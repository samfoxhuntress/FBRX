import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { FbrxAlertSchema, fbrxAlertKey, fbrxAlertSyslog, fbrxAlertText, type FbrxAlert } from '../src/fbrx-alert';
import { postFbrxAlert, sendFbrxAlertSyslog, signFbrxAlert, verifyFbrxAlertSignature } from '../src/node/alert-delivery';

const open: FbrxAlert = {
  v: 1,
  id: 'alrt_1',
  key: fbrxAlertKey('fbrx-server', 'srv-1', 'disk_low', '/srv data'),
  state: 'open',
  severity: 'warning',
  source: { app: 'fbrx-server', host: 'srv-1', role: 'files' },
  rule: 'disk_low',
  title: 'Drive /srv is running out of space',
  detail: '4 GB free (3%).',
  done: 'Old FBRX Time copies were pruned.',
  yours: 'Free some space or add a drive.',
  startedAt: '2026-11-25T10:00:00.000Z',
  sentAt: '2026-11-25T10:00:01.000Z',
};
const resolved: FbrxAlert = { ...open, id: 'alrt_2', state: 'resolved', endedAt: '2026-11-25T12:00:00.000Z', sentAt: '2026-11-25T12:00:00.000Z' };

describe('FBRX Alert v1', () => {
  it('keeps one key per problem and checks what it is sent', () => {
    expect(open.key).toBe('fbrx-server|srv-1|disk_low|/srv_data');
    expect(fbrxAlertKey('fbrx-os', 'pc', 'net_down')).toBe('fbrx-os|pc|net_down');
    expect(FbrxAlertSchema.parse(open)).toEqual(open);
    expect(FbrxAlertSchema.safeParse({ ...open, v: 2 }).success).toBe(false);
    expect(FbrxAlertSchema.safeParse({ ...open, severity: 'panic' }).success).toBe(false);
    expect(FbrxAlertSchema.safeParse({ ...open, startedAt: 'yesterday' }).success).toBe(false);
  });

  it('says a problem, then its all-clear, in words', () => {
    const a = fbrxAlertText(open);
    expect(a.subject).toBe('[FBRX WARNING] Drive /srv is running out of space');
    expect(a.text).toContain('Where: srv-1 · files');
    expect(a.text).toContain('What FBRX did: Old FBRX Time copies were pruned.');
    expect(a.text).toContain('What is left for you: Free some space or add a drive.');
    const r = fbrxAlertText(resolved);
    expect(r.subject).toBe('[FBRX ALL CLEAR] Drive /srv is running out of space');
    expect(r.text).toContain('All clear: Drive /srv is running out of space');
    expect(r.text).toContain('(2 hours)');
    expect(r.text).not.toContain('What is left for you');
  });

  it('writes one RFC 5424 syslog line a SIEM can split', () => {
    const line = fbrxAlertSyslog(open);
    expect(line.startsWith('<132>1 2026-11-25T10:00:01.000Z srv-1 fbrx-server - OPEN - Drive /srv is running out of space - 4 GB free (3%). ')).toBe(true);
    expect(line).toContain('key="fbrx-server|srv-1|disk_low|/srv_data"');
    expect(line).toContain('role=files');
    expect(line).not.toMatch(/[\r\n]/);
    expect(fbrxAlertSyslog(resolved)).toMatch(/^<133>1 .* RESOLVED - All clear: Drive \/srv is running out of space state=resolved/);
    expect(fbrxAlertSyslog({ ...open, severity: 'critical' }, { facility: 1 })).toMatch(/^<10>1 /);
  });

  it('signs webhooks so a receiver can tell who sent them and refuse old ones', () => {
    const body = JSON.stringify(open);
    const sig = signFbrxAlert(body, 'shh', 1_800_000_000);
    expect(sig).toMatch(/^t=1800000000,v1=[a-f0-9]{64}$/);
    expect(verifyFbrxAlertSignature(body, sig, 'shh', { now: 1_800_000_100 })).toBe(true);
    expect(verifyFbrxAlertSignature(body, sig, 'other', { now: 1_800_000_100 })).toBe(false);
    expect(verifyFbrxAlertSignature(`${body} `, sig, 'shh', { now: 1_800_000_100 })).toBe(false);
    expect(verifyFbrxAlertSignature(body, sig, 'shh', { now: 1_800_001_000 })).toBe(false);
    expect(verifyFbrxAlertSignature(body, 'nonsense', 'shh')).toBe(false);
    expect(verifyFbrxAlertSignature(body, null, 'shh')).toBe(false);
  });

  it('posts an alert to a webhook, signed, and says when the webhook refuses it', async () => {
    const got: Array<{ body: string; sig: string; state: string }> = [];
    let status = 200;
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push({ body: b, sig: String(req.headers['fbrx-signature']), state: String(req.headers['fbrx-alert-state']) });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/alerts`;
      await postFbrxAlert(url, resolved, 'shh');
      expect(JSON.parse(got[0]!.body)).toEqual(resolved);
      expect(got[0]!.state).toBe('resolved');
      expect(verifyFbrxAlertSignature(got[0]!.body, got[0]!.sig, 'shh')).toBe(true);
      status = 500;
      await expect(postFbrxAlert(url, open, 'shh')).rejects.toThrow('HTTP 500');
      await expect(postFbrxAlert('ftp://x', open)).rejects.toThrow('https://');
    } finally {
      srv.close();
    }
  });

  it('sends syslog over UDP and over TCP in octet-counted frames', async () => {
    const udp = createSocket('udp4');
    const udpGot = new Promise<string>((r) => udp.once('message', (m) => r(m.toString())));
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
    let tcpGot = '';
    const tcpDone = new Promise<void>((resolve) => {
      const tcp = createTcpServer((s) => {
        s.on('data', (c) => (tcpGot += c.toString()));
        s.on('end', () => {
          tcp.close();
          resolve();
        });
      });
      tcp.listen(0, '127.0.0.1', () => void sendFbrxAlertSyslog({ host: '127.0.0.1', port: (tcp.address() as AddressInfo).port, protocol: 'tcp' }, resolved));
    });
    try {
      await sendFbrxAlertSyslog({ host: '127.0.0.1', port: udp.address().port, protocol: 'udp' }, open);
      expect(await udpGot).toBe(fbrxAlertSyslog(open));
      await tcpDone;
      const line = fbrxAlertSyslog(resolved);
      expect(tcpGot).toBe(`${Buffer.byteLength(line)} ${line}`);
      await expect(sendFbrxAlertSyslog({ host: ' ', port: 514, protocol: 'udp' }, open)).rejects.toThrow('syslog server');
    } finally {
      udp.close();
    }
  });
});

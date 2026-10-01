import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel';
import { createNodePlatform } from '../src/node-platform';
import { readHeader } from '../src/backup/snapshot';
import { makeKernel, memoryKeychain, tempDir, USER } from './helpers';

const PASS = 'snapshot passphrase 123';

/** Copies a snapshot out of the source machine's data folder (like carrying it on a USB drive). */
function carry(file: string): string {
  const dest = join(tempDir('fbrx-usb-'), 'transfer.fbrxsnap');
  copyFileSync(file, dest);
  return dest;
}

async function boot(dataDir: string, keychain = memoryKeychain()) {
  const k = await Kernel.create({ dataDir, platform: createNodePlatform({ dataDir, devMode: true, keychain }) });
  await k.start();
  return k;
}

describe('backup and restore', () => {
  it('moves a complete workstation to a new machine (migrate) as if nothing happened', async () => {
    const a = await makeKernel();
    const k = a.kernel;
    // Build up state on machine A.
    k.vault.set({ name: 'CRM_TOKEN', value: 'crm-token-value-xyz', kind: 'token' });
    k.settings.update({ general: { deviceName: 'Sam MacBook' }, ai: { temperature: 0.55 } });
    await k.gate.invoke('memory.remember', { content: 'Quarterly reports live in the Finance share' }, { origin: 'agent', actor: 'agent' });
    mkdirSync(join(a.dataDir, 'workspace', 'projects'), { recursive: true });
    writeFileSync(join(a.dataDir, 'workspace', 'projects', 'plan.md'), '# Plan');
    const conv = k.conversations.create('Hello world', 'user');
    k.conversations.append(conv.id, { role: 'user', content: 'remember me' });
    k.meta.set('fleet.deviceId', 'dev_original');
    k.vault.set({ name: 'fbrx.fleet.deviceToken', value: 'fbrx_dev_token' }, { internal: true });

    const snap = (await k.call('backup.create', { passphrase: PASS, label: 'before move' }, USER)) as any;
    const usb = carry(snap.file);
    expect(snap.name).toMatch(/^fbrx-sam_macbook-.*\.fbrxsnap$/);
    const header = readHeader(snap.file).header;
    expect(header).toMatchObject({ label: 'before move', deviceName: 'Sam MacBook', includesModels: false });
    // The archive is encrypted: no plaintext secrets or notes.
    const bytes = readFileSync(snap.file);
    expect(bytes.includes(Buffer.from('crm-token-value-xyz'))).toBe(false);
    expect(bytes.includes(Buffer.from('Finance share'))).toBe(false);
    await a.cleanup();

    // Machine B: fresh install, different OS keychain.
    const bDir = tempDir();
    const keychainB = memoryKeychain();
    let b = await boot(bDir, keychainB);
    await expect(b.call('backup.restore', { file: usb, passphrase: 'wrong passphrase!!', mode: 'migrate' }, USER)).rejects.toThrow(/Wrong passphrase/);
    let restarted = false;
    (b.platform as any).requestRestart = () => (restarted = true);
    await b.call('backup.restore', { file: usb, passphrase: PASS, mode: 'migrate' }, USER);
    await new Promise((r) => setTimeout(r, 400));
    expect(restarted).toBe(true);
    await b.stop();

    b = await boot(bDir, keychainB);
    try {
      expect(b.vault.status().state).toBe('unlocked');
      expect(b.vault.get('CRM_TOKEN')).toBe('crm-token-value-xyz');
      expect(b.settings.get().general.deviceName).toBe('Sam MacBook');
      expect(b.settings.get().ai.temperature).toBe(0.55);
      expect(b.conversations.list()[0].title).toBe('Hello world');
      expect(readFileSync(join(bDir, 'workspace', 'projects', 'plan.md'), 'utf8')).toBe('# Plan');
      const recall = await b.gate.invoke('memory.recall', { query: 'quarterly reports' }, { origin: 'agent', actor: 'a' });
      expect(recall.output).toContain('Finance share');
      // Migrate keeps the fleet identity.
      expect(b.meta.get('fleet.deviceId')).toBe('dev_original');
      expect(b.audit.verify().ok).toBe(true);
      const restoredEntry = b.audit.query({ category: 'backup', limit: 5 }).find((e) => e.action === 'restored');
      expect(restoredEntry?.details).toMatchObject({ mode: 'migrate' });
      expect(existsSync(join(bDir, '.pre-restore'))).toBe(true);
    } finally {
      await b.stop();
    }
  });

  it('clone mode keeps data but drops the fleet identity and organisation-managed state', async () => {
    const a = await makeKernel();
    const k = a.kernel;
    k.vault.set({ name: 'SHARED', value: 'shared-value-1' });
    k.meta.set('fleet.deviceId', 'dev_template');
    k.vault.set({ name: 'fbrx.fleet.deviceToken', value: 'tok' }, { internal: true });
    k.vault.applyManaged([{ name: 'ORG_ONLY', value: 'org', version: 1, description: null }]);
    k.settings.applyManaged({ general: { telemetry: true } }, ['general.telemetry']);
    const snap = (await k.call('backup.create', { passphrase: PASS }, USER)) as any;
    const usb = carry(snap.file);
    await a.cleanup();

    const dir = tempDir();
    const kc = memoryKeychain();
    let c = await boot(dir, kc);
    (c.platform as any).requestRestart = () => undefined;
    await c.call('backup.restore', { file: usb, passphrase: PASS, mode: 'clone' }, USER);
    await c.stop();
    c = await boot(dir, kc);
    try {
      expect(c.vault.get('SHARED')).toBe('shared-value-1');
      expect(c.vault.has('ORG_ONLY')).toBe(false);
      expect(c.vault.has('fbrx.fleet.deviceToken')).toBe(false);
      expect(c.meta.get('fleet.deviceId')).toBeNull();
      expect(c.settings.effective().locked).toEqual([]);
    } finally {
      await c.stop();
    }
  });

  it('rejects tampered snapshots', async () => {
    const a = await makeKernel();
    const snap = (await a.kernel.call('backup.create', { passphrase: PASS }, USER)) as any;
    const buf = readFileSync(snap.file);
    buf[buf.length - 40] ^= 0xff;
    writeFileSync(snap.file, buf);
    await expect(a.kernel.call('backup.restore', { file: snap.file, passphrase: PASS, mode: 'migrate' }, USER)).rejects.toThrow(/corrupt/);
    await a.cleanup();
  });
});

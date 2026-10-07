import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MESH_QOS_NFT_REMOVE, MESH_TRAFFIC_CLASSES, meshQosNftables, type MeshTrafficClass } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';

export type NftRunner = (args: string[]) => Promise<{ code: number; out: string; err: string }>;

const KEY = 'mesh.mark';

export const runNft: NftRunner = (args) =>
  new Promise((resolve) => {
    execFile('nft', args, { timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : (err as { code?: unknown }).code === 'ENOENT' ? -1 : 1) : 0;
      resolve({ code, out: String(stdout), err: String(stderr || (err && code === -1 ? 'nft is not installed' : '')) });
    });
  });

/**
 * Prefer Mesh on FBRX Server: the FBRX core runs without root, so FBRX Virtual (root) marks the server's mesh traffic
 * with its priority class (an nftables table), and puts the marking back after every restart.
 */
export class HostMeshMark {
  constructor(
    private readonly db: Db,
    private readonly nft: NftRunner = runNft,
  ) {}

  wanted(): { port: number; trafficClass: MeshTrafficClass } | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', KEY);
    if (!row) return null;
    try {
      const v = JSON.parse(row.value);
      return Number.isInteger(v.port) && MESH_TRAFFIC_CLASSES.includes(v.trafficClass) ? v : null;
    } catch {
      return null;
    }
  }

  /** true or false, or null when nftables cannot be asked (not installed, not root). */
  async applied(): Promise<boolean | null> {
    const want = this.wanted();
    const r = await this.nft(['list', 'table', 'inet', 'fbrx_mesh']);
    if (r.code === 0) return want ? r.out.includes(`dscp set ${want.trafficClass}`) && r.out.includes(`dport ${want.port}`) : true;
    return /No such file|does not exist/i.test(r.err) ? false : null;
  }

  private async load(script: string) {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-mesh-'));
    try {
      const file = join(dir, 'mesh.nft');
      writeFileSync(file, script, { mode: 0o600 });
      const r = await this.nft(['-f', file]);
      if (r.code !== 0) throw new Error(`nft: ${(r.err || r.out).trim().slice(0, 300) || 'failed'}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async apply(port: number, trafficClass: MeshTrafficClass): Promise<void> {
    await this.load(meshQosNftables(port, trafficClass));
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify({ port, trafficClass }));
  }

  async remove(): Promise<void> {
    await this.load(MESH_QOS_NFT_REMOVE);
    this.db.run('DELETE FROM settings WHERE key = ?', KEY);
  }

  /** At start: the marking is not kept across restarts by the kernel, so put it back. */
  async restore(): Promise<void> {
    const want = this.wanted();
    if (want) await this.load(meshQosNftables(want.port, want.trafficClass));
  }
}

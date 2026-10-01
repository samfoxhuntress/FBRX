import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { compareSemver } from '@fbrx/shared';
import { sha256Hex } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { deviceAuth, resolvePrincipal } from '../auth';
import { forbidden, notFound, unauthorized } from '../errors';

const FEED_FILES: Record<string, 'win32' | 'darwin' | 'linux'> = {
  'latest.yml': 'win32',
  'latest-mac.yml': 'darwin',
  'latest-linux.yml': 'linux',
};

const CHANNEL_VISIBILITY: Record<string, string[]> = {
  stable: ['stable'],
  beta: ['beta', 'stable'],
  dev: ['dev', 'beta', 'stable'],
};

export function inferFileKind(platform: string, fileName: string): 'update' | 'installer' | 'blockmap' {
  const f = fileName.toLowerCase();
  if (f.endsWith('.blockmap')) return 'blockmap';
  if (platform === 'win32' && f.endsWith('.exe')) return 'update';
  if (platform === 'darwin' && f.endsWith('.zip')) return 'update';
  if (platform === 'linux' && f.endsWith('.appimage')) return 'update';
  return 'installer';
}

function yamlString(s: string) {
  return `'${s.replace(/'/g, "''")}'`;
}

/** electron-updater "generic provider" metadata (latest.yml / latest-mac.yml / latest-linux.yml). */
export function updaterYaml(release: { version: string; published_at: string | null; notes: string }, files: Array<{ file_name: string; sha512: string; size: number; release_id: string }>): string {
  const lines = [`version: ${release.version}`, 'files:'];
  for (const f of files) {
    lines.push(`  - url: ${yamlString(`files/${f.release_id}/${encodeURIComponent(f.file_name)}`)}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`);
  }
  const main = files[0];
  lines.push(`path: ${yamlString(`files/${main.release_id}/${encodeURIComponent(main.file_name)}`)}`, `sha512: ${main.sha512}`);
  lines.push(`releaseDate: ${yamlString(release.published_at ?? new Date().toISOString())}`);
  if (release.notes) lines.push(`releaseNotes: ${yamlString(release.notes.slice(0, 5000))}`);
  return `${lines.join('\n')}\n`;
}

/** Chooses the release a device should run: its pinned version, or the newest in its channel within rollout. */
export function selectRelease(ctx: AppContext, deviceId: string, platform: string) {
  const d = ctx.db.get<any>('SELECT * FROM devices WHERE id = ?', deviceId);
  const g = d.group_id ? ctx.db.get<any>('SELECT * FROM groups WHERE id = ?', d.group_id) : null;
  const t = ctx.db.get<any>('SELECT * FROM tenants WHERE id = ?', d.tenant_id);
  const pinned = d.pinned_version ?? g?.pinned_version ?? null;
  const channel = d.update_channel ?? g?.update_channel ?? t.update_channel ?? 'stable';
  const filesFor = (releaseId: string) =>
    ctx.db.all<any>("SELECT * FROM release_files WHERE release_id = ? AND platform = ? AND kind = 'update' ORDER BY file_name", releaseId, platform);
  if (pinned) {
    const r = ctx.db.get<any>('SELECT * FROM releases WHERE version = ? AND published = 1', pinned);
    const files = r ? filesFor(r.id) : [];
    return r && files.length ? { release: r, files, channel, pinned } : null;
  }
  const visible = CHANNEL_VISIBILITY[channel] ?? ['stable'];
  const candidates = ctx.db
    .all<any>(`SELECT * FROM releases WHERE published = 1 AND channel IN (${visible.map(() => '?').join(',')})`, ...visible)
    .sort((a, b) => compareSemver(b.version, a.version));
  for (const r of candidates) {
    const bucket = parseInt(createHash('sha256').update(`${deviceId}:${r.id}`).digest('hex').slice(0, 8), 16) % 100;
    if (bucket >= Number(r.rollout_pct)) continue;
    const files = filesFor(r.id);
    if (files.length) return { release: r, files, channel, pinned: null };
  }
  return null;
}

function sendFile(reply: FastifyReply, path: string, name: string) {
  if (!existsSync(path)) throw notFound('File missing from storage');
  reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
  return reply.send(createReadStream(path));
}

export async function updateRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = deviceAuth(ctx);

  app.get('/v1/updates/feed/:file', { preHandler: auth }, async (req, reply) => {
    const { file } = req.params as { file: string };
    const platform = FEED_FILES[file];
    if (!platform) throw notFound();
    const sel = selectRelease(ctx, req.device!.id, platform);
    if (!sel) throw notFound('No release available for this device');
    reply.header('content-type', 'text/yaml; charset=utf-8').header('cache-control', 'no-store');
    return updaterYaml(sel.release, sel.files);
  });

  app.get('/v1/updates/feed/files/:releaseId/:fileName', { preHandler: auth }, async (req, reply) => {
    const { releaseId, fileName } = req.params as { releaseId: string; fileName: string };
    const f = ctx.db.get<any>(
      'SELECT f.* FROM release_files f JOIN releases r ON r.id = f.release_id WHERE f.release_id = ? AND f.file_name = ? AND r.published = 1',
      releaseId,
      decodeURIComponent(fileName),
    );
    if (!f) throw notFound();
    return sendFile(reply, f.storage_path, f.file_name);
  });

  /** Installer downloads for new machines: admin session/API key, or a valid enrollment token (`?et=`). */
  app.get('/v1/downloads/:releaseId/:fileName', async (req, reply) => {
    const { releaseId, fileName } = req.params as { releaseId: string; fileName: string };
    const q = req.query as { et?: string; access_token?: string };
    let allowed = false;
    const authz = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : q.access_token;
    if (authz && (await resolvePrincipal(ctx, authz))) allowed = true;
    if (!allowed && q.et) {
      const t = ctx.db.get<any>('SELECT * FROM enrollment_tokens WHERE token_hash = ? AND revoked_at IS NULL', sha256Hex(q.et));
      allowed = !!t && (!t.expires_at || t.expires_at > new Date().toISOString());
    }
    if (!allowed) throw (authz || q.et ? forbidden() : unauthorized());
    const f = ctx.db.get<any>('SELECT * FROM release_files WHERE release_id = ? AND file_name = ?', releaseId, decodeURIComponent(fileName));
    if (!f) throw notFound();
    return sendFile(reply, f.storage_path, f.file_name);
  });
}

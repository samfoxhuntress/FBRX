import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_MESSAGE, IMAGE_ATTACHMENT_MAX_BYTES, IMAGE_MIME, attachmentKind, fileExtension, newId, type AttachmentInfo, type AttachmentKind } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Db } from '../storage/db';
import type { Logger } from '../logger';
import { extractText } from '../docs/extract';
import { safeFileName } from '../util/misc';

interface AttachmentRow {
  id: string;
  conversation_id: string | null;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  path: string;
  text: string | null;
  pages: number | null;
  note: string | null;
  created_at: string;
}

/** How long an attachment that was never sent is kept. */
const UNSENT_MS = 24 * 3600_000;

const info = (r: AttachmentRow): AttachmentInfo => ({ id: r.id, name: r.name, mime: r.mime, kind: r.kind, size: r.size, path: r.path, textChars: r.text?.length ?? null, pages: r.pages, note: r.note });

/**
 * Files and images attached to chat messages. Each is kept in the workspace (Attachments/<id>/<name>), where the AI's
 * file tools reach it, with the text read out of it in the database. Unsent ones are removed after a day, and sent
 * ones go with their chat.
 */
export class AttachmentStore {
  constructor(private readonly d: { db: Db; root: string; log: Logger }) {}

  async add(p: { name: string; data: Buffer; mime?: string }): Promise<AttachmentInfo> {
    const name = safeFileName(p.name);
    if (!p.data.length) throw new CoreError('INVALID_ARGUMENT', `${name} is empty`);
    if (p.data.length > ATTACHMENT_MAX_BYTES) throw new CoreError('INVALID_ARGUMENT', `${name} is larger than ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`);
    const kind = attachmentKind(name, p.mime);
    if (kind === 'image' && p.data.length > IMAGE_ATTACHMENT_MAX_BYTES) throw new CoreError('INVALID_ARGUMENT', `${name} is larger than ${IMAGE_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB: make the picture smaller first`);
    const mime = kind === 'image' ? (IMAGE_MIME[fileExtension(name)] ?? p.mime ?? 'image/png') : p.mime || 'application/octet-stream';
    const id = newId('att');
    const dir = join(this.d.root, id);
    const path = join(dir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path, p.data);
    const x = await extractText(name, kind, p.data);
    this.d.db.run(
      'INSERT INTO attachments (id, conversation_id, name, mime, kind, size, path, text, pages, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      null,
      name,
      mime,
      kind,
      p.data.length,
      path,
      x.text,
      x.pages,
      x.note,
      new Date().toISOString(),
    );
    return this.info(id);
  }

  private row(id: string): AttachmentRow {
    const r = this.d.db.get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id);
    if (!r) throw new CoreError('NOT_FOUND', 'That attachment is gone');
    return r;
  }

  info(id: string): AttachmentInfo {
    return info(this.row(id));
  }

  /** Gives unsent attachments to a chat (when the message they go with is sent). */
  bind(ids: string[], conversationId: string): AttachmentInfo[] {
    if (ids.length > ATTACHMENTS_PER_MESSAGE) throw new CoreError('INVALID_ARGUMENT', `Attach up to ${ATTACHMENTS_PER_MESSAGE} files to one message`);
    const rows = [...new Set(ids)].map((id) => this.row(id));
    for (const r of rows) if (r.conversation_id && r.conversation_id !== conversationId) throw new CoreError('CONFLICT', `${r.name} belongs to another chat`);
    this.d.db.tx(() => {
      for (const r of rows) this.d.db.run('UPDATE attachments SET conversation_id = ? WHERE id = ?', conversationId, r.id);
    });
    return rows.map(info);
  }

  /** Removes an attachment that was not sent. */
  async remove(id: string): Promise<boolean> {
    const r = this.d.db.get<AttachmentRow>('SELECT * FROM attachments WHERE id = ? AND conversation_id IS NULL', id);
    if (!r) return false;
    this.d.db.run('DELETE FROM attachments WHERE id = ?', id);
    await rm(join(this.d.root, id), { recursive: true, force: true });
    return true;
  }

  async read(id: string): Promise<{ mime: string; data: string }> {
    const r = this.row(id);
    return { mime: r.mime, data: (await readFile(r.path)).toString('base64') };
  }

  /** The text read out of an attachment, for the AI. */
  text(id: string): string | null {
    return this.d.db.get<{ text: string | null }>('SELECT text FROM attachments WHERE id = ?', id)?.text ?? null;
  }

  /** An attached image's bytes, for a model that can see; null when it is not an image or its file is gone. */
  async image(id: string): Promise<{ mime: string; data: string } | null> {
    const r = this.d.db.get<AttachmentRow>("SELECT * FROM attachments WHERE id = ? AND kind = 'image'", id);
    if (!r) return null;
    return readFile(r.path).then(
      (b) => ({ mime: r.mime, data: b.toString('base64') }),
      () => null,
    );
  }

  /** Removes the files of attachments whose chat is gone, and attachments never sent within a day. */
  async sweep(): Promise<number> {
    this.d.db.run('DELETE FROM attachments WHERE conversation_id IS NULL AND created_at < ?', new Date(Date.now() - UNSENT_MS).toISOString());
    const keep = new Set(this.d.db.all<{ id: string }>('SELECT id FROM attachments').map((r) => r.id));
    let removed = 0;
    for (const dir of await readdir(this.d.root).catch(() => [] as string[])) {
      if (keep.has(dir) || !dir.startsWith('att_')) continue;
      await rm(join(this.d.root, dir), { recursive: true, force: true }).catch((err) => this.d.log.debug('Could not remove an old attachment', { dir, error: (err as Error).message }));
      removed++;
    }
    return removed;
  }
}

import { useEffect, useRef, useState } from 'react';
import { ATTACHMENTS_PER_MESSAGE, ATTACHMENT_MAX_BYTES, IMAGE_ATTACHMENT_MAX_BYTES, IMAGE_ATTACHMENT_MAX_SIDE, attachmentKind, type AttachmentInfo, type AttachmentKind } from '@fbrx/shared';
import { Icons, Modal, formatBytes, type IconName } from '@fbrx/ui';
import { bridge, call } from './client';

/** A file on its way into the next message: being read, ready (with what the core made of it), or refused. */
export interface PendingAttachment {
  key: string;
  name: string;
  kind: AttachmentKind;
  /** A thumbnail for images while they are read and after. */
  preview: string | null;
  info: AttachmentInfo | null;
  error: string | null;
}

const KIND_ICON: Record<AttachmentKind, IconName> = { image: 'image', text: 'file', document: 'note', file: 'paperclip' };

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * A picture as AI models take it: no longer than IMAGE_ATTACHMENT_MAX_SIDE on its longest side and under their size
 * limit (a photo is saved as JPEG; a screenshot keeps PNG unless that is still too big).
 */
async function fitImage(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_ATTACHMENT_MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= IMAGE_ATTACHMENT_MAX_BYTES) {
    bmp.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const encode = (type: string, quality?: number) => new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be read'))), type, quality));
  const png = file.type === 'image/png' ? await encode('image/png') : null;
  return png && png.size <= IMAGE_ATTACHMENT_MAX_BYTES ? png : encode('image/jpeg', 0.88);
}

/** The files attached to the message being written: add (picker, drop, paste), remove, and the ids to send. */
export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const ref = useRef(items);
  ref.current = items;
  // Thumbnails are object URLs: let them go when the composer goes.
  useEffect(() => () => ref.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)), []);

  const update = (key: string, patch: Partial<PendingAttachment>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const add = (files: Iterable<File>) => {
    const room = ATTACHMENTS_PER_MESSAGE - ref.current.length;
    [...files].slice(0, Math.max(0, room)).forEach((file, n) => {
      const key = `${Date.now()}-${n}-${file.name}`;
      const kind = attachmentKind(file.name, file.type);
      const preview = kind === 'image' ? URL.createObjectURL(file) : null;
      setItems((list) => [...list, { key, name: file.name || 'pasted image.png', kind, preview, info: null, error: null }]);
      void (async () => {
        try {
          if (kind !== 'image' && file.size > ATTACHMENT_MAX_BYTES) throw new Error(`Larger than ${formatBytes(ATTACHMENT_MAX_BYTES)}`);
          const blob = kind === 'image' ? await fitImage(file) : file;
          const name = blob !== file && blob.type === 'image/jpeg' ? file.name.replace(/\.\w+$/, '') + '.jpg' : file.name || 'pasted image.png';
          const info = await call('ai.attachments.add', { name, data: base64(await blob.arrayBuffer()), mime: blob.type || undefined });
          // Removed while it was being read: let the core forget it too.
          if (!ref.current.some((i) => i.key === key)) void call('ai.attachments.remove', { id: info.id });
          else update(key, { info, name: info.name });
        } catch (err) {
          update(key, { error: (err as Error).message });
        }
      })();
    });
  };

  const remove = (key: string) => {
    const item = ref.current.find((i) => i.key === key);
    if (item?.info) void call('ai.attachments.remove', { id: item.info.id });
    if (item?.preview) URL.revokeObjectURL(item.preview);
    setItems((list) => list.filter((i) => i.key !== key));
  };

  /** After sending: the message shows them from now on. */
  const clear = () => {
    ref.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
    setItems([]);
  };

  /** Puts attachments back (a message that could not be sent). */
  const restore = (infos: AttachmentInfo[]) => setItems(infos.map((info) => ({ key: info.id, name: info.name, kind: info.kind, preview: null, info, error: null })));

  return {
    items,
    add,
    remove,
    clear,
    restore,
    reading: items.some((i) => !i.info && !i.error),
    ids: items.flatMap((i) => (i.info ? [i.info.id] : [])),
    full: items.length >= ATTACHMENTS_PER_MESSAGE,
  };
}

/** The attachments in the composer, each with its state and an ×. */
export function AttachmentTray({ items, onRemove }: { items: PendingAttachment[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="attach-tray">
      {items.map((i) => {
        const Ico = Icons[KIND_ICON[i.kind]];
        return (
          <div key={i.key} className={`attach-chip${i.error ? ' failed' : ''}`} title={i.error ?? i.info?.note ?? i.name}>
            {i.preview ? <img src={i.preview} alt="" /> : <Ico size={15} />}
            <span className="attach-name">{i.name}</span>
            <span className="attach-sub">{i.error ? 'Could not attach' : i.info ? describe(i.info) : 'Reading…'}</span>
            <button aria-label={`Remove ${i.name}`} onClick={() => onRemove(i.key)}>
              <Icons.x size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function describe(a: AttachmentInfo): string {
  const pages = a.pages ? ` · ${a.pages} ${/\.pptx|\.odp$/i.test(a.name) ? 'slides' : /\.(xlsx|ods)$/i.test(a.name) ? 'sheets' : 'pages'}` : '';
  return `${formatBytes(a.size)}${pages}`;
}

const thumbs = new Map<string, Promise<string>>();
/** An attached image as a data URL (read once per window). */
function thumb(id: string): Promise<string> {
  if (!thumbs.has(id)) thumbs.set(id, call('ai.attachments.read', { id }).then((r) => `data:${r.mime};base64,${r.data}`));
  return thumbs.get(id)!;
}

function Thumb({ a, onOpen }: { a: AttachmentInfo; onOpen: (src: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    thumb(a.id).then((s) => live && setSrc(s), () => undefined);
    return () => {
      live = false;
    };
  }, [a.id]);
  return (
    <button className="attach-thumb" title={a.name} onClick={() => src && onOpen(src)}>
      {src ? <img src={src} alt={a.name} /> : <Icons.image size={18} />}
    </button>
  );
}

/** What a sent message had attached: pictures as thumbnails (click for a bigger look), files as chips. */
export function MessageAttachments({ files }: { files: AttachmentInfo[] }) {
  const [big, setBig] = useState<{ src: string; name: string } | null>(null);
  return (
    <div className="msg-attachments">
      {files.map((a) => {
        if (a.kind === 'image') return <Thumb key={a.id} a={a} onOpen={(src) => setBig({ src, name: a.name })} />;
        const Ico = Icons[KIND_ICON[a.kind]];
        return (
          <button key={a.id} className="attach-chip sent" title={a.note ?? `Show ${a.name} in its folder`} onClick={() => void bridge.reveal?.(a.path)}>
            <Ico size={15} />
            <span className="attach-name">{a.name}</span>
            <span className="attach-sub">{describe(a)}</span>
          </button>
        );
      })}
      {big && (
        <Modal wide title={big.name} onClose={() => setBig(null)}>
          <img src={big.src} alt={big.name} style={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', margin: '0 auto', borderRadius: 8 }} />
        </Modal>
      )}
    </div>
  );
}

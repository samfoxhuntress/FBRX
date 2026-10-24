import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Empty, Icons, Page, Spinner, formatDate, useAction, useConfirm, type IconName } from '@fbrx/ui';
import { bridge, call } from '../client';
import { useAgentName, useCore } from '../hooks';
import { navigate } from '../app';
import { base64, fitImage } from '../attachments';

type Pt = [number, number];
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One mark on a snapshot, in the picture's own pixels. */
type Mark =
  | { kind: 'pen' | 'marker'; color: string; width: number; points: Pt[] }
  | { kind: 'arrow' | 'box'; color: string; width: number; a: Pt; b: Pt }
  | { kind: 'text'; color: string; size: number; at: Pt; text: string }
  | { kind: 'blur'; a: Pt; b: Pt };

/** What the person did to the picture: marks in order, and the part kept (all of it when null). */
interface Edit {
  marks: Mark[];
  crop: Rect | null;
}

type Tool = 'pen' | 'marker' | 'arrow' | 'box' | 'text' | 'blur' | 'crop';

/** Text being typed onto the picture: where (in the picture, and on the screen) and how big. */
interface Typing {
  at: Pt;
  left: number;
  top: number;
  px: number;
  text: string;
}

const TOOLS: Array<{ id: Tool; label: string; icon: IconName; key: string }> = [
  { id: 'pen', label: 'Pen', icon: 'edit', key: 'p' },
  { id: 'marker', label: 'Highlighter', icon: 'highlighter', key: 'h' },
  { id: 'arrow', label: 'Arrow', icon: 'arrowUpRight', key: 'a' },
  { id: 'box', label: 'Box', icon: 'square', key: 'r' },
  { id: 'text', label: 'Text', icon: 'type', key: 't' },
  { id: 'blur', label: 'Blur (hides what is under it)', icon: 'droplet', key: 'b' },
  { id: 'crop', label: 'Crop', icon: 'crop', key: 'c' },
];
const COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#0090ff', '#8e4ec6', '#111111', '#ffffff'];
const SIZES = [1, 2, 4];

const rectOf = (a: Pt, b: Pt): Rect => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) });

/** Squares big enough that nothing under them can be read back. */
function pixelate(ctx: CanvasRenderingContext2D, img: HTMLImageElement, r: Rect) {
  if (r.w < 1 || r.h < 1) return;
  const block = Math.max(8, Math.round(Math.max(img.naturalWidth, img.naturalHeight) / 120));
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.ceil(r.w / block));
  small.height = Math.max(1, Math.ceil(r.h / block));
  small.getContext('2d')!.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, r.x, r.y, r.w, r.h);
  ctx.restore();
}

function paint(ctx: CanvasRenderingContext2D, img: HTMLImageElement, m: Mark) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (m.kind) {
    case 'pen':
    case 'marker': {
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.kind === 'marker' ? m.width * 4 : m.width;
      if (m.kind === 'marker') ctx.globalAlpha = 0.38;
      ctx.beginPath();
      m.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (m.points.length === 1) ctx.lineTo(m.points[0][0] + 0.1, m.points[0][1]);
      ctx.stroke();
      break;
    }
    case 'arrow': {
      const [ax, ay] = m.a;
      const [bx, by] = m.b;
      const angle = Math.atan2(by - ay, bx - ax);
      const head = Math.max(12, m.width * 4.5);
      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;
      ctx.lineWidth = m.width;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx - Math.cos(angle) * head * 0.8, by - Math.sin(angle) * head * 0.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - head * Math.cos(angle - 0.45), by - head * Math.sin(angle - 0.45));
      ctx.lineTo(bx - head * Math.cos(angle + 0.45), by - head * Math.sin(angle + 0.45));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'box': {
      const r = rectOf(m.a, m.b);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.width;
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, m.width);
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.font = `600 ${m.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'top';
      // An outline in the opposite shade keeps it readable on any background.
      ctx.lineWidth = Math.max(2, m.size / 7);
      ctx.strokeStyle = m.color === '#111111' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.75)';
      m.text.split('\n').forEach((line, i) => {
        const y = m.at[1] + i * m.size * 1.25;
        ctx.strokeText(line, m.at[0], y);
        ctx.fillStyle = m.color;
        ctx.fillText(line, m.at[0], y);
      });
      break;
    }
    case 'blur':
      pixelate(ctx, img, rectOf(m.a, m.b));
      break;
  }
  ctx.restore();
}

/** The picture with its marks, showing `view` of it (the crop, or all of it while cropping). */
function draw(canvas: HTMLCanvasElement, img: HTMLImageElement, marks: Mark[], view: Rect) {
  if (canvas.width !== view.w || canvas.height !== view.h) {
    canvas.width = view.w;
    canvas.height = view.h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, -view.x, -view.y);
  ctx.clearRect(view.x, view.y, view.w, view.h);
  ctx.drawImage(img, 0, 0);
  for (const m of marks) paint(ctx, img, m);
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be made'))), 'image/png'));
}

/** The editor: a snapshot to mark up, then copy, save, hand to the agent, or delete. */
export function SnapshotEditor({ id }: { id: string }) {
  const agentName = useAgentName();
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const info = useCore('snapshots.list', undefined, ['snapshots.changed']).data?.find((s) => s.id === id);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit>({ marks: [], crop: null });
  const [past, setPast] = useState<Edit[]>([]);
  const [future, setFuture] = useState<Edit[]>([]);
  const [saved, setSaved] = useState<Edit>(edit);
  const [tool, setTool] = useState<Tool>('arrow');
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(1);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [cropDraft, setCropDraft] = useState<Rect | null>(null);
  const [typing, setTyping] = useState<Typing | null>(null);
  // The text being typed, read when it is placed (Enter, a click elsewhere) or dropped (Esc).
  const typed = useRef<Typing | null>(null);
  const type = (t: Typing | null) => {
    typed.current = t;
    setTyping(t);
  };
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const start = useRef<Pt | null>(null);

  useEffect(() => {
    let gone = false;
    setImg(null);
    setFailed(null);
    const fresh = { marks: [], crop: null };
    setEdit(fresh);
    setSaved(fresh);
    setPast([]);
    setFuture([]);
    void call('snapshots.read', { id })
      .then((p) => {
        const image = new Image();
        image.onload = () => !gone && setImg(image);
        image.onerror = () => !gone && setFailed('The picture could not be read');
        image.src = `data:${p.mime};base64,${p.data}`;
      })
      .catch((err: Error) => !gone && setFailed(err.message));
    return () => {
      gone = true;
    };
  }, [id]);

  const full: Rect = img ? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight } : { x: 0, y: 0, w: 1, h: 1 };
  const view = tool === 'crop' ? full : (edit.crop ?? full);
  // Line widths and text that look the same on a small window and a 4K screen.
  const unit = Math.max(2, Math.round(Math.max(full.w, full.h) / 500));

  useEffect(() => {
    if (img && canvas.current) draw(canvas.current, img, draft ? [...edit.marks, draft] : edit.marks, view);
  });

  const commit = (next: Edit) => {
    setPast((p) => [...p, edit].slice(-100));
    setFuture([]);
    setEdit(next);
  };
  const undo = () => {
    const prev = past.at(-1);
    if (!prev) return;
    setPast(past.slice(0, -1));
    setFuture([edit, ...future]);
    setEdit(prev);
  };
  const redo = () => {
    const [next, ...rest] = future;
    if (!next) return;
    setPast([...past, edit]);
    setFuture(rest);
    setEdit(next);
  };

  /** Where a pointer is on the picture, in its own pixels. */
  const at = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvas.current!.getBoundingClientRect();
    const x = view.x + ((e.clientX - r.left) * view.w) / r.width;
    const y = view.y + ((e.clientY - r.top) * view.h) / r.height;
    return [Math.min(full.w, Math.max(0, x)), Math.min(full.h, Math.max(0, y))];
  };

  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !img) return;
    const p = at(e);
    if (tool === 'text') {
      // The text box keeps the focus (a click on the picture would take it away).
      e.preventDefault();
      placeText();
      const r = canvas.current!.getBoundingClientRect();
      const s = stage.current!.getBoundingClientRect();
      type({ at: p, left: e.clientX - s.left, top: e.clientY - s.top, px: (unit * 9 * size * r.width) / view.w, text: '' });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = p;
    if (tool === 'crop') setCropDraft(rectOf(p, p));
    else if (tool === 'pen' || tool === 'marker') setDraft({ kind: tool, color, width: unit * size, points: [p] });
    else if (tool === 'blur') setDraft({ kind: 'blur', a: p, b: p });
    else setDraft({ kind: tool, color, width: unit * size, a: p, b: p });
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!start.current) return;
    const p = at(e);
    if (tool === 'crop') return setCropDraft(rectOf(start.current, p));
    setDraft((d) => (!d ? d : d.kind === 'pen' || d.kind === 'marker' ? { ...d, points: [...d.points, p] } : d.kind === 'text' ? d : { ...d, b: p }));
  };
  const up = () => {
    if (!start.current) return;
    start.current = null;
    if (tool === 'crop') {
      if (cropDraft && cropDraft.w >= 8 && cropDraft.h >= 8) {
        const r = { x: Math.round(cropDraft.x), y: Math.round(cropDraft.y), w: Math.round(cropDraft.w), h: Math.round(cropDraft.h) };
        commit({ ...edit, crop: r });
        setTool('arrow');
      }
      setCropDraft(null);
      return;
    }
    const tiny = draft && 'a' in draft && Math.hypot(draft.b[0] - draft.a[0], draft.b[1] - draft.a[1]) < 4;
    if (draft && !tiny) commit({ ...edit, marks: [...edit.marks, draft] });
    setDraft(null);
  };
  function placeText() {
    const t = typed.current;
    type(null);
    if (t?.text.trim()) commit({ ...edit, marks: [...edit.marks, { kind: 'text', color, size: unit * 9 * size, at: t.at, text: t.text }] });
  }

  /** The picture as it is now: marks drawn in, cropped. */
  const render = async (): Promise<Blob> => {
    const c = document.createElement('canvas');
    draw(c, img!, edit.marks, edit.crop ?? full);
    return toBlob(c);
  };
  const copy = () => run('copy', async () => navigator.clipboard.write([new ClipboardItem({ 'image/png': await render() })]), 'Copied: paste it anywhere');
  const save = () =>
    run(
      'save',
      async () => {
        await call('snapshots.save', { id, data: base64(await (await render()).arrayBuffer()) });
        setSaved(edit);
      },
      'Saved',
    );
  const saveCopy = () =>
    run('copy-file', async () => {
      const shot = await call('snapshots.save', { data: base64(await (await render()).arrayBuffer()) });
      navigate(`snapshots/${encodeURIComponent(shot.id)}`);
    });
  const ask = () =>
    run('ask', async () => {
      const picture = await fitImage(await render());
      const name = `${id.replace(/\.png$/i, '')}.${picture.type === 'image/jpeg' ? 'jpg' : 'png'}`;
      const a = await call('ai.attachments.add', { name, data: base64(await picture.arrayBuffer()), mime: picture.type });
      navigate(`agent/attach/${encodeURIComponent(a.id)}`);
    });
  const remove = async () => {
    if (!(await confirm({ title: 'Delete this snapshot?', body: 'Its file is deleted from the snapshot folder.', danger: true, confirmLabel: 'Delete' }))) return;
    const done = await run('rm', () => call('snapshots.remove', { id }), 'Snapshot deleted');
    if (done) navigate('snapshots');
  };

  // Shortcuts: Ctrl+Z / Ctrl+Y, Ctrl+C, Ctrl+S, and a letter for each tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing || (e.target as HTMLElement).closest('input, textarea, select')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') (e.shiftKey ? redo : undo)();
      else if (mod && key === 'y') redo();
      else if (mod && key === 'c') void copy();
      else if (mod && key === 's') void save();
      else if (!mod && !e.altKey) {
        const t = TOOLS.find((x) => x.key === key);
        if (t) setTool(t.id);
        else return;
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (failed)
    return (
      <Page title="Snapshot" actions={<Button icon="chevronLeft" onClick={() => navigate('snapshots')}>All snapshots</Button>}>
        <Empty title="That snapshot cannot be opened">{failed}</Empty>
      </Page>
    );
  const dirty = edit !== saved;
  const cropShown = tool === 'crop' ? (cropDraft ?? edit.crop) : null;
  const r = canvas.current?.getBoundingClientRect();
  return (
    <Page
      title="Snapshot"
      description={info ? `${formatDate(info.createdAt)}${dirty ? ' · not saved yet' : ''}` : undefined}
      actions={
        <>
          <Button icon="chevronLeft" variant="ghost" onClick={() => navigate('snapshots')}>
            All
          </Button>
          <Button icon="copy" loading={busy === 'copy'} disabled={!img} onClick={() => void copy()}>
            Copy
          </Button>
          <Button icon="sparkles" loading={busy === 'ask'} disabled={!img} onClick={() => void ask()}>
            Ask {agentName}
          </Button>
          <Button variant="primary" icon="save" loading={busy === 'save'} disabled={!img || !dirty} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="snapedit-bar">
        <div className="seg" role="group" aria-label="Tools">
          {TOOLS.map((t) => {
            const Ico = Icons[t.icon];
            return (
              <button key={t.id} className={tool === t.id ? 'on' : ''} title={`${t.label} (${t.key.toUpperCase()})`} aria-label={t.label} onClick={() => setTool(t.id)}>
                <Ico size={15} />
              </button>
            );
          })}
        </div>
        {tool !== 'blur' && tool !== 'crop' && (
          <>
            <div className="snapedit-colors" role="group" aria-label="Color">
              {COLORS.map((c) => (
                <button key={c} className={color === c ? 'on' : ''} style={{ background: c }} aria-label={`Color ${c}`} onClick={() => setColor(c)} />
              ))}
            </div>
            <div className="seg" role="group" aria-label="Size">
              {SIZES.map((s, i) => (
                <button key={s} className={size === s ? 'on' : ''} aria-label={['Thin', 'Medium', 'Thick'][i]} onClick={() => setSize(s)}>
                  <span className="snapedit-dot" style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
                </button>
              ))}
            </div>
          </>
        )}
        {tool === 'crop' && <span className="fx-muted" style={{ fontSize: 12.5 }}>Drag over the part to keep.</span>}
        {edit.crop && (
          <Button size="sm" variant="ghost" icon="x" onClick={() => commit({ ...edit, crop: null })}>
            Uncrop
          </Button>
        )}
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" icon="undo" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo} />
        <Button size="sm" variant="ghost" icon="redo" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!future.length} onClick={redo} />
        <Button size="sm" variant="ghost" icon="plus" loading={busy === 'copy-file'} disabled={!img} title="Save a copy as a new snapshot" onClick={() => void saveCopy()}>
          Save a copy
        </Button>
        {info && bridge.reveal && <Button size="sm" variant="ghost" icon="folder" aria-label="Show in folder" title="Show in folder" onClick={() => void bridge.reveal!(info.path)} />}
        <Button size="sm" variant="ghost" icon="trash" aria-label="Delete" title="Delete" onClick={() => void remove()} />
      </div>
      <div className={`snapedit-stage tool-${tool}`} ref={stage}>
        {!img ? (
          <Spinner />
        ) : (
          <>
            <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} />
            {cropShown && r && stage.current && (
              <div
                className="snapedit-crop"
                style={{
                  left: r.left - stage.current.getBoundingClientRect().left + (cropShown.x * r.width) / view.w,
                  top: r.top - stage.current.getBoundingClientRect().top + (cropShown.y * r.height) / view.h,
                  width: (cropShown.w * r.width) / view.w,
                  height: (cropShown.h * r.height) / view.h,
                }}
              />
            )}
            {typing && (
              <input
                className="snapedit-text"
                autoFocus
                value={typing.text}
                placeholder="Type, then Enter"
                style={{ left: typing.left, top: typing.top, fontSize: typing.px, color }}
                onChange={(e) => type({ ...typing, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') placeText();
                  if (e.key === 'Escape') type(null);
                }}
                onBlur={placeText}
              />
            )}
          </>
        )}
      </div>
      {dialog}
    </Page>
  );
}

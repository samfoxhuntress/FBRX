import { useEffect, useRef, useState } from 'react';
import { REMOTE_KEYS, type RemoteFrame, type RemoteInput, type RemoteKey, type RemoteMode, type RemoteModifier, type RemoteSession } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Page, Select, Status } from '@fbrx/ui';
import { call } from '../client';
import { navigate, routeArg } from '../app';
import { useCore } from '../hooks';

/**
 * Another computer's screen, over FBRX Mesh: ask to see it (or use it), wait for the yes over there (unless it lets
 * this computer in without asking), then pictures as fast as the link allows and, with control, this computer's mouse
 * and keyboard over there. Leaving the page ends the session.
 */

const SHARP = 1600;
const FAST = 1024;
const KEY_SET = new Set<string>(REMOTE_KEYS);
const ARROWS: Record<string, RemoteKey> = { ' ': 'Space' };

/** The remote key for a browser key, or null (typed characters go as text). */
function remoteKey(e: KeyboardEvent): { key: RemoteKey; mods: RemoteModifier[] } | { text: string } | null {
  const mods: RemoteModifier[] = [...(e.ctrlKey ? ['ctrl' as const] : []), ...(e.altKey ? ['alt' as const] : []), ...(e.shiftKey ? ['shift' as const] : []), ...(e.metaKey ? ['meta' as const] : [])];
  const shortcut = e.ctrlKey || e.altKey || e.metaKey;
  if (!shortcut && e.key.length === 1 && e.key !== ' ') return { text: e.key };
  const k = ARROWS[e.key] ?? (e.key.length === 1 ? e.key.toLowerCase() : e.key);
  return KEY_SET.has(k) ? { key: k as RemoteKey, mods: e.key.length === 1 && !shortcut ? [] : mods } : null;
}

export function ScreenPage() {
  const peerId = (routeArg() ?? '').split('/')[0];
  const mesh = useCore('mesh.status');
  const device = (mesh.data?.devices ?? []).find((d) => d.id === peerId);
  const [session, setSession] = useState<RemoteSession | null>(null);
  const [frame, setFrame] = useState<RemoteFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(SHARP);
  const [display, setDisplay] = useState(0);
  const [busy, setBusy] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const queue = useRef<RemoteInput[]>([]);
  const live = session?.state === 'live';
  const control = live && session?.mode === 'control';

  const start = async (mode: RemoteMode) => {
    setBusy(true);
    setError(null);
    try {
      setSession(await call('screen.connect', { peerId, mode }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Waiting for the yes over there.
  useEffect(() => {
    if (session?.state !== 'asking') return;
    const t = setInterval(() => void call('screen.session', { peerId, id: session.id }).then(setSession, (e: Error) => setError(e.message)), 1000);
    return () => clearInterval(t);
  }, [session?.id, session?.state, peerId]);

  // Pictures, one after another; a slow link gets smaller ones.
  useEffect(() => {
    if (!live || !session) return;
    let stop = false;
    let seq = -1;
    let w = width;
    void (async () => {
      while (!stop) {
        try {
          const f = await call('screen.frame', { peerId, id: session.id, after: seq, display, maxWidth: w });
          if (f) {
            seq = f.seq;
            setFrame(f);
          }
        } catch (e) {
          const msg = (e as Error).message;
          if (/too large/i.test(msg) && w > 640) w = Math.round(w * 0.75);
          else if (/over|not reachable|NOT_FOUND/i.test(msg)) {
            setError(msg);
            void call('screen.session', { peerId, id: session.id }).then(setSession, () => undefined);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 120));
      }
    })();
    return () => {
      stop = true;
    };
  }, [live, session?.id, peerId, display, width]);

  // Mouse and keyboard go in small batches.
  useEffect(() => {
    if (!control || !session) return;
    const t = setInterval(() => {
      if (!queue.current.length) return;
      const events = queue.current.splice(0, 200);
      void call('screen.input', { peerId, id: session.id, events }).catch((e: Error) => setError(e.message));
    }, 60);
    return () => clearInterval(t);
  }, [control, session?.id, peerId]);

  // Leaving the page ends it (only leaving: not the session moving from asking to live).
  const latest = useRef<RemoteSession | null>(null);
  latest.current = session;
  useEffect(
    () => () => {
      const s = latest.current;
      if (s && (s.state === 'live' || s.state === 'asking')) void call('screen.end', { peerId, id: s.id }).catch(() => undefined);
    },
    [peerId],
  );

  const at = (e: React.MouseEvent | React.WheelEvent) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const push = (ev: RemoteInput) => {
    const last = queue.current[queue.current.length - 1];
    // Only the newest position of a run of moves matters.
    if (ev.t === 'move' && last?.t === 'move') queue.current[queue.current.length - 1] = ev;
    else queue.current.push(ev);
  };
  const button = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left') as 'left' | 'right' | 'middle';

  const end = async () => {
    if (session) setSession(await call('screen.end', { peerId, id: session.id }).catch(() => session));
  };

  const title = device ? `${device.name}'s screen` : 'Screen';
  return (
    <Page
      title={title}
      description="See a paired computer's screen, or use its mouse and keyboard. It needs Remote screen for this computer over there (Mesh, its permissions)."
      actions={
        <Button variant="ghost" icon="chevronLeft" onClick={() => navigate('mesh')}>
          Mesh
        </Button>
      }
    >
      {!device ? (
        <Empty title="That computer is not paired any more" />
      ) : !session || session.state === 'ended' || session.state === 'denied' ? (
        <Card title={`Connect to ${device.name}`} subtitle="The person there says yes each time, unless that computer lets this one in without asking. A red bar with Stop shows there while it lasts.">
          {session && <Callout tone={session.state === 'denied' ? 'warning' : 'info'} title={session.state === 'denied' ? 'Not allowed' : 'Ended'}>{session.why}</Callout>}
          {error && <Callout tone="critical" title="It did not work">{error}</Callout>}
          <div className="fx-actions">
            <Button variant="primary" icon="monitor" loading={busy} onClick={() => void start('control')}>
              Use it
            </Button>
            <Button icon="eye" loading={busy} onClick={() => void start('view')}>
              Only see it
            </Button>
          </div>
        </Card>
      ) : session.state === 'asking' ? (
        <Card title="Waiting for a yes">
          <p className="fx-secondary">The person at {device.name} is asked whether to share the screen. Nobody there? Ask them to turn on Remote screen without asking for this computer, in Mesh.</p>
          <Button variant="ghost" onClick={() => void end()}>
            Cancel
          </Button>
        </Card>
      ) : (
        <div className="screen-view">
          <div className="fx-actions screen-bar">
            <Status tone="good">{control ? 'Using it' : 'Seeing it'}</Status>
            {session.mode === 'view' && session.asked === 'control' && <span className="fx-muted">{session.control.why ?? 'View only, as the person there chose'}</span>}
            {(frame?.displays ?? session.displays) > 1 && (
              <Select value={String(display)} onChange={(e) => setDisplay(Number(e.target.value))} options={Array.from({ length: frame?.displays ?? session.displays }, (_, i) => ({ value: String(i), label: `Screen ${i + 1}` }))} />
            )}
            <Select value={String(width)} onChange={(e) => setWidth(Number(e.target.value))} options={[{ value: String(SHARP), label: 'Sharp' }, { value: String(FAST), label: 'Faster' }]} />
            <span className="fx-spacer" />
            <Button variant="danger" icon="x" onClick={() => void end()}>
              End
            </Button>
          </div>
          {error && <Callout tone="warning" title="The link stumbled">{error}</Callout>}
          {frame ? (
            <img
              ref={img}
              className={`screen-image${control ? ' screen-control' : ''}`}
              src={`data:image/jpeg;base64,${frame.jpeg}`}
              alt={`${device.name}'s screen`}
              draggable={false}
              tabIndex={control ? 0 : -1}
              onMouseMove={(e) => control && push({ t: 'move', ...at(e) })}
              onMouseDown={(e) => {
                if (!control) return;
                img.current?.focus();
                push({ t: 'down', ...at(e), button: button(e.button) });
              }}
              onMouseUp={(e) => control && push({ t: 'up', ...at(e), button: button(e.button) })}
              onContextMenu={(e) => control && e.preventDefault()}
              onWheel={(e) => control && push({ t: 'scroll', ...at(e), dy: Math.max(-50, Math.min(50, Math.round(e.deltaY / 40) || Math.sign(e.deltaY))) })}
              onKeyDown={(e) => {
                if (!control) return;
                const k = remoteKey(e.nativeEvent);
                if (!k) return;
                e.preventDefault();
                push('text' in k ? { t: 'text', text: k.text } : { t: 'key', key: k.key, mods: k.mods });
              }}
              onPaste={(e) => {
                if (!control) return;
                const text = e.clipboardData.getData('text').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 2000);
                if (text) push({ t: 'text', text });
              }}
            />
          ) : (
            <Empty title="The first picture is on its way…" />
          )}
          {control && <p className="fx-muted">Click the picture to type there. Paste sends the text on this computer's clipboard.</p>}
        </div>
      )}
    </Page>
  );
}

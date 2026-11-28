import { useEffect, useRef, useState } from 'react';
import { REMOTE_KEYS, type RemoteFrame, type RemoteInput, type RemoteKey, type RemoteModifier, type RemoteSession } from '@fbrx/shared';
import { Button, Callout, Empty, Field, Input, Modal, Select, Status, TextArea, useAction } from '@fbrx/ui';
import { api } from '../api';

/**
 * Remote screen from FBRX Command: the administrator gives a ticket number and a reason, the person at the computer is
 * asked (and may allow view only), then pictures and, with control, the administrator's mouse and keyboard. Closing
 * it ends the session; the audit log keeps it.
 */

const KEY_SET = new Set<string>(REMOTE_KEYS);

function remoteKey(e: KeyboardEvent): { key: RemoteKey; mods: RemoteModifier[] } | { text: string } | null {
  const mods: RemoteModifier[] = [...(e.ctrlKey ? ['ctrl' as const] : []), ...(e.altKey ? ['alt' as const] : []), ...(e.shiftKey ? ['shift' as const] : []), ...(e.metaKey ? ['meta' as const] : [])];
  const shortcut = e.ctrlKey || e.altKey || e.metaKey;
  if (!shortcut && e.key.length === 1 && e.key !== ' ') return { text: e.key };
  const k = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return KEY_SET.has(k) ? { key: k as RemoteKey, mods: e.key.length === 1 && !shortcut ? [] : mods } : null;
}

export function RemoteScreenModal({ deviceId, deviceName, onClose }: { deviceId: string; deviceName: string; onClose: () => void }) {
  const [ticket, setTicket] = useState('');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'control' | 'view'>('control');
  const [session, setSession] = useState<RemoteSession | null>(null);
  const [frame, setFrame] = useState<RemoteFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const img = useRef<HTMLImageElement>(null);
  const queue = useRef<RemoteInput[]>([]);
  const latest = useRef<RemoteSession | null>(null);
  latest.current = session;
  const live = session?.state === 'live';
  const control = live && session?.mode === 'control';

  useEffect(() => {
    if (session?.state !== 'asking') return;
    const t = setInterval(() => void api<RemoteSession>('GET', `/v1/admin/screen/${session.id}`).then(setSession, (e: Error) => setError(e.message)), 1000);
    return () => clearInterval(t);
  }, [session?.id, session?.state]);

  useEffect(() => {
    if (!live || !session) return;
    let stop = false;
    let seq = -1;
    void (async () => {
      while (!stop) {
        try {
          const f = await api<RemoteFrame | null>('GET', `/v1/admin/screen/${session.id}/frame?after=${seq}&maxWidth=1600`);
          if (f) {
            seq = f.seq;
            setFrame(f);
          }
        } catch (e) {
          setError((e as Error).message);
          void api<RemoteSession>('GET', `/v1/admin/screen/${session.id}`).then(setSession, () => undefined);
          return;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    })();
    return () => {
      stop = true;
    };
  }, [live, session?.id]);

  useEffect(() => {
    if (!control || !session) return;
    const t = setInterval(() => {
      if (!queue.current.length) return;
      void api('POST', `/v1/admin/screen/${session.id}/input`, { events: queue.current.splice(0, 200) }).catch((e: Error) => setError(e.message));
    }, 60);
    return () => clearInterval(t);
  }, [control, session?.id]);

  // Closing the window ends the session.
  useEffect(
    () => () => {
      const s = latest.current;
      if (s && (s.state === 'live' || s.state === 'asking')) void api('POST', `/v1/admin/screen/${s.id}/end`).catch(() => undefined);
    },
    [],
  );

  const at = (e: React.MouseEvent | React.WheelEvent) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const push = (ev: RemoteInput) => {
    const last = queue.current[queue.current.length - 1];
    if (ev.t === 'move' && last?.t === 'move') queue.current[queue.current.length - 1] = ev;
    else queue.current.push(ev);
  };
  const button = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left') as 'left' | 'right' | 'middle';

  const start = () =>
    void run('start', async () => {
      setError(null);
      setSession(await api<RemoteSession>('POST', `/v1/admin/devices/${deviceId}/screen`, { mode, ticket: ticket.trim(), reason: reason.trim() }));
    });

  const ended = session && (session.state === 'ended' || session.state === 'denied');
  return (
    <Modal title={`Remote screen: ${deviceName}`} onClose={onClose} wide={live}>
      {!session || ended ? (
        <div className="fx-form">
          {ended && <Callout tone={session!.state === 'denied' ? 'warning' : 'info'} title={session!.state === 'denied' ? 'Not allowed' : 'Ended'}>{session!.why}</Callout>}
          {error && <Callout tone="critical" title="It did not work">{error}</Callout>}
          <p className="fx-secondary">The person at the computer is asked first and can allow view only or say no; a red bar with Stop stays on their screen. The audit log keeps the ticket and the reason.</p>
          <Field label="Ticket number">
            <Input value={ticket} maxLength={40} onChange={(e) => setTicket(e.target.value)} placeholder="4521" />
          </Field>
          <Field label="Why (they see this)">
            <TextArea value={reason} maxLength={300} rows={2} onChange={(e) => setReason(e.target.value)} placeholder="Printer setup they asked for" />
          </Field>
          <Field label="Ask for">
            <Select value={mode} onChange={(e) => setMode(e.target.value as 'control' | 'view')} options={[{ value: 'control', label: 'Seeing and using the screen' }, { value: 'view', label: 'Seeing it only' }]} />
          </Field>
          <div className="fx-actions">
            <Button variant="primary" icon="monitor" loading={busy === 'start'} disabled={!ticket.trim()} onClick={start}>
              Ask
            </Button>
          </div>
        </div>
      ) : session.state === 'asking' ? (
        <Empty title="Waiting for a yes">
          The person at {deviceName} is asked whether to share their screen{(session as RemoteSession & { recorded?: boolean }).recorded ? ', and told this organization records the session' : ''}.
        </Empty>
      ) : (
        <div className="fx-form">
          <div className="fx-actions">
            <Status tone="good">{control ? 'Using it' : 'Seeing it'}</Status>
            {(session as RemoteSession & { recorded?: boolean }).recorded && <Status tone="info">Recorded</Status>}
            {session.mode === 'view' && session.asked === 'control' && <span className="fx-muted">{session.control.why ?? 'View only, as the person chose'}</span>}
            <span className="fx-spacer" />
            <Button variant="danger" icon="x" onClick={() => void api<RemoteSession>('POST', `/v1/admin/screen/${session.id}/end`).then(setSession, () => onClose())}>
              End
            </Button>
          </div>
          {error && <Callout tone="warning" title="The link stumbled">{error}</Callout>}
          {frame ? (
            <img
              ref={img}
              src={`data:image/jpeg;base64,${frame.jpeg}`}
              alt={`${deviceName}'s screen`}
              draggable={false}
              tabIndex={control ? 0 : -1}
              style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', background: '#000', borderRadius: 8, cursor: control ? 'crosshair' : 'default', userSelect: 'none' }}
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
        </div>
      )}
    </Modal>
  );
}

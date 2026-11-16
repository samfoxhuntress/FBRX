import { useEffect, useRef, useState } from 'react';
import { Button, Callout, Empty, Modal, Page, Select, Status, Table, formatDate, useAction } from '@fbrx/ui';
import { api, apiBlob } from '../api';
import { useApp, useQuery } from '../state';

/**
 * Screen recordings: the remote screen sessions an organization keeps (Profiles & groups → Remote screen recordings),
 * with a player. Owners and administrators watch them; each watch and each delete is in the audit log.
 */

interface Recording {
  id: string;
  deviceId: string;
  device: string;
  admin: string;
  ticket: string;
  reason: string;
  mode: string;
  startedAt: string;
  endedAt: string | null;
  frames: number;
  bytes: number;
  inputUsed: boolean;
  cut: string | null;
}
interface Detail extends Omit<Recording, 'frames'> {
  frames: Array<{ t: number; width: number; height: number }>;
  inputs: number[];
}

const seconds = (r: { startedAt: string; endedAt: string | null }) => (r.endedAt ? Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)) : 0);
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
};
/** A picture as a data: address (the console's page rules allow those, not blob: ones). */
const dataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the picture'));
    r.readAsDataURL(b);
  });
const CUT: Record<string, string> = { size: 'Stopped at the size limit', length: 'Stopped after four hours', restart: 'Cut short when FBRX Command restarted' };

export function RecordingsPage() {
  const app = useApp();
  const list = useQuery<{ on: boolean; days: number; recordings: Recording[] }>('/v1/admin/screen-recordings', [], (e) => e.type === 'audit' && String(e.entry?.action ?? '').startsWith('device.screen.'));
  const [watch, setWatch] = useState<string | null>(null);
  const [gone, setGone] = useState<Recording | null>(null);
  const { run, busy } = useAction();
  const d = list.data;
  return (
    <Page title="Screen recordings" description="Remote screen sessions this organization keeps: what the administrator saw, a picture a second, and when the mouse and keyboard were used (never what was typed).">
      {d && (
        <Callout tone={d.on ? 'info' : 'warning'} title={d.on ? `Recording is on: kept for ${d.days} day${d.days === 1 ? '' : 's'}` : 'Recording is off'}>
          {d.on ? 'The person at the computer is told in the question and on the red bar that the session is recorded. ' : 'New sessions are not recorded. '}
          Owners and administrators change this in Profiles &amp; groups, under the organization.
        </Callout>
      )}
      {list.error && <Callout tone="critical" title="Could not load the recordings">{list.error}</Callout>}
      <Table
        rows={d?.recordings ?? []}
        rowKey={(r) => r.id}
        onRowClick={(r) => setWatch(r.id)}
        empty={<Empty title="No recordings">{d?.on ? 'Sessions show here once they end.' : 'Turn recording on to keep sessions.'}</Empty>}
        columns={[
          { key: 'when', header: 'Started', render: (r) => formatDate(r.startedAt) },
          { key: 'device', header: 'Computer', render: (r) => r.device },
          { key: 'admin', header: 'Administrator', render: (r) => r.admin },
          { key: 'ticket', header: 'Ticket', render: (r) => <span title={r.reason}>{r.ticket}</span> },
          { key: 'len', header: 'Length', render: (r) => clock(seconds(r) * 1000) },
          { key: 'input', header: 'Mouse and keyboard', render: (r) => (r.inputUsed ? <Status tone="info">Used</Status> : <span className="fx-muted">{r.mode === 'view' ? 'Seeing only' : 'Not used'}</span>) },
          {
            key: 'go',
            header: '',
            render: (r) => (
              <div className="fx-actions" onClick={(e) => e.stopPropagation()}>
                <Button size="sm" icon="play" onClick={() => setWatch(r.id)}>
                  Watch
                </Button>
                {app.can('config.manage') && (
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setGone(r)}>
                    Delete
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
      {watch && <Player id={watch} onClose={() => setWatch(null)} />}
      {gone && (
        <Modal
          title="Delete this recording?"
          onClose={() => setGone(null)}
          footer={
            <>
              <Button onClick={() => setGone(null)}>Keep it</Button>
              <Button variant="danger" loading={busy === 'del'} onClick={() => void run('del', () => api('DELETE', `/v1/admin/screen-recordings/${gone.id}`).then(() => (setGone(null), list.reload())), 'Recording deleted')}>
                Delete
              </Button>
            </>
          }
        >
          <p>
            {gone.admin} on {gone.device}, ticket {gone.ticket}, {formatDate(gone.startedAt)}. It cannot be brought back; the audit log keeps that it was deleted and by whom.
          </p>
        </Modal>
      )}
    </Page>
  );
}

/** Plays a recording: its pictures at their times, with play, a timeline (the marks are mouse and keyboard use) and speed. */
function Player({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [src, setSrc] = useState<string | null>(null);
  const cache = useRef(new Map<number, string>());

  useEffect(() => {
    void api<Detail>('GET', `/v1/admin/screen-recordings/${id}`).then(setD, (e: Error) => setError(e.message));
    const c = cache.current;
    return () => c.clear();
  }, [id]);

  const length = d ? Math.max(d.frames[d.frames.length - 1]?.t ?? 0, (seconds(d) || 0) * 1000) : 0;
  // The picture on screen at a moment: the last one taken at or before it.
  const index = (ms: number) => {
    if (!d?.frames.length) return -1;
    let lo = 0;
    let hi = d.frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (d.frames[mid].t <= ms) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const n = index(at);

  const load = async (i: number) => {
    if (i < 0 || !d || i >= d.frames.length) return null;
    const have = cache.current.get(i);
    if (have) return have;
    const url = await dataUrl(await apiBlob(`/v1/admin/screen-recordings/${id}/frames/${i}`));
    cache.current.set(i, url);
    // Kept to a few hundred pictures in memory.
    if (cache.current.size > 300) cache.current.delete(cache.current.keys().next().value!);
    return url;
  };

  useEffect(() => {
    if (n < 0) return;
    let live = true;
    void load(n).then((u) => live && u && setSrc(u), (e: Error) => setError(e.message));
    // The next few, ready before they are needed.
    for (let i = 1; i <= 3; i++) void load(n + i).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [n, d]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setAt((x) => {
      const next = x + 200 * speed;
      if (next >= length) {
        setPlaying(false);
        return length;
      }
      return next;
    }), 200);
    return () => clearInterval(t);
  }, [playing, speed, length]);

  return (
    <Modal title={d ? `${d.device}: ticket ${d.ticket}` : 'Recording'} onClose={onClose} wide>
      {error && <Callout tone="critical" title="It did not play">{error}</Callout>}
      {!d ? (
        !error && <Empty title="Loading the recording…" />
      ) : (
        <div className="fx-form">
          <p className="fx-secondary">
            {d.admin}, {formatDate(d.startedAt)}, {d.mode === 'control' ? 'seeing and using the screen' : 'seeing it only'}
            {d.reason ? `. Why: ${d.reason}` : ''}
            {d.cut && CUT[d.cut] ? `. ${CUT[d.cut]}` : ''}
          </p>
          <div style={{ background: '#000', borderRadius: 8, display: 'flex', justifyContent: 'center', minHeight: 240 }}>
            {src ? <img src={src} alt={`${d.device}'s screen at ${clock(at)}`} draggable={false} style={{ maxWidth: '100%', maxHeight: '64vh', objectFit: 'contain' }} /> : <Empty title="No pictures" />}
          </div>
          <div style={{ position: 'relative' }}>
            <input type="range" min={0} max={Math.max(1, length)} step={100} value={at} aria-label="Where in the recording" style={{ width: '100%', accentColor: 'var(--accent)' }} onChange={(e) => (setPlaying(false), setAt(Number(e.target.value)))} />
            <div aria-hidden style={{ position: 'relative', height: 6, margin: '0 8px' }}>
              {d.inputs.map((t, i) => (
                <span key={i} style={{ position: 'absolute', left: `${(t / Math.max(1, length)) * 100}%`, width: 2, height: 6, background: 'var(--fg-muted, #888)', borderRadius: 1 }} />
              ))}
            </div>
          </div>
          <div className="fx-actions">
            <Button variant="primary" icon={playing ? 'pause' : 'play'} onClick={() => (at >= length ? (setAt(0), setPlaying(true)) : setPlaying(!playing))}>
              {playing ? 'Pause' : 'Play'}
            </Button>
            <span className="fx-muted">
              {clock(at)} / {clock(length)}
            </span>
            <span className="fx-spacer" />
            {d.inputs.length > 0 && <span className="fx-muted">Marks: mouse or keyboard used</span>}
            <div style={{ width: 90 }}>
              <Select value={String(speed)} aria-label="Speed" onChange={(e) => setSpeed(Number(e.target.value))} options={[1, 2, 4, 8].map((s) => ({ value: String(s), label: `${s}×` }))} />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

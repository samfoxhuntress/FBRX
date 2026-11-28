import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { SNAPSHOT_MODES, SNAPSHOT_MODE_NAMES, type SnapshotMode } from '@fbrx/shared';
import { Icons, Spinner, type IconName } from '@fbrx/ui';
import { bridge } from './client';

/** The still picture of this screen, from when the snapshot started. */
interface Frame {
  image: string;
  mode: SnapshotMode;
  /** The pointer was on this screen: it lists the windows. */
  home: boolean;
  screens: number;
}

interface WindowChoice {
  id: string;
  name: string;
  picture: string;
  icon: string | null;
}

const MODE_ICON: Record<SnapshotMode, IconName> = { region: 'crop', window: 'appWindow', screen: 'monitor' };

const snap = (action: 'frame' | 'mode' | 'windows' | 'pick' | 'cancel', arg?: unknown) => bridge.snap?.(action, arg) ?? Promise.resolve(null);

/** Gives up on `p` after `ms` (a capture that never delivers a frame). */
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out')), ms))]);

/** A window at its real size: one frame of it, captured the way screen sharing does (then PNG bytes). */
async function grabWindow(id: string): Promise<Uint8Array> {
  const constraints = { audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: 7680, maxHeight: 4320 } } };
  const stream = await within(navigator.mediaDevices.getUserMedia(constraints as unknown as MediaStreamConstraints), 4000);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await within(video.play(), 3000);
    // A frame to draw (a still window may not send another).
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await within(new Promise((r) => video.addEventListener('loadeddata', r, { once: true })), 3000);
    if (!video.videoWidth || !video.videoHeight) throw new Error('No picture');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('No picture');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/**
 * FBRX Snapshot's overlay, one over each screen: the screen as it was, to drag out an area, click for the whole screen,
 * or pick a window from the list. Esc leaves without a snapshot.
 */
export function SnapOverlay() {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [mode, setMode] = useState<SnapshotMode>('region');
  const [drag, setDrag] = useState<{ x0: number; y0: number; x: number; y: number } | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [windows, setWindows] = useState<WindowChoice[] | null>(null);
  const [taking, setTaking] = useState(false);

  useEffect(() => {
    void snap('frame').then((f) => {
      if (!f) return;
      setFrame(f as Frame);
      setMode((f as Frame).mode);
    });
    const keys = (e: KeyboardEvent) => e.key === 'Escape' && void snap('cancel');
    window.addEventListener('keydown', keys);
    const off = bridge.onSnapMode?.((m) => setMode(m as SnapshotMode));
    return () => {
      window.removeEventListener('keydown', keys);
      off?.();
    };
  }, []);
  useEffect(() => {
    if (mode === 'window' && frame?.home && !windows) void snap('windows').then((w) => setWindows((w as WindowChoice[] | null) ?? []));
  }, [mode, frame, windows]);

  const choose = (m: SnapshotMode) => {
    setMode(m);
    setDrag(null);
    void snap('mode', m);
  };
  const pickWindow = async (w: WindowChoice) => {
    setTaking(true);
    // Where the window cannot be captured this way, the desktop app takes a picture of it instead.
    const png = await grabWindow(w.id).catch(() => undefined);
    await snap('pick', { kind: 'window', id: w.id, png });
  };

  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0 || taking) return;
    if (mode === 'screen') {
      setTaking(true);
      void snap('pick', { kind: 'screen' });
    } else if (mode === 'region') {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY });
    }
  };
  const move = (e: ReactPointerEvent) => {
    setPointer({ x: e.clientX, y: e.clientY });
    if (drag) setDrag({ ...drag, x: e.clientX, y: e.clientY });
  };
  const rect = drag && { x: Math.min(drag.x0, drag.x), y: Math.min(drag.y0, drag.y), width: Math.abs(drag.x - drag.x0), height: Math.abs(drag.y - drag.y0) };
  const up = () => {
    setDrag(null);
    // A click without a drag is not an area.
    if (!rect || rect.width < 4 || rect.height < 4) return;
    setTaking(true);
    void snap('pick', { kind: 'region', ...rect });
  };

  if (!frame) return <div className="snap-overlay" />;
  const dpr = window.devicePixelRatio || 1;
  return (
    <div className={`snap-overlay mode-${mode}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={() => setPointer(null)}>
      <img className="snap-still" src={frame.image} alt="" draggable={false} />
      {mode === 'region' && !rect && <div className="snap-dim" />}
      {mode === 'region' && !rect && pointer && (
        <>
          <div className="snap-guide x" style={{ left: pointer.x }} />
          <div className="snap-guide y" style={{ top: pointer.y }} />
        </>
      )}
      {rect && (
        <div className="snap-sel" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
          <span className={`snap-size${rect.y > 28 ? '' : ' inside'}`}>
            {Math.round(rect.width * dpr)} × {Math.round(rect.height * dpr)}
          </span>
        </div>
      )}
      {mode === 'screen' && (
        <div className="snap-whole">
          <span>Click to take this screen</span>
        </div>
      )}
      {mode === 'window' && (
        <div className="snap-dim">
          {!frame.home ? (
            <p className="snap-note">Pick a window on the other screen.</p>
          ) : !windows ? (
            <Spinner />
          ) : !windows.length ? (
            <p className="snap-note">No windows to take here. Try an area or the whole screen.</p>
          ) : (
            <div className="snap-windows" onPointerDown={(e) => e.stopPropagation()}>
              {windows.map((w) => (
                  <button key={w.id} className="snap-window" disabled={taking} onClick={() => void pickWindow(w)}>
                    <img src={w.picture} alt="" draggable={false} />
                    <span>
                      {w.icon && <img src={w.icon} alt="" />}
                      {w.name}
                    </span>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      <div className="snap-bar" onPointerDown={(e) => e.stopPropagation()}>
        <div className="seg" role="group" aria-label="What to take">
          {SNAPSHOT_MODES.map((m) => {
            const Ico = Icons[MODE_ICON[m]];
            return (
              <button key={m} className={mode === m ? 'on' : ''} onClick={() => choose(m)}>
                <Ico size={14} /> {SNAPSHOT_MODE_NAMES[m]}
              </button>
            );
          })}
        </div>
        <span className="snap-hint">{mode === 'region' ? 'Drag over what to take' : mode === 'screen' ? (frame.screens > 1 ? 'Click the screen to take' : 'Click to take it') : 'Pick a window'} · Esc to cancel</span>
        <button className="snap-close" aria-label="Cancel" onClick={() => void snap('cancel')}>
          <Icons.x size={15} />
        </button>
      </div>
    </div>
  );
}

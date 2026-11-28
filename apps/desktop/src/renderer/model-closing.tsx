import { useEffect, useState } from 'react';
import type { RuntimeClosing } from '@fbrx/shared';
import { Button, Modal, useAction } from '@fbrx/ui';
import { bridge, call } from './client';
import { useCore } from './hooks';

/** How to end the model's process by hand, on this kind of computer. */
function endItYourself(pid: number | null): string {
  if (bridge.platform === 'win32') return 'Open Task Manager, find "llama-server.exe" under Details, and choose End task.';
  if (bridge.platform === 'darwin') return `Open Activity Monitor, find "llama-server"${pid ? ` (PID ${pid})` : ''}, and choose Force Quit.`;
  return pid ? `In a terminal, run: kill -9 ${pid}` : 'In a terminal, run: pkill -9 llama-server';
}

/** How far the close got, 0 to 100: the time it was given to stop by itself, then by force. */
function progress(c: RuntimeClosing, now: number): number {
  const since = Math.max(0, now - Date.parse(c.stageAt));
  if (c.stage === 'stopping') return Math.min(60, (since / Math.max(1, c.graceMs)) * 60);
  if (c.stage === 'forcing') return 60 + Math.min(35, (since / Math.max(1, c.forceMs)) * 35);
  return 96;
}

/**
 * While the local model closes (switching models, Stop, quitting FBRX OS), the app waits with it: what is happening,
 * how far it got, Stop it now (no waiting for an answer it was writing), and when it does not stop, a kill switch and
 * what else to try. A quick close shows nothing.
 */
export function ModelClosing() {
  const status = useCore('runtime.status', undefined, ['runtime.changed']);
  const c = status.data?.closing ?? null;
  const { run, busy } = useAction();
  const [shown, setShown] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const key = c ? `${c.startedAt}:${c.why ?? ''}` : null;
  useEffect(() => {
    if (!c) {
      setShown(false);
      return;
    }
    const show = setTimeout(() => setShown(true), c.why === 'quit' ? 0 : 700);
    const tick = setInterval(() => setNow(Date.now()), 200);
    return () => {
      clearTimeout(show);
      clearInterval(tick);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c || !shown) return null;
  const quitting = c.why === 'quit';
  const stuck = c.stage === 'stuck';
  const pct = progress(c, now);
  const seconds = Math.round((now - Date.parse(c.startedAt)) / 1000);
  const forceNow = () => void run('force', () => call('runtime.forceStop'));
  const goOn = () => void run('go', () => call('runtime.giveUpClosing'));
  const footer = stuck ? (
    <>
      <Button loading={busy === 'force'} icon="refresh" onClick={forceNow}>
        Try to stop it again
      </Button>
      <Button variant="danger" loading={busy === 'go'} onClick={goOn}>
        {quitting ? 'Quit anyway' : 'Go on without waiting'}
      </Button>
    </>
  ) : c.stage === 'stopping' ? (
    <Button variant="danger" icon="stop" loading={busy === 'force'} onClick={forceNow}>
      Stop it now
    </Button>
  ) : (
    <Button disabled>Stopping…</Button>
  );
  return (
    <Modal title={quitting ? `Closing ${c.modelName} before FBRX OS quits` : `Closing ${c.modelName}`} onClose={() => undefined} footer={footer}>
      <div className="model-closing">
        <p>
          {c.stage === 'stopping'
            ? 'Asking the model to finish and give its memory back to the computer.'
            : c.stage === 'forcing'
              ? c.forced
                ? 'Stopping it now and freeing its memory.'
                : 'It did not stop in time, so FBRX is stopping it by force.'
              : 'The model is not stopping.'}
        </p>
        <div className="fx-meter model-closing-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Closing the model">
          <div style={{ width: `${pct}%`, background: stuck ? 'var(--warning)' : 'var(--accent)' }} />
        </div>
        <div className="fx-muted model-closing-time">
          {seconds} s{c.pid ? ` · process ${c.pid}` : ''}
        </div>
        {c.stage === 'stopping' && <p className="fx-muted">Stop it now frees its memory at once. An answer it is still writing is lost.</p>}
        {stuck && (
          <div className="model-closing-help">
            <b>What to try</b>
            <ol>
              <li>Give it a minute: a large model can be waiting for the disk while it is moved out of memory.</li>
              <li>Close other large programs, so the computer has memory to spare.</li>
              <li>End it yourself. {endItYourself(c.pid)}</li>
              <li>Or restart the computer.</li>
            </ol>
            <p className="fx-muted">
              {quitting ? 'If you quit anyway' : 'If you go on without waiting'}, FBRX stops this model the next time it loads one, so the two never run side by side.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

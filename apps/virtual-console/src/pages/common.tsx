import type { VmPowerAction, VmState, VmSummary } from '@fbrx/shared';
import { Button, Status, useAction, useToast, type StatusTone } from '@fbrx/ui';
import { api } from '../api';
import { useApp } from '../state';

const TONES: Record<VmState, StatusTone> = { running: 'good', paused: 'warning', stopped: 'neutral', 'shutting-down': 'busy', crashed: 'critical', suspended: 'warning', unknown: 'neutral' };
const WORDS: Record<VmState, string> = { running: 'Running', paused: 'Paused', stopped: 'Off', 'shutting-down': 'Shutting down', crashed: 'Crashed', suspended: 'Suspended', unknown: 'Unknown' };

export function VmStateBadge({ state }: { state: VmState }) {
  return <Status tone={TONES[state]}>{WORDS[state]}</Status>;
}

export const mb = (n: number | null | undefined) => (n == null ? '—' : n >= 1024 ? `${Math.round((n / 1024) * 10) / 10} GB` : `${n} MB`);
export const gb = (n: number | null | undefined) => (n == null ? '—' : n >= 1024 ? `${Math.round((n / 1024) * 10) / 10} TB` : `${Math.round(n * 10) / 10} GB`);
export const osName = (os: VmSummary['os']) => (os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : 'Other');

/** Start, shut down, restart, pause and force off, as fits the machine's state. */
export function PowerButtons({ vm, onDone, size }: { vm: Pick<VmSummary, 'id' | 'name' | 'state'>; onDone: () => void; size?: 'sm' }) {
  const app = useApp();
  const toast = useToast();
  const { busy, run } = useAction();
  if (!app.can('operator')) return null;
  const act = (action: VmPowerAction, label: string) =>
    run(action, async () => {
      await api('POST', `/v1/vms/${vm.id}/power`, { action });
      toast.success(`${vm.name}: ${label}`);
      onDone();
    });
  const live = vm.state === 'running' || vm.state === 'paused';
  return (
    <span className="fx-row" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
      {!live && (
        <Button size={size} variant="primary" icon="play" loading={busy === 'start'} onClick={() => void act('start', 'starting')}>
          Start
        </Button>
      )}
      {vm.state === 'running' && (
        <>
          <Button size={size} icon="power" loading={busy === 'shutdown'} onClick={() => void act('shutdown', 'asked to shut down')} title="Asks the guest operating system to shut down">
            Shut down
          </Button>
          <Button size={size} icon="refresh" loading={busy === 'reboot'} onClick={() => void act('reboot', 'restarting')} aria-label="Restart" title="Restart" />
          <Button size={size} icon="clock" loading={busy === 'pause'} onClick={() => void act('pause', 'paused')} aria-label="Pause" title="Pause (freeze it in memory)" />
        </>
      )}
      {vm.state === 'paused' && (
        <Button size={size} icon="play" loading={busy === 'resume'} onClick={() => void act('resume', 'resumed')}>
          Resume
        </Button>
      )}
      {(live || vm.state === 'shutting-down' || vm.state === 'crashed') && (
        <Button size={size} variant="danger" icon="stop" loading={busy === 'stop'} onClick={() => void act('stop', 'turned off')} title="Pulls the plug: like holding the power button">
          Force off
        </Button>
      )}
    </span>
  );
}

export function Pct({ value }: { value: number | null }) {
  if (value == null) return <span className="fx-muted">—</span>;
  return (
    <span className="vt-pct">
      <span className="vt-pct-bar" style={{ width: `${Math.min(100, value)}%` }} />
      <span>{value.toFixed(value < 10 ? 1 : 0)}%</span>
    </span>
  );
}

import { createContext, useContext, useEffect, useState } from 'react';
import type { ModelInfo } from '@fbrx/shared';
import { Button, Field, Icons, Input, formatBytes, formatDate, useConfirm, useToast } from '@fbrx/ui';
import { navigate } from './app';
import { call } from './client';
import { useCore } from './hooks';
import { cluck, unlockTrophy } from './fun';

const OTHER = '__other__';

/** Label for a model in lists: name, size details and why it cannot be used right now. */
export function modelLabel(m: ModelInfo): string {
  const extra = [m.details, m.sizeBytes ? formatBytes(m.sizeBytes) : null].filter(Boolean).join(' · ');
  return `${m.id}${extra ? ` — ${extra}` : ''}${m.unavailable ? ` (${m.unavailable.toLowerCase()})` : ''}`;
}

/** Models a provider has (Ollama: the ones already downloaded on this computer); reloads when `providerId` changes. */
export function useModels(providerId: string) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setModels(null);
    setError(null);
    if (!providerId) return;
    call('ai.models', { providerId })
      .then((m) => alive && setModels(m))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [providerId, tick]);
  return { models, error, reload: () => setTick((t) => t + 1) };
}

/**
 * Model chooser: a list of the provider's installed models, with "Other model…" for typing a name. Falls back to a
 * text box when the provider cannot list its models. An empty value means the provider's default.
 */
export function ModelPicker({ providerId, value, onChange, defaultLabel = 'Automatic (best installed model)', ariaLabel = 'Model' }: { providerId: string; value: string; onChange: (v: string) => void; defaultLabel?: string; ariaLabel?: string }) {
  const { models, error, reload } = useModels(providerId);
  const [typing, setTyping] = useState(false);
  const listed = models ?? [];
  const inList = !value || listed.some((m) => m.id === value);
  if (typing || error || (models && (!listed.length || !inList))) {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input className="fx-input" aria-label={ariaLabel} value={value} placeholder={listed.length ? 'Model name' : 'Model name, e.g. qwen2.5:7b'} onChange={(e) => onChange(e.target.value)} />
        {listed.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setTyping(false);
              if (!listed.some((m) => m.id === value)) onChange('');
            }}
          >
            List
          </Button>
        )}
        {(error || !listed.length) && (
          <Button size="sm" variant="ghost" icon="refresh" aria-label="Look for models again" title={error ?? 'No models found yet'} onClick={reload} />
        )}
      </div>
    );
  }
  return (
    <select
      className="fx-select"
      aria-label={ariaLabel}
      value={value}
      disabled={!models}
      onChange={(e) => {
        if (e.target.value === OTHER) setTyping(true);
        else onChange(e.target.value);
      }}
    >
      {!models ? <option value={value}>Looking for models…</option> : <option value="">{defaultLabel}</option>}
      {listed.map((m) => (
        <option key={m.id} value={m.id}>
          {modelLabel(m)}
        </option>
      ))}
      {models && <option value={OTHER}>Other model…</option>}
    </select>
  );
}

/**
 * Opens a new chat with the agent and sends `prompt`, with `context` (a log, a report, a list…) attached below it.
 * Long context is trimmed so the request stays a reasonable size for local models.
 */
export function askAgent(prompt: string, context?: unknown): void {
  const raw = context === undefined || context === null ? '' : typeof context === 'string' ? context : JSON.stringify(context, null, 1);
  const ctx = raw.length > 12_000 ? `${raw.slice(0, 12_000)}\n… (trimmed)` : raw;
  navigate(`agent/ask/${encodeURIComponent(ctx ? `${prompt}\n\n---\n${ctx}` : prompt)}`);
}

/** The agent's name for buttons deep in the page tree (provided by the main app). */
export const AgentNameContext = createContext('Fabrix');

/** A sparkle button that hands an item to the agent for analysis. */
export function AskButton({ prompt, context, label = 'Analyze', iconOnly = false, variant }: { prompt: string; context?: unknown; label?: string; iconOnly?: boolean; variant?: 'primary' | 'ghost' }) {
  const agent = useContext(AgentNameContext);
  return (
    <Button size="sm" variant={variant} className={variant ? undefined : 'ask-btn'} icon="sparkles" title={`${label} with ${agent}`} aria-label={`${label} with ${agent}`} onClick={() => askAgent(prompt, context)}>
      {iconOnly ? null : label}
    </Button>
  );
}

/** Whether the AI is on emergency stop (and since when, by whom), kept fresh as it changes. */
export function useAiHalt() {
  const { data, reload } = useCore('system.status', undefined, ['ai.halted'], 30_000);
  return { halt: data?.aiHalt ?? null, loaded: !!data, reload };
}

/**
 * The emergency stop: one press cancels everything the AI is doing (chats, tools waiting for approval, AI apps using
 * FBRX over the Local API) and keeps it stopped until someone at this computer resumes it.
 */
export function EmergencyStop({ compact = false }: { compact?: boolean }) {
  const { halt, loaded } = useAiHalt();
  const agent = useContext(AgentNameContext);
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  if (!loaded) return null;
  const stop = async () => {
    setBusy(true);
    try {
      const r = await call('ai.hardStop');
      toast.warning('AI stopped', `${r.cancelledRuns} run${r.cancelledRuns === 1 ? '' : 's'} canceled, ${r.deniedApprovals} approval${r.deniedApprovals === 1 ? '' : 's'} denied. Nothing AI-driven runs until you resume.`);
    } catch (e) {
      toast.error('Could not stop the AI', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    if (!(await confirm({ title: `Resume ${agent}?`, body: `${agent} and AI apps connected to FBRX can work again, within your Governance rules.`, confirmLabel: 'Resume' }))) return;
    setBusy(true);
    try {
      await call('ai.resume');
      toast.success('AI resumed');
    } catch (e) {
      toast.error('Could not resume', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (halt) {
    return (
      <div className={`estop halted${compact ? ' compact' : ''}`}>
        <span className="estop-light" aria-hidden />
        <div className="estop-text">
          <b>AI on emergency stop</b>
          {!compact && (
            <span>
              Since {formatDate(halt.at)} ({halt.by.replace(/^user:/, '')}). Chats, AI tools and connected AI apps are blocked.
            </span>
          )}
        </div>
        <Button size="sm" variant="primary" icon="play" loading={busy} onClick={() => void resume()}>
          Resume
        </Button>
        {dialog}
      </div>
    );
  }
  return (
    <div className={`estop${compact ? ' compact' : ''}`}>
      <button className="estop-button" disabled={busy} onClick={() => void stop()} title="Stops every AI action right now and keeps the AI stopped until you resume it">
        <span className="estop-cap" aria-hidden>
          STOP
        </span>
      </button>
      {compact ? (
        <span className="estop-label">Emergency stop</span>
      ) : (
        <div className="estop-text">
          <b>Emergency stop</b>
          <span>Cancels everything {agent} and connected AI apps are doing, denies waiting approvals and stops the local model. It stays stopped until you resume.</span>
        </div>
      )}
      {dialog}
    </div>
  );
}

/** Saves who uses this computer (and handles the chicken). */
export async function saveProfile(p: { name: string; callMe: string }, fun: boolean, toast: ReturnType<typeof useToast>): Promise<void> {
  await call('settings.update', { patch: { profile: { name: p.name.trim().slice(0, 60), callMe: p.callMe.trim().slice(0, 40) } } });
  if (fun && /^chicken$/i.test(p.callMe.trim())) {
    cluck();
    unlockTrophy('chicken');
    toast.info('Nobody calls me chicken!', '…but if you insist. Bawk.');
  }
}

/** Name and form of address, side by side. */
export function ProfileFields({ name, callMe, onChange, autoFocus }: { name: string; callMe: string; onChange: (p: { name: string; callMe: string }) => void; autoFocus?: boolean }) {
  return (
    <div className="fx-row">
      <Field label="Your name">
        <Input value={name} maxLength={60} placeholder="Samuel Fox" autoFocus={autoFocus} onChange={(e) => onChange({ name: e.target.value, callMe })} />
      </Field>
      <Field label="What should FBRX call you?" help="Optional: a nickname or title, like Sam or Sir">
        <Input value={callMe} maxLength={40} placeholder={name.trim().split(/\s+/)[0] || 'Sam'} onChange={(e) => onChange({ name, callMe: e.target.value })} />
      </Field>
    </div>
  );
}

/** On FBRX Glass, once: asks for a name when none is set (people who set FBRX up before it asked). */
export function NamePrompt({ fun }: { fun: boolean }) {
  const { data } = useCore('settings.get', undefined, ['settings.changed']);
  const toast = useToast();
  const [p, setP] = useState({ name: '', callMe: '' });
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('fbrx.namePromptDismissed') === '1';
    } catch {
      return false;
    }
  });
  if (!data || hidden || data.settings.profile.name.trim()) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem('fbrx.namePromptDismissed', '1');
    } catch {
      /* fine */
    }
  };
  return (
    <div className="glass-tile name-prompt">
      <div className="glass-tile-head">
        <Icons.users size={15} />
        Nice to meet you
      </div>
      <div className="fx-secondary" style={{ fontSize: 13, margin: '6px 0 10px' }}>
        What's your name? FBRX Glass and {data.settings.ai.agentName} will greet you by it. You can change it any time in Settings → General.
      </div>
      <ProfileFields name={p.name} callMe={p.callMe} onChange={setP} />
      <div className="fx-actions" style={{ marginTop: 10 }}>
        <Button size="sm" variant="primary" disabled={!p.name.trim()} onClick={() => void saveProfile(p, fun, toast)}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}

import { createContext, useContext, useEffect, useState } from 'react';
import type { ModelInfo } from '@fbrx/shared';
import { Button, formatBytes } from '@fbrx/ui';
import { navigate } from './app';
import { call } from './client';

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
export const AgentNameContext = createContext('Fabric');

/** A sparkle button that hands an item to the agent for analysis. */
export function AskButton({ prompt, context, label = 'Analyze', iconOnly = false, variant }: { prompt: string; context?: unknown; label?: string; iconOnly?: boolean; variant?: 'primary' | 'ghost' }) {
  const agent = useContext(AgentNameContext);
  return (
    <Button size="sm" variant={variant} className={variant ? undefined : 'ask-btn'} icon="sparkles" title={`${label} with ${agent}`} aria-label={`${label} with ${agent}`} onClick={() => askAgent(prompt, context)}>
      {iconOnly ? null : label}
    </Button>
  );
}

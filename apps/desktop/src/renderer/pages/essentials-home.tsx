import { useState } from 'react';
import { homeBoard, notesFor, type EssentialsNote, type SystemStatus } from '@fbrx/shared';
import { Button, Icons, type IconName } from '@fbrx/ui';
import { useCore } from '../hooks';
import { navigate } from '../app';
import { SplitFlapBoard } from '../splitflap';

const DISMISSED_KEY = 'fbrx.home.dismissed';

function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

const NOTE_ICON: Record<EssentialsNote['kind'], IconName> = { welcome: 'sparkles', tip: 'info', models: 'cpu', upgrade: 'layers' };
const ROUTE: Record<NonNullable<EssentialsNote['action']>['to'], string> = { agent: 'agent', models: 'runtime', edition: 'settings/edition', pair: 'settings/account' };

/**
 * Home in Endpoint Essentials: no dashboard, just the split-flap board and a few notes from FBRX: tips and tricks, the
 * AI models, and what Standard and Ultra add. The same notes are on the phone (FBRX Mobile).
 */
export function EssentialsHome({ status, agentName, who }: { status: SystemStatus; agentName: string; who: string | null }) {
  const providers = useCore('ai.providers', undefined, ['settings.changed', 'runtime.changed', 'policy.changed']);
  const runtime = useCore('runtime.status', undefined, ['runtime.changed', 'settings.changed']);
  const models = useCore('runtime.installed', undefined, ['runtime.changed', 'settings.changed']);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const aiReady = !!providers.data?.some((p) => p.available);
  const modelName = models.data?.find((m) => m.id === runtime.data?.modelId)?.name ?? null;
  // The welcome stays until it is dismissed.
  const firstDays = !dismissed.includes('welcome');
  const notes = notesFor({ tier: status.license.tier, agentName, modelName, dismissed, firstDays });
  const board = homeBoard({ name: who, agentName, aiReady, deviceName: status.deviceName, tier: status.license.tier });
  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {
      /* private storage */
    }
  };
  return (
    <div className="fx-page glass-dash essentials-home">
      <div className="glass-aurora" aria-hidden />
      <section className="glass-hero">
        <span className="screw s-tl" aria-hidden />
        <span className="screw s-tr" aria-hidden />
        <span className="screw s-bl" aria-hidden />
        <span className="screw s-br" aria-hidden />
        <div className="glass-hero-main">
          <div className="glass-eyebrow">
            FBRX <b>Home</b>
          </div>
          <SplitFlapBoard messages={board} sound={false} />
          <div className="fx-actions" style={{ marginTop: 14 }}>
            <Button variant="primary" icon="sparkles" onClick={() => navigate('agent')}>
              Ask {agentName}
            </Button>
          </div>
        </div>
      </section>
      <section className="home-notes" aria-label="From FBRX">
        <h2 className="home-notes-title">From FBRX</h2>
        {notes.map((n) => {
          const Ico = Icons[NOTE_ICON[n.kind]];
          return (
            <article key={n.id} className={`home-note ${n.kind}`}>
              <span className="home-note-icon" aria-hidden>
                <Ico size={18} />
              </span>
              <div className="home-note-body">
                <h3>{n.title}</h3>
                <p>{n.body}</p>
                {n.action && (
                  <Button size="sm" variant={n.kind === 'upgrade' ? 'primary' : undefined} onClick={() => navigate(ROUTE[n.action!.to])}>
                    {n.action.label}
                  </Button>
                )}
              </div>
              {(n.kind === 'tip' || n.kind === 'welcome') && (
                <button className="home-note-close" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(n.id)}>
                  <Icons.x size={14} />
                </button>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}

import { createContext, useContext, useState, type ReactNode } from 'react';
import { EDITION_PLANS, TIER_NAMES, TIER_SHORT, atLeast, formatPrice, type EditionStatus, type Tier, type Vertical } from '@fbrx/shared';
import { Button, Card, Icons, useToast } from '@fbrx/ui';
import { useCore } from './hooks';
import { call } from './client';
import { navigate } from './app';

/**
 * FBRX Endpoint Essentials, Standard, Ultra or Black Hole (see TIERS in @fbrx/shared, prices in plans.ts). Every new
 * computer opens in Essentials, free: the AI on its own (the chat, the AI models, Settings) and a walkthrough. Every
 * edition picks how much the AI does on a task (Settings → Agent → Thinking). Standard adds the everyday tools; Ultra
 * the expert tool sets, the AI's work budget part by part, Mesh, AI coordination, connections and plugins and the
 * theme studio. Both are bought (an FBRX account or a license key) or come through an organization's FBRX Command.
 * Black Hole (everything: the whole Library, network environments, the FBRX Server page) comes only through FBRX
 * Command.
 */
export const TierContext = createContext<Tier>('basic');

/** A student or child computer (FBRX OS Education or FBRX OS Home): the short, friendly set of pages. */
export const LearnerContext = createContext(false);

export function useLearner(): boolean {
  return useContext(LearnerContext);
}

/** The kind of organization this computer belongs to (Work, School or Home), for how things are worded. */
export const VerticalContext = createContext<Vertical>('business');

export function useVertical(): Vertical {
  return useContext(VerticalContext);
}

/** The edition this computer runs, inside the main window. */
export function useTier(): Tier {
  return useContext(TierContext);
}

/** The edition, for windows outside the main app (Spotlight). Undefined until the license status arrives. */
export function useLicenseTier(): Tier | undefined {
  return useCore('license.status', undefined, ['license.changed']).data?.tier;
}

export const ULTRA = TIER_NAMES.ultra;

/** Whether this computer runs at least `min` (Black Hole has everything Ultra has, and so on). */
export function useAtLeast(min: Tier): boolean {
  return atLeast(useTier(), min);
}

/**
 * How this computer could get `tier`, in a sentence: it may already (turn it on), its organization decides, it is
 * bought, or (Black Hole) it comes only through an organization.
 */
export function howToGet(tier: Tier, ed: EditionStatus | null): string {
  const plan = EDITION_PLANS[tier];
  if (ed && atLeast(ed.ceiling, tier)) return `${TIER_SHORT[tier]} is allowed on this computer: turn it on and it is there.`;
  if (ed?.ceilingReason === 'organization' || ed?.enrolled) return `Your organization keeps this computer on ${TIER_SHORT[ed.ceiling]} for now (in FBRX Command). Ask your IT team if you need ${TIER_SHORT[tier]}.`;
  if (plan.monthly == null) return `${TIER_SHORT[tier]} comes only through an organization's FBRX Command, for the people who run it and its FBRX Servers.`;
  return `${TIER_SHORT[tier]} is ${formatPrice(plan.monthly)} a month on your FBRX account, or comes through your organization's FBRX Command.`;
}

/** "Standard stays free on this computer until November 13, 2026…" after an update from before 2.0, else null. */
export function graceLine(ed: EditionStatus | null): string | null {
  if (ed?.ceilingReason !== 'grace' || !ed.graceUntil) return null;
  const until = new Date(ed.graceUntil).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  return `${TIER_SHORT[ed.ceiling]} stays free on this computer until ${until}, as a thank-you for using FBRX before 2.0.`;
}

/** What this computer runs, may run, and why (Settings → Edition, the walkthrough). */
export function useEditionStatus(): EditionStatus | null {
  return useCore('edition.status', undefined, ['license.changed', 'fleet.changed']).data;
}

/** Switches this computer's edition (the person's choice; FBRX Command decides how far up it may go). */
export function useChooseEdition(): { choose: (tier: Tier) => Promise<boolean>; busy: Tier | null } {
  const toast = useToast();
  const [busy, setBusy] = useState<Tier | null>(null);
  const choose = async (tier: Tier) => {
    setBusy(tier);
    try {
      await call('edition.choose', { tier });
      toast.success(`${TIER_NAMES[tier]} is on`, tier === 'essentials' ? 'The everyday pages only. Settings → Edition brings the rest back.' : 'Settings → Edition switches back any time.');
      return true;
    } catch (e) {
      toast.error('Edition not changed', (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { choose, busy };
}

/** Where a Standard page would be, in Essentials: what it does, and one click to switch. */
export function StandardOnly({ title, what }: { title: string; what: string }) {
  const ed = useEditionStatus();
  const { choose, busy } = useChooseEdition();
  const held = ed?.ceiling === 'essentials';
  return (
    <div className="ultra-only">
      <Card>
        <div className="ultra-only-body">
          <span className="ultra-only-icon" aria-hidden>
            <Icons.layers size={22} />
          </span>
          <div>
            <h2>
              {title} is in {TIER_NAMES.basic}
            </h2>
            <p className="fx-muted">{what}</p>
            <p className="fx-muted">
              {held ? howToGet('basic', ed) : 'Essentials is your AI on its own. Standard adds the everyday tools, and you can switch back any time.'}
            </p>
            <div className="fx-actions">
              {!held && (
                <Button variant="primary" icon="unlock" loading={busy === 'basic'} onClick={() => void choose('basic')}>
                  Switch to Standard
                </Button>
              )}
              <Button icon="settings" onClick={() => navigate('settings/edition')}>
                Edition settings
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Where an Ultra (or Black Hole) page would be, in a lighter edition: what it does and how to get it. */
export function UltraOnly({ title, what, learner, need = 'ultra' }: { title: string; what: string; learner?: boolean; need?: 'ultra' | 'blackhole' }) {
  const ed = useEditionStatus();
  const { choose, busy } = useChooseEdition();
  if (learner) {
    return (
      <div className="ultra-only">
        <Card>
          <div className="ultra-only-body">
            <span className="ultra-only-icon" aria-hidden>
              <Icons.school size={22} />
            </span>
            <div>
              <h2>{title} is not on this computer</h2>
              <p className="fx-muted">{what}</p>
              <div className="fx-actions">
                <Button variant="primary" icon="dashboard" onClick={() => navigate('home')}>
                  Back home
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }
  const allowed = atLeast(ed?.ceiling, need);
  return (
    <div className="ultra-only">
      <Card>
        <div className="ultra-only-body">
          <span className={`ultra-only-icon${need === 'blackhole' ? ' blackhole' : ''}`} aria-hidden>
            {need === 'blackhole' ? <Icons.layers size={22} /> : <Icons.sparkles size={22} />}
          </span>
          <div>
            <h2>
              {title} is part of {TIER_NAMES[need]}
            </h2>
            <p className="fx-muted">{what}</p>
            <p className="fx-muted">{howToGet(need, ed)}</p>
            <div className="fx-actions">
              {allowed ? (
                <Button variant="primary" icon="sparkles" loading={busy === need} onClick={() => void choose(need)}>
                  Turn on {TIER_SHORT[need]}
                </Button>
              ) : !ed?.enrolled ? (
                <Button variant="primary" icon="globe" onClick={() => navigate('fleet')}>
                  Join your organization
                </Button>
              ) : null}
              <Button icon="settings" onClick={() => navigate('settings/edition')}>
                Edition settings
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** A short line under a screen that has more in Ultra (or in another edition, `tier`). */
export function UltraHint({ children, tier = 'ultra' }: { children: ReactNode; tier?: Tier }) {
  return (
    <div className="ultra-hint">
      <Icons.sparkles size={13} /> <span>{children}</span>{' '}
      <button className="link-btn" onClick={() => navigate('settings/edition')}>
        About {TIER_SHORT[tier]}
      </button>
    </div>
  );
}

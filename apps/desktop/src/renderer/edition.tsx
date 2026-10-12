import { createContext, useContext, useState, type ReactNode } from 'react';
import { TIER_NAMES, TIER_SHORT, type EditionStatus, type Tier, type Vertical } from '@fbrx/shared';
import { Button, Card, Icons, useToast } from '@fbrx/ui';
import { useCore } from './hooks';
import { call } from './client';
import { navigate } from './app';

/**
 * FBRX Endpoint Essentials, Standard or Ultra (see TIERS in @fbrx/shared). Every new computer opens in Essentials: the
 * everyday pages and a walkthrough. Standard adds the rest of the everyday tools; anyone switches to it in Settings →
 * Edition, or from a page that is in Standard. Ultra (expert tool sets, Mesh, AI coordination, connections and
 * plugins, the theme studio and the easter eggs) is there to turn on only when FBRX Command allows it.
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
  const heldBy = ed?.ceilingReason === 'organization' ? 'Your organization keeps this computer on Essentials. Ask your IT team if you need more.' : 'This computer is kept on Essentials.';
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
              {held
                ? heldBy
                : 'Essentials keeps FBRX to the everyday things. Standard adds the rest of the tools, and you can switch back any time.'}
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

/** Where an Ultra page would be, in Essentials or Standard: what it does and how to get it. */
export function UltraOnly({ title, what, learner }: { title: string; what: string; learner?: boolean }) {
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
  const allowed = ed?.ceiling === 'ultra';
  return (
    <div className="ultra-only">
      <Card>
        <div className="ultra-only-body">
          <span className="ultra-only-icon" aria-hidden>
            <Icons.sparkles size={22} />
          </span>
          <div>
            <h2>
              {title} is part of {ULTRA}
            </h2>
            <p className="fx-muted">{what}</p>
            <p className="fx-muted">
              {allowed
                ? 'Your organization allows Ultra on this computer: turn it on and it is there.'
                : ed?.enrolled
                  ? `Your organization keeps this computer on ${TIER_SHORT[ed.ceiling]} for now (in FBRX Command). Ask your IT team if you need Ultra.`
                  : 'Ultra comes from FBRX Command: once your organization adds this computer and allows Ultra, you turn it on in Settings → Edition.'}
            </p>
            <div className="fx-actions">
              {allowed ? (
                <Button variant="primary" icon="sparkles" loading={busy === 'ultra'} onClick={() => void choose('ultra')}>
                  Turn on Ultra
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

/** A short line under a screen that has more in Ultra. */
export function UltraHint({ children }: { children: ReactNode }) {
  return (
    <div className="ultra-hint">
      <Icons.sparkles size={13} /> <span>{children}</span>{' '}
      <button className="link-btn" onClick={() => navigate('settings/edition')}>
        About Ultra
      </button>
    </div>
  );
}

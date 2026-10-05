import { createContext, useContext, type ReactNode } from 'react';
import { TIER_NAMES, type Tier, type Vertical } from '@fbrx/shared';
import { Button, Card, Icons } from '@fbrx/ui';
import { useCore } from './hooks';
import { navigate } from './app';

/**
 * FBRX Endpoint Basic or Ultra (see TIERS in @fbrx/shared). Basic runs without a license key: the everyday tools and
 * the agent with a plain light or dark look. A license key (or the FBRX Command tenant this computer belongs to) turns
 * on Ultra: expert tool sets, Mesh, AI coordination, connections and plugins, the theme studio and the easter eggs.
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

/** Where an Ultra page would be, in Basic: what it does and how to get it. */
export function UltraOnly({ title, what, learner }: { title: string; what: string; learner?: boolean }) {
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
  return (
    <div className="ultra-only">
      <Card>
        <div className="ultra-only-body">
          <span className="ultra-only-icon" aria-hidden>
            <Icons.sparkles size={22} />
          </span>
          <div>
            <h2>{title} is part of {ULTRA}</h2>
            <p className="fx-muted">{what}</p>
            <p className="fx-muted">
              Ultra turns on with a license key, or on its own when your organization adds this computer to its FBRX Command tenant.
            </p>
            <div className="fx-actions">
              <Button variant="primary" icon="key" onClick={() => navigate('settings/license')}>
                Enter a license key
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** A short line under a Basic screen that has more in Ultra. */
export function UltraHint({ children }: { children: ReactNode }) {
  return (
    <div className="ultra-hint">
      <Icons.sparkles size={13} /> <span>{children}</span>{' '}
      <button className="link-btn" onClick={() => navigate('settings/license')}>
        Get Ultra
      </button>
    </div>
  );
}

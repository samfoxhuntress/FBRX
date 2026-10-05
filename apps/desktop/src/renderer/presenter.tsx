import { useEffect } from 'react';
import type { PresenterStatus } from '@fbrx/shared';
import { Icons } from '@fbrx/ui';
import { call } from './client';
import { useCore } from './hooks';

/**
 * Presenter-safe mode in this window: `data-presenting` on the page blurs anything marked `.private` (chat history,
 * alerts, credentials, tickets, clipboard history) so it does not end up on the projector.
 */
export function usePresenter(): PresenterStatus | null {
  const { data } = useCore('presenter.status', undefined, ['presenter.changed', 'settings.changed']);
  useEffect(() => {
    const el = document.documentElement;
    if (data?.active) el.dataset.presenting = data.blurPrivate ? 'blur' : 'on';
    else delete el.dataset.presenting;
  }, [data?.active, data?.blurPrivate]);
  return data;
}

/** The top bar's reminder that presenter-safe mode is on; click to turn it off. */
export function PresenterPill({ status }: { status: PresenterStatus | null }) {
  if (!status?.active) return null;
  return (
    <button className="model-pill presenter-pill" onClick={() => void call('presenter.set', { on: false })} title={status.reason === 'display' ? 'On because a second screen or projector is connected. Click to turn off until it is unplugged.' : 'Click to turn presenter-safe mode off'}>
      <Icons.presentation size={13} />
      Presenting
      <Icons.x size={12} />
    </button>
  );
}

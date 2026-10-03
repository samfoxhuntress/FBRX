import { useEffect, useState } from 'react';
import type { VaultStatus } from '@fbrx/shared';
import { Button, Callout, Input, Modal, useAction } from '@fbrx/ui';
import { call } from './client';
import { useCore } from './hooks';

/** What to do when the vault is locked, for each reason it can be. */
export function LockedNotice({ status: s, onStartOver, compact }: { status: VaultStatus; onStartOver?: () => void; compact?: boolean }) {
  const [pass, setPass] = useState('');
  const { run, busy } = useAction();
  const unlock = () => void run('u', () => call('vault.unlock', { recoveryPassphrase: pass }).then(() => setPass('')), 'Credentials unlocked');
  const passField = (label: string) => (
    <div className="fx-row" style={{ marginTop: 10 }}>
      <Input type="password" placeholder={label} value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pass && unlock()} autoFocus={compact} />
      <Button variant="primary" loading={busy === 'u'} disabled={!pass} onClick={unlock}>
        Unlock
      </Button>
    </div>
  );
  const startOver = onStartOver && (
    <Button size="sm" variant="ghost" onClick={onStartOver}>
      Start over
    </Button>
  );
  if (s.lockReason === 'moved') {
    return (
      <Callout tone="info" title={`Your saved credentials are still in ${s.movedFrom}`}>
        Earlier versions kept the vault key in {s.movedFrom}, which asks for your Mac password after every FBRX update. FBRX no longer uses it, so nothing will ask again. Bring the key over once: macOS may ask for the password you use to sign in to this Mac (not an FBRX password); choose <b>Always Allow</b>.
        <div className="fx-row" style={{ marginTop: 10, gap: 8 }}>
          <Button variant="primary" icon="key" loading={busy === 'm'} onClick={() => void run('m', () => call('vault.importMoved'), 'Credentials brought over')}>
            Bring them over
          </Button>
          {startOver}
        </div>
        {s.hasRecovery && passField('Or your recovery passphrase')}
      </Callout>
    );
  }
  if (s.lockReason === 'password' || s.lockReason === 'manual') {
    return (
      <Callout tone="info" title="Saved credentials are locked">
        {s.lockReason === 'password' ? 'You asked FBRX to lock them at every start. Enter your vault passphrase to use them.' : 'Enter your vault passphrase to unlock them, or restart FBRX OS.'}
        {passField('Vault passphrase')}
      </Callout>
    );
  }
  return (
    <Callout tone="warning" title="Saved credentials are locked">
      This computer could not open the vault key{s.hasRecovery ? '. Unlock with your recovery passphrase.' : ', and no recovery passphrase is set. You can start over with an empty vault.'}
      {s.hasRecovery && passField('Recovery passphrase')}
      {!s.hasRecovery && <div style={{ marginTop: 10 }}>{startOver}</div>}
    </Callout>
  );
}


let askedThisSession = false;

/**
 * At start: when the vault waits for its password (by choice) or for its key to be brought over from the Mac
 * Keychain, ask once, here, instead of leaving it to an alert. "Not now" keeps credentials locked.
 */
export function VaultStartPrompt() {
  const status = useCore('vault.status', undefined, ['vault.changed']);
  const [open, setOpen] = useState(false);
  const s = status.data;
  useEffect(() => {
    if (!s || askedThisSession) return;
    if (s.state === 'locked' && (s.lockReason === 'password' || s.lockReason === 'moved')) {
      askedThisSession = true;
      setOpen(true);
    }
  }, [s]);
  useEffect(() => {
    if (open && s?.state === 'unlocked') setOpen(false);
  }, [open, s?.state]);
  if (!open || !s) return null;
  return (
    <Modal
      title={s.lockReason === 'password' ? 'Unlock your saved credentials' : 'One step to finish the update'}
      onClose={() => setOpen(false)}
      footer={<Button onClick={() => setOpen(false)}>Not now</Button>}
    >
      <LockedNotice status={s} compact />
    </Modal>
  );
}

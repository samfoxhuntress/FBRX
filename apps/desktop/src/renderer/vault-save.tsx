import { useEffect, useState, useSyncExternalStore } from 'react';
import { GENERATOR_DEFAULTS, LOGIN_LIMITS, STRENGTH_WORDS, displayHost, generatePassword, passwordStrength, siteOf, titleForUrl, type Login, type LoginSummary, type PasswordStrength } from '@fbrx/shared';
import { Button, Callout, Field, Icons, Input, Modal, TextArea, Toggle, useAction, useToast } from '@fbrx/ui';
import { call, onEvent } from './client';
import { useCore } from './hooks';
import { navigate } from './app';

/**
 * "Save to Vault" from anywhere in FBRX: the password generator, text picked with the right-click menu, a password box,
 * and Fabrix in the chat (it opens this for the person to type the password, so the password never goes through the
 * AI). The same editor changes a sign-in on the Vault page.
 */

export interface LoginDraft {
  title?: string;
  url?: string;
  username?: string;
  password?: string;
}

let open: LoginDraft | null = null;
const subs = new Set<() => void>();
const set = (d: LoginDraft | null) => {
  open = d;
  subs.forEach((f) => f());
};

/** Opens the Save to Vault window with this filled in. */
export function saveToVault(d: LoginDraft = {}): void {
  set({ ...d });
}

/** Where the window lives: once per window. The main one also opens it when Fabrix asks. */
export function VaultSaveHost({ listen }: { listen: boolean }) {
  const d = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => open,
  );
  useEffect(() => (listen ? onEvent('passwords.saveRequested', (r) => saveToVault(r)) : undefined), [listen]);
  return d ? <LoginEditor key={JSON.stringify(d)} draft={d} onClose={() => set(null)} /> : null;
}

/** How strong a password is (or a strength already worked out), as a five-step bar and a word. */
export function StrengthMeter({ password, strength }: { password?: string; strength?: PasswordStrength }) {
  if (strength === undefined && !password) return null;
  const s = strength ?? passwordStrength(password ?? '');
  return (
    <span className={`pw-meter s${s}`} title={`${STRENGTH_WORDS[s]} password`}>
      <span className="pw-meter-bar">
        {[0, 1, 2, 3, 4].map((i) => (
          <i key={i} className={i <= s ? 'on' : ''} />
        ))}
      </span>
      <span className="pw-meter-word">{STRENGTH_WORDS[s]}</span>
    </span>
  );
}

/** A password box with show/hide and a button that makes a new strong one. */
export function PasswordInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="pw-input">
      <Input className="mono" type={shown ? 'text' : 'password'} value={value} maxLength={LOGIN_LIMITS.password} autoComplete="new-password" spellCheck={false} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
      <Button size="sm" variant="ghost" icon={shown ? 'eyeOff' : 'eye'} aria-label={shown ? 'Hide password' : 'Show password'} onClick={() => setShown(!shown)} />
      <Button
        size="sm"
        variant="ghost"
        icon="dice"
        title="Make a new strong password"
        aria-label="Make a new strong password"
        onClick={() => {
          onChange(generatePassword(GENERATOR_DEFAULTS));
          setShown(true);
        }}
      />
    </div>
  );
}

/** Adds a sign-in (from a draft) or changes one (from the Vault page). */
export function LoginEditor({ draft, login, onClose }: { draft?: LoginDraft; login?: Login; onClose: () => void }) {
  const status = useCore('vault.status', undefined, ['vault.changed']);
  const [f, setF] = useState(() => ({
    title: login?.title ?? draft?.title ?? '',
    url: login?.urls.join(', ') ?? draft?.url ?? '',
    username: login?.username ?? draft?.username ?? '',
    password: login?.password ?? draft?.password ?? '',
    totp: login?.totp ?? '',
    notes: login?.notes ?? '',
    favorite: login?.favorite ?? false,
  }));
  const [twin, setTwin] = useState<LoginSummary | null>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  const urls = f.url
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const first = urls[0] ?? '';

  // A new sign-in for a site and username the Vault already has updates that one instead of keeping two.
  useEffect(() => {
    if (login || !first || !siteOf(first) || status.data?.state !== 'unlocked') return setTwin(null);
    const t = setTimeout(() => {
      void call('passwords.query', { url: /^https?:\/\//i.test(first) ? first : `https://${first}` })
        .then((found) => setTwin(found.find((l) => l.username.toLowerCase() === f.username.trim().toLowerCase()) ?? null))
        .catch(() => setTwin(null));
    }, 250);
    return () => clearTimeout(t);
  }, [login, first, f.username, status.data?.state]);

  const locked = status.data && status.data.state !== 'unlocked';
  const save = () =>
    void run('save', async () => {
      const id = login?.id ?? twin?.id;
      const saved = await call('passwords.save', { ...(id ? { id } : {}), title: f.title, urls, username: f.username, password: f.password, totp: f.totp, notes: f.notes, favorite: f.favorite });
      onClose();
      toast.success(id ? 'Sign-in updated' : 'Saved to Vault', saved.urls[0] ? `FBRX Browser fills it in on ${displayHost(saved.urls[0])}.` : saved.title, login ? undefined : { label: 'Open Vault', onClick: () => navigate('vault') });
    });
  return (
    <Modal
      title={login ? `Edit ${login.title}` : 'Save to Vault'}
      description={login ? undefined : 'Kept encrypted in your Vault on this computer. Fabrix never sees the password.'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="key" disabled={!!locked || (!f.username.trim() && !f.password)} loading={busy === 'save'} onClick={save}>
            {login || twin ? 'Save changes' : 'Save'}
          </Button>
        </>
      }
    >
      {locked ? (
        <Callout
          tone="warning"
          title="The Vault is locked"
          actions={
            <Button
              size="sm"
              onClick={() => {
                onClose();
                navigate('vault');
              }}
            >
              Open Vault
            </Button>
          }
        >
          Unlock it with your vault password, then save again.
        </Callout>
      ) : (
        <div className="fx-form">
          <div className="fx-row">
            <Field label="Website" help="Where you sign in. Several? Separate them with commas.">
              <Input value={f.url} maxLength={LOGIN_LIMITS.url} placeholder="netflix.com" onChange={(e) => setF({ ...f, url: e.target.value })} autoFocus={!draft?.url && !login} />
            </Field>
            <Field label="Name">
              <Input value={f.title} maxLength={LOGIN_LIMITS.title} placeholder={titleForUrl(first) || 'Netflix'} onChange={(e) => setF({ ...f, title: e.target.value })} />
            </Field>
          </div>
          <Field label="Username or email">
            <Input value={f.username} maxLength={LOGIN_LIMITS.username} autoComplete="off" spellCheck={false} onChange={(e) => setF({ ...f, username: e.target.value })} autoFocus={!!draft?.url && !f.username} />
          </Field>
          <Field label={<span className="pw-label">Password <StrengthMeter password={f.password} /></span>}>
            <PasswordInput value={f.password} onChange={(password) => setF({ ...f, password })} autoFocus={!!draft?.url && !!f.username && !f.password} />
          </Field>
          {twin && (
            <Callout tone="info">
              Your Vault already has <b>{twin.title}</b> for {displayHost(first)} as {twin.username || 'this username'}. Saving updates it; its old password is kept in its history.
            </Callout>
          )}
          <Field label="2-step key (optional)" help="The key a site shows when you turn on 2-step sign-in (or its otpauth:// address). FBRX then shows the code beside the password.">
            <Input className="mono" value={f.totp} maxLength={LOGIN_LIMITS.totp} spellCheck={false} autoComplete="off" onChange={(e) => setF({ ...f, totp: e.target.value })} />
          </Field>
          <Field label="Notes">
            <TextArea rows={2} value={f.notes} maxLength={LOGIN_LIMITS.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </Field>
          <Toggle checked={f.favorite} onChange={(favorite) => setF({ ...f, favorite })} label={<><Icons.bookmark size={13} /> Favorite (listed first)</>} />
        </div>
      )}
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { VERTICAL_INFO, VERTICAL_NAMES, type Vertical } from '@fbrx/shared';
import { Button, Callout, Card, Field, Input, FbrxMark } from '@fbrx/ui';
import { api, session } from '../api';
import { KindPicker } from './common';

function Centered({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div style={{ width: `min(${wide ? 640 : 420}px, 100%)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <FbrxMark className="fx-brand-mark" size={34} />
          <div>
            <div className="fx-brand-name">FBRX Command</div>
            <div className="fx-brand-sub">Tenant controller for FBRX Endpoint</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

type SsoProvider = 'google' | 'microsoft' | 'oidc';
const SSO_LABELS: Record<SsoProvider, string> = { google: 'Sign in with Google', microsoft: 'Sign in with Microsoft', oidc: 'Sign in with single sign-on' };

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<Record<SsoProvider, boolean> | null>(null);

  // Back from Google / Microsoft: trade the one-time code for a session (or show why it did not work).
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get('sso');
    const problem = q.get('sso_error');
    if (code || problem) history.replaceState(null, '', location.pathname + location.hash);
    if (problem) setError(problem);
    if (code) {
      setBusy(true);
      void api<{ token: string }>('POST', '/v1/auth/sso/exchange', { code })
        .then((r) => {
          session.token = r.token;
          onLogin();
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setBusy(false));
    }
    void api<Record<SsoProvider, boolean>>('GET', '/v1/auth/sso/options').then(setSso, () => setSso(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const startSso = async (provider: SsoProvider) => {
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ url: string }>('POST', '/v1/auth/sso/start', { provider, email: email.includes('@') ? email : undefined });
      location.href = r.url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const providers = (['google', 'microsoft', 'oidc'] as const).filter((p) => sso?.[p]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token?: string; mfaRequired?: boolean }>('POST', '/v1/auth/login', { email, password, totp: mfa ? totp : undefined });
      if (r.mfaRequired) setMfa(true);
      else if (r.token) {
        session.token = r.token;
        onLogin();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centered>
      <Card title="Sign in" subtitle="Manage your FBRX Endpoint computers">
        <form className="fx-form" onSubmit={submit}>
          {error && <Callout tone="critical">{error}</Callout>}
          <Field label="Email">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {mfa && (
            <Field label="Authenticator code" help="Enter the 6-digit code from your authenticator app">
              <Input inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} autoFocus maxLength={6} />
            </Field>
          )}
          <Button type="submit" variant="primary" loading={busy}>
            {mfa ? 'Verify' : 'Sign in'}
          </Button>
        </form>
        {providers.length > 0 && !mfa && (
          <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 12 }}>
              <span style={{ flex: 1, borderTop: '1px solid var(--border)' }} />
              or
              <span style={{ flex: 1, borderTop: '1px solid var(--border)' }} />
            </div>
            {providers.map((p) => (
              <Button key={p} icon="key" disabled={busy} onClick={() => void startSso(p)}>
                {SSO_LABELS[p]}
              </Button>
            ))}
            <div className="fx-muted" style={{ fontSize: 12 }}>
              Signing in with your school or work account. If your organization has more than one, enter your email above first.
            </div>
          </div>
        )}
      </Card>
    </Centered>
  );
}

export function SetupPage({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<Vertical | null>(null);
  const [picking, setPicking] = useState<Vertical>('business');
  const [f, setF] = useState({ setupToken: '', organization: '', name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setError('Passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/setup', { setupToken: f.setupToken, organization: f.organization, kind, name: f.name, email: f.email, password: f.password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!kind) {
    return (
      <Centered wide>
        <Card title="Set up FBRX Command" subtitle="Step 1 of 2: what will FBRX Command run?">
          <div className="fx-form">
            <KindPicker value={picking} onChange={setPicking} />
            <p className="fx-card-sub" style={{ margin: 0 }}>
              This sets the wording, the groups made for you and what each computer gets. You can change it later, and FBRX Command can run tenants of every kind.
            </p>
            <div className="fx-actions">
              <span className="fx-spacer" />
              <Button variant="primary" icon="chevronRight" onClick={() => setKind(picking)}>
                Continue as {VERTICAL_NAMES[picking]}
              </Button>
            </div>
          </div>
        </Card>
      </Centered>
    );
  }
  const info = VERTICAL_INFO[kind];
  return (
    <Centered>
      <Card title="Set up FBRX Command" subtitle={`Step 2 of 2: your ${info.noun} and the first administrator`}>
        <form className="fx-form" onSubmit={submit}>
          <Callout tone="info">The one-time setup token is printed in the control plane's log on first start (or set FBRX_CP_SETUP_TOKEN).</Callout>
          {error && <Callout tone="critical">{error}</Callout>}
          <Field label="Setup token">
            <Input value={f.setupToken} onChange={set('setupToken')} required autoFocus />
          </Field>
          <Field label={kind === 'home' ? 'Family name' : kind === 'education' ? 'School name' : 'Organization name'} help={`Kind: ${VERTICAL_NAMES[kind]}`}>
            <Input value={f.organization} onChange={set('organization')} required placeholder={info.example} />
          </Field>
          <Field label="Your name">
            <Input value={f.name} onChange={set('name')} required />
          </Field>
          <Field label="Email">
            <Input type="email" value={f.email} onChange={set('email')} required />
          </Field>
          <Field label="Password" help="At least 12 characters">
            <Input type="password" value={f.password} onChange={set('password')} required minLength={12} autoComplete="new-password" />
          </Field>
          <Field label="Confirm password">
            <Input type="password" value={f.confirm} onChange={set('confirm')} required autoComplete="new-password" />
          </Field>
          <div className="fx-actions">
            <Button type="button" onClick={() => setKind(null)}>
              Back
            </Button>
            <span className="fx-spacer" />
            <Button type="submit" variant="primary" loading={busy}>
              Create administrator
            </Button>
          </div>
        </form>
      </Card>
    </Centered>
  );
}

import { useState } from 'react';
import { Button, Callout, Card, Field, Input, FbrxMark } from '@fbrx/ui';
import { api, session } from '../api';

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div style={{ width: 'min(420px, 100%)' }}>
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

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
      </Card>
    </Centered>
  );
}

export function SetupPage({ onDone }: { onDone: () => void }) {
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
      await api('POST', '/v1/setup', { setupToken: f.setupToken, organization: f.organization, name: f.name, email: f.email, password: f.password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centered>
      <Card title="Set up FBRX Command" subtitle="Create the platform administrator account">
        <form className="fx-form" onSubmit={submit}>
          <Callout tone="info">The one-time setup token is printed in the control plane's log on first start (or set FBRX_CP_SETUP_TOKEN).</Callout>
          {error && <Callout tone="critical">{error}</Callout>}
          <Field label="Setup token">
            <Input value={f.setupToken} onChange={set('setupToken')} required autoFocus />
          </Field>
          <Field label="Organization name">
            <Input value={f.organization} onChange={set('organization')} required placeholder="Fabrics Inc." />
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
          <Button type="submit" variant="primary" loading={busy}>
            Create administrator
          </Button>
        </form>
      </Card>
    </Centered>
  );
}

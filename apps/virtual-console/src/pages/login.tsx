import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Callout, Card, FbrxMark, Field, Input } from '@fbrx/ui';
import { api, session } from '../api';

function Centered({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div style={{ width: 'min(440px, 100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <FbrxMark className="fx-brand-mark" size={34} />
          <div>
            <div className="fx-brand-name">FBRX Virtual</div>
            <div className="fx-brand-sub">The hypervisor of FBRX Server</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>('POST', '/v1/auth/login', { username, password });
      session.token = r.token;
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centered>
      <Card title="Sign in">
        <form className="fx-form" onSubmit={submit}>
          <Field label="Username">
            <Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <Callout tone="critical">{error}</Callout>}
          <Button variant="primary" type="submit" loading={busy} disabled={!username || !password}>
            Sign in
          </Button>
        </form>
      </Card>
    </Centered>
  );
}

export function SetupPage({ onDone }: { onDone: () => void }) {
  const [setupToken, setToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) return setError('The passwords do not match');
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>('POST', '/v1/setup', { setupToken: setupToken.trim(), username, name, password });
      session.token = r.token;
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centered>
      <Card title="Set up this server" subtitle="Make the first administrator account for FBRX Virtual.">
        <form className="fx-form" onSubmit={submit}>
          <Field label="Setup code" help="Shown on the FBRX Server screen and in the service log (journalctl -u fbrx-virtual).">
            <Input value={setupToken} onChange={(e) => setToken(e.target.value)} autoFocus className="mono" />
          </Field>
          <Field label="Username">
            <Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="Your name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Password" help="At least 10 characters.">
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Password again">
            <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          {error && <Callout tone="critical">{error}</Callout>}
          <Button variant="primary" type="submit" loading={busy} disabled={!setupToken || !username || password.length < 10}>
            Create administrator
          </Button>
        </form>
      </Card>
    </Centered>
  );
}

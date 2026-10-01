import { useState } from 'react';
import { Button, Callout, Card, CopyText, Field, Grid, Input, KeyValue, Page, Status, useAction } from '@fbrx/ui';
import { api } from '../api';
import { useApp } from '../state';

export function AccountPage() {
  const app = useApp();
  const u = app.me.user;
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [mfa, setMfa] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [disablePw, setDisablePw] = useState('');
  const { busy, run } = useAction();
  return (
    <Page title="Account" description="Your profile and sign-in security.">
      <Grid cols={2}>
        <Card title="Profile">
          <KeyValue
            items={[
              ['Name', u.name],
              ['Email', u.email],
              ['Role', <span className="fx-badge">{u.role}</span>],
              ['Two-factor', u.mfaEnabled ? <Status tone="good">Enabled</Status> : <Status tone="warning">Not enabled</Status>],
            ]}
          />
        </Card>
        <Card title="Change password">
          <div className="fx-form">
            <Field label="Current password">
              <Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
            </Field>
            <Field label="New password" help="At least 12 characters">
              <Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
            </Field>
            <Field label="Confirm new password" error={pw.confirm && pw.confirm !== pw.next ? 'Passwords do not match' : undefined}>
              <Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" />
            </Field>
            <div>
              <Button
                variant="primary"
                loading={busy === 'pw'}
                disabled={!pw.current || pw.next.length < 12 || pw.next !== pw.confirm}
                onClick={() => void run('pw', () => api('POST', '/v1/auth/password', { current: pw.current, next: pw.next }).then(() => setPw({ current: '', next: '', confirm: '' })), 'Password changed; other sessions were signed out')}
              >
                Change password
              </Button>
            </div>
          </div>
        </Card>
        {app.me.principal.kind === 'user' && (
          <Card title="Two-factor authentication" subtitle="Time-based one-time codes from any authenticator app">
            {u.mfaEnabled ? (
              <div className="fx-form">
                <Callout tone="good">Two-factor authentication is on.</Callout>
                <Field label="Confirm your password to turn it off">
                  <Input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
                </Field>
                <div>
                  <Button variant="danger" loading={busy === 'off'} disabled={!disablePw} onClick={() => void run('off', () => api('POST', '/v1/auth/mfa/disable', { password: disablePw }).then(app.refreshMe), 'Two-factor turned off')}>
                    Turn off
                  </Button>
                </div>
              </div>
            ) : mfa ? (
              <div className="fx-form">
                <Field label="1. Add this key to your authenticator app" help="Choose “enter a setup key”, time-based">
                  <CopyText value={mfa.secret.replace(/(.{4})/g, '$1 ').trim()} />
                </Field>
                <Field label="Or open this link on a device with an authenticator">
                  <CopyText value={mfa.otpauthUrl} />
                </Field>
                <Field label="2. Enter the 6-digit code it shows">
                  <Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
                </Field>
                <div>
                  <Button variant="primary" loading={busy === 'en'} disabled={code.length !== 6} onClick={() => void run('en', () => api('POST', '/v1/auth/mfa/enable', { code }).then(() => (setMfa(null), app.refreshMe())), 'Two-factor enabled')}>
                    Verify and enable
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="primary" icon="shield" loading={busy === 'setup'} onClick={async () => setMfa((await run('setup', () => api('POST', '/v1/auth/mfa/setup'))) ?? null)}>
                Set up two-factor
              </Button>
            )}
          </Card>
        )}
      </Grid>
    </Page>
  );
}

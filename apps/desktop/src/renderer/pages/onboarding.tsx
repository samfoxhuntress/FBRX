import { useEffect, useState } from 'react';
import type { SnapshotHeader, SystemStatus } from '@fbrx/shared';
import { Button, Callout, Card, Field, Input, Status, formatBytes, useAction, FbrxMark } from '@fbrx/ui';
import { call, pickFile } from '../client';
import { useCore } from '../hooks';
import { RestoreModal } from './backup';

type Step = 'welcome' | 'vault' | 'ai' | 'org' | 'done';
const STEPS: Step[] = ['welcome', 'vault', 'ai', 'org', 'done'];

export function Onboarding({ status, onDone }: { status: SystemStatus; onDone: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [name, setName] = useState(status.deviceName);
  const [pass, setPass] = useState({ a: '', b: '' });
  const [ai, setAi] = useState<'local' | 'ollama' | 'anthropic' | 'skip'>('local');
  const [apiKey, setApiKey] = useState('');
  const [org, setOrg] = useState({ serverUrl: '', token: '' });
  const [restore, setRestore] = useState<{ file: string; header: SnapshotHeader } | null>(null);
  const catalog = useCore('runtime.catalog');
  const providers = useCore('ai.providers');
  const { run, busy } = useAction();
  const idx = STEPS.indexOf(step);
  const next = () => setStep(STEPS[idx + 1]);
  const ollamaUp = providers.data?.find((p) => p.id === 'ollama')?.available;
  const recommended = catalog.data?.[0];

  useEffect(() => {
    if (status.fleet.state !== 'unenrolled' && step === 'org') next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const finishAi = async () => {
    if (ai === 'local' && status.runtime.state === 'not-installed') await call('runtime.installRuntime').catch(() => undefined);
    if (ai === 'local' && recommended) await call('runtime.download', { modelId: recommended.id }).catch(() => undefined);
    if (ai === 'local') await call('settings.update', { patch: { runtime: { modelId: recommended?.id ?? '' }, ai: { defaultProvider: 'local' } } });
    if (ai === 'ollama') await call('settings.update', { patch: { ai: { defaultProvider: 'ollama' } } });
    if (ai === 'anthropic') {
      await call('vault.set', { name: 'ANTHROPIC_API_KEY', value: apiKey, kind: 'api-key', description: 'Anthropic Claude' });
      const s = await call('settings.get');
      await call('settings.update', { patch: { ai: { defaultProvider: 'anthropic', defaultModel: 'claude-opus-5-5', providers: s.settings.ai.providers.map((p) => (p.id === 'anthropic' ? { ...p, enabled: true } : p)) } } });
    }
    next();
  };

  return (
    <div className="onboard">
      <div className="onboard-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <FbrxMark className="fx-brand-mark" size={34} />
          <div>
            <div className="fx-brand-name">FBRX OS</div>
            <div className="fx-brand-sub">Fabrics Operating System</div>
          </div>
        </div>
        <div className="steps" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s} className={i <= idx ? 'done' : ''} />
          ))}
        </div>
        <Card>
          {step === 'welcome' && (
            <div className="fx-form">
              <h1>Welcome to your workstation's operating layer</h1>
              <p className="fx-secondary">FBRX OS gives you a private AI agent that can work with your files, apps and systems — governed by clear rules, audited end to end, and backed up so you can move to any computer.</p>
              <Field label="Name this workstation">
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </Field>
              <div className="fx-actions" style={{ justifyContent: 'space-between' }}>
                <Button
                  icon="upload"
                  loading={busy === 'restore'}
                  onClick={async () => {
                    const file = await pickFile({ kind: 'file', title: 'Choose a snapshot to restore', filters: [{ name: 'FBRX snapshot', extensions: ['fbrxsnap'] }] });
                    if (!file) return;
                    const header = await run('restore', () => call('backup.inspect', { file }));
                    if (header) setRestore({ file, header });
                  }}
                >
                  Restore from a backup…
                </Button>
                <Button variant="primary" loading={busy === 'n'} onClick={() => void run('n', () => call('settings.update', { patch: { general: { deviceName: name } } }).then(next))}>
                  Continue
                </Button>
              </div>
              <p className="fx-muted" style={{ fontSize: 13, margin: 0 }}>Moving from another computer? Restore its snapshot and FBRX OS picks up exactly where it left off.</p>
            </div>
          )}
          {step === 'vault' && (
            <div className="fx-form">
              <h1>Protect your credentials</h1>
              <p className="fx-secondary">Your vault is already encrypted and locked to this computer's keychain. A recovery passphrase lets you unlock it anywhere if the keychain is ever reset.</p>
              <Field label="Recovery passphrase" help="At least 10 characters — keep it in your password manager">
                <Input type="password" value={pass.a} onChange={(e) => setPass({ ...pass, a: e.target.value })} autoComplete="new-password" />
              </Field>
              <Field label="Confirm" error={pass.b && pass.a !== pass.b ? 'Does not match' : undefined}>
                <Input type="password" value={pass.b} onChange={(e) => setPass({ ...pass, b: e.target.value })} autoComplete="new-password" />
              </Field>
              <div className="fx-actions" style={{ justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={next}>
                  Skip for now
                </Button>
                <Button variant="primary" loading={busy === 'v'} disabled={pass.a.length < 10 || pass.a !== pass.b} onClick={() => void run('v', () => call('vault.initialize', { recoveryPassphrase: pass.a }).then(next))}>
                  Save passphrase
                </Button>
              </div>
            </div>
          )}
          {step === 'ai' && (
            <div className="fx-form">
              <h1>Choose how the agent thinks</h1>
              <div className="choice-grid">
                <button className={`choice${ai === 'local' ? ' selected' : ''}`} onClick={() => setAi('local')}>
                  <strong>Private, on this computer</strong>
                  <span className="fx-secondary" style={{ fontSize: 13 }}>Download {recommended ? `${recommended.name} (${formatBytes(recommended.sizeBytes)})` : 'a model'} for the built-in runtime. Nothing leaves your machine.</span>
                  {status.runtime.state === 'not-installed' && <Status tone="info">The runtime downloads automatically</Status>}
                </button>
                <button className={`choice${ai === 'ollama' ? ' selected' : ''}`} onClick={() => setAi('ollama')}>
                  <strong>Ollama</strong>
                  <span className="fx-secondary" style={{ fontSize: 13 }}>Use models you already run with Ollama.</span>
                  {ollamaUp ? <Status tone="good">Detected</Status> : <Status tone="neutral">Not detected</Status>}
                </button>
                <button className={`choice${ai === 'anthropic' ? ' selected' : ''}`} onClick={() => setAi('anthropic')}>
                  <strong>Claude (Anthropic)</strong>
                  <span className="fx-secondary" style={{ fontSize: 13 }}>Frontier reasoning in the cloud with your API key. Policy can restrict it.</span>
                </button>
              </div>
              {ai === 'anthropic' && (
                <Field label="Anthropic API key" help="Stored encrypted in your vault as ANTHROPIC_API_KEY">
                  <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value.trim())} placeholder="sk-ant-…" autoComplete="off" />
                </Field>
              )}
              <div className="fx-actions" style={{ justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={next}>
                  Decide later
                </Button>
                <Button variant="primary" loading={busy === 'a'} disabled={ai === 'anthropic' && !apiKey} onClick={() => void run('a', finishAi)}>
                  Continue
                </Button>
              </div>
            </div>
          )}
          {step === 'org' && (
            <div className="fx-form">
              <h1>Connect to your organization</h1>
              <p className="fx-secondary">Optional. If your IT team runs an FBRX control plane, connect so they can manage updates, policies, backups and licensing for this machine.</p>
              <Field label="Control plane URL">
                <Input value={org.serverUrl} onChange={(e) => setOrg({ ...org, serverUrl: e.target.value })} placeholder="https://fbrx.yourcompany.com" />
              </Field>
              <Field label="Enrollment token">
                <Input value={org.token} onChange={(e) => setOrg({ ...org, token: e.target.value.trim() })} placeholder="fbrx_enr_…" />
              </Field>
              <div className="fx-actions" style={{ justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={next}>
                  Use standalone
                </Button>
                <Button variant="primary" loading={busy === 'o'} disabled={!org.serverUrl || !org.token} onClick={() => void run('o', () => call('fleet.enroll', { serverUrl: org.serverUrl, token: org.token }).then(next))}>
                  Connect
                </Button>
              </div>
            </div>
          )}
          {step === 'done' && (
            <div className="fx-form">
              <h1>You're set</h1>
              <Callout tone="good">FBRX OS is running. Try asking the agent to summarize this workstation's health, or connect your first app under Connections.</Callout>
              <p className="fx-secondary">Tip: create a snapshot under Backup & restore before you change computers — it brings everything with you.</p>
              <div className="fx-actions" style={{ justifyContent: 'flex-end' }}>
                <Button
                  variant="primary"
                  loading={busy === 'd'}
                  onClick={() =>
                    void run('d', async () => {
                      await call('settings.update', { patch: { general: { onboardingComplete: true } } });
                      location.hash = '#/home';
                      onDone();
                    })
                  }
                >
                  Open FBRX OS
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
      {restore && <RestoreModal file={restore.file} header={restore.header} onClose={() => setRestore(null)} />}
    </div>
  );
}

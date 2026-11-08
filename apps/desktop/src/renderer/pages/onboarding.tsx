import { useState } from 'react';
import { STANDARD_TRIAL_DAYS, type Settings, type SnapshotHeader, type SystemStatus } from '@fbrx/shared';
import { Button, Card, Field, Input, Status, useAction, FbrxMark } from '@fbrx/ui';
import { call, pickFile } from '../client';
import { useAgentName, useCore, useStarterAi } from '../hooks';
import { PRESETS, resolvedMode } from '../theme';
import { RestoreModal } from './backup';
import { JoinForm } from '../join';
import { AccountSignInForm } from '../account';

/**
 * First start: one screen, then the chat. The AI is already getting ready by itself (the starter model, which
 * "Install FBRX OS" usually downloaded before the app even opened), so the questions are light: an optional name,
 * Simple or Advanced, and the look (each theme shows at once). Everything else waits until someone wants it: a vault
 * recovery passphrase (Vault), another AI (AI models), this computer's name (Settings). Moving from another computer
 * (restore a backup) and joining an organization's FBRX Command are a click away here, and so is signing in to an FBRX
 * account (which brings what it bought).
 */
export function Onboarding({ status, onDone }: { status: SystemStatus; onDone: () => void }) {
  const agentName = useAgentName();
  const starter = useStarterAi();
  const [name, setName] = useState('');
  const [joining, setJoining] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [restore, setRestore] = useState<{ file: string; header: SnapshotHeader } | null>(null);
  const [mode, setMode] = useState<Settings['general']['mode']>('simple');
  const settings = useCore('settings.get', undefined, ['settings.changed']).data?.settings;
  const { run, busy } = useAction();
  // Advanced is every tool, which on a computer on its own is Standard's: its free trial starts with it, where it may.
  const essentials = status.license.tier === 'essentials';
  const trial = essentials && !!status.edition?.trialAvailable;

  const finish = () =>
    run('start', async () => {
      const n = name.trim();
      if (mode === 'advanced' && trial) await call('edition.startTrial').catch(() => undefined);
      await call('settings.update', { patch: { general: { onboardingComplete: true, mode }, ...(n ? { profile: { name: n, callMe: '' } } : {}) } });
      location.hash = '#/agent';
      onDone();
    });
  // The look changes as it is picked, so it is chosen by seeing it.
  const look = (patch: { preset?: Settings['appearance']['preset']; theme?: Settings['general']['theme'] }) =>
    void call('settings.update', { patch: { ...(patch.preset ? { appearance: { preset: patch.preset } } : {}), ...(patch.theme ? { general: { theme: patch.theme } } : {}) } });
  const shade = resolvedMode(settings?.general.theme ?? 'dark');

  const ai =
    !starter || starter.state === 'not-needed' ? null : starter.state === 'ready' ? (
      <Status tone="good">Your AI is ready: {starter.modelName}, on this computer</Status>
    ) : starter.state === 'failed' ? (
      <Status tone="warning">Your AI is not downloaded yet; the chat helps you get it</Status>
    ) : (
      <Status tone="busy">
        Getting your AI ready{starter.step === 'model' && starter.totalBytes ? ` (${Math.round((starter.receivedBytes / starter.totalBytes) * 100)}%)` : '…'}
      </Status>
    );

  return (
    <div className="onboard">
      <div className="onboard-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <FbrxMark className="fx-brand-mark" size={34} />
          <div>
            <div className="fx-brand-name">FBRX OS</div>
            <div className="fx-brand-sub">Your own AI, on your computer</div>
          </div>
        </div>
        <Card>
          {signingIn ? (
            <div className="fx-form">
              <h1>Sign in to your FBRX account</h1>
              <p className="fx-secondary">Whatever your account has (bought on the website, another computer or your phone) comes on here too.</p>
              <AccountSignInForm
                onDone={() => void finish()}
                extraActions={
                  <Button variant="ghost" onClick={() => setSigningIn(false)}>
                    Back
                  </Button>
                }
              />
            </div>
          ) : joining ? (
            <div className="fx-form">
              <h1>Connect to your organization</h1>
              <p className="fx-secondary">If your company, school or family runs FBRX Command, connect so it can look after updates, settings and backups, and answer your requests for help.</p>
              <JoinForm
                showDeviceName={false}
                onJoined={() => void finish()}
                studentNote="It becomes FBRX OS Education (at a school) or FBRX OS Home (in a family): a simpler set of tools and a safe learning helper."
                extraActions={
                  <Button variant="ghost" onClick={() => setJoining(false)}>
                    Back
                  </Button>
                }
              />
            </div>
          ) : (
            <form
              className="fx-form"
              onSubmit={(e) => {
                e.preventDefault();
                void finish();
              }}
            >
              <h1>Hi! Meet {agentName}, your own AI</h1>
              <p className="fx-secondary" style={{ margin: 0 }}>
                It runs right here on this computer, so your chats stay private. It can help with your files, apps and settings, and it asks before it uses the internet or changes anything.
              </p>
              {ai}
              <Field label={`What should ${agentName} call you?`} help="Optional. You can change it later in Settings.">
                <Input value={name} maxLength={60} placeholder="Your name" autoFocus onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="How much should FBRX show?" help="Settings → General → Menu changes it later.">
                <div className="choice-grid onboard-modes" role="radiogroup">
                  <button type="button" role="radio" aria-checked={mode === 'simple'} className={`choice${mode === 'simple' ? ' selected' : ''}`} onClick={() => setMode('simple')}>
                    <strong>Simple</strong>
                    <span className="fx-secondary">{agentName}, its settings and help. A short menu; everything else stays out of the way.</span>
                  </button>
                  <button type="button" role="radio" aria-checked={mode === 'advanced'} className={`choice${mode === 'advanced' ? ' selected' : ''}`} onClick={() => setMode('advanced')}>
                    <strong>Advanced</strong>
                    <span className="fx-secondary">
                      Every tool: files, notes, the network, the terminal and more, in sections.
                      {essentials && (trial ? ` Starts your free ${STANDARD_TRIAL_DAYS}-day Standard trial.` : ' It comes with Standard.')}
                    </span>
                  </button>
                </div>
              </Field>
              <Field label="Pick a look">
                <div className="onboard-looks">
                  <div className="seg" role="group" aria-label="Light or dark">
                    {(['system', 'light', 'dark'] as const).map((t) => (
                      <button type="button" key={t} className={settings?.general.theme === t ? 'on' : ''} onClick={() => look({ theme: t })}>
                        {t === 'system' ? 'Match system' : t === 'light' ? 'Light' : 'Dark'}
                      </button>
                    ))}
                  </div>
                  <div className="swatches onboard-swatches">
                    {PRESETS.map((p) => {
                      const [page, side, accent] = shade === 'dark' ? p.dark : p.light;
                      const on = settings?.appearance.preset === p.id;
                      return (
                        <button type="button" key={p.id} className={`swatch${on ? ' selected' : ''}`} aria-pressed={on} onClick={() => look({ preset: p.id })}>
                          <div className="swatch-preview">
                            <div style={{ background: side }} />
                            <div style={{ background: page }}>
                              <div className="swatch-bar" style={{ background: p.id === 'tropical' ? 'var(--accent-gradient)' : accent, width: '70%' }} />
                              <div className="swatch-bar" style={{ background: shade === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)', width: '90%' }} />
                            </div>
                          </div>
                          <div className="swatch-label">{p.name}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </Field>
              <div className="fx-actions" style={{ justifyContent: 'flex-end' }}>
                <Button type="submit" variant="primary" icon="sparkles" loading={busy === 'start'}>
                  Start chatting
                </Button>
              </div>
              <div className="onboard-more">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="upload"
                  loading={busy === 'restore'}
                  onClick={async () => {
                    const file = await pickFile({ kind: 'file', title: 'Choose a snapshot to restore', filters: [{ name: 'FBRX snapshot', extensions: ['fbrxsnap'] }] });
                    if (!file) return;
                    const header = await run('restore', () => call('backup.inspect', { file }));
                    if (header) setRestore({ file, header });
                  }}
                >
                  Moving from another computer? Restore its backup
                </Button>
                <Button size="sm" variant="ghost" icon="user" onClick={() => setSigningIn(true)}>
                  I have an FBRX account
                </Button>
                {status.fleet.state === 'unenrolled' && (
                  <Button size="sm" variant="ghost" icon="users" onClick={() => setJoining(true)}>
                    Join my organization
                  </Button>
                )}
              </div>
            </form>
          )}
        </Card>
      </div>
      {restore && <RestoreModal file={restore.file} header={restore.header} onClose={() => setRestore(null)} />}
    </div>
  );
}

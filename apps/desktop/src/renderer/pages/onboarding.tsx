import { useState } from 'react';
import type { SnapshotHeader, SystemStatus } from '@fbrx/shared';
import { Button, Card, Field, Input, Status, useAction, FbrxMark } from '@fbrx/ui';
import { call, pickFile } from '../client';
import { useAgentName, useStarterAi } from '../hooks';
import { RestoreModal } from './backup';
import { JoinForm } from '../join';

/**
 * First start: one screen, then the chat. The AI is already getting ready by itself (the starter model, which
 * "Install FBRX OS" usually downloaded before the app even opened), so the only question is an optional name.
 * Everything else waits until someone wants it: a vault recovery passphrase (Vault), another AI (AI models),
 * this computer's name (Settings). Moving from another computer (restore a backup) and joining an organization's
 * FBRX Command are a click away here.
 */
export function Onboarding({ status, onDone }: { status: SystemStatus; onDone: () => void }) {
  const agentName = useAgentName();
  const starter = useStarterAi();
  const [name, setName] = useState('');
  const [joining, setJoining] = useState(false);
  const [restore, setRestore] = useState<{ file: string; header: SnapshotHeader } | null>(null);
  const { run, busy } = useAction();

  const finish = () =>
    run('start', async () => {
      const n = name.trim();
      await call('settings.update', { patch: { general: { onboardingComplete: true }, ...(n ? { profile: { name: n, callMe: '' } } : {}) } });
      location.hash = '#/agent';
      onDone();
    });

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
            <div className="fx-brand-sub">Fabrics Operating System</div>
          </div>
        </div>
        <Card>
          {joining ? (
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

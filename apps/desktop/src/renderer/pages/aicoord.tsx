import { useState } from 'react';
import { Button, Callout, Card, CopyText, Empty, Field, Grid, Icons, Page, Select, Spinner, Status, TextArea, useAction, useToast } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { Markdown } from '../markdown';
import { navigate } from '../app';

const KIND: Record<string, string> = { 'desktop-app': 'Desktop app', cli: 'Command line', ide: 'Code editor', 'local-server': 'Local AI server' };

export function AiCoordPage({ agentName }: { agentName: string }) {
  const apps = useCore('aicoord.detect');
  const bridge = useCore('aicoord.bridge', undefined, ['service.changed', 'settings.changed']);
  const providers = useCore('ai.providers', undefined, ['settings.changed']);
  const { run, busy } = useAction();
  const toast = useToast();
  const [provider, setProvider] = useState('');
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState<{ text: string; who: string } | null>(null);
  const usable = (providers.data ?? []).filter((p) => p.enabled && p.available && !p.blockedByPolicy);

  return (
    <Page
      title="AI coordination"
      description={`Let the other AI apps on this computer use FBRX OS tools and ask ${agentName}, and get second opinions from other models. Everything goes through FBRX governance and approvals.`}
      actions={
        <Button icon="refresh" onClick={() => apps.reload()}>
          Look again
        </Button>
      }
    >
      {bridge.data && !bridge.data.ready && (
        <Callout tone="warning" title="The FBRX bridge is not ready" actions={<Button size="sm" onClick={() => navigate('settings')}>Settings</Button>}>
          {bridge.data.reason}
        </Callout>
      )}
      <Card title="AI apps on this computer" subtitle="Apps that support MCP can be connected with one click; restart the app afterwards." flush>
        {apps.data ? (
          <div className="fx-list">
            {apps.data
              .filter((a) => a.found || a.mcp)
              .sort((a, b) => Number(b.found) - Number(a.found))
              .map((a) => (
                <div key={a.id} className="fx-list-item">
                  <Icons.zap size={16} style={{ color: a.found ? 'var(--accent)' : 'var(--text-muted)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="fx-cell-title">
                      {a.name} <span className="fx-muted" style={{ fontWeight: 400 }}>· {KIND[a.kind]}</span>
                    </div>
                    <div className="fx-cell-sub">{a.found ? a.evidence : 'Not found on this computer'}</div>
                  </div>
                  {a.bridged && <Status tone="good">connected</Status>}
                  {a.mcp &&
                    (a.bridged ? (
                      <Button size="sm" variant="ghost" loading={busy === a.id} onClick={() => void run(a.id, () => call('aicoord.remove', { appId: a.id })).then((r) => (r && toast.success(r.message), apps.reload()))}>
                        Disconnect
                      </Button>
                    ) : (
                      <Button size="sm" variant={a.found ? 'primary' : undefined} disabled={!bridge.data?.ready} loading={busy === a.id} onClick={() => void run(a.id, () => call('aicoord.install', { appId: a.id })).then((r) => (r && toast.success(r.message), apps.reload()))}>
                        Connect
                      </Button>
                    ))}
                  {a.kind === 'local-server' && a.found && (
                    <Button size="sm" variant="ghost" onClick={() => navigate('runtime')}>
                      Use as a model
                    </Button>
                  )}
                </div>
              ))}
          </div>
        ) : (
          <div style={{ padding: 18 }}>
            <Spinner />
          </div>
        )}
      </Card>
      <Grid cols={2}>
        <Card title="Second opinion" subtitle="Ask another configured model the same question (no tools, nothing is changed)">
          {usable.length ? (
            <div className="fx-grid" style={{ gap: 10 }}>
              <Field label="Model">
                <Select value={provider || usable[0].id} onChange={(e) => setProvider(e.target.value)} options={usable.map((p) => ({ value: p.id, label: p.name }))} />
              </Field>
              <TextArea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Question or text to review" />
              <div>
                <Button
                  variant="primary"
                  icon="send"
                  loading={busy === 'consult'}
                  disabled={!prompt.trim()}
                  onClick={() => void run('consult', () => call('aicoord.consult', { providerId: provider || usable[0].id, prompt })).then((r) => r && setAnswer({ text: r.answer, who: `${r.providerId} · ${r.model}` }))}
                >
                  Ask
                </Button>
              </div>
              {answer && (
                <div>
                  <div className="fx-muted" style={{ fontSize: 12 }}>{answer.who}</div>
                  <Markdown text={answer.text} />
                </div>
              )}
            </div>
          ) : (
            <Empty title="Only one model set up" action={<Button size="sm" onClick={() => navigate('runtime')}>AI models</Button>}>
              Add another provider (a local model, Ollama or a cloud key) to compare answers.
            </Empty>
          )}
        </Card>
        <Card title="Manual setup" subtitle="For other MCP-capable apps: add this server to their MCP configuration">
          {bridge.data?.ready ? (
            <div className="fx-grid" style={{ gap: 8 }}>
              <pre className="fx-code" style={{ margin: 0, maxHeight: 220 }}>{bridge.data.snippet}</pre>
              <CopyText value={bridge.data.snippet} />
              <p className="fx-muted" style={{ fontSize: 12.5, margin: 0 }}>
                The bridge uses the Local API with a limited agent token. Tool calls from other apps follow your policy, may wait for your approval, and appear in the audit log.
              </p>
            </div>
          ) : (
            <Empty title="Bridge not ready">{bridge.data?.reason}</Empty>
          )}
        </Card>
      </Grid>
    </Page>
  );
}

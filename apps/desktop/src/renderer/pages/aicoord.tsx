import { useEffect, useState } from 'react';
import type { AiAppInfo } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Icons, Page, Select, Spinner, Status, TextArea, useAction, useToast } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { Markdown } from '../markdown';
import { navigate } from '../app';

const KIND: Record<string, string> = { 'desktop-app': 'Desktop app', cli: 'Command line', ide: 'Code editor', 'local-server': 'Local AI server' };

export function AiCoordPage({ agentName }: { agentName: string }) {
  const [apps, setApps] = useState<AiAppInfo[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const bridge = useCore('aicoord.bridge', undefined, ['service.changed', 'settings.changed']);
  const providers = useCore('ai.providers', undefined, ['settings.changed']);
  const { run, busy } = useAction();
  const toast = useToast();
  const [provider, setProvider] = useState('');
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState<{ text: string; who: string } | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; message: string } | 'running'>>({});
  const claudeCode = useCore('aicoord.claudeCode');
  // Claude through Claude Code (no API key) joins the configured models as a second-opinion choice.
  const usable = [
    ...(providers.data ?? []).filter((p) => p.enabled && p.available && !p.blockedByPolicy).map((p) => ({ id: p.id, name: p.name })),
    ...(claudeCode.data?.available ? [{ id: 'claude-code', name: 'Claude (via Claude Code on this PC)' }] : []),
  ];
  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: 'running' }));
    const r = await call('aicoord.test', { appId: id }).catch((e: Error) => ({ ok: false, message: e.message, tools: 0, durationMs: 0 }));
    setTests((t) => ({ ...t, [id]: { ok: r.ok, message: r.message } }));
  };

  const scan = async (announce: boolean) => {
    setScanning(true);
    try {
      const before = new Set((apps ?? []).filter((a) => a.found).map((a) => a.id));
      const list = await call('aicoord.detect');
      setApps(list);
      if (announce) {
        const found = list.filter((a) => a.found);
        const added = found.filter((a) => !before.has(a.id));
        toast.success(`Found ${found.length} AI app${found.length === 1 ? '' : 's'}`, added.length && before.size ? `New: ${added.map((a) => a.name).join(', ')}` : found.map((a) => a.name).join(', ') || undefined);
      }
    } catch (e) {
      toast.error('Could not look for AI apps', (e as Error).message);
    } finally {
      setScanning(false);
    }
  };
  useEffect(() => {
    void scan(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const refresh = () => void call('aicoord.detect').then(setApps);
  const shown = (apps ?? []).filter((a) => a.found || a.mcp).sort((a, b) => Number(b.found) - Number(a.found) || Number(b.mcp) - Number(a.mcp));

  return (
    <Page
      title="AI coordination"
      description={`Let the other AI apps on this computer use FBRX OS tools and ask ${agentName}, and get second opinions from other models. Everything goes through FBRX governance and approvals.`}
      actions={
        <Button icon="refresh" loading={scanning} onClick={() => void scan(true)}>
          {scanning ? 'Looking…' : 'Look again'}
        </Button>
      }
    >
      {bridge.data && !bridge.data.ready && (
        <Callout tone="warning" title="The FBRX bridge is not ready" actions={<Button size="sm" onClick={() => navigate('settings')}>Settings</Button>}>
          {bridge.data.reason}
        </Callout>
      )}
      <Card title="AI apps on this computer" subtitle="Found from the Start menu, installed programs and running apps. Apps that support MCP connect with one click; restart them afterwards." flush>
        {apps ? (
          <div className="fx-list">
            {shown.map((a) => (
              <div key={a.id} className="fx-list-item" style={{ opacity: a.found ? 1 : 0.7 }}>
                <Icons.zap size={16} style={{ color: a.found ? 'var(--accent)' : 'var(--text-muted)', flex: 'none' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fx-cell-title">
                    {a.name} <span className="fx-muted" style={{ fontWeight: 400 }}>· {KIND[a.kind]}</span>
                    {a.found && !a.mcp && a.kind !== 'local-server' && <span className="fx-badge" style={{ marginLeft: 6 }}>no MCP</span>}
                  </div>
                  <div className="fx-cell-sub">{a.found ? a.evidence : 'Not found on this computer'}</div>
                  {a.found && a.note && <div className="fx-cell-sub" style={{ marginTop: 2 }}>{a.note}</div>}
                  {a.bridged && a.id === 'claude-desktop' && !tests[a.id] && (
                    <div className="fx-cell-sub" style={{ marginTop: 2 }}>
                      In Claude, the FBRX tools appear under the tools (slider) button in the chat box as "fbrx". Ask for example: "Use FBRX to check my disk space", or "Ask Fabrix what is slowing my PC down".
                    </div>
                  )}
                  {tests[a.id] && tests[a.id] !== 'running' && (
                    <div className="fx-cell-sub" style={{ marginTop: 4, color: (tests[a.id] as { ok: boolean }).ok ? 'var(--good)' : 'var(--critical)' }}>
                      {(tests[a.id] as { message: string }).message}
                    </div>
                  )}
                </div>
                {a.bridged && <Status tone="good">connected</Status>}
                {a.bridged && (
                  <Button size="sm" variant="ghost" icon="activity" loading={tests[a.id] === 'running'} onClick={() => void test(a.id)} title="Start the FBRX bridge the way this app does and check that it answers">
                    Test
                  </Button>
                )}
                {a.found && a.launchable && (
                  <Button size="sm" variant="ghost" icon="external" loading={busy === `open:${a.id}`} onClick={() => void run(`open:${a.id}`, () => call('aicoord.launch', { appId: a.id })).then((r) => r && toast.info(r.message))}>
                    {a.kind === 'local-server' ? 'Start' : 'Open'}
                  </Button>
                )}
                {a.found && a.api && (
                  <Button size="sm" variant="ghost" icon="plus" title={`Use ${a.api.name} for second opinions (needs an API key from ${a.api.keyUrl})`} onClick={() => navigate(`runtime/add:${encodeURIComponent(`${a.api!.name}|${a.api!.baseUrl}|${a.api!.model}`)}`)}>
                    Add as a model
                  </Button>
                )}
                {a.mcp &&
                  (a.bridged ? (
                    <Button size="sm" variant="ghost" loading={busy === a.id} onClick={() => void run(a.id, () => call('aicoord.remove', { appId: a.id })).then((r) => (r && toast.success(r.message), refresh()))}>
                      Disconnect
                    </Button>
                  ) : (
                    <Button size="sm" variant={a.found ? 'primary' : undefined} disabled={!bridge.data?.ready} loading={busy === a.id} onClick={() => void run(a.id, () => call('aicoord.install', { appId: a.id })).then((r) => (r && toast.success(r.message), refresh()))}>
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
          <div style={{ padding: 18, display: 'flex', gap: 10, alignItems: 'center' }}>
            <Spinner /> <span className="fx-muted">Looking for AI apps…</span>
          </div>
        )}
      </Card>
      <Grid cols={2}>
        <Card title="Second opinion" subtitle={`Ask another model the same question (no tools, nothing is changed). To ask Claude: install Claude Code (no API key needed) or add Claude with an API key in AI models.`}>
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
              <div>
                <Button size="sm" icon="copy" onClick={() => void navigator.clipboard.writeText(bridge.data!.snippet).then(() => toast.success('Copied'))}>
                  Copy configuration
                </Button>
              </div>
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

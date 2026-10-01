import { useState } from 'react';
import type { DeepPartial, Settings } from '@fbrx/shared';
import { UPDATE_CHANNELS } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Field, Grid, Icons, Input, KeyValue, Page, Select, Status, Tabs, TextArea, Toggle, formatDate, useAction, useConfirm } from '@fbrx/ui';
import { bridge, call } from '../client';
import { isLocked, useCore } from '../hooks';

function Locked({ show }: { show: boolean }) {
  return show ? (
    <span className="lock-note">
      <Icons.lock size={12} /> Managed
    </span>
  ) : null;
}

export function SettingsPage({ onRerunSetup }: { onRerunSetup: () => void }) {
  const [tab, setTab] = useState<'general' | 'updates' | 'license' | 'api' | 'logs'>('general');
  return (
    <Page title="Settings">
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'general', label: 'General' },
          { id: 'updates', label: 'Updates' },
          { id: 'license', label: 'License' },
          { id: 'api', label: 'Local API' },
          { id: 'logs', label: 'Logs & about' },
        ]}
      />
      {tab === 'general' && <General onRerunSetup={onRerunSetup} />}
      {tab === 'updates' && <Updates />}
      {tab === 'license' && <License />}
      {tab === 'api' && <LocalApi />}
      {tab === 'logs' && <Logs />}
    </Page>
  );
}

function useSettings() {
  const s = useCore('settings.get', undefined, ['settings.changed']);
  const { run } = useAction();
  const patch = (p: DeepPartial<Settings>) => run('patch', () => call('settings.update', { patch: p }));
  return { s: s.data?.settings, locked: s.data?.locked ?? [], patch };
}

function General({ onRerunSetup }: { onRerunSetup: () => void }) {
  const { s, locked, patch } = useSettings();
  const [name, setName] = useState<string | null>(null);
  if (!s) return null;
  const L = (p: string) => isLocked(locked, p);
  return (
    <Grid cols={2}>
      <Card title="This workstation">
        <div className="fx-form">
          <Field label={<>Device name <Locked show={L('general.deviceName')} /></>}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input value={name ?? s.general.deviceName} disabled={L('general.deviceName')} onChange={(e) => setName(e.target.value)} />
              <Button disabled={name === null} onClick={() => void patch({ general: { deviceName: name ?? '' } }).then(() => setName(null))}>
                Save
              </Button>
            </div>
          </Field>
          <Field label={<>Theme <Locked show={L('general.theme')} /></>}>
            <Select value={s.general.theme} disabled={L('general.theme')} onChange={(e) => void patch({ general: { theme: e.target.value as Settings['general']['theme'] } })} options={[{ value: 'system', label: 'Match system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </Field>
          <Toggle checked={s.general.launchAtLogin} disabled={L('general.launchAtLogin')} onChange={(v) => void patch({ general: { launchAtLogin: v } })} label="Start FBRX OS when I sign in" />
          <Toggle checked={s.general.minimizeToTray} disabled={L('general.minimizeToTray')} onChange={(v) => void patch({ general: { minimizeToTray: v } })} label="Keep running in the tray when the window is closed" />
          <Toggle checked={s.general.telemetry} disabled={L('general.telemetry')} onChange={(v) => void patch({ general: { telemetry: v } })} label="Share health telemetry with my organisation's control plane" />
        </div>
      </Card>
      <Card title="AI behaviour">
        <div className="fx-form">
          <Field label={<>Creativity (temperature): {s.ai.temperature} <Locked show={L('ai.temperature')} /></>} help="Lower is more precise. Ignored by models that manage this themselves.">
            <input type="range" min={0} max={1} step={0.05} disabled={L('ai.temperature')} value={s.ai.temperature} onChange={(e) => void patch({ ai: { temperature: Number(e.target.value) } })} />
          </Field>
          <Field label={<>Agent instructions <Locked show={L('ai.systemPrompt')} /></>} help="Standing instructions included in every conversation">
            <TextArea rows={8} disabled={L('ai.systemPrompt')} defaultValue={s.ai.systemPrompt} onBlur={(e) => e.target.value !== s.ai.systemPrompt && void patch({ ai: { systemPrompt: e.target.value } })} />
          </Field>
          <div>
            <Button size="sm" onClick={onRerunSetup}>
              Run first-time setup again
            </Button>
          </div>
        </div>
      </Card>
    </Grid>
  );
}

function Updates() {
  const { data: u } = useCore('updates.status', undefined, ['updates.changed']);
  const { s, locked, patch } = useSettings();
  const { run, busy } = useAction();
  if (!u || !s) return null;
  return (
    <Grid cols={2}>
      <Card title="Software updates">
        <div className="fx-form">
          <KeyValue
            items={[
              ['Installed version', u.currentVersion],
              ['Status', <Status tone={u.state === 'downloaded' ? 'good' : u.state === 'error' ? 'critical' : u.state === 'downloading' || u.state === 'checking' ? 'busy' : 'neutral'}>{u.state}{u.progressPct !== null && u.state === 'downloading' ? ` ${u.progressPct}%` : ''}</Status>],
              ['Available', u.availableVersion ?? '—'],
              ['Channel', u.channel],
            ]}
          />
          {u.message && <Callout tone={u.state === 'error' ? 'critical' : 'info'}>{u.message}</Callout>}
          <div className="fx-actions">
            <Button icon="refresh" loading={busy === 'c'} disabled={u.state === 'unsupported'} onClick={() => void run('c', () => call('updates.check'))}>
              Check now
            </Button>
            {u.state === 'downloaded' && (
              <Button variant="primary" onClick={() => void run('i', () => call('updates.install'))}>
                Restart and update
              </Button>
            )}
          </div>
        </div>
      </Card>
      <Card title="Preferences" subtitle="Your organisation decides which version this device runs">
        <div className="fx-form">
          <Field label="Channel">
            <Select value={s.updates.channel} disabled={isLocked(locked, 'updates.channel')} onChange={(e) => void patch({ updates: { channel: e.target.value as Settings['updates']['channel'] } })} options={[...UPDATE_CHANNELS]} />
          </Field>
          <Toggle checked={s.updates.autoDownload} disabled={isLocked(locked, 'updates.autoDownload')} onChange={(v) => void patch({ updates: { autoDownload: v } })} label="Download updates automatically" />
          <Toggle checked={s.updates.autoInstall} disabled={isLocked(locked, 'updates.autoInstall')} onChange={(v) => void patch({ updates: { autoInstall: v } })} label="Install automatically (restarts the app)" />
        </div>
      </Card>
    </Grid>
  );
}

function License() {
  const { data: l } = useCore('license.status', undefined, ['license.changed']);
  const [key, setKey] = useState('');
  const { run, busy } = useAction();
  if (!l) return null;
  return (
    <Grid cols={2}>
      <Card title="Your license">
        <KeyValue
          items={[
            ['Edition', <span className="fx-badge accent">{l.edition}</span>],
            ['State', <Status tone={l.state === 'valid' || l.state === 'development' ? 'good' : l.state === 'unlicensed' ? 'neutral' : 'warning'}>{l.state}</Status>],
            ['Licensed to', l.customer ?? '—'],
            ['Seats', l.seats === 0 ? 'Unlimited' : l.seats ?? '—'],
            ['Expires', l.expiresAt ? formatDate(l.expiresAt) : l.state === 'valid' ? 'Never' : '—'],
            ['Source', { managed: 'Your organisation', local: 'License key on this device', development: 'Development build', none: '—' }[l.source]],
            ['Features', l.features.join(', ')],
          ]}
        />
        {l.message && <Callout tone="info">{l.message}</Callout>}
      </Card>
      <Card title="Activate a license key" subtitle="Enrolled devices receive their license automatically">
        <div className="fx-form">
          <TextArea code rows={4} value={key} onChange={(e) => setKey(e.target.value.trim())} placeholder="FBRX1.…" />
          <div className="fx-actions">
            <Button variant="primary" loading={busy === 'a'} disabled={!key} onClick={() => void run('a', () => call('license.activate', { key }).then(() => setKey('')), 'License activated')}>
              Activate
            </Button>
            {l.source === 'local' && (
              <Button variant="danger" onClick={() => void run('r', () => call('license.remove'), 'License removed')}>
                Remove license
              </Button>
            )}
          </div>
        </div>
      </Card>
    </Grid>
  );
}

function LocalApi() {
  const info = useCore('localapi.info', { revealToken: true }, ['settings.changed']);
  const { s, locked, patch } = useSettings();
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  if (!s || !info.data) return null;
  const i = info.data;
  return (
    <Grid cols={2}>
      <Card title="Local automation API" subtitle="Lets scripts, other apps and FBRX peers use the governed agent and tools">
        <div className="fx-form">
          <Toggle checked={s.localApi.enabled} disabled={isLocked(locked, 'localApi.enabled')} onChange={(v) => void patch({ localApi: { enabled: v } })} label={i.running ? `Running on ${i.url}` : 'Enable Local API'} />
          <Field label="Port">
            <Input type="number" value={s.localApi.port} disabled={isLocked(locked, 'localApi.port')} onChange={(e) => void patch({ localApi: { port: Number(e.target.value) || 47821 } })} />
          </Field>
          <Toggle checked={s.localApi.allowRemote} disabled={isLocked(locked, 'localApi.allowRemote')} onChange={(v) => void patch({ localApi: { allowRemote: v } })} label="Accept connections from other computers (FBRX peers on your network)" />
          {i.token && (
            <Field label="Access token">
              <CopyText value={i.token} secret />
            </Field>
          )}
          <div>
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                if (await confirm({ title: 'Rotate tokens?', body: 'Every script or peer using the current token will need the new one.', danger: true, confirmLabel: 'Rotate' })) await run('r', () => call('localapi.rotateToken').then(info.reload), 'Token rotated');
              }}
            >
              Rotate token
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Try it">
        <pre className="fx-code">{`curl -s ${i.url}/v1/agent/run \\
  -H "Authorization: Bearer $FBRX_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt":"How much disk space is free?"}'

curl -s ${i.url}/v1/tools/time.now -X POST \\
  -H "Authorization: Bearer $FBRX_TOKEN" -d '{}'

# Live events (server-sent events)
curl -N "${i.url}/v1/events?token=$FBRX_TOKEN"`}</pre>
        <p className="fx-secondary">Every call is governed and audited like the agent's own. Actions reserved for you (revealing credentials, restoring, enrolling) are not available over the API.</p>
      </Card>
      {dialog}
    </Grid>
  );
}

function Logs() {
  const [level, setLevel] = useState<'debug' | 'info' | 'warn' | 'error'>('info');
  const logs = useCore('logs.tail', { lines: 300, level }, [], 5000);
  const status = useCore('system.status');
  const [info, setInfo] = useState<{ version: string; dataDir: string; packaged: boolean } | null>(null);
  if (!info && bridge.appInfo) void bridge.appInfo().then((x) => x && setInfo(x));
  return (
    <>
      <Card title="About FBRX OS">
        <KeyValue
          items={[
            ['Version', status.data?.version],
            ['Shell', status.data?.shell],
            ['Data folder', <span className="mono">{status.data?.dataDir}</span>],
            ['Build', info ? (info.packaged ? 'Release' : 'Development') : '—'],
            ['Started', formatDate(status.data?.startedAt)],
          ]}
        />
      </Card>
      <Card title="Logs" actions={<div style={{ width: 140 }}><Select value={level} onChange={(e) => setLevel(e.target.value as typeof level)} options={['debug', 'info', 'warn', 'error']} /></div>}>
        <pre className="fx-code" style={{ maxHeight: 460 }}>
          {(logs.data ?? []).map((l) => `${l.ts.slice(11, 19)} ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.message}${l.data ? ` ${JSON.stringify(l.data)}` : ''}`).join('\n') || 'No log lines'}
        </pre>
      </Card>
    </>
  );
}

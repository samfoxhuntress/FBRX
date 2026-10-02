import { useEffect, useState } from 'react';
import type { DeepPartial, Settings, Texture } from '@fbrx/shared';
import { UPDATE_CHANNELS } from '@fbrx/shared';
import { AdvancedTag, Button, Callout, Card, CopyText, Field, Grid, Icons, Input, KeyValue, Page, Select, Status, TextArea, Toggle, formatDate, useAction, useConfirm, type IconName } from '@fbrx/ui';
import { bridge, call } from '../client';
import { isLocked, useCore } from '../hooks';
import { navigate, routeArg } from '../app';
import { PRESETS, TEXTURE_NAMES, playStartupSound, resolvedMode, resolvedTexture, textureImage, themeAccent } from '../theme';
import { summonGoose } from '../fun';
import { TrophyCase } from '../trophies';
import { AskButton, EmergencyStop } from '../widgets';

function Locked({ show }: { show: boolean }) {
  return show ? (
    <span className="lock-note">
      <Icons.lock size={12} /> Managed
    </span>
  ) : null;
}

type SectionId = 'general' | 'appearance' | 'agent' | 'spotlight' | 'trophies' | 'updates' | 'license' | 'api' | 'logs';
const SECTIONS: Array<{ id: SectionId; label: string; icon: IconName; group: string; advanced?: boolean }> = [
  { id: 'general', label: 'General', icon: 'settings', group: 'You' },
  { id: 'appearance', label: 'Appearance', icon: 'palette', group: 'You' },
  { id: 'agent', label: 'Agent', icon: 'sparkles', group: 'You' },
  { id: 'spotlight', label: 'Spotlight', icon: 'search', group: 'You' },
  { id: 'trophies', label: 'Trophy case', icon: 'trophy', group: 'You' },
  { id: 'updates', label: 'Updates', icon: 'download', group: 'This computer' },
  { id: 'license', label: 'License', icon: 'key', group: 'This computer' },
  { id: 'api', label: 'Local API', icon: 'link', group: 'For experts', advanced: true },
  { id: 'logs', label: 'Logs & about', icon: 'book', group: 'For experts' },
];

const sectionFromRoute = (): SectionId | null => (SECTIONS.some((x) => x.id === routeArg()) ? (routeArg() as SectionId) : null);

export function SettingsPage({ onRerunSetup }: { onRerunSetup: () => void }) {
  const [tab, setTab] = useState<SectionId>(() => sectionFromRoute() ?? 'general');
  // A link to a section (such as "See it" on a trophy) while Settings is already open.
  useEffect(() => {
    const on = () => {
      const t = sectionFromRoute();
      if (t) setTab(t);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  let group = '';
  return (
    <Page title="Settings" description="How FBRX OS looks and behaves on this computer. Settings your organization manages show a lock.">
      <ModeCard />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((x) => {
            const Ico = Icons[x.icon];
            const header = x.group !== group ? (group = x.group) : null;
            return (
              <div key={x.id}>
                {header && <div className="settings-nav-group">{header}</div>}
                <button className={`settings-nav-item${tab === x.id ? ' active' : ''}`} aria-current={tab === x.id ? 'page' : undefined} onClick={() => setTab(x.id)}>
                  <Ico size={15} />
                  <span>{x.label}</span>
                  {x.advanced && <AdvancedTag />}
                </button>
              </div>
            );
          })}
        </nav>
        <div className="settings-body">
          {tab === 'general' && <General onRerunSetup={onRerunSetup} />}
          {tab === 'appearance' && <Appearance />}
          {tab === 'agent' && <AgentSettings />}
          {tab === 'spotlight' && <SpotlightSettings />}
          {tab === 'trophies' && <Trophies />}
          {tab === 'updates' && <Updates />}
          {tab === 'license' && <License />}
          {tab === 'api' && <LocalApi />}
          {tab === 'logs' && <Logs />}
        </div>
      </div>
    </Page>
  );
}

/** Basic or Advanced mode, at the top of Settings so it is easy to find. */
function ModeCard() {
  const { s, locked, patch } = useSettings();
  if (!s) return null;
  const on = s.appearance.advancedMode;
  const lockedMode = isLocked(locked, 'appearance.advancedMode');
  const choice = (advanced: boolean, title: string, body: string) => (
    <button className={`mode-choice${on === advanced ? ' active' : ''}`} disabled={lockedMode} aria-pressed={on === advanced} onClick={() => on !== advanced && void patch({ appearance: { advancedMode: advanced } })}>
      <div className="mode-choice-title">
        {title}
        {advanced && <AdvancedTag label="Expert tools" />}
      </div>
      <div className="mode-choice-body">{body}</div>
    </button>
  );
  return (
    <div className="mode-card">
      <div>
        <div className="mode-card-title">
          Experience <Locked show={lockedMode} />
        </div>
        <div className="fx-muted" style={{ fontSize: 12.5 }}>Also in the top bar. Advanced features are marked with an Advanced tag wherever they appear.</div>
      </div>
      <div className="mode-choices">
        {choice(false, 'Basic', 'Everyday tools: dashboard, workspace, PC care, network, your phone and the agent.')}
        {choice(true, 'Advanced', 'Adds the Terminal, virtual lab, disks and partitions, Defender settings, network adapters, custom scan ranges, logs and developer tools.')}
      </div>
    </div>
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
          <Toggle checked={s.general.telemetry} disabled={L('general.telemetry')} onChange={(v) => void patch({ general: { telemetry: v } })} label="Share health telemetry with my organization's control plane" />
        </div>
      </Card>
      <Card title={`${s.ai.agentName}'s behavior`}>
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

function Appearance() {
  const { s, locked, patch } = useSettings();
  if (!s) return null;
  const a = s.appearance;
  const mode = resolvedMode(s.general.theme);
  const L = (p: string) => isLocked(locked, p);
  const seg = <V extends string>(value: V, options: Array<{ value: V; label: string }>, onChange: (v: V) => void, disabled?: boolean) => (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} disabled={disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
  return (
    <>
      <Card title="Theme" subtitle="Pick a look. Each theme has a light and a dark version.">
        <div className="fx-form">
          <Field label={<>Mode <Locked show={L('general.theme')} /></>}>
            {seg(s.general.theme, [{ value: 'system', label: 'Match Windows' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], (v) => void patch({ general: { theme: v } }), L('general.theme'))}
          </Field>
          <div className="swatches">
            {PRESETS.map((p) => {
              const [page, side, accent, glow] = mode === 'dark' ? p.dark : p.light;
              const tex = textureImage(p.texture, mode, 'bold', accent);
              return (
                <button key={p.id} className={`swatch${a.preset === p.id ? ' selected' : ''}`} disabled={L('appearance.preset')} onClick={() => void patch({ appearance: { preset: p.id } })} aria-pressed={a.preset === p.id}>
                  <div className="swatch-preview">
                    <div style={{ background: [tex, glow ? `linear-gradient(170deg, color-mix(in srgb, ${glow} 45%, ${side}), ${side} 75%)` : side].filter(Boolean).join(', ') }} />
                    <div style={{ background: page }}>
                      <div className="swatch-bar" style={{ background: accent, width: '70%' }} />
                      <div className="swatch-bar" style={{ background: mode === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)', width: '90%' }} />
                      <div className="swatch-bar" style={{ background: mode === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)', width: '55%' }} />
                    </div>
                  </div>
                  <div className="swatch-label">{p.name}{p.id === 'fabrics' ? ' (default)' : ''}</div>
                </button>
              );
            })}
          </div>
          <Field label="Accent color" help="Leave on Theme to use the theme's own accent">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="color" aria-label="Accent color" value={a.accent || themeAccent(a, mode)} onChange={(e) => void patch({ appearance: { accent: e.target.value } })} style={{ width: 44, height: 32, border: 0, background: 'none' }} />
              <span className="mono">{a.accent || 'Theme accent'}</span>
              {a.accent && <Button size="sm" variant="ghost" onClick={() => void patch({ appearance: { accent: '' } })}>Use theme accent</Button>}
            </div>
          </Field>
        </div>
      </Card>
      <Card title="Texture" subtitle="A woven, grainy or patterned finish on the sidebar, top bar and page. Each theme has its own.">
        <div className="fx-form">
          <div className="tex-tiles">
            {(['theme', ...Object.keys(TEXTURE_NAMES)] as Texture[]).map((t) => {
              const shown = t === 'theme' ? resolvedTexture({ texture: 'theme', preset: a.preset }) : t;
              const img = textureImage(shown, mode, 'bold', themeAccent(a, mode));
              return (
                <button key={t} className={`tex-tile${a.texture === t ? ' selected' : ''}`} disabled={L('appearance.texture')} aria-pressed={a.texture === t} onClick={() => void patch({ appearance: { texture: t } })}>
                  <span className="tex-tile-preview" style={{ backgroundImage: img ?? 'none', backgroundSize: shown === 'palms' ? '96px 96px' : shown === 'grid' ? '64px 64px' : undefined }} />
                  <span className="tex-tile-label">{t === 'theme' ? `Theme's own (${TEXTURE_NAMES[shown]})` : TEXTURE_NAMES[t]}</span>
                </button>
              );
            })}
          </div>
          <Field label="Strength">{seg(a.textureStrength, [{ value: 'subtle', label: 'Subtle' }, { value: 'medium', label: 'Medium' }, { value: 'bold', label: 'Bold' }], (v) => void patch({ appearance: { textureStrength: v } }), resolvedTexture(a) === 'none')}</Field>
        </div>
      </Card>
      <Grid cols={2}>
        <Card title="Layout">
          <div className="fx-form">
            <Field label="Density">{seg(a.density, [{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' }], (v) => void patch({ appearance: { density: v } }))}</Field>
            <Field label="Corners">{seg(a.radius, [{ value: 'sharp', label: 'Sharp' }, { value: 'rounded', label: 'Rounded' }, { value: 'soft', label: 'Soft' }], (v) => void patch({ appearance: { radius: v } }))}</Field>
            <Field label={`Text and interface size: ${Math.round(a.fontScale * 100)}%`}>
              <input type="range" min={0.85} max={1.3} step={0.05} value={a.fontScale} onChange={(e) => void patch({ appearance: { fontScale: Number(e.target.value) } })} />
            </Field>
          </div>
        </Card>
        <Card title="Behavior">
          <div className="fx-form">
            <Toggle checked={a.reduceMotion} onChange={(v) => void patch({ appearance: { reduceMotion: v } })} label="Reduce motion" />
            <Toggle checked={a.splash} onChange={(v) => void patch({ appearance: { splash: v } })} label="Show the start-up animation" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle checked={a.splashSound} onChange={(v) => void patch({ appearance: { splashSound: v } })} label="Play the start-up sound" />
              <Button size="sm" variant="ghost" icon="play" onClick={playStartupSound}>
                Listen
              </Button>
            </div>
          </div>
        </Card>
      </Grid>
      <Card title={<>Fun extras <Locked show={L('appearance.easterEggs')} /></>} subtitle="Jokes, easter eggs and the Silly Goose. Nothing here touches your files or settings.">
        <div className="fx-form">
          <Toggle checked={a.easterEggs} disabled={L('appearance.easterEggs')} onChange={(v) => void patch({ appearance: { easterEggs: v } })} label="Easter eggs and jokes" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Toggle checked={a.gooseVisits} disabled={!a.easterEggs || L('appearance.gooseVisits')} onChange={(v) => void patch({ appearance: { gooseVisits: v } })} label="Let the goose drop by now and then" />
            <Button size="sm" icon="feather" disabled={!a.easterEggs} onClick={summonGoose}>
              Release the goose
            </Button>
            <Button size="sm" icon="trophy" variant="ghost" onClick={() => navigate('settings/trophies')}>
              Trophy case
            </Button>
          </div>
          <p className="fx-muted" style={{ margin: 0, fontSize: 12.5 }}>
            The goose waddles across your screen for about a minute and a half, honks, tracks a little mud, borrows your mouse pointer and leaves notes. Clicks go straight through it to your apps. Click the goose three times, or choose Shoo the goose in the tray menu, to send it home. Other surprises are hidden around the app; every one you find earns a badge in the Trophy case.
          </p>
        </div>
      </Card>
    </>
  );
}

function Trophies() {
  const { s, patch } = useSettings();
  if (!s) return null;
  return <TrophyCase enabled={s.appearance.easterEggs} onEnable={() => void patch({ appearance: { easterEggs: true } })} />;
}

function AgentSettings() {
  const { s, locked, patch } = useSettings();
  const [name, setName] = useState<string | null>(null);
  if (!s) return null;
  const L = (p: string) => isLocked(locked, p);
  return (
    <Grid cols={2}>
      <Card title="Your agent">
        <div className="fx-form">
          <Field label={<>Name <Locked show={L('ai.agentName')} /></>} help="Used throughout FBRX OS and in how the agent introduces itself">
            <div style={{ display: 'flex', gap: 8 }}>
              <Input maxLength={40} value={name ?? s.ai.agentName} disabled={L('ai.agentName')} onChange={(e) => setName(e.target.value)} />
              <Button disabled={name === null || !name.trim()} onClick={() => void patch({ ai: { agentName: name!.trim() } }).then(() => setName(null))}>
                Save
              </Button>
            </div>
          </Field>
          <Toggle checked={s.ai.newChatsOffline} disabled={L('ai.newChatsOffline')} onChange={(v) => void patch({ ai: { newChatsOffline: v } })} label="Start new chats offline (ask before using the internet)" />
          <p className="fx-muted" style={{ fontSize: 12.5, margin: 0 }}>
            Offline chats keep everything on this computer. When {s.ai.agentName} needs a web or network tool, you get an approval to put that chat online.
          </p>
        </div>
      </Card>
      <Card title="Models and permissions">
        <div className="fx-form">
          <p className="fx-muted" style={{ margin: 0 }}>Choose which AI model {s.ai.agentName} uses in AI models, and what it may do without asking in Governance.</p>
          <div className="fx-actions">
            <Button onClick={() => (location.hash = '#/runtime')}>AI models</Button>
            <Button onClick={() => (location.hash = '#/governance')}>Governance</Button>
          </div>
        </div>
      </Card>
      <div style={{ gridColumn: '1 / -1' }}>
        <Card title="Emergency stop" subtitle={'The big red button. Also on the agent page, in the tray menu, and as "request ai stop" in FBRX/1.'}>
          <EmergencyStop />
        </Card>
      </div>
    </Grid>
  );
}

function SpotlightSettings() {
  const { s, patch } = useSettings();
  const [key, setKey] = useState<string | null>(null);
  if (!s) return null;
  return (
    <Card title="Spotlight" subtitle="One search box for apps, files, settings, commands, calculations and quick answers, from anywhere">
      <div className="fx-form">
        <Toggle checked={s.spotlight.enabled} onChange={(v) => void patch({ spotlight: { enabled: v } })} label="Turn on Spotlight" />
        <Field label="Keyboard shortcut" help="For example Alt+Space, Control+Space or Alt+Shift+F. Inside FBRX OS, Ctrl+K also opens it.">
          <div style={{ display: 'flex', gap: 8 }}>
            <Input value={key ?? s.spotlight.hotkey} onChange={(e) => setKey(e.target.value)} />
            <Button disabled={key === null || !key.trim()} onClick={() => void patch({ spotlight: { hotkey: key!.trim() } }).then(() => setKey(null))}>
              Save
            </Button>
          </div>
        </Field>
        <Toggle checked={s.spotlight.fileSearch} onChange={(v) => void patch({ spotlight: { fileSearch: v } })} label="Search files (uses the Windows search index)" />
        <Field label="Web search">
          <Select value={s.spotlight.webSearch} onChange={(e) => void patch({ spotlight: { webSearch: e.target.value as 'google' } })} options={[{ value: 'google', label: 'Google' }, { value: 'bing', label: 'Bing' }, { value: 'duckduckgo', label: 'DuckDuckGo' }]} />
        </Field>
        <div>
          <Button icon="search" onClick={() => bridge.showSpotlight?.()}>
            Try it now
          </Button>
        </div>
      </div>
    </Card>
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
      <Card title="Preferences" subtitle="Your organization decides which version this device runs">
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
            ['Source', { managed: 'Your organization', local: 'License key on this device', development: 'Development build', none: '—' }[l.source]],
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
        <p className="fx-muted" style={{ margin: '10px 0 0', fontSize: 12.5, fontStyle: 'italic' }}>Woven from thread, coffee and one very determined goose.</p>
      </Card>
      <Card
        title="Logs"
        actions={
          <>
            <AskButton label="Analyze these logs" prompt="These are the recent FBRX OS log lines from my PC. Tell me whether anything is wrong, what the warnings and errors mean, and what to do about them." context={(logs.data ?? []).slice(-150).map((l) => `${l.ts} ${l.level} [${l.scope}] ${l.message}${l.data ? ` ${JSON.stringify(l.data)}` : ''}`).join('\n')} />
            <div style={{ width: 140 }}>
              <Select value={level} onChange={(e) => setLevel(e.target.value as typeof level)} options={['debug', 'info', 'warn', 'error']} />
            </div>
          </>
        }
      >
        <pre className="fx-code" style={{ maxHeight: 460 }}>
          {(logs.data ?? []).map((l) => `${l.ts.slice(11, 19)} ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.message}${l.data ? ` ${JSON.stringify(l.data)}` : ''}`).join('\n') || 'No log lines'}
        </pre>
      </Card>
    </>
  );
}

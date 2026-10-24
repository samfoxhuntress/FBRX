import { useEffect, useState, type ReactNode } from 'react';
import type { DeepPartial, EditionStatus, EffectivePolicy, Settings, Texture } from '@fbrx/shared';
import {
  AUDIENCE_NAMES,
  BROWSER_SEARCH_ENGINES,
  EDITION_PLANS,
  IMAGE_GENERATORS,
  IMAGE_SIZES,
  MAX_STEPS_PER_TASK,
  STANDARD_TRIAL_DAYS,
  SUPPORT_ENTER_PHRASE,
  SUPPORT_EXIT_PHRASE,
  SUPPORT_PASS_PREFIX,
  THINKING_BUDGETS,
  THINKING_LEVELS,
  THINKING_NAMES,
  THINKING_SETTINGS,
  TIERS,
  TIER_NAMES,
  TIER_SHORT,
  UPDATE_CHANNELS,
  atLeast,
  displayVersion,
  editionPoints,
  formatPrice,
  funEnabled,
  thinkingBudget,
  thinkingLevelOf,
  tierRank,
  withSteps,
  type ImageGenerator,
  type ImageSize,
  type ThinkingLevel,
  type Tier,
  type WebSearchEngine,
} from '@fbrx/shared';
import { AdvancedTag, Button, Callout, Card, CopyText, Field, Grid, Icons, Input, KeyValue, Page, Select, Status, TextArea, Toggle, formatDate, useAction, useConfirm, useToast, type IconName } from '@fbrx/ui';
import { bridge, call } from '../client';
import { isLocked, useCore } from '../hooks';
import { navigate, routeArg } from '../app';
import { PRESETS, TEXTURE_NAMES, playStartupSound, resolvedMode, resolvedTexture, textureImage, themeAccent } from '../theme';
import { GoosePreview, seasonNow, summonGoose } from '../fun';
import { TrophyBadge, TrophyCase } from '../trophies';
import { AskButton, EmergencyStop, ProfileFields, saveProfile } from '../widgets';
import { KeyRecorder, MacroSettings } from './settings-macros';
import { SnippetSettings } from './settings-snippets';
import { VoiceSettings } from './settings-voice';
import { MemorySettings } from './settings-memory';
import { AboutVersion, ReleasePanel } from '../release';
import { AccountSettings, BuyButtons, useAccount } from '../account';
import { EditionHint, trialLine, howToGet, useAtLeast, useChooseEdition, useEditionStatus, useLearner, useTier, useVertical } from '../edition';

function Locked({ show }: { show: boolean }) {
  return show ? (
    <span className="lock-note">
      <Icons.lock size={12} /> Managed
    </span>
  ) : null;
}

type SectionId = 'general' | 'appearance' | 'presenting' | 'messages' | 'agent' | 'memory' | 'voice' | 'snippets' | 'macros' | 'spotlight' | 'browser' | 'trophies' | 'updates' | 'account' | 'edition' | 'license' | 'api' | 'logs';
const SECTIONS: Array<{ id: SectionId; label: string; icon: IconName; group: string; ultra?: boolean; basicLabel?: string; notEssentials?: boolean }> = [
  { id: 'general', label: 'General', icon: 'settings', group: 'You' },
  { id: 'appearance', label: 'Appearance', icon: 'palette', group: 'You' },
  { id: 'presenting', label: 'Presenting', icon: 'presentation', group: 'You', notEssentials: true },
  { id: 'messages', label: 'Messages', icon: 'message', group: 'You', notEssentials: true },
  { id: 'agent', label: 'Agent', icon: 'sparkles', group: 'You' },
  { id: 'memory', label: 'Memory', icon: 'brain', group: 'You' },
  { id: 'voice', label: 'Voice', icon: 'mic', group: 'You' },
  { id: 'snippets', label: 'Snippets', icon: 'code', group: 'You', notEssentials: true },
  { id: 'macros', label: 'Macros', icon: 'zap', group: 'You', notEssentials: true },
  { id: 'spotlight', label: 'Spotlight', icon: 'search', group: 'You' },
  { id: 'browser', label: 'Browser', icon: 'globe', group: 'You', notEssentials: true },
  { id: 'trophies', label: 'Trophy case', icon: 'trophy', group: 'You' },
  { id: 'updates', label: 'Updates', icon: 'download', group: 'This computer' },
  { id: 'account', label: 'FBRX account', icon: 'user', group: 'This computer' },
  { id: 'edition', label: 'Edition', icon: 'layers', group: 'This computer' },
  { id: 'license', label: 'License', icon: 'key', group: 'This computer' },
  { id: 'api', label: 'Local API', icon: 'link', group: 'For experts', ultra: true },
  { id: 'logs', label: 'Logs & about', icon: 'book', group: 'For experts', basicLabel: 'About' },
];

/** Student computers: who they are, how it looks and sounds, presenting, and About. */
const LEARNER_SECTIONS = new Set<SectionId>(['general', 'appearance', 'presenting', 'messages', 'voice', 'logs']);

const sectionFromRoute = (): SectionId | null => (SECTIONS.some((x) => x.id === routeArg()) ? (routeArg() as SectionId) : null);

export function SettingsPage({ onRerunSetup }: { onRerunSetup: () => void }) {
  const tier = useTier();
  const ultra = atLeast(tier, 'ultra');
  const funUnlocked = useCore('settings.get', undefined, ['settings.changed']).data?.settings.appearance.funUnlocked ?? false;
  const learner = useLearner();
  const vertical = useVertical();
  const sections = SECTIONS.filter((x) => (learner ? LEARNER_SECTIONS.has(x.id) : (ultra || !x.ultra) && !(tier === 'essentials' && x.notEssentials)));
  const [picked, setTab] = useState<SectionId>(() => sectionFromRoute() ?? 'general');
  const tab = sections.some((x) => x.id === picked) ? picked : 'general';
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
    <Page title="Settings" description={`How FBRX looks and behaves on this computer. Settings your ${vertical === 'home' ? 'family' : 'organization'} manages show a lock.`}>
      <EditionCard />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map((x) => {
            const Ico = Icons[x.icon];
            const g = !ultra && x.group === 'For experts' ? 'Help' : x.group;
            const header = g !== group ? (group = g) : null;
            return (
              <div key={x.id}>
                {header && <div className="settings-nav-group">{header}</div>}
                <button className={`settings-nav-item${tab === x.id ? ' active' : ''}${x.id === 'trophies' && !funUnlocked ? ' locked' : ''}`} aria-current={tab === x.id ? 'page' : undefined} onClick={() => setTab(x.id)}>
                  <Ico size={15} />
                  <span>{!ultra && x.basicLabel ? x.basicLabel : x.label}</span>
                  {x.id === 'trophies' && !funUnlocked ? <Icons.lock size={12} className="settings-nav-lock" /> : x.ultra && <AdvancedTag />}
                </button>
              </div>
            );
          })}
        </nav>
        <div className="settings-body">
          {tab === 'general' && <General onRerunSetup={onRerunSetup} />}
          {tab === 'appearance' && <Appearance />}
          {tab === 'presenting' && <PresentingSettings />}
          {tab === 'messages' && <MessagesSettings />}
          {tab === 'agent' && <AgentSettings />}
          {tab === 'memory' && <MemorySettings />}
          {tab === 'voice' && <VoiceSettings />}
          {tab === 'snippets' && <SnippetSettings />}
          {tab === 'macros' && <MacroSettings />}
          {tab === 'spotlight' && <SpotlightSettings />}
          {tab === 'browser' && <BrowserSettings />}
          {tab === 'trophies' && <Trophies />}
          {tab === 'updates' && <Updates />}
          {tab === 'account' && <AccountSettings />}
          {tab === 'edition' && <EditionSettings />}
          {tab === 'license' && <License />}
          {tab === 'api' && <LocalApi />}
          {tab === 'logs' && <Logs />}
        </div>
      </div>
    </Page>
  );
}

/** Which FBRX Endpoint this is, at the top of Settings, who set it, and the way to Settings → Edition. */
function EditionCard() {
  const { data: l } = useCore('license.status', undefined, ['license.changed']);
  const { data: fleet } = useCore('fleet.status', undefined, ['fleet.changed']);
  const ed = useCore('edition.status', undefined, ['license.changed', 'fleet.changed']).data;
  if (!l) return null;
  if (ed?.learner) {
    return (
      <div className="mode-card edition-card basic">
        <div>
          <div className="mode-card-title">
            {ed.productName} <span className="tier-badge student">{AUDIENCE_NAMES[ed.audience]}</span>
          </div>
          <div className="fx-muted" style={{ fontSize: 12.5 }}>
            {ed.vertical === 'home'
              ? `A computer set up by ${fleet?.tenantName ?? 'your family'} for learning and play. A parent chooses its tools and keeps it safe.`
              : `A computer set up by ${fleet?.tenantName ?? 'your school'} for learning. Your school chooses its tools and keeps it safe.`}
          </div>
        </div>
      </div>
    );
  }
  const by = l.source === 'managed' ? `Set by ${fleet?.tenantName ?? 'your organization'} (FBRX Command)` : l.source === 'development' ? 'Development build' : l.customer ? `Licensed to ${l.customer}` : null;
  const more = ed && tierRank(ed.ceiling) > tierRank(l.tier);
  return (
    <div className={`mode-card edition-card ${l.tier}`}>
      <div>
        <div className="mode-card-title">
          {TIER_NAMES[l.tier]} <span className={`tier-badge ${l.tier}`}>{TIER_SHORT[l.tier]}</span>
          {ed && ed.vertical !== 'business' && <span className="tier-badge student" style={{ marginLeft: 6 }}>{ed.vertical === 'home' ? 'Home' : 'Education'}</span>}
        </div>
        <div className="fx-muted" style={{ fontSize: 12.5 }}>
          {EDITION_PLANS[l.tier].summary}
          {by && <> · {by}</>}
        </div>
      </div>
      <Button variant={more ? 'primary' : undefined} icon="layers" onClick={() => navigate('settings/edition')}>
        {more ? 'More tools' : 'Edition'}
      </Button>
    </div>
  );
}

/** "$4.99 a month", "Free", "$24.99 a month, through FBRX Command". */
function priceLine(t: Tier): ReactNode {
  const p = EDITION_PLANS[t];
  if (p.monthly === 0) return 'Free';
  if (p.monthly == null) return <>{formatPrice(p.tenantMonthly)} <small>a month per computer, through FBRX Command</small></>;
  return <>{formatPrice(p.monthly)} <small>a month, or {formatPrice(p.tenantMonthly)} through FBRX Command</small></>;
}

/** Why this computer may run what it may, in a sentence (Settings → Edition). */
function ceilingLine(ed: EditionStatus): string {
  switch (ed.ceilingReason) {
    case 'development':
      return 'Development build: every edition can be turned on.';
    case 'trial':
      return `${trialLine(ed)} Then Standard is ${formatPrice(EDITION_PLANS.basic.monthly!)} a month; Essentials stays free.`;
    case 'standalone':
      return `On its own, this computer runs Essentials for free.${ed.trialAvailable ? ` Standard can be tried free for ${STANDARD_TRIAL_DAYS} days, once.` : ''} Standard and Ultra are bought on your FBRX account or with a license key (Settings → License), or come through your organization’s FBRX Command. Black Hole comes only through FBRX Command.`;
    case 'organization':
      return `Your organization (FBRX Command) lets this computer go up to ${TIER_SHORT[ed.ceiling]}.`;
    default:
      return ed.enrolled ? `Your organization's license allows up to ${TIER_SHORT[ed.ceiling]}.` : `Your license allows up to ${TIER_SHORT[ed.ceiling]}. Black Hole comes only through an organization's FBRX Command.`;
  }
}

/**
 * Settings → Edition: Essentials (free, where a new computer starts), Standard and Ultra (bought, or through an
 * organization's FBRX Command) and Black Hole (only through FBRX Command), with why a choice is locked and the
 * walkthrough again.
 */
function EditionSettings() {
  const ed = useEditionStatus();
  const account = useAccount();
  const { choose, startTrial, busy } = useChooseEdition();
  if (!ed) return null;
  return (
    <>
      <Card title="Edition" subtitle="How much of FBRX this computer shows. Switch any time: nothing you saved goes away.">
        <div className="ed-choices">
          {TIERS.map((t) => {
            const current = ed.tier === t;
            const locked = tierRank(t) > tierRank(ed.ceiling);
            return (
              <div key={t} className={`ed-choice${current ? ' current' : ''}${locked ? ' locked' : ''}`}>
                <h4>
                  {TIER_SHORT[t]} {locked && <Icons.lock size={13} />}
                </h4>
                <div className="ed-price">{priceLine(t)}</div>
                <ul>
                  {editionPoints(t).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <div className="ed-choice-foot">
                  {current ? (
                    <Status tone="good">On now</Status>
                  ) : locked && t === 'basic' && ed.trialAvailable ? (
                    <Button size="sm" variant="primary" icon="sparkles" loading={busy === t} onClick={() => void startTrial()}>
                      Try free for {STANDARD_TRIAL_DAYS} days
                    </Button>
                  ) : locked && account?.signedIn && account.canBuy && !ed.enrolled && EDITION_PLANS[t].sold === 'personal' && !atLeast(account.tier, t) ? (
                    <BuyButtons account={account} only={[t]} short />
                  ) : locked ? (
                    <span className="fx-muted" style={{ fontSize: 12.5 }}>
                      {howToGet(t, ed)}
                    </span>
                  ) : (
                    <Button size="sm" variant={tierRank(t) > tierRank(ed.tier) ? 'primary' : undefined} loading={busy === t} onClick={() => void choose(t)}>
                      Switch to {TIER_SHORT[t]}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="fx-muted" style={{ margin: '12px 0 0' }}>
          {ceilingLine(ed)}
          {ed.chosen !== ed.tier && tierRank(ed.chosen) > tierRank(ed.tier) && <> You chose {TIER_SHORT[ed.chosen]}; it runs {TIER_SHORT[ed.tier]} until that is allowed.</>}
        </p>
        {!ed.enrolled && ed.ceilingReason !== 'development' && (
          <div className="fx-actions" style={{ marginTop: 10 }}>
            {!account?.signedIn && (
              <Button size="sm" variant="primary" icon="user" onClick={() => navigate('settings/account')}>
                Sign in to your FBRX account
              </Button>
            )}
            <Button size="sm" icon="key" onClick={() => navigate('settings/license')}>
              Enter a license key
            </Button>
            <Button size="sm" icon="globe" onClick={() => navigate('fleet')}>
              Join your organization
            </Button>
          </div>
        )}
      </Card>
      <Card title="The walkthrough" subtitle="A short look around Essentials: your AI, its models and Settings.">
        {ed.tier === 'essentials' ? (
          <Button
            icon="compass"
            onClick={() =>
              void call('edition.tourDone', { done: false }).then(() => {
                navigate('home');
                window.dispatchEvent(new Event('fbrx:tour'));
              })
            }
          >
            Take the tour again
          </Button>
        ) : (
          <p className="fx-muted" style={{ margin: 0 }}>
            The walkthrough shows the Essentials pages: switch to Essentials to take it.
          </p>
        )}
      </Card>
    </>
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
  const [profile, setProfile] = useState<{ name: string; callMe: string } | null>(null);
  const toast = useToast();
  const tier = useTier();
  const ultra = atLeast(tier, 'ultra');
  const learner = useLearner();
  const enrolled = useCore('fleet.status', undefined, ['fleet.changed']).data?.state !== 'unenrolled';
  if (!s) return null;
  const L = (p: string) => isLocked(locked, p);
  const prof = profile ?? s.profile;
  return (
    <Grid cols={2}>
      <div style={{ gridColumn: '1 / -1' }}>
        <Card title="You" subtitle={`FBRX Glass and ${s.ai.agentName} greet you by this name.`}>
          <div className="fx-form">
            <ProfileFields name={prof.name} callMe={prof.callMe} onChange={setProfile} />
            <div>
              <Button variant="primary" disabled={!profile} onClick={() => void saveProfile(prof, funEnabled(s, tier), toast).then(() => setProfile(null))}>
                Save
              </Button>
            </div>
          </div>
        </Card>
      </div>
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
          <Toggle checked={s.general.launchAtLogin} disabled={L('general.launchAtLogin')} onChange={(v) => void patch({ general: { launchAtLogin: v } })} label="Start FBRX when I sign in" />
          <Toggle checked={s.general.minimizeToTray} disabled={L('general.minimizeToTray')} onChange={(v) => void patch({ general: { minimizeToTray: v } })} label="Keep running in the tray when the window is closed" />
          {(ultra || enrolled) && <Toggle checked={s.general.telemetry} disabled={L('general.telemetry')} onChange={(v) => void patch({ general: { telemetry: v } })} label="Share health telemetry with my organization's control plane" />}
        </div>
      </Card>
      {bridge.popOut && !learner && (
        <Card title="Windows" subtitle="Open these in a window of their own, to keep them beside FBRX or any other app. Right-click a page in the sidebar to open any page in a new window.">
          <div className="fx-form">
            {ultra && <Toggle checked={s.windows.terminal} disabled={L('windows.terminal')} onChange={(v) => void patch({ windows: { terminal: v } })} label="The Terminal opens in its own window" />}
            <Toggle checked={s.windows.agent} disabled={L('windows.agent')} onChange={(v) => void patch({ windows: { agent: v } })} label={`The chat with ${s.ai.agentName} opens in its own window`} />
          </div>
        </Card>
      )}
      {!learner && <Card title={`${s.ai.agentName}'s behavior`}>
        <div className="fx-form">
          {ultra && (
            <Field label={<>Creativity (temperature): {s.ai.temperature} <Locked show={L('ai.temperature')} /></>} help="Lower is more precise. Ignored by models that manage this themselves.">
              <input type="range" min={0} max={1} step={0.05} disabled={L('ai.temperature')} value={s.ai.temperature} onChange={(e) => void patch({ ai: { temperature: Number(e.target.value) } })} />
            </Field>
          )}
          <Field label={<>Agent instructions <Locked show={L('ai.systemPrompt')} /></>} help={ultra ? 'Standing instructions included in every conversation' : 'Included in every conversation. Add anything it should always know, such as "I teach 4th grade; keep answers short."'}>
            <TextArea rows={8} disabled={L('ai.systemPrompt')} defaultValue={s.ai.systemPrompt} onBlur={(e) => e.target.value !== s.ai.systemPrompt && void patch({ ai: { systemPrompt: e.target.value } })} />
          </Field>
          <div>
            <Button size="sm" onClick={onRerunSetup}>
              Run first-time setup again
            </Button>
          </div>
        </div>
      </Card>}
    </Grid>
  );
}

const NAV_ICON_STYLES: Array<{ id: Settings['appearance']['navIcons']; label: string; ultra?: boolean }> = [
  { id: 'accent', label: 'Theme color' },
  { id: 'sections', label: 'A color for each section' },
  { id: 'custom', label: 'One color you pick', ultra: true },
  { id: 'plain', label: 'Plain' },
];
const NAV_PREVIEW: Array<{ icon: IconName; sec: string }> = [
  { icon: 'compass', sec: 'command' },
  { icon: 'layers', sec: 'workspace' },
  { icon: 'wrench', sec: 'care' },
  { icon: 'castle', sec: 'protect' },
];

/** Settings → Appearance → Sidebar icons: one color for a calm, single-color look, or a color for each section. */
function NavIconsCard() {
  const { s, locked, patch } = useSettings();
  const ultra = useAtLeast('ultra');
  if (!s) return null;
  const a = s.appearance;
  const L = (p: string) => isLocked(locked, p);
  const mode = resolvedMode(s.general.theme);
  const picked = a.navIconColor || themeAccent(a, mode);
  const hueFor = (style: Settings['appearance']['navIcons'], sec: string) =>
    style === 'accent' ? 'var(--accent)' : style === 'sections' ? `var(--sec-${sec})` : style === 'custom' ? picked : 'var(--text-secondary)';
  const tint = a.navIconStrength / 50;
  return (
    <Card title="Sidebar icons" subtitle="All in one color for a calm look (your theme's, or one you pick), or a color for each section.">
      <div className="fx-form">
        <div className="tex-tiles">
          {NAV_ICON_STYLES.filter((x) => ultra || !x.ultra).map((x) => (
            <button
              key={x.id}
              className={`tex-tile${a.navIcons === x.id ? ' selected' : ''}`}
              disabled={L('appearance.navIcons')}
              aria-pressed={a.navIcons === x.id}
              onClick={() => void patch({ appearance: { navIcons: x.id, ...(x.id === 'custom' && !a.navIconColor ? { navIconColor: picked } : {}) } })}
            >
              <span className="nav-icons-preview">
                {NAV_PREVIEW.map((p) => {
                  const hue = hueFor(x.id, p.sec);
                  const Ico = Icons[p.icon];
                  return (
                    <span key={p.icon} style={{ color: hue, background: `color-mix(in srgb, ${hue} ${13 * tint}%, var(--surface-2))`, borderColor: `color-mix(in srgb, ${hue} ${28 * tint}%, transparent)` }}>
                      <Ico size={14} />
                    </span>
                  );
                })}
              </span>
              <span className="tex-tile-label">{x.label}</span>
            </button>
          ))}
        </div>
        {ultra && a.navIcons === 'custom' && (
          <Field label="Icon color">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="color" aria-label="Icon color" value={picked} disabled={L('appearance.navIconColor')} onChange={(e) => void patch({ appearance: { navIconColor: e.target.value } })} style={{ width: 44, height: 32, border: 0, background: 'none' }} />
              <span className="mono">{picked}</span>
            </div>
          </Field>
        )}
        <Field label={`Tint behind the icons: ${a.navIconStrength === 0 ? 'off' : `${Math.round(a.navIconStrength)}%`}`} help="From just the colored icon to a rich colored tile. 50% is the usual look.">
          <div className="tex-strength">
            <span>None</span>
            <input type="range" min={0} max={100} step={5} disabled={a.navIcons === 'plain' || L('appearance.navIconStrength')} value={a.navIconStrength} onChange={(e) => void patch({ appearance: { navIconStrength: Number(e.target.value) } })} />
            <span>Rich</span>
          </div>
        </Field>
      </div>
    </Card>
  );
}

function Appearance() {
  const { s, locked, patch } = useSettings();
  const ultra = useAtLeast('ultra');
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
      <Card title="Theme" subtitle={ultra ? 'Pick a look. Each theme has a light and a dark version.' : 'Light or dark, or follow your computer.'}>
        <div className="fx-form">
          <Field label={<>Mode <Locked show={L('general.theme')} /></>}>
            {seg(s.general.theme, [{ value: 'system', label: 'Match Windows' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], (v) => void patch({ general: { theme: v } }), L('general.theme'))}
          </Field>
          {!ultra && <EditionHint>More themes, accent colors, gradients and textures come with Endpoint Ultra.</EditionHint>}
          {ultra && <>
          <div className="swatches">
            {PRESETS.map((p) => {
              const [page, side, accent, glow] = mode === 'dark' ? p.dark : p.light;
              const tex = textureImage(p.texture, mode, 100, accent);
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
          </>}
        </div>
      </Card>
      {ultra && <Card title="Texture" subtitle="A woven, grainy or patterned finish on the sidebar, top bar and page. Each theme has its own.">
        <div className="fx-form">
          <div className="tex-tiles">
            {(['theme', ...Object.keys(TEXTURE_NAMES)] as Texture[]).map((t) => {
              const shown = t === 'theme' ? resolvedTexture({ texture: 'theme', preset: a.preset }) : t;
              const img = textureImage(shown, mode, 100, themeAccent(a, mode));
              return (
                <button key={t} className={`tex-tile${a.texture === t ? ' selected' : ''}`} disabled={L('appearance.texture')} aria-pressed={a.texture === t} onClick={() => void patch({ appearance: { texture: t } })}>
                  <span className="tex-tile-preview" style={{ backgroundImage: img ?? 'none', backgroundSize: shown === 'palms' ? '96px 96px' : shown === 'grid' ? '64px 64px' : undefined }} />
                  <span className="tex-tile-label">{t === 'theme' ? `Theme's own (${TEXTURE_NAMES[shown]})` : TEXTURE_NAMES[t]}</span>
                </button>
              );
            })}
          </div>
          <Field label={`Strength: ${a.textureStrength === 0 ? 'off' : `${Math.round(a.textureStrength)}%`}`} help="From barely there to clearly woven. New installs start at a soft 50%.">
            <div className="tex-strength">
              <span>Faint</span>
              <input type="range" min={0} max={100} step={5} disabled={resolvedTexture(a) === 'none' || L('appearance.textureStrength')} value={a.textureStrength} onChange={(e) => void patch({ appearance: { textureStrength: Number(e.target.value) } })} />
              <span>Strong</span>
            </div>
          </Field>
        </div>
      </Card>}
      <NavIconsCard />
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
            <Field label="Effects" help="Lite turns off frosted glass, glows and decorative animation. Auto picks Lite on smaller computers.">
              {seg(a.effects, [{ value: 'auto', label: 'Auto' }, { value: 'full', label: 'Full' }, { value: 'light', label: 'Lite' }], (v) => void patch({ appearance: { effects: v } }))}
            </Field>
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
      {a.funUnlocked && <Card title={<>Fun extras <Locked show={L('appearance.easterEggs')} /></>} subtitle="Jokes, easter eggs and the Silly Goose. Nothing here touches your files or settings.">
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
          <div className="goose-wardrobe">
            <Field label="The goose's wardrobe" help="Flight goggles all year. Scarf and boots in winter, a scarf in the fall, a butterfly for company in spring, and a beach umbrella (and postcards) in summer. By season follows where you are.">
              <div className="seg" role="group" aria-label="The goose's wardrobe">
                {(['auto', 'winter', 'spring', 'summer', 'fall'] as const).map((x) => (
                  <button key={x} className={a.gooseSeason === x ? 'on' : ''} disabled={!a.easterEggs} onClick={() => void patch({ appearance: { gooseSeason: x } })}>
                    {x === 'auto' ? `By season (${seasonNow()})` : x[0].toUpperCase() + x.slice(1)}
                  </button>
                ))}
              </div>
            </Field>
            <GoosePreview season={a.gooseSeason === 'auto' ? seasonNow() : a.gooseSeason} />
          </div>
          <p className="fx-muted" style={{ margin: 0, fontSize: 12.5 }}>
            The goose waddles across your screen for about a minute and a half, honks, drops the odd feather, boops your mouse pointer and leaves notes. Clicks go straight through it to your apps. Click the goose three times, or choose Shoo the goose in the tray menu, to send it home. Other surprises are hidden around the app; every one you find earns a badge in the Trophy case.
          </p>
        </div>
      </Card>}
    </>
  );
}

function Trophies() {
  const { s, patch } = useSettings();
  if (!s) return null;
  if (!s.appearance.funUnlocked) return <LockedCase />;
  return <TrophyCase enabled={s.appearance.easterEggs} onEnable={() => void patch({ appearance: { easterEggs: true } })} />;
}

/** Before 418: a locked display case with the badges' outlines behind the glass, and a hint. */
function LockedCase() {
  return (
    <Card title="Trophy case" subtitle="Locked">
      <div className="locked-case">
        <div className="locked-case-glass" aria-hidden>
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i} className="locked-case-slot" />
          ))}
        </div>
        <div className="locked-case-lock">
          <Icons.lock size={22} />
          <div>
            <b>This case is locked.</b>
            <span>The key is short and stout.</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Presenter-safe mode: for when the screen is on a projector, a TV or shared in a meeting. In every edition. */
function PresentingSettings() {
  const { s, locked, patch } = useSettings();
  const st = useCore('presenter.status', undefined, ['presenter.changed', 'settings.changed']).data;
  const { run, busy } = useAction();
  if (!s) return null;
  const p = s.presenter;
  const L = (k: string) => isLocked(locked, `presenter.${k}`);
  const active = !!st?.active;
  return (
    <Grid cols={2}>
      <div style={{ gridColumn: '1 / -1' }}>
        <Card title="Presenter-safe mode" subtitle="For when your screen is on a projector, a classroom TV or shared in a meeting. Nothing private pops up while it is on.">
          <div className="fx-form">
            <div className="fx-actions">
              <Status tone={active ? 'good' : 'neutral'}>{active ? (st?.reason === 'display' ? 'On: a second screen or projector is connected' : 'On') : st?.externalDisplay && p.auto ? 'Off until the second screen is unplugged' : 'Off'}</Status>
              <span className="fx-spacer" />
              <Button variant={active ? undefined : 'primary'} icon="presentation" loading={busy === 'p'} onClick={() => void run('p', () => call('presenter.set', { on: !active }))}>
                {active ? 'Turn off' : 'Turn on now'}
              </Button>
            </div>
            <Toggle checked={p.auto} disabled={L('auto')} onChange={(v) => void patch({ presenter: { auto: v } })} label="Turn on by itself while a projector or second screen is connected" />
            <Field label={<>Shortcut <Locked show={L('hotkey')} /></>} help="Works anywhere, even while FBRX is in the background. Also in the tray menu, and the top bar shows Presenting while it is on.">
              <KeyRecorder value={p.hotkey} allowOff disabled={L('hotkey')} onChange={(v) => void patch({ presenter: { hotkey: v } })} />
            </Field>
          </div>
        </Card>
      </div>
      <Card title="While presenting">
        <div className="fx-form">
          <Toggle checked={p.hideNotifications} disabled={L('hideNotifications')} onChange={(v) => void patch({ presenter: { hideNotifications: v } })} label="Keep notifications quiet (urgent ones only say that something needs a look)" />
          <Toggle checked={p.maskClipboard} disabled={L('maskClipboard')} onChange={(v) => void patch({ presenter: { maskClipboard: v } })} label="Show clipboard history as dots" />
          <Toggle checked={p.blurPrivate} disabled={L('blurPrivate')} onChange={(v) => void patch({ presenter: { blurPrivate: v } })} label="Blur chat history, alerts, credentials and help desk tickets" />
          <p className="fx-muted" style={{ margin: 0, fontSize: 12.5 }}>The Silly Goose stays home and approvals wait quietly in the top bar.</p>
        </div>
      </Card>
      <Card title="Good to know">
        <ul className="fx-muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
          <li>Turn it on before you share your screen in a video call; FBRX cannot tell when a call app is sharing.</li>
          <li>Mirrored displays can look like one screen to the computer, so the automatic switch may not notice them. The shortcut always works.</li>
          <li>Your organization can turn the automatic switch on for every staff computer.</li>
        </ul>
      </Card>
    </Grid>
  );
}

function MessagesSettings() {
  const { s, locked, patch } = useSettings();
  const fleet = useCore('fleet.status', undefined, ['fleet.changed']).data;
  const home = useVertical() === 'home';
  if (!s) return null;
  const m = s.messages;
  const L = (k: string) => isLocked(locked, `messages.${k}`);
  const org = fleet && fleet.state !== 'unenrolled' ? (fleet.tenantName ?? (home ? 'your family' : 'your organization')) : null;
  return (
    <Grid cols={2}>
      <Card title="Messages" subtitle="Chat with your other computers and your phone, and with the other computers in your organization or family.">
        <div className="fx-form">
          <Toggle
            checked={m.enabled}
            disabled={L('enabled')}
            onChange={(v) => void patch({ messages: { enabled: v } })}
            label={<>Messages <Locked show={L('enabled')} /></>}
            info="Shows Messages in the sidebar. Off hides it, and other devices are told this computer does not take messages."
          />
          <Toggle
            checked={m.organization}
            disabled={!m.enabled || L('organization')}
            onChange={(v) => void patch({ messages: { organization: v } })}
            label={<>Chat with {org ?? 'your organization'} <Locked show={L('organization')} /></>}
            info="Message any computer in the organization, or everyone at once. FBRX Command passes these on and keeps them for 180 days. Off keeps Messages to your own mesh."
          />
          <Toggle checked={m.notify} disabled={!m.enabled || L('notify')} onChange={(v) => void patch({ messages: { notify: v } })} label={<>Notify me about new messages <Locked show={L('notify')} /></>} info="A pop-up when a message arrives, except for the conversation you have open. Presenter-safe mode keeps them quiet too." />
        </div>
      </Card>
      {org && (
        <Card title="Help desk" subtitle="When you send a ticket, the help desk can work on this computer from it: check how it is doing, ask the AI here, and run commands.">
          <div className="fx-form">
            <Field label={<>Let the help desk in <Locked show={isLocked(locked, 'helpdesk.assist')} /></>} help="Commands always ask you first when you choose Ask me.">
              <Select
                value={s.helpdesk.assist}
                disabled={isLocked(locked, 'helpdesk.assist')}
                onChange={(e) => void patch({ helpdesk: { assist: e.target.value as Settings['helpdesk']['assist'] } })}
                options={[
                  { value: 'ask', label: 'Ask me once per ticket' },
                  { value: 'allow', label: 'Without asking (the policy still applies to commands)' },
                  { value: 'off', label: 'Never' },
                ]}
              />
            </Field>
          </div>
        </Card>
      )}
      <Card title="Good to know">
        <ul className="fx-muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
          <li>Messages between your own devices go straight between them over FBRX Mesh, encrypted end to end.</li>
          <li>A computer that is switched off gets mesh messages when it is back (for up to a week); organization messages wait in FBRX Command.</li>
          <li>{org ? `${org} can turn messages off for some computers (classrooms, say).` : 'Join an organization’s FBRX Command and its computers show up in Messages too.'}</li>
        </ul>
      </Card>
    </Grid>
  );
}

const RESOURCE_HELP = {
  light: 'A quarter of the processor at the lowest priority: slower answers, and the PC stays smooth while it thinks.',
  balanced: 'Half the processor at below-normal priority: good answers without the PC stuttering. Recommended.',
  full: 'Every core but one at normal priority: fastest answers, but other apps may slow down while it thinks.',
} as const;

function AgentSettings() {
  const { s, locked, patch } = useSettings();
  const [name, setName] = useState<string | null>(null);
  const ultra = useAtLeast('ultra');
  // Unloading the local model when idle comes with Standard (Thinking, in every edition, is a card of its own).
  const standard = useAtLeast('basic');
  if (!s) return null;
  const L = (p: string) => isLocked(locked, p);
  return (
    <Grid cols={2}>
      <Card title="Your agent">
        <div className="fx-form">
          <Field label={<>Name <Locked show={L('ai.agentName')} /></>} help="Used throughout FBRX and in how the agent introduces itself">
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
          <Field label={<>How hard a local model may work this PC <Locked show={L('ai.resources')} /></>} help={RESOURCE_HELP[s.ai.resources]}>
            <div className="seg" role="group" aria-label="Local AI resources">
              {(['light', 'balanced', 'full'] as const).map((r) => (
                <button key={r} className={s.ai.resources === r ? 'on' : ''} disabled={L('ai.resources')} onClick={() => void patch({ ai: { resources: r } })}>
                  {r === 'light' ? 'Light' : r === 'balanced' ? 'Balanced' : 'Full speed'}
                </button>
              ))}
            </div>
          </Field>
          {standard && <Field label={<>Unload the local model when idle <Locked show={L('runtime.idleStopMinutes')} /></>} help="Gives its memory back to the computer; it loads again with the next question (a few seconds).">
            <Select
              value={String(s.runtime.idleStopMinutes)}
              disabled={L('runtime.idleStopMinutes')}
              onChange={(e) => void patch({ runtime: { idleStopMinutes: Number(e.target.value) } })}
              options={[
                { value: '5', label: 'After 5 minutes' },
                { value: '20', label: 'After 20 minutes' },
                { value: '60', label: 'After an hour' },
                { value: '0', label: 'Never (keep it loaded)' },
              ]}
            />
          </Field>}
        </div>
      </Card>
      <div style={{ gridColumn: '1 / -1' }}>
        <Thinking />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <Creations />
      </div>
      <Card title={ultra ? 'Models and permissions' : 'AI model'}>
        <div className="fx-form">
          <p className="fx-muted" style={{ margin: 0 }}>{ultra ? <>Choose which AI model {s.ai.agentName} uses in AI models, and what it may do without asking in Governance.</> : <>Choose which AI model {s.ai.agentName} uses. {s.ai.agentName} always asks before it changes anything on this computer.</>}</p>
          <div className="fx-actions">
            <Button onClick={() => (location.hash = '#/runtime')}>AI models</Button>
            {ultra && <Button onClick={() => (location.hash = '#/governance')}>Governance</Button>}
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

const IMAGE_GENERATOR_NAMES: Record<ImageGenerator, string> = { draw: 'The agent draws them (vector art, works offline)', 'images-api': 'An AI provider’s images endpoint', txt2img: 'A local image server (txt2img)' };
const IMAGE_SIZE_NAMES: Record<ImageSize, string> = { '1024x1024': 'Square (1024 × 1024)', '1536x1024': 'Wide (1536 × 1024)', '1024x1536': 'Tall (1024 × 1536)' };

/** What the agent makes and reads: where its files go, how it makes pictures, where it searches. */
function Creations() {
  const { s, locked, patch } = useSettings();
  const folder = useCore('ai.files.folder', undefined, ['settings.changed', 'policy.changed']).data;
  const [url, setUrl] = useState<{ images?: string; search?: string; model?: string }>({});
  if (!s) return null;
  const L = (p: string) => isLocked(locked, p);
  const img = s.ai.images;
  const providers = s.ai.providers.filter((p) => p.type === 'openai' || p.type === 'openai-compatible');
  const pick = async () => {
    const dir = await bridge.dialog?.({ kind: 'folder', title: `Where ${s.ai.agentName} saves what it makes`, defaultPath: folder?.path });
    if (dir) await patch({ ai: { outputFolder: dir } });
  };
  return (
    <Card title="Files, pictures and the web" subtitle={`${s.ai.agentName} writes documents (PDF, .docx, web pages, Markdown, text, CSV), draws or makes pictures, reads web pages and looks up stock quotes. What it makes appears in the chat with an Open button.`}>
      <div className="fx-form">
        <Field label={<>Saved in <Locked show={L('ai.outputFolder')} /></>} help={folder && !folder.allowed ? `${s.ai.agentName} may not write in ${folder.chosen} (the folders it may use are set in Governance), so it saves in FBRX’s workspace instead.` : 'A new file never replaces one already there.'}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
            <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={folder?.path}>
              {folder?.path ?? '…'}
            </code>
            {bridge.dialog && (
              <Button size="sm" disabled={L('ai.outputFolder')} onClick={() => void pick()}>
                Change…
              </Button>
            )}
            {folder && bridge.reveal && (
              <Button size="sm" variant="ghost" icon="folder" onClick={() => void bridge.reveal?.(folder.path)}>
                Show
              </Button>
            )}
          </div>
        </Field>
        <Field label={<>Pictures from a description <Locked show={L('ai.images')} /></>} help={img.generator === 'draw' ? `${s.ai.agentName} draws illustrations, icons, logos, charts and diagrams itself. For photo-like pictures, choose a picture maker.` : 'The description goes to the picture maker; the picture is saved as PNG.'}>
          <Select value={img.generator} disabled={L('ai.images')} options={IMAGE_GENERATORS.map((g) => ({ value: g, label: IMAGE_GENERATOR_NAMES[g] }))} onChange={(e) => void patch({ ai: { images: { generator: e.target.value as ImageGenerator } } })} />
        </Field>
        {img.generator === 'images-api' && (
          <Grid cols={2}>
            <Field label="AI provider" help={providers.length ? 'Its address and key are used (AI models).' : 'Add an OpenAI-compatible provider in AI models first.'}>
              <Select value={img.providerId} disabled={L('ai.images')} options={[{ value: '', label: 'Choose…' }, ...providers.map((p) => ({ value: p.id, label: p.name }))]} onChange={(e) => void patch({ ai: { images: { providerId: e.target.value } } })} />
            </Field>
            <Field label="Model" help="The provider’s picture model">
              <Input value={url.model ?? img.model} placeholder="gpt-image-1" disabled={L('ai.images')} onChange={(e) => setUrl({ ...url, model: e.target.value })} onBlur={() => url.model !== undefined && void patch({ ai: { images: { model: url.model.trim() } } })} />
            </Field>
          </Grid>
        )}
        {img.generator === 'txt2img' && (
          <Field label="Image server’s address" help="A picture server on this computer or your network that offers the txt2img API (/sdapi/v1/txt2img).">
            <Input value={url.images ?? img.url} placeholder="http://127.0.0.1:7860" disabled={L('ai.images')} onChange={(e) => setUrl({ ...url, images: e.target.value })} onBlur={() => url.images !== undefined && void patch({ ai: { images: { url: url.images.trim() } } })} />
          </Field>
        )}
        {img.generator !== 'draw' && (
          <Field label="Picture size">
            <Select value={img.size} disabled={L('ai.images')} options={IMAGE_SIZES.map((z) => ({ value: z, label: IMAGE_SIZE_NAMES[z] }))} onChange={(e) => void patch({ ai: { images: { size: e.target.value as ImageSize } } })} />
          </Field>
        )}
        <Field label={<>Web search <Locked show={L('ai.webSearch')} /></>} help={s.ai.webSearch.engine === 'public' ? 'A public search page, no account needed.' : 'Your own SearXNG server, with its JSON format turned on.'}>
          <Select
            value={s.ai.webSearch.engine}
            disabled={L('ai.webSearch')}
            options={[
              { value: 'public', label: 'DuckDuckGo (no account)' },
              { value: 'searxng', label: 'My SearXNG server' },
            ]}
            onChange={(e) => void patch({ ai: { webSearch: { engine: e.target.value as WebSearchEngine } } })}
          />
        </Field>
        {s.ai.webSearch.engine === 'searxng' && (
          <Field label="SearXNG server’s address">
            <Input value={url.search ?? s.ai.webSearch.url} placeholder="http://searxng.lan:8080" disabled={L('ai.webSearch')} onChange={(e) => setUrl({ ...url, search: e.target.value })} onBlur={() => url.search !== undefined && void patch({ ai: { webSearch: { url: url.search.trim() } } })} />
          </Field>
        )}
      </div>
    </Card>
  );
}

const THINKING_HELP: Record<ThinkingLevel, string> = {
  quick: `Small jobs and quick answers: up to ${THINKING_BUDGETS.quick.steps} steps a task, so it checks in with you sooner.`,
  everyday: `Everyday tasks: up to ${THINKING_BUDGETS.everyday.steps} steps a task. Recommended.`,
  thorough: `Big jobs and long documents: up to ${THINKING_BUDGETS.thorough.steps} steps a task (the most there is), and a local model keeps twice as much in mind (about 1 GB more memory).`,
};

/**
 * How much the agent does on one task. Every edition picks a level (Quick, Everyday or Thorough); from Standard up,
 * each part is also set on its own, which makes the level Custom.
 */
function Thinking() {
  const { s, locked, patch } = useSettings();
  const pol = useCore('governance.policy', undefined, ['policy.changed']);
  const standard = useAtLeast('basic');
  const { run, busy } = useAction();
  if (!s || !pol.data) return null;
  const L = (p: string) => isLocked(locked, p);
  const name = s.ai.agentName;
  // An organization that sets any part of it sets the level too.
  const managed = pol.data.source === 'managed' || THINKING_SETTINGS.some(L);
  const level = thinkingLevelOf(thinkingBudget(pol.data.policy, s));
  return (
    <Card title="Thinking" subtitle={`How much ${name} may do on one task, and how much of the conversation it keeps in mind.`}>
      <div className="fx-form">
        <Field label={<>How much {name} does on one task <Locked show={managed} /></>} help={level === 'custom' ? 'Custom: set part by part below. Pick a level to go back to one.' : THINKING_HELP[level]}>
          <div className="seg" role="group" aria-label={`How much ${name} does on one task`}>
            {THINKING_LEVELS.map((l) => (
              <button key={l} className={level === l ? 'on' : ''} disabled={managed || !!busy} onClick={() => void run(l, () => call('ai.setThinking', { level: l }), `Thinking: ${THINKING_NAMES[l]}, up to ${THINKING_BUDGETS[l].steps} steps a task`)}>
                {THINKING_NAMES[l]}
              </button>
            ))}
          </div>
        </Field>
        {standard ? (
          <WorkBudget policy={pol.data} />
        ) : (
          <EditionHint tier="basic">Standard sets each part on its own: steps per task, the longest answer, and how much a local model keeps in mind.</EditionHint>
        )}
        <Toggle checked={s.ai.showThinking} disabled={L('ai.showThinking')} onChange={(v) => void patch({ ai: { showThinking: v } })} label={`Show what ${name} is thinking and doing while it works`} />
      </div>
    </Card>
  );
}

const ANSWER_LENGTHS = [
  { value: '0', label: 'Automatic (the model decides)' },
  { value: '2048', label: 'Short (2,000 tokens, about 1,500 words)' },
  { value: '8192', label: 'Standard (8,000 tokens)' },
  { value: '16384', label: 'Long (16,000 tokens)' },
  { value: '32768', label: 'Very long (32,000 tokens)' },
  { value: '65536', label: 'Huge (64,000 tokens)' },
];
const CONTEXTS = [4096, 8192, 16384, 32768, 65536, 131072];
const ctxLabel = (n: number) => `${n / 1024}K tokens${n === 8192 ? ' (default)' : ''}`;
// Rough extra memory for the conversation itself (the KV cache of a typical 7–8B model).
const ctxMemory = (n: number) => (n <= 8192 ? 'about 1 GB extra memory' : n <= 16384 ? 'about 2 GB' : n <= 32768 ? 'about 4 GB' : n <= 65536 ? 'about 8 GB' : 'about 16 GB');

/** Each part of the work budget on its own (Standard and up): steps, answer length, what a model keeps in mind. */
function WorkBudget({ policy }: { policy: EffectivePolicy }) {
  const { s, locked, patch } = useSettings();
  const providers = useCore('ai.providers', undefined, ['settings.changed']);
  const [moving, setMoving] = useState<number | null>(null);
  const { run } = useAction();
  if (!s) return null;
  const L = (p: string) => isLocked(locked, p);
  const policyManaged = policy.source === 'managed';
  const steps = policy.policy.ai.maxStepsPerRun;
  const shownSteps = moving ?? steps;
  const saveSteps = (n: number) => {
    if (n === steps) return;
    void run('steps', () => call('governance.updatePolicy', { policy: withSteps(policy.policy, n) }), `${s.ai.agentName} may now take up to ${n} steps per task`).then(() => setMoving(null));
  };
  const hasOllama = (providers.data ?? []).some((p) => p.type === 'ollama' && p.enabled);
  return (
    <div className="budget-grid">
      <Field
        label={
          <>
            Steps per task <span className="budget-value">{shownSteps}</span> <Locked show={policyManaged} />
          </>
        }
        help={`A step is one round of thinking and using tools. When ${s.ai.agentName} runs out, it says so and you can tell it to continue.`}
      >
        <input
          type="range"
          min={5}
          max={MAX_STEPS_PER_TASK}
          step={1}
          value={shownSteps}
          disabled={policyManaged}
          aria-label="Steps per task"
          onChange={(e) => setMoving(Number(e.target.value))}
          onPointerUp={() => moving !== null && saveSteps(moving)}
          onKeyUp={() => moving !== null && saveSteps(moving)}
        />
      </Field>
      <Field label={<>Longest answer <Locked show={L('ai.maxOutputTokens')} /></>} help="The most the model may write in one reply. Long code or reports need more; a token is about three quarters of a word.">
        <Select value={String(s.ai.maxOutputTokens)} disabled={L('ai.maxOutputTokens')} onChange={(e) => void patch({ ai: { maxOutputTokens: Number(e.target.value) } })} options={ANSWER_LENGTHS} />
      </Field>
      <Field
        label={<>Memory of the built-in model <Locked show={L('runtime.contextSize')} /></>}
        help={`How much of the conversation (including tool results) the built-in model keeps in mind. More lets it work on bigger tasks but uses ${ctxMemory(s.runtime.contextSize)}. The model reloads to apply it.`}
      >
        <Select
          value={String(s.runtime.contextSize)}
          disabled={L('runtime.contextSize')}
          onChange={(e) => void patch({ runtime: { contextSize: Number(e.target.value) } })}
          options={[...new Set([...CONTEXTS, s.runtime.contextSize])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: ctxLabel(n) }))}
        />
      </Field>
      {hasOllama && (
        <Field label={<>Memory of Ollama models <Locked show={L('ai.ollamaContext')} /></>} help="Ollama's own setting is often 4K, which a long task fills quickly. 32K suits most tool-using work on a 16 GB computer.">
          <Select
            value={String(s.ai.ollamaContext)}
            disabled={L('ai.ollamaContext')}
            onChange={(e) => void patch({ ai: { ollamaContext: Number(e.target.value) } })}
            options={[{ value: '0', label: "Ollama's setting" }, ...CONTEXTS.map((n) => ({ value: String(n), label: `${n / 1024}K tokens` }))]}
          />
        </Field>
      )}
    </div>
  );
}

function SpotlightSettings() {
  const { s, patch } = useSettings();
  if (!s) return null;
  return (
    <Card title="Spotlight" subtitle="One search box for apps, files, settings, commands, calculations and quick answers, from anywhere">
      <div className="fx-form">
        <Toggle checked={s.spotlight.enabled} onChange={(v) => void patch({ spotlight: { enabled: v } })} label="Turn on Spotlight" />
        <Field label="Keyboard shortcut (a macro)" help="Click it and press the new keys, for example Alt+Space or Ctrl+Shift+F. Inside FBRX, Ctrl+K also opens it. All shortcuts are in Settings → Macros.">
          <KeyRecorder value={s.spotlight.hotkey} disabled={!s.spotlight.enabled} onChange={(v) => void patch({ spotlight: { hotkey: v } })} />
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

/** Settings → Browser: FBRX Browser's home page, search, privacy, Fabrix, and the sites blocked on this computer. */
function BrowserSettings() {
  const { s, locked, patch } = useSettings();
  const { data: b } = useCore('browser.state', undefined, ['browser.changed', 'settings.changed']);
  const [block, setBlock] = useState('');
  const { run, busy } = useAction();
  if (!s || !b) return null;
  const br = s.browser;
  const lock = (path: string) => isLocked(locked, `browser.${path}`);
  const org = b.policy;
  return (
    <>
      <Card title="Browser" subtitle="FBRX Browser opens in its own window, from the sidebar or the tray." actions={<Button size="sm" icon="globe" onClick={() => navigate('browser')}>Open it</Button>}>
        <div className="fx-form">
          <Field label="Home page" help="Where the home button goes. Empty: the FBRX start page.">
            <Input value={br.homepage} disabled={lock('homepage')} placeholder="https://" onChange={(e) => void patch({ browser: { homepage: e.target.value.trim() } })} />
          </Field>
          <Field label="Search with">
            <Select
              value={br.searchEngine}
              disabled={lock('searchEngine')}
              onChange={(e) => void patch({ browser: { searchEngine: e.target.value as typeof br.searchEngine } })}
              options={Object.entries(BROWSER_SEARCH_ENGINES).map(([value, e]) => ({ value, label: e.name }))}
            />
          </Field>
          <Toggle checked={br.doNotTrack} disabled={lock('doNotTrack')} onChange={(v) => void patch({ browser: { doNotTrack: v } })} label="Ask sites not to track me (Do Not Track and Global Privacy Control)" />
          <Toggle checked={br.privateByDefault} disabled={lock('privateByDefault')} onChange={(v) => void patch({ browser: { privateByDefault: v } })} label="Open new tabs as private tabs (nothing is kept once they close)" />
          <Toggle checked={br.aiAssist} disabled={lock('aiAssist')} onChange={(v) => void patch({ browser: { aiAssist: v } })} label="Let Fabrix read the page when I ask about it (on this computer only)" />
        </div>
      </Card>
      <Card title="Blocked sites" subtitle="Sites that never open in FBRX Browser on this computer, with their subdomains.">
        <form
          className="fx-actions"
          onSubmit={(e) => {
            e.preventDefault();
            void run('add', () => call('browser.addBlocked', { host: block }).then(() => setBlock('')));
          }}
        >
          <Input value={block} placeholder="example.com" onChange={(e) => setBlock(e.target.value)} />
          <Button type="submit" size="sm" loading={busy === 'add'} disabled={!block.trim()}>
            Block
          </Button>
        </form>
        {b.blockedByMe.length > 0 && (
          <div className="fx-form" style={{ marginTop: 10 }}>
            {b.blockedByMe.map((h) => (
              <div key={h} className="account-org">
                <span className="mono">{h}</span>
                <Button size="sm" variant="ghost" onClick={() => void run(h, () => call('browser.removeBlocked', { host: h }))}>
                  Unblock
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
      {(org.managed || org.safeBrowsing) && (
        <Card title="Set by your organization" subtitle="These come from FBRX Command and apply to every page, not only what is typed.">
          <KeyValue
            items={[
              ['Only these sites', org.allowed.length ? org.allowed.join(', ') : 'Any site'],
              ['Blocked', br.blocked.length ? br.blocked.join(', ') : 'None'],
              ['Safe browsing', org.safeBrowsing ? 'On: strict SafeSearch on Google, Bing, DuckDuckGo and Brave, and YouTube Restricted Mode' : 'Off'],
            ]}
          />
        </Card>
      )}
      <Card title="History">
        <Button size="sm" variant="danger" loading={busy === 'clear'} onClick={() => void run('clear', () => call('browser.clearHistory', {}), 'Browsing history cleared')}>
          Clear browsing history
        </Button>
      </Card>
    </>
  );
}

function Updates() {
  const { data: u } = useCore('updates.status', undefined, ['updates.changed']);
  const { s, locked, patch } = useSettings();
  const ultra = useAtLeast('ultra');
  const { run, busy } = useAction();
  if (!u || !s) return null;
  const release = (
    <ReleasePanel
      checkRepo={s.updates.checkRepo}
      locked={isLocked(locked, 'updates.checkRepo')}
      onToggle={(v) => void patch({ updates: { checkRepo: v } })}
      autoInstall={{ on: s.updates.autoInstall, locked: isLocked(locked, 'updates.autoInstall'), onChange: (v) => void patch({ updates: { autoInstall: v } }) }}
    />
  );
  // Updates pushed by an organization's update server, when this computer has one.
  if (u.state === 'unsupported') return release;
  return (
    <>
    {release}
    <Grid cols={2}>
      <Card title="Updates from your organization">
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
            <Button icon="refresh" loading={busy === 'c'} onClick={() => void run('c', () => call('updates.check'))}>
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
          {ultra && <Field label="Channel">
            <Select value={s.updates.channel} disabled={isLocked(locked, 'updates.channel')} onChange={(e) => void patch({ updates: { channel: e.target.value as Settings['updates']['channel'] } })} options={[...UPDATE_CHANNELS]} />
          </Field>}
          <Toggle checked={s.updates.autoDownload} disabled={isLocked(locked, 'updates.autoDownload')} onChange={(v) => void patch({ updates: { autoDownload: v } })} label="Download updates automatically" />
          <Toggle checked={s.updates.autoInstall} disabled={isLocked(locked, 'updates.autoInstall')} onChange={(v) => void patch({ updates: { autoInstall: v } })} label="Install automatically (restarts the app)" />
        </div>
      </Card>
    </Grid>
    </>
  );
}

function License() {
  const { data: l } = useCore('license.status', undefined, ['license.changed']);
  const { data: support } = useCore('support.status', undefined, ['support.changed']);
  const { s, patch } = useSettings();
  const [key, setKey] = useState('');
  // When the support phrase is typed, the box turns into a support-pass prompt.
  const [awaitingPass, setAwaitingPass] = useState(false);
  const { run, busy } = useAction();
  const toast = useToast();
  if (!l || !s) return null;
  const activate = () => {
    const trimmed = key.trim();
    // Support mode (troubleshooting): the phrase asks for a signed pass; the resume phrase, or a pass, acts at once.
    if (trimmed.toLowerCase() === SUPPORT_ENTER_PHRASE) {
      setKey('');
      setAwaitingPass(true);
      return;
    }
    if (trimmed.toLowerCase() === SUPPORT_EXIT_PHRASE) {
      setKey('');
      setAwaitingPass(false);
      if (support?.active) void run('a', () => call('support.end'), 'Support mode ended');
      return;
    }
    if (trimmed.startsWith(`${SUPPORT_PASS_PREFIX}.`)) {
      void run('a', () =>
        call('support.activate', { pass: trimmed }).then((st) => {
          setKey('');
          setAwaitingPass(false);
          toast.success('Support mode on', `This computer runs as ${TIER_NAMES[(st as { tier: Tier }).tier ?? 'blackhole']} until the pass runs out. Type "${SUPPORT_EXIT_PHRASE}" to end it.`);
        }),
      );
      return;
    }
    // 418: not a license at all, just a teapot. It unlocks the easter eggs, in every edition.
    if (key === '418') {
      setKey('');
      if (s.appearance.funUnlocked && s.appearance.easterEggs) {
        toast.info('Still a teapot', 'Short and stout, and already unlocked.');
        return;
      }
      void patch({ appearance: { funUnlocked: true, easterEggs: true } }).then(() =>
        toast.custom({
          title: '418 I\'m a teapot',
          body: 'Short and stout, and now unlocked: easter eggs, the Silly Goose and the Trophy case. Have fun.',
          icon: <TrophyBadge id="teapot" found size={36} />,
          action: { label: 'Open the trophy case', onClick: () => navigate('settings/trophies') },
        }),
      );
      return;
    }
    void run(
      'a',
      () =>
        call('license.activate', { key }).then((r) => {
          setKey('');
          toast.success(atLeast(r.ceiling ?? r.tier, 'ultra') ? 'License activated: Ultra is there to turn on' : 'License activated', r.message ?? (atLeast(r.ceiling ?? r.tier, 'ultra') ? 'Settings → Edition turns it on.' : undefined));
        }),
    );
  };
  return (
    <Grid cols={2}>
      <Card title="Your license">
        <KeyValue
          items={[
            ['Product', <span className={`tier-badge ${l.tier}`}>{TIER_NAMES[l.tier]}</span>],
            ['License', <span className="fx-badge accent">{l.edition}</span>],
            ['State', <Status tone={l.state === 'valid' || l.state === 'development' ? 'good' : l.state === 'unlicensed' ? 'neutral' : 'warning'}>{l.state}</Status>],
            ['Licensed to', l.customer ?? '—'],
            ['Seats', l.seats === 0 ? 'Unlimited' : l.seats ?? '—'],
            ['Expires', l.expiresAt ? formatDate(l.expiresAt) : l.state === 'valid' ? 'Never' : '—'],
            ['Source', { managed: 'Your organization (FBRX Command)', local: 'License key on this device', account: 'Your FBRX account', development: 'Development build', support: 'Support mode', none: '—' }[l.source]],
            ...(support ? [['Install id', <CopyText value={support.installId} />] as [string, ReactNode]] : []),
            ...(l.commandUrl ? [['FBRX Command', <span className="mono">{l.commandUrl}</span>] as [string, ReactNode]] : []),
            ['Features', l.features.join(', ')],
          ]}
        />
        {l.message && <Callout tone="info">{l.message}</Callout>}
        {support?.active && (
          <Callout tone="warning">
            Support mode is on until {support.until ? formatDate(support.until) : 'the pass runs out'}. This computer runs with full access for troubleshooting. Type “{SUPPORT_EXIT_PHRASE}” below, or{' '}
            <button className="fx-link" onClick={() => void run('a', () => call('support.end'), 'Support mode ended')}>
              end support now
            </button>
            .
          </Callout>
        )}
      </Card>
      <Card
        title={awaitingPass ? 'Enter the support pass' : l.state === 'valid' ? 'Change the license key' : 'Enter a license key'}
        subtitle={
          awaitingPass
            ? 'Paste the support pass FBRX gave you for this computer. It turns on full access for a short while, for troubleshooting.'
            : l.source === 'managed'
              ? 'Computers in an organization receive their license automatically'
              : 'Paste the license key you bought or got from your organization. If it belongs to an FBRX Command tenant, this computer joins it too.'
        }
      >
        <div className="fx-form">
          <TextArea code rows={4} value={key} onChange={(e) => setKey(e.target.value)} placeholder={awaitingPass ? `${SUPPORT_PASS_PREFIX}.…` : 'FBRX1.…'} />
          <div className="fx-actions">
            <Button variant="primary" loading={busy === 'a'} disabled={!key.trim()} onClick={activate}>
              {awaitingPass ? 'Start support mode' : 'Activate'}
            </Button>
            {awaitingPass && (
              <Button variant="ghost" onClick={() => (setAwaitingPass(false), setKey(''))}>
                Cancel
              </Button>
            )}
            {!awaitingPass && l.source === 'local' && (
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
  const ultra = useAtLeast('ultra');
  const status = useCore('system.status');
  const [info, setInfo] = useState<{ version: string; dataDir: string; packaged: boolean } | null>(null);
  if (!info && bridge.appInfo) void bridge.appInfo().then((x) => x && setInfo(x));
  return (
    <>
      <Card title="About FBRX Endpoint">
        {status.data && <AboutVersion version={status.data.version} />}
        <KeyValue
          items={[
            ['Version', status.data ? displayVersion(status.data.version) : '…'],
            ...(ultra
              ? ([
                  ['Shell', status.data?.shell],
                  ['Data folder', <span className="mono">{status.data?.dataDir}</span>],
                  ['Build', info ? (info.packaged ? 'Release' : 'Development') : '—'],
                ] as Array<[string, ReactNode]>)
              : []),
            ['Started', formatDate(status.data?.startedAt)],
          ]}
        />
        <p className="fx-muted" style={{ margin: '10px 0 0', fontSize: 12.5, fontStyle: 'italic' }}>Woven from thread, coffee and one very determined goose.</p>
      </Card>
      {ultra && <LogTail />}
    </>
  );
}

function LogTail() {
  const [level, setLevel] = useState<'debug' | 'info' | 'warn' | 'error'>('info');
  const logs = useCore('logs.tail', { lines: 300, level }, [], 5000);
  return (
    <Card
      title="Logs"
      actions={
        <>
          <AskButton label="Analyze these logs" prompt="These are the recent FBRX log lines from my PC. Tell me whether anything is wrong, what the warnings and errors mean, and what to do about them." context={(logs.data ?? []).slice(-150).map((l) => `${l.ts} ${l.level} [${l.scope}] ${l.message}${l.data ? ` ${JSON.stringify(l.data)}` : ''}`).join('\n')} />
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
  );
}

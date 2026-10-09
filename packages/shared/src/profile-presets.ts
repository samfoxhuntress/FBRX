/**
 * The settings an organization usually sets for its computers, in words, and ready-made bundles of them ("No Fun
 * Extras", "Private by default"…). FBRX Command's profile editor shows these as switches and lists; anything else
 * still goes in as JSON. Paths are dotted paths into Settings (see settings.ts).
 */
import { UPDATE_CHANNELS } from './constants';
import { getPath } from './json';

export type ProfileArea = 'ai' | 'fun' | 'privacy' | 'mesh' | 'backup' | 'protection' | 'updates' | 'presenter' | 'everyday';

export const PROFILE_AREAS: Array<{ id: ProfileArea; label: string }> = [
  { id: 'ai', label: 'AI' },
  { id: 'fun', label: 'Fun and look' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'presenter', label: 'Screens and meetings' },
  { id: 'mesh', label: 'Mesh and phone' },
  { id: 'backup', label: 'Backups' },
  { id: 'protection', label: 'Protection' },
  { id: 'updates', label: 'Updates' },
  { id: 'everyday', label: 'Everyday' },
];

export interface ProfileSetting {
  path: string;
  label: string;
  /** What it does, for the (i) beside it. */
  help: string;
  area: ProfileArea;
  kind: 'toggle' | 'select' | 'number' | 'text';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  unit?: string;
}

const MODES = [
  { value: 'off', label: 'Never' },
  { value: 'ask', label: 'Ask the person first' },
  { value: 'auto', label: 'Automatically (policy still applies)' },
];

export const PROFILE_SETTINGS: ProfileSetting[] = [
  // AI
  {
    path: 'ai.defaultProvider',
    area: 'ai',
    kind: 'select',
    label: 'Where the AI runs',
    help: 'The AI service the agent uses unless someone picks another. On the computer keeps every word on the computer; cloud services need an API key (Secrets) and send the conversation to that company.',
    options: [
      { value: 'local', label: 'On the computer (FBRX Local Runtime)' },
      { value: 'ollama', label: 'On the computer (Ollama)' },
      { value: 'anthropic', label: 'Cloud: Anthropic' },
      { value: 'openai', label: 'Cloud: OpenAI' },
    ],
  },
  { path: 'ai.newChatsOffline', area: 'ai', kind: 'toggle', label: 'New chats start offline', help: 'A new chat cannot reach the internet until the person allows it, the first time a tool needs it.' },
  {
    path: 'ai.resources',
    area: 'ai',
    kind: 'select',
    label: 'How much of the computer local AI may use',
    help: 'For AI that runs on the computer. Light keeps the computer quick for other work; full answers fastest.',
    options: [
      { value: 'light', label: 'Light (a quarter, lowest priority)' },
      { value: 'balanced', label: 'Balanced (half)' },
      { value: 'full', label: 'Full (all but one core)' },
    ],
  },
  { path: 'ai.showThinking', area: 'ai', kind: 'toggle', label: 'Show what the agent is doing', help: 'Shows the agent’s steps and reasoning while it works, so people see why it does what it does.' },
  { path: 'ai.agentName', area: 'ai', kind: 'text', label: 'The agent’s name', help: 'What the agent is called throughout the app (Fabrix unless you change it).' },
  // Fun and look
  { path: 'appearance.easterEggs', area: 'fun', kind: 'toggle', label: 'Easter eggs, jokes and the goose', help: 'Hidden extras, jokes from the agent, trophies and the Silly Goose. Off keeps work strictly work.' },
  { path: 'appearance.gooseVisits', area: 'fun', kind: 'toggle', label: 'The goose drops by on its own', help: 'Now and then the Silly Goose walks across the screen without being asked.' },
  { path: 'appearance.splash', area: 'fun', kind: 'toggle', label: 'Start-up animation', help: 'The FBRX logo is stitched in when the app opens.' },
  { path: 'appearance.splashSound', area: 'fun', kind: 'toggle', label: 'Start-up sound', help: 'A short chime when the app opens.' },
  {
    path: 'appearance.effects',
    area: 'fun',
    kind: 'select',
    label: 'Visual effects',
    help: 'Full has glass, glows and animation; Lite is flat and quick, kinder to older or busy computers.',
    options: [
      { value: 'auto', label: 'Automatic (Lite on small computers)' },
      { value: 'full', label: 'Full' },
      { value: 'light', label: 'Lite' },
    ],
  },
  { path: 'appearance.reduceMotion', area: 'fun', kind: 'toggle', label: 'Reduce motion', help: 'Fewer moving parts on screen, for people who find animation distracting or unpleasant.' },
  {
    path: 'general.theme',
    area: 'fun',
    kind: 'select',
    label: 'Light or dark',
    help: 'Follow the computer’s own setting, or always light or dark.',
    options: [
      { value: 'system', label: 'Like the computer' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
  },
  // Privacy
  { path: 'general.telemetry', area: 'privacy', kind: 'toggle', label: 'Anonymous usage statistics', help: 'Counts of which features are used, without content or names, to improve FBRX.' },
  { path: 'clipboard.history', area: 'privacy', kind: 'toggle', label: 'Clipboard history', help: 'Keeps what was copied (in memory only, never on disk) so it can be pasted again later.' },
  { path: 'spotlight.fileSearch', area: 'privacy', kind: 'toggle', label: 'Search finds files', help: 'The search box (Alt+Space) also looks through file names in the person’s folders.' },
  { path: 'localApi.enabled', area: 'privacy', kind: 'toggle', label: 'Local API', help: 'Lets scripts and other apps on the computer talk to FBRX with a token. Off unless you use it.' },
  { path: 'localApi.allowRemote', area: 'privacy', kind: 'toggle', label: 'Local API reachable from the network', help: 'Other computers may reach the Local API (they still need a token). Leave off unless you know you need it.' },
  // Screens and meetings
  { path: 'presenter.auto', area: 'presenter', kind: 'toggle', label: 'Presenter-safe with a projector', help: 'Presenter-safe mode turns on by itself while a second screen or projector is connected.' },
  { path: 'presenter.hideNotifications', area: 'presenter', kind: 'toggle', label: 'Hide notifications when presenting', help: 'No pop-ups while presenter-safe mode is on.' },
  { path: 'presenter.blurPrivate', area: 'presenter', kind: 'toggle', label: 'Blur private lists when presenting', help: 'Chats, alerts, credentials and tickets are blurred while presenter-safe mode is on.' },
  { path: 'presenter.maskClipboard', area: 'presenter', kind: 'toggle', label: 'Mask the clipboard when presenting', help: 'Clipboard history shows dots instead of what was copied while presenter-safe mode is on.' },
  { path: 'alerts.quietHours.enabled', area: 'presenter', kind: 'toggle', label: 'Quiet hours', help: 'Alerts below critical wait until quiet hours end (the times are set on each computer, or in JSON).' },
  // Mesh
  { path: 'mesh.enabled', area: 'mesh', kind: 'toggle', label: 'FBRX Mesh', help: 'Connects the computer to the person’s phone and other FBRX computers. Only paired devices can do anything.' },
  {
    path: 'mesh.incoming',
    area: 'mesh',
    kind: 'select',
    label: 'When another device asks the agent',
    help: 'What happens when a paired device asks this computer’s agent to do something.',
    options: [
      { value: 'ask', label: 'Ask the person first' },
      { value: 'allow', label: 'Go ahead (policy still applies)' },
      { value: 'deny', label: 'Never' },
    ],
  },
  { path: 'mesh.assist.request', area: 'mesh', kind: 'select', label: 'Borrow other computers’ AI', help: 'Whether the agent may hand work to another computer when it gets stuck (Mesh Assist).', options: MODES },
  { path: 'mesh.assist.offer', area: 'mesh', kind: 'select', label: 'Lend this computer’s AI', help: 'Whether other computers may use this computer’s AI for their work (Mesh Assist).', options: MODES },
  // Backups
  { path: 'backup.scheduleEnabled', area: 'backup', kind: 'toggle', label: 'Scheduled backups', help: 'Encrypted snapshots of FBRX’s data on a schedule. They need a passphrase: set backup.passphraseSecret to a secret you add under Secrets.' },
  { path: 'backup.intervalHours', area: 'backup', kind: 'number', label: 'Back up every', help: 'Hours between scheduled snapshots (24 is daily).', min: 1, max: 720, unit: 'hours' },
  { path: 'backup.retention', area: 'backup', kind: 'number', label: 'Keep the last', help: 'Older snapshots are deleted once there are more than this.', min: 1, max: 365, unit: 'snapshots' },
  { path: 'backup.includeModels', area: 'backup', kind: 'toggle', label: 'Include AI models', help: 'Downloaded AI models go into the snapshot too. They are large and can be downloaded again.' },
  // Protection
  { path: 'protection.shield.watchDownloads', area: 'protection', kind: 'toggle', label: 'Check downloads', help: 'FBRX Shield scans new files in the Downloads folder as they arrive.' },
  { path: 'protection.shield.autoQuarantine', area: 'protection', kind: 'toggle', label: 'Quarantine threats by itself', help: 'Threats found are moved to quarantine at once, without waiting for the person.' },
  { path: 'protection.shield.heuristics', area: 'protection', kind: 'toggle', label: 'Catch suspicious files', help: 'Also flags files that look like malware but are not on any list yet. A few harmless files may be flagged.' },
  { path: 'protection.shield.updateSignatures', area: 'protection', kind: 'toggle', label: 'Update the threat list', help: 'Downloads the latest list of known threats every day.' },
  {
    path: 'protection.shield.schedule',
    area: 'protection',
    kind: 'select',
    label: 'Scheduled scan',
    help: 'A full scan of the person’s folders on a schedule, when the computer is idle.',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'daily', label: 'Daily' },
      { value: 'weekly', label: 'Weekly' },
    ],
  },
  // Updates
  { path: 'updates.channel', area: 'updates', kind: 'select', label: 'Update channel', help: 'Stable for everyone; beta and dev get new versions sooner and are less tested.', options: UPDATE_CHANNELS.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })) },
  { path: 'updates.autoDownload', area: 'updates', kind: 'toggle', label: 'Download updates by themselves', help: 'New versions download in the background. A group’s Automatic updates setting decides installing.' },
  // Everyday
  { path: 'general.launchAtLogin', area: 'everyday', kind: 'toggle', label: 'Start with the computer', help: 'FBRX opens (in the tray) when the person signs in.' },
  { path: 'general.minimizeToTray', area: 'everyday', kind: 'toggle', label: 'Keep running in the tray', help: 'Closing the window keeps FBRX running in the tray, so alerts and the mesh keep working.' },
  { path: 'voice.readReplies', area: 'everyday', kind: 'toggle', label: 'Read replies aloud', help: 'The agent reads its answers aloud after a spoken question.' },
];

export interface ProfilePreset {
  id: string;
  name: string;
  description: string;
  /** Dotted path → value. */
  values: Record<string, unknown>;
  /** Paths people cannot change on their computer. */
  lock: string[];
}

export const PROFILE_PRESETS: ProfilePreset[] = [
  {
    id: 'no-fun',
    name: 'No Fun Extras',
    description: 'No easter eggs, jokes, goose or start-up sound. Work stays work.',
    values: { 'appearance.easterEggs': false, 'appearance.gooseVisits': false, 'appearance.splashSound': false },
    lock: ['appearance.easterEggs', 'appearance.gooseVisits'],
  },
  {
    id: 'private',
    name: 'Private by default',
    description: 'AI runs on the computer, chats start offline, no usage statistics or clipboard history.',
    values: { 'ai.defaultProvider': 'local', 'ai.newChatsOffline': true, 'general.telemetry': false, 'clipboard.history': false },
    lock: ['ai.defaultProvider', 'general.telemetry'],
  },
  {
    id: 'locked-down',
    name: 'Locked down',
    description: 'No mesh, no Local API, no sharing AI: for shared, public or kiosk computers.',
    values: { 'mesh.enabled': false, 'localApi.enabled': false, 'localApi.allowRemote': false, 'mesh.assist.request': 'off', 'mesh.assist.offer': 'off' },
    lock: ['mesh.enabled', 'localApi.enabled', 'localApi.allowRemote', 'mesh.assist.request', 'mesh.assist.offer'],
  },
  {
    id: 'strong-protection',
    name: 'Strong protection',
    description: 'FBRX Shield checks downloads, quarantines threats by itself and scans every day.',
    values: { 'protection.shield.watchDownloads': true, 'protection.shield.autoQuarantine': true, 'protection.shield.heuristics': true, 'protection.shield.updateSignatures': true, 'protection.shield.schedule': 'daily' },
    lock: ['protection.shield.watchDownloads', 'protection.shield.autoQuarantine', 'protection.shield.updateSignatures'],
  },
  {
    id: 'nightly-backups',
    name: 'Daily backups',
    description: 'An encrypted snapshot every day, the last 14 kept (add a passphrase secret too).',
    values: { 'backup.scheduleEnabled': true, 'backup.intervalHours': 24, 'backup.retention': 14 },
    lock: ['backup.scheduleEnabled'],
  },
  {
    id: 'meeting-safe',
    name: 'Meeting-room safe',
    description: 'Presenter-safe mode turns on with a projector: no pop-ups, private lists blurred.',
    values: { 'presenter.auto': true, 'presenter.hideNotifications': true, 'presenter.blurPrivate': true, 'presenter.maskClipboard': true },
    lock: [],
  },
  {
    id: 'calm',
    name: 'Calm and quick',
    description: 'Quiet hours, no start-up animation or sound, Lite visuals and less motion.',
    values: { 'alerts.quietHours.enabled': true, 'appearance.splash': false, 'appearance.splashSound': false, 'appearance.effects': 'light', 'appearance.reduceMotion': true },
    lock: [],
  },
  {
    id: 'share-ai',
    name: 'Share AI across computers',
    description: 'Computers lend each other their AI when one gets stuck, looking things up only.',
    values: { 'mesh.enabled': true, 'mesh.assist.request': 'auto', 'mesh.assist.offer': 'auto', 'mesh.assist.tools': 'read' },
    lock: [],
  },
];

// ------------------------------------------------------------------------------------------ dotted paths

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A copy with the value at a dotted path set (getPath reads it); `undefined` removes it, and objects left empty. */
export function setPath(obj: Obj, path: string, value: unknown): Obj {
  const keys = path.split('.');
  const out: Obj = structuredClone(obj);
  const walk = (o: Obj, i: number): void => {
    const k = keys[i];
    if (i === keys.length - 1) {
      if (value === undefined) delete o[k];
      else o[k] = value;
      return;
    }
    if (!isObj(o[k])) {
      if (value === undefined) return;
      o[k] = {};
    }
    walk(o[k] as Obj, i + 1);
    if (value === undefined && Object.keys(o[k] as Obj).length === 0) delete o[k];
  };
  walk(out, 0);
  return out;
}

/** Whether a profile already has everything a preset sets and locks. */
export function presetApplied(p: ProfilePreset, settings: Obj, locked: readonly string[]): boolean {
  return Object.entries(p.values).every(([k, v]) => getPath(settings, k) === v) && p.lock.every((k) => locked.includes(k));
}

/** The profile with a preset added (on) or taken out again (off: its settings go back to each computer's own). */
export function applyPreset(p: ProfilePreset, settings: Obj, locked: readonly string[], on: boolean): { settings: Obj; locked: string[] } {
  let s = settings;
  for (const [k, v] of Object.entries(p.values)) s = setPath(s, k, on ? v : undefined);
  const lock = on ? [...new Set([...locked, ...p.lock])] : locked.filter((k) => !p.lock.includes(k));
  return { settings: s, locked: lock };
}

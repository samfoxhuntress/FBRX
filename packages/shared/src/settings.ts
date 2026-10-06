import { z } from 'zod';
import type { Tier } from './license';
import { DEFAULT_LOCAL_API_PORT, DEFAULT_RUNTIME_PORT, UPDATE_CHANNELS } from './constants';
import { ALERT_CHANNELS } from './ext';
import { PROTECTION_DEFAULT_FEED } from './protection';

/** Built-in color themes (see the desktop theme studio). "fabrics" is the FBRX OS brand look. */
export const THEME_PRESETS = ['fabrics', 'tropical', 'neon', 'ember', 'midnight', 'graphite', 'ocean', 'forest', 'orchid', 'paper', 'contrast'] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];
/** Background textures. "theme" uses each theme's own (weave for Fabrics, palms for Tropical, …). */
export const TEXTURES = ['theme', 'none', 'weave', 'linen', 'grain', 'grid', 'dots', 'carbon', 'waves', 'palms'] as const;
export type Texture = (typeof TEXTURES)[number];
export const AI_RESOURCES = ['light', 'balanced', 'full'] as const;
export type AiResources = (typeof AI_RESOURCES)[number];
export const DEFAULT_MESH_PORT = 47800;

/**
 * Speech recognition models (Whisper, run on this computer). Downloaded once from Hugging Face into the data folder;
 * the .en models only understand English but are faster and more accurate at it.
 */
export const VOICE_MODELS = [
  { id: 'whisper-tiny.en', repo: 'Xenova/whisper-tiny.en', name: 'Fastest', sizeMB: 41, english: true, note: 'Quick on any computer; misses more words' },
  { id: 'whisper-base.en', repo: 'Xenova/whisper-base.en', name: 'Recommended', sizeMB: 78, english: true, note: 'A good balance of speed and accuracy' },
  { id: 'whisper-small.en', repo: 'Xenova/whisper-small.en', name: 'Most accurate', sizeMB: 249, english: true, note: 'Best results; a second or two slower' },
  { id: 'whisper-base', repo: 'Xenova/whisper-base', name: 'Many languages', sizeMB: 78, english: false, note: 'Understands about 100 languages' },
] as const;
export type VoiceModelId = (typeof VOICE_MODELS)[number]['id'];
export const VOICE_MODEL_IDS = VOICE_MODELS.map((m) => m.id) as [VoiceModelId, ...VoiceModelId[]];
/**
 * Natural voices: the Kokoro speech model (Apache-2.0) with its English voices, run on this computer and downloaded
 * once. In settings a natural voice is saved as "natural:<id>" in voice.voiceName.
 */
export const NATURAL_VOICE_PACK = {
  id: 'natural-voices',
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  name: 'Natural voices',
  sizeMB: 107,
  note: 'Lifelike voices made on this computer, British and American',
} as const;
export const NATURAL_PREFIX = 'natural:';
export const NATURAL_VOICES = [
  { id: 'bm_george', name: 'George', accent: 'British', who: 'man', note: 'An older British gentleman: the butler' },
  { id: 'bm_fable', name: 'Fable', accent: 'British', who: 'man', note: 'A warm storyteller' },
  { id: 'bm_lewis', name: 'Lewis', accent: 'British', who: 'man', note: 'Deep and unhurried' },
  { id: 'bm_daniel', name: 'Daniel', accent: 'British', who: 'man', note: 'Crisp and clear' },
  { id: 'bf_emma', name: 'Emma', accent: 'British', who: 'woman', note: 'Polished and friendly' },
  { id: 'bf_isabella', name: 'Isabella', accent: 'British', who: 'woman', note: 'Bright and lively' },
  { id: 'bf_alice', name: 'Alice', accent: 'British', who: 'woman', note: 'Calm and even' },
  { id: 'bf_lily', name: 'Lily', accent: 'British', who: 'woman', note: 'Soft-spoken' },
  { id: 'af_heart', name: 'Heart', accent: 'American', who: 'woman', note: 'Warm and natural' },
  { id: 'af_bella', name: 'Bella', accent: 'American', who: 'woman', note: 'Expressive' },
  { id: 'af_nicole', name: 'Nicole', accent: 'American', who: 'woman', note: 'Hushed, close to the microphone' },
  { id: 'af_sarah', name: 'Sarah', accent: 'American', who: 'woman', note: 'Clear and steady' },
  { id: 'af_aoede', name: 'Aoede', accent: 'American', who: 'woman', note: 'Gentle' },
  { id: 'af_kore', name: 'Kore', accent: 'American', who: 'woman', note: 'Confident' },
  { id: 'af_sky', name: 'Sky', accent: 'American', who: 'woman', note: 'Light and quick' },
  { id: 'am_michael', name: 'Michael', accent: 'American', who: 'man', note: 'Friendly and relaxed' },
  { id: 'am_fenrir', name: 'Fenrir', accent: 'American', who: 'man', note: 'Deep and strong' },
  { id: 'am_puck', name: 'Puck', accent: 'American', who: 'man', note: 'Playful' },
  { id: 'am_adam', name: 'Adam', accent: 'American', who: 'man', note: 'Plain and direct' },
  { id: 'am_eric', name: 'Eric', accent: 'American', who: 'man', note: 'Businesslike' },
  { id: 'am_liam', name: 'Liam', accent: 'American', who: 'man', note: 'Young and easygoing' },
  { id: 'am_onyx', name: 'Onyx', accent: 'American', who: 'man', note: 'Low and smooth' },
] as const;
export type NaturalVoiceId = (typeof NATURAL_VOICES)[number]['id'];
export type VoiceDownloadId = VoiceModelId | typeof NATURAL_VOICE_PACK.id;
export const VOICE_DOWNLOAD_IDS = [...VOICE_MODEL_IDS, NATURAL_VOICE_PACK.id] as [VoiceDownloadId, ...VoiceDownloadId[]];

/** Speaking speed, in words per minute. 180 is an ordinary conversational pace; FBRX starts a little brisker. */
export const VOICE_WPM = { min: 120, max: 360, default: 210 } as const;

export const PROVIDER_TYPES = ['local-runtime', 'ollama', 'openai-compatible', 'openai', 'anthropic'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const ProviderConfigSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/),
  type: z.enum(PROVIDER_TYPES),
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  baseUrl: z.string().url().optional(),
  /** Name of the vault secret holding the API key. Keys never live in settings. */
  apiKeySecret: z.string().optional(),
  defaultModel: z.string().optional(),
  /** True when requests leave the machine. Governed by policy.ai.allowCloudProviders. */
  cloud: z.boolean(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const SettingsSchema = z.object({
  general: z.object({
    deviceName: z.string().max(120),
    theme: z.enum(['system', 'dark', 'light']),
    launchAtLogin: z.boolean(),
    minimizeToTray: z.boolean(),
    telemetry: z.boolean(),
    /** First-run setup finished (travels with backups so a restored machine skips onboarding). */
    onboardingComplete: z.boolean(),
  }),
  ai: z.object({
    defaultProvider: z.string(),
    defaultModel: z.string(),
    systemPrompt: z.string().max(20000),
    temperature: z.number().min(0).max(2),
    providers: z.array(ProviderConfigSchema),
    /** The agent's display name throughout the app. */
    agentName: z.string().min(1).max(40),
    /** New chats start offline: the first internet tool asks permission to go online. */
    newChatsOffline: z.boolean(),
    /**
     * How much of the computer a local model may use: light (a quarter of the processor, lowest priority), balanced
     * (half, below-normal priority) or full (all but one core). Applies to the built-in runtime and to Ollama.
     */
    resources: z.enum(AI_RESOURCES),
    /** Longest answer the model may write in one go, in tokens (0 = the provider's own limit). */
    maxOutputTokens: z.number().int().min(0).max(128000),
    /** Context window for Ollama models, in tokens (0 = Ollama's own setting). The built-in runtime uses runtime.contextSize. */
    ollamaContext: z.number().int().min(0).max(262144),
    /** Show what the agent is thinking and doing while it works. */
    showThinking: z.boolean(),
  }),
  voice: z.object({
    /** Speech recognition model (see VOICE_MODELS). */
    sttModel: z.enum(VOICE_MODEL_IDS),
    /** Microphone device id; empty = the system default. */
    micId: z.string().max(300),
    /** Voice used to read replies aloud: a system voice's name, "natural:<id>" for a natural voice, or empty for the system default. */
    voiceName: z.string().max(300),
    /** Speaking speed in words per minute. */
    wpm: z.number().int().min(VOICE_WPM.min).max(VOICE_WPM.max),
    pitch: z.number().min(0.5).max(1.5),
    /** Read the agent's replies aloud. */
    readReplies: z.boolean(),
    /** Send what you said as soon as it is written down (otherwise it waits in the box for you to check). */
    autoSend: z.boolean(),
    /** Hands-free: listen again after each spoken reply, until you stop. */
    handsFree: z.boolean(),
    /** Say a short "I heard you, looking into it" after a spoken message. */
    acknowledge: z.boolean(),
    /** A soft sound while the agent works on a spoken message. */
    thinkingSound: z.boolean(),
  }),
  appearance: z.object({
    preset: z.enum(THEME_PRESETS),
    /** Custom accent color (#rrggbb), or empty to use the preset's. */
    accent: z.string().regex(/^(#[0-9a-fA-F]{6})?$/),
    density: z.enum(['compact', 'comfortable', 'spacious']),
    fontScale: z.number().min(0.85).max(1.3),
    texture: z.enum(TEXTURES),
    /** How strong the texture is, 0–100 %. Older versions saved subtle / medium / bold. */
    textureStrength: z.preprocess((v) => (typeof v === 'string' ? (({ subtle: 35, medium: 50, bold: 100 }) as Record<string, number>)[v] ?? v : v), z.number().min(0).max(100)),
    radius: z.enum(['sharp', 'rounded', 'soft']),
    reduceMotion: z.boolean(),
    splash: z.boolean(),
    splashSound: z.boolean(),
    /** Easter eggs, jokes and the Silly Goose. An organization can turn them off. */
    easterEggs: z.boolean(),
    /** The Silly Goose drops by now and then on its own. */
    gooseVisits: z.boolean(),
    /** What the goose wears: dressed for the season where you are (auto), or a season you pick. */
    gooseSeason: z.enum(['auto', 'winter', 'spring', 'summer', 'fall']),
    /** Fun extras stay hidden until someone enters 418 as a license key, Ultra or not (see funEnabled). */
    funUnlocked: z.boolean(),
    /** Visual effects: full (glass, glows, animation), light (shown as "Lite": flat and quick) or auto (Lite on small PCs). */
    effects: z.enum(['auto', 'full', 'light']),
  }),
  /**
   * Quick snippets (stored as `macros` for compatibility): type /trigger in the chat, the Terminal, FBRX/1 or the
   * clipboard editor and it pastes. The text may contain {date}, {time}, {datetime}, {name}, {callme}, {host},
   * {clipboard} and {cursor}. Macros in the app's sense are keyboard shortcuts (spotlight.hotkey, clipboard.hotkey).
   */
  macros: z
    .array(
      z.object({
        id: z.string().max(40),
        trigger: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,23}$/),
        description: z.string().max(120),
        text: z.string().max(5000),
        scope: z.enum(['everywhere', 'chat', 'terminal']),
      }),
    )
    .max(200),
  clipboard: z.object({
    /** Keep a history of copied text while FBRX runs (in memory only; never written to disk). */
    history: z.boolean(),
    /** The macro (global keyboard shortcut) that opens the clipboard history anywhere; empty turns it off. */
    hotkey: z.string().max(60),
    /** Paste the copy you pick straight into the app you were in (otherwise it is only put on the clipboard). */
    autoPaste: z.boolean(),
    /** Saved transform pipelines for the clipboard processor. */
    macros: z
      .array(
        z.object({
          id: z.string().max(40),
          name: z.string().min(1).max(60),
          steps: z.array(z.object({ op: z.string().max(40), a: z.string().max(500).optional(), b: z.string().max(500).optional(), flag: z.boolean().optional() })).max(30),
        }),
      )
      .max(100),
  }),
  /**
   * Presenter-safe mode, for when the screen is on a projector or shared in a meeting: notifications stay quiet,
   * clipboard history is masked, private lists (chats, alerts, credentials, tickets) are blurred, and the goose stays home.
   */
  presenter: z.object({
    /** Turned on by hand (Settings, the tray, the top bar or its shortcut). */
    enabled: z.boolean(),
    /** Turns on by itself while a second screen or projector is connected. */
    auto: z.boolean(),
    hideNotifications: z.boolean(),
    maskClipboard: z.boolean(),
    blurPrivate: z.boolean(),
    /** The macro (global keyboard shortcut) that switches it on and off; empty turns it off. */
    hotkey: z.string().max(60),
  }),
  /** Who uses this computer: shown on FBRX Glass and used by the agent. */
  profile: z.object({
    name: z.string().max(60),
    /** What FBRX and the agent call you ("Sam", "Sir"); empty uses the first name. */
    callMe: z.string().max(40),
  }),
  spotlight: z.object({
    enabled: z.boolean(),
    hotkey: z.string().max(60),
    fileSearch: z.boolean(),
    webSearch: z.enum(['google', 'bing', 'duckduckgo']),
  }),
  alerts: z.object({
    rules: z.record(z.string(), z.object({ enabled: z.boolean(), threshold: z.number().nullable() })),
    channels: z.object({
      desktop: z.boolean(),
      mobile: z.boolean(),
      organisation: z.boolean(),
      webhook: z.object({ enabled: z.boolean(), url: z.string(), format: z.enum(['slack', 'teams', 'discord', 'ntfy', 'json']) }),
      email: z.object({
        enabled: z.boolean(),
        host: z.string(),
        port: z.number().int().min(1).max(65535),
        secure: z.boolean(),
        user: z.string(),
        from: z.string(),
        to: z.string(),
        /** Vault secret holding the SMTP password. */
        passwordSecret: z.string(),
      }),
    }),
    routing: z.object({ info: z.array(z.enum(ALERT_CHANNELS)), warning: z.array(z.enum(ALERT_CHANNELS)), critical: z.array(z.enum(ALERT_CHANNELS)) }),
    quietHours: z.object({ enabled: z.boolean(), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }),
    cooldownMinutes: z.number().int().min(1).max(1440),
  }),
  mesh: z.object({
    enabled: z.boolean(),
    port: z.number().int().min(1024).max(65535),
    /** What happens when another device asks this computer's agent to do something. */
    incoming: z.enum(['ask', 'allow', 'deny']),
  }),
  runtime: z.object({
    enabled: z.boolean(),
    autoStart: z.boolean(),
    binaryPath: z.string(),
    modelId: z.string(),
    port: z.number().int().min(1024).max(65535),
    contextSize: z.number().int().min(512).max(262144),
    gpuLayers: z.number().int().min(-1).max(999),
    threads: z.number().int().min(0).max(256),
    /** Stop the runtime after this many idle minutes to give the memory back (0 = keep it loaded); it starts again when needed. */
    idleStopMinutes: z.number().int().min(0).max(1440),
  }),
  localApi: z.object({
    enabled: z.boolean(),
    port: z.number().int().min(1024).max(65535),
    /** Listen on all interfaces (for FBRX peers on the LAN). Tokens are still required. */
    allowRemote: z.boolean(),
  }),
  backup: z.object({
    scheduleEnabled: z.boolean(),
    intervalHours: z.number().int().min(1).max(24 * 30),
    retention: z.number().int().min(1).max(365),
    directory: z.string(),
    includeModels: z.boolean(),
    /** Vault secret that holds the passphrase used for scheduled (unattended) snapshots. */
    passphraseSecret: z.string(),
  }),
  fleet: z.object({
    heartbeatSeconds: z.number().int().min(10).max(3600),
  }),
  updates: z.object({
    channel: z.enum(UPDATE_CHANNELS),
    autoDownload: z.boolean(),
    autoInstall: z.boolean(),
    /** Look for new versions in the FBRX repository and offer them. */
    checkRepo: z.boolean(),
    /** A version the person chose to skip (no more reminders for it). */
    skipVersion: z.string().max(40),
  }),
  /** Calendars (Outlook / Microsoft 365 accounts and calendar links) shown in Calendar, on FBRX Glass and to the agent. */
  calendar: z.object({
    /** Remind this many minutes before a meeting starts (0 = no reminders). */
    remindMinutes: z.number().int().min(0).max(120),
    /** How often to fetch the calendars, in minutes. */
    syncMinutes: z.number().int().min(5).max(240),
    microsoft: z.object({
      /**
       * Application (client) ID of a Microsoft Entra app registration for "Mobile and desktop applications" with the
       * redirect URI http://localhost. Empty uses the one built into this copy of FBRX, if it has one. Organizations
       * set it for every computer from FBRX Command (Configuration → profile settings).
       */
      clientId: z.string().max(80),
      /** "common" (work, school and personal accounts), "organizations", "consumers", or a tenant ID or domain. */
      tenant: z.string().max(120),
      /** Only read calendars: FBRX asks for read access and cannot add events. */
      readOnly: z.boolean(),
    }),
  }),
  /** Antivirus: what protects this computer, and FBRX Shield's own settings. */
  protection: z.object({
    /** "auto", "shield" (FBRX Shield), "defender" (Microsoft Defender) or "product:<id>" (an antivirus found here). */
    provider: z.string().max(80),
    shield: z.object({
      /** Check new files in Downloads and on the desktop as soon as they arrive. */
      watchDownloads: z.boolean(),
      /** Move malware into quarantine straight away (suspicious files are only reported). */
      autoQuarantine: z.boolean(),
      /** Report suspicious files (disguised programs, scripts that download and run code, macros from the internet…). */
      heuristics: z.boolean(),
      /** Keep the threat database (known-malware fingerprints) up to date. */
      updateSignatures: z.boolean(),
      /** Where the threat database comes from: a list of SHA-256 fingerprints, one per line. */
      feedUrl: z.string().max(500),
      /** Endpoint Ultra: a quick scan every day or week. */
      schedule: z.enum(['off', 'daily', 'weekly']),
      /** Endpoint Ultra: also scan with ClamAV when it is installed. */
      useClamAV: z.boolean(),
      /** Endpoint Ultra: ask VirusTotal about suspicious files (needs a VIRUSTOTAL_API_KEY in Credentials). */
      useVirusTotal: z.boolean(),
      /** Folders and files FBRX Shield skips. */
      exclusions: z.array(z.string().max(1000)).max(200),
    }),
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SYSTEM_PROMPT = `You are the built-in operations agent of FBRX OS (the Fabrics Operating System) running on the user's workstation.
You are precise, security-conscious and efficient. Use the tools available to you to inspect and act on the
system when it helps answer the request. Prefer read-only tools before tools that change state. Explain what
you did and why in a short summary. Never reveal secrets, credentials or API keys, even if a tool returns them.`;

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'local', type: 'local-runtime', name: 'FBRX Local Runtime', enabled: true, cloud: false },
  { id: 'ollama', type: 'ollama', name: 'Ollama', enabled: true, baseUrl: 'http://127.0.0.1:11434', cloud: false },
  {
    id: 'anthropic',
    type: 'anthropic',
    name: 'Anthropic Claude',
    enabled: false,
    baseUrl: 'https://api.anthropic.com',
    apiKeySecret: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-5-5',
    cloud: true,
  },
  {
    id: 'openai',
    type: 'openai',
    name: 'OpenAI',
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKeySecret: 'OPENAI_API_KEY',
    cloud: true,
  },
];

export const DEFAULT_SETTINGS: Settings = {
  general: {
    deviceName: '',
    theme: 'dark',
    launchAtLogin: false,
    minimizeToTray: true,
    telemetry: true,
    onboardingComplete: false,
  },
  ai: {
    defaultProvider: 'local',
    defaultModel: '',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    temperature: 0.2,
    providers: DEFAULT_PROVIDERS,
    agentName: 'Fabrix',
    newChatsOffline: true,
    resources: 'balanced',
    maxOutputTokens: 0,
    ollamaContext: 0,
    showThinking: true,
  },
  voice: {
    sttModel: 'whisper-base.en',
    micId: '',
    voiceName: '',
    wpm: VOICE_WPM.default,
    pitch: 1,
    readReplies: false,
    autoSend: true,
    handsFree: false,
    acknowledge: true,
    thinkingSound: true,
  },
  appearance: {
    preset: 'fabrics',
    accent: '',
    density: 'comfortable',
    fontScale: 1,
    texture: 'theme',
    textureStrength: 50,
    radius: 'rounded',
    reduceMotion: false,
    splash: true,
    splashSound: true,
    easterEggs: true,
    gooseVisits: false,
    gooseSeason: 'auto',
    funUnlocked: false,
    effects: 'auto',
  },
  macros: [
    { id: 'm-sig', trigger: 'sig', description: 'Sign off with your name', text: 'Thanks,\n{name}', scope: 'everywhere' },
    { id: 'm-ts', trigger: 'stamp', description: 'Date and time stamp', text: '[{datetime}]', scope: 'everywhere' },
    { id: 'm-flush', trigger: 'flushdns', description: 'Flush DNS and renew the address', text: 'ipconfig /flushdns; ipconfig /release; ipconfig /renew', scope: 'terminal' },
  ],
  clipboard: {
    history: false,
    hotkey: 'Control+Alt+Z',
    autoPaste: true,
    macros: [
      { id: 'c-clean', name: 'Clean up pasted text', steps: [{ op: 'straightQuotes' }, { op: 'collapseSpaces' }, { op: 'trimLines' }, { op: 'removeBlank' }] },
      { id: 'c-ps', name: 'Lines → PowerShell array', steps: [{ op: 'trimLines' }, { op: 'removeBlank' }, { op: 'dedupe' }, { op: 'wrapLines', a: "'", b: "'" }, { op: 'join', a: ', ' }, { op: 'wrap', a: '@(', b: ')' }] },
    ],
  },
  presenter: {
    enabled: false,
    auto: false,
    hideNotifications: true,
    maskClipboard: true,
    blurPrivate: true,
    hotkey: 'Control+Alt+P',
  },
  profile: {
    name: '',
    callMe: '',
  },
  spotlight: {
    enabled: true,
    hotkey: 'Alt+Space',
    fileSearch: true,
    webSearch: 'google',
  },
  alerts: {
    rules: {},
    channels: {
      desktop: true,
      mobile: true,
      organisation: true,
      webhook: { enabled: false, url: '', format: 'slack' },
      email: { enabled: false, host: '', port: 587, secure: false, user: '', from: '', to: '', passwordSecret: 'FBRX_SMTP_PASSWORD' },
    },
    routing: { info: ['inbox'], warning: ['inbox', 'desktop', 'mobile'], critical: ['inbox', 'desktop', 'mobile', 'organisation', 'webhook', 'email'] },
    quietHours: { enabled: false, start: '22:00', end: '07:00' },
    cooldownMinutes: 30,
  },
  mesh: {
    enabled: false,
    port: DEFAULT_MESH_PORT,
    incoming: 'ask',
  },
  runtime: {
    enabled: true,
    autoStart: true,
    binaryPath: '',
    modelId: '',
    port: DEFAULT_RUNTIME_PORT,
    contextSize: 8192,
    gpuLayers: -1,
    threads: 0,
    idleStopMinutes: 20,
  },
  localApi: {
    enabled: true,
    port: DEFAULT_LOCAL_API_PORT,
    allowRemote: false,
  },
  backup: {
    scheduleEnabled: false,
    intervalHours: 24,
    retention: 7,
    directory: '',
    includeModels: false,
    passphraseSecret: 'FBRX_BACKUP_PASSPHRASE',
  },
  fleet: {
    heartbeatSeconds: 30,
  },
  updates: {
    channel: 'stable',
    autoDownload: true,
    autoInstall: false,
    checkRepo: true,
    skipVersion: '',
  },
  calendar: {
    remindMinutes: 10,
    syncMinutes: 15,
    microsoft: { clientId: '', tenant: 'common', readOnly: false },
  },
  protection: {
    provider: 'auto',
    shield: {
      watchDownloads: true,
      autoQuarantine: true,
      heuristics: true,
      updateSignatures: true,
      feedUrl: PROTECTION_DEFAULT_FEED,
      schedule: 'off',
      useClamAV: true,
      useVirusTotal: false,
      exclusions: [],
    },
  },
};

/** Settings paths that can never be changed remotely or by the renderer (identity-bearing). */
export const PROTECTED_SETTING_PATHS: readonly string[] = [];

/**
 * Fun extras live in FBRX Endpoint Ultra, stay hidden until someone enters 418 as a license key, and can be switched
 * off again (an organization can lock them off).
 */
export function funEnabled(s: Pick<Settings, 'appearance'> | null | undefined, tier: Tier | null | undefined): boolean {
  return !!s && tier === 'ultra' && s.appearance.funUnlocked && s.appearance.easterEggs;
}

/** What to call the user: their chosen form of address, else their first name, else null. */
export function addressAs(s: Pick<Settings, 'profile'> | null | undefined): string | null {
  const p = s?.profile;
  if (!p) return null;
  const call = p.callMe.trim();
  if (call) return call;
  const first = p.name.trim().split(/\s+/)[0];
  return first || null;
}

import { z } from 'zod';
import { DEFAULT_LOCAL_API_PORT, DEFAULT_RUNTIME_PORT, UPDATE_CHANNELS } from './constants';
import { ALERT_CHANNELS } from './ext';

/** Built-in color themes (see the desktop theme studio). "fabrics" is the FBRX OS brand look. */
export const THEME_PRESETS = ['fabrics', 'tropical', 'neon', 'ember', 'midnight', 'graphite', 'ocean', 'forest', 'orchid', 'paper', 'contrast'] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];
/** Background textures. "theme" uses each theme's own (weave for Fabrics, palms for Tropical, …). */
export const TEXTURES = ['theme', 'none', 'weave', 'linen', 'grain', 'grid', 'dots', 'carbon', 'waves', 'palms'] as const;
export type Texture = (typeof TEXTURES)[number];
export const DEFAULT_MESH_PORT = 47800;

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
  }),
  appearance: z.object({
    preset: z.enum(THEME_PRESETS),
    /** Custom accent color (#rrggbb), or empty to use the preset's. */
    accent: z.string().regex(/^(#[0-9a-fA-F]{6})?$/),
    density: z.enum(['compact', 'comfortable', 'spacious']),
    fontScale: z.number().min(0.85).max(1.3),
    texture: z.enum(TEXTURES),
    textureStrength: z.enum(['subtle', 'medium', 'bold']),
    radius: z.enum(['sharp', 'rounded', 'soft']),
    reduceMotion: z.boolean(),
    splash: z.boolean(),
    splashSound: z.boolean(),
    /** Show expert screens (disks and partitions, Hyper-V lab, network adapters, registry-level fixes). */
    advancedMode: z.boolean(),
    /** Easter eggs, jokes and the Silly Goose. An organization can turn them off. */
    easterEggs: z.boolean(),
    /** The Silly Goose drops by now and then on its own. */
    gooseVisits: z.boolean(),
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
  },
  appearance: {
    preset: 'fabrics',
    accent: '',
    density: 'comfortable',
    fontScale: 1,
    texture: 'theme',
    textureStrength: 'medium',
    radius: 'rounded',
    reduceMotion: false,
    splash: true,
    splashSound: true,
    advancedMode: false,
    easterEggs: true,
    gooseVisits: false,
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
  },
};

/** Settings paths that can never be changed remotely or by the renderer (identity-bearing). */
export const PROTECTED_SETTING_PATHS: readonly string[] = [];

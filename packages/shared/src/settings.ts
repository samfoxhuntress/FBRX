import { z } from 'zod';
import { DEFAULT_LOCAL_API_PORT, DEFAULT_RUNTIME_PORT, UPDATE_CHANNELS } from './constants';

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

export const DEFAULT_SYSTEM_PROMPT = `You are FBRX, the built-in operations agent of FBRX OS running on the user's workstation.
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
    theme: 'system',
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

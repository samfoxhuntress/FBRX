/**
 * The FBRX OS core API contract.
 *
 * One surface, many transports: the Electron renderer reaches it over IPC, local automations over the
 * authenticated Local API (HTTP + WebSocket), and the fleet agent maps remote commands onto it. Every
 * method is validated and audited by the core before it runs.
 */
import type { LicenseStatus } from './license';
import type { AccountDevice, AccountStatus, InvitationPreview, LocalAccountStatus } from './accounts';
import type { AttachmentInfo } from './attachments';
import type { SupportStatus } from './support';
import type { Bookmark, BrowserCheck, BrowserState, HistoryEntry } from './browser';
import type { MemoryCategory, MemoryEntry, MemoryStatus } from './memory';
import type { Policy, PolicyAction, PolicyRule, RiskLevel } from './policy';
import type { ThinkingBudget, ThinkingLevel } from './thinking';
import type { ExtEvents, ExtMethods } from './ext';
import type { Settings } from './settings';
import type { UpdateChannel } from './constants';
import type { ReleaseCheck } from './release';
import type { EditionStatus, Vertical } from './editions';

export type DeepPartial<T> = T extends (infer U)[] ? U[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export type ServiceState = 'stopped' | 'starting' | 'running' | 'degraded' | 'failed' | 'disabled';

export interface ServiceStatus {
  name: string;
  title: string;
  description: string;
  state: ServiceState;
  message: string | null;
  startedAt: string | null;
  restarts: number;
  dependsOn: string[];
  critical: boolean;
}

/**
 * Why the vault is locked: "password" = it asks for the vault password at every start (by choice); "moved" = the key
 * is still protected by a keychain FBRX no longer uses (the Mac Keychain before 1.8.1) and can be brought over;
 * "keychain" = this computer's keychain could not open it (use the recovery passphrase); "manual" = locked by hand.
 */
export type VaultLockReason = 'password' | 'moved' | 'keychain' | 'manual';

export interface VaultStatus {
  state: 'uninitialized' | 'locked' | 'unlocked';
  keychain: 'available' | 'unavailable';
  /** What protects the key on this computer: the operating system's keychain or FBRX's own key file. */
  keychainKind: 'os' | 'file' | 'env' | 'memory';
  secretCount: number;
  managedCount: number;
  hasRecovery: boolean;
  lockReason: VaultLockReason | null;
  /** The vault asks for its password every time FBRX OS starts. */
  passwordOnStart: boolean;
  /** Name of the old keychain the key can be brought over from (when lockReason is "moved"). */
  movedFrom: string | null;
}

export const SECRET_KINDS = ['api-key', 'password', 'token', 'certificate', 'connection-string', 'note', 'other'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export interface SecretMeta {
  name: string;
  kind: SecretKind;
  description: string;
  tags: string[];
  managed: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
}

export type ToolSource = 'builtin' | 'plugin' | 'connector';

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  source: ToolSource;
  sourceId: string | null;
  risk: RiskLevel;
  enabled: boolean;
  inputSchema: Record<string, unknown>;
  policyAction: PolicyAction;
}

export interface ToolInvokeResult {
  ok: boolean;
  output: string;
  data?: unknown;
  error?: string;
  durationMs: number;
}

export interface GuardianFinding {
  severity: 'info' | 'warning' | 'critical';
  code: string;
  message: string;
}

export type InvocationOrigin = 'agent' | 'user' | 'api' | 'remote' | 'scheduler';

export interface ApprovalRequest {
  id: string;
  runId: string | null;
  tool: string;
  toolTitle: string;
  risk: RiskLevel;
  input: unknown;
  reason: string;
  origin: InvocationOrigin;
  requestedAt: string;
  expiresAt: string;
  findings: GuardianFinding[];
}

export interface AuditEntry {
  seq: number;
  ts: string;
  category: string;
  action: string;
  actor: string;
  target: string | null;
  outcome: 'success' | 'failure' | 'denied' | 'info';
  details: unknown;
  prevHash: string;
  hash: string;
}

export interface AuditQuery {
  limit?: number;
  beforeSeq?: number;
  category?: string;
  outcome?: AuditEntry['outcome'];
  search?: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  brokenAtSeq: number | null;
  message: string;
}

export interface AuditStats {
  total: number;
  last24h: number;
  denied24h: number;
  failures24h: number;
  byCategory: Record<string, number>;
}

// ---------------------------------------------------------------------------------------------- AI

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  status: 'pending' | 'awaiting-approval' | 'running' | 'succeeded' | 'failed' | 'denied';
  output?: string;
  error?: string;
  durationMs?: number;
  findings?: GuardianFinding[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: ToolCallRecord[];
  toolCallId?: string;
  toolName?: string;
  createdAt: string;
  providerId?: string;
  model?: string;
  /** What the model said it was thinking before this answer (a summary, when the provider shares one). */
  thinking?: string;
  /** Files and images the person attached to this message. */
  attachments?: AttachmentInfo[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  providerId: string | null;
  model: string | null;
  origin: InvocationOrigin;
  /** Offline chats ask before the agent uses an internet tool for the first time. */
  offline: boolean;
  /** The project this chat belongs to (Projects), or null. */
  projectId: string | null;
}

export interface Conversation extends ConversationSummary {
  messages: ChatMessage[];
}

/** A conversation as the chat opens it: its messages, and what the agent is doing in it right now. */
export interface OpenConversation extends Conversation {
  run: RunActivity | null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** "mesh": another computer's agent is taking over or being consulted (Mesh Assist). */
export type AgentPhase = 'model' | 'thinking' | 'writing' | 'tool' | 'approval' | 'reading' | 'mesh';

/**
 * Events of a run carry its sequence number (seq, from 1), so what someone saw of a run can be put together exactly
 * from its RunActivity and the events after it.
 */
export type AgentEvent = { seq?: number } & (
  | { type: 'run.started'; runId: string; conversationId: string; providerId: string; model: string }
  | { type: 'message.delta'; runId: string; conversationId: string; messageId: string; delta: string }
  | { type: 'thinking.delta'; runId: string; conversationId: string; messageId: string; delta: string }
  /** What the agent is doing right now (shown while it works). */
  | { type: 'run.progress'; runId: string; conversationId: string; step: number; maxSteps: number; phase: AgentPhase; detail: string; usage: TokenUsage }
  | { type: 'message.completed'; runId: string; conversationId: string; message: ChatMessage }
  | { type: 'tool.updated'; runId: string; conversationId: string; messageId: string; call: ToolCallRecord }
  | { type: 'run.completed'; runId: string; conversationId: string; steps: number; usage: TokenUsage }
  | { type: 'run.failed'; runId: string; conversationId: string; error: string }
  | { type: 'run.cancelled'; runId: string; conversationId: string }
  | { type: 'mode.changed'; runId: string | null; conversationId: string; offline: boolean }
);

/** One step of a run, as the activity panel lists it. */
export interface RunStep {
  phase: AgentPhase;
  detail: string;
  at: number;
}

/**
 * What a run is doing right now: its steps, its thinking and the answer it is writing. The core keeps one for each run
 * while it works (foldRunActivity over the run's events), so a chat opened in the middle of a run shows it too.
 */
export interface RunActivity {
  runId: string;
  conversationId: string;
  /** The sequence number of the last event in it. */
  seq: number;
  startedAt: number;
  /** The steps so far, the current one last. */
  steps: RunStep[];
  step: number;
  maxSteps: number;
  usage: TokenUsage;
  /** The thinking behind the reply being written (it starts over with each reply). */
  thinking: string;
  thinkingFor: string | null;
  /** The reply being written, until it is complete. */
  reply: { messageId: string; text: string } | null;
}

export interface ProviderStatus {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  cloud: boolean;
  available: boolean;
  blockedByPolicy: boolean;
  message: string | null;
  defaultModel: string | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
  sizeBytes?: number;
  contextLength?: number;
  /** Short description such as "7.6B · Q4_K_M · qwen2". */
  details?: string;
  /** Why the model cannot be used right now (for example Ollama is not running), or absent when it can. */
  unavailable?: string;
}

export interface RuntimeStatus {
  state: 'not-installed' | 'no-model' | 'stopped' | 'starting' | 'running' | 'failed' | 'disabled';
  binaryPath: string | null;
  modelId: string | null;
  modelFile: string | null;
  port: number;
  pid: number | null;
  endpoint: string | null;
  message: string | null;
  /** Why the last start failed, so the right fix can be offered (download again, update the runtime…). */
  problem?: 'gpu-memory' | 'memory' | 'damaged' | 'unsupported' | 'other' | null;
}

/** The model a new computer starts with, ready before the first question (small and quick: about 1 GB). */
export const STARTER_MODEL_ID = 'qwen2.5-1.5b-instruct-q4km';

/** Getting the AI ready on a new computer: the built-in runtime and the starter model (ai.starter). */
export interface StarterAiStatus {
  /** not-needed: someone chose an AI already (another model, another provider). */
  state: 'idle' | 'preparing' | 'ready' | 'failed' | 'not-needed';
  step: 'runtime' | 'model' | 'starting' | null;
  receivedBytes: number;
  totalBytes: number;
  message: string | null;
  modelId: string;
  modelName: string;
}

export interface CatalogModel {
  id: string;
  name: string;
  family: string;
  parameters: string;
  quantization: string;
  sizeBytes: number;
  contextLength: number;
  url: string;
  sha256: string | null;
  license: string;
  description: string;
  /** "server": for FBRX Server or a workstation with a lot of memory (the hive other computers call on). */
  tier: 'small' | 'medium' | 'large' | 'server';
  toolCalling: boolean;
}

/** What this computer offers a model: memory, and a graphics card the runtime can use. */
export interface RuntimeHardware {
  memoryBytes: number;
  freeMemoryBytes: number;
  cpus: number;
  /** The graphics cards found; the runtime uses one through Vulkan (Metal on a Mac). */
  gpus: Array<{ name: string; vramBytes: number }>;
  /** Which runtime build suits it. */
  variant: 'cpu' | 'vulkan' | 'metal';
}

export type ModelFit = 'gpu' | 'memory' | 'tight' | 'too-big';

/**
 * Whether a model runs well here: all of it on the graphics card, in memory on the processor (slower, fine for a
 * server doing background work), only just, or not at all. The model needs its file size plus room for its context.
 */
export function modelFit(sizeBytes: number, hw: Pick<RuntimeHardware, 'memoryBytes' | 'gpus' | 'variant'>): ModelFit {
  const need = sizeBytes * 1.1 + 1.5e9;
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramBytes));
  if (hw.variant === 'metal' ? need <= hw.memoryBytes * 0.7 : hw.variant === 'vulkan' && need <= vram) return 'gpu';
  // Leave the operating system (and, on a server, its virtual machines) a quarter.
  if (need <= hw.memoryBytes * 0.75) return 'memory';
  if (need <= hw.memoryBytes * 0.9) return 'tight';
  return 'too-big';
}

export interface InstalledModel {
  id: string;
  name: string;
  file: string;
  sizeBytes: number;
  installedAt: string;
  sha256: string | null;
  source: 'catalog' | 'imported';
  active: boolean;
}

export interface DownloadProgress {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled';
  error?: string;
}

// ------------------------------------------------------------------------------- plugins/connectors

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  state: 'running' | 'stopped' | 'failed' | 'incompatible';
  error: string | null;
  permissions: string[];
  tools: string[];
  path: string;
  installedAt: string;
}

export const CONNECTOR_TYPES = ['rest', 'mcp-stdio', 'mcp-http', 'webhook', 'fbrx-peer'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export interface ConnectorInfo {
  id: string;
  name: string;
  type: ConnectorType;
  enabled: boolean;
  state: 'connected' | 'disconnected' | 'error' | 'idle';
  message: string | null;
  tools: string[];
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorInput {
  name: string;
  type: ConnectorType;
  enabled?: boolean;
  config: Record<string, unknown>;
}

export interface ConnectorTypeInfo {
  type: ConnectorType;
  title: string;
  description: string;
  fields: Array<{
    key: string;
    label: string;
    kind: 'text' | 'url' | 'secret-ref' | 'textarea' | 'select' | 'json' | 'boolean';
    required: boolean;
    placeholder?: string;
    options?: string[];
    help?: string;
  }>;
}

// -------------------------------------------------------------------------------- backup / restore

export interface SnapshotHeader {
  format: number;
  snapshotId: string;
  createdAt: string;
  label: string | null;
  appVersion: string;
  schemaVersion: number;
  deviceName: string;
  hostname: string;
  platform: string;
  deviceId: string | null;
  includesModels: boolean;
  encryption: { cipher: 'aes-256-gcm'; kdf: 'scrypt'; N: number; r: number; p: number; salt: string; iv: string };
}

export interface SnapshotInfo {
  file: string;
  name: string;
  sizeBytes: number;
  header: SnapshotHeader | null;
  error: string | null;
}

export interface RestoreRequest {
  file: string;
  passphrase: string;
  /**
   * `migrate`: this machine becomes the same device (fleet identity moves with the snapshot).
   * `clone`: everything is restored except fleet identity; the machine enrolls as a new device.
   */
  mode: 'migrate' | 'clone';
}

// ------------------------------------------------------------------------------------ fleet/updates

export interface FleetStatus {
  state: 'unenrolled' | 'connecting' | 'online' | 'offline' | 'error';
  serverUrl: string | null;
  deviceId: string | null;
  tenantId: string | null;
  tenantName: string | null;
  groupName: string | null;
  configVersion: number;
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
  message: string | null;
  lockedSettings: string[];
  policyManaged: boolean;
  managedSecrets: number;
  /** FBRX Command's certificate fingerprint this computer trusts, when FBRX Command uses its own certificate. */
  serverFingerprint: string | null;
}

/** What a computer sees of an FBRX Command address before joining it. */
export interface FleetProbe {
  /** The address as it will be used (https://host:port). */
  serverUrl: string;
  /** http:// on this same computer (no certificate involved). */
  local: boolean;
  /** The certificate it presents; trusted = the system already vouches for it, otherwise its fingerprint must be trusted. */
  certificate: { fingerprint: string; subject: string; issuer: string; validTo: string; trusted: boolean } | null;
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';
  currentVersion: string;
  availableVersion: string | null;
  progressPct: number | null;
  channel: UpdateChannel;
  feedUrl: string | null;
  message: string | null;
}

export interface LocalApiInfo {
  enabled: boolean;
  running: boolean;
  port: number;
  url: string;
  token: string | null;
}

export interface EffectiveSettings {
  settings: Settings;
  locked: string[];
}

/** The AI asking the person for a folder it may not use yet (Governance → Folders). */
export interface FolderRequest {
  id: string;
  /** The folder asked for, or null when the AI asks the person to pick one. */
  path: string | null;
  reason: string;
  at: string;
  agentName: string;
}

export interface FolderAccessStatus {
  /** Decided by the organization (FBRX Command → Governance): no changes here. */
  managed: boolean;
  /** The policy's entries, as written (${HOME}…), what they are on this computer, and a friendly name. */
  folders: Array<{ entry: string; path: string; label: string | null }>;
  readOnly: boolean;
  /** Requests from the AI waiting for an answer. */
  requests: FolderRequest[];
}

export interface EffectivePolicy {
  policy: Policy;
  source: 'default' | 'local' | 'managed';
  /** Rules created locally via "always allow" approvals. Appended after managed/local rules. */
  rememberedRules: PolicyRule[];
}

export interface SystemStatus {
  product: string;
  version: string;
  platform: string;
  arch: string;
  hostname: string;
  deviceName: string;
  dataDir: string;
  startedAt: string;
  uptimeSeconds: number;
  devMode: boolean;
  shell: 'desktop' | 'headless';
  services: ServiceStatus[];
  vault: VaultStatus;
  license: LicenseStatus;
  /** Endpoint Essentials, Standard or Ultra, or FBRX OS Education on a student computer; the organization kind and who uses it. */
  edition: EditionStatus;
  fleet: FleetStatus;
  runtime: RuntimeStatus;
  pendingApprovals: number;
  activeRuns: number;
  /** Emergency stop: the agent and other AI apps cannot run until someone resumes it. */
  aiHalt?: { at: string; by: string } | null;
  stats: { agentRuns24h: number; toolCalls24h: number; policyDenials24h: number; errors24h: number; lastBackupAt: string | null };
}

export interface LogLine {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  data?: unknown;
}

export interface NotificationEvent {
  title: string;
  body: string;
  level: 'info' | 'success' | 'warning' | 'error';
  source: string;
  /** The page a click opens ("messages/mesh:…"). */
  open?: string;
}

/** Method name → (params) => result. Results may be returned as promises by implementations. */
export interface CoreMethods extends ExtMethods {
  'system.status': () => SystemStatus;
  'system.restartService': (p: { name: string }) => ServiceStatus;
  'logs.tail': (p: { lines?: number; level?: LogLine['level'] }) => LogLine[];

  'settings.get': () => EffectiveSettings;
  'settings.update': (p: { patch: DeepPartial<Settings> }) => EffectiveSettings;

  'vault.status': () => VaultStatus;
  'vault.initialize': (p: { recoveryPassphrase: string }) => VaultStatus;
  'vault.unlock': (p: { recoveryPassphrase: string }) => VaultStatus;
  'vault.lock': () => VaultStatus;
  'vault.list': () => SecretMeta[];
  'vault.set': (p: { name: string; value: string; kind?: SecretKind; description?: string; tags?: string[] }) => SecretMeta;
  'vault.reveal': (p: { name: string }) => { name: string; value: string };
  'vault.delete': (p: { name: string }) => { deleted: boolean };
  'vault.changeRecovery': (p: { current: string; next: string }) => VaultStatus;
  /** Brings the key over from the keychain an earlier version used (the Mac Keychain). */
  'vault.importMoved': () => VaultStatus;
  /** Ask for the vault password at every start (on), or unlock silently on this computer again (off). */
  'vault.passwordOnStart': (p: { enabled: boolean; passphrase: string }) => VaultStatus;
  /** Deletes every saved credential and starts a new, empty vault (FBRX OS restarts). */
  'vault.reset': (p: { confirm: 'DELETE' }) => VaultStatus;

  'ai.providers': () => ProviderStatus[];
  'ai.models': (p: { providerId: string }) => ModelInfo[];
  /** attachments: ids from ai.attachments.add, sent with this message. */
  'ai.chat': (p: { conversationId?: string; message: string; providerId?: string; model?: string; offline?: boolean; attachments?: string[] }) => { runId: string; conversationId: string };
  /** Attaches a file (its bytes in base64) for the next message; it is read and kept until sent or removed. */
  'ai.attachments.add': (p: { name: string; data: string; mime?: string }) => AttachmentInfo;
  /** Removes an attachment that was not sent. */
  'ai.attachments.remove': (p: { id: string }) => { removed: boolean };
  /** An attachment's bytes (base64), to show it again in the chat. */
  'ai.attachments.read': (p: { id: string }) => { mime: string; data: string };
  'ai.cancel': (p: { runId: string }) => { cancelled: boolean };
  /** What every run in progress is doing right now. */
  'ai.runs': () => RunActivity[];
  /** How much the agent does on one task (a thinking level): its whole work budget at once (thinking.ts). */
  'ai.setThinking': (p: { level: ThinkingLevel }) => ThinkingBudget;
  /** projectId: only that project's chats ("none": chats in no project). */
  'ai.conversations.list': (p?: { projectId?: string | 'none' }) => ConversationSummary[];
  'ai.conversations.get': (p: { id: string }) => OpenConversation;
  'ai.conversations.rename': (p: { id: string; title: string }) => ConversationSummary;
  'ai.conversations.delete': (p: { id: string }) => { deleted: boolean };
  /** Deletes several chats at once (a chat the agent is still answering in is skipped). */
  'ai.conversations.deleteMany': (p: { ids: string[] }) => { deleted: number; skipped: number };
  /**
   * Cleans up the history: deletes chats not touched for olderThanDays (0 = all), keeping chats in projects unless
   * includeProjects. dryRun only counts them.
   */
  'ai.conversations.cleanup': (p: { olderThanDays: number; includeProjects?: boolean; dryRun?: boolean }) => { deleted: number };
  /** Adds a chat to a project (null takes it out). */
  'ai.conversations.setProject': (p: { id: string; projectId: string | null }) => ConversationSummary;
  'ai.conversations.setOffline': (p: { id: string; offline: boolean }) => ConversationSummary;

  'runtime.status': () => RuntimeStatus;
  'runtime.start': () => RuntimeStatus;
  'runtime.stop': () => RuntimeStatus;
  'runtime.catalog': () => CatalogModel[];
  /** Downloads the llama.cpp runtime for this OS/CPU; progress arrives as `runtime.download` with modelId "llama-runtime". */
  'runtime.installRuntime': () => { started: boolean };
  'runtime.installed': () => InstalledModel[];
  'runtime.download': (p: { modelId: string }) => { started: boolean };
  'runtime.cancelDownload': (p: { modelId: string }) => { cancelled: boolean };
  'runtime.importModel': (p: { path: string; name?: string }) => InstalledModel;
  'runtime.deleteModel': (p: { modelId: string }) => { deleted: boolean };
  /** Deletes a downloaded model's file (even the one in use) and downloads it again. */
  'runtime.redownload': (p: { modelId: string }) => { started: boolean };
  /** The runtime's last lines of output, for troubleshooting. */
  'runtime.logs': () => string[];
  'runtime.selectModel': (p: { modelId: string }) => RuntimeStatus;
  /** Memory and graphics cards, for choosing a model that fits. */
  'runtime.hardware': () => RuntimeHardware;
  /** Downloads under way (models and the runtime itself), and ones that finished in the last few minutes. */
  'runtime.downloads': () => DownloadProgress[];
  /** Makes a model this computer's AI: the built-in runtime on, the model selected, the local provider the default. */
  'runtime.useModel': (p: { modelId: string }) => RuntimeStatus;
  /** The AI ready on a new computer (the built-in runtime and the starter model). */
  'ai.starter': () => StarterAiStatus;
  /** Gets it ready now (again, after a failure, or after it was turned down). */
  'ai.prepareStarter': () => StarterAiStatus;

  'tools.list': () => ToolInfo[];
  'tools.setEnabled': (p: { name: string; enabled: boolean }) => ToolInfo;
  'tools.invoke': (p: { name: string; input: unknown }) => ToolInvokeResult;

  'governance.policy': () => EffectivePolicy;
  'governance.updatePolicy': (p: { policy: Policy }) => EffectivePolicy;
  'governance.removeRememberedRule': (p: { id: string }) => EffectivePolicy;
  /** What the AI remembers about the person (Settings → Memory). */
  'memory.status': () => MemoryStatus;
  'memory.add': (p: { content: string; category?: MemoryCategory }) => MemoryEntry;
  'memory.update': (p: { id: string; content: string }) => MemoryEntry;
  'memory.forget': (p: { id: string }) => { ok: boolean };
  'memory.forgetAll': () => { forgotten: number };
  'governance.folders': () => FolderAccessStatus;
  /** Lets the AI use a folder (picked by the person). */
  'governance.addFolder': (p: { path: string }) => FolderAccessStatus;
  'governance.removeFolder': (p: { entry: string }) => FolderAccessStatus;
  /** Answers the AI's request: a folder (the one asked for, or another), or null to say no. */
  'governance.answerFolder': (p: { id: string; path: string | null }) => FolderAccessStatus;
  'approvals.list': () => ApprovalRequest[];
  'approvals.resolve': (p: { id: string; decision: 'approve' | 'deny'; remember?: boolean }) => { resolved: boolean };

  'audit.query': (p: AuditQuery) => AuditEntry[];
  'audit.verify': () => AuditVerifyResult;
  'audit.stats': () => AuditStats;

  'plugins.list': () => PluginInfo[];
  'plugins.install': (p: { path: string }) => PluginInfo;
  'plugins.uninstall': (p: { id: string }) => { uninstalled: boolean };
  'plugins.setEnabled': (p: { id: string; enabled: boolean }) => PluginInfo;
  'plugins.reload': (p: { id: string }) => PluginInfo;

  'connectors.types': () => ConnectorTypeInfo[];
  'connectors.list': () => ConnectorInfo[];
  'connectors.create': (p: ConnectorInput) => ConnectorInfo;
  'connectors.update': (p: { id: string; patch: Partial<ConnectorInput> }) => ConnectorInfo;
  'connectors.delete': (p: { id: string }) => { deleted: boolean };
  'connectors.test': (p: { id: string }) => { ok: boolean; message: string; tools: string[] };

  'backup.list': () => SnapshotInfo[];
  'backup.create': (p: { passphrase?: string; label?: string; includeModels?: boolean }) => SnapshotInfo;
  'backup.inspect': (p: { file: string }) => SnapshotHeader;
  'backup.restore': (p: RestoreRequest) => { restored: boolean; restartRequired: boolean };
  'backup.delete': (p: { file: string }) => { deleted: boolean };

  'fleet.status': () => FleetStatus;
  /** audience "student" makes this a student computer (FBRX OS Education), whatever the token says. */
  /** fingerprint: trust FBRX Command's own certificate (home and school networks without a public one). */
  'fleet.enroll': (p: { serverUrl: string; token: string; deviceName?: string; audience?: 'staff' | 'student' | 'parent' | 'child'; fingerprint?: string }) => FleetStatus;
  /** Looks at an FBRX Command address before joining: whether its certificate is trusted, and its fingerprint. */
  'fleet.probe': (p: { serverUrl: string }) => FleetProbe;
  'fleet.unenroll': () => FleetStatus;
  'fleet.sync': () => FleetStatus;

  'license.status': () => LicenseStatus;
  'license.activate': (p: { key: string }) => LicenseStatus;
  'license.remove': () => LicenseStatus;
  'account.status': () => AccountStatus;
  /** Signs in to an FBRX account (or makes one, `create`), and turns on what it bought. */
  'account.signIn': (p: { server?: string; email: string; password: string; name?: string; create?: boolean }) => AccountStatus;
  'account.signOut': () => AccountStatus;
  'account.refresh': () => AccountStatus;
  /** A page to buy Standard or Ultra (Stripe Checkout), to open in the browser. */
  'account.checkout': (p: { productId: string }) => { url: string };
  /** The billing portal: change the plan or the card, invoices, cancel. */
  'account.portal': () => { url: string };
  /** Joins this computer to an organization the account belongs to, at the edition it gives the account. */
  'account.join': (p: { tenantId: string }) => AccountStatus;
  /** Where the account is signed in: computers, phones and browsers (`current` is this computer). */
  'account.devices': () => AccountDevice[];
  /** Signs the account out somewhere else. */
  'account.signOutDevice': (p: { id: string }) => { ok: true };
  /** Sends the email that confirms the account's address again. */
  'account.resendConfirmation': () => { sent: boolean };
  /** Emails a link to choose a new password (it opens on the website). */
  'account.forgotPassword': (p: { email: string; server?: string }) => { ok: true };
  /** Starts an FBRX Command for the person's organization (in the cloud); answers with its console's address. */
  'account.startOrganization': (p: { name: string; kind: Vertical }) => { consoleUrl: string; tenantId: string };
  /** What an invitation code from an organization is for (its name, the email and edition), before using it. */
  'account.previewInvitation': (p: { code: string; server?: string }) => InvitationPreview;
  /**
   * Uses an invitation code: makes the FBRX account (or, when the email has one, signs in to it with its password),
   * joins the organization at the edition it gives, and signs in here.
   */
  'account.acceptInvitation': (p: { code: string; server?: string; name?: string; password: string }) => AccountStatus;

  /** The offline, local-only FBRX account on this computer (works with no cloud; see accounts.ts). */
  'localAccount.status': () => LocalAccountStatus;
  'localAccount.create': (p: { name: string; email?: string; password?: string }) => LocalAccountStatus;
  'localAccount.update': (p: { name?: string; email?: string | null }) => LocalAccountStatus;
  /** Turn the start password on (with a password) or off; and unlock FBRX at start with it. */
  'localAccount.setPassword': (p: { password: string; current?: string }) => LocalAccountStatus;
  'localAccount.clearPassword': (p: { current: string }) => LocalAccountStatus;
  'localAccount.unlock': (p: { password: string }) => LocalAccountStatus;
  'localAccount.remove': (p: { confirm: 'DELETE' }) => LocalAccountStatus;

  /** Support mode (troubleshooting): a signed pass elevates this computer; the resume phrase or expiry restores it. */
  'support.status': () => SupportStatus;
  'support.activate': (p: { pass: string }) => SupportStatus;
  'support.end': () => SupportStatus;

  /** FBRX Browser: what the browser window needs that lives in the core (bookmarks, history, policy, homepage). */
  'browser.state': () => BrowserState;
  'browser.check': (p: { input: string }) => BrowserCheck;
  'browser.bookmark': (p: { url: string; title: string }) => Bookmark[];
  'browser.removeBookmark': (p: { id: string }) => Bookmark[];
  'browser.history': (p?: { limit?: number; query?: string }) => HistoryEntry[];
  'browser.visited': (p: { url: string; title: string }) => { ok: true };
  'browser.clearHistory': (p?: { since?: string }) => { cleared: number };
  'browser.setHomepage': (p: { url: string }) => BrowserState;
  'browser.addBlocked': (p: { host: string }) => BrowserState;
  'browser.removeBlocked': (p: { host: string }) => BrowserState;

  'updates.status': () => UpdateStatus;
  'updates.check': () => UpdateStatus;
  'updates.install': () => UpdateStatus;

  /** New versions published in the FBRX repository (release.json), offered to the person. */
  'release.status': () => ReleaseCheck;
  'release.check': () => ReleaseCheck;
  'release.skip': (p: { version: string }) => ReleaseCheck;
  /** Downloads the new version into the folder FBRX was installed from and starts its installer. */
  'release.install': () => ReleaseCheck;

  'localapi.info': (p: { revealToken?: boolean }) => LocalApiInfo;
  'localapi.rotateToken': () => LocalApiInfo;
}

export type CoreMethod = keyof CoreMethods;
export type CoreParams<M extends CoreMethod> = Parameters<CoreMethods[M]> extends [infer P] ? P : undefined;
export type CoreResult<M extends CoreMethod> = ReturnType<CoreMethods[M]>;

export interface CoreEvents extends ExtEvents {
  agent: AgentEvent;
  /** The runs in progress, each time one starts or ends. */
  'agent.runs': Array<Pick<RunActivity, 'runId' | 'conversationId'>>;
  'approval.requested': ApprovalRequest;
  'approval.resolved': { id: string; decision: 'approve' | 'deny' | 'expired'; by: string };
  'service.changed': ServiceStatus;
  'vault.changed': VaultStatus;
  'audit.appended': AuditEntry;
  'runtime.changed': RuntimeStatus;
  'runtime.download': DownloadProgress;
  'ai.starter': StarterAiStatus;
  'settings.changed': EffectiveSettings;
  'policy.changed': EffectivePolicy;
  'governance.folderRequest': FolderRequest & { state: 'open' | 'closed' };
  /** The AI's memory of the person changed (how many facts it holds now). */
  'memory.changed': { count: number };
  'plugins.changed': PluginInfo[];
  'connectors.changed': ConnectorInfo[];
  'tools.changed': ToolInfo[];
  'fleet.changed': FleetStatus;
  'license.changed': LicenseStatus;
  'account.changed': AccountStatus;
  'support.changed': SupportStatus;
  'localAccount.changed': LocalAccountStatus;
  'browser.changed': BrowserState;
  'updates.changed': UpdateStatus;
  'release.changed': ReleaseCheck;
  notification: NotificationEvent;
}
export type CoreEventName = keyof CoreEvents;

/** Methods available to Local API tokens with the restricted `agent` scope. */
export const AGENT_SCOPE_METHODS: readonly CoreMethod[] = [
  'system.status',
  'ai.providers',
  'ai.models',
  'ai.chat',
  'ai.cancel',
  'ai.runs',
  'ai.conversations.list',
  'ai.conversations.get',
  'tools.list',
  'tools.invoke',
  'approvals.list',
];

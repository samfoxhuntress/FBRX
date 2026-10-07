import type { TrophyState } from './fun';
import type { VoiceDownloadId } from './settings';
import type { HelpdeskScope, HelpdeskStatus, TicketCategory, TicketDetail, TicketPriority, TicketStatus, TicketSummary } from './helpdesk';
import type { EditionStatus } from './editions';
import type { CalendarAccount, CalendarChange, CalendarEvent, CalendarSignIn, CalendarStatus, NewCalendarEvent } from './calendar';
import type { ProtectionState, ProtectionStatus, ScanJob, ScanType, ShieldDetection, ShieldVerdict } from './protection';
import type { AssistOffer, AssistPriority, AssistSession, AssistTools } from './mesh-assist';
import type { NetEnvDeviceAction, NetEnvDeviceStats, NetEnvDevice, NetEnvInput, NetEnvironment, NetEnvOverview, NetEnvProbe, NetEnvVoucher } from './netenv';
/**
 * Contracts for the FBRX OS command-center modules: workspace (notes, tasks, projects, snippets), live system
 * information, Spotlight, alerts, PC care (storage, security, updates, troubleshooting, Hyper-V lab), the
 * Network Center, the personal Mesh with its phone companion, and AI Coordination.
 *
 * Merged into `CoreMethods` / `CoreEvents` in api.ts. Windows-only modules throw `UNAVAILABLE` elsewhere.
 */

// ------------------------------------------------------------------------------------------- workspace

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  projectId: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}
export type NoteInput = Partial<Omit<Note, 'createdAt' | 'updatedAt'>> & { title: string };

export const TASK_STATUSES = ['todo', 'doing', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export interface Task {
  id: string;
  title: string;
  details: string;
  status: TaskStatus;
  priority: TaskPriority;
  due: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export type TaskInput = Partial<Omit<Task, 'createdAt' | 'updatedAt' | 'completedAt'>> & { title: string };

export interface Milestone {
  id: string;
  title: string;
  done: boolean;
}
export const PROJECT_STATUSES = ['active', 'paused', 'done'] as const;
export interface Project {
  id: string;
  name: string;
  description: string;
  status: (typeof PROJECT_STATUSES)[number];
  color: string;
  due: string | null;
  milestones: Milestone[];
  createdAt: string;
  updatedAt: string;
}
export type ProjectInput = Partial<Omit<Project, 'createdAt' | 'updatedAt'>> & { name: string };
export interface ProjectSummary extends Project {
  tasks: number;
  done: number;
  overdue: number;
  notes: number;
  snippets: number;
  /** Chats with the agent in this project. */
  chats: number;
}

export interface Snippet {
  id: string;
  title: string;
  language: string;
  content: string;
  tags: string[];
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}
export type SnippetInput = Partial<Omit<Snippet, 'createdAt' | 'updatedAt'>> & { title: string };

// ------------------------------------------------------------------------------------- presenter-safe mode

export interface PresenterStatus {
  /** Presenter-safe mode is on right now. */
  active: boolean;
  /** Why: turned on by hand, or by itself because a second screen or projector is connected. */
  reason: 'manual' | 'display' | null;
  /** A second screen or projector is connected. */
  externalDisplay: boolean;
  hideNotifications: boolean;
  maskClipboard: boolean;
  blurPrivate: boolean;
}

// ------------------------------------------------------------------------------------- system & files

export interface DiskVolume {
  mount: string;
  label: string;
  fs: string;
  size: number;
  used: number;
}
export interface SystemStatic {
  os: { name: string; version: string; build: string; arch: string; hostname: string };
  cpu: { model: string; cores: number; threads: number; speedGHz: number | null };
  memoryTotal: number;
  gpus: Array<{ model: string; vramMB: number | null }>;
  disks: DiskVolume[];
  machine: { manufacturer: string; model: string };
  hasBattery: boolean;
}
export interface SystemLive {
  ts: number;
  cpu: number;
  cores: number[];
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  netRx: number;
  netTx: number;
  battery: { percent: number; charging: boolean } | null;
  tempC: number | null;
  uptime: number;
}
export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memBytes: number;
  user: string;
  path: string;
  started: string;
}
export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modifiedAt: string | null;
}
export interface FilePreview {
  path: string;
  kind: 'text' | 'image' | 'binary';
  size: number;
  truncated: boolean;
  content: string;
}

// ---------------------------------------------------------------------------------------------- spotlight

export type SpotlightAction =
  | { type: 'nav'; route: string }
  | { type: 'copy'; text: string }
  | { type: 'open'; path: string }
  | { type: 'app'; appId: string }
  | { type: 'url'; url: string }
  | { type: 'system'; name: SystemCommand; confirm: boolean }
  | { type: 'ask'; prompt: string };
export const SYSTEM_COMMANDS = ['lock', 'sleep', 'restart', 'shutdown', 'signout', 'emptybin', 'flushdns'] as const;
export type SystemCommand = (typeof SYSTEM_COMMANDS)[number];
export interface SpotlightItem {
  id: string;
  kind: 'app' | 'file' | 'page' | 'command' | 'calc' | 'convert' | 'web' | 'ask' | 'note' | 'task' | 'snippet' | 'recent';
  title: string;
  subtitle?: string;
  action: SpotlightAction;
  score: number;
}

// ------------------------------------------------------------------------------------------------- alerts

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const ALERT_CHANNELS = ['inbox', 'desktop', 'mobile', 'organisation', 'webhook', 'email'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];
export interface AlertRuleInfo {
  id: string;
  group: string;
  label: string;
  help: string;
  unit: string | null;
  threshold: number | null;
  enabled: boolean;
  severity: AlertSeverity;
  windowsOnly: boolean;
}
export interface AlertItem {
  id: string;
  ruleId: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  deliveries: Partial<Record<AlertChannel, string>>;
}

// ------------------------------------------------------------------------------------------ PC care (Windows)

export interface ElevatedResult {
  ok: boolean;
  output: string;
}
export interface DriveInfo {
  letter: string;
  label: string;
  fs: string;
  type: string;
  size: number;
  free: number;
  health: string;
  bitlocker: string | null;
}
export interface PartitionInfo {
  number: number;
  letter: string;
  type: string;
  size: number;
  fs: string;
  label: string;
  free: number | null;
  isBoot: boolean;
  isSystem: boolean;
  hidden: boolean;
}
export interface PhysicalDiskInfo {
  number: number;
  model: string;
  media: string;
  bus: string;
  size: number;
  health: string;
  serial: string;
  partitionStyle: string;
  isBoot: boolean;
  temperatureC: number | null;
  wearPercent: number | null;
  partitions: PartitionInfo[];
}
export interface CleanupInfo {
  temp: Array<{ path: string; size: number }>;
  downloads: { path: string; size: number };
  recycleBin: number | null;
}
export interface FolderUsage {
  path: string;
  total: number;
  files: number;
  children: Array<{ name: string; path: string; size: number; dir: boolean }>;
  largest: Array<{ path: string; size: number }>;
  partial: boolean;
}
export const STORAGE_ACTIONS = ['analyze', 'optimize', 'chkdsk', 'label', 'letter', 'extend'] as const;

export interface DefenderStatus {
  realtime: boolean;
  antivirus: boolean;
  tamperProtected: boolean;
  behaviorMonitor: boolean;
  signatureVersion: string;
  signatureAgeDays: number | null;
  engineVersion: string;
  lastQuickScan: string | null;
  lastFullScan: string | null;
}
export interface DefenderThreat {
  id: string;
  name: string;
  severity: string;
  active: boolean;
  time: string | null;
  status: string;
  resources: string[];
}
export interface FirewallProfile {
  name: string;
  enabled: boolean;
  inbound: string;
  outbound: string;
}
export interface ListeningPort {
  protocol: 'TCP' | 'UDP';
  address: string;
  port: number;
  pid: number;
  process: string;
  exposed: boolean;
}
export interface AuditItem {
  name: string;
  detail: string;
  path: string;
  signed: string;
  flags: string[];
}
export interface FileReport {
  path: string;
  size: number;
  sha256: string;
  signature: { status: string; signer: string } | null;
  virustotal: { known: boolean; malicious: number; suspicious: number; harmless: number; link: string } | { error: string } | null;
  /** What FBRX Shield thinks of it (null: nothing found). */
  shield?: ShieldVerdict | null;
}
export interface LinkReport {
  input: string;
  url: string;
  finalUrl: string;
  domain: string;
  verdict: 'safe' | 'caution' | 'dangerous';
  score: number;
  findings: Array<{ severity: 'info' | 'warning' | 'critical'; text: string }>;
  redirects: Array<{ url: string; status: number | null }>;
}
export interface BugReport {
  days: number;
  events: Array<{ source: string; eventId: number; level: string; count: number; last: string; message: string }>;
  crashes: Array<{ app: string; time: string; module: string }>;
  stopErrors: Array<{ time: string; code: string }>;
  unexpectedShutdowns: Array<{ time: string }>;
  problemDevices: Array<{ name: string; id: string; status: string; error: string }>;
  stoppedServices: Array<{ name: string; display: string }>;
}
export interface EventLogEntry {
  time: string;
  log: string;
  level: 'critical' | 'error' | 'warning' | 'information';
  source: string;
  eventId: number;
  message: string;
  /** Event Viewer extras (when the log provides them). */
  recordId?: number;
  task?: string;
  user?: string;
  pid?: number;
}

export const EVENT_LEVELS = ['critical', 'error', 'warning', 'information'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export interface EventLogInfo {
  id: string;
  name: string;
  description: string;
  /** Reading it needs administrator rights (the Windows Security log). */
  admin?: boolean;
}

export interface EventQuery {
  log: string;
  levels: EventLevel[];
  /** How far back, in hours (up to 30 days). */
  hours: number;
  source?: string;
  eventId?: number;
  limit?: number;
}

// ------------------------------------------------------------------------------------------- code lab

export const CODE_LANGUAGES = ['powershell', 'python', 'javascript', 'typescript', 'csharp', 'java', 'go', 'rust', 'c', 'cpp', 'ruby', 'bash', 'lua', 'php', 'kotlin', 'swift', 'batch'] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

export interface VoiceModelStatus {
  id: VoiceDownloadId;
  /** Speech recognition (listen) or the natural voices (speak). */
  kind: 'listen' | 'speak';
  name: string;
  note: string;
  sizeMB: number;
  english: boolean;
  installed: boolean;
  downloading: boolean;
}

export interface CodeFile {
  name: string;
  language: CodeLanguage;
  size: number;
  updatedAt: string;
}
export interface FixInfo {
  id: string;
  label: string;
  admin: boolean;
  target: 'none' | 'service' | 'device';
}
export interface WingetUpgrade {
  id: string;
  name: string;
  current: string;
  available: string;
  source: string;
}
export interface WindowsUpdateItem {
  title: string;
  kb: string;
  severity: string;
  sizeMB: number | null;
  downloaded: boolean;
}
export interface DriverInfo {
  device: string;
  provider: string;
  version: string;
  date: string;
  className: string;
}
export interface HotfixInfo {
  id: string;
  description: string;
  installedOn: string | null;
}
export interface LabStatus {
  edition: string;
  admin: boolean;
  hyperv: 'enabled' | 'disabled' | 'unavailable';
  sandbox: 'enabled' | 'disabled' | 'unavailable';
  vmPlatform: 'enabled' | 'disabled' | 'unavailable';
  wsl: 'enabled' | 'disabled' | 'unavailable';
  virtualizationFirmware: boolean | null;
}
export interface VmInfo {
  name: string;
  state: string;
  cpuUsage: number;
  memoryMB: number;
  uptimeSeconds: number;
  generation: number;
  network: string;
  checkpoints: number;
  cpus: number;
}
export const LAB_FEATURES = ['Microsoft-Hyper-V-All', 'Containers-DisposableClientVM', 'VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux'] as const;
export const VM_ACTIONS = ['start', 'stop', 'off', 'save', 'checkpoint', 'revert', 'isolate', 'internet', 'disconnect', 'delete'] as const;
export interface VmSpec {
  name: string;
  os: 'windows' | 'linux';
  cpus: number;
  memoryGB: number;
  diskGB: number;
  network: 'none' | 'isolated' | 'internet';
  iso?: string;
  hardened?: boolean;
}

// ------------------------------------------------------------------------------------------------ network

export interface NetInterface {
  name: string;
  ip: string;
  mac: string;
  netmask: string;
  type: string;
  speedMbps: number | null;
  up: boolean;
}
export interface NetContext {
  hostname: string;
  interfaces: NetInterface[];
  ip: string | null;
  gateway: string | null;
  dns: string[];
}
export interface PingResult {
  host: string;
  ip: string | null;
  sent: number;
  received: number;
  lossPct: number;
  min: number | null;
  avg: number | null;
  max: number | null;
  jitter: number | null;
  samples: Array<number | null>;
}
export interface TraceHop {
  hop: number;
  ip: string | null;
  name: string | null;
  avg: number | null;
  role: 'this-pc' | 'router' | 'gateway' | 'isp' | 'internet' | 'target' | 'timeout';
  vendor: string | null;
  org: string | null;
  location: string | null;
}
export interface LanDevice {
  ip: string;
  mac: string | null;
  vendor: string | null;
  name: string | null;
  /** Model reported over UPnP or Bonjour, when the device tells. */
  model?: string | null;
  type: string;
  typeLabel: string;
  ports: number[];
  services: string[];
  latencyMs: number | null;
  isGateway: boolean;
  isSelf: boolean;
}
// ------------------------------------------------------------------------------------- MAC vendors

export interface VendorDbInfo {
  entries: number;
  source: 'built-in' | 'downloaded' | 'none';
  /** When the IEEE list in use was published or downloaded. */
  updatedAt: string | null;
}
export interface MacLookup {
  mac: string;
  vendor: string | null;
  /** Private (randomized by a phone or laptop), multicast or a normal maker-assigned address. */
  kind: 'global' | 'private' | 'multicast' | 'invalid';
  /** IEEE block size of the match: MA-L (24-bit), MA-M (28-bit) or MA-S (36-bit). */
  block: 'MA-L' | 'MA-M' | 'MA-S' | null;
  prefix: string | null;
}

// ----------------------------------------------------------------------------------- device console

export type ConsoleProtocol = 'ssh' | 'telnet';
export interface ConsoleSession {
  id: string;
  host: string;
  port: number;
  protocol: ConsoleProtocol;
  username: string | null;
  label: string;
  /** Device guide in use (see DEVICE_PROFILES). */
  profileId: string | null;
  vendor: string | null;
  state: 'connecting' | 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  reason: string | null;
  /** SSH host key fingerprint (SHA256:…). */
  fingerprint: string | null;
}
export interface ConsoleConnectInput {
  host: string;
  port?: number;
  protocol: ConsoleProtocol;
  username?: string;
  password?: string;
  /** Use the password saved for this host and user. */
  useSaved?: boolean;
  /** Save the password (encrypted in the FBRX vault) after a successful login. */
  remember?: boolean;
  /** Allow older SSH algorithms (SHA-1 key exchange, CBC ciphers) for old firmware. */
  legacy?: boolean;
  /** The host key fingerprint the person confirmed. */
  trustFingerprint?: string;
  cols?: number;
  rows?: number;
  profileId?: string;
  vendor?: string;
  label?: string;
}
export type ConsoleConnectResult =
  | { session: ConsoleSession }
  | { hostKey: { host: string; port: number; fingerprint: string; keyType: string; status: 'new' | 'changed'; previous: string | null } };
export interface ConsoleLogin {
  host: string;
  port: number;
  protocol: ConsoleProtocol;
  username: string;
  savedAt: string;
}

// ------------------------------------------------------------------------------------------ FBRX/1

export interface CliResult {
  output: string;
  /** Prompt for the next line, e.g. "you@laptop>" or "[edit]\nyou@laptop#". */
  prompt: string;
  mode: 'operational' | 'configure';
  /** The screen should be cleared (the "clear" command). */
  clear?: boolean;
}

// ---------------------------------------------------------------------------------- terminal shells

export interface TerminalShell {
  id: 'pwsh' | 'powershell' | 'cmd' | 'sh';
  name: string;
  version: string | null;
  path: string;
  /** Used when the person has not picked one: PowerShell 7 when installed. */
  default: boolean;
}

export interface LanScan {
  id: string;
  subnet: string;
  label: string;
  scannedAt: string;
  durationMs: number;
  devices: LanDevice[];
}
export interface LanScanCompare {
  added: LanDevice[];
  removed: LanDevice[];
  changed: Array<{ device: LanDevice; diffs: string[] }>;
  unchanged: number;
}
export interface SpeedTestResult {
  at: string;
  downloadMbps: number;
  uploadMbps: number;
  latencyMs: number | null;
  jitterMs: number | null;
  server: string | null;
}
export interface WifiInfo {
  connection: { ssid: string; signalPct: number; channel: number | null; band: string; rxMbps: number | null; txMbps: number | null; security: string } | null;
  networks: Array<{ ssid: string; signalPct: number; channel: number | null; band: string; security: string }>;
  channels: Record<string, number>;
}
export interface BluetoothDevice {
  name: string;
  connected: boolean;
  kind: string;
  battery: number | null;
}
export interface PrinterInfo {
  name: string;
  status: string;
  isDefault: boolean;
  port: string;
  ip: string | null;
  jobs: number;
  driver: string;
  shared: boolean;
}
export const PRINTER_ACTIONS = ['test', 'queue', 'props', 'default', 'clear', 'spooler'] as const;
export interface DnsTest {
  name: string;
  addresses: string[];
  resolvers: Array<{ name: string; ip: string; ms: number | null; ok: boolean }>;
}
export interface NetAdapter {
  alias: string;
  description: string;
  status: string;
  mac: string;
  speed: string;
  dhcp: boolean;
  ipv4: Array<{ ip: string; prefix: number }>;
  gateway: string | null;
  dns: string[];
}
export interface NetEvent {
  reqId: string;
  type: 'hop' | 'progress' | 'speed' | 'done';
  hop?: TraceHop;
  done?: number;
  total?: number;
  phase?: string;
  mbps?: number;
}

// -------------------------------------------------------------------------------------------------- mesh

export interface MeshPermissions {
  /** See this computer's health and status. */
  status: boolean;
  /** Exchange chat messages. */
  chat: boolean;
  /** Ask this computer's agent to do something (it still follows this computer's policy). */
  ask: boolean;
  /** Approve or deny actions waiting for approval on this computer. */
  approve: boolean;
  /** Read and edit tasks and notes. */
  workspace: boolean;
  /** See alerts. */
  alerts: boolean;
  /** Locate, lock or put this computer to sleep. */
  control: boolean;
  /** Ask this computer's AI for help with its own work (Mesh Assist), under this computer's Mesh Assist settings. */
  assist: boolean;
  /**
   * Controller: when it runs as administrator, its requests for help run here without asking, may be urgent, and
   * may stop lower-priority help (they still follow this computer's policy).
   */
  command: boolean;
}
export interface MeshDevice {
  id: string;
  name: string;
  kind: 'desktop' | 'mobile';
  platform: string;
  version: string;
  addr: string | null;
  port: number | null;
  online: boolean;
  lastSeen: string | null;
  fingerprint: string;
  pairedAt: string;
  permissions: MeshPermissions;
}
export interface MeshMessage {
  id: string;
  fromId: string;
  fromName: string;
  text: string;
  at: string;
}
export interface MeshPairing {
  code: string;
  expiresAt: string;
  url: string;
  qrDataUrl: string;
}
export interface MeshStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  self: { id: string; name: string; fingerprint: string; addresses: string[] };
  devices: MeshDevice[];
  nearby: Array<{ id: string; name: string; addr: string }>;
  pairing: MeshPairing | null;
  error: string | null;
}
export interface MeshJob {
  jobId: string;
  status: 'waiting-approval' | 'running' | 'done' | 'denied' | 'error';
  text: string;
  error: string | null;
  tools: string[];
}
export const MESH_ACTIONS = ['notify', 'locate', 'lock', 'sleep'] as const;

// ----------------------------------------------------------------------------------------- AI coordination

export interface AiAppInfo {
  id: string;
  name: string;
  kind: 'desktop-app' | 'cli' | 'ide' | 'local-server';
  found: boolean;
  evidence: string | null;
  mcp: boolean;
  bridged: boolean;
  /** FBRX can open (start) the app. */
  launchable: boolean;
  /** What the app can and cannot do with FBRX, for apps without MCP. */
  note: string | null;
  /** A cloud API the app's maker offers, which can be added as a model for second opinions. */
  api?: { name: string; baseUrl: string; model: string; keyUrl: string };
}
export interface McpBridgeInfo {
  ready: boolean;
  reason: string | null;
  command: string;
  args: string[];
  snippet: string;
}

// ---------------------------------------------------------------------------------------------- contract

type Ok = { ok: true };
type Deleted = { deleted: boolean };

// ------------------------------------------------------------------------------------------ migration

export const MIGRATE_ENGINES = ['robocopy', 'rsync', 'builtin'] as const;
export type MigrateEngine = (typeof MIGRATE_ENGINES)[number];
/** copy: everything, keeping extra files at the destination; update: only new and changed files (never overwrites
 * newer ones); mirror: make the destination identical (deletes extras); move: copy, then delete the originals. */
export const MIGRATE_MODES = ['copy', 'update', 'mirror', 'move'] as const;
export type MigrateMode = (typeof MIGRATE_MODES)[number];

export interface MigrateRequest {
  engine: MigrateEngine;
  mode: MigrateMode;
  source: string;
  dest: string;
  /** Include subfolders (on by default). */
  subfolders?: boolean;
  /** Copy permissions (NTFS security / Unix modes and owners) as well as data, attributes and timestamps. */
  permissions?: boolean;
  /** Skip Thumbs.db, desktop.ini, ~$ Office lock files, temp files and the Recycle Bin. */
  skipJunk?: boolean;
  retries?: number;
  /** Robocopy multi-threading (1–64). */
  threads?: number;
  excludeFiles?: string[];
  excludeDirs?: string[];
  /** List what would happen without copying anything. */
  dryRun?: boolean;
}

export interface MigrateEngineInfo {
  id: MigrateEngine;
  name: string;
  available: boolean;
  note: string;
}

export interface MigrateJob {
  jobId: string;
  request: MigrateRequest;
  state: 'running' | 'done' | 'failed' | 'canceled';
  startedAt: string;
  finishedAt: string | null;
  files: number;
  bytes: number;
  errors: number;
  summary: string | null;
}

export type MigrateEvent =
  /** Output, a few times a second (a big copy prints a line per file). */
  | { jobId: string; type: 'lines'; lines: string[] }
  | { jobId: string; type: 'progress'; files: number; bytes: number; errors: number }
  | { jobId: string; type: 'done'; job: MigrateJob };

export interface ExtMethods {
  'notes.list': (p?: { projectId?: string; query?: string }) => Note[];
  'notes.save': (p: NoteInput) => Note;
  'notes.delete': (p: { id: string }) => Deleted;
  'tasks.list': (p?: { projectId?: string; status?: TaskStatus }) => Task[];
  'tasks.save': (p: TaskInput) => Task;
  'tasks.delete': (p: { id: string }) => Deleted;
  'projects.list': () => ProjectSummary[];
  'projects.save': (p: ProjectInput) => Project;
  'projects.delete': (p: { id: string; cascade?: boolean }) => Deleted;
  'snippets.list': (p?: { projectId?: string; query?: string }) => Snippet[];
  'snippets.save': (p: SnippetInput) => Snippet;
  'snippets.delete': (p: { id: string }) => Deleted;

  'sysinfo.static': () => SystemStatic;
  'sysinfo.live': () => { current: SystemLive | null; history: SystemLive[] };
  'processes.list': (p?: { sort?: 'cpu' | 'memory'; filter?: string; limit?: number }) => { total: number; list: ProcessInfo[] };
  'processes.kill': (p: { pid: number }) => { killed: boolean };
  'files.home': () => { home: string; places: Array<{ name: string; path: string }>; drives: string[] };
  'files.list': (p: { path: string; hidden?: boolean }) => { path: string; parent: string | null; items: FileEntry[] };
  'files.read': (p: { path: string }) => FilePreview;
  'files.write': (p: { path: string; content: string }) => Ok;
  'files.open': (p: { path: string }) => Ok;
  'files.search': (p: { root: string; pattern: string }) => { results: FileEntry[] };
  'terminal.run': (p: { command: string; cwd?: string; shell?: TerminalShell['id'] }) => { sessionId: string };
  'terminal.kill': (p: { sessionId: string }) => { killed: boolean };
  'terminal.shells': () => TerminalShell[];

  'spotlight.query': (p: { q: string }) => SpotlightItem[];
  'spotlight.files': (p: { q: string }) => SpotlightItem[];
  'spotlight.run': (p: { item: SpotlightItem; modifier?: 'reveal' | 'copy' }) => { ok: boolean; navigate?: string; ask?: string; message?: string };
  'spotlight.ask': (p: { q: string }) => { answer: string };

  'alerts.rules': () => AlertRuleInfo[];
  'alerts.inbox': (p?: { limit?: number; unreadOnly?: boolean }) => AlertItem[];
  'alerts.markRead': (p: { id: string }) => Ok;
  'alerts.delete': (p: { id: string }) => Ok;
  'alerts.test': (p: { channel: AlertChannel }) => { ok: boolean; result: string };
  'alerts.counts': () => { unread: number; critical: number };

  'storage.drives': () => DriveInfo[];
  'storage.disks': () => PhysicalDiskInfo[];
  'storage.cleanupInfo': () => CleanupInfo;
  'storage.cleanTemp': () => { freed: number; skipped: number };
  'storage.emptyRecycleBin': () => Ok;
  'storage.analyze': (p: { path: string }) => FolderUsage;
  'storage.maintenance': (p: { action: (typeof STORAGE_ACTIONS)[number]; letter?: string; value?: string; disk?: number; partition?: number }) => ElevatedResult;

  'security.defender': () => DefenderStatus;
  'security.defenderPrefs': () => Record<string, unknown>;
  'security.setDefenderPref': (p: { name: string; value: boolean | number | string }) => ElevatedResult;
  'security.exclusion': (p: { kind: 'path' | 'ext' | 'process'; value: string; remove?: boolean }) => ElevatedResult;
  'security.threats': () => DefenderThreat[];
  'security.scan': (p: { type: 'quick' | 'full' | 'custom'; path?: string }) => { threatsFound: boolean; output: string };
  'security.updateSignatures': () => { ok: boolean; output: string };
  'security.removeThreats': () => ElevatedResult;
  'security.firewall': () => FirewallProfile[];
  'security.setFirewall': (p: { profile: string; enabled: boolean }) => ElevatedResult;
  'security.ports': () => ListeningPort[];
  'security.processAudit': () => AuditItem[];
  'security.startup': () => AuditItem[];
  'security.fileReport': (p: { path: string }) => FileReport;
  'security.linkCheck': (p: { url: string }) => LinkReport;
  'security.sandbox': (p: { url?: string; folder?: string; networking?: boolean }) => Ok;
  'security.open': (p: { page: string }) => Ok;

  'bugs.scan': (p?: { days?: number }) => BugReport;
  'bugs.fixes': () => FixInfo[];
  'bugs.events': (p: { log: 'System' | 'Application' | 'Setup'; days?: number; minLevel?: 'error' | 'warning' | 'information'; limit?: number }) => EventLogEntry[];
  'bugs.fix': (p: { id: string; target?: string }) => ElevatedResult;

  'winupdates.apps': () => WingetUpgrade[];
  'winupdates.upgradeApp': (p: { id: string; reqId: string }) => { ok: boolean; output: string };
  'winupdates.windows': () => WindowsUpdateItem[];
  'winupdates.drivers': () => DriverInfo[];
  'winupdates.hotfixes': () => HotfixInfo[];
  'winupdates.open': (p: { page: 'check' | 'history' | 'advanced' | 'optional' | 'store' }) => Ok;

  'lab.status': () => LabStatus;
  'lab.enableFeature': (p: { feature: (typeof LAB_FEATURES)[number] }) => ElevatedResult;
  'lab.vms': (p?: { elevated?: boolean }) => { vms: VmInfo[]; error: string | null };
  'lab.createVm': (p: VmSpec) => ElevatedResult;
  'lab.vmAction': (p: { name: string; action: (typeof VM_ACTIONS)[number]; arg?: string }) => ElevatedResult;
  'lab.openManager': () => Ok;
  /** Opens a VM's console window (Virtual Machine Connection). */
  'lab.openConsole': (p: { name: string }) => Ok;

  'net.context': () => NetContext;
  'net.publicIp': () => { ip: string | null; isp: string | null; location: string | null };
  'net.ping': (p: { host: string; count?: number }) => PingResult;
  'net.traceroute': (p: { host: string; reqId: string }) => { target: string; hops: TraceHop[] };
  'net.scan': (p: { reqId: string; subnet?: string; label?: string }) => LanScan;
  'net.scans': () => Array<Omit<LanScan, 'devices'> & { count: number }>;
  'net.scanGet': (p: { id: string }) => LanScan;
  'net.scanDelete': (p: { id: string }) => Deleted;
  'net.compare': (p: { a: string; b: string }) => LanScanCompare;
  'net.exportCsv': (p: { id: string; path: string }) => { path: string; rows: number };
  'net.speedTest': (p: { reqId: string }) => SpeedTestResult;
  'net.speedHistory': () => SpeedTestResult[];

  /**
   * A quick answer from the default model with no tools (it cannot change anything): for side panels that explain
   * code, logs or processes. Text streams as `ai.quick` events with the same reqId.
   */
  'ai.quick': (p: { reqId: string; prompt: string; context?: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> }) => { answer: string; model: string };
  'ai.quickCancel': (p: { reqId: string }) => Ok;

  'events.logs': () => EventLogInfo[];
  'events.query': (p: EventQuery) => { entries: EventLogEntry[]; note: string | null };

  'codelab.list': () => CodeFile[];
  'codelab.read': (p: { name: string }) => { name: string; content: string };
  'codelab.save': (p: { name: string; content: string }) => CodeFile;
  'codelab.delete': (p: { name: string }) => Ok;
  'codelab.folder': () => { path: string };
  'codelab.editors': () => { vscode: boolean; ise: boolean; sandbox: boolean };
  /** Opens a file from the code lab in VS Code, PowerShell ISE, Notepad, or shows its folder. */
  'codelab.open': (p: { name: string; app: 'vscode' | 'ise' | 'notepad' | 'folder' }) => Ok;
  /** Runs a PowerShell or batch file inside Windows Sandbox: a throw-away Windows with no network and the code lab folder read-only. */
  'codelab.sandbox': (p: { name: string }) => Ok;

  // ------------------------------------------------------------------------------------------- voice
  /** Speech recognition models and whether they are on this computer. */
  'voice.models': () => VoiceModelStatus[];
  /** Downloads a model (progress arrives as voice.download events). */
  'voice.install': (p: { model: VoiceDownloadId }) => Ok;
  'voice.remove': (p: { model: VoiceDownloadId }) => Ok;
  'voice.cancel': () => Ok;

  'migrate.engines': () => MigrateEngineInfo[];
  /** The exact command a request would run, and warnings about it, without running anything. */
  'migrate.plan': (p: MigrateRequest) => { command: string; warnings: string[] };
  'migrate.start': (p: MigrateRequest) => { jobId: string; command: string };
  'migrate.cancel': (p: { jobId: string }) => Ok;
  'migrate.jobs': () => MigrateJob[];
  'net.wifi': () => WifiInfo;
  'net.bluetooth': () => { adapters: string[]; devices: BluetoothDevice[] };
  'net.printers': () => PrinterInfo[];
  'net.printerAction': (p: { name: string; action: (typeof PRINTER_ACTIONS)[number] }) => Ok;
  'net.dns': (p: { name: string }) => DnsTest;
  'net.port': (p: { host: string; port: number }) => { open: boolean; ms: number | null };
  'net.adapters': () => NetAdapter[];
  'net.setIp': (p: { alias: string; mode: 'dhcp' | 'static' | 'secondary' | 'removeSecondary'; ip?: string; prefix?: number | string; gateway?: string; dns?: string[] }) => ElevatedResult;
  'net.ssh': (p: { host: string; user?: string; port?: number }) => Ok;
  'net.vendorInfo': () => VendorDbInfo;
  'net.vendorUpdate': () => VendorDbInfo;
  'net.macLookup': (p: { mac: string }) => MacLookup;
  // Help desk (a computer in an organization): tickets to IT through FBRX Command.
  'helpdesk.status': () => HelpdeskStatus;
  'helpdesk.tickets': (p: { scope: HelpdeskScope; state?: 'open' | 'closed' | 'all' }) => TicketSummary[];
  'helpdesk.ticket': (p: { id: string }) => TicketDetail;
  'helpdesk.create': (p: { subject: string; body: string; category?: TicketCategory; priority?: TicketPriority; attachDiagnostics?: boolean }) => TicketDetail;
  'helpdesk.reply': (p: { id: string; body: string }) => TicketDetail;
  'helpdesk.update': (p: { id: string; status?: TicketStatus; priority?: TicketPriority; assignToMe?: boolean }) => TicketDetail;
  /** What this computer is: its edition, organization kind and who uses it. */
  'edition.status': () => EditionStatus;
  'presenter.status': () => PresenterStatus;
  /** Turn presenter-safe mode on or off now (off also snoozes the automatic switch until the screen is unplugged). */
  'presenter.set': (p: { on: boolean }) => PresenterStatus;
  // Network environments (Endpoint Ultra): the UniFi console that runs the whole network.
  'netenv.list': () => NetEnvironment[];
  'netenv.probe': (p: { url: string; apiKey?: string; id?: string; fingerprint?: string | null }) => NetEnvProbe;
  'netenv.save': (p: NetEnvInput) => NetEnvironment;
  'netenv.remove': (p: { id: string }) => Deleted;
  'netenv.overview': (p: { id: string; siteId?: string }) => NetEnvOverview;
  'netenv.deviceStats': (p: { id: string; deviceId: string; siteId?: string }) => NetEnvDeviceStats & { device: NetEnvDevice | null };
  'netenv.deviceAction': (p: { id: string; deviceId: string; action: NetEnvDeviceAction; siteId?: string }) => Ok;
  'netenv.vouchers': (p: { id: string; siteId?: string }) => NetEnvVoucher[];
  'netenv.createVouchers': (p: { id: string; name: string; count?: number; timeLimitMinutes: number; guestLimit?: number; siteId?: string }) => NetEnvVoucher[];
  // Calendar: Outlook / Microsoft 365 accounts and calendar links.
  'calendar.status': () => CalendarStatus;
  /** Events between two times (ISO), across the accounts that are turned on. */
  'calendar.events': (p: { from: string; to: string; accountId?: string }) => CalendarEvent[];
  /** Add a calendar link (an iCalendar address; webcal:// works too). */
  'calendar.addLink': (p: { name: string; url: string; color?: string }) => CalendarAccount;
  /** Start signing in to Outlook / Microsoft 365: open the returned address in the browser. */
  'calendar.signIn': () => CalendarSignIn;
  'calendar.cancelSignIn': () => Ok;
  'calendar.update': (p: { id: string; name?: string; color?: string; enabled?: boolean; calendars?: Array<{ id: string; enabled: boolean }> }) => CalendarAccount;
  'calendar.remove': (p: { id: string }) => Deleted;
  /** Fetch now (one account, or all of them). */
  'calendar.sync': (p?: { id?: string }) => CalendarStatus;
  'calendar.create': (p: NewCalendarEvent) => CalendarEvent;
  'calendar.delete': (p: { accountId: string; id: string }) => Deleted;
  // Antivirus: what protects this computer, and FBRX Shield.
  'protection.status': (p?: { refresh?: boolean }) => ProtectionStatus;
  /** "auto", "shield", "defender" or "product:<id>". */
  'protection.setProvider': (p: { provider: string }) => ProtectionStatus;
  /** Starts a scan with the active antivirus, or with FBRX Shield for a second opinion. */
  'protection.scan': (p: { type: ScanType; path?: string; engine?: 'active' | 'shield' }) => ScanJob;
  'protection.cancelScan': () => Ok;
  /** The scan running now, or the last one. */
  'protection.job': () => ScanJob | null;
  'shield.detections': (p?: { limit?: number }) => ShieldDetection[];
  'shield.act': (p: { id: string; action: 'quarantine' | 'restore' | 'delete' | 'allow' }) => ShieldDetection;
  'shield.updateSignatures': () => { added: number; total: number };
  /** Adds fingerprints from a text file (one SHA-256 per line). */
  'shield.importSignatures': (p: { path: string }) => { added: number; total: number };
  'shield.check': (p: { path: string }) => { verdict: ShieldVerdict | null; sha256: string | null; detection: ShieldDetection | null };

  'console.connect': (p: ConsoleConnectInput) => ConsoleConnectResult;
  'console.write': (p: { id: string; data: string }) => Ok;
  'console.resize': (p: { id: string; cols: number; rows: number }) => Ok;
  'console.close': (p: { id: string }) => Ok;
  'console.list': () => ConsoleSession[];
  'console.transcript': (p: { id: string }) => { text: string };
  'console.logins': () => ConsoleLogin[];
  'console.forgetLogin': (p: { host: string; port: number; username: string }) => Ok;
  'console.forgetHostKey': (p: { host: string; port: number }) => Ok;

  'fun.trophies': () => TrophyState;
  'fun.unlock': (p: { id: string }) => { unlocked: boolean; golden: boolean };

  'ai.hardStop': () => { cancelledRuns: number; deniedApprovals: number };
  'ai.resume': () => Ok;

  'cli.exec': (p: { session: string; line: string }) => CliResult;
  'cli.complete': (p: { session: string; line: string }) => { completions: string[] };

  'aicoord.test': (p: { appId: string }) => { ok: boolean; message: string; tools: number; durationMs: number };

  'mesh.status': () => MeshStatus;
  'mesh.setEnabled': (p: { enabled: boolean }) => MeshStatus;
  'mesh.startPairing': () => MeshPairing;
  'mesh.cancelPairing': () => MeshStatus;
  'mesh.pair': (p: { code: string; host: string }) => MeshDevice;
  'mesh.removeDevice': (p: { id: string }) => MeshStatus;
  'mesh.setPermissions': (p: { id: string; permissions: Partial<MeshPermissions> }) => MeshDevice;
  'mesh.rename': (p: { name: string }) => MeshStatus;
  'mesh.peerInfo': (p: { id: string }) => unknown;
  'mesh.ask': (p: { id: string; prompt: string; reqId: string }) => MeshJob;
  'mesh.message': (p: { text: string }) => { delivered: number; total: number };
  'mesh.messages': () => MeshMessage[];
  'mesh.action': (p: { id: string; action: (typeof MESH_ACTIONS)[number]; text?: string }) => Ok;
  /** Paired computers that could help right now, best first. */
  'mesh.assist.helpers': () => AssistOffer[];
  /** Help asked from here and help given here, newest first. */
  'mesh.assist.sessions': () => AssistSession[];
  /** Hands work to other computers' AI ("any": the best helper). */
  'mesh.assist.send': (p: { peerIds: string[] | 'any'; goal: string; priority?: AssistPriority; tools?: AssistTools }) => AssistSession[];
  /** Asks the same helper a follow-up in the same conversation. */
  'mesh.assist.followUp': (p: { sessionId: string; text: string }) => AssistSession;
  'mesh.assist.cancel': (p: { sessionId: string }) => AssistSession;

  'aicoord.detect': () => AiAppInfo[];
  'aicoord.bridge': () => McpBridgeInfo;
  'aicoord.install': (p: { appId: string }) => { ok: boolean; path: string | null; message: string };
  'aicoord.remove': (p: { appId: string }) => { ok: boolean; message: string };
  'aicoord.launch': (p: { appId: string }) => { ok: boolean; message: string };
  'aicoord.consult': (p: { providerId: string; prompt: string; model?: string }) => { answer: string; providerId: string; model: string };
  /** Claude Code on this computer, usable for second opinions without an API key. */
  'aicoord.claudeCode': () => { available: boolean };
}

export interface ExtEvents {
  'workspace.changed': { kind: 'notes' | 'tasks' | 'projects' | 'snippets' };
  'sysinfo.live': SystemLive;
  'terminal.output': { sessionId: string; stream: 'out' | 'err'; text: string };
  'terminal.exit': { sessionId: string; code: number | null };
  'console.data': { id: string; data: string };
  'console.changed': ConsoleSession;
  'fun.trophy': { id: string; name: string; at: string; golden: boolean };
  'ai.halted': { halted: boolean; at: string | null; by: string | null };
  'alerts.new': AlertItem;
  /** Unread counts after any inbox change (new, read, deleted). */
  'alerts.changed': { unread: number; critical: number };
  'net.event': NetEvent;
  'netenv.changed': NetEnvironment[];
  'calendar.changed': CalendarChange;
  'protection.changed': { state: ProtectionState };
  'protection.scan': ScanJob;
  'shield.detected': ShieldDetection;
  'presenter.changed': PresenterStatus;
  'helpdesk.changed': { ticketId: string; number: number; reason: 'created' | 'message' | 'updated'; subject: string };
  'migrate.event': MigrateEvent;
  'ai.quick': { reqId: string; delta: string };
  'voice.download': { model: VoiceDownloadId; received: number; total: number; done: boolean; error: string | null };
  'winupdates.event': { reqId: string; line: string };
  'mesh.changed': MeshStatus;
  'mesh.message': MeshMessage;
  'mesh.job': { reqId: string; job: MeshJob };
  'mesh.assist': AssistSession;
}

/** Methods only a person at the workstation (never the Local API, a remote command or a mesh peer) may call. */
export const EXT_USER_ONLY: readonly (keyof ExtMethods)[] = [
  'processes.kill',
  'files.write',
  'files.open',
  'terminal.run',
  'terminal.kill',
  'spotlight.run',
  'storage.cleanTemp',
  'storage.emptyRecycleBin',
  'storage.maintenance',
  'security.setDefenderPref',
  'security.exclusion',
  'security.removeThreats',
  'security.setFirewall',
  'security.sandbox',
  'security.open',
  'bugs.fix',
  'winupdates.upgradeApp',
  'winupdates.open',
  'lab.enableFeature',
  'lab.createVm',
  'lab.vmAction',
  'lab.openManager',
  'lab.openConsole',
  'migrate.plan',
  'ai.quick',
  'ai.quickCancel',
  'codelab.list',
  'codelab.read',
  'codelab.save',
  'codelab.delete',
  'codelab.folder',
  'codelab.open',
  'codelab.sandbox',
  'voice.install',
  'voice.remove',
  'voice.cancel',
  'migrate.start',
  'migrate.cancel',
  'net.setIp',
  'net.printerAction',
  'net.exportCsv',
  'net.ssh',
  'net.vendorUpdate',
  'helpdesk.create',
  'helpdesk.reply',
  'helpdesk.update',
  'netenv.probe',
  'netenv.save',
  'netenv.remove',
  'netenv.deviceAction',
  'netenv.createVouchers',
  'protection.setProvider',
  'protection.scan',
  'protection.cancelScan',
  'shield.act',
  'shield.updateSignatures',
  'shield.importSignatures',
  'shield.check',
  'calendar.events',
  'calendar.addLink',
  'calendar.signIn',
  'calendar.cancelSignIn',
  'calendar.update',
  'calendar.remove',
  'calendar.sync',
  'calendar.create',
  'calendar.delete',
  'console.connect',
  'console.write',
  'console.resize',
  'console.close',
  'console.list',
  'console.transcript',
  'console.logins',
  'console.forgetLogin',
  'console.forgetHostKey',
  'fun.unlock',
  'ai.resume',
  'cli.exec',
  'cli.complete',
  'aicoord.test',
  'mesh.setEnabled',
  'mesh.startPairing',
  'mesh.pair',
  'mesh.removeDevice',
  'mesh.setPermissions',
  'mesh.rename',
  'mesh.action',
  'aicoord.install',
  'aicoord.remove',
  'aicoord.launch',
];

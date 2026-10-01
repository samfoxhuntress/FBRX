/**
 * FBRX OS Plugin SDK
 *
 * A plugin is a folder (or .tgz) with an `fbrx-plugin.json` manifest and a JavaScript entry point that
 * default-exports `definePlugin({...})`. Plugins run in an isolated worker process; every capability
 * (secrets, network, storage, notifications) is brokered by the host and gated by the permissions the
 * manifest declares and by the workstation's governance policy.
 */

export type RiskLevel = 'read' | 'write' | 'execute' | 'network' | 'sensitive';

/** JSON Schema (draft 2020-12 subset) describing a tool's input object. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface ToolResult {
  /** Text the agent sees. Keep it concise; it is fed back into the model context. */
  output: string;
  /** Structured data for programmatic callers (Local API, remote commands). */
  data?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface PluginLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface PluginContext {
  plugin: { id: string; version: string; dataDir: string };
  log: PluginLogger;
  /** Requires the `storage` permission. Values are JSON-serializable and persisted by the host. */
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  /** Requires `secrets:<NAME>` for each secret. Values come from the workstation's encrypted vault. */
  secrets: {
    get(name: string): Promise<string | undefined>;
  };
  /** Requires `network:<host>` (or `network:*`). Requests are executed by the host under network policy. */
  http: {
    fetch(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
  };
  /** Requires the `notifications` permission. */
  notify(title: string, body: string): Promise<void>;
}

export interface ToolInvocation {
  /** Unique id of this call (useful for logs). */
  callId: string;
  /** Where the call came from: the agent, a user, the Local API, a remote command … */
  origin: string;
  signal: AbortSignal;
}

export interface ToolDefinition<I = any> {
  /** Short name; the host exposes it as `<plugin namespace>.<name>`. Lowercase, `[a-z0-9_]`. */
  name: string;
  title: string;
  description: string;
  risk: RiskLevel;
  inputSchema: JsonSchema;
  run(input: I, ctx: PluginContext, invocation: ToolInvocation): Promise<ToolResult | string> | ToolResult | string;
}

export interface PluginDefinition {
  tools?: ToolDefinition[];
  /** Called once after the worker starts. */
  activate?(ctx: PluginContext): Promise<void> | void;
  /** Called before the worker is stopped (disable, uninstall, app exit). */
  deactivate?(): Promise<void> | void;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

export function defineTool<I = any>(def: ToolDefinition<I>): ToolDefinition<I> {
  return def;
}

// --------------------------------------------------------------------------------------- manifest

export const PLUGIN_MANIFEST_FILE = 'fbrx-plugin.json';

/**
 * Permission strings:
 * - `storage`               persistent key/value storage
 * - `notifications`         desktop notifications
 * - `secrets:<NAME>`        read a named vault secret
 * - `network:<host>`        HTTP via ctx.http to host (`*.example.com` and `*` allowed)
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** Prefix for tool names, e.g. `weather` → `weather.forecast`. */
  namespace: string;
  /** Entry module relative to the plugin root. */
  main: string;
  engines?: { fbrx?: string };
  permissions?: string[];
}

export const MANIFEST_ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
export const NAMESPACE_RE = /^[a-z][a-z0-9_]{1,31}$/;
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function validateManifest(m: unknown): { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['Manifest must be an object'] };
  const o = m as Record<string, unknown>;
  const str = (k: string) => typeof o[k] === 'string' && (o[k] as string).length > 0;
  if (!str('id') || !MANIFEST_ID_RE.test(o.id as string)) errors.push('id must be reverse-DNS, e.g. com.acme.weather');
  if (!str('name')) errors.push('name is required');
  if (!str('version') || !/^\d+\.\d+\.\d+/.test(o.version as string)) errors.push('version must be semver');
  if (!str('namespace') || !NAMESPACE_RE.test(o.namespace as string)) errors.push('namespace must match [a-z][a-z0-9_]{1,31}');
  if (!str('main')) errors.push('main is required');
  else if ((o.main as string).includes('..')) errors.push('main must stay inside the plugin folder');
  if (o.permissions !== undefined) {
    if (!Array.isArray(o.permissions) || o.permissions.some((p) => typeof p !== 'string')) errors.push('permissions must be strings');
    else
      for (const p of o.permissions as string[]) {
        if (!/^(storage|notifications|secrets:[A-Za-z0-9_.-]+|network:(\*|(\*\.)?[a-z0-9.-]+(:\d+)?))$/.test(p)) {
          errors.push(`Unknown permission "${p}"`);
        }
      }
  }
  return errors.length ? { ok: false, errors } : { ok: true, manifest: o as unknown as PluginManifest };
}

// ------------------------------------------------------------------------------- host/worker RPC

/** Messages between the host process and the plugin worker. Internal, but stable within a major version. */
export type HostToWorker =
  | { kind: 'init'; manifest: PluginManifest; root: string; dataDir: string }
  | { kind: 'invoke'; id: string; tool: string; input: unknown; callId: string; origin: string }
  | { kind: 'cancel'; id: string }
  | { kind: 'response'; id: string; ok: boolean; result?: unknown; error?: string }
  | { kind: 'shutdown' };

export type WorkerToHost =
  | { kind: 'ready'; tools: Array<Omit<ToolDefinition, 'run'>> }
  | { kind: 'init-failed'; error: string }
  | { kind: 'result'; id: string; ok: boolean; result?: ToolResult; error?: string }
  | { kind: 'request'; id: string; method: 'storage.get' | 'storage.set' | 'storage.delete' | 'storage.keys' | 'secrets.get' | 'http.fetch' | 'notify'; params: unknown }
  | { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown };

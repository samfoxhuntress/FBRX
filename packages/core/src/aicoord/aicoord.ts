import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AiAppInfo, McpBridgeInfo } from '@fbrx/shared';
import { CoreError } from '../errors';
import { exec, IS_WIN, psObject } from '../windows/ps';

const HOME = homedir();
const APPDATA = process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming');
const LOCAL = process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local');
const MAC_SUPPORT = join(HOME, 'Library', 'Application Support');

interface CatalogEntry {
  id: string;
  name: string;
  kind: AiAppInfo['kind'];
  paths: string[];
  cmd?: string;
  port?: number;
  /** MCP configuration file and the key holding servers. */
  config?: { file: string; key: 'mcpServers' | 'servers'; vscode?: boolean };
  vscodeExt?: RegExp;
  /** Windows: matches the app's Start menu entry or installed-program name. */
  match?: RegExp;
  /** Windows: matches its process name while it runs. */
  process?: RegExp;
  note?: string;
  api?: AiAppInfo['api'];
}

/**
 * Claude Desktop from the Microsoft Store (MSIX) reads its settings from its package folder
 * (%LOCALAPPDATA%\\Packages\\Claude_…\\LocalCache\\Roaming\\Claude), not %APPDATA%\\Claude. FBRX writes both.
 */
function claudeMsixConfigs(): string[] {
  if (!IS_WIN) return [];
  const pkgs = join(LOCAL, 'Packages');
  try {
    return readdirSync(pkgs)
      .filter((d) => /^(AnthropicPBC\.)?Claude_/i.test(d) || /^Anthropic\.Claude/i.test(d))
      .map((d) => join(pkgs, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  } catch {
    return [];
  }
}

/** Every configuration file an app may read (Claude Desktop: the normal one plus the Store app's). */
function configFiles(c: CatalogEntry): string[] {
  if (!c.config) return [];
  return c.id === 'claude-desktop' ? [c.config.file, ...claudeMsixConfigs()] : [c.config.file];
}

const NO_MCP = (app: string) => `${app} cannot load tools from other apps (MCP) on Windows yet. You can still ask Fabrix from FBRX, and get second opinions from its model below.`;

const CATALOG: CatalogEntry[] = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    kind: 'desktop-app',
    paths: [join(LOCAL, 'AnthropicClaude'), join(APPDATA, 'Claude'), join(MAC_SUPPORT, 'Claude')],
    match: /^Claude$/i,
    config: { file: IS_WIN ? join(APPDATA, 'Claude', 'claude_desktop_config.json') : join(MAC_SUPPORT, 'Claude', 'claude_desktop_config.json'), key: 'mcpServers' },
  },
  { id: 'claude-code', name: 'Claude Code', kind: 'cli', paths: [join(HOME, '.claude')], cmd: 'claude', config: { file: join(HOME, '.claude.json'), key: 'mcpServers' } },
  { id: 'cursor', name: 'Cursor', kind: 'ide', paths: [join(LOCAL, 'Programs', 'cursor'), join(HOME, '.cursor')], cmd: 'cursor', match: /^Cursor$/i, config: { file: join(HOME, '.cursor', 'mcp.json'), key: 'mcpServers' } },
  { id: 'windsurf', name: 'Windsurf', kind: 'ide', paths: [join(LOCAL, 'Programs', 'Windsurf'), join(HOME, '.codeium', 'windsurf')], match: /^Windsurf$/i, config: { file: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' } },
  {
    id: 'vscode',
    name: 'VS Code (GitHub Copilot)',
    kind: 'ide',
    paths: [join(LOCAL, 'Programs', 'Microsoft VS Code')],
    cmd: 'code',
    match: /^Visual Studio Code$/i,
    vscodeExt: /^github\.copilot(-chat)?-/i,
    config: { file: IS_WIN ? join(APPDATA, 'Code', 'User', 'mcp.json') : process.platform === 'darwin' ? join(MAC_SUPPORT, 'Code', 'User', 'mcp.json') : join(HOME, '.config', 'Code', 'User', 'mcp.json'), key: 'servers', vscode: true },
  },
  { id: 'gemini', name: 'Gemini CLI', kind: 'cli', paths: [join(HOME, '.gemini')], cmd: 'gemini', config: { file: join(HOME, '.gemini', 'settings.json'), key: 'mcpServers' } },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local-server', paths: [join(LOCAL, 'Programs', 'LM Studio'), join(HOME, '.lmstudio'), join(HOME, '.cache', 'lm-studio')], port: 1234, match: /^LM Studio$/i, process: /^LM Studio$/i, config: { file: join(HOME, '.lmstudio', 'mcp.json'), key: 'mcpServers' } },
  {
    id: 'perplexity',
    name: 'Perplexity',
    kind: 'desktop-app',
    paths: [join(LOCAL, 'Programs', 'Perplexity'), '/Applications/Perplexity.app'],
    match: /^Perplexity$/i,
    process: /^Perplexity$/i,
    note: NO_MCP('Perplexity'),
    api: { name: 'Perplexity (Sonar)', baseUrl: 'https://api.perplexity.ai', model: 'sonar-pro', keyUrl: 'https://www.perplexity.ai/settings/api' },
  },
  { id: 'comet', name: 'Comet (Perplexity browser)', kind: 'desktop-app', paths: [join(LOCAL, 'Perplexity', 'Comet')], match: /^Comet$/i, process: /^comet$/i, note: 'Comet is a web browser; it cannot load tools from other apps (MCP).' },
  {
    id: 'grok',
    name: 'Grok',
    kind: 'desktop-app',
    paths: [join(LOCAL, 'Programs', 'Grok'), '/Applications/Grok.app'],
    match: /^Grok$/i,
    process: /^Grok$/i,
    note: NO_MCP('Grok'),
    api: { name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-4', keyUrl: 'https://console.x.ai' },
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    kind: 'desktop-app',
    paths: [join(LOCAL, 'Programs', 'ChatGPT'), '/Applications/ChatGPT.app'],
    match: /^ChatGPT$/i,
    process: /^ChatGPT$/i,
    note: NO_MCP('ChatGPT'),
    api: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', keyUrl: 'https://platform.openai.com/api-keys' },
  },
  { id: 'copilot', name: 'Microsoft Copilot', kind: 'desktop-app', paths: [], match: /^(Microsoft )?Copilot$/i, note: 'Copilot cannot load tools from other apps (MCP).' },
  { id: 'msty', name: 'Msty', kind: 'desktop-app', paths: [join(LOCAL, 'Programs', 'Msty')], match: /^Msty/i, process: /^Msty$/i, note: 'Msty can use local models; point it at Ollama to share the same models as FBRX OS.' },
  { id: 'anythingllm', name: 'AnythingLLM', kind: 'desktop-app', paths: [join(LOCAL, 'Programs', 'AnythingLLM'), join(APPDATA, 'anythingllm-desktop')], match: /^AnythingLLM/i, note: 'AnythingLLM can use local models; point it at Ollama to share the same models as FBRX OS.' },
  { id: 'codex', name: 'OpenAI Codex CLI', kind: 'cli', paths: [join(HOME, '.codex')], cmd: 'codex' },
  { id: 'ollama', name: 'Ollama', kind: 'local-server', paths: [join(LOCAL, 'Programs', 'Ollama'), join(HOME, '.ollama')], cmd: 'ollama', port: 11434, match: /^Ollama$/i, process: /^ollama( app)?$/i },
  { id: 'jan', name: 'Jan', kind: 'local-server', paths: [join(LOCAL, 'Programs', 'jan'), join(APPDATA, 'Jan')], port: 1337, match: /^Jan$/i },
  { id: 'gpt4all', name: 'GPT4All', kind: 'local-server', paths: [join(LOCAL, 'nomic.ai'), join(HOME, 'gpt4all')], port: 4891, match: /^GPT4All/i },
];

/** What Windows knows about installed and running apps: Start menu entries, installed programs and processes. */
interface Inventory {
  start: Array<{ n: string; id: string }>;
  installed: Array<{ n: string; p?: string; v?: string }>;
  running: string[];
}

const INVENTORY_SCRIPT = `
$o = [ordered]@{ start = @(); installed = @(); running = @() }
try { $o.start = @(Get-StartApps | ForEach-Object { @{ n = $_.Name; id = $_.AppID } }) } catch {}
$keys = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$o.installed = @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object { @{ n = [string]$_.DisplayName; p = [string]$_.InstallLocation; v = [string]$_.DisplayVersion } })
$o.running = @(Get-Process -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique)
$o | ConvertTo-Json -Depth 4 -Compress`;

async function which(cmd: string): Promise<string | null> {
  const r = IS_WIN ? await exec('where.exe', [cmd], { timeoutMs: 6000 }) : await exec('/bin/sh', ['-c', `command -v ${cmd}`], { timeoutMs: 6000 });
  const p = r.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return r.code === 0 && p ? p : null;
}

async function serverUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    await r.body?.cancel();
    return r.status < 500;
  } catch {
    return false;
  }
}

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    throw new CoreError('INVALID_ARGUMENT', `${file} is not valid JSON; fix it before connecting FBRX OS`);
  }
}

export interface AiCoordDeps {
  /** Command and arguments that start the MCP shim (the FBRX executable in Node mode, or node). */
  shim: () => { command: string; args: string[]; env: Record<string, string> } | null;
  localApiRunning: () => boolean;
}

/**
 * AI Coordination: finds other AI apps on this computer and connects the MCP-capable ones to FBRX OS, so they can
 * use FBRX tools and ask Fabrix, always under FBRX governance.
 */
export class AiCoordination {
  constructor(private readonly d: AiCoordDeps) {}

  bridge(): McpBridgeInfo {
    const s = this.d.shim();
    const reason = !s ? 'The MCP bridge is not included in this build' : !this.d.localApiRunning() ? 'Turn on the Local API (Settings → Local API) so AI apps can reach FBRX OS' : null;
    const entry = s ? { command: s.command, args: s.args, env: s.env } : { command: '', args: [], env: {} };
    return {
      ready: !reason,
      reason,
      command: entry.command,
      args: entry.args,
      snippet: JSON.stringify({ mcpServers: { fbrx: entry } }, null, 2),
    };
  }

  private isBridged(c: CatalogEntry): boolean {
    if (!c.config) return false;
    return configFiles(c).some((f) => {
      try {
        return !!readJson(f)[c.config!.key]?.fbrx;
      } catch {
        return false;
      }
    });
  }

  private inventoryCache: { at: number; value: Inventory } | null = null;

  /** Start menu, installed programs and running processes (Windows; cached for a few seconds). */
  private async inventory(fresh = false): Promise<Inventory> {
    const empty: Inventory = { start: [], installed: [], running: [] };
    if (!IS_WIN) return empty;
    if (!fresh && this.inventoryCache && Date.now() - this.inventoryCache.at < 15_000) return this.inventoryCache.value;
    try {
      const v = await psObject<Partial<Inventory>>(INVENTORY_SCRIPT, 45_000);
      const arr = <T>(x: T | T[] | undefined): T[] => (Array.isArray(x) ? x : x ? [x] : []);
      const value = { start: arr(v.start), installed: arr(v.installed), running: arr(v.running) };
      this.inventoryCache = { at: Date.now(), value };
      return value;
    } catch {
      return empty;
    }
  }

  async detect(): Promise<AiAppInfo[]> {
    let vsExt: string[] = [];
    for (const dir of [join(HOME, '.vscode', 'extensions'), join(HOME, '.vscode-insiders', 'extensions')]) {
      try {
        vsExt = vsExt.concat(readdirSync(dir));
      } catch {
        /* not installed */
      }
    }
    const inv = await this.inventory(true);
    return Promise.all(
      CATALOG.map(async (c) => {
        const evidence: string[] = [];
        const folder = c.paths.find((p) => existsSync(p));
        if (folder) evidence.push(`Found ${folder.replace(HOME, '~')}`);
        const start = c.match ? inv.start.find((a) => c.match!.test(a.n)) : undefined;
        const prog = c.match ? inv.installed.find((a) => c.match!.test(a.n)) : undefined;
        if (prog) evidence.push(`Installed${prog.v ? ` (version ${prog.v})` : ''}`);
        else if (start) evidence.push('In the Start menu');
        if (!evidence.length && c.cmd) {
          const w = await which(c.cmd);
          if (w) evidence.push(`Command ${w.replace(HOME, '~')}`);
        }
        if (c.vscodeExt) {
          const e = vsExt.find((x) => c.vscodeExt!.test(x));
          if (e) evidence.push(`Extension ${e}`);
        }
        if (c.process && inv.running.some((n) => c.process!.test(n))) evidence.push('running now');
        if (c.port && (await serverUp(c.port))) evidence.push(`API server on port ${c.port}`);
        return {
          id: c.id,
          name: c.name,
          kind: c.kind,
          found: evidence.length > 0,
          evidence: evidence.length ? evidence.join('; ') : null,
          mcp: !!c.config,
          bridged: this.isBridged(c),
          launchable: IS_WIN && (!!start || (c.id === 'ollama' && evidence.length > 0)),
          note: c.note ?? null,
          ...(c.api ? { api: c.api } : {}),
        };
      }),
    );
  }

  /** Opens an app from its Start menu entry; for Ollama, starts its server. */
  async launch(appId: string): Promise<{ ok: boolean; message: string }> {
    const c = CATALOG.find((x) => x.id === appId);
    if (!c) throw new CoreError('NOT_FOUND', 'Unknown app');
    if (!IS_WIN) throw new CoreError('UNAVAILABLE', 'Opening apps from FBRX is available on Windows');
    const inv = await this.inventory();
    const start = c.match ? inv.start.find((a) => c.match!.test(a.n)) : undefined;
    if (start) {
      await exec('explorer.exe', [`shell:AppsFolder\\${start.id}`], { timeoutMs: 10_000 });
      return { ok: true, message: `Opening ${c.name}…` };
    }
    if (c.id === 'ollama') {
      const cmd = (await which('ollama')) ?? [join(LOCAL, 'Programs', 'Ollama', 'ollama.exe')].find((p) => existsSync(p));
      if (cmd) {
        spawn(cmd, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return { ok: true, message: 'Starting Ollama…' };
      }
    }
    throw new CoreError('NOT_FOUND', `${c.name} was not found in the Start menu`);
  }

  /** Adds FBRX OS as an MCP server in the app's configuration (keeping a backup of the old file). */
  async install(appId: string): Promise<{ ok: boolean; path: string | null; message: string }> {
    const c = CATALOG.find((x) => x.id === appId);
    if (!c?.config) throw new CoreError('INVALID_ARGUMENT', 'This app cannot be connected through MCP');
    const b = this.bridge();
    if (!b.ready) throw new CoreError('UNAVAILABLE', b.reason ?? 'The bridge is not ready');
    const s = this.d.shim()!;
    if (c.id === 'claude-code') {
      const cmd = await which('claude');
      if (cmd) {
        const envArgs = Object.entries(s.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
        const r = await exec(cmd, ['mcp', 'add', '--scope', 'user', ...envArgs, 'fbrx', '--', s.command, ...s.args], { timeoutMs: 30_000 });
        if (r.code === 0) return { ok: true, path: null, message: 'Added with "claude mcp add". New Claude Code sessions can use FBRX OS.' };
      }
    }
    const files = configFiles(c);
    for (const file of files) {
      mkdirSync(dirname(file), { recursive: true });
      const j = readJson(file);
      if (existsSync(file)) writeFileSync(`${file}.fbrx-backup`, readFileSync(file));
      j[c.config.key] = { ...(j[c.config.key] ?? {}), fbrx: c.config.vscode ? { type: 'stdio', ...s } : s };
      writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
    }
    const quit = c.id === 'claude-desktop' ? ' Quit it completely (right-click its tray icon → Quit), start it again, then use Test to check the link.' : '';
    return { ok: true, path: files[0], message: `Connected. Restart ${c.name} to load the FBRX OS tools.${quit}` };
  }

  async remove(appId: string): Promise<{ ok: boolean; message: string }> {
    const c = CATALOG.find((x) => x.id === appId);
    if (!c?.config) throw new CoreError('INVALID_ARGUMENT', 'This app is not connected through MCP');
    if (c.id === 'claude-code') {
      const cmd = await which('claude');
      if (cmd) await exec(cmd, ['mcp', 'remove', '--scope', 'user', 'fbrx'], { timeoutMs: 20_000 });
    }
    for (const file of configFiles(c)) {
      if (!existsSync(file)) continue;
      const j = readJson(file);
      if (j[c.config.key]?.fbrx) {
        delete j[c.config.key].fbrx;
        writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
      }
    }
    return { ok: true, message: `Disconnected from ${c.name}.` };
  }

  /**
   * Tests the link the way the AI app uses it: starts the configured bridge command, does the MCP handshake and asks
   * for the tool list. Proves that the app will find FBRX OS and its tools once it has restarted.
   */
  async test(appId: string): Promise<{ ok: boolean; message: string; tools: number; durationMs: number }> {
    const c = CATALOG.find((x) => x.id === appId);
    let entry: { command: string; args: string[]; env?: Record<string, string> } | null = null;
    for (const f of c ? configFiles(c) : []) {
      try {
        entry = readJson(f)[c!.config!.key]?.fbrx ?? entry;
      } catch {
        /* unreadable config */
      }
    }
    entry ??= this.d.shim();
    if (!entry?.command) return { ok: false, message: 'FBRX OS is not connected to this app yet: use Connect first.', tools: 0, durationMs: 0 };
    if (!this.d.localApiRunning()) return { ok: false, message: 'The Local API is off, so AI apps cannot reach FBRX OS. Turn it on in Settings → Local API.', tools: 0, durationMs: 0 };
    const t0 = Date.now();
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let done = false;
      const child = spawn(entry!.command, entry!.args, { env: { ...process.env, ...(entry!.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const finish = (r: { ok: boolean; message: string; tools: number }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.kill();
        resolve({ ...r, durationMs: Date.now() - t0 });
      };
      const timer = setTimeout(() => finish({ ok: false, message: `The bridge did not answer within 20 seconds.${err ? ` It said: ${err.trim().slice(-300)}` : ''}`, tools: 0 }), 20_000);
      const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
      child.on('error', (e) => finish({ ok: false, message: `The bridge command could not start (${e.message}). Reinstall FBRX OS, then Connect again.`, tools: 0 }));
      child.on('exit', (code) => finish({ ok: false, message: `The bridge stopped (exit code ${code}).${err ? ` ${err.trim().slice(-300)}` : ''}`, tools: 0 }));
      child.stderr.on('data', (b: Buffer) => (err += b.toString()));
      child.stdout.on('data', (b: Buffer) => {
        out += b.toString();
        let nl: number;
        while ((nl = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, nl).trim();
          out = out.slice(nl + 1);
          if (!line) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id === 1) {
            if (msg.error) return finish({ ok: false, message: `The bridge refused the handshake: ${msg.error.message}`, tools: 0 });
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          } else if (msg.id === 2) {
            const tools = Array.isArray(msg.result?.tools) ? msg.result.tools.length : 0;
            if (msg.error || tools <= 1) {
              return finish({ ok: false, message: `The bridge started but could not list FBRX tools${msg.error ? `: ${msg.error.message}` : ' (is FBRX OS running with the Local API on?)'}.`, tools });
            }
            finish({ ok: true, message: `Working: the bridge answered with ${tools} FBRX tools.${c ? ` After restarting ${c.name}, ask it for example "Use FBRX to check my disk space" or "Ask Fabrix what is slowing my PC down".` : ''}`, tools });
          }
        }
      });
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fbrx-link-test', version: '1.0.0' } } });
    });
  }

  /** Asks Claude through Claude Code (if installed and signed in) for a second opinion: no API key needed. */
  async askClaudeCode(prompt: string): Promise<{ answer: string; providerId: string; model: string }> {
    const cmd = await which('claude');
    if (!cmd) throw new CoreError('NOT_FOUND', 'Claude Code is not installed. Install it, or add Claude with an API key in AI models.');
    // The question goes in on stdin (never on a command line); npm installs claude as a .cmd on Windows.
    const viaCmd = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
    const answer = await new Promise<string>((resolve, reject) => {
      const child = viaCmd
        ? spawn('cmd.exe', ['/d', '/s', '/c', `""${cmd}" -p --output-format text"`], { windowsVerbatimArguments: true, windowsHide: true })
        : spawn(cmd, ['-p', '--output-format', 'text'], { windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill(), 300_000);
      child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
      child.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')));
      child.on('error', (e) => reject(new CoreError('UNAVAILABLE', `Claude Code could not start: ${e.message}`)));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && out.trim()) resolve(out.trim());
        else reject(new CoreError('UNAVAILABLE', `Claude Code could not answer: ${(err || out).trim().slice(0, 400) || `exit code ${code}`}. Run "claude" once in a terminal to sign in.`));
      });
      child.stdin.end(prompt);
    });
    return { answer, providerId: 'claude-code', model: 'Claude (via Claude Code)' };
  }

  /** Whether Claude Code is on this computer (for the Second opinion list). */
  async hasClaudeCode(): Promise<boolean> {
    return !!(await which('claude'));
  }
}

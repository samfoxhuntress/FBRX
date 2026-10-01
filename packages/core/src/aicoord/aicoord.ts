import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AiAppInfo, McpBridgeInfo } from '@fbrx/shared';
import { CoreError } from '../errors';
import { exec, IS_WIN } from '../windows/ps';

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
}

const CATALOG: CatalogEntry[] = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    kind: 'desktop-app',
    paths: [join(LOCAL, 'AnthropicClaude'), join(APPDATA, 'Claude'), join(MAC_SUPPORT, 'Claude')],
    config: { file: IS_WIN ? join(APPDATA, 'Claude', 'claude_desktop_config.json') : join(MAC_SUPPORT, 'Claude', 'claude_desktop_config.json'), key: 'mcpServers' },
  },
  { id: 'claude-code', name: 'Claude Code', kind: 'cli', paths: [join(HOME, '.claude')], cmd: 'claude', config: { file: join(HOME, '.claude.json'), key: 'mcpServers' } },
  { id: 'cursor', name: 'Cursor', kind: 'ide', paths: [join(LOCAL, 'Programs', 'cursor'), join(HOME, '.cursor')], cmd: 'cursor', config: { file: join(HOME, '.cursor', 'mcp.json'), key: 'mcpServers' } },
  { id: 'windsurf', name: 'Windsurf', kind: 'ide', paths: [join(LOCAL, 'Programs', 'Windsurf'), join(HOME, '.codeium', 'windsurf')], config: { file: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' } },
  {
    id: 'vscode',
    name: 'VS Code (GitHub Copilot)',
    kind: 'ide',
    paths: [join(LOCAL, 'Programs', 'Microsoft VS Code')],
    cmd: 'code',
    vscodeExt: /^github\.copilot(-chat)?-/i,
    config: { file: IS_WIN ? join(APPDATA, 'Code', 'User', 'mcp.json') : process.platform === 'darwin' ? join(MAC_SUPPORT, 'Code', 'User', 'mcp.json') : join(HOME, '.config', 'Code', 'User', 'mcp.json'), key: 'servers', vscode: true },
  },
  { id: 'chatgpt', name: 'ChatGPT desktop', kind: 'desktop-app', paths: [join(LOCAL, 'Programs', 'ChatGPT'), '/Applications/ChatGPT.app'] },
  { id: 'codex', name: 'OpenAI Codex CLI', kind: 'cli', paths: [join(HOME, '.codex')], cmd: 'codex' },
  { id: 'gemini', name: 'Gemini CLI', kind: 'cli', paths: [join(HOME, '.gemini')], cmd: 'gemini' },
  { id: 'ollama', name: 'Ollama', kind: 'local-server', paths: [join(LOCAL, 'Programs', 'Ollama'), join(HOME, '.ollama')], cmd: 'ollama', port: 11434 },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local-server', paths: [join(LOCAL, 'Programs', 'LM Studio'), join(HOME, '.lmstudio'), join(HOME, '.cache', 'lm-studio')], port: 1234 },
  { id: 'jan', name: 'Jan', kind: 'local-server', paths: [join(LOCAL, 'Programs', 'jan'), join(APPDATA, 'Jan')], port: 1337 },
  { id: 'gpt4all', name: 'GPT4All', kind: 'local-server', paths: [join(LOCAL, 'nomic.ai'), join(HOME, 'gpt4all')], port: 4891 },
];

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
 * use FBRX tools and ask Fabric, always under FBRX governance.
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
    try {
      return !!readJson(c.config.file)[c.config.key]?.fbrx;
    } catch {
      return false;
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
    return Promise.all(
      CATALOG.map(async (c) => {
        let evidence: string | null = null;
        const folder = c.paths.find((p) => existsSync(p));
        if (folder) evidence = `Found ${folder.replace(HOME, '~')}`;
        if (!evidence && c.cmd) {
          const w = await which(c.cmd);
          if (w) evidence = `Command ${w.replace(HOME, '~')}`;
        }
        if (c.vscodeExt) {
          const e = vsExt.find((x) => c.vscodeExt!.test(x));
          if (e) evidence = `Extension ${e}`;
        }
        if (c.port && (await serverUp(c.port))) evidence = `${evidence ? `${evidence}; ` : ''}API server on port ${c.port}`;
        return { id: c.id, name: c.name, kind: c.kind, found: !!evidence, evidence, mcp: !!c.config, bridged: this.isBridged(c) };
      }),
    );
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
    const file = c.config.file;
    mkdirSync(dirname(file), { recursive: true });
    const j = readJson(file);
    if (existsSync(file)) writeFileSync(`${file}.fbrx-backup`, readFileSync(file));
    j[c.config.key] = { ...(j[c.config.key] ?? {}), fbrx: c.config.vscode ? { type: 'stdio', ...s } : s };
    writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
    return { ok: true, path: file, message: `Connected. Restart ${c.name} to load the FBRX OS tools.` };
  }

  async remove(appId: string): Promise<{ ok: boolean; message: string }> {
    const c = CATALOG.find((x) => x.id === appId);
    if (!c?.config) throw new CoreError('INVALID_ARGUMENT', 'This app is not connected through MCP');
    if (c.id === 'claude-code') {
      const cmd = await which('claude');
      if (cmd) await exec(cmd, ['mcp', 'remove', '--scope', 'user', 'fbrx'], { timeoutMs: 20_000 });
    }
    const file = c.config.file;
    if (existsSync(file)) {
      const j = readJson(file);
      if (j[c.config.key]?.fbrx) {
        delete j[c.config.key].fbrx;
        writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
      }
    }
    return { ok: true, message: `Disconnected from ${c.name}.` };
  }
}

/**
 * FBRX OS MCP server (stdio). AI apps such as Claude Desktop, Claude Code, Cursor, Windsurf or VS Code start this
 * shim; it forwards to the running FBRX OS through the Local API with the agent-scoped token, so every tool call is
 * checked by FBRX governance (policy, guardian, approvals, audit) exactly like a call from Fabrix itself.
 *
 * Launched as `"FBRX OS.exe" fbrx-mcp.mjs` with ELECTRON_RUN_AS_NODE=1 and FBRX_DATA_DIR pointing at the data folder,
 * where FBRX keeps the current agent token (`localapi-agent.json`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const DATA_DIR = process.env.FBRX_DATA_DIR ?? '';

function connection(): { url: string; token: string } {
  try {
    const j = JSON.parse(readFileSync(join(DATA_DIR, 'localapi-agent.json'), 'utf8'));
    return { url: String(j.url), token: String(j.token) };
  } catch {
    throw new Error('FBRX OS is not running, or its Local API is turned off (FBRX OS → AI coordination).');
  }
}

async function api(path: string, body: unknown): Promise<any> {
  const { url, token } = connection();
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15 * 60_000),
    });
  } catch {
    throw new Error('FBRX OS is not running. Open FBRX OS and try again.');
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message ?? `FBRX OS returned HTTP ${res.status}`);
  return j;
}

const wire = (name: string) => name.replace(/\./g, '__').slice(0, 64);

const server = new Server({ name: 'fbrx-os', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'Tools from FBRX OS on this computer. Calls follow FBRX policy and may wait for the user to approve them in FBRX OS.' });

let names = new Map<string, string>();

server.setRequestHandler(ListToolsRequestSchema, async () => {
  let tools: any[] = [];
  try {
    tools = (await api('/v1/rpc', { method: 'tools.list' })).result ?? [];
  } catch {
    tools = [];
  }
  names = new Map();
  const out = tools
    .filter((t) => t.enabled && t.policyAction !== 'deny')
    .map((t) => {
      names.set(wire(t.name), t.name);
      return { name: wire(t.name), description: `${t.title}. ${t.description}`.slice(0, 1024), inputSchema: t.inputSchema ?? { type: 'object', properties: {} } };
    });
  out.push({
    name: 'ask_fabrix',
    description: 'Ask Fabrix, the FBRX OS agent on this computer, to do a task with all of its tools. Returns its final answer.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'What Fabrix should do' } }, required: ['prompt'] },
  });
  return { tools: out };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    // ask_fabric: the tool's name before the agent was renamed, still used by apps that cached the tool list.
    if (name === 'ask_fabrix' || name === 'ask_fabric') {
      const r = await api('/v1/agent/run', { prompt: String(args.prompt ?? '') });
      return { content: [{ type: 'text', text: String(r.answer ?? r.error ?? '') || '(no answer)' }], isError: r.status !== 'completed' };
    }
    const tool = names.get(name) ?? name.replace(/__/g, '.');
    const r = await api(`/v1/tools/${encodeURIComponent(tool)}`, { input: args });
    return { content: [{ type: 'text', text: String(r.output ?? '').slice(0, 100_000) }], isError: !r.ok };
  } catch (err) {
    return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());

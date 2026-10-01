import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RiskLevel } from '@fbrx/shared';
import { RISK_LEVELS } from '@fbrx/shared';
import type { ToolSpec } from '../tools/types';
import { truncate } from '../util/misc';
import { asToolSlug, authHeaders, resolveSecretRefs, type ConnectorDriver, type DriverContext } from './types';

interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string };
}

/**
 * Model Context Protocol client. Any MCP server (local process over stdio, or remote over Streamable HTTP)
 * becomes a set of governed FBRX tools.
 */
export class McpConnector implements ConnectorDriver {
  private client: Client | null = null;
  private serverTools: McpTool[] = [];

  constructor(
    private readonly c: DriverContext,
    private readonly mode: 'stdio' | 'http',
  ) {}

  private get cfg() {
    return this.c.record.config;
  }

  async connect(): Promise<void> {
    await this.disconnect();
    const client = new Client({ name: 'fbrx-os', version: this.c.appVersion });
    if (this.mode === 'stdio') {
      const env: Record<string, string> = { ...getDefaultEnvironment() };
      for (const [k, v] of Object.entries((this.cfg.env as Record<string, string>) ?? {})) env[k] = resolveSecretRefs(String(v), this.c.secret);
      const transport = new StdioClientTransport({
        command: String(this.cfg.command),
        args: ((this.cfg.args as string[]) ?? []).map((a) => resolveSecretRefs(String(a), this.c.secret)),
        env,
        cwd: this.cfg.cwd ? String(this.cfg.cwd) : undefined,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (b: Buffer) => this.c.log('info', `[mcp:${this.c.record.slug}] ${b.toString().trim().slice(0, 500)}`));
      await client.connect(transport, { timeout: 30_000 });
    } else {
      const headers: Record<string, string> = { ...authHeaders(this.cfg, this.c.secret) };
      for (const [k, v] of Object.entries((this.cfg.headers as Record<string, string>) ?? {})) headers[k] = resolveSecretRefs(String(v), this.c.secret);
      const transport = new StreamableHTTPClientTransport(new URL(String(this.cfg.url)), { requestInit: { headers } });
      await client.connect(transport, { timeout: 30_000 });
    }
    this.client = client;
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
      tools.push(...(page.tools as McpTool[]));
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1000);
    this.serverTools = tools;
  }

  async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.close().catch(() => undefined);
  }

  private riskFor(t: McpTool): RiskLevel {
    const overrides = (this.cfg.toolRisk as Record<string, string>) ?? {};
    const o = overrides[t.name];
    if (o && (RISK_LEVELS as readonly string[]).includes(o)) return o as RiskLevel;
    if (t.annotations?.readOnlyHint) return t.annotations.openWorldHint ? 'network' : 'read';
    const def = String(this.cfg.defaultRisk ?? 'write');
    return (RISK_LEVELS as readonly string[]).includes(def) ? (def as RiskLevel) : 'write';
  }

  tools(): ToolSpec[] {
    const slug = this.c.record.slug;
    return this.serverTools.map((t) => ({
      name: `${slug}.${asToolSlug(t.name)}`,
      title: `${this.c.record.name}: ${t.title ?? t.annotations?.title ?? t.name}`,
      description: t.description ?? t.name,
      risk: this.riskFor(t),
      source: 'connector',
      sourceId: this.c.record.id,
      feature: 'connectors.mcp',
      timeoutMs: Number(this.cfg.timeoutSeconds ?? 120) * 1000,
      inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      run: async (input, ctx) => {
        if (!this.client) throw new Error('MCP server is not connected');
        const res = await this.client.callTool({ name: t.name, arguments: (input ?? {}) as Record<string, unknown> }, undefined, {
          signal: ctx.signal,
          timeout: Number(this.cfg.timeoutSeconds ?? 120) * 1000,
        });
        const parts: string[] = [];
        for (const block of (res.content as Array<Record<string, unknown>>) ?? []) {
          if (block.type === 'text') parts.push(String(block.text));
          else if (block.type === 'resource' && (block.resource as { text?: string })?.text) parts.push(String((block.resource as { text: string }).text));
          else parts.push(`[${String(block.type)} content]`);
        }
        if (res.structuredContent && !parts.length) parts.push(JSON.stringify(res.structuredContent, null, 2));
        const output = truncate(parts.join('\n\n') || '(no content)', 20_000);
        if (res.isError) throw new Error(output);
        return { output, data: res.structuredContent };
      },
    }));
  }

  async test() {
    await this.connect();
    return { ok: true, message: `Connected; ${this.serverTools.length} tools available` };
  }
}

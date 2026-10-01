import type { ToolSpec } from '../tools/types';
import type { ConnectorDriver, DriverContext } from './types';

/** Connects to another FBRX OS instance's Local API: delegate tasks agent-to-agent. */
export class PeerConnector implements ConnectorDriver {
  constructor(private readonly c: DriverContext) {}

  private get cfg() {
    return this.c.record.config;
  }

  private async call(path: string, body?: unknown, timeoutMs = 30_000) {
    const token = this.c.secret(String(this.cfg.tokenSecret ?? ''));
    if (!token) throw new Error(`Vault secret "${String(this.cfg.tokenSecret)}" not found`);
    const res = await fetch(new URL(path, String(this.cfg.url)).toString(), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String((json.error as { message?: string })?.message ?? `HTTP ${res.status}`));
    return json;
  }

  async connect() {
    new URL(String(this.cfg.url));
  }
  async disconnect() {}

  tools(): ToolSpec[] {
    const slug = this.c.record.slug;
    const common = { source: 'connector' as const, sourceId: this.c.record.id, feature: 'connectors' as const };
    return [
      {
        ...common,
        name: `${slug}.ask`,
        title: `${this.c.record.name}: delegate task`,
        description: `Ask the FBRX OS agent on "${this.c.record.name}" to perform a task with its own tools and return its answer.`,
        risk: 'network',
        timeoutMs: 15 * 60_000,
        inputSchema: { type: 'object', properties: { prompt: { type: 'string', minLength: 1 } }, required: ['prompt'] },
        run: async (i) => {
          const r = await this.call('/v1/agent/run', { prompt: i.prompt, providerId: this.cfg.providerId || undefined }, 15 * 60_000);
          return { output: String(r.answer ?? ''), data: r };
        },
      },
      {
        ...common,
        name: `${slug}.status`,
        title: `${this.c.record.name}: status`,
        description: `Health and status of the FBRX OS instance "${this.c.record.name}".`,
        risk: 'network',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
          const r = await this.call('/v1/rpc', { method: 'system.status', params: {} });
          const s = r.result as Record<string, any>;
          return {
            output: `${s.product} ${s.version} on ${s.hostname}: ${s.services?.filter((x: any) => x.state === 'running').length}/${s.services?.length} services running; fleet ${s.fleet?.state}`,
            data: s,
          };
        },
      },
    ];
  }

  async test() {
    const r = await this.call('/v1/health');
    return { ok: true, message: `Reached FBRX OS ${String(r.version ?? '')}` };
  }
}

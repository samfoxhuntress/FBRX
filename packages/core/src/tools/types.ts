import type { Feature, InvocationOrigin, RiskLevel, ToolSource } from '@fbrx/shared';

/** Resources a tool call will touch; declared up-front so governance can check them before execution. */
export interface ToolResources {
  paths?: Array<{ path: string; access: 'read' | 'write' }>;
  urls?: string[];
  command?: string;
}

export interface ToolExecContext {
  callId: string;
  origin: InvocationOrigin;
  actor: string;
  runId: string | null;
  signal: AbortSignal;
}

export interface ToolOutcome {
  output: string;
  data?: unknown;
}

export interface ToolSpec {
  /** Dotted, namespaced name: `fs.read_file`, `weather.forecast`, `github.create_issue`. */
  name: string;
  title: string;
  description: string;
  risk: RiskLevel;
  source: ToolSource;
  sourceId: string | null;
  inputSchema: Record<string, unknown>;
  /** License feature required to use the tool. */
  feature?: Feature;
  /** While this returns a reason, the tool is hidden from the agent and refused (e.g. it needs Endpoint Ultra). */
  unavailable?: () => string | null;
  /**
   * It sends traffic beyond this computer although its risk says otherwise (an AI Toolkit action that asks first and
   * pings, say). An offline chat asks before it runs, as for any `network` tool.
   */
  network?: boolean;
  timeoutMs?: number;
  resources?(input: any): ToolResources | Promise<ToolResources>;
  run(input: any, ctx: ToolExecContext): Promise<ToolOutcome>;
}

export interface InvocationContext {
  origin: InvocationOrigin;
  actor: string;
  runId?: string | null;
  signal?: AbortSignal;
}

/** Whether a tool reaches beyond this computer: an offline chat asks before it runs one. */
export function sendsTraffic(spec: Pick<ToolSpec, 'risk' | 'source' | 'network'>): boolean {
  return spec.risk === 'network' || spec.network === true || spec.source === 'connector';
}

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

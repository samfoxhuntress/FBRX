import type { ToolInfo, ToolSource } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Db } from '../storage/db';
import type { ToolSpec } from './types';

const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$/;

/** Catalog of every tool the agent can use: built-ins, plugin tools and connector tools. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  private listeners = new Set<() => void>();
  private disabled = new Set<string>();

  constructor(private readonly db: Db) {
    for (const r of this.db.all<{ name: string; enabled: number }>('SELECT name, enabled FROM tool_state')) {
      if (!r.enabled) this.disabled.add(r.name);
    }
  }

  register(spec: ToolSpec): void {
    if (!NAME_RE.test(spec.name)) throw new CoreError('INVALID_ARGUMENT', `Invalid tool name "${spec.name}"`);
    const existing = this.tools.get(spec.name);
    if (existing && (existing.source !== spec.source || existing.sourceId !== spec.sourceId)) {
      throw new CoreError('ALREADY_EXISTS', `Tool "${spec.name}" is already provided by ${existing.source}${existing.sourceId ? ` ${existing.sourceId}` : ''}`);
    }
    this.tools.set(spec.name, spec);
    this.changed();
  }

  registerMany(specs: ToolSpec[]): void {
    for (const s of specs) this.register(s);
  }

  unregisterSource(source: ToolSource, sourceId: string): void {
    let removed = false;
    for (const [name, spec] of this.tools) {
      if (spec.source === source && spec.sourceId === sourceId) {
        this.tools.delete(name);
        removed = true;
      }
    }
    if (removed) this.changed();
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  isEnabled(name: string): boolean {
    return !this.disabled.has(name);
  }

  setEnabled(name: string, enabled: boolean): void {
    if (!this.tools.has(name)) throw new CoreError('NOT_FOUND', `Unknown tool ${name}`);
    this.db.run(
      'INSERT INTO tool_state (name, enabled) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled',
      name,
      enabled ? 1 : 0,
    );
    if (enabled) this.disabled.delete(name);
    else this.disabled.add(name);
    this.changed();
  }

  toInfo(spec: ToolSpec, policyAction: ToolInfo['policyAction']): ToolInfo {
    return {
      name: spec.name,
      title: spec.title,
      description: spec.description,
      source: spec.source,
      sourceId: spec.sourceId,
      risk: spec.risk,
      enabled: this.isEnabled(spec.name),
      inputSchema: spec.inputSchema,
      policyAction,
    };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed() {
    for (const l of this.listeners) l();
  }
}

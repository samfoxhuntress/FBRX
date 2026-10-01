import type { SystemStatus, AuditEntry } from '@fbrx/shared';
import type { ToolSpec } from '../types';

export interface FbrxToolDeps {
  status: () => Promise<SystemStatus>;
  recentAudit: (limit: number) => AuditEntry[];
}

/** Self-introspection: lets the agent explain the state of FBRX OS itself. */
export function fbrxTools(d: FbrxToolDeps): ToolSpec[] {
  return [
    {
      name: 'fbrx.status',
      title: 'FBRX status',
      description: 'Health of FBRX OS services, vault, license, fleet connection and local model runtime.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const s = await d.status();
        const lines = [
          `${s.product} ${s.version} on ${s.platform}/${s.arch} (${s.deviceName || s.hostname})`,
          `License: ${s.license.edition} (${s.license.state})`,
          `Vault: ${s.vault.state}, ${s.vault.secretCount} secrets`,
          `Fleet: ${s.fleet.state}${s.fleet.tenantName ? ` — ${s.fleet.tenantName}` : ''}`,
          `Local runtime: ${s.runtime.state}${s.runtime.modelId ? ` (${s.runtime.modelId})` : ''}`,
          `Services:`,
          ...s.services.map((x) => `  - ${x.title}: ${x.state}${x.message ? ` — ${x.message}` : ''}`),
          `Last 24h: ${s.stats.agentRuns24h} agent runs, ${s.stats.toolCalls24h} tool calls, ${s.stats.policyDenials24h} denials, ${s.stats.errors24h} errors`,
        ];
        return { output: lines.join('\n'), data: s };
      },
    },
    {
      name: 'fbrx.audit_recent',
      title: 'Recent audit events',
      description: 'Most recent entries from the tamper-evident audit log.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } },
      async run(i) {
        const rows = d.recentAudit(i.limit);
        return {
          output: rows.map((r) => `#${r.seq} ${r.ts} ${r.category}/${r.action} by ${r.actor} → ${r.outcome}${r.target ? ` (${r.target})` : ''}`).join('\n') || 'Empty',
        };
      },
    },
  ];
}

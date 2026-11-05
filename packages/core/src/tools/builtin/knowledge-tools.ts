import type { KnowledgeBase } from '../../knowledge/knowledge-base';
import { doctorReport, type DoctorFinding } from '../../knowledge/doctor';
import { FIXES } from '../../knowledge/playbooks';
import type { ToolSpec } from '../types';

export interface KnowledgeToolDeps {
  kb: KnowledgeBase;
  doctor: () => Promise<DoctorFinding[]>;
  /** Applies a fix; returns what happened, in words. */
  fix: (id: string) => Promise<string>;
}

/** FBRX knows itself: its guides and playbooks (a local search database), a check-up, and fixes the person agrees to. */
export function knowledgeTools(d: KnowledgeToolDeps): ToolSpec[] {
  return [
    {
      name: 'fbrx.help',
      title: 'FBRX knowledge',
      description:
        "Search FBRX's own guides and troubleshooting playbooks (on this computer, offline): how to do something in FBRX, what a feature or setting does, FBRX/1 and fbrx-server commands, and what to do when FBRX is slow or misbehaves.",
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 400 }, limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 } }, required: ['query'] },
      async run(i) {
        const hits = d.kb.search(i.query, i.limit);
        return {
          output: hits.length ? hits.map((h) => `## ${h.title} (${h.kind === 'guide' ? h.ref : h.kind})\n${h.text}`).join('\n\n') : 'Nothing in FBRX’s guides matches that. Try other words, or fbrx.doctor for a check-up.',
          data: hits.map((h) => ({ kind: h.kind, ref: h.ref, title: h.title })),
        };
      },
    },
    {
      name: 'fbrx.doctor',
      title: 'FBRX check-up',
      description:
        'Check FBRX itself: its services, memory (and the local AI model against it), background work such as scans, its database and disk space, recent errors in its log, and settings that explain why something is not happening. Lists what it found with the fix for each (apply with fbrx.fix after the person agrees). Changes nothing.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const findings = await d.doctor();
        return { output: doctorReport(findings), data: findings };
      },
    },
    {
      name: 'fbrx.fix',
      title: 'Fix FBRX',
      description: `Apply a fix fbrx.doctor offered, once the person agrees: ${FIXES.map((f) => `${f.id} (${f.label})`).join('; ')}. restart-service takes the service's name: restart-service:runtime.`,
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      timeoutMs: 5 * 60_000,
      inputSchema: { type: 'object', properties: { fix: { type: 'string', pattern: '^(restart-service:[a-z0-9-]{1,40}|cancel-scan|recheck-shield|unload-model|lower-context|compact-database)$' } }, required: ['fix'] },
      async run(i) {
        return { output: await d.fix(i.fix) };
      },
    },
  ];
}

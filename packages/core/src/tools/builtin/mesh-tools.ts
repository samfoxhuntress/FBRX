import { ASSIST_PRIORITIES, ASSIST_TOOLS, type AssistPriority, type AssistTools } from '@fbrx/shared';
import type { MeshAssist } from '../../mesh/mesh-assist';
import type { ToolSpec } from '../types';

/**
 * Mesh Assist for the agent: see which computers on the mesh could lend their AI, and consult one in the middle of a
 * task (a question, a second opinion, a piece of work with that computer's tools and internet connection). Follow-ups
 * continue the same conversation with the same helper, so the two agents can go back and forth.
 */
export function meshTools(assist: MeshAssist, unavailable: () => string | null): ToolSpec[] {
  const tool = (t: Omit<ToolSpec, 'source' | 'sourceId'>): ToolSpec => ({ source: 'builtin', sourceId: null, unavailable, ...t });
  // The last helper consulted in each run, for follow-ups.
  const lastByRun = new Map<string, string>();
  return [
    tool({
      name: 'mesh.helpers',
      title: 'Computers that can help',
      description:
        'Lists the other computers on the mesh (your servers and computers) whose AI could help right now: whether each would say yes, whether its AI is ready, how busy it is and its roles. Use it before mesh.consult when choosing a helper matters.',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const offers = await assist.helpers();
        if (!offers.length) return { output: 'No other computer on the mesh answered.', data: [] };
        const lines = offers.map(
          (o) =>
            `- ${o.name}: ${o.accepts === 'off' ? `cannot help (${o.reason ?? 'off'})` : o.accepts === 'auto' ? 'helps right away' : 'helps once its person agrees'}; AI ${o.ai.ready ? `${o.ai.model ?? 'ready'}${o.ai.local ? ' (local)' : ''}` : 'not ready'}; busy ${o.busy}/${o.capacity}${o.queued ? `, ${o.queued} waiting` : ''}${o.roles.length ? `; roles ${o.roles.join(', ')}` : ''}${o.load.cpu !== null ? `; processor ${Math.round(o.load.cpu)}%` : ''}`,
        );
        return { output: lines.join('\n'), data: offers };
      },
    }),
    tool({
      name: 'mesh.consult',
      title: 'Consult another computer',
      description:
        "Asks another computer's AI on the mesh to answer a question or do a piece of work with its own tools, knowledge and internet connection, and returns its answer. It cannot see this computer's files: include what it needs in the question. Use it for a second opinion, to split a big job, when this computer lacks something, or to save this computer's effort. followUp continues the same conversation with the same helper.",
      risk: 'read',
      timeoutMs: 31 * 60_000,
      inputSchema: {
        type: 'object',
        required: ['question'],
        properties: {
          question: { type: 'string', description: 'What to answer or do, with the facts it needs' },
          peer: { type: 'string', description: 'A computer by name (default: the best one available)' },
          followUp: { type: 'boolean', description: 'Continue the last consultation in this task with the same helper' },
          tools: { type: 'string', enum: [...ASSIST_TOOLS], description: 'none: think only; read: look things up (default); all: whatever its policy allows' },
          priority: { type: 'string', enum: [...ASSIST_PRIORITIES], description: 'How urgent (default: this computer’s setting)' },
        },
      },
      async run(i: { question: string; peer?: string; followUp?: boolean; tools?: AssistTools; priority?: AssistPriority }, ctx) {
        const previous = ctx.runId ? lastByRun.get(ctx.runId) : undefined;
        const s =
          i.followUp && previous
            ? await assist.followUp(previous, i.question, ctx.signal)
            : await assist.request({ peerId: i.peer, kind: 'consult', goal: i.question, tools: i.tools ?? 'read', priority: i.priority, trigger: 'agent', signal: ctx.signal });
        if (ctx.runId) {
          lastByRun.set(ctx.runId, s.id);
          if (lastByRun.size > 200) lastByRun.delete(lastByRun.keys().next().value!);
        }
        if (s.status === 'done') return { output: `${s.peerName} answered:\n${s.answer}`, data: s };
        return { output: `${s.peerName} did not answer (${s.status}${s.error ? `: ${s.error}` : ''}). Carry on without it or try another computer.`, data: s };
      },
    }),
  ];
}

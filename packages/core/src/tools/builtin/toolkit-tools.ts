import { TOOLKIT_INPUT_KINDS, TOOLKIT_LIMITS, TOOLKIT_SYSTEM_NAMES } from '@fbrx/shared';
import type { ToolkitStore } from '../../ai/toolkit';
import type { ToolSpec } from '../types';

/**
 * The AI Toolkit for the agent (ai/toolkit.ts): building a new action is a write, so FBRX asks the person first and
 * every action Fabrix built is one they saw. The actions themselves are tools of their own (kit.<name>).
 */
export function toolkitTools(kit: ToolkitStore): ToolSpec[] {
  const system = TOOLKIT_SYSTEM_NAMES[kit.system];
  return [
    {
      name: 'toolkit.build',
      title: 'Build a toolkit action',
      description: `Add an action to the AI Toolkit: a command for this computer (${system}${kit.system === 'windows' ? ', PowerShell' : ''}) you can run again with one tool call. Build one when no kit.* tool fits a request a person could well ask again and a command does it; then call the new kit.* tool. The person approves it first and can change it in AI Toolkit.`,
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 3, maxLength: TOOLKIT_LIMITS.name, description: 'Short, like "My IP address"' },
          when: { type: 'string', maxLength: TOOLKIT_LIMITS.when, description: 'When it applies, in the words a person would use' },
          kit: { type: 'string', maxLength: TOOLKIT_LIMITS.kit, description: 'The toolkit it belongs in, like Networking (optional)' },
          command: { type: 'string', minLength: 1, maxLength: TOOLKIT_LIMITS.command, description: 'The command; write {{name}} where an input goes' },
          inputs: {
            type: 'array',
            maxItems: TOOLKIT_LIMITS.inputs,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,30}$' },
                label: { type: 'string', maxLength: TOOLKIT_LIMITS.label },
                kind: { type: 'string', enum: [...TOOLKIT_INPUT_KINDS] },
              },
              required: ['name', 'label', 'kind'],
            },
            description: 'What the command needs each time (a host, an adapter name…)',
          },
          changes: { type: 'boolean', description: 'True when the command changes anything (settings, files, services), false when it only looks' },
        },
        required: ['name', 'when', 'command', 'changes'],
      },
      async run(i) {
        const a = kit.save({ name: i.name, when: i.when, kit: i.kit, commands: { [kit.system]: i.command }, inputs: i.inputs ?? [], ask: !!i.changes }, 'fabrix');
        return {
          output: `Built "${a.name}" in the AI Toolkit as ${a.tool}${a.ask ? ' (it asks the person before each run)' : ''}. Call ${a.tool} to run it; the person can change it in AI Toolkit.`,
          data: { id: a.id, tool: a.tool },
        };
      },
    },
    {
      name: 'toolkit.list',
      title: 'List toolkit actions',
      description: 'The actions in the AI Toolkit you can run on this computer, by toolkit, with their tool names.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const list = kit.list().filter((a) => a.enabled && a.commands[kit.system]);
        const kits = [...new Set(list.map((a) => a.kit))];
        return {
          output: kits.map((k) => `${k}:\n${list.filter((a) => a.kit === k).map((a) => `- ${a.tool}: ${a.name}${a.ask ? ' (asks first)' : ''}`).join('\n')}`).join('\n\n') || 'No toolkit actions for this computer.',
          data: list.map((a) => ({ id: a.id, tool: a.tool, name: a.name, kit: a.kit })),
        };
      },
    },
  ];
}

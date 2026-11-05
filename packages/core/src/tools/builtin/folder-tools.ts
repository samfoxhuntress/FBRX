import type { FolderAccess } from '../../governance/folder-access';
import type { ToolSpec } from '../types';

/** The AI asks the person for a folder it may not use yet; the person picks it (or another), or says no. */
export function folderTools(folders: FolderAccess): ToolSpec[] {
  return [
    {
      name: 'files.request_access',
      title: 'Ask for a folder',
      description:
        'Ask the person to let you use a folder you may not use yet: another drive, a network share, or a folder outside the home folder. FBRX shows them the folder and your reason; they can pick a different folder or say no. Leave out path to ask them to pick one. Returns the folder you may now use, or that they declined.',
      // The person's answer is the approval: nothing is opened, and nothing changes unless they grant a folder.
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      timeoutMs: 15 * 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', maxLength: 4096, description: 'The folder, for example D:\\Projects or \\\\nas\\photos' },
          reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Why you need it, in one sentence the person will read' },
        },
        required: ['reason'],
      },
      async run(i, ctx) {
        const r = await folders.request({ path: i.path, reason: i.reason, signal: ctx.signal });
        return { output: r.message, data: { granted: r.granted } };
      },
    },
  ];
}

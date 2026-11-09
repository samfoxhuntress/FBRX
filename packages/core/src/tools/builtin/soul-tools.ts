import { SOUL_LIMITS, soulSection } from '@fbrx/shared';
import type { SoulStore } from '../../ai/soul';
import type { ToolSpec } from '../types';

/**
 * The AI's own tools for itself: reading its soul (soul.md), changing it (a write: FBRX asks the person, who sees the
 * change), and reading every toolkit it has, by family, FBRX Server and FBRX Gate included.
 */

interface Family {
  id: string;
  title: string;
  prefixes: string[];
  about: string;
}

export const TOOL_FAMILIES: Family[] = [
  { id: 'kit', title: 'AI Toolkit', prefixes: ['kit', 'toolkit'], about: 'Ready-made actions for this computer: the library, the person’s own and the ones you built with their yes.' },
  { id: 'computer', title: 'This computer', prefixes: ['pc', 'system', 'time', 'plan', 'alerts'], about: 'Health, storage, updates, errors, processes, cleaning and fixes.' },
  { id: 'files', title: 'Files', prefixes: ['fs', 'files', 'shell'], about: 'The folders the person lets you use (and asking for another), and commands.' },
  { id: 'network', title: 'Network', prefixes: ['net', 'http'], about: 'Addresses, Wi-Fi, speed, names, routes, ports and the devices on the network.' },
  { id: 'security', title: 'Security', prefixes: ['shield', 'passwords'], about: 'FBRX Shield’s scans and quarantine, and the saved sign-ins.' },
  { id: 'fbrx', title: 'FBRX itself', prefixes: ['fbrx'], about: 'Its guides, check-up, fixes, status and log.' },
  { id: 'server', title: 'FBRX Server and Gate', prefixes: ['server'], about: 'What the person’s FBRX Server sees of the network (FBRX Gate and MiniDome), read-only.' },
  { id: 'mesh', title: 'Mesh and devices', prefixes: ['mesh', 'device_console', 'network_env'], about: 'The person’s other computers, device consoles and network environments.' },
  { id: 'work', title: 'Work', prefixes: ['workspace', 'calendar', 'docs', 'image', 'web', 'finance', 'helpdesk'], about: 'Notes, tasks, projects, the calendar, documents, pictures, the web and the help desk.' },
  { id: 'me', title: 'Me', prefixes: ['memory', 'skills', 'soul', 'toolkits'], about: 'What you remember, the skills you learned, your toolkits and your soul.' },
];

/** What the person (or you, through them) can use on an FBRX Server itself, beyond server.network_check. */
export const SERVER_REFERENCE = `On an FBRX Server itself (its console at https://<server>:9443, and its command line as root):
- Console pages: Overview, Virtual machines, Storage & ISOs, Networks; Gate, Networks & VLANs, Firewall, DNS & VPN, Traffic & Prefer Mesh, Changes (What If before a commit); MiniDome; FBRX Time; File server; Hardware map; Server & BIOS; Fabrix (the server's own AI); Mesh & AI; FBRX Command; Roles; Terminal; Users & audit.
- fbrx-server: status, doctor [--fix], update [check | commit | rollback], roles [add | remove | set] <role>, url, setup-code, logs [ai | command] [-f], restart, command.
- fbrx-gate (on a gate): status, show [running] [path], set <path> <value>, add <path> <json>, delete <path>, edit, check, compare, commit [confirmed <minutes>] [comment <text>], confirm, rollback <commit> | now, renumber <network> <address>, wan dhcp | static <address> <gateway>, reset, history, leases, preview nftables | dnsmasq | networkd.
- Roles: virtual (virtual machines), ai (the server's AI and FBRX Mesh), gate (router and firewall), minidome (threat watch), time (image backups, each checked by starting it), files (file server, backups to a NAS), command (FBRX Command).
From this computer, server.network_check reads the gate and MiniDome once the server lets Fabrix look (FBRX Server → the server → Let Fabrix look). Nothing on the server is changed from here: give the person the console page or command to use.`;

const familyOf = (name: string): Family | null => {
  const prefix = name.split('.')[0]!;
  return TOOL_FAMILIES.find((f) => f.prefixes.includes(prefix)) ?? null;
};

export function soulTools(soul: SoulStore, tools: () => ToolSpec[]): ToolSpec[] {
  return [
    {
      name: 'soul.read',
      title: 'Read your soul',
      description: 'Read soul.md, the person’s file of who you are and how you work: what you care about, how you talk, the options they set, their commands, your toolkits and notes. Optionally one section.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { section: { type: 'string', maxLength: 60, description: 'One section, like Options or Commands (optional)' } } },
      async run(i) {
        const text = soul.read();
        if (i.section) {
          const s = soulSection(text, i.section);
          return { output: s ? `## ${s.title}\n\n${s.body}` : `soul.md has no section called ${i.section}. Its sections: ${soul.status().sections.join(', ')}.`, data: { section: s?.title ?? null } };
        }
        return { output: text, data: { path: soul.path, isDefault: soul.isDefault() } };
      },
    },
    {
      name: 'soul.update',
      title: 'Change your soul',
      description: `Change one section of soul.md, when the person asks you to work differently (a new option, a command, a note on how they like things). Replace the section, or append lines to it (Notes, a command). The person approves the change first and can undo it in Settings → Soul. ${SOUL_LIMITS.change} characters at most, no # or ## headings inside.`,
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', minLength: 2, maxLength: 60, description: 'The section, like Options, Commands or Notes (a new one is added before Notes)' },
          mode: { type: 'string', enum: ['append', 'replace'], description: 'append adds lines at its end; replace sets the whole section' },
          content: { type: 'string', minLength: 1, maxLength: SOUL_LIMITS.change, description: 'The lines to add, or the section’s new text' },
          why: { type: 'string', maxLength: 300, description: 'What the person asked for, in a few words' },
        },
        required: ['section', 'mode', 'content', 'why'],
      },
      async run(i) {
        const s = soul.update({ section: i.section, content: i.content, mode: i.mode === 'replace' ? 'replace' : 'append' }, 'Fabrix');
        return { output: `soul.md changed (${i.mode === 'replace' ? 'replaced' : 'added to'} ${i.section}). You follow it from the next message; the person can undo it in Settings → Soul.`, data: { sections: s.sections } };
      },
    },
    {
      name: 'toolkits.read',
      title: 'Read your toolkits',
      description: 'Every toolkit you have, by family, with each tool and whether it works right now: the AI Toolkit, this computer, files, network, security, FBRX itself, FBRX Server and Gate (with what the person can do on the server), mesh and devices, work, and you. Optionally one family.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { family: { type: 'string', maxLength: 40, description: `One family (optional): ${TOOL_FAMILIES.map((f) => f.id).join(', ')}, or plugins` } } },
      async run(i) {
        const all = tools();
        const want = String(i.family ?? '').trim().toLowerCase();
        const families = [...TOOL_FAMILIES, { id: 'plugins', title: 'Plugins and connections', prefixes: [], about: 'Tools from plugins and connections the person added.' }].filter(
          (f) => !want || f.id === want || f.title.toLowerCase().includes(want),
        );
        if (!families.length) return { output: `There is no family called ${i.family}. The families: ${TOOL_FAMILIES.map((f) => f.id).join(', ')}, plugins.`, data: null };
        const parts: string[] = [];
        const data: Record<string, Array<{ name: string; ready: boolean }>> = {};
        for (const f of families) {
          const mine = all.filter((t) => (f.id === 'plugins' ? t.source !== 'builtin' && !familyOf(t.name) : familyOf(t.name)?.id === f.id)).sort((a, b) => a.name.localeCompare(b.name));
          data[f.id] = mine.map((t) => ({ name: t.name, ready: !t.unavailable?.() }));
          if (!mine.length && f.id !== 'server') continue;
          const lines = mine.map((t) => {
            const why = t.unavailable?.() ?? null;
            return `- ${t.name}: ${t.title}${t.risk === 'read' ? '' : ' (asks first or changes things)'}${why ? ` — not now: ${why}` : ''}`;
          });
          parts.push(`${f.title} — ${f.about}\n${lines.join('\n') || '- (none on this computer)'}${f.id === 'server' ? `\n\n${SERVER_REFERENCE}` : ''}`);
        }
        return { output: parts.join('\n\n') || 'No tools in that family on this computer.', data };
      },
    },
  ];
}

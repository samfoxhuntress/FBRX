import { deviceProfile } from '@fbrx/shared';
import { CoreError } from '../../errors';
import type { DeviceConsoles } from '../../network/device-console';
import type { ToolSpec } from '../types';

const tool = (t: Omit<ToolSpec, 'source' | 'sourceId'>): ToolSpec => ({ source: 'builtin', sourceId: null, ...t });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lets the agent help with a device console the person opened (Network Center → Devices → Connect): see which
 * consoles are open, read what is on screen, and type one command at a time. Typing is "execute" risk, so by
 * default each command waits for the person's approval with the exact text shown. The agent cannot open consoles
 * or see saved passwords.
 */
export function deviceConsoleTools(consoles: DeviceConsoles): ToolSpec[] {
  const pick = (id?: string) => {
    const open = consoles.list().filter((s) => s.state === 'open');
    const s = id ? open.find((x) => x.id === id) : open[0];
    if (!s) throw new CoreError('NOT_FOUND', open.length ? `No open console with id ${id}` : 'No device console is open. Ask the person to connect from Network Center → Devices.');
    return s;
  };
  return [
    tool({
      name: 'device_console.sessions',
      title: 'List device consoles',
      description: 'Device consoles (SSH or Telnet to switches, firewalls, access points, servers) the person has open, with the device guide in use.',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const list = consoles.list();
        if (!list.length) return { output: 'No device consoles. The person can open one from Network Center → Devices → Connect.' };
        return {
          output: list
            .map((s) => {
              const p = deviceProfile(s.profileId);
              return `- ${s.id}: ${s.label} (${s.protocol.toUpperCase()} ${s.host}:${s.port}${s.username ? `, user ${s.username}` : ''}) — ${s.state}${p ? `; guide: ${p.name}` : ''}${s.vendor ? `; maker: ${s.vendor}` : ''}`;
            })
            .join('\n'),
          data: list,
        };
      },
    }),
    tool({
      name: 'device_console.read',
      title: 'Read a device console',
      description: 'The recent text of an open device console (what the person sees), newest last. Defaults to the most recent console.',
      risk: 'read',
      inputSchema: { type: 'object', properties: { session: { type: 'string', description: 'Console id from device_console.sessions' }, lines: { type: 'integer', minimum: 5, maximum: 400, default: 80 } } },
      async run(i) {
        const s = pick(i.session);
        const text = consoles.transcript(s.id).split('\n').slice(-(i.lines ?? 80)).join('\n');
        return { output: `${s.label} (${s.protocol.toUpperCase()} ${s.host})\n${text || '(nothing yet)'}` };
      },
    }),
    tool({
      name: 'device_console.send',
      title: 'Type a command in a device console',
      description:
        'Types one command into an open device console and presses Enter, then returns what the device printed. Use the vendor\'s exact CLI syntax (see the device guide). Prefer read-only "show" commands; explain any change first. If output stops at --More--, send a single space as the command to page on, or turn paging off with the guide\'s command.',
      risk: 'execute',
      timeoutMs: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', minLength: 1, maxLength: 2000 },
          session: { type: 'string', description: 'Console id (defaults to the most recent open console)' },
          waitSeconds: { type: 'integer', minimum: 1, maximum: 30, default: 6, description: 'Longest time to wait for output' },
        },
        required: ['command'],
      },
      resources: (i) => ({ command: String(i.command ?? '') }),
      async run(i, ctx) {
        const s = pick(i.session);
        const start = consoles.since(s.id, Number.MAX_SAFE_INTEGER).received;
        consoles.write(s.id, i.command === ' ' ? ' ' : `${String(i.command).replace(/\r?\n/g, '\r')}\r`);
        const t0 = Date.now();
        let last = start;
        let changedAt = t0;
        const limit = (i.waitSeconds ?? 6) * 1000;
        while (Date.now() - t0 < limit && !ctx.signal.aborted) {
          await sleep(250);
          const r = consoles.since(s.id, start).received;
          if (r !== last) {
            last = r;
            changedAt = Date.now();
          } else if (r > start && Date.now() - changedAt > 1200) break;
        }
        const text = consoles.since(s.id, start).text;
        const out = text.length > 12_000 ? `… (start trimmed)\n${text.slice(-12_000)}` : text;
        const paging = /--\s*more\s*--|<--- more --->|press any key/i.test(out.slice(-200)) ? '\n\n[The device is paging the output: send " " to continue or turn paging off.]' : '';
        return { output: `${out.trim() || '(no output yet)'}${paging}` };
      },
    }),
  ];
}

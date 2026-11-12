/**
 * The AI Toolkit: ready-made actions Fabrix runs for you, each a command for Windows (PowerShell), macOS and Linux.
 * FBRX comes with a library of them (library); Fabrix builds new ones when it works something out (built), each saved
 * only when you approve it; and you can write your own (yours). Every one can be changed: what it runs, whether it
 * asks first, and when it is used. Each action is a tool Fabrix calls directly (kit.<name>), in every edition.
 */
export const TOOLKIT_SYSTEMS = ['windows', 'mac', 'linux'] as const;
export type ToolkitSystem = (typeof TOOLKIT_SYSTEMS)[number];
export const TOOLKIT_SYSTEM_NAMES: Record<ToolkitSystem, string> = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };

/**
 * What an input may hold, checked before it goes into a command: a host name or address, an IPv4 address, a whole
 * number, a name (an adapter, a network service), or short plain text. Numbers and addresses go in as they are; the
 * rest go in quoted, so a value can never become a command of its own.
 */
export const TOOLKIT_INPUT_KINDS = ['host', 'ip', 'number', 'name', 'text'] as const;
export type ToolkitInputKind = (typeof TOOLKIT_INPUT_KINDS)[number];

export interface ToolkitInput {
  /** Used in the commands as {{name}}. */
  name: string;
  /** What it is, for Fabrix and for you ("The adapter's name, from Network adapters"). */
  label: string;
  kind: ToolkitInputKind;
}

export type ToolkitCommands = Partial<Record<ToolkitSystem, string>>;

export interface ToolkitAction {
  id: string;
  /** The tool Fabrix calls (kit.my_ip_address); it stays the same when the action is renamed. */
  tool: string;
  /** The toolkit it belongs to (Networking, This computer, Troubleshooting, or one you name). */
  kit: string;
  name: string;
  /** When Fabrix uses it, in the words a person would use. */
  when: string;
  commands: ToolkitCommands;
  inputs: ToolkitInput[];
  /** Asks you before each run. Off for actions that only look. */
  ask: boolean;
  /** The systems where it needs administrator rights (the system asks for them: UAC, or your password). */
  admin: ToolkitSystem[];
  /** For a change that could cut you off: what puts it back, run after `seconds` unless you keep the change. */
  undo: { commands: ToolkitCommands; seconds: number } | null;
  source: 'library' | 'built' | 'yours';
  /** A library action you changed (Reset puts FBRX's back). */
  changed: boolean;
  enabled: boolean;
  uses: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export const TOOLKIT_LIMITS = { name: 60, kit: 40, when: 300, command: 4000, inputs: 5, label: 120, undoSeconds: { min: 15, max: 600 } } as const;

const INPUT_RES: Record<ToolkitInputKind, RegExp> = {
  host: /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*\.?$|^[0-9a-fA-F:.]{2,45}$/,
  ip: /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/,
  number: /^\d{1,9}$/,
  name: /^[\p{L}\p{N} ._()+'’-]{1,80}$/u,
  text: /^[^\0-\x1f\x7f]{0,200}$/,
};

/** Why a value cannot go into an input of this kind, or null. */
export function toolkitInputProblem(kind: ToolkitInputKind, value: string): string | null {
  if (!INPUT_RES[kind].test(value)) {
    return {
      host: 'a host name or an IP address',
      ip: 'an IPv4 address like 192.168.1.20',
      number: 'a whole number',
      name: 'a name (letters, digits, spaces, dots, dashes, apostrophes)',
      text: 'one line of text, up to 200 characters',
    }[kind];
  }
  return null;
}

/** The {{name}} placeholders a command uses. */
export const toolkitPlaceholders = (command: string): string[] => [...new Set([...command.matchAll(/\{\{\s*([a-z][a-z0-9_]{0,30})\s*\}\}/g)].map((m) => m[1]))];

/** The tool name for an action's name: kit. and its words joined by underscores (letters only, so names stay clean). */
export function toolkitToolName(name: string, taken: Iterable<string> = []): string {
  const base =
    'kit.' +
    (name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40)
      .replace(/_+$/, '') || 'action');
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (const suffix of 'bcdefghijklmnopqrstuvwxyz') if (!used.has(`${base}_${suffix}`)) return `${base}_${suffix}`;
  return `${base}_${Date.now().toString(36).replace(/\d/g, '')}`;
}

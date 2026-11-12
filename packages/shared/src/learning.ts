import type { SystemInventory } from './ext';
import { INVISIBLE_CHARS } from './names';
import { normalText } from './personality';

/**
 * Learning your computer: after setup, and each time someone picks a new AI, FBRX reads what the AI needs to know
 * about this computer (on the computer itself, nothing sent out), writes it into the AI's instructions as a short
 * profile, and has the model read its instructions and tools once, so the first answer comes ready.
 */

export type LearningStepId = 'agent' | 'hardware' | 'system' | 'network' | 'fbrx' | 'context' | 'warmup';
export type LearningStepState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';

export interface LearningStep {
  id: LearningStepId;
  label: string;
  state: LearningStepState;
  /** What is happening, or what went wrong (plain words). */
  detail: string | null;
}

/** Why it learns: setup (or the first start of a version that learns), a new AI, an old profile, or the person asked. */
export type LearningReason = 'setup' | 'agent' | 'refresh' | 'manual';

/** The AI the profile is for. */
export interface LearningAgent {
  /** Provider and model, as one key: a different key is a different AI to learn for. */
  key: string;
  providerId: string;
  model: string;
  /** "Qwen3 8B", "FBRX Cloud AI"… */
  label: string;
  where: 'this computer' | 'your network' | 'another of your computers' | 'the cloud';
  /** A cloud AI gets the profile without what identifies the computer or the person. */
  cloud: boolean;
  /** The persona it has (personality.md): trying another is trying a new agent too. */
  persona?: string | null;
}

export interface LearningStatus {
  state: 'idle' | 'learning' | 'ready' | 'failed';
  reason: LearningReason | null;
  /** Shown full screen (setup, a new AI) rather than quietly (a refresh). */
  screen: boolean;
  agent: LearningAgent | null;
  steps: LearningStep[];
  startedAt: string | null;
  finishedAt: string | null;
  /** When the profile the AI has now was learned. */
  learnedAt: string | null;
  /** One line about the computer, for the ready screen. */
  summary: string | null;
  /** What did not work (the AI not ready yet, say), in plain words. */
  message: string | null;
}

export const LEARNING_STEPS: ReadonlyArray<{ id: LearningStepId; label: string }> = [
  { id: 'agent', label: 'Waking up the AI' },
  { id: 'hardware', label: 'Reading the hardware' },
  { id: 'system', label: 'Getting to know the system' },
  { id: 'network', label: 'Finding the network' },
  { id: 'fbrx', label: 'Checking FBRX’s own setup' },
  { id: 'context', label: 'Writing what it learned' },
  { id: 'warmup', label: 'Reading its instructions and tools' },
];

/** What FBRX read, from which the profile is written (kept on this computer). */
export interface ComputerFacts {
  at: string;
  inventory: SystemInventory | null;
  /** The account signed in on this computer. */
  user: string | null;
  network: {
    kind: 'wifi' | 'ethernet' | 'other' | 'none';
    connected: boolean;
    /** The Wi-Fi network this computer is on (never the ones around it). */
    ssid: string | null;
    ip: string | null;
    gateway: string | null;
    dns: string[];
    /** Network adapters with an address. */
    adapters: number;
    vpn: boolean;
  } | null;
  fbrx: {
    version: string;
    edition: string;
    mode: 'simple' | 'advanced';
    persona: string | null;
    kits: string[];
    tools: number;
    newChatsOffline: boolean;
  } | null;
  agent: { label: string; where: LearningAgent['where'] } | null;
}

/** Bumped when the profile reads differently: computers learn again, quietly. */
export const PROFILE_VERSION = 1;

/** A profile older than this is learned again, quietly, at a start. */
export const PROFILE_MAX_AGE_DAYS = 7;

/** A profile is never longer than this (most are under 900 characters); what does not fit is cut, a line at a time. */
export const PROFILE_MAX_CHARS = 1500;

/**
 * A name that reads like an instruction to the AI rather than a name, or like FBRX's own headings and notices: left out
 * of the profile. It is read as FBRX's checks read text (look-alike letters as Latin, invisible characters out).
 */
const INSTRUCTION_LIKE =
  /core principles|\(fixed\)|end of persona|guardian notice|fbrx note|this computer|#{2,}|\b(ignore|disregard|forget|override)\b|\byou (are|must|should|will|can)\b|\b(instructions?|prompts?|approv(e|al|als)|jailbreak)\b|\b(system|assistant|user|developer)\s*:|\b(run|execute|call|open|send|delete)\s+(this|the|a|all|it|now|pc\.|net\.|fs\.|fbrx\.)|\b[a-z]+\.[a-z_]+\s*\(|https?:\/\//i;

/**
 * A name from the hardware or the network, made safe to put in the AI's instructions: one short line of plain
 * characters, in quotes when written, and left out when it reads like an instruction. Anyone who names a device, a
 * printer or a Wi-Fi network chooses these words.
 */
export function profileName(v: unknown, max = 40): string | null {
  const s = String(v ?? '')
    .normalize('NFKC')
    // Control, zero-width and direction-changing characters, and what could open or close a block.
    .replace(INVISIBLE_CHARS, ' ')
    .replace(/[<>{}[\]`"\\|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  if (INSTRUCTION_LIKE.test(s) || INSTRUCTION_LIKE.test(normalText(s))) return '(left out: it reads like an instruction)';
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const size = (b: number) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)} TB` : b >= 1024 ** 3 ? `${Math.round(b / 1024 ** 3)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const q = (v: unknown, max?: number) => {
  const n = profileName(v, max);
  return n ? `"${n}"` : null;
};
/** The parts that are there, joined (a part left out is anything but a non-empty string). */
const list = (xs: unknown[], sep = ', ') => xs.filter((v): v is string => typeof v === 'string' && v.length > 0).join(sep);

/**
 * The profile the AI reads, a line per part. With `cloud`, what identifies the computer or the person stays
 * behind: serial numbers, its name, the account, network addresses and the Wi-Fi network's name.
 */
export function computerProfile(f: ComputerFacts, o: { cloud: boolean }): string {
  const i = f.inventory;
  const local = !o.cloud;
  const lines: string[] = [];
  if (i) {
    // A virtual machine often calls itself one: said once.
    const named = list([i.system.manufacturer, i.system.model], ' ');
    const model = i.system.virtual && /virtual/i.test(named) ? null : q(named, 60);
    lines.push(`- Computer: ${list([model ?? (i.system.virtual ? null : 'model not reported'), i.system.kind && !i.system.virtual && `a ${String(profileName(i.system.kind, 24)).toLowerCase()}`, i.system.virtual && 'a virtual machine', local && i.system.serial && `serial ${q(i.system.serial, 32)}`])}`);
    lines.push(`- System: ${list([list([profileName(i.os.name, 40), profileName(i.os.version, 24), i.os.build && `(build ${profileName(i.os.build, 24)})`], ' '), profileName(i.os.arch, 12), local && `computer name ${q(i.os.hostname, 40)}`, local && f.user && `signed in as ${q(f.user, 32)}`])}`);
    lines.push(`- Processor: ${list([q(i.cpu.name, 60), i.cpu.cores && `${i.cpu.cores} cores`, i.cpu.threads && `${i.cpu.threads} threads`, i.cpu.maxGHz && `up to ${i.cpu.maxGHz} GHz`])}`);
    const mods = i.memory.modules;
    lines.push(`- Memory: ${size(i.memory.totalBytes)}${mods.length ? ` (${list([`${mods.length}${i.memory.slots ? ` of ${i.memory.slots}` : ''} slots used`, profileName(mods[0]?.type, 12), mods[0]?.mhz && `${mods[0].mhz} MHz`])})` : ''}`);
    const screens = i.displays.slice(0, 4).map((x) => list([x.width && x.height && `${x.width}×${x.height}`, x.hz && `at ${x.hz} Hz`, x.main && '(main)'], ' ')).filter(Boolean);
    const shown = i.displays.length ? `${i.displays.length} screen${i.displays.length === 1 ? '' : 's'}${screens.length ? `: ${screens.join(', ')}` : ''}` : 'no screens reported';
    lines.push(`- Graphics: ${list([...i.graphics.slice(0, 3).map((g) => list([q(g.name, 48), g.vramMB && size(g.vramMB * 1024 ** 2)], ' ')), shown])}`);
    const drives = i.drives.slice(0, 6).map((d) => list([size(d.bytes), profileName(d.kind, 16), d.health && `(health ${profileName(d.health, 16)})`], ' '));
    const volumes = i.volumes.slice(0, 6).map((v) => `${profileName(v.mount, 24)} had ${size(v.bytes - v.usedBytes)} free of ${size(v.bytes)}`);
    lines.push(`- Storage: ${list([drives.length ? drives.join(', ') : null, volumes.length ? `when learned, ${volumes.join(', ')}` : null], '; ') || 'not reported'}`);
    lines.push(`- Battery: ${i.battery ? list([i.battery.healthPct && `health ${i.battery.healthPct}% of new`, i.battery.cycles && `${i.battery.cycles} cycles`]) || 'yes' : 'none (runs on mains power)'}`);
  }
  const n = f.network;
  if (n) {
    const kind = n.kind === 'wifi' ? 'Wi-Fi' : n.kind === 'ethernet' ? 'Ethernet (cable)' : n.kind === 'other' ? 'connected' : 'none';
    const on = n.connected ? 'connected' : 'not connected';
    lines.push(
      `- Network: ${list([
        n.kind === 'wifi' && local && n.ssid ? `${kind} ${q(n.ssid, 32)}` : kind,
        n.kind !== 'none' && on,
        local && n.ip && `address ${profileName(n.ip, 40)}`,
        local && n.gateway && `router ${profileName(n.gateway, 40)}`,
        local && n.dns.length && `DNS ${n.dns.slice(0, 3).map((d) => profileName(d, 40)).join(', ')}`,
        n.adapters > 1 && `${n.adapters} adapters with an address`,
        n.vpn && 'a VPN is on',
      ])}`,
    );
  }
  const x = f.fbrx;
  if (x) {
    lines.push(`- FBRX: ${list([`FBRX OS ${x.version}`, x.edition, x.mode === 'advanced' ? 'the Advanced menu' : 'the Simple menu', x.persona && `persona ${q(x.persona, 40)}`, x.kits.length && `toolkits ${x.kits.slice(0, 6).join(', ')}`, `${x.tools} tools`, x.newChatsOffline && 'new chats start offline'])}`);
  }
  if (f.agent) lines.push(`- You: ${list([q(f.agent.label, 48), `running on ${f.agent.where}`], ' ')}`);
  // Within PROFILE_MAX_CHARS, whatever the hardware reports: whole lines, the last ones left out first.
  const kept: string[] = [];
  for (const l of lines) {
    if ([...kept, l].join('\n').length > PROFILE_MAX_CHARS - 2) break;
    kept.push(l);
  }
  return kept.length < lines.length ? `${kept.join('\n')}\n…` : kept.join('\n');
}

/** One line about the computer, for the person: "A Dell XPS 13 laptop with Windows 11, 16 GB of memory and 120 GB free, on Wi-Fi." */
export function computerSummary(f: ComputerFacts): string {
  const i = f.inventory;
  if (!i) return 'This computer, as FBRX could read it.';
  const named = profileName(list([i.system.manufacturer, i.system.model], ' '), 40);
  const model = i.system.virtual && named && /virtual/i.test(named) ? null : named;
  const kind = i.system.virtual ? 'virtual machine' : (profileName(i.system.kind, 20)?.toLowerCase() ?? 'computer');
  const main = i.volumes.find((v) => /^(c:|\/)\\?$/i.test(v.mount)) ?? i.volumes[0];
  const said = [profileName(list([i.os.name, i.os.version], ' '), 40), `${size(i.memory.totalBytes)} of memory`, main ? `${size(main.bytes - main.usedBytes)} free` : null].filter((v): v is string => !!v);
  const tail = said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said.at(-1)}` : (said[0] ?? '');
  const net = f.network?.connected ? (f.network.kind === 'wifi' ? ', on Wi-Fi' : f.network.kind === 'ethernet' ? ', on a cable' : '') : '';
  return `${model && !/^(computer|virtual machine)$/.test(kind) ? `A ${model} ${kind}` : model ? `A ${model}` : `A ${kind}`}${tail ? ` with ${tail}` : ''}${net}.`;
}

/**
 * What the learning screen says while it works, a few seconds each, in turn. FBRX's own jokes: no characters, shows or
 * brands of anyone else's.
 */
export const LEARNING_QUIPS: readonly string[] = [
  'Learning the hyperdrives…',
  'Counting the cores. Then counting them again…',
  'Asking the router nicely…',
  'Reading the fine print on the BIOS…',
  'Saying hello to every USB port…',
  'Memorizing the memory…',
  'Measuring the gigabytes with a very small ruler…',
  'Introducing myself to the graphics card…',
  'Polishing the pixels…',
  'Checking under the keyboard for crumbs…',
  'Teaching the fans to hum in tune…',
  'Charting the hyperlanes of your file system…',
  'Sorting the ones from the zeros…',
  'Finding out where the Wi-Fi likes to hide…',
  'Shaking hands with the hard drive…',
  'Warming up the neurons…',
  'Untangling the cables (the virtual ones)…',
  'Reading the manual so you don’t have to…',
  'Stretching before the heavy lifting…',
  'Learning which way the bits flow…',
  'Tuning the antennas…',
  'Folding bits into neat little bytes…',
  'Looking for the any key…',
  'Charging the lasers (they’re just for show)…',
  'Counting pixels, rounding to the nearest million…',
  'Making friends with the battery…',
  'Plotting a course to the processor…',
  'Engaging the hyperdrive in 3… 2…',
];

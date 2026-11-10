import { SKILL_LIMITS, newId, principleProblem, type Skill } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { MetaStore } from '../storage/meta';
import { aboutOwnWork, requestWords } from './request-words';

/**
 * Fabrix's skills (see @fbrx/shared skills.ts): the starter ones FBRX comes with, the ones it learned with the person's
 * approval, and the person's own, kept on this computer. The skills that fit a request (by the words they share with
 * it) go to the model with the message, so even a small model follows steps that worked before.
 */

const SAVED = 'ai.skills';
const STARTER_STATE = 'ai.skills.starter';
/** At most this many skills go with one request. */
const PER_REQUEST = 2;

type Starter = Pick<Skill, 'id' | 'name' | 'when' | 'steps'> & {
  keywords: string[];
  /** It looks after the computer or the network: for a question about the person's own notes or tasks, it needs more. */
  fix?: true;
};

/** The starter library: everyday jobs, with the tools FBRX has for them. */
export const STARTER_SKILLS: Starter[] = [
  {
    id: 'skill_wifi',
    name: 'Slow or dropping Wi-Fi',
    fix: true,
    when: 'The Wi-Fi is slow, keeps dropping, or the signal is weak in a room.',
    keywords: ['wifi', 'wi-fi', 'wireless', 'signal', 'router', 'channel', 'internet', 'drop', 'disconnect', 'buffer', 'lag'],
    steps: [
      'net.wifi_channels: the signal (dBm), band and channel of this network, and how crowded the channels are.',
      'A signal weaker than -70 dBm means distance is the problem: suggest moving closer, or a mesh node or access point nearer the room, before any channel change.',
      "When the channel is crowded, give the planner's best channel and how to change it in the router's settings (the router's address is in the report).",
      'net.ping the router and 1.1.1.1 and compare: slow to both is the Wi-Fi, slow only past the router is the internet. Offer net.speed_test (it uses about 100 MB).',
      'Sum up what is wrong (signal, crowding, the router or the internet provider) and the one or two things to do first.',
    ],
  },
  {
    id: 'skill_troubleshoot',
    name: 'Troubleshoot the network',
    fix: true,
    when: 'The person asks to troubleshoot the network, or the internet is down, slow or acting up for every device.',
    keywords: ['troubleshoot', 'troubleshooting', 'network', 'internet', 'outage', 'gate', 'minidome', 'firewall', 'diagnose'],
    steps: [
      'kit.check_the_internet: the router, the internet past it, then names (DNS), in that order. Where it first fails is where to look.',
      "server.network_check, when an FBRX Server lets you look: FBRX Gate's internet side (link, address, router), a change waiting to be confirmed (it rolls back by itself), DNS and DHCP, problems it found; and MiniDome's sensors and worst open findings.",
      'When names fail but addresses work: kit.dns_servers, then kit.look_up_a_name on the site in question.',
      'Only this computer affected: kit.my_ip_address (no address or a 169.254 one means DHCP failed; offer kit.get_a_fresh_address) and, on Wi-Fi, net.wifi_channels.',
      'Say where it breaks (this computer, the Wi-Fi, the gate, or the internet provider) and the one or two things to do first; any fix asks the person before it runs.',
    ],
  },
  {
    id: 'skill_space',
    name: 'Free up disk space',
    fix: true,
    when: 'The disk is full or nearly full, or the person wants space back.',
    keywords: ['disk', 'space', 'storage', 'full', 'drive', 'free', 'clean', 'cleanup', 'room', 'gigabyte'],
    steps: [
      'pc.storage_report: how full each drive is, and what temporary files, Downloads and the Recycle Bin hold.',
      'pc.space_hogs: caches, AI models, games and backups that take the most.',
      'Offer what is safe first: pc.clean_temp (temporary files older than a day), and clearing caches in Storage → Space hogs (they come back by themselves).',
      "For the person's own files (Downloads, videos, old installers), name the biggest and ask before anything moves; never delete them yourself.",
      'Say how much was freed and what else could go, and point to Storage → Space map to look further.',
    ],
  },
  {
    id: 'skill_slow',
    name: 'Computer feels slow',
    fix: true,
    when: 'The computer is slow, freezes, or the fan runs loud.',
    keywords: ['slow', 'sluggish', 'laggy', 'freeze', 'freezing', 'hang', 'performance', 'fan', 'hot', 'cpu', 'memory'],
    steps: [
      'pc.live_status: processor, memory and temperature now and over five minutes.',
      'system.processes: what takes the most processor and memory.',
      'fbrx.doctor: FBRX\'s own checks (a model too big for the memory, a scan running…); fbrx.fix for what it offers, after asking.',
      'pc.pending_updates and pc.event_errors: a restart waiting, or errors piling up.',
      'Give the main cause and the fixes in order of effort; ask before ending a process or running a fix.',
    ],
  },
  {
    id: 'skill_security',
    name: 'Security check-up',
    fix: true,
    when: 'The person wants to know whether the computer is safe, or thinks something is wrong.',
    keywords: ['secure', 'security', 'safe', 'virus', 'malware', 'hacked', 'protect', 'antivirus', 'firewall', 'checkup', 'phishing', 'suspicious'],
    steps: [
      'pc.security_status: antivirus, firewall and updates.',
      "shield.status: FBRX Shield's findings and quarantine.",
      'pc.pending_updates: security updates waiting.',
      'alerts.recent: security alerts lately.',
      'A link they clicked or were sent: net.check_link on it (where it really goes, look-alike names, how new the domain is).',
      'Say what is fine and what needs doing, the most important first; offer shield.scan when anything looks off.',
    ],
  },
  {
    id: 'skill_network_map',
    name: "What's on my network",
    fix: true,
    when: 'The person wants to see the devices on their network, or spotted one they do not know.',
    keywords: ['network', 'device', 'devices', 'scan', 'lan', 'connected', 'unknown', 'router', 'who'],
    steps: [
      'net.scan_lan: the devices on the network, with their makers and open ports.',
      'Point out what stands out: a maker nobody recognizes, remote-access ports open (Telnet 23, RDP 3389, SMB 445), a second router (double NAT).',
      'net.port_check or net.ping on anything the person asks about.',
      'Sum up in plain words, and suggest Network Center → Devices to save the scan and compare it later.',
    ],
  },
  {
    id: 'skill_day',
    name: 'Plan my day',
    when: 'The person asks what is on today, or wants help planning the day.',
    keywords: ['plan', 'day', 'today', 'schedule', 'agenda', 'priorities', 'morning'],
    steps: [
      'calendar.agenda: what is on today.',
      'workspace.list_tasks: open tasks, due ones first.',
      'calendar.free_time: the free stretches.',
      'Propose an order that fits the tasks into the free time; add or change tasks (workspace.add_task, workspace.update_task) only when asked.',
    ],
  },
];

const STOP = new Set(
  'the and for with that this what why how can you your yours please help are was were from into have has had not but out about there their they them then than when where which while would could should just like make get got its it’s our ours very also some any all something thing things feel feels keep keeps really still again much many off way'.split(' '),
);
const stem = (w: string) => (w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w);
/** The words of a text that say what it is about: lower case, three letters or more, common words left out. */
const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/wi-fi/g, 'wifi')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map(stem),
  );

export class SkillStore {
  constructor(private readonly d: { meta: MetaStore; events?: EventBus; now?: () => Date }) {}

  private now() {
    return (this.d.now?.() ?? new Date()).toISOString();
  }

  private saved(): Skill[] {
    return this.d.meta.get<Skill[]>(SAVED) ?? [];
  }

  private starterState(): Record<string, { enabled?: boolean; uses?: number; lastUsedAt?: string | null }> {
    return this.d.meta.get<Record<string, { enabled?: boolean; uses?: number; lastUsedAt?: string | null }>>(STARTER_STATE) ?? {};
  }

  private changed() {
    this.d.events?.emit('skills.changed', { count: this.list().length });
  }

  /** Every skill: the starter ones first, then the learned and your own, newest first. */
  list(): Skill[] {
    const state = this.starterState();
    const starters = STARTER_SKILLS.map(({ keywords: _k, fix: _f, ...s }): Skill => ({ ...s, source: 'starter', enabled: state[s.id]?.enabled ?? true, uses: state[s.id]?.uses ?? 0, createdAt: '', updatedAt: '', lastUsedAt: state[s.id]?.lastUsedAt ?? null }));
    return [...starters, ...this.saved().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))];
  }

  /** Saves a skill (one with the same name is updated): learned by Fabrix, or written by the person. */
  save(input: { id?: string; name: string; when: string; steps: string[]; source: 'learned' | 'yours' }): Skill {
    const name = input.name.trim().slice(0, SKILL_LIMITS.name);
    const when = input.when.trim().slice(0, SKILL_LIMITS.when);
    const steps = input.steps.map((s) => s.trim().slice(0, SKILL_LIMITS.step)).filter(Boolean).slice(0, SKILL_LIMITS.steps);
    if (!name || !steps.length) throw new CoreError('INVALID_ARGUMENT', 'A skill needs a name and at least one step');
    if (STARTER_SKILLS.some((s) => s.id === input.id)) throw new CoreError('INVALID_ARGUMENT', 'Starter skills can be turned off, not changed');
    // A skill's steps go to the AI to follow: they cannot carry a change to FBRX's core principles.
    for (const line of [name, when, ...steps]) {
      const against = principleProblem(line);
      if (against) throw new CoreError('FORBIDDEN', `FBRX's core principles are fixed, so a skill cannot hold ${against}`);
    }
    const all = this.saved();
    const at = this.now();
    const same = all.find((s) => (input.id ? s.id === input.id : s.name.toLowerCase() === name.toLowerCase()));
    const skill: Skill = same
      ? { ...same, name, when, steps, updatedAt: at }
      : { id: newId('skill'), name, when, steps, source: input.source, enabled: true, uses: 0, createdAt: at, updatedAt: at, lastUsedAt: null };
    this.d.meta.set(SAVED, [skill, ...all.filter((s) => s !== same)]);
    this.changed();
    return skill;
  }

  setEnabled(id: string, enabled: boolean): Skill {
    if (STARTER_SKILLS.some((s) => s.id === id)) {
      const state = this.starterState();
      this.d.meta.set(STARTER_STATE, { ...state, [id]: { ...state[id], enabled } });
    } else {
      const all = this.saved();
      if (!all.some((s) => s.id === id)) throw new CoreError('NOT_FOUND', 'That skill is gone');
      this.d.meta.set(SAVED, all.map((s) => (s.id === id ? { ...s, enabled, updatedAt: this.now() } : s)));
    }
    this.changed();
    return this.list().find((s) => s.id === id)!;
  }

  remove(id: string): boolean {
    if (STARTER_SKILLS.some((s) => s.id === id)) throw new CoreError('INVALID_ARGUMENT', 'Starter skills can be turned off, not removed');
    const all = this.saved();
    const kept = all.filter((s) => s.id !== id);
    this.d.meta.set(SAVED, kept);
    this.changed();
    return kept.length < all.length;
  }

  /**
   * The skills that fit a request, by the words they share with it: a word of the skill's name or of its keywords
   * counts 2, one of its "when" 1. A skill needs 2, and goes along only when it fits nearly as well as the best one.
   */
  match(text: string, limit = PER_REQUEST): Skill[] {
    // Only what the request asks: not a name in quotes, the content to save, or the subject of the person's notes.
    const asked = words(requestWords(text));
    if (!asked.size) return [];
    const own = aboutOwnWork(text);
    const keywords = new Map(STARTER_SKILLS.map((s) => [s.id, s.keywords]));
    const fixes = new Set(STARTER_SKILLS.filter((s) => s.fix).map((s) => s.id));
    const scored = this.list()
      .filter((s) => s.enabled)
      .map((s) => {
        const strong = words([s.name, ...(keywords.get(s.id) ?? [])].join(' '));
        const about = words(s.when);
        let score = 0;
        for (const w of asked) score += strong.has(w) ? 2 : about.has(w) ? 1 : 0;
        return { s, score: own && fixes.has(s.id) ? score / 2 : score };
      })
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score || b.s.uses - a.s.uses);
    const best = scored[0]?.score ?? 0;
    return scored
      .filter((x) => x.score >= best * 0.75)
      .slice(0, limit)
      .map((x) => x.s);
  }

  /** What goes with a request: the skills that fit it, as steps to follow (and each is counted as used). */
  context(text: string): string | null {
    const found = this.match(text);
    if (!found.length) return null;
    this.used(found.map((s) => s.id));
    return found.map((s) => `### ${s.name}\nWhen: ${s.when}\n${s.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}`).join('\n\n');
  }

  private used(ids: string[]) {
    const at = this.now();
    const state = this.starterState();
    let starters = false;
    for (const id of ids.filter((x) => STARTER_SKILLS.some((s) => s.id === x))) {
      state[id] = { ...state[id], uses: (state[id]?.uses ?? 0) + 1, lastUsedAt: at };
      starters = true;
    }
    if (starters) this.d.meta.set(STARTER_STATE, state);
    const mine = ids.filter((x) => !STARTER_SKILLS.some((s) => s.id === x));
    if (mine.length) this.d.meta.set(SAVED, this.saved().map((s) => (mine.includes(s.id) ? { ...s, uses: s.uses + 1, lastUsedAt: at } : s)));
  }
}

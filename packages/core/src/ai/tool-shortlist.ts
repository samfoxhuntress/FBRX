import type { ToolSpec } from '../tools/types';
import { aboutOwnWork, requestWords } from './request-words';

/**
 * The tools a model on this computer (or on the local network) is given. Such a model reads every tool's definition
 * before each answer, and on a computer's processor that reading is most of the wait: all of FBRX's tools come to about
 * 6,500 tokens, a minute or more on a laptop before the first word, and more than a small model's context holds.
 *
 * It gets what the conversation is about instead: a few tools it always has, and each group whose words come up in what
 * the person asked in this chat, in the order they first came up. A new subject adds its tools at the end, so the start
 * of each request stays the same and the runtime reuses what it already read. A cloud model gets every tool.
 *
 * Only what a request asks counts (request-words.ts): not a name in quotes, the content to save, or the subject of the
 * person's notes ("my notes about the router" is about notes, not the router). A question about notes or tasks always
 * gets their own tools first, and troubleshooting groups go after the rest for it.
 */

/** Tools a local model always has: the time, its memory, and FBRX's own help and check-up. */
const ALWAYS = new Set(['time.now', 'plan.update', 'memory.remember', 'memory.recall', 'fbrx.help', 'fbrx.doctor', 'fbrx.fix']);

/** Matches a word that starts with one of these (case aside): "file" matches files and filename. */
const starts = (...stems: string[]) => new RegExp(`(?:^|[^a-z0-9])(?:${stems.join('|')})`, 'i');

/**
 * Each group of tools (by name) and the words that bring it in. `fix`: it looks after the computer or the network, so
 * for a question about the person's own notes, tasks or files it comes after the rest.
 */
const GROUPS: Array<{ tools: RegExp; words: RegExp; fix?: true }> = [
  { tools: /^(fs|files)\./, words: starts('file', 'folder', 'director', 'document', 'desktop', 'download', 'path', 'txt', 'csv', 'log', 'rename', 'attach') },
  { tools: /^(docs|image)\./, words: starts('pdf', 'docx', 'word doc', 'report', 'spreadsheet', 'excel', 'slide', 'markdown', 'html', 'picture', 'image', 'photo', 'draw', 'scene', 'cartoon', 'illustrat', 'storybook', 'comic', 'diagram', 'chart', 'graph', 'icon', 'logo', 'poster', 'flyer', 'letter', 'resume', 'invoice', 'make a', 'create a', 'write a') },
  { tools: /^(web|http|finance)\./, words: starts('http', 'www', 'web', 'site', 'page', 'link', 'url', 'search', 'look up', 'lookup', 'news', 'latest', 'price', 'stock', 'quote', 'ticker', 'market', 'weather', 'online', 'internet', 'article') },
  { tools: /^(net|server)\./, words: starts('troubleshoot', 'gate', 'minidome', 'network', 'wifi', 'wi-fi', 'internet', 'ping', 'dns', 'router', 'ip(?![a-z0-9])', 'ipv', 'ipconfig', 'ifconfig', 'mac address', 'gateway', 'subnet', 'adapter', 'ethernet', 'port', 'speed', 'latency', 'lag', 'trace', 'connect', 'lan', 'offline'), fix: true },
  { tools: /^(network_env|device_console)\./, words: starts('unifi', 'controller', 'access point', 'switch', 'firewall', 'vlan', 'ssh', 'console', 'device', 'guest', 'client', 'wlan'), fix: true },
  { tools: /^(system|pc|shell|alerts)\./, words: starts('computer', 'pc', 'laptop', 'cpu', 'processor', 'ram', 'disk', 'drive', 'storage', 'space', 'slow', 'fan', 'hot', 'temperature', 'process', 'app', 'program', 'install', 'uninstall', 'update', 'command', 'terminal', 'powershell', 'shell', 'script', 'battery', 'startup', 'service', 'alert', 'clean', 'temp', 'cache', 'free up', 'running'), fix: true },
  { tools: /^shield\./, words: starts('virus', 'malware', 'scan', 'shield', 'threat', 'quarantine', 'infect', 'suspicious', 'ransom', 'phish', 'security', 'hack'), fix: true },
  { tools: /^workspace\./, words: starts('note', 'task', 'to-do', 'todo', 'project', 'snippet', 'remind', 'list', 'checklist') },
  { tools: /^calendar\./, words: starts('calendar', 'meeting', 'event', 'schedule', 'appointment', 'free time', 'busy', 'tomorrow', 'today', 'tonight', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'week', 'invite') },
  { tools: /^passwords\./, words: starts('password', 'sign-in', 'sign in', 'signin', 'login', 'log in', 'account', 'vault', '2fa', 'two-factor', 'credential', 'sign up', 'signup', 'register') },
  { tools: /^(mesh|helpdesk)\./, words: starts('mesh', 'other computer', 'another computer', 'help desk', 'helpdesk', 'ticket', 'it team', 'it support', 'admin') },
  { tools: /^skills\./, words: starts('skill', 'save this', 'save that', 'next time', 'same way', 'procedure', 'routine', 'what can you do', 'how you did') },
  { tools: /^toolkit\./, words: starts('toolkit', 'tool kit', 'build', 'save this', 'save that', 'next time', 'shortcut', 'command', 'what can you do') },
  { tools: /^memory\./, words: starts('remember', 'forget', 'memory', 'earlier', 'last time', 'you said', 'we talked', 'told you') },
  { tools: /^fbrx\./, words: starts('fbrx', 'setting', 'edition', 'audit') },
];
/** The tools a question about notes or tasks needs, ahead of every group (search, then add to it or make one). */
const LEAD: Array<{ words: RegExp; tools: string[] }> = [
  { words: starts('note'), tools: ['workspace.search_notes', 'workspace.create_note', 'workspace.append_note'] },
  { words: /(?:^|[^a-z0-9])(?:tasks?(?!\s*(?:manager|bar|scheduler))|to-?dos?)(?![a-z0-9])/i, tools: ['workspace.list_tasks', 'workspace.add_task', 'workspace.update_task'] },
];

/** More than this and a small model loses track of them (and the reading is long again). */
const MAX_TOOLS = 24;

/**
 * A tool from a plugin or connection (no group of its own) comes in when a whole word of its name or title comes up.
 * Not AI Toolkit actions: they come with the toolkit's own match (toolkit.ts), which the agent passes as `wanted`.
 */
function mentioned(t: ToolSpec, text: string): boolean {
  if (t.name.startsWith('kit.')) return false;
  const words = [t.name.split('.')[0], ...t.title.toLowerCase().split(/[^a-z0-9]+/)].filter((w) => w.length >= 4);
  const low = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return words.some((w) => low.includes(` ${w.replace(/_/g, ' ')} `) || low.includes(` ${w} `));
}

/**
 * The tools for a conversation, given what the person asked in it so far (oldest first), and the tools the skills that
 * go with the request name (so a small model can follow their steps).
 */
export function shortlistTools(tools: ToolSpec[], asked: string[], wanted: string[] = []): ToolSpec[] {
  const picked: ToolSpec[] = tools.filter((t) => ALWAYS.has(t.name) || wanted.includes(t.name));
  const add = (t: ToolSpec) => !picked.includes(t) && picked.push(t);
  const groupOf = (t: ToolSpec) => GROUPS.findIndex((g) => g.tools.test(t.name));
  const done = new Set<number>();
  for (const said of asked) {
    const text = requestWords(said);
    for (const l of LEAD) if (l.words.test(text)) tools.filter((t) => l.tools.includes(t.name)).forEach(add);
    // The groups this request brings in, in the order their words come up in it; for the person's own work, the
    // troubleshooting ones after the rest.
    const own = aboutOwnWork(said);
    const found = GROUPS.map((g, i) => ({ i, at: done.has(i) ? -1 : text.search(g.words) }))
      .filter((g) => g.at >= 0)
      .map((g) => ({ ...g, later: own && GROUPS[g.i].fix ? 1 : 0 }))
      .sort((a, b) => a.later - b.later || a.at - b.at);
    for (const { i } of found) {
      done.add(i);
      tools.filter((t) => groupOf(t) === i).forEach(add);
    }
    tools.filter((t) => groupOf(t) < 0 && mentioned(t, text)).forEach(add);
  }
  return picked.slice(0, MAX_TOOLS);
}

/** A tool's description cut to its first sentence (and a length), for a model that reads every word slowly. */
export function briefDescription(description: string, max = 240): string {
  const first = description.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? description;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

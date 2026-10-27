import type { ToolSpec } from '../tools/types';

/**
 * The tools a model on this computer (or on the local network) is given. Such a model reads every tool's definition
 * before each answer, and on a computer's processor that reading is most of the wait: all of FBRX's tools come to about
 * 6,500 tokens, a minute or more on a laptop before the first word, and more than a small model's context holds.
 *
 * It gets what the conversation is about instead: a few tools it always has, and each group whose words come up in what
 * the person asked in this chat, in the order they first came up. A new subject adds its tools at the end, so the start
 * of each request stays the same and the runtime reuses what it already read. A cloud model gets every tool.
 */

/** Tools a local model always has: the time, its memory, and FBRX's own help and check-up. */
const ALWAYS = new Set(['time.now', 'memory.remember', 'memory.recall', 'fbrx.help', 'fbrx.doctor', 'fbrx.fix']);

/** Matches a word that starts with one of these (case aside): "file" matches files and filename. */
const starts = (...stems: string[]) => new RegExp(`(?:^|[^a-z0-9])(?:${stems.join('|')})`, 'i');

/** Each group of tools (by name) and the words that bring it in. */
const GROUPS: Array<{ tools: RegExp; words: RegExp }> = [
  { tools: /^(fs|files)\./, words: starts('file', 'folder', 'director', 'document', 'desktop', 'download', 'path', 'txt', 'csv', 'log', 'rename', 'attach') },
  { tools: /^(docs|image)\./, words: starts('pdf', 'docx', 'word doc', 'report', 'spreadsheet', 'excel', 'slide', 'markdown', 'html', 'picture', 'image', 'photo', 'draw', 'diagram', 'chart', 'graph', 'icon', 'logo', 'poster', 'flyer', 'letter', 'resume', 'invoice', 'make a', 'create a', 'write a') },
  { tools: /^(web|http|finance)\./, words: starts('http', 'www', 'web', 'site', 'page', 'link', 'url', 'search', 'look up', 'lookup', 'news', 'latest', 'price', 'stock', 'quote', 'ticker', 'market', 'weather', 'online', 'internet', 'article') },
  { tools: /^net\./, words: starts('network', 'wifi', 'wi-fi', 'internet', 'ping', 'dns', 'router', 'ip ', 'ip address', 'port', 'speed', 'latency', 'lag', 'trace', 'connect', 'lan', 'offline') },
  { tools: /^(network_env|device_console)\./, words: starts('unifi', 'controller', 'access point', 'switch', 'firewall', 'vlan', 'ssh', 'console', 'device', 'guest', 'client', 'wlan') },
  { tools: /^(system|pc|shell|alerts)\./, words: starts('computer', 'pc', 'laptop', 'cpu', 'processor', 'ram', 'disk', 'drive', 'storage', 'space', 'slow', 'fan', 'hot', 'temperature', 'process', 'app', 'program', 'install', 'uninstall', 'update', 'command', 'terminal', 'powershell', 'shell', 'script', 'battery', 'startup', 'service', 'alert', 'clean', 'temp', 'cache', 'free up', 'running') },
  { tools: /^shield\./, words: starts('virus', 'malware', 'scan', 'shield', 'threat', 'quarantine', 'infect', 'suspicious', 'ransom', 'phish', 'security', 'hack') },
  { tools: /^workspace\./, words: starts('note', 'task', 'to-do', 'todo', 'project', 'snippet', 'remind', 'list', 'checklist') },
  { tools: /^calendar\./, words: starts('calendar', 'meeting', 'event', 'schedule', 'appointment', 'free time', 'busy', 'tomorrow', 'today', 'tonight', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'week', 'invite') },
  { tools: /^passwords\./, words: starts('password', 'sign-in', 'sign in', 'signin', 'login', 'log in', 'account', 'vault', '2fa', 'two-factor', 'credential', 'sign up', 'signup', 'register') },
  { tools: /^(mesh|helpdesk)\./, words: starts('mesh', 'other computer', 'another computer', 'help desk', 'helpdesk', 'ticket', 'it team', 'it support', 'admin') },
  { tools: /^memory\./, words: starts('remember', 'forget', 'memory', 'earlier', 'last time', 'you said', 'we talked', 'told you') },
  { tools: /^fbrx\./, words: starts('fbrx', 'setting', 'edition', 'audit') },
];
/** More than this and a small model loses track of them (and the reading is long again). */
const MAX_TOOLS = 24;

/** A tool from a plugin or connection (no group of its own) comes in when its name or title words come up. */
function mentioned(t: ToolSpec, text: string): boolean {
  const words = [t.name.split('.')[0], ...t.title.toLowerCase().split(/[^a-z0-9]+/)].filter((w) => w.length >= 4);
  const low = text.toLowerCase();
  return words.some((w) => low.includes(w.replace(/_/g, ' ')) || low.includes(w));
}

/** The tools for a conversation, given what the person asked in it so far (oldest first). */
export function shortlistTools(tools: ToolSpec[], asked: string[]): ToolSpec[] {
  const picked: ToolSpec[] = tools.filter((t) => ALWAYS.has(t.name));
  const add = (t: ToolSpec) => !picked.includes(t) && picked.push(t);
  const groupOf = (t: ToolSpec) => GROUPS.findIndex((g) => g.tools.test(t.name));
  const done = new Set<number>();
  for (const text of asked) {
    GROUPS.forEach((g, i) => {
      if (done.has(i) || !g.words.test(text)) return;
      done.add(i);
      tools.filter((t) => groupOf(t) === i).forEach(add);
    });
    tools.filter((t) => groupOf(t) < 0 && mentioned(t, text)).forEach(add);
  }
  return picked.slice(0, MAX_TOOLS);
}

/** A tool's description cut to its first sentence (and a length), for a model that reads every word slowly. */
export function briefDescription(description: string, max = 240): string {
  const first = description.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? description;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

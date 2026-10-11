import type {
  MeshMessage,
  MessagesOverview,
  MessageThread,
  OrgChatMessage,
  OrgChatState,
  ServerToDeviceMessage,
  Settings,
  ThreadMessage,
} from '@fbrx/shared';
import { MESSAGE_MAX_CHARS } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { EventBus } from '../events';
import type { FleetAgent } from '../fleet/fleet-agent';
import type { Logger } from '../logger';
import type { MeshService } from '../mesh/mesh-service';
import type { Db } from '../storage/db';

export interface MessagesDeps {
  db: Db;
  events: EventBus;
  log: Logger;
  mesh: MeshService;
  fleet: FleetAgent;
  settings: () => Settings['messages'];
  /** The mesh is on and listening. */
  meshOn: () => boolean;
  /** The person's name (or the computer's), on messages to the organization. */
  myName: () => string;
  /** `open`: the conversation a click on the notification opens. */
  notify: (title: string, body: string, open: string) => void;
}

/** Up to this many computers in an organization are listed by name; past that, conversations you have plus "New message". */
const LIST_ALL_UP_TO = 12;
const ORG_REFRESH_MS = 5 * 60_000;

const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows computer', darwin: 'Mac', linux: 'Linux computer' };
const deviceKind = (d: { kind?: string; platform: string }) => (d.kind === 'mobile' ? 'Phone' : (PLATFORM_NAMES[d.platform] ?? 'Computer'));

/**
 * Messages: one inbox for chatting with your own devices (FBRX Mesh, end to end between them) and with the computers
 * in your organization (FBRX Command passes those on and keeps them). Thread ids are "mesh:all", "mesh:<device>",
 * "org:all" and "org:<device>". It also decides about notifications, so the conversation on screen stays quiet.
 */
export class Messages {
  /** The conversation open on screen (no notification for it, and it is read as messages arrive). */
  private focused: string | null = null;
  private org: OrgChatState | null = null;
  private orgError: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: MessagesDeps) {
    d.events.on('mesh.message', (m) => this.onMesh(m));
  }

  start(): void {
    // What waits in the organization, so the sidebar can show it before Messages is opened.
    const tick = () => void this.refreshOrg().catch(() => undefined);
    setTimeout(tick, 5000).unref?.();
    this.timer = setInterval(tick, ORG_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------------------------------ reading

  async overview(): Promise<MessagesOverview> {
    const s = this.d.settings();
    const threads: MessageThread[] = [];
    if (!s.enabled) {
      return { enabled: false, threads, mesh: { on: false, devices: 0, note: 'Messages are turned off on this computer.' }, org: { on: false, name: null, note: null }, unread: 0 };
    }

    // Your mesh: everyone at once, then each device that takes messages.
    const meshOn = this.d.meshOn();
    const peers = meshOn ? this.d.mesh.devices().filter((x) => x.permissions.chat) : [];
    let meshNote: string | null = null;
    if (!meshOn) meshNote = 'Turn on FBRX Mesh (Mesh & phone) to message your other computers and your phone.';
    else if (peers.length === 0) meshNote = 'Pair your other computers or your phone (Mesh & phone) to message them.';
    if (meshOn) {
      const sums = new Map(this.d.mesh.threadSummaries((c) => this.readAt(`mesh:${c}`)).map((x) => [x.conversation, x]));
      const self = this.d.mesh.selfId;
      const last = (c: string) => {
        const x = sums.get(c);
        return { last: x ? { text: x.last.text, fromName: x.last.fromName, mine: x.last.fromId === self, at: x.last.at } : null, unread: x?.unread ?? 0 };
      };
      if (peers.length > 0 || sums.has('all')) {
        threads.push({ id: 'mesh:all', place: 'mesh', kind: 'group', title: 'Everyone on my mesh', subtitle: `${peers.length} device${peers.length === 1 ? '' : 's'}`, online: null, ...last('all'), cannotSend: peers.length ? null : 'No paired device takes messages yet' });
      }
      for (const p of peers) {
        threads.push({ id: `mesh:${p.id}`, place: 'mesh', kind: 'direct', title: p.name, subtitle: deviceKind(p), online: p.online, ...last(p.id), cannotSend: null });
      }
    }

    // Your organization.
    const fleet = this.d.fleet.status();
    let org: MessagesOverview['org'] = { on: false, name: fleet.tenantName ?? null, note: null };
    if (fleet.state === 'unenrolled') org.note = null;
    else if (!s.organization) org.note = fleet.lockedSettings.includes('messages.organization') ? 'Your organization keeps messages on this computer to your own devices.' : 'Messages with your organization are turned off (Settings → Messages).';
    else {
      await this.refreshOrg().catch(() => undefined);
      const st = this.org;
      if (!st) org.note = this.orgError ?? 'FBRX Command could not be reached';
      else if (!st.available) org = { on: false, name: st.organization, note: st.message };
      else {
        org = { on: true, name: st.organization, note: this.orgError };
        const conv = new Map(st.conversations.map((c) => [c.with, c]));
        const view = (w: string) => {
          const c = conv.get(w);
          return { last: c?.last ? { text: c.last.text, fromName: c.last.fromName, mine: c.last.fromDeviceId === st.me, at: c.last.at } : null, unread: c?.unread ?? 0 };
        };
        const n = st.peers.length + 1;
        threads.push({ id: 'org:all', place: 'org', kind: 'group', title: `Everyone at ${st.organization ?? 'your organization'}`, subtitle: `${n} computer${n === 1 ? '' : 's'}`, online: null, ...view('all'), cannotSend: null });
        const listed = st.peers.length <= LIST_ALL_UP_TO ? st.peers : st.peers.filter((p) => conv.has(p.deviceId));
        for (const p of listed) threads.push({ id: `org:${p.deviceId}`, place: 'org', kind: 'direct', title: p.name, subtitle: deviceKind(p), online: p.online, ...view(p.deviceId), cannotSend: null });
      }
    }
    return { enabled: true, threads, mesh: { on: meshOn, devices: peers.length, note: meshNote }, org, unread: threads.reduce((n, t) => n + t.unread, 0) };
  }

  /** Every computer in the organization (to start a conversation with one not listed). */
  async directory(): Promise<Array<{ id: string; title: string; subtitle: string; online: boolean }>> {
    const st = await this.refreshOrg();
    return st.available ? st.peers.map((p) => ({ id: `org:${p.deviceId}`, title: p.name, subtitle: deviceKind(p), online: p.online })) : [];
  }

  /** Unread messages everywhere, for the sidebar (the organization's count is the last one fetched). */
  unread(): number {
    const s = this.d.settings();
    if (!s.enabled) return 0;
    let n = 0;
    if (this.d.meshOn()) for (const x of this.d.mesh.threadSummaries((c) => this.readAt(`mesh:${c}`))) n += x.unread;
    if (s.organization && this.org?.available) for (const c of this.org.conversations) n += c.unread;
    return n;
  }

  async thread(id: string, opts: { before?: string; limit?: number } = {}): Promise<ThreadMessage[]> {
    this.enabled();
    const { place, other } = parseThread(id);
    if (place === 'mesh') {
      const self = this.d.mesh.selfId;
      return this.d.mesh.messages(other, opts).map((m) => this.fromMesh(m, self));
    }
    this.orgAllowed();
    const q = new URLSearchParams({ with: other, limit: String(opts.limit ?? 100), ...(opts.before ? { before: opts.before } : {}) });
    const rows = await this.d.fleet.request<OrgChatMessage[]>('GET', `/v1/device/chat/messages?${q}`);
    const me = this.d.fleet.deviceId;
    return rows.map((m) => fromOrg(m, me));
  }

  // ------------------------------------------------------------------------------------------ writing

  async send(id: string, text: string): Promise<ThreadMessage> {
    this.enabled();
    const t = text.trim();
    if (!t) throw new CoreError('INVALID_ARGUMENT', 'Type a message');
    if (t.length > MESSAGE_MAX_CHARS) throw new CoreError('INVALID_ARGUMENT', `Messages are up to ${MESSAGE_MAX_CHARS} characters`);
    const { place, other } = parseThread(id);
    let out: ThreadMessage;
    if (place === 'mesh') {
      if (!this.d.meshOn()) throw new CoreError('UNAVAILABLE', 'FBRX Mesh is off: turn it on under Mesh & phone');
      const r = await this.d.mesh.message(t, other === 'all' ? undefined : other);
      out = this.fromMesh(r.message, this.d.mesh.selfId);
    } else {
      this.orgAllowed();
      const m = await this.d.fleet.request<OrgChatMessage>('POST', '/v1/device/chat/messages', { to: other, text: t, fromName: this.d.myName() });
      out = fromOrg(m, this.d.fleet.deviceId);
      this.bumpOrg(m, 0);
    }
    this.markReadLocal(id);
    this.changed(id, out);
    return out;
  }

  /** Tries one of your mesh messages again. */
  async resend(messageId: string): Promise<ThreadMessage> {
    const m = await this.d.mesh.resend(messageId);
    return this.fromMesh(m, this.d.mesh.selfId);
  }

  async read(id: string): Promise<void> {
    const { place, other } = parseThread(id);
    this.markReadLocal(id);
    if (place === 'org' && this.d.fleet.enrolled) {
      const c = this.org?.conversations.find((x) => x.with === other);
      if (c) c.unread = 0;
      await this.d.fleet.request('POST', '/v1/device/chat/read', { with: other }).catch((err) => this.d.log.debug('Could not mark read', { error: errorMessage(err) }));
    }
    this.changed(id);
  }

  /** The conversation now on screen (null: none); it is marked read. */
  async focus(id: string | null): Promise<void> {
    this.focused = id;
    if (id) await this.read(id);
  }

  // ------------------------------------------------------------------------------------------ arriving

  /** A push from FBRX Command. */
  onPush(msg: ServerToDeviceMessage): void {
    if (msg.type !== 'chat.message') return;
    const s = this.d.settings();
    if (!s.enabled || !s.organization) return;
    const m = msg.message;
    const id = `org:${m.with}`;
    const seen = this.focused === id;
    this.bumpOrg(m, seen ? 0 : 1);
    if (seen) void this.read(id);
    else if (s.notify) this.d.notify(m.with === 'all' ? `${m.fromName} to everyone` : m.fromName, m.text.slice(0, 200), `messages/${id}`);
    this.changed(id, fromOrg(m, this.d.fleet.deviceId));
  }

  private onMesh(m: MeshMessage): void {
    let self: string;
    try {
      self = this.d.mesh.selfId;
    } catch {
      return;
    }
    const id = `mesh:${m.conversation ?? 'all'}`;
    if (m.fromId !== self) {
      const s = this.d.settings();
      if (this.focused === id) this.markReadLocal(id);
      else if (s.enabled && s.notify) this.d.notify(id === 'mesh:all' ? `${m.fromName} to your mesh` : `Message from ${m.fromName}`, m.text.slice(0, 200), `messages/${id}`);
    }
    this.changed(id, this.fromMesh(m, self));
  }

  // ------------------------------------------------------------------------------------------ helpers

  private async refreshOrg(): Promise<OrgChatState> {
    const s = this.d.settings();
    if (!this.d.fleet.enrolled || !s.enabled || !s.organization) throw new CoreError('UNAVAILABLE', 'This computer does not message its organization');
    try {
      const before = this.unreadOrg();
      this.org = await this.d.fleet.request<OrgChatState>('GET', '/v1/device/chat');
      this.orgError = null;
      if (this.unreadOrg() !== before) this.changed(null);
      return this.org;
    } catch (err) {
      // An older FBRX Command without Messages answers 404: say so plainly.
      this.orgError = err instanceof CoreError && err.code === 'NOT_FOUND' ? 'Your FBRX Command does not have Messages yet (update it)' : errorMessage(err);
      throw err;
    }
  }

  private unreadOrg(): number {
    return this.org?.available ? this.org.conversations.reduce((n, c) => n + c.unread, 0) : 0;
  }

  /** Keeps the cached organization list current as messages come and go. */
  private bumpOrg(m: OrgChatMessage, unread: number) {
    if (!this.org) return;
    const c = this.org.conversations.find((x) => x.with === m.with);
    if (c) {
      c.last = m;
      c.unread += unread;
    } else this.org.conversations.push({ with: m.with, last: m, unread });
  }

  private enabled() {
    if (!this.d.settings().enabled) throw new CoreError('FORBIDDEN', 'Messages are turned off on this computer');
  }

  private orgAllowed() {
    if (!this.d.settings().organization) throw new CoreError('FORBIDDEN', 'Messages with your organization are turned off on this computer');
  }

  private readAt(thread: string): string {
    return this.d.db.get<{ read_at: string }>('SELECT read_at FROM message_reads WHERE thread = ?', thread)?.read_at ?? '';
  }

  private markReadLocal(thread: string) {
    this.d.db.run('INSERT INTO message_reads (thread, read_at) VALUES (?, ?) ON CONFLICT (thread) DO UPDATE SET read_at = excluded.read_at', thread, new Date().toISOString());
  }

  private fromMesh(m: MeshMessage, self: string): ThreadMessage {
    const mine = m.fromId === self;
    return {
      id: m.id,
      threadId: `mesh:${m.conversation ?? 'all'}`,
      fromId: m.fromId,
      fromName: m.fromName,
      mine,
      text: m.text,
      at: m.at,
      ...(mine && m.state ? { state: m.state } : {}),
      ...(mine && m.error ? { error: m.error } : {}),
    };
  }

  private changed(threadId: string | null, message?: ThreadMessage) {
    this.d.events.emit('messages.changed', { threadId, message, unread: this.unread() });
  }
}

function parseThread(id: string): { place: 'mesh' | 'org'; other: string } {
  const m = /^(mesh|org):([\w.-]{1,80})$/.exec(id);
  if (!m) throw new CoreError('INVALID_ARGUMENT', 'Unknown conversation');
  return { place: m[1] as 'mesh' | 'org', other: m[2] };
}

function fromOrg(m: OrgChatMessage, me: string | null): ThreadMessage {
  return {
    id: m.id,
    threadId: `org:${m.with}`,
    fromId: m.fromDeviceId ?? 'admin',
    fromName: m.fromName,
    mine: !!me && m.fromDeviceId === me,
    ...(m.fromKind === 'admin' ? { fromAdmin: true } : {}),
    text: m.text,
    at: m.at,
  };
}

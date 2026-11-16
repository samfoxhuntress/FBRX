import { newId, REMOTE_LIMITS, remoteInputProblem, remoteWho, type RemoteFrame, type RemoteFrom, type RemoteInput, type RemoteMode, type RemoteSession } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { ScreenShare } from '../platform';

/**
 * This computer's side of remote view and control: one session at a time, asked of the person here (unless one of
 * their own computers was let in without asking), with a banner and Stop on the screen while it lasts. Pictures are
 * taken only when the viewer asks for one, so nothing runs while nobody looks; a session nobody asks anything of ends.
 * Every start, answer and end goes in the audit log.
 */

export interface ScreenHostDeps {
  share: () => ScreenShare | null;
  audit: (action: string, outcome: 'success' | 'denied' | 'failure', details: Record<string, unknown>) => void;
  /** Said once when a session ends that the person did not end themselves. */
  notify?: (title: string, body: string) => void;
  now?: () => number;
}

interface Live {
  session: RemoteSession;
  lastAsked: number;
  seq: number;
  frame: RemoteFrame | null;
  frameAt: number;
  display: number;
  capturing: Promise<RemoteFrame | null> | null;
  inputUsed: boolean;
}

/** At most this many pictures a second, whatever the viewer asks. */
const MIN_FRAME_MS = 150;

export class ScreenHost {
  private live: Live | null = null;
  private ended: RemoteSession[] = [];
  private idle: NodeJS.Timeout | null = null;

  constructor(private readonly d: ScreenHostDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  private share(): ScreenShare {
    const s = this.d.share();
    if (!s) throw new CoreError('UNAVAILABLE', 'This computer cannot share its screen (FBRX runs without a desktop here)');
    return s;
  }

  /** The current or last session, as both sides see it. */
  session(id: string): RemoteSession {
    if (this.live?.session.id === id) {
      this.live.lastAsked = this.now();
      return this.live.session;
    }
    const s = this.ended.find((x) => x.id === id);
    if (!s) throw new CoreError('NOT_FOUND', 'That screen session is over');
    return s;
  }

  current(): RemoteSession | null {
    return this.live?.session ?? null;
  }

  /**
   * Someone asks to see (or use) this screen. With `unattended` (one of the person's own computers they let in) it
   * starts at once; otherwise the person here is asked. Returns at once, asking or live; the viewer polls session().
   */
  async request(from: RemoteFrom, asked: RemoteMode, o: { unattended: boolean }): Promise<RemoteSession> {
    const share = this.share();
    if (this.live && this.live.session.state !== 'ended') throw new CoreError('CONFLICT', `${remoteWho(this.live.session.viewer)} is already ${this.live.session.state === 'asking' ? 'asking to see' : 'seeing'} this screen`);
    const control = await share.canControl().catch((e) => ({ ok: false, why: errorMessage(e) }));
    const first = await share.capture({ display: 0, maxWidth: 320, quality: 40 }).catch(() => null);
    if (!first) throw new CoreError('UNAVAILABLE', 'This computer does not let FBRX see its screen: allow screen recording for FBRX in the system settings');
    const session: RemoteSession = {
      id: newId('scr'),
      viewer: from,
      asked,
      mode: asked === 'control' && !control.ok ? 'view' : asked,
      state: o.unattended ? 'live' : 'asking',
      unattended: o.unattended,
      startedAt: new Date(this.now()).toISOString(),
      endedAt: null,
      why: null,
      displays: first.displays,
      control,
    };
    this.live = { session, lastAsked: this.now(), seq: 0, frame: null, frameAt: 0, display: 0, capturing: null, inputUsed: false };
    this.d.audit('screen.requested', 'success', { session: session.id, who: remoteWho(from), kind: from.kind, asked, ticket: from.ticket ?? null, reason: from.reason ?? null, unattended: o.unattended });
    this.watchIdle();
    if (o.unattended) this.goLive(session);
    else void this.ask(session);
    return session;
  }

  private async ask(session: RemoteSession) {
    let answer: RemoteMode | 'deny';
    try {
      answer = await this.share().ask({ who: remoteWho(session.viewer), asked: session.mode, ticket: session.viewer.ticket ?? null, reason: session.viewer.reason ?? null, timeoutMs: REMOTE_LIMITS.askMs });
    } catch {
      answer = 'deny';
    }
    if (this.live?.session !== session || session.state !== 'asking') return;
    if (answer === 'deny') {
      this.finish(session, 'denied', 'The person at the computer said no (or did not answer)', 'person');
      return;
    }
    // The person may narrow control to view only, never widen it.
    session.mode = session.mode === 'control' && answer === 'control' ? 'control' : 'view';
    this.goLive(session);
  }

  private goLive(session: RemoteSession) {
    session.state = 'live';
    this.d.audit('screen.started', 'success', { session: session.id, who: remoteWho(session.viewer), mode: session.mode, unattended: session.unattended });
    this.share().banner({ who: remoteWho(session.viewer), mode: session.mode }, () => this.end(session.id, 'person'));
  }

  private watchIdle() {
    if (this.idle) return;
    this.idle = setInterval(() => {
      const l = this.live;
      if (!l) return;
      if (this.now() - l.lastAsked > REMOTE_LIMITS.idleMs + (l.session.state === 'asking' ? REMOTE_LIMITS.askMs : 0)) this.finish(l.session, 'ended', 'The viewer went away', 'timeout');
    }, 5_000);
    this.idle.unref?.();
  }

  private finish(session: RemoteSession, state: 'ended' | 'denied', why: string, by: 'person' | 'viewer' | 'timeout') {
    if (session.state === 'ended' || session.state === 'denied') return;
    const wasLive = session.state === 'live';
    session.state = state;
    session.why = why;
    session.endedAt = new Date(this.now()).toISOString();
    const l = this.live;
    this.d.audit(state === 'denied' ? 'screen.denied' : 'screen.ended', state === 'denied' ? 'denied' : 'success', {
      session: session.id,
      who: remoteWho(session.viewer),
      by,
      mode: session.mode,
      inputUsed: l?.session === session ? l.inputUsed : false,
      seconds: Math.round((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000),
    });
    if (l?.session === session) this.live = null;
    this.ended = [session, ...this.ended].slice(0, 20);
    if (wasLive) this.d.share()?.banner(null, () => undefined);
    if (wasLive && by === 'timeout') this.d.notify?.('Screen sharing ended', `${remoteWho(session.viewer)} stopped asking for your screen.`);
    if (!this.live && this.idle) {
      clearInterval(this.idle);
      this.idle = null;
    }
  }

  private liveSession(id: string): Live {
    const l = this.live;
    if (!l || l.session.id !== id) throw new CoreError('NOT_FOUND', 'That screen session is over');
    if (l.session.state !== 'live') throw new CoreError('CONFLICT', l.session.state === 'asking' ? 'Waiting for the person at the computer to say yes' : 'That screen session is over');
    l.lastAsked = this.now();
    return l;
  }

  /** The newest picture of the screen (a new one at most every 150 ms); `after` skips one the viewer already has. */
  async frame(id: string, o: { after?: number; display?: number; maxWidth?: number } = {}): Promise<RemoteFrame | null> {
    const l = this.liveSession(id);
    if (o.display !== undefined) {
      if (!Number.isInteger(o.display) || o.display < 0 || o.display >= Math.max(1, l.session.displays)) throw new CoreError('INVALID_ARGUMENT', 'There is no such screen');
      l.display = o.display;
    }
    const fresh = l.frame && l.frame.display === l.display && this.now() - l.frameAt < MIN_FRAME_MS;
    if (!fresh) {
      l.capturing ??= this.share()
        .capture({ display: l.display, maxWidth: Math.min(Math.max(o.maxWidth ?? 1600, 320), 2560), quality: 60 })
        .then((c) => {
          if (!c) return l.frame;
          l.seq += 1;
          l.session.displays = c.displays;
          l.frame = { seq: l.seq, width: c.width, height: c.height, jpeg: c.jpeg.toString('base64'), display: l.display, displays: c.displays };
          l.frameAt = this.now();
          return l.frame;
        })
        .finally(() => (l.capturing = null));
      await l.capturing;
    }
    if (!l.frame || (o.after !== undefined && l.frame.seq <= o.after)) return null;
    return l.frame;
  }

  /** Mouse and keyboard, when the session allows control. */
  async input(id: string, events: RemoteInput[]): Promise<{ ok: true }> {
    const l = this.liveSession(id);
    if (l.session.mode !== 'control') throw new CoreError('FORBIDDEN', 'This session is view only');
    const problem = remoteInputProblem(events);
    if (problem) throw new CoreError('INVALID_ARGUMENT', problem);
    l.inputUsed = true;
    await this.share().input(events, l.display);
    return { ok: true };
  }

  /** Either side ends it. */
  end(id: string, by: 'person' | 'viewer'): RemoteSession {
    const l = this.live;
    if (!l || l.session.id !== id) return this.session(id);
    this.finish(l.session, 'ended', by === 'person' ? 'The person at the computer stopped it' : 'The viewer ended it', by);
    return l.session;
  }

  stop() {
    if (this.live) this.finish(this.live.session, 'ended', 'FBRX stopped', 'person');
  }
}

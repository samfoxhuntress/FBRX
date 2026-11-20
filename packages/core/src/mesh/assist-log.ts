import { ASSIST_LOG_DAYS, ASSIST_TERMINAL, type AssistLogEntry, type AssistLogQuery, type AssistRequester, type AssistSession, type AssistTally } from '@fbrx/shared';
import type { Db, SqlParam } from '../storage/db';

/**
 * Mesh Assist's log: every request this computer served for another (and asked of one), kept for ASSIST_LOG_DAYS
 * with the computer and the person who asked, so administrators look back by computer and by person. A request is
 * written when it arrives and again at each change. What was asked is kept; the answer stays in its conversation, and
 * the log notes only how long it was.
 */
interface Row {
  id: string;
  direction: 'in' | 'out';
  peer_id: string;
  peer_name: string;
  person_name: string | null;
  person_email: string | null;
  person_user: string | null;
  kind: AssistLogEntry['kind'];
  trigger: AssistLogEntry['trigger'];
  priority: AssistLogEntry['priority'];
  status: AssistLogEntry['status'];
  goal: string;
  error: string | null;
  steps: number;
  tools: string;
  answer_chars: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancelled_by: string | null;
}

const job = (r: Row): AssistLogEntry => ({
  id: r.id,
  direction: r.direction,
  peerId: r.peer_id,
  peerName: r.peer_name,
  requester: r.person_name || r.person_email || r.person_user ? { name: r.person_name, email: r.person_email, user: r.person_user } : null,
  kind: r.kind,
  trigger: r.trigger,
  priority: r.priority,
  status: r.status,
  goal: r.goal,
  error: r.error,
  steps: r.steps,
  tools: JSON.parse(r.tools) as string[],
  answerChars: r.answer_chars,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  cancelledBy: r.cancelled_by,
});

/** A person's key in the tallies: their email, else their system user on the computer they asked from. */
const personKey = (r: { person_email: string | null; person_user: string | null; peer_name: string }) => r.person_email?.toLowerCase() ?? (r.person_user ? `${r.person_user}@${r.peer_name}` : `?@${r.peer_name}`);

const HOUR = 3_600_000;

export class AssistLog {
  private prunedAt = 0;

  constructor(private readonly db: Db) {}

  /** At start: requests the last run left unfinished did not get to the end, and say so. */
  interrupted(now = new Date()): number {
    const open = ['waiting-approval', 'queued', 'running'];
    return this.db.run(
      `UPDATE assist_jobs SET status = 'error', error = 'FBRX stopped before it finished', finished_at = ? WHERE status IN (${open.map(() => '?').join(',')})`,
      now.toISOString(),
      ...open,
    ).changes;
  }

  /** Writes a request as it is now. */
  record(s: AssistSession, now = Date.now()): void {
    const r: AssistRequester | null = s.requester;
    this.db.run(
      `INSERT INTO assist_jobs (id, direction, peer_id, peer_name, person_name, person_email, person_user, kind, trigger, priority, status, goal, error, steps, tools,
         answer_chars, created_at, started_at, finished_at, cancelled_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET peer_id = excluded.peer_id, peer_name = excluded.peer_name, priority = excluded.priority, status = excluded.status,
         goal = excluded.goal, error = excluded.error, steps = excluded.steps, tools = excluded.tools, answer_chars = excluded.answer_chars,
         started_at = excluded.started_at, finished_at = excluded.finished_at, cancelled_by = excluded.cancelled_by`,
      s.id,
      s.direction,
      s.peerId,
      s.peerName,
      r?.name ?? null,
      r?.email ?? null,
      r?.user ?? null,
      s.kind,
      s.trigger,
      s.priority,
      s.status,
      s.goal,
      s.error,
      s.steps,
      JSON.stringify(s.tools),
      s.answer.length,
      s.createdAt,
      s.startedAt,
      s.finishedAt,
      s.cancelledBy,
    );
    if (now - this.prunedAt > HOUR) this.prune(now);
  }

  /** Forgets finished requests older than ASSIST_LOG_DAYS. */
  prune(now = Date.now()): number {
    this.prunedAt = now;
    const before = new Date(now - ASSIST_LOG_DAYS * 24 * HOUR).toISOString();
    return this.db.run(`DELETE FROM assist_jobs WHERE created_at < ? AND status IN (${ASSIST_TERMINAL.map(() => '?').join(',')})`, before, ...ASSIST_TERMINAL).changes;
  }

  /** Requests, newest first, narrowed by direction, status, computer, person, words and time. */
  list(q: AssistLogQuery = {}): AssistLogEntry[] {
    const where: string[] = [];
    const args: SqlParam[] = [];
    const add = (sql: string, ...v: SqlParam[]) => {
      where.push(sql);
      args.push(...v);
    };
    if (q.direction) add('direction = ?', q.direction);
    if (q.status) add('status = ?', q.status);
    if (q.peerId) add('peer_id = ?', q.peerId);
    if (q.person) {
      const at = q.person.lastIndexOf('@');
      // An email, or "user@computer" as the tallies key a person without one.
      add('(lower(person_email) = lower(?) OR (person_email IS NULL AND person_user = ? AND peer_name = ?))', q.person, at > 0 ? q.person.slice(0, at) : q.person, at > 0 ? q.person.slice(at + 1) : '');
    }
    if (q.text) add("goal LIKE ? ESCAPE '\\'", `%${q.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    if (q.since) add('created_at >= ?', q.since);
    if (q.before) add('created_at < ?', q.before);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    return this.db
      .all<Row>(`SELECT * FROM assist_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${limit}`, ...args)
      .map(job);
  }

  /** What each computer, or each person, asked for (help given here unless "out"), most recent first. */
  tally(by: 'device' | 'person', q: { direction?: 'in' | 'out'; since?: string } = {}): AssistTally[] {
    const rows = this.db.all<Row>('SELECT * FROM assist_jobs WHERE direction = ? AND created_at >= ? ORDER BY created_at DESC', q.direction ?? 'in', q.since ?? '');
    const out = new Map<string, AssistTally>();
    for (const r of rows) {
      const key = by === 'device' ? r.peer_id : personKey(r);
      let t = out.get(key);
      if (!t) {
        const who = r.person_name || r.person_email || r.person_user;
        t = {
          key,
          label: by === 'device' ? r.peer_name : (who ?? `Someone on ${r.peer_name}`),
          detail: by === 'device' ? null : r.person_email ? r.person_email : `${r.person_user ?? 'unknown user'} on ${r.peer_name}`,
          jobs: 0,
          done: 0,
          failed: 0,
          cancelled: 0,
          denied: 0,
          runMs: 0,
          lastAt: r.created_at,
        };
        out.set(key, t);
      }
      t.jobs++;
      if (r.status === 'done') t.done++;
      else if (r.status === 'error') t.failed++;
      else if (r.status === 'cancelled') t.cancelled++;
      else if (r.status === 'denied') t.denied++;
      if (r.started_at) t.runMs += Math.max(0, Date.parse(r.finished_at ?? new Date().toISOString()) - Date.parse(r.started_at));
    }
    return [...out.values()];
  }
}

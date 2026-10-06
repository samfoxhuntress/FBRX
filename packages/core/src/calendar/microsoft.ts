import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CalendarShowAs } from '@fbrx/shared';
import { findJoinUrl } from './ics';

/**
 * Outlook / Microsoft 365 through Microsoft Graph. FBRX is a public desktop client: the person signs in in their
 * own browser (authorization code with PKCE, redirected back to a one-time listener on this computer), FBRX never
 * sees the password, and keeps only the refresh token, in the vault. National clouds set FBRX_MS_AUTHORITY and
 * FBRX_MS_GRAPH.
 */

export interface MsEndpoints {
  authority: string;
  graph: string;
}

export function msEndpoints(): MsEndpoints {
  return {
    authority: (process.env.FBRX_MS_AUTHORITY || 'https://login.microsoftonline.com').replace(/\/+$/, ''),
    graph: (process.env.FBRX_MS_GRAPH || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, ''),
  };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function msScopes(readOnly: boolean): string {
  return ['offline_access', 'User.Read', readOnly ? 'Calendars.Read' : 'Calendars.ReadWrite'].join(' ');
}

export function authorizeUrl(ep: MsEndpoints, o: { tenant: string; clientId: string; redirectUri: string; challenge: string; state: string; readOnly: boolean }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    response_type: 'code',
    redirect_uri: o.redirectUri,
    response_mode: 'query',
    scope: msScopes(o.readOnly),
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${ep.authority}/${encodeURIComponent(o.tenant)}/oauth2/v2.0/authorize?${q}`;
}

export interface MsTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
}

/** The first line of a Microsoft sign-in error ("AADSTS…: what went wrong"), without the trace and correlation ids. */
function signInError(j: any, status: number): string {
  const d = String(j?.error_description ?? '').split(/\r?\n/)[0].trim();
  if (d) return d;
  return j?.error ? `Microsoft sign-in failed (${j.error})` : `Microsoft sign-in failed (HTTP ${status})`;
}

export async function msToken(ep: MsEndpoints, tenant: string, form: Record<string, string>): Promise<MsTokens> {
  const res = await fetch(`${ep.authority}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw Object.assign(new Error(signInError(j, res.status)), { code: j?.error ?? null });
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt: Date.now() + Math.max(60, Number(j.expires_in) || 3600) * 1000, scope: String(j.scope ?? '') };
}

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GraphCalendar {
  id: string;
  name: string;
  canEdit: boolean;
  isDefaultCalendar: boolean;
}

export interface GraphOccurrence {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string | null;
  organizer: string | null;
  joinUrl: string | null;
  webLink: string | null;
  showAs: CalendarShowAs;
  cancelled: boolean;
}

const SELECT = 'id,subject,start,end,isAllDay,location,organizer,isOnlineMeeting,onlineMeeting,onlineMeetingUrl,showAs,isCancelled,webLink,bodyPreview';
const SHOW_AS: Record<string, CalendarShowAs> = { free: 'free', tentative: 'tentative', busy: 'busy', oof: 'oof', workingElsewhere: 'workingElsewhere' };

/** A Graph date-time in UTC ("2026-10-06T16:30:00.0000000"). */
function utc(dt: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(dt) ? dt : `${dt.replace(/\.\d+$/, '')}Z`);
}
/** All-day events are dates: shown on that day wherever the computer is. */
function localDate(dt: string): Date {
  const [y, m, d] = dt.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toOccurrence(e: any): GraphOccurrence {
  const allDay = !!e.isAllDay;
  const location = e.location?.displayName ? String(e.location.displayName) : null;
  return {
    id: String(e.id),
    title: String(e.subject ?? '').trim() || '(No title)',
    start: allDay ? localDate(e.start.dateTime) : utc(e.start.dateTime),
    end: allDay ? localDate(e.end.dateTime) : utc(e.end.dateTime),
    allDay,
    location,
    organizer: e.organizer?.emailAddress?.name ?? e.organizer?.emailAddress?.address ?? null,
    joinUrl: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? findJoinUrl(location, e.bodyPreview),
    webLink: e.webLink ?? null,
    showAs: SHOW_AS[e.showAs] ?? 'unknown',
    cancelled: !!e.isCancelled,
  };
}

export class GraphClient {
  constructor(
    private readonly ep: MsEndpoints,
    private readonly token: (refresh?: boolean) => Promise<string>,
  ) {}

  private async request(method: string, pathOrUrl: string, body?: unknown, retried = false): Promise<any> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.ep.graph}${pathOrUrl}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.token(retried)}`,
        prefer: 'outlook.timezone="UTC"',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 && !retried) return this.request(method, pathOrUrl, body, true);
    if (res.status === 204) return null;
    const j: any = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = j?.error?.message ? String(j.error.message) : `HTTP ${res.status}`;
      if (res.status === 429) throw new GraphError('Microsoft asked FBRX to slow down; it will try again shortly.', 429);
      if (res.status === 403) throw new GraphError(`Microsoft did not allow this: ${msg}`, 403);
      throw new GraphError(`Microsoft Graph: ${msg}`, res.status);
    }
    return j;
  }

  async me(): Promise<{ name: string | null; address: string | null }> {
    const j = await this.request('GET', '/me?$select=displayName,mail,userPrincipalName');
    return { name: j?.displayName ?? null, address: j?.mail ?? j?.userPrincipalName ?? null };
  }

  async calendars(): Promise<GraphCalendar[]> {
    const out: GraphCalendar[] = [];
    let next: string | null = '/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=100';
    for (let page = 0; next && page < 10; page++) {
      const j: any = await this.request('GET', next);
      for (const c of j?.value ?? []) out.push({ id: String(c.id), name: String(c.name ?? 'Calendar'), canEdit: !!c.canEdit, isDefaultCalendar: !!c.isDefaultCalendar });
      next = j?.['@odata.nextLink'] ?? null;
    }
    return out;
  }

  /** Every occurrence (repeats expanded by Microsoft) between two instants. */
  async calendarView(calendarId: string, from: Date, to: Date): Promise<GraphOccurrence[]> {
    const out: GraphOccurrence[] = [];
    const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $select: SELECT, $top: '250', $orderby: 'start/dateTime' });
    let next: string | null = `/me/calendars/${encodeURIComponent(calendarId)}/calendarView?${q}`;
    for (let page = 0; next && page < 40; page++) {
      const j: any = await this.request('GET', next);
      for (const e of j?.value ?? []) out.push(toOccurrence(e));
      next = j?.['@odata.nextLink'] ?? null;
    }
    return out;
  }

  async createEvent(calendarId: string, body: Record<string, unknown>): Promise<GraphOccurrence> {
    return toOccurrence(await this.request('POST', `/me/calendars/${encodeURIComponent(calendarId)}/events`, body));
  }

  async deleteEvent(id: string): Promise<void> {
    await this.request('DELETE', `/me/events/${encodeURIComponent(id)}`);
  }
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui,sans-serif;background:#0b1020;color:#e8ecf6;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:440px;text-align:center"><h1 style="font-size:22px">${title}</h1><p style="color:#a8b0c6">${text}</p></div></body>`;

/**
 * A one-time listener for the browser's redirect after sign-in, on this computer only (http://localhost:<port>).
 * Answers the first request that carries the expected state, then closes.
 */
export async function loopbackListener(state: string, onCode: (q: URLSearchParams) => Promise<void>): Promise<{ port: number; close: () => void }> {
  const servers: Server[] = [];
  let done = false;
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
    if (done || q.get('state') !== state) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Nothing here', 'This address is only used while FBRX signs in to your calendar.'));
      return;
    }
    done = true;
    void onCode(q).then(
      () => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Your calendar is connected', 'You can close this tab and go back to FBRX.')),
      (err) => res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('That did not work', `${String(err instanceof Error ? err.message : err).replace(/[<>&]/g, '')} Go back to FBRX to try again.`)),
    ).finally(() => setTimeout(close, 500));
  };
  let closed = false;
  const close = () => {
    closed = true;
    for (const s of servers) s.close();
    servers.length = 0;
  };
  const v4 = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    v4.once('error', reject);
    v4.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(v4);
  const port = (v4.address() as AddressInfo).port;
  // Browsers may try "localhost" over IPv6 first.
  const v6 = createServer(handler);
  v6.once('error', () => undefined);
  v6.listen(port, '::1', () => (closed ? v6.close() : servers.push(v6)));
  return { port, close };
}

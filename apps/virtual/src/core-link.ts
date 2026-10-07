import { readFileSync, statSync } from 'node:fs';
import { VirtualError, errorMessage, unavailable } from './errors';

export interface CoreState {
  /** The AI role is installed (the core has written its console token). */
  installed: boolean;
  running: boolean;
  version: string | null;
  error: string | null;
}

/**
 * FBRX Virtual's line to the FBRX core on the same server (the "ai" role: the agent, FBRX Mesh and Mesh Assist). It
 * talks to the core's Local API on 127.0.0.1 with the console token the core writes, root only, at every start. The
 * routes decide who may call what; this only carries the calls.
 */
export class CoreLink {
  private token: { value: string; mtimeMs: number } | null = null;

  constructor(
    private readonly url: string,
    private readonly tokenFile: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private readToken(force = false): string | null {
    try {
      const st = statSync(this.tokenFile);
      if (!force && this.token && this.token.mtimeMs === st.mtimeMs) return this.token.value;
      const value = readFileSync(this.tokenFile, 'utf8').trim();
      if (!value) return null;
      this.token = { value, mtimeMs: st.mtimeMs };
      return value;
    } catch {
      this.token = null;
      return null;
    }
  }

  async state(): Promise<CoreState> {
    const installed = this.readToken() !== null;
    try {
      const res = await this.fetchImpl(`${this.url}/v1/health`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json().catch(() => ({}))) as { version?: string };
      return { installed, running: res.ok, version: body.version ?? null, error: res.ok ? null : `The core answered ${res.status}` };
    } catch (e) {
      return { installed, running: false, version: null, error: installed ? `The FBRX core is not answering (${errorMessage(e)})` : null };
    }
  }

  /** Calls a core method as the person signed in to this console. */
  async call<T = unknown>(method: string, params: unknown, actor: string, timeoutMs = 60_000): Promise<T> {
    let token = this.readToken();
    if (!token) throw unavailable('The AI role is not installed on this server (install.sh --roles virtual,ai adds it)');
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.url}/v1/rpc`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-fbrx-actor': actor },
          body: JSON.stringify({ method, params: params ?? {} }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw unavailable(`The FBRX core is not answering (${errorMessage(e)}). sudo systemctl status fbrx-core shows why.`);
      }
      const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { code?: string; message?: string } };
      if (res.ok) return body.result as T;
      // The core makes a new token each time it starts: read it again once.
      if (res.status === 401 && attempt === 0) {
        token = this.readToken(true);
        if (token) continue;
      }
      if (res.status === 401) throw unavailable('The FBRX core did not accept this console (it may be restarting)');
      throw new VirtualError(res.status >= 400 && res.status < 600 ? res.status : 502, body.error?.message ?? `The FBRX core answered ${res.status}`);
    }
  }
}

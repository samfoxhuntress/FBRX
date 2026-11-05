import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIGGER_NAME, type MeshDevice } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';

/**
 * FBRX Digger thinking with FBRX Endpoint's AI on the same computer. Digger runs on its own, with no AI of its own;
 * while FBRX Endpoint runs, it answers on a link of its own: 127.0.0.1, a port of the moment and a secret, written to
 * DIGGER_LINK_FILE in Endpoint's data folder (only the person can read it). Digger reads that file to find it and sends
 * the requests a paired computer sends to think with another's AI (assist.model.*): Digger's agent, tools and chats
 * stay in Digger, and only the model's work happens in Endpoint. Nothing leaves the computer.
 */
export const DIGGER_LINK_FILE = 'digger-link.json';

/** FBRX Digger as Endpoint's model lender sees it: this computer's own app, never a device on the network. */
export const DIGGER_PEER: MeshDevice = {
  id: 'fbrx-digger',
  name: DIGGER_NAME,
  kind: 'desktop',
  platform: process.platform,
  version: '',
  addr: '127.0.0.1',
  port: null,
  online: true,
  lastSeen: null,
  fingerprint: '',
  pairedAt: '',
  permissions: { status: false, chat: false, ask: false, approve: false, workspace: false, alerts: false, control: false, assist: true, command: false, network: false, sync: false },
};

/** Requests are a conversation for the model at most (the lender keeps it under 1 MiB, with room). */
const MAX_BODY = 2 * 1024 * 1024;

interface LinkFile {
  url: string;
  token: string;
}

/** Endpoint's side: the link Digger finds, answering the model lender's requests only. */
export class DiggerLinkServer {
  private server: Server | null = null;

  constructor(
    private readonly o: {
      /** Endpoint's data folder, where the link file goes. */
      dir: string;
      /** One assist.model.* request from Digger (the model lender, with Digger as the asker). */
      handle: (method: string, params: unknown) => Promise<unknown>;
      log: { warn: (msg: string, data?: Record<string, unknown>) => void };
    },
  ) {}

  get file(): string {
    return join(this.o.dir, DIGGER_LINK_FILE);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const token = randomBytes(32).toString('base64url');
    const expected = Buffer.from(`Bearer ${token}`);
    const server = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      const auth = Buffer.from(req.headers.authorization ?? '');
      if (req.method !== 'POST' || req.url !== '/' || auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(401, { error: { code: 'UNAUTHENTICATED', message: 'Not FBRX Digger on this computer' } });
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        void (async () => {
          try {
            const { method, params } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: unknown; params?: unknown };
            if (typeof method !== 'string' || !method.startsWith('assist.model.')) throw new CoreError('FORBIDDEN', 'FBRX Digger may only think with this computer’s AI');
            send(200, { result: await this.o.handle(method, params) });
          } catch (err) {
            send(err instanceof CoreError && err.code === 'NOT_FOUND' ? 404 : 400, { error: { code: err instanceof CoreError ? err.code : 'INVALID_ARGUMENT', message: errorMessage(err) } });
          }
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    const { port } = server.address() as AddressInfo;
    try {
      writeFileSync(this.file, JSON.stringify({ url: `http://127.0.0.1:${port}/`, token } satisfies LinkFile), { mode: 0o600 });
    } catch (err) {
      this.o.log.warn('FBRX Digger cannot find this computer’s AI: the link file could not be written', { error: errorMessage(err) });
    }
  }

  async stop(): Promise<void> {
    rmSync(this.file, { force: true });
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Digger's side: whether FBRX Endpoint on this computer has its link up (it runs). */
export const diggerLinkPresent = (endpointDir: string) => existsSync(join(endpointDir, DIGGER_LINK_FILE));

/**
 * Digger's side: a request to FBRX Endpoint on this computer, found through the link file in its data folder. Endpoint
 * not installed, or not running, answers UNAVAILABLE.
 */
export function diggerLinkCall(endpointDir: string) {
  return async <T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> => {
    let link: LinkFile;
    try {
      link = JSON.parse(readFileSync(join(endpointDir, DIGGER_LINK_FILE), 'utf8')) as LinkFile;
    } catch {
      throw new CoreError('UNAVAILABLE', 'FBRX Endpoint is not running on this computer');
    }
    let res: Response;
    try {
      res = await fetch(link.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${link.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CoreError('UNAVAILABLE', 'FBRX Endpoint is not running on this computer');
    }
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { code?: string; message?: string } };
    if (!res.ok) throw new CoreError((body.error?.code as never) ?? 'UNAVAILABLE', body.error?.message ?? `FBRX Endpoint answered ${res.status}`);
    return body.result as T;
  };
}

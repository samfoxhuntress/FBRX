import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { deviceProfile, newId, type ConsoleConnectInput, type ConsoleConnectResult, type ConsoleLogin, type ConsoleSession } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { MetaStore } from '../storage/meta';
import type { Vault } from '../vault/vault';

const KNOWN_HOSTS = 'console.knownHosts';
const LOGINS = 'console.logins';
const TRANSCRIPT_MAX = 120_000;
const MAX_SESSIONS = 12;

/** Older firmware (Cisco IOS 12/15, Sophos SFOS, HP ProCurve…) only offers these. */
const LEGACY: NonNullable<ConnectConfig['algorithms']> = {
  kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'] } as never,
  cipher: { append: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'] } as never,
  serverHostKey: { append: ['ssh-rsa', 'ssh-dss'] } as never,
  hmac: { append: ['hmac-sha1', 'hmac-md5'] } as never,
};

/** Terminal text without colors, cursor movement and other escape sequences (for the transcript and the agent). */
export function stripAnsi(s: string): string {
  let t = s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x07\x0b-\x1f\x7f]/g, '');
  // A backspace erases the character before it (devices echo "x\b \b" when you delete).
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(/[^\n\x08]\x08/g, '');
  }
  return t.replace(/\x08/g, '');
}

/** SHA256:base64 of an SSH host key, as `ssh` prints it. */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function keyTypeOf(key: Buffer): string {
  try {
    const len = key.readUInt32BE(0);
    return key.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'unknown';
  }
}

interface Live {
  info: ConsoleSession;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  transcript: string;
  /** Total characters received; the agent tool uses it to read only what a command printed. */
  received: number;
}

// ------------------------------------------------------------------------------------------- Telnet

const IAC = 255;
const [WILL, WONT, DO, DONT, SB, SE] = [251, 252, 253, 254, 250, 240];
const [ECHO, SGA, TTYPE, NAWS] = [1, 3, 24, 31];

/**
 * A minimal Telnet client: agrees to echo, suppress-go-ahead, terminal type and window size, refuses everything
 * else, and strips negotiation from the text.
 */
class TelnetLink {
  private buf: number[] = [];
  private sbOpt = -1;
  private sbData: number[] = [];
  constructor(
    private readonly sock: net.Socket,
    private cols: number,
    private rows: number,
  ) {}

  private send(bytes: number[]) {
    this.sock.write(Buffer.from(bytes));
  }

  naws(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    const b = [cols >> 8, cols & 255, rows >> 8, rows & 255].flatMap((x) => (x === IAC ? [IAC, IAC] : [x]));
    this.send([IAC, SB, NAWS, ...b, IAC, SE]);
  }

  /** Returns the text part of a chunk and answers the negotiation in it. */
  feed(chunk: Buffer): Buffer {
    const out: number[] = [];
    for (const byte of chunk) {
      const st = this.buf;
      if (this.sbOpt >= 0) {
        // Inside a subnegotiation: collect until IAC SE.
        if (st.length && st[0] === IAC) {
          st.length = 0;
          if (byte === SE) {
            if (this.sbOpt === TTYPE && this.sbData[0] === 1) this.send([IAC, SB, TTYPE, 0, ...Buffer.from('XTERM'), IAC, SE]);
            this.sbOpt = -1;
            this.sbData = [];
          } else if (byte === IAC) this.sbData.push(IAC);
          continue;
        }
        if (byte === IAC) st.push(IAC);
        else this.sbData.push(byte);
        continue;
      }
      if (!st.length) {
        if (byte === IAC) st.push(byte);
        else out.push(byte);
        continue;
      }
      if (st.length === 1) {
        if (byte === IAC) {
          out.push(IAC);
          st.length = 0;
        } else if (byte === SB) st.push(byte);
        else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) st.push(byte);
        else st.length = 0; // other commands (NOP, GA…) carry no data
        continue;
      }
      if (st[1] === SB) {
        this.sbOpt = byte;
        this.sbData = [];
        st.length = 0;
        continue;
      }
      const verb = st[1];
      st.length = 0;
      if (verb === WILL) this.send([IAC, byte === ECHO || byte === SGA ? DO : DONT, byte]);
      else if (verb === DO) {
        if (byte === NAWS) {
          this.send([IAC, WILL, NAWS]);
          this.naws(this.cols, this.rows);
        } else this.send([IAC, byte === TTYPE || byte === SGA ? WILL : WONT, byte]);
      }
    }
    return Buffer.from(out);
  }

  write(text: string) {
    // Enter is CR LF on the wire; a literal 255 byte is doubled.
    const bytes = [...Buffer.from(text.replace(/\r(?!\n)/g, '\r\n'), 'utf8')].flatMap((b) => (b === IAC ? [IAC, IAC] : [b]));
    this.sock.write(Buffer.from(bytes));
  }
}

// ------------------------------------------------------------------------------------------ manager

/**
 * Console sessions to network devices (switches, firewalls, access points, NAS, servers) over SSH or Telnet, shown
 * in the desktop app's device console. Host keys are pinned on first use and a changed key is refused until the
 * person confirms it; saved passwords live encrypted in the vault as internal secrets (never visible to plugins or
 * the agent). Only the person at the workstation can open, type into or read a console; the agent's device tools
 * act on sessions the person opened, through governance.
 */
export class DeviceConsoles {
  private readonly live = new Map<string, Live>();

  constructor(
    private readonly d: {
      events: EventBus;
      meta: MetaStore;
      vault: Vault;
      audit: (action: string, outcome: 'success' | 'failure' | 'info', details: Record<string, unknown>) => void;
      /** Home folder, for ~/.ssh keys. */
      home?: () => string;
    },
  ) {}

  list(): ConsoleSession[] {
    return [...this.live.values()].map((l) => ({ ...l.info })).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }

  get(id: string): Live {
    const l = this.live.get(id);
    if (!l) throw new CoreError('NOT_FOUND', 'That console session has ended');
    return l;
  }

  transcript(id: string): string {
    return this.get(id).transcript;
  }

  /** Characters received so far and the text since `from` (for the agent's send-and-read). */
  since(id: string, from: number): { received: number; text: string } {
    const l = this.get(id);
    const back = l.received - from;
    return { received: l.received, text: back > 0 ? l.transcript.slice(-Math.min(back, l.transcript.length)) : '' };
  }

  write(id: string, data: string): void {
    const l = this.get(id);
    if (l.info.state !== 'open') throw new CoreError('CONFLICT', 'The session is not connected');
    l.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.live.get(id)?.resize(Math.max(20, Math.min(500, cols)), Math.max(5, Math.min(200, rows)));
  }

  close(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    l.close();
    this.live.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.live.keys()]) this.close(id);
  }

  // ------------------------------------------------------------------------------ logins and host keys

  private secretName(protocol: string, host: string, port: number, username: string) {
    return `fbrx.console.${createHash('sha256').update(`${protocol}|${host.toLowerCase()}|${port}|${username}`).digest('hex').slice(0, 40)}`;
  }

  logins(): ConsoleLogin[] {
    return this.d.meta.get<ConsoleLogin[]>(LOGINS) ?? [];
  }

  private saveLogin(l: ConsoleLogin, password: string) {
    this.d.vault.set({ name: this.secretName(l.protocol, l.host, l.port, l.username), value: password, kind: 'password', description: `Device console login for ${l.username}@${l.host}` }, { internal: true });
    const rest = this.logins().filter((x) => !(x.host === l.host && x.port === l.port && x.username === l.username && x.protocol === l.protocol));
    this.d.meta.set(LOGINS, [l, ...rest].slice(0, 200));
  }

  forgetLogin(host: string, port: number, username: string): void {
    for (const l of this.logins().filter((x) => x.host === host && x.port === port && x.username === username)) {
      this.d.vault.delete(this.secretName(l.protocol, l.host, l.port, l.username), { internal: true });
    }
    this.d.meta.set(
      LOGINS,
      this.logins().filter((x) => !(x.host === host && x.port === port && x.username === username)),
    );
  }

  private knownHosts(): Record<string, { fingerprint: string; keyType: string; addedAt: string }> {
    return this.d.meta.get(KNOWN_HOSTS) ?? {};
  }

  forgetHostKey(host: string, port: number): void {
    const k = this.knownHosts();
    delete k[`${host.toLowerCase()}:${port}`];
    this.d.meta.set(KNOWN_HOSTS, k);
  }

  // ------------------------------------------------------------------------------------------ connect

  async connect(input: ConsoleConnectInput): Promise<ConsoleConnectResult> {
    const host = input.host.trim();
    if (!/^[A-Za-z0-9.:_-]{1,253}$/.test(host)) throw new CoreError('INVALID_ARGUMENT', 'Enter an IP address or host name');
    const port = input.port ?? (input.protocol === 'telnet' ? 23 : 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CoreError('INVALID_ARGUMENT', 'Port must be 1-65535');
    const username = input.username?.trim() || null;
    if (username && !/^[^\s:@]{1,64}$/.test(username)) throw new CoreError('INVALID_ARGUMENT', 'Invalid user name');
    if (input.protocol === 'ssh' && !username) throw new CoreError('INVALID_ARGUMENT', 'Enter the user name to log in with');
    for (const [id, l] of this.live) if (l.info.state === 'closed') this.live.delete(id);
    if (this.live.size >= MAX_SESSIONS) throw new CoreError('CONFLICT', `Close a console first (at most ${MAX_SESSIONS} at a time)`);
    let password = input.password ?? '';
    if (!password && input.useSaved && username) {
      if (!this.d.vault.isUnlocked) throw new CoreError('UNAVAILABLE', 'Unlock the vault to use a saved password');
      password = this.d.vault.get(this.secretName(input.protocol, host, port, username), { allowInternal: true }) ?? '';
    }
    const profile = deviceProfile(input.profileId);
    const info: ConsoleSession = {
      id: newId('con'),
      host,
      port,
      protocol: input.protocol,
      username,
      label: input.label?.trim().slice(0, 120) || `${username ? `${username}@` : ''}${host}`,
      profileId: profile?.id ?? null,
      vendor: input.vendor?.slice(0, 120) ?? null,
      state: 'connecting',
      openedAt: new Date().toISOString(),
      closedAt: null,
      reason: null,
      fingerprint: null,
    };
    const cols = input.cols ?? 120;
    const rows = input.rows ?? 32;
    const result =
      input.protocol === 'ssh'
        ? await this.ssh(info, password, cols, rows, input.trustFingerprint, input.legacy ?? profile?.legacyCrypto ?? false)
        : await this.telnet(info, password, cols, rows);
    if ('session' in result) {
      this.d.audit('connect', 'success', { host, port, protocol: input.protocol, username, fingerprint: info.fingerprint });
      if (input.remember && username && password && this.d.vault.isUnlocked) {
        this.saveLogin({ host, port, protocol: input.protocol, username, savedAt: new Date().toISOString() }, password);
      }
    }
    return result;
  }

  private open(info: ConsoleSession, impl: Omit<Live, 'info' | 'transcript' | 'received'>): Live {
    const l: Live = { info, transcript: '', received: 0, ...impl };
    this.live.set(info.id, l);
    return l;
  }

  private data(l: Live, text: string) {
    if (!text) return;
    this.d.events.emit('console.data', { id: l.info.id, data: text });
    const clean = stripAnsi(text);
    l.received += clean.length;
    l.transcript = (l.transcript + clean).slice(-TRANSCRIPT_MAX);
  }

  private ended(l: Live, reason: string | null) {
    if (l.info.state === 'closed') return;
    l.info.state = 'closed';
    l.info.closedAt = new Date().toISOString();
    l.info.reason = reason;
    this.d.events.emit('console.changed', { ...l.info });
    this.d.audit('disconnect', 'info', { host: l.info.host, port: l.info.port, protocol: l.info.protocol, reason });
  }

  private sshKeys(): Buffer[] {
    const home = this.d.home?.() ?? homedir();
    const out: Buffer[] = [];
    for (const k of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
      const p = join(home, '.ssh', k);
      try {
        if (existsSync(p)) out.push(readFileSync(p));
      } catch {
        /* unreadable key */
      }
    }
    return out;
  }

  private ssh(info: ConsoleSession, password: string, cols: number, rows: number, trust: string | undefined, legacy: boolean, retried = false): Promise<ConsoleConnectResult> {
    return new Promise((resolve, reject) => {
      const id = `${info.host.toLowerCase()}:${info.port}`;
      const known = this.knownHosts()[id];
      let seen: { fingerprint: string; keyType: string } | null = null;
      let settled = false;
      const conn = new Client();
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const keys = password ? [] : this.sshKeys();
      const cfg: ConnectConfig = {
        host: info.host,
        port: info.port,
        username: info.username ?? undefined,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        tryKeyboard: true,
        hostVerifier: (key: Buffer) => {
          seen = { fingerprint: fingerprintOf(key), keyType: keyTypeOf(key) };
          if (known) return known.fingerprint === seen.fingerprint || trust === seen.fingerprint;
          return trust === seen.fingerprint;
        },
        ...(legacy ? { algorithms: LEGACY } : {}),
      };
      if (password) cfg.password = password;
      else if (keys.length) cfg.privateKey = keys[0];
      conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, reply) => reply(prompts.map(() => password)));
      conn.on('ready', () => {
        const s = seen as { fingerprint: string; keyType: string } | null;
        if (s && (!known || known.fingerprint !== s.fingerprint)) {
          const all = this.knownHosts();
          all[id] = { fingerprint: s.fingerprint, keyType: s.keyType, addedAt: new Date().toISOString() };
          this.d.meta.set(KNOWN_HOSTS, all);
        }
        info.fingerprint = s?.fingerprint ?? null;
        conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream: ClientChannel) => {
          if (err) {
            conn.end();
            return finish(() => reject(new CoreError('UNAVAILABLE', `The device refused a terminal: ${err.message}`)));
          }
          const dec = new StringDecoder('utf8');
          const l = this.open(info, {
            write: (data) => stream.write(data),
            resize: (c, r) => stream.setWindow(r, c, 0, 0),
            close: () => {
              stream.end();
              conn.end();
              this.ended(l, 'Closed');
            },
          });
          info.state = 'open';
          stream.on('data', (b: Buffer) => this.data(l, dec.write(b)));
          stream.stderr.on('data', (b: Buffer) => this.data(l, b.toString('utf8')));
          stream.on('close', () => {
            conn.end();
            this.ended(l, 'The device closed the connection');
          });
          conn.on('close', () => this.ended(l, 'Disconnected'));
          this.d.events.emit('console.changed', { ...info });
          finish(() => resolve({ session: { ...info } }));
        });
      });
      conn.on('error', (err: Error & { level?: string }) => {
        const s = seen as { fingerprint: string; keyType: string } | null;
        // The host key check failed: ask the person instead of failing.
        if (s && /verification failed|host denied/i.test(err.message) && s.fingerprint !== trust) {
          return finish(() => resolve({ hostKey: { host: info.host, port: info.port, fingerprint: s.fingerprint, keyType: s.keyType, status: known ? 'changed' : 'new', previous: known?.fingerprint ?? null } }));
        }
        if (!legacy && !retried && /no matching|handshake failed/i.test(err.message)) {
          return finish(() => this.ssh(info, password, cols, rows, trust, true, true).then(resolve, reject));
        }
        const msg = /authentication|all configured authentication methods failed/i.test(err.message)
          ? password
            ? 'The user name or password was not accepted'
            : 'Enter the password (no SSH key on this computer was accepted)'
          : /ECONNREFUSED/.test(err.message)
            ? `Nothing answered on port ${info.port}: SSH may be turned off on the device`
            : /ETIMEDOUT|timed out|EHOSTUNREACH/i.test(err.message)
              ? `${info.host} did not answer: check the address and that you are on the same network`
              : err.message;
        this.d.audit('connect', 'failure', { host: info.host, port: info.port, protocol: 'ssh', username: info.username, error: msg });
        finish(() => reject(new CoreError('UNAVAILABLE', msg)));
      });
      try {
        conn.connect(cfg);
      } catch (err) {
        finish(() => reject(new CoreError('INVALID_ARGUMENT', (err as Error).message)));
      }
    });
  }

  private telnet(info: ConsoleSession, password: string, cols: number, rows: number): Promise<ConsoleConnectResult> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: info.host, port: info.port });
      sock.setTimeout(15_000);
      const link = new TelnetLink(sock, cols, rows);
      const dec = new StringDecoder('utf8');
      let l: Live | null = null;
      // Fills in the user name and password at the first prompts, like a saved login.
      let pendingUser = info.username;
      let pendingPass = password;
      let tail = '';
      sock.once('connect', () => {
        sock.setTimeout(0);
        info.state = 'open';
        l = this.open(info, {
          write: (data) => link.write(data),
          resize: (c, r) => link.naws(c, r),
          close: () => {
            sock.destroy();
            this.ended(l!, 'Closed');
          },
        });
        this.d.events.emit('console.changed', { ...info });
        resolve({ session: { ...info } });
      });
      sock.on('data', (b: Buffer) => {
        if (!l) return;
        const text = dec.write(link.feed(b));
        this.data(l, text);
        if (pendingUser || pendingPass) {
          tail = (tail + stripAnsi(text)).slice(-200);
          if (pendingUser && /(user ?name|login)\s*:\s*$/i.test(tail)) {
            link.write(`${pendingUser}\r`);
            pendingUser = null;
            tail = '';
          } else if (pendingPass && /password\s*:\s*$/i.test(tail)) {
            link.write(`${pendingPass}\r`);
            pendingPass = '';
            pendingUser = null;
            tail = '';
          }
        }
      });
      sock.on('timeout', () => sock.destroy(new Error('ETIMEDOUT')));
      sock.on('error', (err) => {
        if (l) return this.ended(l, err.message);
        const msg = /ECONNREFUSED/.test(err.message) ? `Nothing answered on port ${info.port}: Telnet is probably turned off (good)` : /ETIMEDOUT|EHOSTUNREACH/.test(err.message) ? `${info.host} did not answer` : err.message;
        this.d.audit('connect', 'failure', { host: info.host, port: info.port, protocol: 'telnet', error: msg });
        reject(new CoreError('UNAVAILABLE', msg));
      });
      sock.on('close', () => l && this.ended(l, 'The device closed the connection'));
    });
  }
}

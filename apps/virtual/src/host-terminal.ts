import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';

/**
 * The server's own shell in the console (Server → Terminal): a root bash in a pseudo-terminal, carried over a
 * WebSocket. util-linux script makes the pseudo-terminal (no native module), and on FBRX Server the shell runs as a
 * service of its own (systemd-run), outside this console's sandbox, so it sees the whole system: /root, /home, the
 * real /tmp, and modules it can load. Every session can be recorded to a file on the server (what was on the screen;
 * passwords are not echoed, so they are not in it).
 *
 * The WebSocket carries the screen as binary frames both ways; text frames are commands ({"type":"resize"}).
 */
export interface TerminalConfig {
  enabled: boolean;
  /** "systemd-run": a service of its own (FBRX Server); "direct": a child of this process (development, tests). */
  spawn: 'systemd-run' | 'direct';
  shell: string;
  /** Where sessions are recorded, or null not to record them. */
  recordDir: string | null;
  keepDays: number;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** The marker the session prints first: the pseudo-terminal it got, so a resize reaches it. Not shown. */
const MARK = /\x1b\]7777;(\/dev\/pts\/\d{1,6})\x07/;
const MAX_SESSIONS = 4;

export const clampSize = (s: Partial<TerminalSize>): TerminalSize => ({
  cols: Math.min(500, Math.max(20, Math.round(Number(s.cols) || 100))),
  rows: Math.min(200, Math.max(5, Math.round(Number(s.rows) || 30))),
});

export class HostTerminals {
  private readonly open = new Set<HostTerminal>();

  constructor(private readonly config: TerminalConfig) {
    // Shells left from before this console restarted (an update): their screen went with it.
    if (config.enabled && config.spawn === 'systemd-run') run('systemctl', ['stop', 'fbrx-terminal-*.service']);
  }

  get count(): number {
    return this.open.size;
  }

  get full(): boolean {
    return this.open.size >= MAX_SESSIONS;
  }

  /** Starts a shell for this WebSocket. Calls back when it ends, with how long it lasted. */
  start(ws: WebSocket, user: string, size: TerminalSize, onEnd: (info: { id: string; seconds: number; reason: string }) => void): HostTerminal {
    const t = new HostTerminal(this.config, ws, user, size, (info) => {
      this.open.delete(t);
      onEnd(info);
    });
    this.open.add(t);
    return t;
  }

  closeAll(): void {
    for (const t of [...this.open]) t.end('The console is stopping');
  }
}

export class HostTerminal {
  readonly id = randomBytes(5).toString('hex');
  readonly recording: string | null;
  private readonly child: ChildProcess;
  private readonly started = Date.now();
  private tty: string | null = null;
  /** Output held back until the marker went by (a few hundred bytes at most). */
  private head: Buffer | null = Buffer.alloc(0);
  private size: TerminalSize;
  private resizing = false;
  private pendingSize: TerminalSize | null = null;
  private ended = false;

  constructor(
    private readonly config: TerminalConfig,
    private readonly ws: WebSocket,
    user: string,
    size: TerminalSize,
    private readonly onEnd: (info: { id: string; seconds: number; reason: string }) => void,
  ) {
    this.size = clampSize(size);
    this.recording = config.recordDir ? recordFile(config.recordDir, user, this.id, config.keepDays) : null;
    const inner = `printf '\\033]7777;%s\\007' "$(tty)"; stty rows ${this.size.rows} cols ${this.size.cols} 2>/dev/null; cd; exec ${config.shell} -l`;
    const script = ['-qfec', inner, this.recording ?? '/dev/null'];
    const env = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG && /utf-?8/i.test(process.env.LANG) ? process.env.LANG : 'C.UTF-8', SHELL: config.shell, FBRX_TERMINAL: this.id };
    this.child =
      config.spawn === 'systemd-run'
        ? spawn('systemd-run', ['--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', `--unit=${this.unit}`, '--description=FBRX Server terminal', '-p', 'User=root', ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), '/usr/bin/script', ...script], { stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn('script', script, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, cwd: process.env.HOME, detached: true });
    this.child.stdout!.on('data', (d: Buffer) => this.output(d));
    this.child.stderr!.on('data', (d: Buffer) => this.output(d));
    this.child.stdin!.on('error', () => undefined);
    this.child.on('error', (e) => this.end(`The shell could not start (${e.message})`));
    this.child.on('exit', () => this.end('The shell ended'));
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
      const b = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (binary) return void this.input(b);
      try {
        const m = JSON.parse(b.toString('utf8')) as { type?: string; cols?: number; rows?: number };
        if (m.type === 'resize') this.resize(clampSize(m));
      } catch {
        /* not a command */
      }
    });
    ws.on('close', () => this.end('Closed'));
    ws.on('error', () => this.end('Connection lost'));
  }

  private get unit(): string {
    return `fbrx-terminal-${this.id}.service`;
  }

  get seconds(): number {
    return Math.round((Date.now() - this.started) / 1000);
  }

  private input(b: Buffer) {
    if (!this.ended && this.child.stdin?.writable) this.child.stdin.write(b);
  }

  private output(d: Buffer) {
    if (this.head) {
      // Keystrokes before the shell was ready can arrive first (the terminal echoes them), so look in what came so far.
      const all = Buffer.concat([this.head, d]);
      const text = all.toString('latin1');
      const m = MARK.exec(text);
      if (!m && all.length < 4096) {
        this.head = all;
        return;
      }
      this.head = null;
      if (m) {
        this.tty = m[1];
        d = Buffer.concat([all.subarray(0, m.index), all.subarray(m.index + m[0].length)]);
        if (this.pendingSize) this.resize(this.pendingSize);
      } else d = all;
      if (!d.length) return;
    }
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(d, { binary: true });
  }

  /** Sets the terminal's size; the kernel tells the programs in it (SIGWINCH). One at a time, the latest wins. */
  resize(size: TerminalSize) {
    if (this.ended) return;
    if (!this.tty || this.resizing) {
      this.pendingSize = size;
      return;
    }
    if (size.cols === this.size.cols && size.rows === this.size.rows) return;
    this.resizing = true;
    this.pendingSize = null;
    this.size = size;
    run('stty', ['-F', this.tty, 'rows', String(size.rows), 'cols', String(size.cols)], () => {
      this.resizing = false;
      if (this.pendingSize) this.resize(this.pendingSize);
    });
  }

  end(reason: string) {
    if (this.ended) return;
    this.ended = true;
    if (this.config.spawn === 'systemd-run') run('systemctl', ['stop', this.unit]);
    if (this.child.exitCode === null && this.child.pid) {
      try {
        if (this.config.spawn === 'direct') process.kill(-this.child.pid, 'SIGHUP');
        else this.child.kill('SIGTERM');
      } catch {
        /* gone */
      }
      const pid = this.child.pid;
      setTimeout(() => {
        try {
          if (this.child.exitCode === null) process.kill(this.config.spawn === 'direct' ? -pid : pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }, 3000).unref();
    }
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(1000, reason.slice(0, 120));
    this.onEnd({ id: this.id, seconds: this.seconds, reason });
  }
}

/** The file this session is recorded to (root only), after removing recordings older than keepDays. */
function recordFile(dir: string, user: string, id: string, keepDays: number): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cutoff = Date.now() - keepDays * 86400_000;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (f.endsWith('.log') && statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* in use or gone */
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return join(dir, `${stamp}-${user.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)}-${id}.log`);
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[], done?: () => void) {
  const p = spawn(cmd, args, { stdio: 'ignore' });
  p.on('error', () => done?.());
  p.on('exit', () => done?.());
}

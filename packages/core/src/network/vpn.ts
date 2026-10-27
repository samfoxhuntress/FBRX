import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostRange, inCidr, isIPv4, newId, parseVpnSettings, renderVpnSettings, VPN_INTERFACE, type VpnCheck, type VpnProfile, type VpnSettings, type VpnStatus } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { Db } from '../storage/db';
import type { MetaStore } from '../storage/meta';
import type { Vault } from '../vault/vault';

/**
 * FBRX VPN: this computer's tunnel to an FBRX Gate's VPN, so home (the FBRX Server, its AI over FBRX Mesh, the network
 * behind the gate) is reachable from anywhere. The gate makes each device's settings (DNS & VPN → Add a device); FBRX
 * keeps them sealed with the vault key and runs the tunnel with the system's own VPN driver (VpnDriver below), which
 * asks for administrator rights each time it starts or stops one.
 */

export interface CommandResult {
  code: number | null;
  out: string;
  err: string;
}
export type Run = (cmd: string, args: string[], o?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;

/** Starts and stops the tunnel on one kind of system. */
export interface VpnDriver {
  /** Whether a tunnel can run here; else why, and whether install() can fix it. */
  ready(): Promise<VpnStatus['driver']>;
  /** Installs what the tunnel needs (the system's VPN tools). */
  install(): Promise<void>;
  /** The system can set the tunnel's name server (else the tunnel runs without one: addresses still work). */
  dns(): Promise<boolean>;
  /** The settings file must stay while the tunnel runs (Windows' tunnel service reads it when it starts). */
  readonly keepsFile: boolean;
  up(file: string): Promise<void>;
  down(file: string): Promise<void>;
  state(): Promise<{ up: boolean; received: number | null; sent: number | null }>;
}

/** The last lines of what a command said, for a message. */
const said = (r: CommandResult) => (r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 300);

/** Linux: wg-quick, through pkexec (the system's administrator prompt) unless FBRX already runs as root. */
export class LinuxVpnDriver implements VpnDriver {
  readonly keepsFile = false;
  constructor(private readonly o: { run: Run; root: boolean }) {}

  private async which(cmd: string): Promise<string | null> {
    const r = await this.o.run('sh', ['-c', `command -v ${cmd}`]);
    return r.code === 0 && r.out.trim() ? r.out.trim().split('\n')[0]! : null;
  }

  private async admin(cmd: string, args: string[]): Promise<CommandResult> {
    if (this.o.root) return this.o.run(cmd, args, { timeoutMs: 60_000 });
    const r = await this.o.run('pkexec', [cmd, ...args], { timeoutMs: 120_000 });
    if (r.code === 126 || r.code === 127) throw new CoreError('CANCELLED', 'Administrator permission was declined');
    return r;
  }

  async ready(): Promise<VpnStatus['driver']> {
    const pkexec = this.o.root || !!(await this.which('pkexec'));
    if (!(await this.which('wg-quick'))) {
      const manager = (await this.which('apt-get')) || (await this.which('dnf'));
      return { ready: false, why: 'The VPN tools are not installed on this computer (the wireguard-tools package).', canInstall: !!manager && pkexec };
    }
    if (!pkexec) return { ready: false, why: 'Starting a tunnel needs the system’s administrator prompt (pkexec, from polkit), which is not installed.', canInstall: false };
    return { ready: true, why: null, canInstall: false };
  }

  async install(): Promise<void> {
    const apt = await this.which('apt-get');
    const manager = apt ?? (await this.which('dnf'));
    if (!manager) throw new CoreError('UNAVAILABLE', 'Install the wireguard-tools package with your system’s package manager');
    const r = await this.admin(manager, ['install', '-y', 'wireguard-tools']);
    if (r.code !== 0) throw new CoreError('UNAVAILABLE', `The VPN tools could not be installed: ${said(r)}`);
  }

  async dns(): Promise<boolean> {
    return !!(await this.which('resolvconf'));
  }

  async up(file: string): Promise<void> {
    const r = await this.admin((await this.which('wg-quick')) ?? 'wg-quick', ['up', file]);
    if (r.code !== 0) throw new CoreError('UNAVAILABLE', `The tunnel did not start: ${said(r)}`);
  }

  async down(file: string): Promise<void> {
    const r = await this.admin((await this.which('wg-quick')) ?? 'wg-quick', ['down', file]);
    if (r.code !== 0 && !/is not a WireGuard interface|does not exist/i.test(r.err)) throw new CoreError('UNAVAILABLE', `The tunnel did not stop: ${said(r)}`);
  }

  async state() {
    const r = await this.o.run('ip', ['-s', '-j', 'link', 'show', 'dev', VPN_INTERFACE]);
    if (r.code !== 0) return { up: false, received: null, sent: null };
    try {
      const s = (JSON.parse(r.out) as Array<{ stats64?: { rx?: { bytes?: number }; tx?: { bytes?: number } } }>)[0]?.stats64;
      return { up: true, received: s?.rx?.bytes ?? null, sent: s?.tx?.bytes ?? null };
    } catch {
      return { up: true, received: null, sent: null };
    }
  }
}

/** macOS: wg-quick from Homebrew's wireguard-tools, with the administrator prompt (osascript). */
export class MacVpnDriver implements VpnDriver {
  readonly keepsFile = false;
  private static readonly BIN = ['/opt/homebrew/bin', '/usr/local/bin'];
  constructor(private readonly o: { run: Run; exists?: (path: string) => boolean }) {}

  private find(name: string): string | null {
    const exists = this.o.exists ?? existsSync;
    return MacVpnDriver.BIN.map((d) => join(d, name)).find((p) => exists(p)) ?? null;
  }

  private async admin(command: string): Promise<CommandResult> {
    // A shell command inside an AppleScript string: backslashes and double quotes escaped for AppleScript.
    const script = `do shell script "${`PATH=${MacVpnDriver.BIN.join(':')}:$PATH ${command}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
    const r = await this.o.run('osascript', ['-e', script], { timeoutMs: 120_000 });
    if (/User canceled|-128/.test(r.err)) throw new CoreError('CANCELLED', 'Administrator permission was declined');
    return r;
  }

  async ready(): Promise<VpnStatus['driver']> {
    if (this.find('wg-quick')) return { ready: true, why: null, canInstall: false };
    return { ready: false, why: 'The VPN tools are not installed on this Mac (Homebrew’s wireguard-tools).', canInstall: !!this.find('brew') };
  }

  async install(): Promise<void> {
    const brew = this.find('brew');
    if (!brew) throw new CoreError('UNAVAILABLE', 'Install Homebrew first (brew.sh), then the VPN tools: brew install wireguard-tools');
    const r = await this.o.run(brew, ['install', 'wireguard-tools'], { timeoutMs: 15 * 60_000 });
    if (r.code !== 0) throw new CoreError('UNAVAILABLE', `The VPN tools could not be installed: ${said(r)}`);
  }

  async dns(): Promise<boolean> {
    return true;
  }

  private quote(path: string): string {
    return `'${path.replace(/'/g, `'\\''`)}'`;
  }

  async up(file: string): Promise<void> {
    const r = await this.admin(`wg-quick up ${this.quote(file)}`);
    if (r.code !== 0) throw new CoreError('UNAVAILABLE', `The tunnel did not start: ${said(r)}`);
  }

  async down(file: string): Promise<void> {
    const r = await this.admin(`wg-quick down ${this.quote(file)}`);
    if (r.code !== 0 && !/is not a WireGuard interface/i.test(r.err)) throw new CoreError('UNAVAILABLE', `The tunnel did not stop: ${said(r)}`);
  }

  async state() {
    const exists = this.o.exists ?? existsSync;
    return { up: exists(`/var/run/wireguard/${VPN_INTERFACE}.name`), received: null, sent: null };
  }
}

/** Windows: the tunnel service of the system's WireGuard driver, installed and removed through the UAC prompt. */
export class WindowsVpnDriver implements VpnDriver {
  readonly keepsFile = true;
  constructor(
    private readonly o: {
      run: Run;
      /** Runs a PowerShell script as administrator (UAC). */
      elevate: (script: string) => Promise<{ ok: boolean; output: string }>;
      exists?: (path: string) => boolean;
      programFiles?: string;
    },
  ) {}

  private get exe(): string {
    return join(this.o.programFiles ?? process.env.ProgramFiles ?? 'C:\\Program Files', 'WireGuard', 'wireguard.exe');
  }

  private q(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
  }

  async ready(): Promise<VpnStatus['driver']> {
    if ((this.o.exists ?? existsSync)(this.exe)) return { ready: true, why: null, canInstall: false };
    const winget = await this.o.run('where.exe', ['winget']);
    return { ready: false, why: 'The VPN driver is not installed on this computer (WireGuard for Windows, free).', canInstall: winget.code === 0 };
  }

  async install(): Promise<void> {
    const r = await this.o.run('winget', ['install', '--id', 'WireGuard.WireGuard', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { timeoutMs: 15 * 60_000 });
    if (r.code !== 0 && !(await this.ready()).ready) throw new CoreError('UNAVAILABLE', `The VPN driver could not be installed: ${said(r)}`);
  }

  async dns(): Promise<boolean> {
    return true;
  }

  async up(file: string): Promise<void> {
    const r = await this.o.elevate(`& ${this.q(this.exe)} /installtunnelservice ${this.q(file)}`);
    if (!r.ok) throw new CoreError('UNAVAILABLE', `The tunnel did not start: ${r.output.slice(-300)}`);
  }

  async down(): Promise<void> {
    const r = await this.o.elevate(`& ${this.q(this.exe)} /uninstalltunnelservice ${VPN_INTERFACE}`);
    if (!r.ok) throw new CoreError('UNAVAILABLE', `The tunnel did not stop: ${r.output.slice(-300)}`);
  }

  async state() {
    const r = await this.o.run('sc.exe', ['query', `WireGuardTunnel$${VPN_INTERFACE}`]);
    return { up: r.code === 0 && /RUNNING/.test(r.out), received: null, sent: null };
  }
}

export interface VpnDeps {
  db: Db;
  meta: MetaStore;
  vault: Vault;
  events: EventBus;
  /** Where the settings file is written while the tunnel starts (machine-local, never in a backup). */
  dir: string;
  driver: VpnDriver;
  ping: (host: string) => Promise<{ ok: boolean; ms: number | null }>;
  /** Paired FBRX computers with their addresses and roles. */
  computers: () => Promise<Array<{ id: string; name: string; addresses: string[]; roles: string[] }>>;
  /** FBRX Mesh answers from that computer. */
  meshAnswers: (id: string) => Promise<boolean>;
}

interface Row {
  id: string;
  name: string;
  data_enc: string;
  created_at: string;
  last_connected_at: string | null;
}

const CONNECTED = 'vpn.connected';
const sealLabel = (id: string) => `vpn:${id}`;

export class VpnService {
  private busy: 'connecting' | null = null;
  private failure: string | null = null;

  constructor(private readonly d: VpnDeps) {}

  private settings(r: Row): VpnSettings {
    return JSON.parse(this.d.vault.unseal(sealLabel(r.id), r.data_enc)) as VpnSettings;
  }

  private summary(r: Row, s: VpnSettings): VpnProfile {
    const networks = s.peer.allowedIps;
    const fullTunnel = networks.includes('0.0.0.0/0');
    // The gate answers on its own tunnel address, which it gives as the name server (else the tunnel network's first).
    const tunnel = networks.find((n) => n !== '0.0.0.0/0' && inCidr(s.address.split('/')[0]!, n));
    const gateAddress = s.dns ?? (tunnel ? hostRange(tunnel).first : null);
    return { id: r.id, name: r.name, endpoint: s.peer.endpoint, address: s.address, gateAddress, networks, fullTunnel, createdAt: r.created_at, lastConnectedAt: r.last_connected_at };
  }

  private row(id: string): Row {
    const r = this.d.db.get<Row>('SELECT * FROM vpn_profiles WHERE id = ?', id);
    if (!r) throw new CoreError('NOT_FOUND', 'There is no such VPN connection');
    return r;
  }

  list(): VpnProfile[] {
    return this.d.db.all<Row>('SELECT * FROM vpn_profiles ORDER BY created_at').map((r) => this.summary(r, this.settings(r)));
  }

  /** Keeps a gate's device settings (pasted, or read from the file it gave). */
  add(p: { name: string; settings: string }): VpnProfile {
    const s = parseVpnSettings(p.settings);
    const name = p.name.trim().slice(0, 60) || s.peer.endpoint.split(':')[0]!;
    const id = newId('vpn');
    const now = new Date().toISOString();
    this.d.db.run('INSERT INTO vpn_profiles (id, name, data_enc, created_at) VALUES (?, ?, ?, ?)', id, name, this.d.vault.seal(sealLabel(id), JSON.stringify(s)), now);
    this.changed();
    return this.summary(this.row(id), s);
  }

  async remove(id: string): Promise<boolean> {
    this.row(id);
    if (this.d.meta.get<string>(CONNECTED) === id) await this.disconnect();
    this.d.db.run('DELETE FROM vpn_profiles WHERE id = ?', id);
    this.changed();
    return true;
  }

  async status(): Promise<VpnStatus> {
    const [driver, st] = await Promise.all([this.d.driver.ready(), this.d.driver.state().catch(() => ({ up: false, received: null, sent: null }))]);
    let connected = this.d.meta.get<string>(CONNECTED);
    // The tunnel went away by itself (the computer restarted, someone stopped it elsewhere).
    if (connected && !st.up && !this.busy) {
      this.d.meta.delete(CONNECTED);
      connected = null;
    }
    const since = connected ? (this.d.db.get<{ at: string | null }>('SELECT last_connected_at AS at FROM vpn_profiles WHERE id = ?', connected)?.at ?? null) : null;
    return {
      driver,
      profiles: this.list(),
      connected,
      state: this.busy ?? (connected && st.up ? 'on' : this.failure ? 'error' : 'off'),
      message: this.failure,
      since,
      received: st.received,
      sent: st.sent,
    };
  }

  /** Writes the settings file the driver runs the tunnel from (only root, or this user, can read it). */
  private async file(r: Row): Promise<string> {
    mkdirSync(this.d.dir, { recursive: true, mode: 0o700 });
    const path = join(this.d.dir, `${VPN_INTERFACE}.conf`);
    writeFileSync(path, renderVpnSettings(this.settings(r), { dns: await this.d.driver.dns() }), { mode: 0o600 });
    return path;
  }

  async connect(id: string): Promise<VpnStatus> {
    const r = this.row(id);
    const ready = await this.d.driver.ready();
    if (!ready.ready) throw new CoreError('UNAVAILABLE', ready.why ?? 'FBRX VPN cannot run on this computer');
    const now = this.d.meta.get<string>(CONNECTED);
    if (now && now !== id) await this.disconnect();
    this.busy = 'connecting';
    this.failure = null;
    this.changed();
    const path = await this.file(r);
    try {
      await this.d.driver.up(path);
      this.d.meta.set(CONNECTED, id);
      this.d.db.run('UPDATE vpn_profiles SET last_connected_at = ? WHERE id = ?', new Date().toISOString(), id);
    } catch (e) {
      this.failure = (e as Error).message;
      throw e;
    } finally {
      this.busy = null;
      if (!this.d.driver.keepsFile) rmSync(path, { force: true });
      this.changed();
    }
    return this.status();
  }

  async disconnect(): Promise<VpnStatus> {
    const id = this.d.meta.get<string>(CONNECTED);
    const r = id ? this.d.db.get<Row>('SELECT * FROM vpn_profiles WHERE id = ?', id) : undefined;
    // wg-quick reads the settings to take the tunnel down: they are written again for it, then removed.
    const path = r ? await this.file(r) : join(this.d.dir, `${VPN_INTERFACE}.conf`);
    try {
      await this.d.driver.down(path);
    } finally {
      rmSync(path, { force: true });
    }
    this.d.meta.delete(CONNECTED);
    this.failure = null;
    this.changed();
    return this.status();
  }

  async install(): Promise<VpnStatus> {
    await this.d.driver.install();
    this.changed();
    return this.status();
  }

  /** Pings the gate and every paired FBRX computer behind the tunnel, and asks those over FBRX Mesh. */
  async check(): Promise<VpnCheck> {
    const id = this.d.meta.get<string>(CONNECTED);
    const profile = id ? this.list().find((p) => p.id === id) : this.list()[0];
    if (!profile) return { gate: null, computers: [] };
    const behind = (a: string) => isIPv4(a) && (profile.fullTunnel ? /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) : profile.networks.some((n) => inCidr(a, n)));
    const [gate, computers] = await Promise.all([
      profile.gateAddress ? this.d.ping(profile.gateAddress).then((r) => ({ address: profile.gateAddress!, ...r })) : Promise.resolve(null),
      this.d.computers().then((list) =>
        Promise.all(
          list.flatMap((c) => {
            const address = c.addresses.find(behind);
            if (!address) return [];
            return [Promise.all([this.d.ping(address), this.d.meshAnswers(c.id).catch(() => false)]).then(([p, mesh]) => ({ id: c.id, name: c.name, address, ok: p.ok, ms: p.ms, mesh, roles: c.roles }))];
          }),
        ),
      ),
    ]);
    return { gate, computers };
  }

  private changed() {
    this.d.events.emit('vpn.changed', { at: new Date().toISOString() });
  }
}

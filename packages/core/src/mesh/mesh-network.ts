import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces, platform as osPlatform, tmpdir } from 'node:os';
import {
  DSCP_VALUES,
  inCidr,
  JUMBO_MTU,
  MESH_QOS_NFT_REMOVE,
  MESH_QOS_WINDOWS_REMOVE,
  meshQosNftables,
  meshQosWindows,
  type MeshLocalAddress,
  type MeshNetworkStatus,
  type MeshPathTest,
  type MeshTrafficClass,
} from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import { elevated, exec, type ExecResult } from '../windows/ps';

export interface MeshNetworkSettings {
  preferMesh: boolean;
  subnets: string[];
  trafficClass: MeshTrafficClass;
  jumbo: boolean;
}

export interface MeshNetworkDeps {
  settings: () => MeshNetworkSettings;
  port: () => number;
  /** Paired computers, with the address each is reached on. */
  peers: () => Array<{ id: string; name: string; address: string | null }>;
  /** A sealed round trip to a peer (resolves when it answers). */
  hello: (id: string) => Promise<unknown>;
  elevated: () => Promise<boolean>;
  /** Runs a program (tests swap it). */
  exec?: (cmd: string, args: string[]) => Promise<ExecResult>;
  platform?: NodeJS.Platform;
  /** Reads an interface's MTU (tests swap it). */
  mtu?: (iface: string) => Promise<number | null>;
  interfaces?: () => ReturnType<typeof networkInterfaces>;
}

/** Runs a program; never throws (a missing program reports code -1). */
function run(cmd: string, args: string[]): Promise<ExecResult> {
  return exec(cmd, args, { timeoutMs: 20_000 });
}

/**
 * Prefer Mesh: which of this computer's networks carry mesh traffic, whether that traffic is marked for priority
 * (DSCP, which switches and FBRX Gate honor), whether jumbo frames are set up where they should be, and how each paired
 * computer is reached. Choosing the address itself is the mesh's job (see MeshService.addressFor).
 */
export class MeshNetwork {
  private readonly platform: NodeJS.Platform;
  private readonly run: (cmd: string, args: string[]) => Promise<ExecResult>;

  constructor(private readonly d: MeshNetworkDeps) {
    this.platform = d.platform ?? osPlatform();
    this.run = d.exec ?? run;
  }

  private async mtu(iface: string): Promise<number | null> {
    if (this.d.mtu) return this.d.mtu(iface);
    try {
      if (this.platform === 'linux') return Number(readFileSync(`/sys/class/net/${iface}/mtu`, 'utf8').trim()) || null;
      if (this.platform === 'darwin') {
        const r = await this.run('ifconfig', [iface]);
        const m = /\bmtu (\d+)/.exec(r.out);
        return m ? Number(m[1]) : null;
      }
      if (this.platform === 'win32') {
        const r = await this.run('netsh', ['interface', 'ipv4', 'show', 'subinterfaces']);
        for (const line of r.out.split(/\r?\n/)) {
          const m = /^\s*(\d+)\s+\d+\s+\d+\s+\d+\s+(.+?)\s*$/.exec(line);
          if (m && m[2] === iface) return Number(m[1]);
        }
      }
    } catch {
      /* unknown */
    }
    return null;
  }

  async local(): Promise<MeshLocalAddress[]> {
    const s = this.d.settings();
    const out: MeshLocalAddress[] = [];
    for (const [iface, list] of Object.entries((this.d.interfaces ?? networkInterfaces)())) {
      for (const a of list ?? []) {
        if (a.internal || a.family !== 'IPv4' || a.address.startsWith('169.254.')) continue;
        out.push({ address: a.address, iface, cidr: a.cidr ?? `${a.address}/32`, mtu: await this.mtu(iface), preferred: s.subnets.some((n) => inCidr(a.address, n)) });
      }
    }
    return out.sort((x, y) => Number(y.preferred) - Number(x.preferred));
  }

  private method(): MeshNetworkStatus['qos']['method'] {
    return this.platform === 'linux' ? 'nftables' : this.platform === 'win32' ? 'windows' : 'none';
  }

  private script(remove = false): string | null {
    const s = this.d.settings();
    const m = this.method();
    if (m === 'nftables') return remove ? MESH_QOS_NFT_REMOVE : meshQosNftables(this.d.port(), s.trafficClass);
    if (m === 'windows') return remove ? MESH_QOS_WINDOWS_REMOVE : meshQosWindows(this.d.port(), s.trafficClass);
    return null;
  }

  /** Whether the marking is in place: true, false, or null when this account cannot look. */
  private async applied(): Promise<boolean | null> {
    const s = this.d.settings();
    const m = this.method();
    if (m === 'nftables') {
      const r = await this.run('nft', ['list', 'table', 'inet', 'fbrx_mesh']);
      if (r.code === 0) return r.out.includes(`dscp set ${s.trafficClass}`) && r.out.includes(`dport ${this.d.port()}`);
      return /No such file|does not exist/i.test(r.err) ? false : null;
    }
    if (m === 'windows') {
      const r = await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-NetQosPolicy -Name 'FBRX Mesh out' -ErrorAction Stop | Select-Object -ExpandProperty DSCPAction"]);
      if (r.code === 0 && /^\d+/.test(r.out.trim())) return Number(r.out.trim()) === DSCP_VALUES[s.trafficClass];
      return /No MSFT_NetQosPolicySettingData|not found/i.test(r.err) ? false : null;
    }
    return null;
  }

  async status(): Promise<MeshNetworkStatus> {
    const s = this.d.settings();
    const local = await this.local();
    const method = this.method();
    const admin = await this.d.elevated();
    const applied = method === 'none' ? null : await this.applied();
    const warnings: string[] = [];
    if (s.preferMesh && !s.subnets.length) warnings.push('Add the mesh network (for example your AI or server VLAN) so computers reach each other through it first.');
    if (s.preferMesh && s.subnets.length && !local.some((a) => a.preferred)) warnings.push(`This computer has no address in ${s.subnets.join(', ')}: it reaches the others through its usual network.`);
    if (s.jumbo) {
      for (const a of local.filter((x) => x.preferred && x.mtu !== null && x.mtu < JUMBO_MTU)) warnings.push(`${a.iface} (${a.address}) has an MTU of ${a.mtu}, not ${JUMBO_MTU}: set jumbo frames on it, the switch ports and the other computers, or turn jumbo frames off here.`);
    }
    if (s.preferMesh && applied === false) warnings.push('Mesh traffic is not marked for priority on this computer yet.');
    const detail =
      method === 'nftables'
        ? 'Marked by an nftables rule on this computer.'
        : method === 'windows'
          ? 'Marked by a Windows QoS policy on this computer.'
          : 'This system cannot mark its own traffic: mark it at the switch, or let FBRX Gate prioritize the mesh port.';
    return {
      preferMesh: s.preferMesh,
      subnets: s.subnets,
      trafficClass: s.trafficClass,
      dscp: DSCP_VALUES[s.trafficClass],
      port: this.d.port(),
      jumbo: s.jumbo,
      local,
      qos: { method, applied, canApply: method === 'windows' || (method === 'nftables' && admin), detail, script: this.script() },
      warnings,
    };
  }

  /** Marks mesh traffic (or stops). Windows asks for administrator permission; Linux needs to run as root. */
  async applyQos(remove = false): Promise<MeshNetworkStatus> {
    const m = this.method();
    const script = this.script(remove);
    if (m === 'none' || !script) throw new CoreError('UNAVAILABLE', 'This system cannot mark its own traffic. Prioritize the mesh port at the switch or in FBRX Gate.');
    if (m === 'nftables') {
      if (!(await this.d.elevated())) throw new CoreError('FORBIDDEN', 'Marking traffic needs root: run the commands shown here as an administrator (sudo nft -f -).');
      // nft reads rules from a file (not from a pipe, which some versions refuse).
      const dir = mkdtempSync(join(tmpdir(), 'fbrx-nft-'));
      try {
        const file = join(dir, 'mesh.nft');
        writeFileSync(file, script, { mode: 0o600 });
        const r = await this.run('nft', ['-f', file]);
        if (r.code !== 0) throw new CoreError('INTERNAL', `nft: ${(r.err || r.out).trim().slice(0, 300)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      const r = await elevated(script, { timeoutMs: 120_000 });
      if (!r.ok) throw new CoreError('INTERNAL', r.output.slice(0, 300) || 'The QoS policy could not be set');
    }
    return this.status();
  }

  /** How each paired computer is reached, the round trip, and whether jumbo frames get through. */
  async test(peerId?: string): Promise<MeshPathTest[]> {
    const s = this.d.settings();
    const peers = this.d.peers().filter((p) => !peerId || p.id === peerId);
    return Promise.all(
      peers.map(async (p): Promise<MeshPathTest> => {
        const out: MeshPathTest = { peerId: p.id, peerName: p.name, address: p.address, preferred: !!p.address && s.subnets.some((n) => inCidr(p.address!, n)), rttMs: null, jumbo: { tested: false, ok: null, detail: 'Jumbo frames are off for the mesh.' }, error: null };
        try {
          const t0 = performance.now();
          await this.d.hello(p.id);
          out.rttMs = Math.round((performance.now() - t0) * 10) / 10;
        } catch (e) {
          out.error = errorMessage(e);
        }
        if (s.jumbo && p.address) out.jumbo = await this.jumboTo(p.address);
        return out;
      }),
    );
  }

  /** Sends one 9000-byte packet that may not be split up on the way. */
  private async jumboTo(address: string): Promise<MeshPathTest['jumbo']> {
    const payload = String(JUMBO_MTU - 28);
    const args =
      this.platform === 'win32' ? ['-f', '-l', payload, '-n', '1', '-w', '2000', address] : this.platform === 'darwin' ? ['-D', '-s', payload, '-c', '1', '-t', '2', address] : ['-M', 'do', '-s', payload, '-c', '1', '-W', '2', address];
    const r = await this.run('ping', args);
    if (r.code === -1) return { tested: false, ok: null, detail: 'ping is not installed here, so jumbo frames could not be tested.' };
    const text = `${r.out}\n${r.err}`;
    if (r.code === 0 && !/needs to be fragmented|message too long|frag needed|Packet needs to be fragmented/i.test(text)) return { tested: true, ok: true, detail: `9000-byte packets reach ${address} whole.` };
    if (/fragment|message too long|frag needed/i.test(text)) return { tested: true, ok: false, detail: `Somewhere between here and ${address} the MTU is below 9000 (a switch port or the other computer).` };
    return { tested: true, ok: false, detail: `No answer to a 9000-byte packet from ${address} (it may block ping, or jumbo frames stop on the way).` };
  }
}

import { haLinks, type GateHa } from '../ha';
import type { GateConfig } from '../model';
import type { LinuxApplier } from './applier';

/**
 * FBRX Gate's half of a high-availability takeover: the gateway links and the internet port come up on this server
 * (each announcing itself, so switches learn at once where its MAC address is), and DHCP and DNS start answering here;
 * or, on the server that hands over or stops, the other way round. Both servers already have the whole configuration
 * applied, so this takes well under a second.
 */
export class GateHaSwitch {
  constructor(private readonly applier: LinuxApplier) {}

  private async link(dev: string, up: boolean) {
    // Announce the address as the link comes up (a gratuitous ARP), so switches and devices learn where it is now.
    if (up) await this.applier.exec('sysctl', ['-w', `net.ipv4.conf.${dev}.arp_notify=1`]);
    const r = this.applier.mode === 'networkd' ? await this.applier.exec('networkctl', [up ? 'up' : 'down', dev]) : await this.applier.exec('ip', ['link', 'set', 'dev', dev, up ? 'up' : 'down']);
    if (r.code !== 0) throw new Error(`${dev} did not come ${up ? 'up' : 'down'}: ${r.err.trim() || r.out.trim()}`);
  }

  async up(c: GateConfig, ha: GateHa): Promise<string[]> {
    const t0 = performance.now();
    const ms = () => `${Math.round(performance.now() - t0)} ms`;
    const steps: string[] = [];
    const links = haLinks(c, ha);
    // First the open connections the other server sent, into this server's table, so they carry on.
    if (ha.sync) {
      const ctd = (flag: string) => this.applier.exec('conntrackd', ['-C', this.applier.conntrackdConf, flag]);
      const commit = await ctd('-c');
      await ctd('-f');
      await ctd('-R');
      await ctd('-B');
      steps.push(commit.code === 0 ? `Open connections taken over from the other server (${ms()})` : `Open connections were not taken over (conntrackd: ${(commit.err || commit.out).trim().slice(0, 120)}): downloads in progress start again`);
    }
    for (const l of links) await this.link(l.dev, true);
    if (links.length) steps.push(`The gateway address${links.length > 1 ? 'es' : ''} moved here and ${links.length > 1 ? 'were' : 'was'} announced: ${links.map((l) => `${l.address.split('/')[0]} (${l.network})`).join(', ')} (${ms()})`);
    await this.link(c.wan.interface, true);
    if (this.applier.mode === 'iproute' && c.wan.mode === 'static' && c.wan.gateway) await this.applier.exec('ip', ['route', 'replace', 'default', 'via', c.wan.gateway, 'dev', c.wan.interface]);
    steps.push(c.wan.mode === 'dhcp' ? `The internet port is on here, with the pair's MAC address (the provider sees the same machine) (${ms()})` : `The internet port is on here: ${c.wan.address} (${ms()})`);
    await this.applier.startDns();
    steps.push(`DHCP and DNS answer from here, with the leases copied from the other server (${ms()})`);
    return steps;
  }

  async down(c: GateConfig, ha: GateHa): Promise<string[]> {
    const steps: string[] = [];
    await this.applier.stopDns();
    // Connections age out here; the active server's are asked for in full.
    if (ha.sync) {
      await this.applier.exec('conntrackd', ['-C', this.applier.conntrackdConf, '-t']);
      await this.applier.exec('conntrackd', ['-C', this.applier.conntrackdConf, '-n']);
    }
    for (const l of haLinks(c, ha)) await this.link(l.dev, false).catch(() => undefined);
    await this.link(c.wan.interface, false).catch(() => undefined);
    steps.push('FBRX Gate here: the gateway addresses and the internet port are off, DHCP and DNS stopped');
    return steps;
  }
}

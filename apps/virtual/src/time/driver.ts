import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BootCheck, TimeDiskFile, TimeImage, VmDetail } from '@fbrx/shared';
import { VirtualError, badRequest } from '../errors';
import { esc } from '../drivers/xml';
import { virshRunner, type VirshRunner } from '../drivers/virsh';
import { lookAt, readPpm, samplePicture, toPng, type ScreenLook } from './png';

/**
 * What FBRX Time needs from the hypervisor: copy a virtual machine's disks at one moment (while it runs, too), open an
 * image as a throwaway machine with no network to see whether it starts, and make a new machine from an image. The
 * libvirt driver does it with virsh and qemu-img; the simulated one pretends, for development, demos and tests.
 */
export interface TimeDriver {
  readonly kind: 'libvirt' | 'simulated';
  /** Images can be opened here (a hypervisor is installed). */
  canBoot(): Promise<boolean>;
  backupVm(vm: VmDetail, dir: string, progress: (pct: number) => void): Promise<{ disks: TimeDiskFile[]; consistency: TimeImage['consistency']; domainXml: string | null }>;
  bootCheck(image: TimeImage, dir: string, scratch: string, seconds: number, signal?: AbortSignal): Promise<BootCheck>;
  restore(image: TimeImage, dir: string, name: string, imagesDir: string): Promise<{ vmName: string }>;
  /** Format and size of a disk file that arrived from a computer. */
  inspect(file: string): Promise<{ format: TimeDiskFile['format']; virtualBytes: number | null }>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** How a boot check reads what it saw, in words people use. */
export function judgeCheck(o: { ranSeconds: number; stoppedEarly: string | null; agent: boolean | null; screen: ScreenLook | null; screenshot: string | null; at: string }): BootCheck {
  const mins = o.ranSeconds >= 120 ? `${Math.round(o.ranSeconds / 60)} minutes` : `${o.ranSeconds} seconds`;
  const base = { at: o.at, seconds: o.ranSeconds, screenshot: o.screenshot, agent: o.agent };
  if (o.stoppedEarly) return { ...base, state: 'failed', detail: `It stopped by itself after ${mins} (${o.stoppedEarly}). The image may not start; see its screen.` };
  if (o.agent) return { ...base, state: 'passed', detail: `Started and kept running for ${mins}; the guest agent answered, so its operating system is up.` };
  if (o.screen?.graphical) return { ...base, state: 'passed', detail: `Started and kept running for ${mins}; its screen shows a desktop or sign-in picture.` };
  if (o.screen && !o.screen.blank) return { ...base, state: 'warning', detail: `Kept running for ${mins}, but its screen shows only text: a server's sign-in prompt, or a boot error. Look at the picture.` };
  return { ...base, state: 'warning', detail: `Kept running for ${mins}, but its screen stayed blank. It may still be starting, or it did not find what to start.` };
}

// ------------------------------------------------------------------------------------------------ libvirt

function qemuImg(args: string[], progress?: (pct: number) => void, timeoutMs = 12 * 3600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('qemu-img', args, { env: { ...process.env, LC_ALL: 'C' } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      out += s;
      const m = /\((\d+(?:\.\d+)?)\/100%\)/g;
      let last: RegExpExecArray | null = null;
      for (let x = m.exec(s); x; x = m.exec(s)) last = x;
      if (last && progress) progress(Number(last[1]));
      if (out.length > 1_000_000) out = out.slice(-100_000);
    });
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new VirtualError(503, 'qemu-img is not installed on this server (apt install qemu-utils)') : e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new VirtualError(500, `qemu-img ${args[0]} failed: ${err.trim().split('\n').pop() || `exit ${code}`}`));
    });
  });
}

/** The domain XML of a throwaway machine for a boot check: the image's disks behind scratch overlays, no network. */
export function checkDomainXml(o: { name: string; uuid: string; image: TimeImage; overlays: Array<{ path: string; target: string; bus: string }>; memoryMb: number; cpus: number; domainType: 'kvm' | 'qemu' }): string {
  const uefi = o.image.firmware === 'uefi';
  const win = o.image.os === 'windows';
  return [
    `<domain type='${o.domainType}'>`,
    `  <name>${esc(o.name)}</name>`,
    `  <uuid>${o.uuid}</uuid>`,
    `  <description>FBRX Time boot check of ${esc(o.image.subject)} (${esc(o.image.createdAt)}): deleted when the check ends.</description>`,
    `  <memory unit='MiB'>${o.memoryMb}</memory>`,
    `  <vcpu placement='static'>${o.cpus}</vcpu>`,
    `  <os${uefi ? " firmware='efi'" : ''}>`,
    `    <type arch='x86_64' machine='q35'>hvm</type>${uefi ? `\n    <firmware><feature enabled='no' name='secure-boot'/></firmware>` : ''}`,
    `    <boot dev='hd'/>`,
    `  </os>`,
    `  <features><acpi/><apic/>${win ? "<hyperv mode='custom'><relaxed state='on'/><vapic state='on'/><spinlocks state='on' retries='8191'/></hyperv>" : ''}</features>`,
    o.domainType === 'kvm' ? `  <cpu mode='host-passthrough' check='none'/>` : '',
    `  <clock offset='${win ? 'localtime' : 'utc'}'/>`,
    `  <on_poweroff>destroy</on_poweroff>`,
    `  <on_reboot>restart</on_reboot>`,
    `  <on_crash>destroy</on_crash>`,
    `  <devices>`,
    ...o.overlays.map((d) => `    <disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='${esc(d.path)}'/><target dev='${esc(d.target)}' bus='${esc(d.bus)}'/></disk>`),
    // No network card: the copy must not meet the real machine on the network.
    `    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>`,
    `    <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/>`,
    `    <video><model type='${win ? 'vga' : 'virtio'}'/></video>`,
    `    <memballoon model='none'/>`,
    `  </devices>`,
    `</domain>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** A new, stopped virtual machine made from an image: its disks copied, the machine's size and firmware kept, on the default network. */
export function restoreDomainXml(o: { name: string; image: TimeImage; disks: Array<{ path: string; target: string; bus: string }>; memoryMb: number; cpus: number; domainType: 'kvm' | 'qemu'; network: string }): string {
  const uefi = o.image.firmware === 'uefi';
  const win = o.image.os === 'windows';
  return [
    `<domain type='${o.domainType}'>`,
    `  <name>${esc(o.name)}</name>`,
    `  <description>Restored by FBRX Time from ${esc(o.image.subject)} (${esc(o.image.createdAt)})</description>`,
    `  <memory unit='MiB'>${o.memoryMb}</memory>`,
    `  <vcpu placement='static'>${o.cpus}</vcpu>`,
    `  <os${uefi ? " firmware='efi'" : ''}>`,
    `    <type arch='x86_64' machine='q35'>hvm</type>`,
    `    <boot dev='hd'/>`,
    `  </os>`,
    `  <features><acpi/><apic/></features>`,
    o.domainType === 'kvm' ? `  <cpu mode='host-passthrough' check='none'/>` : '',
    `  <clock offset='${win ? 'localtime' : 'utc'}'/>`,
    `  <devices>`,
    ...o.disks.map((d) => `    <disk type='file' device='disk'><driver name='qemu' type='qcow2' discard='unmap'/><source file='${esc(d.path)}'/><target dev='${esc(d.target)}' bus='${esc(d.bus)}'/></disk>`),
    `    <interface type='network'><source network='${esc(o.network)}'/><model type='${win ? 'e1000e' : 'virtio'}'/></interface>`,
    `    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>`,
    `    <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/>`,
    `    <video><model type='${win ? 'vga' : 'virtio'}'/></video>`,
    `  </devices>`,
    `</domain>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Facts kept with a virtual machine's image, so a check or a restore gives it the same size of machine. */
export interface ImageFacts {
  cpus: number;
  memoryMb: number;
}

export class LibvirtTimeDriver implements TimeDriver {
  readonly kind = 'libvirt' as const;
  private readonly virsh: VirshRunner;

  constructor(private readonly opts: { uri: string; virsh?: VirshRunner; facts: (image: TimeImage) => ImageFacts }) {
    this.virsh = opts.virsh ?? virshRunner(opts.uri);
  }

  /** KVM where the processor offers it; FBRX_V_DOMAIN_TYPE=qemu forces software emulation (nested setups, CI). */
  private async domainType(): Promise<'kvm' | 'qemu'> {
    if (process.env.FBRX_V_DOMAIN_TYPE === 'qemu') return 'qemu';
    return existsSync('/dev/kvm') ? 'kvm' : 'qemu';
  }

  async canBoot(): Promise<boolean> {
    try {
      await this.virsh(['version'], { timeoutMs: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  async inspect(file: string): Promise<{ format: TimeDiskFile['format']; virtualBytes: number | null }> {
    const ext = file.toLowerCase().endsWith('.vhdx') ? 'vhdx' : file.toLowerCase().endsWith('.qcow2') ? 'qcow2' : 'raw';
    try {
      const info = JSON.parse(await qemuImg(['info', '--output=json', '-U', file])) as { format?: string; 'virtual-size'?: number };
      const format = info.format === 'vhdx' || info.format === 'qcow2' ? info.format : ext;
      return { format, virtualBytes: info['virtual-size'] ?? null };
    } catch {
      return { format: ext, virtualBytes: null };
    }
  }

  async backupVm(vm: VmDetail, dir: string, progress: (pct: number) => void) {
    const disks = vm.disks.filter((d) => d.device === 'disk' && d.path);
    if (!disks.length) throw badRequest(`${vm.name} has no disks to back up`);
    mkdirSync(dir, { recursive: true });
    const domainXml = await this.virsh(['dumpxml', vm.id, '--inactive']).catch(() => null);
    const live = vm.state === 'running' || vm.state === 'paused';
    let consistency: TimeImage['consistency'] = live ? 'crash' : 'offline';
    const snap = `fbrx-time-${Date.now()}`;
    const overlays = disks.map((d) => ({ target: d.target, path: `${d.path}.${snap}` }));
    if (live) {
      // A moment in time: new writes go to an overlay while the disks underneath are copied, then they are merged back.
      const spec = overlays.flatMap((o) => ['--diskspec', `${o.target},snapshot=external,file=${o.path}`]);
      const base = ['snapshot-create-as', vm.id, snap, '--disk-only', '--atomic', '--no-metadata'];
      try {
        await this.virsh([...base, '--quiesce', ...spec]);
        consistency = 'quiesced';
      } catch {
        await this.virsh([...base, ...spec]);
      }
    }
    const out: TimeDiskFile[] = [];
    try {
      for (let i = 0; i < disks.length; i++) {
        const d = disks[i]!;
        const file = `${d.target}.qcow2`;
        await qemuImg(['convert', '-p', ...(live ? ['-U'] : []), '-O', 'qcow2', d.path!, join(dir, file)], (pct) => progress(Math.round(((i + pct / 100) / disks.length) * 100)));
        const facts = await this.inspect(join(dir, file));
        out.push({ target: d.target, file, format: 'qcow2', bus: d.bus, bytes: statSync(join(dir, file)).size, virtualBytes: facts.virtualBytes });
      }
    } finally {
      if (live) {
        const failed: string[] = [];
        for (const o of overlays) {
          try {
            await this.virsh(['blockcommit', vm.id, o.target, '--active', '--pivot', '--wait'], { timeoutMs: 6 * 3600_000 });
            if (existsSync(o.path)) unlinkSync(o.path);
          } catch {
            failed.push(o.path);
          }
        }
        if (failed.length) throw new VirtualError(500, `The copy is made, but ${vm.name} still writes to ${failed.join(', ')}: merge it back with virsh blockcommit ${vm.name} <disk> --active --pivot`);
      }
    }
    return { disks: out, consistency, domainXml };
  }

  async bootCheck(image: TimeImage, dir: string, scratch: string, seconds: number, signal?: AbortSignal): Promise<BootCheck> {
    mkdirSync(scratch, { recursive: true });
    const name = `fbrx-time-check-${image.id.slice(0, 8)}`;
    const facts = this.opts.facts(image);
    const overlays: Array<{ path: string; target: string; bus: string }> = [];
    const at = new Date().toISOString();
    // A leftover from an earlier check that was cut short.
    await this.virsh(['destroy', name]).catch(() => undefined);
    try {
      for (const d of image.disks) {
        const path = join(scratch, `${d.target}.qcow2`);
        // The image itself is only read: everything the machine writes lands in the overlay, deleted afterwards.
        await qemuImg(['create', '-q', '-f', 'qcow2', '-F', d.format, '-b', join(dir, d.file), path]);
        overlays.push({ path, target: d.target, bus: d.bus });
      }
      const xmlFile = join(scratch, 'domain.xml');
      writeFileSync(xmlFile, checkDomainXml({ name, uuid: randomUUID(), image, overlays, memoryMb: Math.min(Math.max(facts.memoryMb, 1024), 16384), cpus: Math.min(Math.max(facts.cpus, 1), 4), domainType: await this.domainType() }));
      await this.virsh(['create', xmlFile]);
      const t0 = Date.now();
      let stoppedEarly: string | null = null;
      let agent: boolean | null = null;
      while (Date.now() - t0 < seconds * 1000 && !signal?.aborted) {
        await sleep(5000, signal);
        const state = (await this.virsh(['domstate', name]).catch(() => 'shut off')).trim();
        if (state !== 'running' && state !== 'idle' && state !== 'blocked') {
          stoppedEarly = state || 'stopped';
          break;
        }
        if (agent !== true && Date.now() - t0 > 20_000) {
          agent = await this.virsh(['qemu-agent-command', name, '{"execute":"guest-ping"}', '--timeout', '5'], { timeoutMs: 15_000 })
            .then(() => true)
            .catch(() => (agent === null ? null : false));
        }
      }
      if (signal?.aborted) throw new VirtualError(409, 'The check was stopped');
      const ranSeconds = Math.round((Date.now() - t0) / 1000);
      let screen: ScreenLook | null = null;
      let screenshot: string | null = null;
      const ppm = join(scratch, 'screen.ppm');
      if (!stoppedEarly && (await this.virsh(['screenshot', name, ppm]).then(() => true).catch(() => false)) && existsSync(ppm)) {
        try {
          const pic = readPpm(readFileSync(ppm));
          screen = lookAt(pic);
          screenshot = `check-${at.replace(/[:.]/g, '-')}.png`;
          writeFileSync(join(dir, screenshot), toPng(pic));
        } catch {
          /* no picture */
        }
      }
      return judgeCheck({ ranSeconds, stoppedEarly, agent, screen, screenshot, at });
    } finally {
      await this.virsh(['destroy', name]).catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async restore(image: TimeImage, dir: string, name: string, imagesDir: string): Promise<{ vmName: string }> {
    const facts = this.opts.facts(image);
    mkdirSync(imagesDir, { recursive: true });
    const disks: Array<{ path: string; target: string; bus: string }> = [];
    for (const d of image.disks) {
      const path = join(imagesDir, `${name}-${d.target}.qcow2`);
      if (existsSync(path)) throw new VirtualError(409, `${path} already exists: pick another name`);
      await qemuImg(['convert', '-p', '-O', 'qcow2', join(dir, d.file), path]);
      disks.push({ path, target: d.target, bus: d.bus });
    }
    const xmlFile = join(dir, `restore-${name}.xml`);
    writeFileSync(xmlFile, restoreDomainXml({ name, image, disks, memoryMb: facts.memoryMb, cpus: facts.cpus, domainType: await this.domainType(), network: 'default' }));
    try {
      await this.virsh(['define', xmlFile]);
    } finally {
      rmSync(xmlFile, { force: true });
    }
    return { vmName: name };
  }
}

// --------------------------------------------------------------------------------------------- simulated

/** Pretend backups and checks: small files instead of disks, and a made-up screen. */
export class SimulatedTimeDriver implements TimeDriver {
  readonly kind = 'simulated' as const;
  /** For tests: what the next checks see. */
  outcome: 'passed' | 'text' | 'stops' = 'passed';
  restored: Array<{ name: string; from: string }> = [];

  constructor(private readonly opts: { delayMs?: number } = {}) {}

  async canBoot(): Promise<boolean> {
    return true;
  }

  async inspect(file: string): Promise<{ format: TimeDiskFile['format']; virtualBytes: number | null }> {
    const lower = file.toLowerCase();
    return { format: lower.endsWith('.vhdx') ? 'vhdx' : lower.endsWith('.qcow2') ? 'qcow2' : 'raw', virtualBytes: statSync(file).size * 1024 };
  }

  async backupVm(vm: VmDetail, dir: string, progress: (pct: number) => void) {
    mkdirSync(dir, { recursive: true });
    const disks = vm.disks.filter((d) => d.device === 'disk');
    const list = disks.length ? disks : [{ target: vm.os === 'windows' ? 'sda' : 'vda', bus: vm.os === 'windows' ? 'sata' : 'virtio', sizeGb: vm.diskGb }];
    const out: TimeDiskFile[] = [];
    for (let i = 0; i < list.length; i++) {
      const d = list[i]!;
      const file = `${d.target}.qcow2`;
      writeFileSync(join(dir, file), `FBRX Time simulated image of ${vm.name} ${d.target} ${new Date().toISOString()}\n`.repeat(64));
      progress(Math.round(((i + 1) / list.length) * 100));
      await sleep(this.opts.delayMs ?? 0);
      out.push({ target: d.target, file, format: 'qcow2', bus: d.bus, bytes: statSync(join(dir, file)).size, virtualBytes: (('sizeGb' in d ? d.sizeGb : null) ?? vm.diskGb) * 1024 ** 3 });
    }
    return { disks: out, consistency: (vm.state === 'running' ? 'quiesced' : 'offline') as TimeImage['consistency'], domainXml: `<domain><name>${esc(vm.name)}</name></domain>` };
  }

  async bootCheck(image: TimeImage, dir: string, _scratch: string, seconds: number): Promise<BootCheck> {
    await sleep(this.opts.delayMs ?? 0);
    const at = new Date().toISOString();
    if (this.outcome === 'stops') return judgeCheck({ ranSeconds: 12, stoppedEarly: 'shut off', agent: null, screen: null, screenshot: null, at });
    const pic = this.outcome === 'text' ? { width: 160, height: 100, rgb: Buffer.alloc(160 * 100 * 3) } : samplePicture(320, 200, image.os === 'windows' ? 210 : 120);
    if (this.outcome === 'text') for (let i = 0; i < 400; i += 3) pic.rgb[i * 30] = 200;
    const screenshot = `check-${at.replace(/[:.]/g, '-')}.png`;
    writeFileSync(join(dir, screenshot), toPng(pic));
    return judgeCheck({ ranSeconds: seconds, stoppedEarly: null, agent: image.source === 'vm' && this.outcome === 'passed', screen: lookAt(pic), screenshot, at });
  }

  async restore(image: TimeImage, _dir: string, name: string): Promise<{ vmName: string }> {
    this.restored.push({ name, from: image.id });
    return { vmName: name };
  }
}

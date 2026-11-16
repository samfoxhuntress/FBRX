import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import si from 'systeminformation';
import { cleanName, type DeviceFinding, type DeviceReport } from '@fbrx/shared';
import { CoreError } from '../errors';

const run = promisify(execFile);

/** Where systeminformation's answers come from (tests pass their own). */
export interface DeviceSources {
  graphics(): Promise<any>;
  usb(): Promise<any[]>;
  diskLayout(): Promise<any[]>;
  blockDevices(): Promise<any[]>;
  printer(): Promise<any[]>;
}

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? cleanName(v).trim() : '';
  return s && !/^(unknown|default string|to be filled by o\.e\.m\.|n\/a|-)$/i.test(s) ? s : null;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const within = <T>(p: Promise<T>, fallback: T, ms = 15_000): Promise<T> => Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/** The maker's page for a graphics driver, by who made the card. */
export function driverPage(vendor: string | null): string | null {
  const v = (vendor ?? '').toLowerCase();
  if (v.includes('nvidia')) return 'https://www.nvidia.com/Download/index.aspx';
  if (v.includes('amd') || v.includes('advanced micro') || v.includes('ati')) return 'https://www.amd.com/en/support/download/drivers.html';
  if (v.includes('intel')) return 'https://www.intel.com/content/www/us/en/support/detect.html';
  return null;
}

/** What looks wrong in a device report, each with what to do. */
export function deviceFindings(r: Omit<DeviceReport, 'findings' | 'at'>): DeviceFinding[] {
  const out: DeviceFinding[] = [];
  for (const m of r.monitors) {
    // A built-in screen, or one at exactly half its best (a HiDPI screen the system scales, as a Mac reports it), is
    // as it should be.
    const scaled = m.width && m.height && m.bestWidth && m.bestHeight && m.bestWidth === m.width * 2 && m.bestHeight === m.height * 2;
    if (!m.builtin && !scaled && m.width && m.height && m.bestWidth && m.bestHeight && m.width * m.height < m.bestWidth * m.bestHeight) {
      out.push({ device: 'monitor', level: 'warning', title: `${m.name} runs below its best resolution`, detail: `It shows ${m.width}×${m.height}; it can do ${m.bestWidth}×${m.bestHeight}. Set it in the system's display settings, or check the cable and port can carry it.`, link: null });
    }
  }
  for (const g of r.graphics) {
    if (g.temperatureC !== null && g.temperatureC >= 85) out.push({ device: 'graphics', level: 'warning', title: `${g.name} is running hot (${g.temperatureC} °C)`, detail: 'Clean the dust from its fans and vents, give the computer room to breathe, and check its power plan.', link: null });
  }
  if (r.usb.some((u) => /displaylink/i.test(`${u.name} ${u.vendor ?? ''}`))) {
    out.push({ device: 'usb', level: 'info', title: 'A DisplayLink dock or adapter is plugged in', detail: 'Screens on it need its driver: when they stay black, install the driver from its maker.', link: 'https://www.synaptics.com/products/displaylink-graphics/downloads' });
  }
  const nameless = r.usb.filter((u) => !u.name || /^unknown/i.test(u.name)).length;
  if (nameless) out.push({ device: 'usb', level: 'info', title: nameless === 1 ? 'A USB device does not say what it is' : `${nameless} USB devices do not say what they are`, detail: 'One may be missing its driver: unplug it and plug it in again, then look in the system’s device list.', link: null });
  for (const d of r.externalDrives) {
    if (d.health && !/^(ok|good|healthy|verified|passed)$/i.test(d.health)) out.push({ device: 'drive', level: 'warning', title: `${d.name} reports a health problem (${d.health})`, detail: 'Copy what matters off it now, and stop keeping the only copy of anything on it.', link: 'backup' });
  }
  for (const p of r.printers) if (p.status && /error|offline|stopped|jam|paper/i.test(p.status)) out.push({ device: 'printer', level: 'warning', title: `${p.name}: ${p.status}`, detail: 'Network Center → Printers shows its queue, prints a test page and restarts the print service.', link: 'network/printers' });
  return out;
}

/** The devices of this computer (This PC → Devices). */
export async function deviceReport(src: DeviceSources = si as unknown as DeviceSources): Promise<DeviceReport> {
  const [gfx, usb, disks, blocks, printers] = await Promise.all([
    within(src.graphics(), { controllers: [], displays: [] }),
    within(src.usb(), []),
    within(src.diskLayout(), []),
    within(src.blockDevices(), []),
    within(src.printer(), []),
  ]);
  const monitors = (gfx.displays ?? []).map((x: any) => ({
    name: text(x.model) ?? text(x.deviceName) ?? 'Screen',
    vendor: text(x.vendor),
    model: text(x.model),
    serial: text(x.serial),
    year: num(x.productionYear),
    connection: text(x.connection),
    builtin: !!x.builtin,
    main: !!x.main,
    width: num(x.currentResX),
    height: num(x.currentResY),
    bestWidth: num(x.resolutionX),
    bestHeight: num(x.resolutionY),
    hz: num(x.currentRefreshRate),
  }));
  const graphics = (gfx.controllers ?? []).map((g: any) => {
    const vendor = text(g.vendor);
    return {
      name: [vendor, text(g.model)].filter(Boolean).join(' ').replace(/^(\S+) \1 /i, '$1 ') || 'Graphics',
      vendor,
      vramMB: num(g.vram),
      driver: text(g.driverVersion),
      temperatureC: num(g.temperatureGpu),
      loadPct: typeof g.utilizationGpu === 'number' ? g.utilizationGpu : null,
      memoryUsedMB: num(g.memoryUsed),
      memoryTotalMB: num(g.memoryTotal),
      fanPct: typeof g.fanSpeed === 'number' ? g.fanSpeed : null,
      driverPage: driverPage(vendor ?? text(g.model)),
    };
  });
  const external = (disks as any[]).filter((d) => /usb|thunderbolt|1394/i.test(`${d.interfaceType ?? ''}`) || d.removable === true);
  const externalDrives = external.map((d: any) => {
    const device = String(d.device ?? d.name ?? '');
    const parts = (blocks as any[]).filter((b) => b.mount && (b.device === device || String(b.name ?? '').startsWith(device.replace(/^\/dev\//, '')) || (b.physical && b.physical === d.name)));
    return {
      device,
      name: text(d.name) ?? 'External drive',
      vendor: text(d.vendor),
      bytes: num(d.size) ?? 0,
      interface: text(d.interfaceType),
      health: text(d.smartStatus),
      mounts: parts.map((b) => ({ mount: String(b.mount), fs: text(b.fsType), label: text(b.label), device: typeof b.device === 'string' && /^\/dev\/[a-z0-9]+$/.test(b.device) ? b.device : null })),
    };
  });
  const usbDevices = (usb as any[]).map((u) => ({ name: text(u.name) ?? '', vendor: text(u.manufacturer) ?? text(u.vendor), kind: text(u.type), maxPowerMa: num(typeof u.maxPower === 'string' ? Number.parseInt(u.maxPower, 10) : u.maxPower) }));
  const printerList = (printers as any[]).map((p) => ({ name: text(p.name) ?? 'Printer', model: text(p.model), status: text(p.status), local: !!p.local, isDefault: !!p.default }));
  const body = { monitors, graphics, externalDrives, usb: usbDevices, printers: printerList };
  return { at: new Date().toISOString(), ...body, findings: deviceFindings(body) };
}

/** The command that safely ejects a drive: no shell, and only a drive from the Devices list (see ejectDrive). */
export function ejectCommand(platform: NodeJS.Platform, drive: DeviceReport['externalDrives'][number]): Array<[string, string[]]> {
  if (platform === 'win32') {
    const letters = drive.mounts.map((m) => /^([A-Za-z]):/.exec(m.mount)?.[1]?.toUpperCase()).filter((l): l is string => !!l);
    if (!letters.length) throw new CoreError('INVALID_ARGUMENT', 'That drive has no drive letter to eject');
    return letters.map((l) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Shell.Application).Namespace(17).ParseName('${l}:').InvokeVerb('Eject')`]]);
  }
  if (platform === 'darwin') {
    if (!/^\/dev\/disk\d+$/.test(drive.device)) throw new CoreError('INVALID_ARGUMENT', 'That drive cannot be ejected from here');
    return [['diskutil', ['eject', drive.device]]];
  }
  if (!/^\/dev\/[a-z0-9]+$/.test(drive.device)) throw new CoreError('INVALID_ARGUMENT', 'That drive cannot be ejected from here');
  // Each partition unmounted the way the desktop does it (udisksctl, as the person, no root), then the drive powered off.
  const parts = [...new Set(drive.mounts.map((m) => (m.device && /^\/dev\/[a-z0-9]+$/.test(m.device) ? m.device : null)).filter((x): x is string => !!x))];
  return [...parts.map((p): [string, string[]] => ['udisksctl', ['unmount', '-b', p]]), ['udisksctl', ['power-off', '-b', drive.device]]];
}

/** Safely ejects one of the external drives the Devices list shows (anything else is refused). */
export async function ejectDrive(device: string, src?: DeviceSources): Promise<{ message: string }> {
  const drive = (await deviceReport(src)).externalDrives.find((d) => d.device === device);
  if (!drive) throw new CoreError('NOT_FOUND', 'That is not one of the external drives here');
  for (const [cmd, args] of ejectCommand(process.platform, drive)) {
    try {
      await run(cmd, args, { timeout: 60_000, windowsHide: true });
    } catch (err) {
      throw new CoreError('CONFLICT', `${drive.name} could not be ejected: a program may still be using it. Close it and try again. (${(err as Error).message.split('\n')[0]})`);
    }
  }
  return { message: `${drive.name} can be unplugged now.` };
}

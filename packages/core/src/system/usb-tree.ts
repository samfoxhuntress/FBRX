import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cleanName, type DeviceFinding, type UsbNode } from '@fbrx/shared';

/**
 * The USB tree (This PC → Devices): each controller with its hubs and devices on their ports, with the speed each one
 * runs at and the power it asks for, so "this fast drive is on a USB 2 port" can be said. Read from the system on each
 * platform: sysfs on Linux, system_profiler on a Mac, Plug and Play on Windows (no installs).
 */

const run = promisify(execFile);
const name = (v: unknown): string | null => {
  const s = typeof v === 'string' ? cleanName(v).trim() : '';
  return s || null;
};
const node = (o: Partial<UsbNode> & { name: string }): UsbNode => ({ vendor: null, speedMbps: null, usbVersion: null, maxPowerMa: null, hub: false, children: [], ...o });

/** Linux: /sys/bus/usb/devices, with "usbN" for each bus's root hub and "N-1.2" for a device on hub port 1, port 2. */
export function linuxUsbTree(root = '/sys/bus/usb/devices'): UsbNode[] {
  let entries: string[];
  try {
    entries = readdirSync(root).filter((e) => /^(usb\d+|\d+-[\d.]+)$/.test(e));
  } catch {
    return [];
  }
  const read = (dir: string, file: string): string | null => {
    try {
      return readFileSync(join(root, dir, file), 'utf8').trim() || null;
    } catch {
      return null;
    }
  };
  const nodes = new Map<string, UsbNode>();
  for (const e of entries) {
    const speed = Number.parseFloat(read(e, 'speed') ?? '');
    const version = Number.parseFloat(read(e, 'version') ?? '');
    const power = Number.parseInt(read(e, 'bMaxPower') ?? '', 10);
    const hub = read(e, 'bDeviceClass') === '09';
    const product = name(read(e, 'product'));
    const bus = /^usb(\d+)$/.exec(e)?.[1];
    nodes.set(
      e,
      node({
        name: bus ? `USB controller (bus ${bus}${version >= 3 ? ', USB 3' : version >= 2 ? ', USB 2' : ''})` : (product ?? (hub ? 'USB hub' : 'USB device')),
        vendor: bus ? null : name(read(e, 'manufacturer')),
        speedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
        usbVersion: Number.isFinite(version) && version > 0 ? version : null,
        maxPowerMa: Number.isFinite(power) && power > 0 ? power : null,
        hub: hub || !!bus,
      }),
    );
  }
  const parentOf = (e: string): string | null => {
    if (/^usb\d+$/.test(e)) return null;
    const [bus, path] = e.split('-');
    const up = path.split('.').slice(0, -1);
    return up.length ? `${bus}-${up.join('.')}` : `usb${bus}`;
  };
  // Ports in order: "1-2" before "1-10".
  const order = (e: string) => e.replace(/\d+/g, (d) => d.padStart(4, '0'));
  const roots: UsbNode[] = [];
  for (const e of [...nodes.keys()].sort((a, b) => order(a).localeCompare(order(b)))) {
    const parent = parentOf(e);
    const n = nodes.get(e)!;
    if (parent && nodes.has(parent)) nodes.get(parent)!.children.push(n);
    else roots.push(n);
  }
  return roots;
}

/** A speed as a Mac writes it ("Up to 480 Mb/s", "up_to_5_gb_sec", "super_speed") in Mb/s. */
export function macSpeed(v: unknown): number | null {
  const s = String(v ?? '').toLowerCase();
  const m = /(\d+(?:\.\d+)?)\s*[_ ]?(gb|mb)/.exec(s);
  if (m) return Number(m[1]) * (m[2] === 'gb' ? 1000 : 1);
  if (/super_?speed_?plus/.test(s)) return 10000;
  if (/super_?speed/.test(s)) return 5000;
  if (/high_?speed/.test(s)) return 480;
  if (/full_?speed/.test(s)) return 12;
  return null;
}

/** macOS: system_profiler's USB data (SPUSBDataType, or SPUSBHostDataType from macOS 14). */
export function macUsbTree(json: unknown): UsbNode[] {
  const top = json && typeof json === 'object' ? ((json as Record<string, unknown>).SPUSBDataType ?? (json as Record<string, unknown>).SPUSBHostDataType) : null;
  const walk = (o: Record<string, unknown>, root: boolean): UsbNode => {
    const items = Array.isArray(o._items) ? (o._items as Record<string, unknown>[]) : [];
    const speedKey = Object.keys(o).find((k) => /speed/i.test(k));
    const power = Number.parseInt(String(o.current_required ?? o.bus_power_used ?? ''), 10);
    return node({
      name: name(o._name) ?? (root ? 'USB controller' : 'USB device'),
      vendor: name(o.manufacturer ?? o.USBDeviceKeyVendorName),
      speedMbps: speedKey ? macSpeed(o[speedKey]) : null,
      maxPowerMa: Number.isFinite(power) && power > 0 ? power : null,
      hub: root || items.length > 0 || /hub/i.test(String(o._name ?? '')),
      children: items.map((c) => walk(c, false)),
    });
  };
  return Array.isArray(top) ? (top as Record<string, unknown>[]).map((b) => walk(b, true)) : [];
}

/** Windows: Plug and Play devices under USB, each with its parent; the interfaces of one device ("&MI_") left out. */
export function windowsUsbTree(list: Array<{ id: string; name: string | null; parent: string | null; maker: string | null }>): UsbNode[] {
  const devices = list.filter((d) => /^USB\\/i.test(d.id) && !/&MI_\d+/i.test(d.id));
  const byId = new Map(devices.map((d) => [d.id.toUpperCase(), d]));
  const nodes = new Map(
    devices.map((d) => {
      const root = /ROOT_HUB(\d\d)?/i.exec(d.id);
      const gen = root?.[1] === '30' || root?.[1] === '31' ? 'USB 3' : root ? 'USB 2' : null;
      return [d.id.toUpperCase(), node({ name: name(d.name) ?? (root ? 'USB root hub' : 'USB device'), vendor: name(d.maker), hub: !!root || /hub/i.test(d.name ?? ''), speedMbps: gen === 'USB 3' ? 5000 : gen === 'USB 2' ? 480 : null, usbVersion: gen === 'USB 3' ? 3 : gen === 'USB 2' ? 2 : null })];
    }),
  );
  const roots: UsbNode[] = [];
  for (const [id, n] of nodes) {
    const parent = byId.get(id)?.parent?.toUpperCase();
    if (parent && nodes.has(parent)) nodes.get(parent)!.children.push(n);
    else roots.push(n);
  }
  // Only the root hubs carry a speed: Windows does not say what each device negotiated.
  return roots;
}

const WINDOWS_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$d = @(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\\*' })
@($d | ForEach-Object { [pscustomobject]@{ id = $_.InstanceId; name = $_.FriendlyName; maker = $_.Manufacturer; parent = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_Parent').Data } }) | ConvertTo-Json -Compress -Depth 3`;

/** This computer's USB tree, or [] when the system does not say. */
export async function usbTree(platform: NodeJS.Platform = process.platform): Promise<UsbNode[]> {
  try {
    if (platform === 'linux') return linuxUsbTree();
    if (platform === 'darwin') {
      const tryType = async (t: string) => JSON.parse((await run('system_profiler', [t, '-json'], { timeout: 30_000, maxBuffer: 8 << 20 })).stdout);
      const tree = macUsbTree(await tryType('SPUSBDataType'));
      return tree.length ? tree : macUsbTree(await tryType('SPUSBHostDataType'));
    }
    if (platform === 'win32') {
      const out = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], { timeout: 45_000, windowsHide: true, maxBuffer: 8 << 20 })).stdout.trim();
      const parsed = out ? JSON.parse(out) : [];
      return windowsUsbTree(Array.isArray(parsed) ? parsed : [parsed]);
    }
  } catch {
    // The tree is extra: the USB list from systeminformation still shows.
  }
  return [];
}

/** A USB 3 device running at USB 2 speed: on a USB 2 port, a USB 2 hub or a USB 2 cable. */
export function usbFindings(tree: UsbNode[]): DeviceFinding[] {
  const out: DeviceFinding[] = [];
  const walk = (n: UsbNode) => {
    if (!n.hub && n.usbVersion !== null && n.usbVersion >= 3 && n.speedMbps !== null && n.speedMbps <= 480) {
      out.push({ device: 'usb', level: 'info', title: `${n.name} runs at USB 2 speed`, detail: 'It can go faster: plug it into a USB 3 port (often blue, or marked SS) with a USB 3 cable, not through a USB 2 hub.', link: null });
    }
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

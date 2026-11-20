import { hostname, uptime } from 'node:os';
import si from 'systeminformation';
import type { SystemInventory } from '@fbrx/shared';

/**
 * This PC: what the computer is made of, for the This PC page and the AI's system.info. The make and model, serial
 * number, BIOS, processor, each memory module, each drive and its health, graphics and screens, network adapters and
 * the battery, as the system reports them. Read once a minute at most: some of it is slow to ask for.
 */

let cached: { at: number; value: SystemInventory } | null = null;
const TTL = 60_000;

const clean = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  // What makers leave in fields they do not fill.
  return !s || /^(default string|to be filled by o\.?e\.?m\.?|system (product name|serial number|manufacturer|version)|not (specified|available|applicable)|none|0+|-|n\/a|unknown|123456789|o\.e\.m\.)$/i.test(s) ? null : s;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** A promise's value, or the fallback when it fails or takes too long. */
function within<T>(p: Promise<T>, fallback: T, ms = 15_000): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

export async function systemInventory(fresh = false): Promise<SystemInventory> {
  if (!fresh && cached && Date.now() - cached.at < TTL) return cached.value;
  const [sys, bios, board, os, cpu, mem, slots, drives, volumes, gfx, nets, battery, chassis] = await Promise.all([
    within(si.system(), {} as any),
    within(si.bios(), {} as any),
    within(si.baseboard(), {} as any),
    within(si.osInfo(), {} as any),
    within(si.cpu(), {} as any),
    within(si.mem(), {} as any),
    within(si.memLayout(), [] as any[]),
    within(si.diskLayout(), [] as any[]),
    within(si.fsSize(), [] as any[]),
    within(si.graphics(), { controllers: [], displays: [] } as any),
    within(si.networkInterfaces(), [] as any),
    within(si.battery(), {} as any),
    within(si.chassis(), {} as any),
  ]);
  const value: SystemInventory = {
    at: new Date().toISOString(),
    system: {
      manufacturer: clean(sys.manufacturer),
      model: clean(sys.model),
      version: clean(sys.version),
      serial: clean(sys.serial) ?? clean(chassis.serial),
      sku: clean(sys.sku),
      kind: clean(chassis.type),
      virtual: !!sys.virtual,
    },
    bios: { vendor: clean(bios.vendor), version: clean(bios.version), date: clean(bios.releaseDate) },
    board: { manufacturer: clean(board.manufacturer), model: clean(board.model), serial: clean(board.serial) },
    os: { name: clean(os.distro) ?? clean(os.platform) ?? 'Unknown', version: clean(os.release), build: clean(os.build), arch: clean(os.arch), hostname: hostname(), uptimeHours: Math.round(uptime() / 360) / 10 },
    cpu: {
      name: [clean(cpu.manufacturer), clean(cpu.brand)].filter(Boolean).join(' ') || 'Unknown',
      cores: num(cpu.physicalCores),
      threads: num(cpu.cores),
      baseGHz: num(cpu.speed),
      maxGHz: num(cpu.speedMax),
      socket: clean(cpu.socket),
      virtualization: typeof cpu.virtualization === 'boolean' ? cpu.virtualization : null,
    },
    memory: {
      totalBytes: num(mem.total) ?? 0,
      usedBytes: num(mem.active) ?? num(mem.used) ?? 0,
      modules: (Array.isArray(slots) ? slots : [])
        .filter((m: any) => num(m.size))
        .map((m: any) => ({ slot: clean(m.bank) ?? clean(m.formFactor), bytes: m.size, type: clean(m.type), mhz: num(m.clockSpeed), formFactor: clean(m.formFactor), manufacturer: clean(m.manufacturer), part: clean(m.partNum) })),
      slots: (Array.isArray(slots) ? slots : []).length || null,
    },
    drives: (Array.isArray(drives) ? drives : []).map((d: any) => ({
      name: clean(d.name) ?? clean(d.device) ?? 'Drive',
      kind: /nvme/i.test(`${d.interfaceType} ${d.name}`) ? 'NVMe SSD' : clean(d.type) === 'SSD' ? 'SSD' : clean(d.type) === 'HD' ? 'Hard disk' : clean(d.type),
      bytes: num(d.size) ?? 0,
      interface: clean(d.interfaceType),
      vendor: clean(d.vendor),
      serial: clean(d.serialNum),
      health: clean(d.smartStatus),
      temperatureC: num(d.temperature),
    })),
    volumes: (Array.isArray(volumes) ? volumes : [])
      .filter((v: any) => (num(v.size) ?? 0) >= 1024 ** 3 && !/^(\/snap|\/boot\/efi|\/run|\/dev|\/sys|\/proc)/.test(String(v.mount)))
      .map((v: any) => ({ mount: String(v.mount || v.fs), fs: clean(v.type), bytes: v.size, usedBytes: num(v.used) ?? 0 })),
    graphics: (gfx.controllers ?? []).map((g: any) => ({ name: [clean(g.vendor), clean(g.model)].filter(Boolean).join(' ').replace(/^(\S+) \1 /i, '$1 ') || 'Graphics', vramMB: num(g.vram), driver: clean(g.driverVersion) })),
    displays: (gfx.displays ?? []).map((x: any) => ({ name: clean(x.model) ?? clean(x.deviceName) ?? 'Display', main: !!x.main, connection: clean(x.connection), width: num(x.currentResX), height: num(x.currentResY), hz: num(x.currentRefreshRate) })),
    network: (Array.isArray(nets) ? nets : [nets])
      .filter((n: any) => !n.internal && n.mac && !/^(lo|docker|veth|br-|virbr)/.test(String(n.iface)))
      .map((n: any) => ({ name: clean(n.ifaceName) ?? String(n.iface), kind: /wireless|wi-?fi|wlan/i.test(`${n.type} ${n.iface}`) ? 'Wi-Fi' : clean(n.type) === 'wired' ? 'Ethernet' : (clean(n.type) ?? 'Adapter'), mac: String(n.mac), speedMbps: num(n.speed), connected: n.operstate === 'up' || !!n.ip4, ip: clean(n.ip4) })),
    battery: battery.hasBattery
      ? {
          percent: num(battery.percent),
          charging: !!battery.isCharging,
          healthPct: num(battery.designedCapacity) && num(battery.maxCapacity) ? Math.round((battery.maxCapacity / battery.designedCapacity) * 100) : null,
          cycles: num(battery.cycleCount),
          designWh: num(battery.designedCapacity) && battery.capacityUnit === 'mWh' ? Math.round(battery.designedCapacity / 100) / 10 : null,
        }
      : null,
  };
  cached = { at: Date.now(), value };
  return value;
}

export { inventoryText } from '@fbrx/shared';

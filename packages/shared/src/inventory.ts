import type { SystemInventory } from './ext';

const gb = (b: number) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)} TB` : `${Math.round(b / 1024 ** 3)} GB`);

/** The inventory as a few lines of plain text (for the AI). */
export function inventoryText(i: SystemInventory): string {
  const mem = i.memory.modules;
  return [
    `Computer: ${[i.system.manufacturer, i.system.model].filter(Boolean).join(' ') || 'unknown model'}${i.system.serial ? `, serial ${i.system.serial}` : ''}${i.system.virtual ? ' (a virtual machine)' : ''}`,
    `System: ${i.os.name} ${i.os.version ?? ''}${i.os.build ? ` (build ${i.os.build})` : ''}, ${i.os.arch ?? ''}; name ${i.os.hostname}; up ${i.os.uptimeHours} h`,
    `BIOS: ${[i.bios.vendor, i.bios.version, i.bios.date].filter(Boolean).join(' ') || 'not reported'}`,
    `Processor: ${i.cpu.name}${i.cpu.cores ? `, ${i.cpu.cores} cores` : ''}${i.cpu.threads ? ` / ${i.cpu.threads} threads` : ''}${i.cpu.maxGHz ? `, up to ${i.cpu.maxGHz} GHz` : ''}`,
    `Memory: ${gb(i.memory.totalBytes)}${mem.length ? ` in ${mem.length} module(s)${i.memory.slots ? ` of ${i.memory.slots} slots` : ''}: ${mem.map((m) => `${gb(m.bytes)} ${m.type ?? ''}${m.mhz ? ` ${m.mhz} MHz` : ''}`.trim()).join(', ')}` : ''}`,
    ...i.drives.map((d) => `Drive: ${d.name}, ${gb(d.bytes)} ${d.kind ?? ''}${d.health ? `, health ${d.health}` : ''}${d.temperatureC ? `, ${d.temperatureC} °C` : ''}`),
    ...i.volumes.map((v) => `Volume ${v.mount}: ${gb(v.bytes - v.usedBytes)} free of ${gb(v.bytes)}`),
    ...i.graphics.map((g) => `Graphics: ${g.name}${g.vramMB ? `, ${g.vramMB} MB` : ''}`),
    ...i.displays.map((x) => `Display: ${x.name}${x.width && x.height ? `, ${x.width}×${x.height}` : ''}${x.hz ? ` at ${x.hz} Hz` : ''}${x.main ? ' (main)' : ''}`),
    ...i.network.map((n) => `Network: ${n.name} (${n.kind}), ${n.connected ? `connected${n.ip ? ` at ${n.ip}` : ''}` : 'not connected'}, MAC ${n.mac}`),
    i.battery ? `Battery: ${i.battery.percent ?? '?'}%${i.battery.charging ? ', charging' : ''}${i.battery.healthPct ? `, health ${i.battery.healthPct}%` : ''}${i.battery.cycles ? `, ${i.battery.cycles} cycles` : ''}` : 'Battery: none',
  ].join('\n');
}

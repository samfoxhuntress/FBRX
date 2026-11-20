import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deviceReport } from '../src/system/devices';
import { driveSpeed, windowsReadScript } from '../src/system/drive-speed';
import { localPrinterHost, parseIpp, printerSupplies, suppliesRequest } from '../src/system/ipp';
import { inputsFromCapabilities, monitorControls, parseDdcutilDetect, parseDdcutilVcp, parseWindowsDdc, setMonitor, windowsDdcScript } from '../src/system/monitor-control';
import { linuxUsbTree, macSpeed, macUsbTree, usbFindings, windowsUsbTree } from '../src/system/usb-tree';

/** An IPP response with the printer attributes given (integers as numbers, the rest as keywords or text). */
function ippResponse(attrs: Record<string, Array<string | number>>): Buffer {
  const parts: Buffer[] = [Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 0x01])];
  const one = (tag: number, name: string, value: Buffer) => {
    const n = Buffer.from(name);
    const b = Buffer.alloc(5 + n.length + value.length);
    b[0] = tag;
    b.writeUInt16BE(n.length, 1);
    n.copy(b, 3);
    b.writeUInt16BE(value.length, 3 + n.length);
    value.copy(b, 5 + n.length);
    parts.push(b);
  };
  one(0x47, 'attributes-charset', Buffer.from('utf-8'));
  parts.push(Buffer.from([0x04]));
  for (const [name, values] of Object.entries(attrs)) {
    values.forEach((v, i) => {
      const n = i === 0 ? name : '';
      if (typeof v === 'number') {
        const b = Buffer.alloc(4);
        b.writeInt32BE(v);
        one(0x21, n, b);
      } else one(name === 'marker-names' ? 0x41 : 0x44, n, Buffer.from(v));
    });
  }
  parts.push(Buffer.from([0x03]));
  return Buffer.concat(parts);
}

describe('Devices extras (2.5.0): the USB tree, ink levels, a drive speed test and screen settings', () => {
  it('draws the USB tree from sysfs and says when a USB 3 device runs at USB 2 speed', () => {
    const root = mkdtempSync(join(tmpdir(), 'fbrx-sysfs-'));
    const dev = (name: string, files: Record<string, string>) => {
      mkdirSync(join(root, name));
      for (const [f, v] of Object.entries(files)) writeFileSync(join(root, name, f), `${v}\n`);
    };
    dev('usb1', { product: 'EHCI Host Controller', speed: '480', version: ' 2.00', bDeviceClass: '09' });
    dev('usb2', { product: 'xHCI Host Controller', speed: '5000', version: ' 3.00', bDeviceClass: '09' });
    dev('1-1', { product: 'USB2.0 Hub', speed: '480', version: ' 2.00', bDeviceClass: '09', bMaxPower: '100mA' });
    dev('1-1.2', { product: 'Fast\u200B Drive', manufacturer: 'Maker', speed: '480', version: ' 3.20', bDeviceClass: '00', bMaxPower: '896mA' });
    dev('1-1.10', { product: 'Keyboard', speed: '12', version: ' 1.10', bDeviceClass: '00' });
    dev('2-1', { product: 'Quick Drive', speed: '5000', version: ' 3.10', bDeviceClass: '00' });
    // An interface entry ("1-1.2:1.0") is left out; Windows cannot make a folder with a colon in its name.
    if (process.platform !== 'win32') mkdirSync(join(root, '1-1.2:1.0'));
    const tree = linuxUsbTree(root);
    expect(tree.map((n) => n.name)).toEqual(['USB controller (bus 1, USB 2)', 'USB controller (bus 2, USB 3)']);
    const hub = tree[0].children[0];
    expect(hub).toMatchObject({ name: 'USB2.0 Hub', hub: true, maxPowerMa: 100 });
    // Ports in order (2 before 10), names cleaned.
    expect(hub.children.map((c) => c.name)).toEqual(['Fast Drive', 'Keyboard']);
    expect(hub.children[0]).toMatchObject({ vendor: 'Maker', speedMbps: 480, usbVersion: 3.2, maxPowerMa: 896, hub: false });
    expect(usbFindings(tree).map((f) => f.title)).toEqual(['Fast Drive runs at USB 2 speed']);
    expect(linuxUsbTree(join(root, 'nowhere'))).toEqual([]);
  });

  it('reads the Mac’s and Windows’ USB lists into the same tree', () => {
    expect([macSpeed('Up to 480 Mb/s'), macSpeed('up_to_5_gb_sec'), macSpeed('super_speed'), macSpeed('high_speed'), macSpeed('')]).toEqual([480, 5000, 5000, 480, null]);
    const mac = macUsbTree({ SPUSBDataType: [{ _name: 'USB31Bus', _items: [{ _name: 'USB3.0 Hub', manufacturer: 'Hubs Inc', _items: [{ _name: 'Backup Drive', manufacturer: 'Maker', speed: 'Up to 5 Gb/s', current_required: '896' }] }] }] });
    expect(mac[0].children[0].children[0]).toMatchObject({ name: 'Backup Drive', vendor: 'Maker', speedMbps: 5000, maxPowerMa: 896 });
    const win = windowsUsbTree([
      { id: 'USB\\ROOT_HUB30\\4&1', name: 'USB Root Hub (USB 3.0)', parent: 'PCI\\VEN_8086', maker: '(Standard USB HUBs)' },
      { id: 'USB\\VID_0BDA&PID_0411\\1', name: 'Generic SuperSpeed USB Hub', parent: 'USB\\ROOT_HUB30\\4&1', maker: null },
      { id: 'USB\\VID_046D&PID_C52B\\2', name: 'USB Composite Device', parent: 'USB\\VID_0BDA&PID_0411\\1', maker: null },
      { id: 'USB\\VID_046D&PID_C52B&MI_00\\3', name: 'USB Input Device', parent: 'USB\\VID_046D&PID_C52B\\2', maker: null },
    ]);
    expect(win).toHaveLength(1);
    expect(win[0]).toMatchObject({ name: 'USB Root Hub (USB 3.0)', speedMbps: 5000, hub: true });
    expect(win[0].children[0].children.map((c) => c.name)).toEqual(['USB Composite Device']);
  });

  it('asks a printer for its ink and toner over IPP, only on this computer or the local network', async () => {
    let asked: Buffer | null = null;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        asked = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/ipp' });
        res.end(ippResponse({ 'marker-names': ['Black Toner', 'Cyan Toner', 'Waste Toner Box'], 'marker-levels': [8, 60, 5], 'marker-colors': ['#000000', '#00FFFF', 'none'], 'marker-types': ['toner-cartridge', 'toner-cartridge', 'waste-toner'] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const supplies = await printerSupplies(`ipp://127.0.0.1:${port}/ipp/print`);
      expect(supplies).toEqual([
        { name: 'Black Toner', kind: 'toner', color: '#000000', level: 8, low: true },
        { name: 'Cyan Toner', kind: 'toner', color: '#00FFFF', level: 60, low: false },
        { name: 'Waste Toner Box', kind: 'waste', color: null, level: 5, low: true },
      ]);
      // A Get-Printer-Attributes request for the printer, asking for the supplies.
      const req = parseIpp(Buffer.concat([asked!.subarray(0, 8), asked!.subarray(8)]));
      expect(asked!.readUInt16BE(2)).toBe(0x000b);
      expect(req.attributes['printer-uri']).toEqual([`ipp://127.0.0.1:${port}/ipp/print`]);
      expect(req.attributes['requested-attributes']).toContain('marker-levels');
    } finally {
      server.close();
    }
    expect(suppliesRequest('ipp://x/ipp/print')[0]).toBe(2);
    // Never past the local network, and nothing for an address that is not a printer's.
    for (const h of ['localhost', '192.168.1.20', '10.0.0.5', 'printer.local', 'fe80::1']) expect(localPrinterHost(h), h).toBe(true);
    for (const h of ['8.8.8.8', 'example.com', '172.32.0.1']) expect(localPrinterHost(h), h).toBe(false);
    expect(await printerSupplies('ipp://8.8.8.8/ipp/print')).toBeNull();
    expect(await printerSupplies('usb://HP/LaserJet')).toBeNull();
  });

  it('says when a printer’s ink is nearly out, from the device report', async () => {
    const r = await deviceReport({
      graphics: async () => ({ controllers: [], displays: [] }),
      usb: async () => [],
      diskLayout: async () => [],
      blockDevices: async () => [],
      printer: async () => [{ name: 'Office', model: 'Laser 5', status: 'Idle', local: false, default: true, uri: 'ipp://192.168.1.20/ipp/print' }],
      usbTree: async () => [],
      supplies: async (p) => (p.name === 'Office' ? [{ name: 'Black Toner', kind: 'toner', color: '#000000', level: 6, low: true }] : null),
    });
    expect(r.printers[0].supplies?.[0].level).toBe(6);
    expect(r.findings.map((f) => f.title)).toContain('Office: Black Toner is nearly out (6%)');
    expect(r.findings.find((f) => f.title.startsWith('Office'))?.detail).toMatch(/toner cartridge/);
  });

  it('tests a drive’s write and read speed with a file it removes afterwards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-speed-'));
    const r = await driveSpeed(dir, { sizeMB: 8 });
    expect(r.sizeMB).toBe(8);
    expect(r.writeMBps).toBeGreaterThan(0);
    expect(r.readMBps).toBeGreaterThan(0);
    expect(typeof r.readCached).toBe('boolean');
    expect(readdirSync(dir)).toEqual([]);
    await expect(driveSpeed(join(dir, 'gone'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Windows reads past its cache through unbuffered reads; a quote in the path cannot end the string.
    const script = windowsReadScript("E:\\it's\\.fbrx-speed.tmp");
    expect(script).toContain("'E:\\it''s\\.fbrx-speed.tmp'");
    expect(script).toContain('0x20000000');
  });

  it('reads and sets screens over DDC/CI: ddcutil on Linux, dxva2 on Windows, not on a Mac yet', async () => {
    expect(parseDdcutilDetect('Display 1\n   I2C bus:  /dev/i2c-4\n   Monitor:             DEL:DELL U2719D:ABC123\n\nDisplay 2\n   I2C bus:  /dev/i2c-5\n   Monitor:             GSM:LG ULTRAFINE:XYZ\n')).toEqual([
      { display: 1, name: 'DELL U2719D' },
      { display: 2, name: 'LG ULTRAFINE' },
    ]);
    expect(parseDdcutilVcp('VCP 10 C 50 100\nVCP 12 C 75 100\nVCP 60 SNC x0f\n')).toEqual({ brightness: { value: 50, max: 100 }, contrast: { value: 75, max: 100 }, input: { value: 15, max: 255 } });
    expect(inputsFromCapabilities('(prot(monitor)type(LCD)model(U2719D)vcp(02 04 10 12 60(0F 11 12 1B) D6(01 04)))')).toEqual([0x0f, 0x11, 0x12, 0x1b]);
    // ddcutil's listing, with the feature's name in brackets before its values.
    expect(inputsFromCapabilities('   Feature: 10 (Brightness)\n   Feature: 60 (Input Source)\n      Values:\n         0f: DisplayPort-1\n         11: HDMI-1\n   Feature: 62 (Audio)\n         01: x\n')).toEqual([0x0f, 0x11]);
    expect(parseWindowsDdc('[{"index":0,"name":"Generic PnP Monitor","brightness":[40,100],"input":17,"caps":"vcp(10 12 60(11 0F))"},{"index":1,"name":"Built-in","caps":""}]')).toEqual([
      { id: 'win-0', name: 'Generic PnP Monitor', brightness: { value: 40, max: 100 }, contrast: null, input: { value: 17, options: [{ code: 0x11, label: 'HDMI 1' }, { code: 0x0f, label: 'DisplayPort 1' }] } },
    ]);
    const script = windowsDdcScript(1, 0x10, 70);
    expect(script).toContain('[FbrxDdc]::Run(1, 16, 70)');
    expect(script).toContain('SetVCPFeature');
    expect(await monitorControls('darwin')).toMatchObject({ supported: false, why: expect.stringMatching(/not on a Mac yet/) });
    await expect(setMonitor('ddc-1', 'brightness', 50, 'linux')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Linux, with a stand-in for ddcutil (a shell script, which Windows cannot run).
    if (process.platform === 'win32') return;
    const bin = mkdtempSync(join(tmpdir(), 'fbrx-ddc-'));
    const log = join(bin, 'calls.log');
    writeFileSync(
      join(bin, 'ddcutil'),
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\ncase "$*" in\n  "detect --terse") printf 'Display 1\\n   I2C bus:  /dev/i2c-4\\n   Monitor:             DEL:DELL U2719D:ABC\\n' ;;\n  *getvcp*) printf 'VCP 10 C 50 100\\nVCP 12 C 75 100\\nVCP 60 SNC x0f\\n' ;;\n  *capabilities*) printf 'Model: U2719D\\nVCP Features:\\n   Feature: 60 (Input Source)\\n   vcp(10 12 60(0F 11))\\n' ;;\n  *setvcp*) ;;\nesac\n`,
    );
    chmodSync(join(bin, 'ddcutil'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const c = await monitorControls('linux');
      expect(c).toMatchObject({ supported: true, why: null });
      expect(c.monitors[0]).toMatchObject({ id: 'ddc-1', name: 'DELL U2719D', brightness: { value: 50, max: 100 }, input: { value: 15, options: [{ code: 15, label: 'DisplayPort 1' }, { code: 17, label: 'HDMI 1' }] } });
      await setMonitor('ddc-1', 'brightness', 80, 'linux');
      await setMonitor('ddc-1', 'input', 17, 'linux');
      await expect(setMonitor('ddc-1', 'brightness', 101, 'linux')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(setMonitor('ddc-1', 'input', 0x12, 'linux')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      const calls = readFileSync(log, 'utf8');
      expect(calls).toContain('--display 1 setvcp 10 80');
      expect(calls).toContain('--display 1 setvcp 60 17');
    } finally {
      process.env.PATH = path;
    }
    expect(existsSync(log)).toBe(true);
  });
});

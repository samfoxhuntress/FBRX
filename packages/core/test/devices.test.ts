import { describe, expect, it } from 'vitest';
import { deviceReport, driverPage, ejectCommand, type DeviceSources } from '../src/system/devices';

const sources = (over: Partial<Record<keyof DeviceSources, unknown>> = {}): DeviceSources => ({
  graphics: async () =>
    over.graphics ?? {
      controllers: [{ vendor: 'NVIDIA', model: 'NVIDIA GeForce RTX 4060', vram: 8192, driverVersion: '561.09', temperatureGpu: 88, utilizationGpu: 40 }],
      displays: [{ vendor: 'Dell', model: 'U2723QE', serial: 'ABC123', productionYear: 2023, connection: 'DisplayPort', main: true, currentResX: 2560, currentResY: 1440, resolutionX: 3840, resolutionY: 2160, currentRefreshRate: 60 }],
    },
  usb: async () => (over.usb as any[]) ?? [{ name: 'DisplayLink USB3.0 Dock', manufacturer: 'DisplayLink', type: 'Video' }, { name: '', manufacturer: null }],
  diskLayout: async () => (over.diskLayout as any[]) ?? [{ device: '/dev/sdb', name: 'SanDisk Ultra', vendor: 'SanDisk', size: 64e9, interfaceType: 'USB', smartStatus: 'Predicted Failure' }, { device: '/dev/nvme0n1', name: 'Samsung 990', interfaceType: 'PCIe', size: 1e12 }],
  blockDevices: async () => (over.blockDevices as any[]) ?? [{ name: 'sdb1', device: '/dev/sdb1', mount: '/media/sam/USB', fsType: 'vfat', label: 'USB' }],
  printer: async () => (over.printer as any[]) ?? [{ name: 'Office\u202e printer', status: 'Paper jam', local: false, default: true }],
});

describe('This PC → Devices', () => {
  it('reads each kind of device, cleans their names, and says what looks wrong and what to do', async () => {
    const r = await deviceReport(sources());
    expect(r.monitors).toMatchObject([{ vendor: 'Dell', model: 'U2723QE', serial: 'ABC123', year: 2023, width: 2560, bestWidth: 3840, hz: 60 }]);
    expect(r.graphics[0]).toMatchObject({ name: 'NVIDIA GeForce RTX 4060', driver: '561.09', temperatureC: 88, driverPage: driverPage('NVIDIA') });
    expect(r.externalDrives).toMatchObject([{ device: '/dev/sdb', name: 'SanDisk Ultra', health: 'Predicted Failure', mounts: [{ mount: '/media/sam/USB', fs: 'vfat', label: 'USB', device: '/dev/sdb1' }] }]);
    expect(r.printers[0]!.name).toBe('Office printer');
    const titles = r.findings.map((f) => f.title).join(' | ');
    expect(titles).toMatch(/U2723QE runs below its best resolution/);
    expect(titles).toMatch(/running hot \(88 °C\)/);
    expect(titles).toMatch(/DisplayLink dock/);
    expect(titles).toMatch(/A USB device does not say what it is/);
    expect(titles).toMatch(/SanDisk Ultra reports a health problem/);
    expect(titles).toMatch(/Office printer: Paper jam/);
  });

  it('leaves a scaled HiDPI or built-in screen alone, and counts nameless USB devices once', async () => {
    const r = await deviceReport(
      sources({
        graphics: { controllers: [], displays: [{ model: 'Retina', builtin: true, currentResX: 1512, currentResY: 982, resolutionX: 3024, resolutionY: 1964 }, { model: 'Studio', currentResX: 2560, currentResY: 1440, resolutionX: 5120, resolutionY: 2880 }] },
        usb: [{ name: '' }, { name: 'Unknown device' }, { name: 'Keyboard' }],
      }),
    );
    expect(r.findings.filter((f) => f.device === 'monitor')).toEqual([]);
    expect(r.findings.filter((f) => f.device === 'usb').map((f) => f.title)).toEqual(['2 USB devices do not say what they are']);
  });

  it('says nothing is wrong when nothing is, and copes with a system that reports nothing', async () => {
    const quiet = await deviceReport(sources({ graphics: { controllers: [], displays: [] }, usb: [], diskLayout: [], blockDevices: [], printer: [] }));
    expect(quiet).toMatchObject({ monitors: [], graphics: [], externalDrives: [], usb: [], printers: [], findings: [] });
    const failing = { graphics: () => Promise.reject(new Error('x')), usb: () => Promise.reject(new Error('x')), diskLayout: () => Promise.reject(new Error('x')), blockDevices: () => Promise.reject(new Error('x')), printer: () => Promise.reject(new Error('x')) } as unknown as DeviceSources;
    expect((await deviceReport(failing)).findings).toEqual([]);
  });

  it('ejects only with the system’s own tools, and only a drive it can name safely', () => {
    const drive = { device: '/dev/sdb', name: 'USB', vendor: null, bytes: 1, interface: 'USB', health: null, mounts: [{ mount: '/media/sam/USB', fs: 'vfat', label: null, device: '/dev/sdb1' }] };
    expect(ejectCommand('linux', drive)).toEqual([['udisksctl', ['unmount', '-b', '/dev/sdb1']], ['udisksctl', ['power-off', '-b', '/dev/sdb']]]);
    expect(() => ejectCommand('linux', { ...drive, device: '/dev/sdb; rm -rf /' })).toThrow();
    expect(ejectCommand('darwin', { ...drive, device: '/dev/disk4' })).toEqual([['diskutil', ['eject', '/dev/disk4']]]);
    const win = ejectCommand('win32', { ...drive, device: '\\\\.\\PHYSICALDRIVE2', mounts: [{ mount: 'E:\\', fs: 'NTFS', label: null, device: null }] });
    expect(win[0]![1].join(' ')).toContain("ParseName('E:').InvokeVerb('Eject')");
    expect(() => ejectCommand('win32', { ...drive, mounts: [] })).toThrow(/no drive letter/);
  });
});

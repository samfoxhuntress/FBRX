import { describe, expect, it } from 'vitest';
import type { VmCreateSpec } from '@fbrx/shared';
import { buildDomainXml, editDomainXml, hostdevXml, parseDomainXml } from '../src/drivers/xml';

const linux: VmCreateSpec = { name: 'web-01', os: 'linux', cpus: 2, memoryMb: 2048, diskGb: 20, network: { kind: 'network', source: 'default' }, firmware: 'bios', description: 'Web & <proxy>' };

describe('domain XML', () => {
  it('builds a Linux machine and reads it back', () => {
    const xml = buildDomainXml({ spec: linux, domainType: 'kvm', diskPath: '/var/lib/fbrx-virtual/images/web-01.qcow2', isoPath: '/isos/debian.iso', tpmAvailable: false, createdAt: '2026-10-06T00:00:00.000Z' });
    expect(xml).toContain("<domain type='kvm'>");
    expect(xml).toContain("host-passthrough");
    expect(xml).toContain('Web &amp; &lt;proxy&gt;');
    const p = parseDomainXml(xml.replace('<name>', '<uuid>1b4e28ba-2fa1-11d2-883f-0016d3cca427</uuid>\n  <name>'));
    expect(p).toMatchObject({ uuid: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', name: 'web-01', description: 'Web & <proxy>', os: 'linux', memoryMb: 2048, cpus: 2, firmware: 'bios', secureBoot: false, tpm: false, machine: 'q35', createdAt: '2026-10-06T00:00:00.000Z', vncPort: null });
    expect(p.disks).toEqual([
      { target: 'vda', device: 'disk', path: '/var/lib/fbrx-virtual/images/web-01.qcow2', bus: 'virtio' },
      { target: 'sda', device: 'cdrom', path: '/isos/debian.iso', bus: 'sata' },
    ]);
    expect(p.nics).toEqual([{ mac: '', kind: 'network', source: 'default', model: 'virtio' }]);
  });

  it('gives Windows SATA, an Intel NIC, Hyper-V hints, Secure Boot and a TPM', () => {
    const xml = buildDomainXml({
      spec: { ...linux, name: 'win11', os: 'windows', firmware: 'uefi', secureBoot: true, tpm: true, network: { kind: 'bridge', source: 'br0' } },
      domainType: 'qemu',
      diskPath: '/d/win11.qcow2',
      isoPath: null,
      tpmAvailable: true,
      createdAt: 'x',
    });
    expect(xml).not.toContain('host-passthrough');
    expect(xml).toContain("<os firmware='efi'>");
    expect(xml).toContain("<feature enabled='yes' name='secure-boot'/>");
    expect(xml).toContain("<smm state='on'/>");
    expect(xml).toContain("<model type='e1000e'/>");
    expect(xml).toContain("<source bridge='br0'/>");
    expect(xml).toContain('tpm-crb');
    const p = parseDomainXml(xml);
    expect(p).toMatchObject({ os: 'windows', firmware: 'uefi', secureBoot: true, tpm: true });
    expect(p.disks[0]).toMatchObject({ target: 'sda', bus: 'sata' });
    expect(p.disks[1]).toMatchObject({ device: 'cdrom', path: null });
    expect(p.nics[0]).toMatchObject({ kind: 'bridge', source: 'br0', model: 'e1000e' });
  });

  it('leaves the TPM out when swtpm is missing', () => {
    const xml = buildDomainXml({ spec: { ...linux, tpm: true }, domainType: 'qemu', diskPath: '/d', isoPath: null, tpmAvailable: false, createdAt: 'x' });
    expect(xml).not.toContain('<tpm');
  });

  it('reads machines libvirt wrote (KiB memory, live VNC port, passthrough, pinned CPUs)', () => {
    const xml = `<domain type='kvm' id='3'>
  <name>legacy</name>
  <uuid>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</uuid>
  <memory unit='KiB'>4194304</memory>
  <vcpu placement='static' cpuset='0-3'>4</vcpu>
  <os><type arch='x86_64' machine='pc-q35-8.2'>hvm</type><loader readonly='yes' secure='yes' type='pflash'>/usr/share/OVMF/OVMF_CODE_4M.ms.fd</loader></os>
  <features><acpi/><hyperv mode='custom'><relaxed state='on'/></hyperv></features>
  <devices>
    <disk type='file' device='disk'><source file='/x.qcow2'/><target dev='sda' bus='sata'/></disk>
    <interface type='network'><mac address='52:54:00:12:34:56'/><source network='lab'/><model type='virtio'/></interface>
    <hostdev mode='subsystem' type='pci' managed='yes'><source><address domain='0x0000' bus='0x02' slot='0x00' function='0x1'/></source></hostdev>
    <graphics type='vnc' port='5901' autoport='yes' listen='127.0.0.1'/>
    <tpm model='tpm-crb'/>
  </devices>
</domain>`;
    expect(parseDomainXml(xml)).toMatchObject({ name: 'legacy', os: 'windows', memoryMb: 4096, cpus: 4, cpuset: '0-3', firmware: 'uefi', secureBoot: true, tpm: true, vncPort: 5901, hostdevs: ['0000:02:00.1'], nics: [{ mac: '52:54:00:12:34:56', kind: 'network', source: 'lab', model: 'virtio' }] });
  });

  it('edits processors, memory, placement and description', () => {
    const base = `<domain type='kvm'>\n  <name>a</name>\n  <memory unit='KiB'>1048576</memory>\n  <currentMemory unit='KiB'>1048576</currentMemory>\n  <vcpu placement='static'>1</vcpu>\n</domain>`;
    const out = editDomainXml(base, { cpus: 4, memoryMb: 8192, cpuset: '2-5', description: 'Lab & test' });
    expect(out).toContain("<vcpu placement='static' cpuset='2-5'>4</vcpu>");
    expect(out).toContain("<memory unit='KiB'>8388608</memory>");
    expect(out).toContain("<currentMemory unit='KiB'>8388608</currentMemory>");
    expect(out).toContain('<description>Lab &amp; test</description>');
    const again = editDomainXml(out, { cpus: 2, description: '' });
    expect(again).toContain("<vcpu placement='static' cpuset='2-5'>2</vcpu>");
    expect(again).not.toContain('<description>');
    expect(editDomainXml(out, { cpuset: null })).toContain("<vcpu placement='static'>4</vcpu>");
  });

  it('makes hostdev XML only for real PCI addresses', () => {
    expect(hostdevXml('0000:02:00.1')).toContain("bus='0x02' slot='0x00' function='0x1'");
    expect(() => hostdevXml("0000:02:00.1'/><evil")).toThrow();
  });
});

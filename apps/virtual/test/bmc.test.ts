import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '@fbrx/shared/node';
import { BmcService } from '../src/bmc/service';
import { checkHost, controllerKind } from '../src/bmc/redfish';
import { VIRTUAL_MIGRATIONS } from '../src/migrations';
import { startMockIdrac, type MockIdrac } from './idrac-mock';

let idrac: MockIdrac;
let db: Db;
let bmc: BmcService;

beforeAll(async () => {
  idrac = await startMockIdrac();
  db = new Db(':memory:');
  db.migrate(VIRTUAL_MIGRATIONS);
  bmc = new BmcService(db, randomBytes(32));
});
afterAll(async () => {
  db.close();
  await idrac.close();
});

describe('management controller (Redfish)', () => {
  it('checks host names and tells controllers apart', () => {
    expect(checkHost('https://192.168.1.20/')).toBe('192.168.1.20');
    expect(checkHost('idrac.example.lan:8443')).toBe('idrac.example.lan:8443');
    expect(() => checkHost('a b/../c')).toThrow();
    expect(controllerKind({ Vendor: 'Dell' }, { Model: '13G Monolithic' })).toBe('iDRAC 8');
    expect(controllerKind({ Vendor: 'Dell' }, { Model: '14G Monolithic' })).toBe('iDRAC 9');
    expect(controllerKind({ Oem: { Hpe: {} } }, null)).toBe('iLO');
    expect(controllerKind({}, null)).toBe('Redfish');
  });

  it('shows the certificate, then connects by its fingerprint', async () => {
    const probe = await bmc.probe(idrac.host);
    expect(probe.fingerprint).toBe(idrac.fingerprint);
    expect(probe.trusted).toBe(false);
    await expect(bmc.connect({ host: idrac.host, username: 'root', password: 'wrong', fingerprint: probe.fingerprint })).rejects.toThrow(/username or password/);
    await expect(bmc.connect({ host: idrac.host, username: 'root', password: 'calvin', fingerprint: 'AA:BB' })).rejects.toThrow(/different certificate/);
    const cfg = await bmc.connect({ host: idrac.host, username: 'root', password: 'calvin', fingerprint: probe.fingerprint });
    expect(cfg).toMatchObject({ host: idrac.host, username: 'root', kind: 'iDRAC 8', lastError: null });
    // The password is kept encrypted.
    expect(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'bmc'")!.value).not.toContain('calvin');
  });

  it('reads the system, sensors and event log', async () => {
    const sys = await bmc.use((rf) => rf.system());
    expect(sys).toMatchObject({ manufacturer: 'Dell Inc.', model: 'PowerEdge R330', serviceTag: 'ABC1234', biosVersion: '2.11.0', powerState: 'On', health: 'OK', processors: '1 × Intel(R) Xeon(R) CPU E3-1230 v5 @ 3.40GHz', memoryGb: 32, controller: { name: 'iDRAC 8', firmware: '2.83.83.83' } });
    expect(sys.resetTypes).toContain('GracefulRestart');
    const sensors = await bmc.use((rf) => rf.sensors());
    expect(sensors.find((s) => s.name === 'CPU1 Temp')).toMatchObject({ kind: 'temperature', reading: 41, unit: '°C', upperCritical: 95 });
    expect(sensors.find((s) => s.kind === 'fan')).toMatchObject({ name: 'System Board Fan1', reading: 4920, unit: 'RPM' });
    expect(sensors.find((s) => s.kind === 'power')).toMatchObject({ reading: 58, unit: 'W' });
    expect(sensors.some((s) => s.name === 'PS1 Status')).toBe(false);
    const logs = await bmc.use((rf) => rf.logs());
    expect(logs[0]).toMatchObject({ id: '2', severity: 'Warning' });
  });

  it('reads BIOS settings with names, groups and choices', async () => {
    const bios = await bmc.use((rf) => rf.bios());
    const vt = bios.attributes.find((a) => a.name === 'ProcVirtualization')!;
    expect(vt).toMatchObject({ displayName: 'Virtualization Technology', value: 'Disabled', pending: null, type: 'enum', group: 'Processor Settings', readOnly: false, help: 'Turns on processor virtualization.' });
    expect(vt.options).toEqual([
      { value: 'Enabled', label: 'Enabled' },
      { value: 'Disabled', label: 'Disabled' },
    ]);
    expect(bios.attributes.some((a) => a.name === 'NumLock')).toBe(false); // hidden
    expect(bios.attributes.find((a) => a.name === 'SystemServiceTag')?.readOnly).toBe(true);
    expect(bios.attributes.find((a) => a.name === 'AcPwrRcvryUserDelay')).toMatchObject({ type: 'integer', min: 60, max: 240 });
    expect(bios.pendingCount).toBe(0);
  });

  it('stages BIOS changes as a job for the next restart, and can throw them away', async () => {
    await expect(bmc.use((rf) => rf.setBios({ ProcVirtualization: 'Sideways' }))).rejects.toThrow(/can be Enabled, Disabled/);
    await expect(bmc.use((rf) => rf.setBios({ SystemServiceTag: 'X' }))).rejects.toThrow(/cannot be changed/);
    await expect(bmc.use((rf) => rf.setBios({ AcPwrRcvryUserDelay: 999 }))).rejects.toThrow(/from 60 to 240/);
    await expect(bmc.use((rf) => rf.setBios({ NoSuchThing: 'x' }))).rejects.toThrow(/no setting/);
    const r = await bmc.use((rf) => rf.setBios({ ProcVirtualization: 'Enabled', SriovGlobalEnable: 'Enabled' }));
    expect(r.jobId).toBe('JID_1');
    expect(idrac.state.pending).toEqual({ ProcVirtualization: 'Enabled', SriovGlobalEnable: 'Enabled' });
    // A second change while the job waits rides along with it.
    expect((await bmc.use((rf) => rf.setBios({ SysProfile: 'PerfOptimized' }))).jobId).toBeNull();
    const bios = await bmc.use((rf) => rf.bios());
    expect(bios.pendingCount).toBe(3);
    expect(bios.attributes.find((a) => a.name === 'ProcVirtualization')?.pending).toBe('Enabled');
    expect(bios.jobs[0]).toMatchObject({ id: 'JID_1', state: 'Scheduled' });
    await bmc.use((rf) => rf.clearPending());
    expect(idrac.state.jobs).toEqual([]);
    expect(idrac.state.pending).toEqual({});
  });

  it('boots into BIOS setup once and restarts', async () => {
    await bmc.use((rf) => rf.bootToSetup(true));
    expect(idrac.state.bootOverride).toEqual({ BootSourceOverrideTarget: 'BiosSetup', BootSourceOverrideEnabled: 'Once' });
    expect(idrac.state.resets.at(-1)).toBe('GracefulRestart');
  });

  it('remembers the last failure', async () => {
    const bad = new BmcService(db, randomBytes(32));
    expect(() => bad.client()).toThrow(); // a different key cannot open the saved password
    bmc.disconnect();
    expect(bmc.config()).toBeNull();
    expect(() => bmc.client()).toThrow(/Connect the management controller/);
  });
});

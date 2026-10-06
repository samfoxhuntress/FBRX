import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createSelfSignedCertificate } from '@fbrx/shared/node';

/** A pretend Dell iDRAC 8 speaking Redfish, enough for FBRX Virtual's server page. */
export interface MockIdrac {
  url: string;
  host: string;
  fingerprint: string;
  state: {
    power: string;
    bios: Record<string, string | number>;
    pending: Record<string, string | number>;
    jobs: Array<{ Id: string; Name: string; JobState: string; PercentComplete: number; Message: string }>;
    resets: string[];
    bootOverride: unknown;
  };
  close(): Promise<void>;
}

export async function startMockIdrac(user = 'root', password = 'calvin'): Promise<MockIdrac> {
  const cert = createSelfSignedCertificate({ commonName: 'idrac-mock', names: ['127.0.0.1'] });
  const state: MockIdrac['state'] = {
    power: 'On',
    bios: { ProcVirtualization: 'Disabled', SriovGlobalEnable: 'Disabled', SysProfile: 'PerfPerWattOptimizedDapc', BootMode: 'Uefi', NumLock: 'On', AcPwrRcvryUserDelay: 60, SystemServiceTag: 'ABC1234' },
    pending: {},
    jobs: [],
    resets: [],
    bootOverride: null,
  };
  const SYS = '/redfish/v1/Systems/System.Embedded.1';
  const MGR = '/redfish/v1/Managers/iDRAC.Embedded.1';
  const CH = '/redfish/v1/Chassis/System.Embedded.1';
  const registry = {
    RegistryEntries: {
      Menus: [
        { MenuName: 'ProcSettings', DisplayName: 'Processor Settings', MenuPath: './ProcSettings' },
        { MenuName: 'IntegratedDevices', DisplayName: 'Integrated Devices', MenuPath: './IntegratedDevices' },
        { MenuName: 'SysProfileSettings', DisplayName: 'System Profile Settings', MenuPath: './SysProfileSettings' },
        { MenuName: 'BootSettings', DisplayName: 'Boot Settings', MenuPath: './BootSettings' },
      ],
      Attributes: [
        { AttributeName: 'ProcVirtualization', DisplayName: 'Virtualization Technology', Type: 'Enumeration', Value: [{ ValueName: 'Enabled', ValueDisplayName: 'Enabled' }, { ValueName: 'Disabled', ValueDisplayName: 'Disabled' }], MenuPath: './ProcSettings', HelpText: 'Turns on processor virtualization.', ReadOnly: false },
        { AttributeName: 'SriovGlobalEnable', DisplayName: 'SR-IOV Global Enable', Type: 'Enumeration', Value: [{ ValueName: 'Enabled', ValueDisplayName: 'Enabled' }, { ValueName: 'Disabled', ValueDisplayName: 'Disabled' }], MenuPath: './IntegratedDevices', ReadOnly: false },
        { AttributeName: 'SysProfile', DisplayName: 'System Profile', Type: 'Enumeration', Value: [{ ValueName: 'PerfPerWattOptimizedDapc', ValueDisplayName: 'Performance Per Watt (DAPC)' }, { ValueName: 'PerfOptimized', ValueDisplayName: 'Performance' }], MenuPath: './SysProfileSettings', ReadOnly: false },
        { AttributeName: 'BootMode', DisplayName: 'Boot Mode', Type: 'Enumeration', Value: [{ ValueName: 'Bios', ValueDisplayName: 'BIOS' }, { ValueName: 'Uefi', ValueDisplayName: 'UEFI' }], MenuPath: './BootSettings', ReadOnly: false },
        { AttributeName: 'NumLock', DisplayName: 'Keyboard NumLock', Type: 'Enumeration', Value: [{ ValueName: 'On', ValueDisplayName: 'On' }, { ValueName: 'Off', ValueDisplayName: 'Off' }], MenuPath: './Miscellaneous', Hidden: true },
        { AttributeName: 'AcPwrRcvryUserDelay', DisplayName: 'User Defined Delay (60s to 240s)', Type: 'Integer', LowerBound: 60, UpperBound: 240, MenuPath: './SysSecurity', ReadOnly: false },
        { AttributeName: 'SystemServiceTag', DisplayName: 'Service Tag', Type: 'String', MenuPath: './SysInformation', ReadOnly: true },
      ],
    },
  };
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer({ key: cert.keyPem, cert: cert.certPem }, (req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`) return json(res, 401, { error: { message: 'Unauthorized' } });
      const body = raw ? JSON.parse(raw) : null;
      const path = (req.url ?? '').split('?')[0]!;
      const m = req.method;
      if (m === 'GET' && path === '/redfish/v1') return json(res, 200, { RedfishVersion: '1.4.0', Oem: { Dell: {} }, Vendor: 'Dell' });
      if (m === 'GET' && path === '/redfish/v1/Systems') return json(res, 200, { Members: [{ '@odata.id': SYS }] });
      if (m === 'GET' && path === '/redfish/v1/Managers') return json(res, 200, { Members: [{ '@odata.id': MGR }] });
      if (m === 'GET' && path === '/redfish/v1/Chassis') return json(res, 200, { Members: [{ '@odata.id': CH }] });
      if (m === 'GET' && path === MGR) return json(res, 200, { Id: 'iDRAC.Embedded.1', Model: '13G Monolithic', FirmwareVersion: '2.83.83.83' });
      if (m === 'GET' && path === SYS)
        return json(res, 200, {
          Manufacturer: 'Dell Inc.',
          Model: 'PowerEdge R330',
          SerialNumber: 'CN7016',
          SKU: 'ABC1234',
          BiosVersion: '2.11.0',
          PowerState: state.power,
          Status: { Health: 'OK', HealthRollup: 'OK' },
          HostName: 'fbrx-server',
          ProcessorSummary: { Count: 1, Model: 'Intel(R) Xeon(R) CPU E3-1230 v5 @ 3.40GHz' },
          MemorySummary: { TotalSystemMemoryGiB: 32 },
          Actions: { '#ComputerSystem.Reset': { 'ResetType@Redfish.AllowableValues': ['On', 'ForceOff', 'GracefulRestart', 'GracefulShutdown', 'PushPowerButton', 'Nmi'] } },
        });
      if (m === 'PATCH' && path === SYS) {
        state.bootOverride = body?.Boot;
        return json(res, 200, {});
      }
      if (m === 'POST' && path === `${SYS}/Actions/ComputerSystem.Reset`) {
        state.resets.push(body.ResetType);
        return json(res, 204, {});
      }
      if (m === 'GET' && path === `${SYS}/Bios`) return json(res, 200, { '@odata.id': `${SYS}/Bios`, AttributeRegistry: 'BiosAttributeRegistry.v1_0_3', Attributes: state.bios, '@Redfish.Settings': { SettingsObject: { '@odata.id': `${SYS}/Bios/Settings` } } });
      if (m === 'GET' && path === `${SYS}/Bios/BiosRegistry`) return json(res, 200, registry);
      if (m === 'GET' && path === `${SYS}/Bios/Settings`) return json(res, 200, { Attributes: { ...state.bios, ...state.pending } });
      if (m === 'PATCH' && path === `${SYS}/Bios/Settings`) {
        Object.assign(state.pending, body.Attributes);
        return json(res, 200, {});
      }
      if (m === 'POST' && path === `${SYS}/Bios/Settings/Actions/Oem/DellManager.ClearPending`) {
        state.pending = {};
        return json(res, 200, {});
      }
      if (m === 'POST' && path === `${MGR}/Jobs`) {
        if (state.jobs.some((j) => j.JobState === 'Scheduled')) return json(res, 400, { error: { '@Message.ExtendedInfo': [{ Message: 'Pending configuration job already exists.' }] } });
        const id = `JID_${state.jobs.length + 1}`;
        state.jobs.push({ Id: id, Name: 'ConfigBIOS:BIOS.Setup.1-1', JobState: 'Scheduled', PercentComplete: 0, Message: 'Task successfully scheduled.' });
        return json(res, 200, {}, { location: `${MGR}/Jobs/${id}` });
      }
      if (m === 'GET' && path === `${MGR}/Jobs`) return json(res, 200, { Members: state.jobs.map((j) => ({ '@odata.id': `${MGR}/Jobs/${j.Id}` })) });
      const job = /\/Jobs\/(JID_\d+)$/.exec(path);
      if (job && m === 'GET') return json(res, 200, state.jobs.find((j) => j.Id === job[1]) ?? {});
      if (job && m === 'DELETE') {
        state.jobs = state.jobs.filter((j) => j.Id !== job[1]);
        return json(res, 200, {});
      }
      if (m === 'GET' && path === `${CH}/Thermal`)
        return json(res, 200, {
          Temperatures: [
            { Name: 'System Board Inlet Temp', ReadingCelsius: 22, UpperThresholdCritical: 42, Status: { Health: 'OK', State: 'Enabled' } },
            { Name: 'CPU1 Temp', ReadingCelsius: 41, UpperThresholdCritical: 95, Status: { Health: 'OK', State: 'Enabled' } },
          ],
          Fans: [{ FanName: 'System Board Fan1', Reading: 4920, ReadingUnits: 'RPM', Status: { Health: 'OK', State: 'Enabled' } }],
        });
      if (m === 'GET' && path === `${CH}/Power`) return json(res, 200, { PowerControl: [{ Name: 'System Power Control', PowerConsumedWatts: 58, PowerCapacityWatts: 350 }], PowerSupplies: [{ Name: 'PS1 Status', Status: { State: 'Absent' } }], Voltages: [] });
      if (m === 'GET' && path === `${MGR}/LogServices`) return json(res, 200, { Members: [{ '@odata.id': `${MGR}/LogServices/Lclog` }, { '@odata.id': `${MGR}/LogServices/Sel` }] });
      if (m === 'GET' && path === `${MGR}/LogServices/Sel/Entries`)
        return json(res, 200, {
          Members: [
            { Id: '1', Created: '2026-10-01T10:00:00-05:00', Severity: 'OK', Message: 'Log cleared.' },
            { Id: '2', Created: '2026-10-05T08:00:00-05:00', Severity: 'Warning', Message: 'The system inlet temperature is greater than the upper warning threshold.' },
          ],
        });
      return json(res, 404, { error: { message: `No ${m} ${path}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `https://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    fingerprint: cert.fingerprint,
    state,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

import type { Agent } from 'node:https';
import type { BiosAttribute, BiosSettings, BmcLogEntry, BmcSensor, BmcSystem } from '@fbrx/shared';
import { pinnedAgent, pinnedFetch } from '@fbrx/shared/node';
import { badRequest, VirtualError } from '../errors';

/**
 * A server's management controller over Redfish (the DMTF standard that iDRAC, iLO, XClarity and most others speak):
 * the system, its sensors and power, BIOS settings and the event log. Written against Dell's iDRAC 8 / 9 first (they
 * stage BIOS changes as a job that runs at the next restart) with the plain Redfish ways as the fallback.
 */

export interface RedfishTarget {
  host: string;
  username: string;
  password: string;
  /** SHA-256 fingerprint of the controller's certificate (they come with self-signed ones). */
  fingerprint: string | null;
}

type Json = Record<string, any>;

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;

export function checkHost(host: string): string {
  const h = host
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!HOST_RE.test(h)) throw badRequest('Give the controller as a name or address, like 192.168.1.20 or idrac.example.lan');
  return h;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** What kind of controller this is, from the service root and manager. */
export function controllerKind(root: Json, manager: Json | null): string {
  const vendor = String(root.Vendor ?? Object.keys(root.Oem ?? {})[0] ?? '').toLowerCase();
  const model = String(manager?.Model ?? '');
  if (vendor.includes('dell') || /idrac/i.test(String(manager?.Id ?? ''))) {
    const gen = /^(\d+)G/.exec(model)?.[1];
    const n = gen ? Number(gen) : null;
    return n === 12 || n === 13 ? 'iDRAC 8' : n !== null && n >= 14 ? 'iDRAC 9' : 'iDRAC';
  }
  if (vendor.includes('hpe') || vendor.includes('hp')) return 'iLO';
  if (vendor.includes('lenovo')) return 'XClarity Controller';
  if (vendor.includes('supermicro')) return 'Supermicro BMC';
  return 'Redfish';
}

export class Redfish {
  readonly base: string;
  private readonly agent: Agent | null;
  private cache = new Map<string, string>();

  constructor(
    private readonly t: RedfishTarget,
    private readonly fetcher: typeof fetch | null = null,
  ) {
    this.base = `https://${checkHost(t.host)}`;
    this.agent = t.fingerprint ? pinnedAgent(t.fingerprint, 'The management controller presented a different certificate than the one you trusted. Check it and trust it again (Server → Connect).') : null;
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; headers: Headers }> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.t.username}:${this.t.password}`).toString('base64')}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    };
    let res: Response;
    try {
      res = this.fetcher ? await this.fetcher(url, init) : this.agent ? await pinnedFetch(url, init, this.agent) : await fetch(url, init);
    } catch (e) {
      const msg = (e as Error).message;
      if ((e as { code?: string }).code === 'FORBIDDEN') throw new VirtualError(502, msg);
      throw new VirtualError(502, `Cannot reach the management controller at ${this.t.host}: ${(e as { cause?: Error }).cause?.message ?? msg}`);
    }
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (res.status === 401) throw new VirtualError(502, 'The management controller turned down the username or password');
    if (res.status >= 400) {
      const ext = json?.error?.['@Message.ExtendedInfo']?.[0]?.Message ?? json?.error?.message ?? `HTTP ${res.status}`;
      throw new VirtualError(res.status === 404 ? 404 : 502, `The management controller said: ${ext}`);
    }
    return { status: res.status, json, headers: res.headers };
  }

  get(path: string) {
    return this.request('GET', path).then((r) => r.json);
  }

  private async member(collection: string, key: string): Promise<string> {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const c = await this.get(collection);
    const id = c.Members?.[0]?.['@odata.id'];
    if (!id) throw new VirtualError(502, `The management controller lists no ${key}`);
    this.cache.set(key, id);
    return id;
  }

  systemPath() {
    return this.member('/redfish/v1/Systems', 'system');
  }
  managerPath() {
    return this.member('/redfish/v1/Managers', 'manager');
  }
  chassisPath() {
    return this.member('/redfish/v1/Chassis', 'chassis');
  }

  async root(): Promise<Json> {
    return this.get('/redfish/v1');
  }

  async kind(): Promise<string> {
    const [root, manager] = await Promise.all([this.root(), this.managerPath().then((p) => this.get(p), () => null)]);
    return controllerKind(root, manager);
  }

  async system(): Promise<BmcSystem> {
    const s = await this.get(await this.systemPath());
    const m = await this.managerPath()
      .then((p) => this.get(p))
      .catch(() => null);
    const root = await this.root().catch(() => ({}));
    const ps = s.ProcessorSummary ?? {};
    return {
      manufacturer: str(s.Manufacturer),
      model: str(s.Model),
      serial: str(s.SerialNumber),
      serviceTag: str(s.SKU) ?? str(s.Oem?.Dell?.DellSystem?.ChassisServiceTag),
      biosVersion: str(s.BiosVersion),
      powerState: str(s.PowerState),
      health: str(s.Status?.HealthRollup) ?? str(s.Status?.Health),
      hostName: str(s.HostName),
      processors: ps.Count ? `${ps.Count} × ${str(ps.Model) ?? 'processor'}` : str(ps.Model),
      memoryGb: num(s.MemorySummary?.TotalSystemMemoryGiB),
      controller: m ? { name: controllerKind(root, m), firmware: str(m.FirmwareVersion) } : null,
      resetTypes: s.Actions?.['#ComputerSystem.Reset']?.['ResetType@Redfish.AllowableValues'] ?? ['On', 'ForceOff', 'GracefulShutdown', 'GracefulRestart', 'ForceRestart'],
    };
  }

  async sensors(): Promise<BmcSensor[]> {
    const chassis = await this.chassisPath();
    const out: BmcSensor[] = [];
    const thermal = await this.get(`${chassis}/Thermal`).catch(() => null);
    for (const t of thermal?.Temperatures ?? []) {
      if (t.Status?.State === 'Absent') continue;
      out.push({ kind: 'temperature', name: str(t.Name) ?? 'Temperature', reading: num(t.ReadingCelsius), unit: '°C', health: str(t.Status?.Health), upperCritical: num(t.UpperThresholdCritical) });
    }
    for (const f of thermal?.Fans ?? []) {
      if (f.Status?.State === 'Absent') continue;
      out.push({ kind: 'fan', name: str(f.Name) ?? str(f.FanName) ?? 'Fan', reading: num(f.Reading), unit: str(f.ReadingUnits) === 'Percent' ? '%' : 'RPM', health: str(f.Status?.Health), upperCritical: null });
    }
    const power = await this.get(`${chassis}/Power`).catch(() => null);
    for (const p of power?.PowerControl ?? []) {
      out.push({ kind: 'power', name: str(p.Name) ?? 'Power use', reading: num(p.PowerConsumedWatts), unit: 'W', health: str(p.Status?.Health), upperCritical: num(p.PowerCapacityWatts) });
    }
    for (const p of power?.PowerSupplies ?? []) {
      if (p.Status?.State === 'Absent') continue;
      out.push({ kind: 'power', name: str(p.Name) ?? 'Power supply', reading: num(p.LastPowerOutputWatts) ?? num(p.PowerOutputWatts), unit: 'W', health: str(p.Status?.Health), upperCritical: num(p.PowerCapacityWatts) });
    }
    for (const v of power?.Voltages ?? []) {
      if (v.Status?.State === 'Absent') continue;
      out.push({ kind: 'voltage', name: str(v.Name) ?? 'Voltage', reading: num(v.ReadingVolts), unit: 'V', health: str(v.Status?.Health), upperCritical: num(v.UpperThresholdCritical) });
    }
    return out;
  }

  async reset(resetType: string): Promise<void> {
    const sys = await this.systemPath();
    await this.request('POST', `${sys}/Actions/ComputerSystem.Reset`, { ResetType: resetType });
  }

  /** Boots into BIOS setup once (shown on the server's screen, or through the controller's virtual console). */
  async bootToSetup(restart: boolean): Promise<void> {
    const sys = await this.systemPath();
    await this.request('PATCH', sys, { Boot: { BootSourceOverrideTarget: 'BiosSetup', BootSourceOverrideEnabled: 'Once' } });
    if (restart) {
      const s = await this.get(sys);
      await this.reset(String(s.PowerState).toLowerCase() === 'off' ? 'On' : 'GracefulRestart');
    }
  }

  // ------------------------------------------------------------------------------------- BIOS

  private async registry(bios: Json): Promise<Json | null> {
    const biosPath = String(bios['@odata.id'] ?? '');
    // Dell publishes it next to the settings; others through the registries collection.
    if (biosPath) {
      const direct = await this.get(`${biosPath}/BiosRegistry`).catch(() => null);
      if (direct?.RegistryEntries) return direct;
    }
    const name = str(bios.AttributeRegistry);
    if (!name) return null;
    const regs = await this.get('/redfish/v1/Registries').catch(() => null);
    for (const m of regs?.Members ?? []) {
      const id = String(m['@odata.id'] ?? '');
      if (!id.split('/').pop()?.startsWith(name.split('.')[0]!)) continue;
      const file = await this.get(id).catch(() => null);
      const uri = file?.Location?.find((l: Json) => !l.Language || l.Language === 'en')?.Uri ?? file?.Location?.[0]?.Uri;
      if (uri) return this.get(uri).catch(() => null);
    }
    return null;
  }

  async bios(): Promise<BiosSettings> {
    const sys = await this.systemPath();
    const bios = await this.get(`${sys}/Bios`);
    const settingsPath = bios['@Redfish.Settings']?.SettingsObject?.['@odata.id'] ?? `${sys}/Bios/Settings`;
    const pending: Json = (await this.get(settingsPath).catch((): Json => ({})))?.Attributes ?? {};
    const current: Json = bios.Attributes ?? {};
    const reg = await this.registry(bios);
    const menus = new Map<string, string>();
    for (const m of reg?.RegistryEntries?.Menus ?? []) menus.set(String(m.MenuPath ?? ''), String(m.DisplayName ?? m.MenuName ?? ''));
    const regAttrs = new Map<string, Json>();
    for (const a of reg?.RegistryEntries?.Attributes ?? []) regAttrs.set(String(a.AttributeName), a);
    const typeOf = (r: Json | undefined, v: unknown): BiosAttribute['type'] => {
      const t = String(r?.Type ?? '').toLowerCase();
      if (t === 'enumeration') return 'enum';
      if (t === 'string' || t === 'integer' || t === 'boolean' || t === 'password') return t;
      return typeof v === 'number' ? 'integer' : typeof v === 'boolean' ? 'boolean' : typeof v === 'string' ? 'string' : 'unknown';
    };
    const attributes: BiosAttribute[] = Object.entries(current)
      .filter(([name]) => !regAttrs.get(name)?.Hidden)
      .map(([name, value]) => {
        const r = regAttrs.get(name);
        const menuPath = String(r?.MenuPath ?? '');
        const group = menus.get(menuPath) ?? (menuPath.replace(/^\.\//, '').split('/')[0]?.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Settings');
        return {
          name,
          displayName: str(r?.DisplayName) ?? name.replace(/([a-z])([A-Z])/g, '$1 $2'),
          value: value as BiosAttribute['value'],
          pending: name in pending && pending[name] !== value ? (pending[name] as BiosAttribute['pending']) : null,
          type: typeOf(r, value),
          options: (r?.Value ?? []).map((o: Json) => ({ value: String(o.ValueName), label: String(o.ValueDisplayName ?? o.ValueName) })),
          readOnly: !!r?.ReadOnly || !!r?.GrayOut,
          group,
          help: str(r?.HelpText),
          min: num(r?.LowerBound),
          max: num(r?.UpperBound),
        };
      });
    const jobs = await this.jobs().catch(() => []);
    return { attributes, pendingCount: attributes.filter((a) => a.pending !== null).length, jobs };
  }

  /**
   * Stages BIOS changes. They take effect at the next restart: Dell controllers need a configuration job for that
   * (made here); the standard way asks for "OnReset". Restarting now is up to the caller.
   */
  async setBios(changes: Record<string, string | number | boolean>, current?: BiosSettings): Promise<{ jobId: string | null }> {
    const known = current ?? (await this.bios());
    for (const [name, value] of Object.entries(changes)) {
      const a = known.attributes.find((x) => x.name === name);
      if (!a) throw badRequest(`The BIOS has no setting called ${name}`);
      if (a.readOnly) throw badRequest(`${a.displayName} cannot be changed right now`);
      if (a.type === 'enum' && a.options.length && !a.options.some((o) => o.value === value)) throw badRequest(`${a.displayName} can be ${a.options.map((o) => o.label).join(', ')}`);
      if (a.type === 'integer' && (typeof value !== 'number' || (a.min !== null && value < a.min) || (a.max !== null && value > a.max))) throw badRequest(`${a.displayName} must be a number${a.min !== null ? ` from ${a.min}` : ''}${a.max !== null ? ` to ${a.max}` : ''}`);
    }
    const sys = await this.systemPath();
    const settingsPath = `${sys}/Bios/Settings`;
    const dell = /idrac/i.test(await this.kind());
    await this.request('PATCH', settingsPath, dell ? { Attributes: changes } : { Attributes: changes, '@Redfish.SettingsApplyTime': { ApplyTime: 'OnReset' } });
    if (!dell) return { jobId: null };
    const manager = await this.managerPath();
    try {
      const r = await this.request('POST', `${manager}/Jobs`, { TargetSettingsURI: settingsPath });
      const loc = r.headers.get('location') ?? '';
      return { jobId: loc.split('/').pop() || null };
    } catch (e) {
      // A BIOS job may already be waiting for the restart: it picks up these changes too.
      if (/already|pending|exists/i.test((e as Error).message)) return { jobId: null };
      throw e;
    }
  }

  /** Throws away staged BIOS changes (and Dell's waiting BIOS job). */
  async clearPending(): Promise<void> {
    const sys = await this.systemPath();
    const manager = await this.managerPath().catch(() => null);
    if (manager) {
      for (const j of await this.jobs().catch(() => [])) {
        if (/bios/i.test(j.name) && /scheduled|new|pending/i.test(j.state)) await this.request('DELETE', `${manager}/Jobs/${j.id}`).catch(() => undefined);
      }
    }
    await this.request('POST', `${sys}/Bios/Settings/Actions/Oem/DellManager.ClearPending`, {}).catch(async () => {
      await this.request('DELETE', `${sys}/Bios/Settings`).catch(() => undefined);
    });
  }

  async jobs(): Promise<BiosSettings['jobs']> {
    const manager = await this.managerPath();
    const coll = await this.get(`${manager}/Jobs`);
    const members: Json[] = coll.Members ?? [];
    const recent = members.slice(-10);
    const jobs = await Promise.all(recent.map((m) => (m.JobState ? Promise.resolve(m) : this.get(String(m['@odata.id'])).catch(() => null))));
    return jobs
      .filter((j): j is Json => !!j)
      .map((j) => ({ id: String(j.Id), name: String(j.Name ?? j.JobType ?? 'Job'), state: String(j.JobState ?? j.TaskState ?? 'Unknown'), percent: num(j.PercentComplete), message: str(j.Message) }))
      .reverse();
  }

  async logs(limit = 100): Promise<BmcLogEntry[]> {
    const candidates = [await this.managerPath().catch(() => null), await this.systemPath().catch(() => null)].filter((x): x is string => !!x);
    for (const owner of candidates) {
      const services = await this.get(`${owner}/LogServices`).catch(() => null);
      const sel = (services?.Members ?? []).map((m: Json) => String(m['@odata.id'])).find((id: string) => /\/(sel|log1|eventlog)$/i.test(id));
      if (!sel) continue;
      const entries = await this.get(`${sel}/Entries`).catch(() => null);
      if (!entries) continue;
      return (entries.Members ?? [])
        .map((e: Json) => ({ id: String(e.Id ?? ''), at: str(e.Created), severity: str(e.Severity), message: str(e.Message) ?? '' }))
        .sort((a: BmcLogEntry, b: BmcLogEntry) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
        .slice(0, limit);
    }
    return [];
  }
}

import type { NetEnvClient, NetEnvDevice, NetEnvOverview } from '@fbrx/shared';
import { CoreError } from '../../errors';
import type { NetEnvironments } from '../../network/environments';
import type { ToolSpec } from '../types';

/**
 * The agent's view of attached network environments (Network Center → Environments, Endpoint Ultra): what is on the
 * network, what is offline, who is connected where. Restarting a device and making guest Wi-Fi codes change the
 * network, so they wait for the person's approval like any other change. The API key is never visible to the agent.
 */
export function netEnvTools(envs: NetEnvironments, unavailable: () => string | null): ToolSpec[] {
  const tool = (t: Omit<ToolSpec, 'source' | 'sourceId' | 'unavailable'>): ToolSpec => ({ source: 'builtin', sourceId: null, unavailable, ...t });
  const pick = (id?: string) => {
    const list = envs.list();
    if (!list.length) throw new CoreError('NOT_FOUND', 'No network environment is attached. The person can attach one in Network Center → Environments.');
    const env = id ? list.find((e) => e.id === id || e.name.toLowerCase() === id.toLowerCase()) : list[0];
    if (!env) throw new CoreError('NOT_FOUND', `No network environment "${id}". Attached: ${list.map((e) => `${e.name} (${e.id})`).join(', ')}`);
    return env;
  };
  const deviceLine = (d: NetEnvDevice, clients: number | null) =>
    `- ${d.name} [${d.id}] ${d.model}${d.roles.length ? ` (${d.roles.join(', ')})` : ''} — ${d.state}${d.ip ? `, ${d.ip}` : ''}${d.firmware ? `, firmware ${d.firmware}` : ''}${d.firmwareUpdatable ? ' (update available)' : ''}${clients !== null ? `, ${clients} clients` : ''}`;
  const perDevice = (o: NetEnvOverview) => {
    const m = new Map<string, number>();
    for (const c of o.clients) if (c.uplinkDeviceId) m.set(c.uplinkDeviceId, (m.get(c.uplinkDeviceId) ?? 0) + 1);
    return m;
  };
  const envProp = { environment: { type: 'string', description: 'Environment id or name (default: the first one attached)' }, site: { type: 'string', description: 'Site id (default: the environment’s default site)' } };

  return [
    tool({
      name: 'network_env.overview',
      title: 'Network overview',
      description:
        'A summary of an attached network (a UniFi console): sites, gateways, switches and access points with their state, which are offline, devices with firmware updates, and how many clients are connected by type. Use it for questions about the school or office network as a whole.',
      risk: 'read',
      inputSchema: { type: 'object', properties: envProp },
      async run(i) {
        const env = pick(i.environment);
        const o = await envs.overview(env.id, i.site);
        const by = perDevice(o);
        const offline = o.devices.filter((d) => d.state === 'offline');
        const updates = o.devices.filter((d) => d.firmwareUpdatable);
        const types = { wired: 0, wireless: 0, vpn: 0, other: 0 } as Record<NetEnvClient['type'], number>;
        for (const c of o.clients) types[c.type]++;
        const lines = [
          `${env.name} — site ${o.site.name}${o.sites.length > 1 ? ` (sites: ${o.sites.map((s) => `${s.name} [${s.id}]`).join(', ')})` : ''}`,
          `Devices: ${o.devices.length} (${o.devices.filter((d) => d.state === 'online').length} online, ${offline.length} offline${updates.length ? `, ${updates.length} with firmware updates` : ''})`,
          `Clients: ${o.clients.length} (${types.wireless} wireless, ${types.wired} wired${types.vpn ? `, ${types.vpn} VPN` : ''})`,
          ...(offline.length ? ['Offline:', ...offline.map((d) => deviceLine(d, null))] : []),
          'All devices:',
          ...o.devices.map((d) => deviceLine(d, by.get(d.id) ?? 0)),
        ];
        return { output: lines.join('\n'), data: { site: o.site, devices: o.devices.length, clients: o.clients.length, offline: offline.map((d) => d.name) } };
      },
    }),
    tool({
      name: 'network_env.clients',
      title: 'Find network clients',
      description: 'Computers, phones and other clients connected to an attached network, with IP, MAC, connection type and the access point or switch they are on. Optionally filter by part of a name, IP or MAC.',
      risk: 'read',
      inputSchema: { type: 'object', properties: { ...envProp, search: { type: 'string', description: 'Part of a name, IP address or MAC address' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
      async run(i) {
        const env = pick(i.environment);
        const o = await envs.overview(env.id, i.site);
        const q = String(i.search ?? '').toLowerCase();
        const names = new Map(o.devices.map((d) => [d.id, d.name]));
        const hits = o.clients.filter((c) => !q || [c.name, c.ip, c.mac].some((x) => x?.toLowerCase().includes(q)));
        const shown = hits.slice(0, i.limit ?? 50);
        return {
          output: hits.length
            ? [`${hits.length} client(s)${q ? ` matching "${i.search}"` : ''}${hits.length > shown.length ? `, first ${shown.length}` : ''}:`, ...shown.map((c) => `- ${c.name} — ${c.type}${c.ip ? `, ${c.ip}` : ''}${c.mac ? `, ${c.mac}` : ''}${c.uplinkDeviceId ? `, on ${names.get(c.uplinkDeviceId) ?? c.uplinkDeviceId}` : ''}${c.connectedAt ? `, since ${c.connectedAt}` : ''}`)].join('\n')
            : `No clients${q ? ` matching "${i.search}"` : ''}.`,
          data: shown,
        };
      },
    }),
    tool({
      name: 'network_env.device_stats',
      title: 'Network device health',
      description: 'Live health of one gateway, switch or access point: uptime, CPU, memory, load and uplink traffic.',
      risk: 'read',
      inputSchema: { type: 'object', required: ['device'], properties: { ...envProp, device: { type: 'string', description: 'Device id from network_env.overview' } } },
      async run(i) {
        const env = pick(i.environment);
        const s = await envs.deviceStats(env.id, i.device, i.site);
        const pct = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n)}%`);
        const rate = (n: number | null) => (n === null ? 'n/a' : `${(n / 1e6).toFixed(1)} Mbps`);
        const up = s.uptimeSec === null ? 'n/a' : `${Math.floor(s.uptimeSec / 86400)}d ${Math.floor((s.uptimeSec % 86400) / 3600)}h`;
        return { output: `${s.device?.name ?? i.device}: up ${up}, CPU ${pct(s.cpuPct)}, memory ${pct(s.memPct)}, load ${s.load1 ?? 'n/a'}, uplink ↑${rate(s.txBps)} ↓${rate(s.rxBps)}${s.lastHeartbeatAt ? `, last heard ${s.lastHeartbeatAt}` : ''}`, data: s };
      },
    }),
    tool({
      name: 'network_env.restart_device',
      title: 'Restart a network device',
      description: 'Restarts a gateway, switch or access point on an attached network. Everyone connected through it drops for a minute or two, so say so when you ask.',
      risk: 'execute',
      inputSchema: { type: 'object', required: ['device'], properties: { ...envProp, device: { type: 'string', description: 'Device id from network_env.overview' } } },
      async run(i) {
        const env = pick(i.environment);
        await envs.deviceAction(env.id, i.device, 'restart', i.site);
        return { output: `Restart sent to ${i.device} on ${env.name}. It is usually back within two minutes.` };
      },
    }),
    tool({
      name: 'network_env.guest_codes',
      title: 'Make guest Wi-Fi codes',
      description: 'Creates guest Wi-Fi voucher codes on an attached UniFi network (the guest hotspot must use vouchers). Good for visitors, substitutes and events.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        required: ['minutes'],
        properties: {
          ...envProp,
          minutes: { type: 'integer', minimum: 10, maximum: 525600, description: 'How long each code works once used' },
          count: { type: 'integer', minimum: 1, maximum: 50, default: 1 },
          note: { type: 'string', description: 'A label, such as "Parent night"' },
        },
      },
      async run(i) {
        const env = pick(i.environment);
        const made = await envs.createVouchers(env.id, { name: i.note ?? 'FBRX guest', count: i.count ?? 1, timeLimitMinutes: i.minutes, siteId: i.site });
        return { output: made.length ? `Guest codes (${i.minutes} minutes each):\n${made.map((v) => `- ${v.code}`).join('\n')}` : 'The console made the codes but did not return them; see UniFi → Hotspot.', data: made };
      },
    }),
  ];
}

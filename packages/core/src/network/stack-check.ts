import { cleanName, quoteName, type PingResult, type StackLayer, type StackReport, type StackStep } from '@fbrx/shared';

/**
 * The full network check ("why is my network not working?"): every layer from the cable or radio up to the site the
 * person wants, in order, each with what it found, the commands that show the same by hand, what to do first and the
 * tools that look further. It stops calling a layer broken at the first one that fails: everything above it is
 * "skipped", since a layer that fails takes the ones above it down too.
 *
 * NetDiag.stackFacts gathers the facts; stackReport reads them, without touching the network, so the tests can give it
 * any situation.
 */

export interface StackFacts {
  os: 'windows' | 'mac' | 'linux';
  interfaces: Array<{ name: string; type: string; up: boolean; ip4: string | null; ip6: string | null; mac: string; speedMbps: number | null; virtual: boolean; dhcp: boolean | null }>;
  wifi: { ssid: string; signalPct: number | null; signalDbm: number | null; band: string } | null;
  gateway: string | null;
  /** null: not tried. */
  gatewayPing: PingResult | null;
  /** The router's hardware address from the ARP table, after the ping: it answers on the local network. */
  gatewayMac: string | null;
  /** Whether the internet may be reached: false in an offline chat or under a policy. */
  internetAllowed: boolean;
  internetPing: PingResult | null;
  dnsServers: string[];
  dnsSystem: { ok: boolean; ms: number | null } | null;
  dnsDirect: { ok: boolean; ms: number | null } | null;
  tcp443: { byIp: boolean | null; byName: boolean | null };
  proxy: string | null;
  /** A VPN adapter that is up. */
  vpn: string | null;
  web: { portal: boolean; status: number | null; error: string | null; clockSkewMin: number | null } | null;
  target: { name: string; resolved: boolean; port443: boolean | null; status: number | null; error: string | null } | null;
}

const TITLES: Record<StackLayer, string> = {
  physical: 'Physical: the adapter, cable or Wi-Fi signal',
  link: 'Link: joined to the network, the router within reach',
  ip: 'Address: this computer’s IP address and router',
  routing: 'Routing: the router, then the internet past it',
  dns: 'Names (DNS): turning names into addresses',
  transport: 'Connections: secure web traffic (port 443), proxy and VPN',
  application: 'Websites: a real page, sign-in pages and the clock',
};

/** Each layer as a sentence names it. */
const NAMES: Record<StackLayer, string> = { physical: 'the adapter', link: 'the link to the router', ip: 'the address', routing: 'routing', dns: 'names (DNS)', transport: 'connections', application: 'websites' };

const PROBE = 'example.com';
const PUBLIC_IP = '1.1.1.1';

/** The commands that show each layer by hand. */
function commands(layer: StackLayer, f: StackFacts): StackStep['commands'] {
  const gw = f.gateway ?? '<router>';
  const site = f.target?.name ?? PROBE;
  switch (layer) {
    case 'physical':
      return {
        windows: ['Get-NetAdapter | Format-Table Name, Status, LinkSpeed, MediaType', 'netsh wlan show interfaces'],
        mac: ['networksetup -listallhardwareports', 'system_profiler SPAirPortDataType'],
        linux: ['ip link', 'nmcli device status', 'iw dev'],
      };
    case 'link':
      return { windows: [`ping -n 2 ${gw}`, 'arp -a'], mac: [`ping -c 2 ${gw}`, 'arp -a'], linux: [`ping -c 2 ${gw}`, 'ip neigh'] };
    case 'ip':
      return { windows: ['ipconfig /all'], mac: ['ifconfig', 'ipconfig getpacket en0'], linux: ['ip addr', 'ip route show default'] };
    case 'routing':
      return {
        windows: [`ping -n 4 ${gw}`, `ping -n 4 ${PUBLIC_IP}`, `tracert -d ${PUBLIC_IP}`, 'route print -4'],
        mac: [`ping -c 4 ${gw}`, `ping -c 4 ${PUBLIC_IP}`, `traceroute -n ${PUBLIC_IP}`, 'netstat -rn'],
        linux: [`ping -c 4 ${gw}`, `ping -c 4 ${PUBLIC_IP}`, `tracepath -n ${PUBLIC_IP}`, 'ip route'],
      };
    case 'dns':
      return {
        windows: [`Resolve-DnsName ${site}`, `Resolve-DnsName ${site} -Server ${PUBLIC_IP}`, 'Get-DnsClientServerAddress -AddressFamily IPv4'],
        mac: [`dig ${site}`, `dig @${PUBLIC_IP} ${site}`, 'scutil --dns'],
        linux: [`resolvectl query ${site}`, `dig @${PUBLIC_IP} ${site}`, 'resolvectl status'],
      };
    case 'transport':
      return {
        windows: [`Test-NetConnection ${site} -Port 443`, 'netsh winhttp show proxy'],
        mac: [`nc -vz ${site} 443`, 'scutil --proxy'],
        linux: [`nc -vz ${site} 443`, 'env | grep -i proxy'],
      };
    case 'application':
      return {
        windows: [`curl.exe -I https://${site}`, 'w32tm /query /status'],
        mac: [`curl -I https://${site}`, 'date'],
        linux: [`curl -I https://${site}`, 'timedatectl'],
      };
  }
}

const ms = (p: PingResult | null) => (p?.avg != null ? `${p.avg} ms` : 'no reply');
const signalWord = (dbm: number) => (dbm >= -60 ? 'strong' : dbm >= -67 ? 'good' : dbm >= -75 ? 'fair' : 'weak');

/**
 * The full check, read from the facts. `has` says which tools this FBRX has, so a next step names only real ones.
 */
export function stackReport(f: StackFacts, has: (tool: string) => boolean, at = new Date()): StackReport {
  const steps: StackStep[] = [];
  let broken: StackLayer | null = null;
  /** `headline`: the line of `found` that says it in one; the first when not given. */
  const step = (layer: StackLayer, s: Omit<StackStep, 'layer' | 'title' | 'commands' | 'next' | 'headline'> & { next?: StackStep['next']; headline?: string }) => {
    const status = broken ? 'skipped' : s.status;
    const found = broken ? [`Skipped: ${NAMES[broken]} fails first, and that takes this layer down too.`] : s.found;
    const headline = broken ? found[0]! : (s.headline ?? found[0] ?? '');
    steps.push({ layer, title: TITLES[layer], status, headline, found, commands: commands(layer, f), fix: broken ? [] : s.fix, next: broken ? [] : (s.next ?? []).filter((n) => has(n.tool)) });
    if (!broken && status === 'fail') broken = layer;
  };
  const real = f.interfaces.filter((i) => !i.virtual);
  const up = real.filter((i) => i.up);
  const primary = up.find((i) => i.ip4 && !i.ip4.startsWith('169.254.')) ?? up.find((i) => i.ip4) ?? up[0] ?? null;
  const wireless = (i: { type: string; name: string }) => /wireless|wi-?fi|wlan|802\.11|airport/i.test(`${i.type} ${i.name}`);

  // 1. Physical.
  if (!up.length) {
    step('physical', {
      status: 'fail',
      found: ['No network adapter is connected: Wi-Fi is off or not joined, airplane mode is on, or the cable is unplugged.'],
      fix: ['Turn Wi-Fi on (or airplane mode off) and join your network, or plug the cable in firmly at both ends.', 'If an adapter is missing altogether, restart the computer; its driver may need an update.'],
      next: [{ tool: 'kit.network_adapters', why: 'every adapter and whether it is connected' }],
    });
  } else {
    const found: string[] = [];
    const fix: string[] = [];
    const next: StackStep['next'] = [];
    let status: StackStep['status'] = 'ok';
    if (f.wifi && primary && wireless(primary)) {
      const dbm = f.wifi.signalDbm;
      const pct = f.wifi.signalPct;
      found.push(`Wi-Fi: joined ${quoteName(f.wifi.ssid)}${f.wifi.band ? ` (${f.wifi.band})` : ''}${dbm != null ? `, signal ${dbm} dBm (${signalWord(dbm)})` : pct != null ? `, signal ${pct}%` : ''}. The name in quotes is as the network reports it.`);
      if ((dbm != null && dbm < -75) || (dbm == null && pct != null && pct < 35)) {
        status = 'warn';
        found.push('The signal is weak: too far from the router, or walls and appliances in the way. Drops and slow pages follow.');
        fix.push('Move closer to the router, or add an access point or mesh node near this room.');
        next.push({ tool: 'net.wifi_channels', why: 'the signal, the channel and how crowded each channel is' });
      }
    }
    for (const i of up.filter((x) => !wireless(x))) {
      found.push(`${cleanName(i.name)}: connected${i.speedMbps ? ` at ${i.speedMbps >= 1000 ? `${i.speedMbps / 1000} Gbps` : `${i.speedMbps} Mbps`}` : ''}.`);
      if (i.speedMbps != null && i.speedMbps > 0 && i.speedMbps <= 100) {
        status = 'warn';
        found.push(`${cleanName(i.name)} runs at ${i.speedMbps} Mbps: a damaged cable, a loose plug or an old port often does that.`);
        fix.push('Try another cable and another port on the router or switch.');
      }
    }
    if (!found.length) found.push(`${primary ? cleanName(primary.name) : 'An adapter'} is connected.`);
    step('physical', { status, found, fix, next, headline: status === 'warn' ? found.find((x) => /weak|runs at/.test(x)) : undefined });
  }

  // 2. Link: the router within reach on the local network.
  if (!f.gateway) {
    step('link', { status: 'ok', found: [`Joined the network on ${primary ? cleanName(primary.name) : 'an adapter'}; there is no router address to check yet (the address step says why).`], fix: [] });
  } else if (f.gatewayMac || (f.gatewayPing?.received ?? 0) > 0) {
    step('link', { status: 'ok', found: [`The router (${f.gateway}) answers on the local network${f.gatewayMac ? ` (its hardware address ${f.gatewayMac})` : ''}.`], fix: [] });
  } else {
    step('link', {
      status: 'fail',
      found: [`The router (${f.gateway}) does not answer on the local network: no reply and no hardware address.`],
      fix: ['Restart the router: unplug it for 30 seconds.', 'On Wi-Fi, forget the network and join it again; on a cable, try another cable or port.'],
      next: [
        { tool: 'net.scan_lan', why: 'what else answers on the network (a second router, an address clash)' },
        { tool: 'net.wifi_channels', why: 'whether this is the Wi-Fi network you meant to join' },
      ],
    });
  }

  // 3. Address.
  const ip4 = primary?.ip4 ?? null;
  if (!ip4) {
    step('ip', {
      status: 'fail',
      found: ['This computer has no IPv4 address: the router gave it none (DHCP).'],
      fix: ['Get a fresh address from the router (it asks first).', 'Restart the router if it keeps happening.'],
      next: [{ tool: 'kit.get_a_fresh_address', why: 'asks the router for a new address' }, { tool: 'kit.network_details', why: 'every adapter, address, router and DNS server' }],
    });
  } else if (ip4.startsWith('169.254.')) {
    step('ip', {
      status: 'fail',
      found: [`The address is ${ip4}: this computer asked the router for an address and nothing answered (DHCP failed).`],
      fix: ['Get a fresh address from the router (it asks first).', 'Restart the router; if other devices also fail, the router’s DHCP is off or full.'],
      next: [{ tool: 'kit.get_a_fresh_address', why: 'asks the router for a new address' }, { tool: 'kit.network_details', why: 'every adapter, address, router and DNS server' }],
    });
  } else if (!f.gateway) {
    step('ip', {
      status: 'fail',
      found: [`The address is ${ip4}, but there is no router: nothing leads off this network. A fixed address set without a router does this.`],
      fix: ['Switch the adapter back to an automatic address (it asks first), or add the router to the fixed settings.'],
      next: [{ tool: 'kit.use_an_automatic_address', why: 'back to an address from the router' }, { tool: 'kit.network_details', why: 'the settings as they are' }],
    });
  } else {
    step('ip', { status: 'ok', found: [`Address ${ip4}${primary?.dhcp === false ? ' (set by hand)' : primary?.dhcp ? ' (from the router)' : ''}, router ${f.gateway}.`], fix: [] });
  }

  // 4. Routing: the router, then past it.
  {
    const found: string[] = [];
    const fix: string[] = [];
    const next: StackStep['next'] = [];
    let status: StackStep['status'] = 'ok';
    const g = f.gatewayPing;
    if (g) {
      if (!g.received) found.push(`The router does not answer pings, though it is on the network (many routers ignore them).`);
      else {
        found.push(`The router answers in ${ms(g)}${g.lossPct ? `, ${g.lossPct}% lost` : ''}.`);
        const slow = g.avg != null && g.avg > (primary && wireless(primary) ? 60 : 20);
        if (g.lossPct > 0 || slow) {
          status = 'warn';
          found.push(g.lossPct > 0 ? 'Pings to the router get lost: Wi-Fi interference, a weak signal or a bad cable.' : 'The router is slow to answer for a local hop: a busy Wi-Fi channel or an overloaded router.');
          next.push({ tool: 'net.wifi_channels', why: 'how busy the channel is' });
        }
      }
    }
    if (f.vpn) found.push(`A VPN is on (${f.vpn}): when it is down or slow, so is everything it carries.`);
    if (!f.internetAllowed) {
      found.push('The internet was not checked: this chat is offline (or a policy keeps FBRX off the internet).');
      step('routing', { status, found, fix, next });
    } else {
      const w = f.internetPing;
      // Many networks (offices, VPNs, some providers) drop pings: a connection that gets out is what counts.
      const through = f.tcp443.byIp === true || f.tcp443.byName === true || f.dnsDirect?.ok === true || (f.web?.status != null && !f.web.portal);
      let headline: string | undefined;
      if (w && !w.received && through) {
        headline = `The internet works: connections get out, though pings to ${PUBLIC_IP} get no reply (this network blocks pings, which is common).`;
        found.push(headline);
      } else if (!through && (!w || !w.received)) {
        status = 'fail';
        headline = `Nothing past the router answers: no reply from ${PUBLIC_IP} and no connection gets out. The internet connection is down, or the router is not passing traffic.`;
        found.push(headline);
        fix.push('Restart the modem and the router: unplug both for 30 seconds, the modem back first.', 'Check your provider’s outage page from a phone on mobile data.');
        if (f.vpn) fix.push(`Turn the VPN (${f.vpn}) off and try again.`);
        next.push({ tool: 'net.traceroute', why: 'how far traffic gets before it stops', input: { target: PUBLIC_IP } }, { tool: 'server.network_check', why: "FBRX Gate's internet side, when an FBRX Server is the router" });
      } else if (w && w.received) {
        found.push(`The internet (${PUBLIC_IP}) answers in ${ms(w)}${w.lossPct ? `, ${w.lossPct}% lost` : ''}.`);
        if (w.lossPct > 0 || (w.avg != null && w.avg > 150)) {
          if (status === 'ok') status = 'warn';
          found.push('Past the router it is lossy or slow: the provider’s line, or something using all the bandwidth.');
          next.push({ tool: 'net.speed_test', why: 'download and upload speed (uses about 100 MB)' }, { tool: 'net.traceroute', why: 'where the delay starts', input: { target: PUBLIC_IP } });
        }
      } else found.push('Connections get out past the router (ping is not available here to time it).');
      step('routing', { status, found, fix, next, headline: headline ?? found.find((x) => x.startsWith('The internet')) ?? found[found.length - 1] });
    }
  }

  // 5. Names.
  if (!f.internetAllowed) {
    step('dns', { status: 'skipped', found: ['Not checked: it needs the internet.'], fix: [] });
  } else {
    const servers = f.dnsServers.length ? f.dnsServers.join(', ') : 'none set';
    if (f.dnsSystem?.ok) {
      const slow = f.dnsSystem.ms != null && f.dnsSystem.ms > 300;
      step('dns', {
        status: slow ? 'warn' : 'ok',
        found: [`Names work: ${f.target?.name ?? PROBE} found through your DNS server (${servers})${f.dnsSystem.ms != null ? ` in ${f.dnsSystem.ms} ms` : ''}.`, ...(slow ? ['That is slow: every page waits for it first.'] : [])],
        fix: slow ? ['Restart the router; if it stays slow, use another DNS server (it asks first).'] : [],
        next: slow ? [{ tool: 'net.dns_lookup', why: 'how fast each DNS server answers' }] : [],
      });
    } else if (f.dnsDirect?.ok) {
      step('dns', {
        status: 'fail',
        found: [`Your DNS server (${servers}) does not answer, but a public one does: websites fail by name while the internet works.`],
        fix: ['Clear the DNS cache (it asks first).', 'Restart the router.', 'Use another DNS server, such as the router’s or your provider’s (it asks first).'],
        next: [{ tool: 'kit.flush_the_dns_cache', why: 'clears names this computer remembered' }, { tool: 'kit.dns_servers', why: 'which DNS servers each adapter uses' }, { tool: 'net.dns_lookup', why: 'which DNS servers answer, and how fast' }],
      });
    } else if (f.proxy) {
      step('dns', {
        status: 'warn',
        found: [`Names do not resolve from here (yours: ${servers}), but a proxy is set (${f.proxy}). On a network where the proxy looks names up itself, browsers still work; if websites fail in the browser too, the proxy or DNS is the problem.`],
        fix: ['If websites fail in the browser, ask whoever runs the network about the proxy, or turn it off if you did not set it.'],
        next: [{ tool: 'net.dns_lookup', why: 'which DNS servers answer' }],
      });
    } else {
      step('dns', {
        status: 'fail',
        found: [`No DNS server answers (yours: ${servers}; a public one: none)${f.internetPing?.received ? ', though the internet does: something blocks names (a firewall, a filter or a VPN)' : ''}.`],
        fix: ['Turn off a VPN or web filter and try again.', 'Restart the router.'],
        next: [{ tool: 'net.dns_lookup', why: 'which DNS servers answer' }, { tool: 'kit.dns_servers', why: 'which DNS servers each adapter uses' }],
      });
    }
  }

  // 6. Connections.
  if (!f.internetAllowed) {
    step('transport', { status: 'skipped', found: ['Not checked: it needs the internet.'], fix: [] });
  } else {
    const found: string[] = [];
    let status: StackStep['status'] = 'ok';
    const fix: string[] = [];
    const next: StackStep['next'] = [];
    if (f.tcp443.byIp === false && f.tcp443.byName !== true && f.web?.status == null) {
      status = 'fail';
      found.push('Secure web traffic (port 443) does not get out, though pings do: a firewall, a web filter or a proxy is stopping it.');
      fix.push('Check the firewall and any security or filtering software; turn a VPN off and try again.');
      next.push({ tool: 'net.port_check', why: 'whether a server answers on a port', input: { host: PROBE, port: 443 } });
    } else found.push(`Secure web traffic (port 443) gets out${f.tcp443.byName ? ` (to ${PROBE})` : ''}.`);
    if (f.proxy) {
      if (status === 'ok') status = 'warn';
      found.push(`A proxy is set (${f.proxy}): when it is down or wrong, websites fail while everything else works.`);
      fix.push('If you did not set the proxy, turn it off in the system’s network settings.');
    }
    step('transport', { status, found, fix, next, headline: status === 'warn' ? found[found.length - 1] : found[0] });
  }

  // 7. Websites.
  if (!f.internetAllowed || !f.web) {
    step('application', { status: 'skipped', found: ['Not checked: it needs the internet.'], fix: [] });
  } else {
    const found: string[] = [];
    let status: StackStep['status'] = 'ok';
    const fix: string[] = [];
    const next: StackStep['next'] = [];
    const skew = f.web.clockSkewMin;
    if (f.web.portal) {
      status = 'fail';
      found.push('A sign-in page is in the way (hotel, café or guest Wi-Fi): pages go to it until you sign in or accept its terms.');
      fix.push('Open a browser and go to any plain web page; the sign-in page comes up. Sign in, then try again.');
    } else if (f.web.status != null && f.web.status < 500) found.push(`Secure websites load (${PROBE} answered ${f.web.status}).`);
    else if (f.web.error && f.proxy) {
      status = 'warn';
      found.push(`Secure websites do not load directly (${f.web.error}); this network reaches the web through its proxy (${f.proxy}), which this check does not use. If the browser loads pages, all is well.`);
    } else if (f.web.error) {
      status = 'fail';
      found.push(`Secure websites fail: ${f.web.error}.`);
      if (/cert|tls|ssl/i.test(f.web.error)) fix.push('Check the date and time; a security program that inspects web traffic can also do this.');
    }
    if (skew != null && Math.abs(skew) >= 5) {
      if (status === 'ok') status = 'warn';
      found.push(`This computer’s clock is ${Math.abs(skew)} minutes ${skew > 0 ? 'ahead' : 'behind'}: secure sites and sign-ins fail when it is far off.`);
      fix.push('Set the date and time automatically in the system’s settings.');
    }
    const t = f.target;
    if (t && status !== 'fail') {
      if (!t.resolved) {
        status = 'fail';
        found.push(`${t.name} does not resolve to an address: the name may be misspelled, or the site is gone. Other sites work, so it is not your connection.`);
        next.push({ tool: 'net.dns_lookup', why: 'what each DNS server says about the name', input: { name: t.name } });
      } else if (t.port443 === false) {
        status = 'fail';
        found.push(`${t.name} does not answer on port 443: the site itself looks down (other sites work).`);
        next.push({ tool: 'net.port_check', why: 'whether it answers on other ports', input: { host: t.name, port: 80 } }, { tool: 'net.traceroute', why: 'how far traffic to it gets', input: { target: t.name } });
      } else if (t.status != null && t.status >= 500) {
        if (status === 'ok') status = 'warn';
        found.push(`${t.name} answers, with an error (${t.status}): the site has a problem of its own, not your connection.`);
      } else if (t.error) {
        status = 'fail';
        found.push(`${t.name} fails: ${t.error}.`);
        next.push({ tool: 'net.check_link', why: 'where the address really goes, and its certificate', input: { url: `https://${t.name}` } });
      } else found.push(`${t.name} loads${t.status != null ? ` (it answered ${t.status})` : ''}.`);
    }
    step('application', { status, found, fix, next, headline: status === 'ok' ? found[found.length - 1] : found.find((x) => !x.startsWith('Secure websites load')) });
  }

  const firstFail = steps.find((s) => s.status === 'fail');
  const warns = steps.filter((s) => s.status === 'warn');
  const summary = firstFail
    ? `It breaks at ${NAMES[firstFail.layer]}: ${firstFail.headline}${firstFail.fix[0] ? ` First: ${firstFail.fix[0]}` : ''}`
    : warns.length
      ? `It works, with ${warns.length === 1 ? `one thing to look at, ${NAMES[warns[0]!.layer]}: ${warns[0]!.headline}` : `${warns.length} things to look at: ${warns.map((w) => NAMES[w.layer]).join(', ').replace(/, ([^,]*)$/, ' and $1')}.`}${f.internetAllowed ? '' : ' The internet was not checked.'}`
      : f.internetAllowed
        ? 'Every layer works, from the adapter to secure websites.'
        : 'This computer and the router work; the internet was not checked (an offline chat or a policy).';
  return { at: at.toISOString(), target: f.target?.name ?? null, breaksAt: firstFail?.layer ?? null, summary, steps, localOnly: !f.internetAllowed };
}

/** The check as text for the AI: where it breaks, then each layer with what it found, the fix and the next tools. */
export function stackText(r: StackReport, os: StackFacts['os']): string {
  const mark = { ok: '✓', warn: '!', fail: '✗', skipped: '–' } as const;
  const out = [r.summary, ''];
  r.steps.forEach((s, i) => {
    out.push(`${i + 1}. ${mark[s.status]} ${s.title}`);
    for (const f of s.found) out.push(`   ${f}`);
    if (s.status !== 'skipped') out.push(`   By hand: ${s.commands[os].join(' ; ')}`);
    for (const f of s.fix) out.push(`   Do: ${f}`);
    for (const n of s.next) out.push(`   Next tool: ${n.tool}${n.input ? ` ${JSON.stringify(n.input)}` : ''} (${n.why})`);
  });
  return out.join('\n');
}

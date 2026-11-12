import { quoteName, type WifiAccessPoint, type WifiBand, type WifiBandReport, type WifiChannelLoad } from '@fbrx/shared';

/**
 * The Wi-Fi channel planner: how busy each channel is with the networks around you, which channel your network
 * should move to, and why, in plain words. Only what a scan sees is used: each access point's channel, band and
 * signal. A network on the same channel shares the air (they take turns); one on an overlapping 2.4 GHz channel is
 * worse, because it is noise that cannot be taken turns with. Louder neighbors count for more.
 */

/** The 2.4 GHz channels in use around the world (14 is Japan only and left out). */
const CH24 = Array.from({ length: 13 }, (_, i) => i + 1);
/** The three 2.4 GHz channels that do not overlap each other: the only ones worth choosing. */
const CLEAR24 = [1, 6, 11];
/** 5 GHz channels (20 MHz). 52–144 are DFS: radar may force a router off them, and some devices do not use them. */
const CH5 = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165];
const DFS = (ch: number) => ch >= 52 && ch <= 144;
/** 6 GHz preferred scanning channels (PSC), where 6 GHz routers start. */
const CH6 = [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213, 229];

/** How much a network on one 2.4 GHz channel disturbs another, by how many channels apart they are. */
const OVERLAP24 = [1, 0.8, 0.5, 0.2, 0.05];
/** The 80 MHz block a 5 GHz channel belongs to: networks in the same block step on each other once they go wide. */
const block80 = (ch: number) => (ch >= 149 ? Math.floor((ch - 149) / 16) + 100 : Math.floor((ch - 36) / 16));

export const bandOf = (frequencyMhz: number | null | undefined, channel?: number | null): WifiBand | null => {
  if (frequencyMhz) return frequencyMhz >= 5925 ? '6 GHz' : frequencyMhz >= 4900 ? '5 GHz' : frequencyMhz >= 2400 ? '2.4 GHz' : null;
  if (!channel) return null;
  return channel <= 14 ? '2.4 GHz' : '5 GHz';
};

/** A neighbor's weight: 1 at -40 dBm and stronger, falling to almost nothing near -90 dBm. */
const weight = (dbm: number) => Math.min(1, Math.max(0.02, (dbm + 92) / 52));

/** How much each channel of a band is disturbed by the networks around (your own left out). */
export function channelLoads(band: WifiBand, points: WifiAccessPoint[]): WifiChannelLoad[] {
  const others = points.filter((p) => p.band === band && !p.mine);
  const mineOn = new Set(points.filter((p) => p.band === band && p.mine).map((p) => p.channel));
  const list = band === '2.4 GHz' ? CH24 : band === '5 GHz' ? CH5 : CH6;
  return list.map((channel) => {
    let load = 0;
    let networks = 0;
    for (const p of others) {
      const near = band === '2.4 GHz' ? (OVERLAP24[Math.abs(p.channel - channel)] ?? 0) : p.channel === channel ? 1 : band === '5 GHz' && block80(p.channel) === block80(channel) ? 0.35 : 0;
      if (near > 0) load += near * weight(p.signalDbm);
      if (p.channel === channel) networks++;
    }
    return { channel, networks, load: Math.round(load * 100) / 100, dfs: band === '5 GHz' && DFS(channel), mine: mineOn.has(channel) };
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The report for one band: where your network is, the best channel to move to, and what to do. */
export function bandReport(band: WifiBand, points: WifiAccessPoint[], o: { ultra: boolean }): WifiBandReport {
  const channels = channelLoads(band, points);
  const mine = points.find((p) => p.band === band && p.connected) ?? points.find((p) => p.band === band && p.mine) ?? null;
  const at = (ch: number) => channels.find((c) => c.channel === ch);
  const candidates = band === '2.4 GHz' ? channels.filter((c) => CLEAR24.includes(c.channel)) : band === '5 GHz' ? channels.filter((c) => o.ultra || !c.dfs) : channels;
  const best = [...candidates].sort((a, b) => a.load - b.load || a.networks - b.networks || (a.dfs ? 1 : 0) - (b.dfs ? 1 : 0))[0] ?? null;
  const advice: string[] = [];
  const nearby = points.filter((p) => p.band === band && !p.mine).length;
  if (!nearby) advice.push(`No other ${band} networks are in range: any channel is fine.`);
  if (mine && best) {
    const now = at(mine.channel);
    const off24 = band === '2.4 GHz' && !CLEAR24.includes(mine.channel);
    if (off24) advice.push(`Channel ${mine.channel} overlaps its neighbors on both sides. Use 1, 6 or 11: they are the only 2.4 GHz channels that do not overlap.`);
    if (now && best.channel !== mine.channel && (off24 || now.load - best.load >= 0.3)) {
      advice.push(`Move ${quoteName(mine.ssid)} from channel ${mine.channel} to ${best.channel}: ${best.networks ? `${plural(best.networks, 'network')} there` : 'nobody else is there'}, against ${plural(now.networks, 'network')} on ${mine.channel}${now.load > 1 ? ', several of them loud' : ''}.`);
    } else if (now) advice.push(`Channel ${mine.channel} is a good choice for ${quoteName(mine.ssid)}: no channel nearby is clearly quieter.`);
    if (mine.signalDbm < -70) advice.push(`Your signal is weak here (${mine.signalDbm} dBm): moving closer to the router, or a mesh node or access point nearer this room, helps more than any channel.`);
  } else if (best) advice.push(`If you have a ${band} network, channel ${best.channel} is the quietest here.`);
  if (band === '2.4 GHz' && mine && points.some((p) => p.mine && p.band !== '2.4 GHz')) {
    advice.push('Your router also has a faster 5 or 6 GHz network: devices close to it should use that one.');
  }
  const report: WifiBandReport = { band, channels, mine: mine?.channel ?? null, best: best ? { channel: best.channel, load: best.load, dfs: best.dfs } : null, advice, width: null };
  if (o.ultra) report.width = widthAdvice(band, channels, best?.channel ?? mine?.channel ?? null);
  if (o.ultra && band === '5 GHz' && best?.dfs) advice.push(`Channel ${best.channel} is a DFS channel: quiet because few routers use it, but the router has to leave it if it detects radar, and a few older devices cannot see it. If anything drops off, use ${candidates.filter((c) => !c.dfs).sort((a, b) => a.load - b.load)[0]?.channel ?? 36} instead.`);
  return report;
}

/** Endpoint Ultra: how wide the channel can be here (wider is faster, but takes more of a crowded band). */
function widthAdvice(band: WifiBand, channels: WifiChannelLoad[], ch: number | null): WifiBandReport['width'] {
  if (band === '2.4 GHz') return { mhz: 20, why: 'At 2.4 GHz, 40 MHz takes two of the three clear channels: keep 20 MHz.' };
  if (band === '6 GHz') return { mhz: 160, why: '6 GHz has room: 160 MHz gives the most speed to devices that support it.' };
  if (ch === null) return null;
  const blockLoad = channels.filter((c) => block80(c.channel) === block80(ch)).reduce((a, c) => a + c.load, 0);
  if (blockLoad < 0.4) return { mhz: 80, why: `The channels around ${ch} are quiet: 80 MHz is fast and will not step on anyone.` };
  if (blockLoad < 1.2) return { mhz: 40, why: `Some networks share the channels around ${ch}: 40 MHz keeps speed up without fighting them.` };
  return { mhz: 20, why: `The channels around ${ch} are crowded: 20 MHz holds up better than a wide channel here.` };
}

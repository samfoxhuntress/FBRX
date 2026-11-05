import { describe, expect, it } from 'vitest';
import type { WifiAccessPoint, WifiBand } from '@fbrx/shared';
import { bandOf, bandReport, channelLoads } from '../src/network/wifi-channels';

const ap = (ssid: string, channel: number, signalDbm: number, o: Partial<WifiAccessPoint> = {}): WifiAccessPoint => ({
  ssid,
  bssid: `${ssid}-${channel}`,
  channel,
  band: (channel <= 14 ? '2.4 GHz' : '5 GHz') as WifiBand,
  signalDbm,
  signalPct: 0,
  security: 'WPA2',
  mine: false,
  connected: false,
  ...o,
});
const home = (channel: number, signalDbm = -50) => ap('Home', channel, signalDbm, { mine: true, connected: true });

describe('the Wi-Fi channel planner', () => {
  it('tells the bands apart by frequency, or by channel when the frequency is missing', () => {
    expect([bandOf(2437), bandOf(5180), bandOf(5955), bandOf(null, 11), bandOf(null, 149)]).toEqual(['2.4 GHz', '5 GHz', '6 GHz', '2.4 GHz', '5 GHz']);
  });

  it('moves a 2.4 GHz network off an overlapping channel to the quietest of 1, 6 and 11', () => {
    const points = [home(3), ap('A', 1, -45), ap('B', 1, -60), ap('C', 6, -50), ap('D', 6, -70), ap('E', 11, -85)];
    const r = bandReport('2.4 GHz', points, { ultra: false });
    expect(r.mine).toBe(3);
    expect(r.best?.channel).toBe(11);
    expect(r.advice[0]).toMatch(/overlaps its neighbors on both sides\. Use 1, 6 or 11/);
    expect(r.advice[1]).toMatch(/Move "Home" from channel 3 to 11: 1 network there/);
    expect(r.width).toBeNull(); // channel width advice is Ultra
    // Your own network never counts against you, and an overlapping neighbor disturbs the channels next to it.
    const loads = channelLoads('2.4 GHz', points);
    expect(loads.find((c) => c.channel === 3)).toMatchObject({ networks: 0, mine: true });
    expect(loads.find((c) => c.channel === 2)!.load).toBeGreaterThan(loads.find((c) => c.channel === 11)!.load);
  });

  it('keeps a channel that is already the quiet one, and says when the signal, not the channel, is the problem', () => {
    const r = bandReport('2.4 GHz', [home(11, -78), ap('A', 1, -50), ap('B', 6, -55)], { ultra: false });
    expect(r.best?.channel).toBe(11);
    expect(r.advice).toEqual([expect.stringMatching(/Channel 11 is a good choice/), expect.stringMatching(/signal is weak here \(-78 dBm\)/)]);
  });

  it('leaves DFS channels out unless on Endpoint Ultra, which also says how wide to go', () => {
    const points = [home(36), ap('A', 36, -50), ap('B', 40, -55), ap('C', 149, -60), ap('D', 157, -65), ap('E', 44, -60), ap('F', 48, -62), ap('G', 153, -60), ap('H', 161, -64), ap('I', 165, -70)];
    const plain = bandReport('5 GHz', points, { ultra: false });
    expect(plain.best?.dfs).toBe(false);
    expect(plain.width).toBeNull();

    const ultra = bandReport('5 GHz', points, { ultra: true });
    expect(ultra.best).toMatchObject({ dfs: true, load: 0 });
    expect(ultra.width).toMatchObject({ mhz: 80 });
    expect(ultra.advice.at(-1)).toMatch(/is a DFS channel: quiet because few routers use it/);
  });

  it('says any channel will do when nobody else is around', () => {
    const r = bandReport('5 GHz', [home(149)], { ultra: true });
    expect(r.advice[0]).toBe('No other 5 GHz networks are in range: any channel is fine.');
    expect(r.width).toMatchObject({ mhz: 80 });
  });
});

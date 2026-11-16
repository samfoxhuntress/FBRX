import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanName, type MonitorControl, type MonitorControls, type MonitorFeature } from '@fbrx/shared';
import { CoreError } from '../errors';

/**
 * Brightness, contrast and the input of external screens (This PC → Devices), over DDC/CI, the channel screens listen on
 * through their cable: Windows' own monitor configuration API (dxva2, no installs), ddcutil on Linux. Not on a Mac yet.
 * A screen that does not answer is left out; nothing is changed but what the person moves.
 */

const run = promisify(execFile);

/** The input codes of the monitor standard (VCP 0x60), with the USB-C one most screens use. */
export const INPUTS: Record<number, string> = {
  0x01: 'VGA 1',
  0x02: 'VGA 2',
  0x03: 'DVI 1',
  0x04: 'DVI 2',
  0x0f: 'DisplayPort 1',
  0x10: 'DisplayPort 2',
  0x11: 'HDMI 1',
  0x12: 'HDMI 2',
  0x13: 'HDMI 3',
  0x1b: 'USB-C',
};
const CODE: Record<MonitorFeature, number> = { brightness: 0x10, contrast: 0x12, input: 0x60 };

/** The input codes a screen lists in its capabilities ("60(0F 11 12)"), or in ddcutil's feature list. */
export function inputsFromCapabilities(caps: string): number[] {
  const codes = (list: string[]) => [...new Set(list.map((h) => Number.parseInt(h, 16)).filter((n) => Number.isFinite(n) && n > 0 && n < 0x100))];
  // The raw capabilities string: "vcp(... 60(0F 11 12) ...)".
  const raw = /(?:^|[\s(])60\s*\(\s*((?:[0-9a-f]{2}\s*)+)\)/i.exec(caps);
  if (raw) return codes(raw[1].trim().split(/\s+/));
  // ddcutil's own listing: "Feature: 60 (Input Source)", then "   0f: DisplayPort-1" lines until the next feature.
  const lines = caps.split('\n');
  const at = lines.findIndex((l) => /^\s*Feature:\s*60\b/i.test(l));
  if (at < 0) return [];
  const found: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\s*Feature:/i.test(l)) break;
    const v = /^\s+([0-9a-f]{2}):/i.exec(l);
    if (v) found.push(v[1]);
  }
  return codes(found);
}

// ------------------------------------------------------------------------------------------------------------- Linux

/** ddcutil detect --terse: each display's number and its model. */
export function parseDdcutilDetect(out: string): Array<{ display: number; name: string }> {
  const list: Array<{ display: number; name: string }> = [];
  for (const block of out.split(/\n(?=Display \d+)/)) {
    const d = /^Display (\d+)/m.exec(block);
    if (!d) continue;
    const model = /Monitor:\s*([^\n]+)/.exec(block)?.[1]?.split(':')[1];
    list.push({ display: Number(d[1]), name: cleanName(model ?? '').trim() || `Screen ${d[1]}` });
  }
  return list;
}

/** ddcutil getvcp --brief: "VCP 10 C 50 100" (current and max), "VCP 60 SNC x0f". */
export function parseDdcutilVcp(out: string): Partial<Record<MonitorFeature, { value: number; max: number }>> {
  const r: Partial<Record<MonitorFeature, { value: number; max: number }>> = {};
  for (const line of out.split('\n')) {
    const c = /^VCP\s+(10|12)\s+C\s+(\d+)\s+(\d+)/i.exec(line.trim());
    if (c) r[c[1] === '10' ? 'brightness' : 'contrast'] = { value: Number(c[2]), max: Number(c[3]) || 100 };
    const s = /^VCP\s+60\s+SNC\s+x([0-9a-f]+)/i.exec(line.trim());
    if (s) r.input = { value: Number.parseInt(s[1], 16) & 0xff, max: 0xff };
  }
  return r;
}

async function linuxControls(): Promise<MonitorControls> {
  let detect: string;
  try {
    detect = (await run('ddcutil', ['detect', '--terse'], { timeout: 30_000 })).stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') return { supported: false, why: 'Install ddcutil to change a screen’s brightness from here (for example: sudo apt install ddcutil), then sign out and in again.', monitors: [] };
    if (/permission|i2c/i.test(err.stderr ?? '')) return { supported: false, why: 'ddcutil needs to reach the screens: add yourself to the i2c group (sudo usermod -aG i2c $USER), then sign out and in again.', monitors: [] };
    return { supported: false, why: 'The screens did not answer ddcutil.', monitors: [] };
  }
  const monitors: MonitorControl[] = [];
  for (const d of parseDdcutilDetect(detect).slice(0, 8)) {
    try {
      const vcp = parseDdcutilVcp((await run('ddcutil', ['--display', String(d.display), 'getvcp', '10', '12', '60', '--brief'], { timeout: 20_000 })).stdout);
      const caps = await run('ddcutil', ['--display', String(d.display), 'capabilities', '--terse'], { timeout: 20_000 }).then((x) => x.stdout, () => '');
      monitors.push(control(`ddc-${d.display}`, d.name, vcp, inputsFromCapabilities(caps)));
    } catch {
      // That screen does not take DDC/CI (a built-in one, or it is turned off in the screen's menu).
    }
  }
  return { supported: true, why: monitors.length ? null : 'No screen answered: DDC/CI may be off in the screen’s own menu.', monitors };
}

// ----------------------------------------------------------------------------------------------------------- Windows

/** Reads every physical screen (target < 0), or sets one feature on screen number `target`. */
export function windowsDdcScript(target: number, code: number, value: number): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class FbrxDdc {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct PHYSICAL_MONITOR { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string desc; }
  delegate bool EnumProc(IntPtr m, IntPtr dc, IntPtr r, IntPtr d);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, EnumProc cb, IntPtr d);
  [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr m, out uint n);
  [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr m, uint n, [Out] PHYSICAL_MONITOR[] a);
  [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint n, PHYSICAL_MONITOR[] a);
  [DllImport("dxva2.dll")] static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte c, IntPtr t, out uint cur, out uint max);
  [DllImport("dxva2.dll")] static extern bool SetVCPFeature(IntPtr h, byte c, uint v);
  [DllImport("dxva2.dll")] static extern bool GetCapabilitiesStringLength(IntPtr h, out uint n);
  [DllImport("dxva2.dll", CharSet = CharSet.Ansi)] static extern bool CapabilitiesRequestAndCapabilitiesReply(IntPtr h, StringBuilder s, uint n);
  static string Esc(string s) { return (s ?? "").Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\""); }
  public static string Run(int target, int code, int value) {
    var all = new List<PHYSICAL_MONITOR[]>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (m, dc, r, d) => { uint n; if (GetNumberOfPhysicalMonitorsFromHMONITOR(m, out n) && n > 0) { var a = new PHYSICAL_MONITOR[n]; if (GetPhysicalMonitorsFromHMONITOR(m, n, a)) all.Add(a); } return true; }, IntPtr.Zero);
    var sb = new StringBuilder("["); int i = 0; bool first = true;
    try {
      foreach (var a in all) foreach (var p in a) {
        if (target < 0) {
          uint bc, bm, cc, cm, ic, im, len;
          bool b = GetVCPFeatureAndVCPFeatureReply(p.h, 0x10, IntPtr.Zero, out bc, out bm);
          bool c = GetVCPFeatureAndVCPFeatureReply(p.h, 0x12, IntPtr.Zero, out cc, out cm);
          bool s = GetVCPFeatureAndVCPFeatureReply(p.h, 0x60, IntPtr.Zero, out ic, out im);
          string caps = "";
          if (GetCapabilitiesStringLength(p.h, out len) && len > 0 && len < 65536) { var cs = new StringBuilder((int)len); if (CapabilitiesRequestAndCapabilitiesReply(p.h, cs, len)) caps = cs.ToString(); }
          if (!first) sb.Append(","); first = false;
          sb.Append("{\\"index\\":" + i + ",\\"name\\":\\"" + Esc(p.desc) + "\\"");
          if (b) sb.Append(",\\"brightness\\":[" + bc + "," + bm + "]");
          if (c) sb.Append(",\\"contrast\\":[" + cc + "," + cm + "]");
          if (s) sb.Append(",\\"input\\":" + (ic & 0xff));
          sb.Append(",\\"caps\\":\\"" + Esc(caps) + "\\"}");
        } else if (i == target) {
          if (!SetVCPFeature(p.h, (byte)code, (uint)value)) throw new Exception("The screen did not take the change");
        }
        i++;
      }
    } finally { foreach (var a in all) DestroyPhysicalMonitors((uint)a.Length, a); }
    return sb.Append("]").ToString();
  }
}
'@
[FbrxDdc]::Run(${Math.trunc(target)}, ${Math.trunc(code)}, ${Math.trunc(value)})`;
}

async function windows(target: number, code: number, value: number): Promise<string> {
  const script = Buffer.from(windowsDdcScript(target, code, value), 'utf16le').toString('base64');
  return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], { timeout: 60_000, windowsHide: true })).stdout.trim();
}

/** The JSON the Windows script prints, as controls. */
export function parseWindowsDdc(out: string): MonitorControl[] {
  const list = JSON.parse(out || '[]') as Array<{ index: number; name: string; brightness?: [number, number]; contrast?: [number, number]; input?: number; caps?: string }>;
  return list
    .filter((m) => m.brightness || m.contrast || m.input !== undefined)
    .map((m) =>
      control(
        `win-${m.index}`,
        cleanName(m.name ?? '').trim() || `Screen ${m.index + 1}`,
        {
          ...(m.brightness ? { brightness: { value: m.brightness[0], max: m.brightness[1] || 100 } } : {}),
          ...(m.contrast ? { contrast: { value: m.contrast[0], max: m.contrast[1] || 100 } } : {}),
          ...(m.input !== undefined ? { input: { value: m.input, max: 0xff } } : {}),
        },
        inputsFromCapabilities(m.caps ?? ''),
      ),
    );
}

// ------------------------------------------------------------------------------------------------------------ Shared

function control(id: string, name: string, vcp: Partial<Record<MonitorFeature, { value: number; max: number }>>, inputs: number[]): MonitorControl {
  const options = inputs.map((code) => ({ code, label: INPUTS[code] ?? `Input ${code.toString(16).toUpperCase().padStart(2, '0')}` }));
  return {
    id,
    name,
    brightness: vcp.brightness ?? null,
    contrast: vcp.contrast ?? null,
    input: vcp.input || options.length ? { value: vcp.input?.value ?? null, options } : null,
  };
}

/** The last read, so a change is checked against what the screen said it takes. */
let lastRead: MonitorControl[] = [];

export async function monitorControls(platform: NodeJS.Platform = process.platform): Promise<MonitorControls> {
  let r: MonitorControls;
  if (platform === 'win32') {
    try {
      const monitors = parseWindowsDdc(await windows(-1, 0, 0));
      r = { supported: true, why: monitors.length ? null : 'No screen answered: DDC/CI may be off in the screen’s own menu, or the screen is built in.', monitors };
    } catch {
      r = { supported: true, why: 'The screens could not be read just now.', monitors: [] };
    }
  } else if (platform === 'linux') r = await linuxControls();
  else r = { supported: false, why: 'Changing an external screen’s brightness from FBRX is not on a Mac yet: use the screen’s own buttons.', monitors: [] };
  lastRead = r.monitors;
  return r;
}

/** Sets one feature of one screen, within what the screen last said it takes. */
export async function setMonitor(id: string, feature: MonitorFeature, value: number, platform: NodeJS.Platform = process.platform): Promise<{ ok: true }> {
  const m = lastRead.find((x) => x.id === id);
  if (!m) throw new CoreError('NOT_FOUND', 'Read the screens first: that one is not in the list');
  if (!Number.isInteger(value) || value < 0) throw new CoreError('INVALID_ARGUMENT', 'Not a value a screen takes');
  if (feature === 'input') {
    if (!m.input?.options.some((o) => o.code === value)) throw new CoreError('INVALID_ARGUMENT', 'That screen does not list that input');
  } else {
    const f = m[feature];
    if (!f) throw new CoreError('INVALID_ARGUMENT', `That screen does not take a ${feature} setting`);
    if (value > f.max) throw new CoreError('INVALID_ARGUMENT', `At most ${f.max}`);
  }
  const code = CODE[feature];
  try {
    if (platform === 'win32') await windows(Number(id.replace(/^win-/, '')), code, value);
    else if (platform === 'linux') await run('ddcutil', ['--display', id.replace(/^ddc-/, ''), 'setvcp', code.toString(16), String(value)], { timeout: 20_000 });
    else throw new CoreError('UNAVAILABLE', 'Not on a Mac yet');
  } catch (e) {
    if (e instanceof CoreError) throw e;
    throw new CoreError('CONFLICT', 'The screen did not take the change: it may be off, asleep, or have DDC/CI turned off in its menu');
  }
  if (feature === 'input' && m.input) m.input.value = value;
  else if (feature !== 'input' && m[feature]) m[feature]!.value = value;
  return { ok: true };
}

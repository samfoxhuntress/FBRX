import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { arch, hostname, networkInterfaces, platform, release, version } from 'node:os';
import type { DeviceFacts, Platform } from '@fbrx/shared';

let cachedMachineId: string | null = null;

function rawMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
      const m = /"IOPlatformUUID" = "([^"]+)"/.exec(out);
      if (m) return m[1];
    } else if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      if (m) return m[1];
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) if (existsSync(f)) return readFileSync(f, 'utf8').trim();
    }
  } catch {
    /* fall through */
  }
  const macs = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && !n.internal && n.mac !== '00:00:00:00:00:00')
    .map((n) => n!.mac)
    .sort();
  return `${hostname()}|${macs.join(',')}`;
}

/** Stable, non-reversible hardware fingerprint (salted so it cannot be correlated with other software). */
export function machineId(): string {
  if (!cachedMachineId) cachedMachineId = createHash('sha256').update(`fbrx-os:${rawMachineId()}`).digest('hex');
  return cachedMachineId;
}

export function deviceFacts(appVersion: string, deviceName: string): DeviceFacts {
  return {
    name: deviceName || hostname(),
    hostname: hostname(),
    platform: (['darwin', 'win32', 'linux'].includes(platform()) ? platform() : 'linux') as Platform,
    arch: arch(),
    osVersion: `${release()} ${version()}`.slice(0, 200),
    appVersion,
    machineId: machineId(),
  };
}

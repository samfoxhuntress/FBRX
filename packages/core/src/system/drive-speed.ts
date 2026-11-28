import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DriveSpeed } from '@fbrx/shared';
import { CoreError } from '../errors';

/**
 * A quick read and write speed test of an external drive (This PC → Devices): a test file written and flushed to the
 * drive, then read back past the system's cache (dd's direct reads on Linux, perl's F_NOCACHE on a Mac, unbuffered
 * reads on Windows), then removed. Where reading past the cache is not possible, the read is marked as cached.
 */

const run = promisify(execFile);
const BLOCK = 4 << 20;

/** Windows: unbuffered reads into page-aligned memory, timed in the same process (no compile time counted). */
export function windowsReadScript(path: string): string {
  const quoted = `'${path.replace(/'/g, "''")}'`;
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class FbrxDriveRead {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern SafeFileHandle CreateFile(string n, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(SafeFileHandle h, IntPtr b, uint n, out uint r, IntPtr o);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr VirtualAlloc(IntPtr a, UIntPtr s, uint t, uint p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool VirtualFree(IntPtr a, UIntPtr s, uint t);
  public static long Read(string path) {
    SafeFileHandle h = CreateFile(path, 0x80000000, 1, IntPtr.Zero, 3, 0x20000000 | 0x08000000, IntPtr.Zero);
    if (h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    uint size = ${BLOCK}; IntPtr buf = VirtualAlloc(IntPtr.Zero, (UIntPtr)size, 0x3000, 0x04); long total = 0; uint got;
    try { while (ReadFile(h, buf, size, out got, IntPtr.Zero) && got > 0) total += got; }
    finally { VirtualFree(buf, UIntPtr.Zero, 0x8000); h.Dispose(); }
    return total;
  }
}
'@
$w = [Diagnostics.Stopwatch]::StartNew()
$bytes = [FbrxDriveRead]::Read(${quoted})
$w.Stop()
@{ bytes = $bytes; ms = $w.Elapsed.TotalMilliseconds } | ConvertTo-Json -Compress`;
}

const PERL_NOCACHE = 'open(my $f, "<", $ARGV[0]) or die "$!"; fcntl($f, 48, 1); my $b; my $t = 0; while (my $n = sysread($f, $b, 4194304)) { $t += $n } print $t;';

/** Reads the file past the cache; seconds, or null when this system cannot read past it. */
async function uncachedRead(file: string, platform: NodeJS.Platform): Promise<number | null> {
  try {
    if (platform === 'linux') {
      const t = process.hrtime.bigint();
      await run('dd', [`if=${file}`, 'of=/dev/null', `bs=${BLOCK}`, 'iflag=direct'], { timeout: 300_000 });
      return Number(process.hrtime.bigint() - t) / 1e9;
    }
    if (platform === 'darwin') {
      const t = process.hrtime.bigint();
      await run('/usr/bin/perl', ['-e', PERL_NOCACHE, file], { timeout: 300_000 });
      return Number(process.hrtime.bigint() - t) / 1e9;
    }
    if (platform === 'win32') {
      const script = Buffer.from(windowsReadScript(file), 'utf16le').toString('base64');
      const out = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], { timeout: 300_000, windowsHide: true })).stdout;
      const r = JSON.parse(out.trim()) as { bytes: number; ms: number };
      return r.bytes > 0 && r.ms > 0 ? r.ms / 1000 : null;
    }
  } catch {
    // Direct reads are refused (a file system without them, say): fall back to a cached read.
  }
  return null;
}

/** Writes sizeMB to a test file on the drive at `mount`, reads it back, removes it. */
export async function driveSpeed(mount: string, o: { sizeMB?: number; platform?: NodeJS.Platform } = {}): Promise<DriveSpeed> {
  const platform = o.platform ?? process.platform;
  let free: number;
  try {
    const s = statfsSync(mount);
    free = Number(s.bavail) * Number(s.bsize);
  } catch {
    throw new CoreError('NOT_FOUND', 'That drive is not open on this computer');
  }
  let sizeMB = o.sizeMB ?? 256;
  if (free < sizeMB * 4 * (1 << 20)) sizeMB = 64;
  if (free < sizeMB * 2 * (1 << 20)) throw new CoreError('CONFLICT', 'The drive is too full for a speed test: it needs about 128 MB free');
  const file = join(mount, `.fbrx-speed-${randomBytes(4).toString('hex')}.tmp`);
  const chunk = randomBytes(BLOCK);
  const blocks = Math.max(1, Math.round((sizeMB << 20) / BLOCK));
  const bytes = blocks * BLOCK;
  // Asynchronous writes and reads: FBRX keeps answering while a slow drive takes its time.
  let fh: FileHandle | null = null;
  try {
    try {
      fh = await open(file, 'w');
    } catch {
      throw new CoreError('FORBIDDEN', 'FBRX cannot write to that drive (it may be read-only, or locked)');
    }
    const w0 = process.hrtime.bigint();
    for (let i = 0; i < blocks; i++) await fh.write(chunk);
    await fh.sync();
    const writeSec = Number(process.hrtime.bigint() - w0) / 1e9;
    await fh.close();
    fh = null;
    let readSec = await uncachedRead(file, platform);
    const cached = readSec === null;
    if (readSec === null) {
      const rh = await open(file, 'r');
      try {
        const buf = Buffer.alloc(BLOCK);
        const r0 = process.hrtime.bigint();
        while ((await rh.read(buf, 0, BLOCK, null)).bytesRead > 0);
        readSec = Number(process.hrtime.bigint() - r0) / 1e9;
      } finally {
        await rh.close();
      }
    }
    const mbps = (sec: number) => Math.round((bytes / (1 << 20) / Math.max(sec, 1e-6)) * 10) / 10;
    const writeMBps = mbps(writeSec);
    const readMBps = mbps(readSec);
    const slow = Math.min(writeMBps, readMBps) < 40;
    return {
      mount,
      sizeMB: Math.round(bytes / (1 << 20)),
      writeMBps,
      readMBps,
      readCached: cached,
      note: cached
        ? 'The read came partly from the computer’s memory, so it can look faster than the drive is.'
        : slow
          ? 'Slow for a USB 3 drive: it may be on a USB 2 port, hub or cable. A USB 3 port is often blue or marked SS.'
          : null,
    };
  } finally {
    await fh?.close().catch(() => undefined);
    await unlink(file).catch(() => undefined);
  }
}

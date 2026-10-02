import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

/**
 * Moves the real mouse pointer for the Silly Goose on Windows: a small PowerShell helper that reads "x y" lines and
 * calls SetCursorPos, so while the goose holds the pointer in its beak it really is dragged along (and fighting it
 * is futile for a second or two). It is started when the goose arrives, so it is warm by the time the goose
 * grabs the pointer, and ended when the goose leaves. Other platforms keep the drawn pointer instead.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace FbrxGoose -Name Pointer -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
'@
try { [FbrxGoose.Pointer]::SetProcessDpiAwarenessContext([System.IntPtr]::new(-4)) | Out-Null } catch { [FbrxGoose.Pointer]::SetProcessDPIAware() | Out-Null }
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'q') { break }
  $p = $line.Split(' ')
  if ($p.Length -eq 2) { [FbrxGoose.Pointer]::SetCursorPos([int]$p[0], [int]$p[1]) | Out-Null }
}
`;

export class CursorPuppet {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;

  static supported(): boolean {
    return process.platform === 'win32';
  }

  /** Starts the helper (no-op if running or unsupported). */
  start(): void {
    if (!CursorPuppet.supported() || this.proc) return;
    const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      const p = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
      this.proc = p;
      p.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('ready')) this.ready = true;
      });
      p.stderr.resume();
      p.on('error', () => this.reset(p));
      p.on('exit', () => this.reset(p));
      p.stdin.on('error', () => undefined);
    } catch {
      this.proc = null;
    }
  }

  /** Whether the real pointer can be moved right now. */
  get available(): boolean {
    return this.ready && !!this.proc;
  }

  /** Puts the pointer at a physical screen position. */
  move(x: number, y: number): void {
    if (!this.available) return;
    this.proc!.stdin.write(`${Math.round(x)} ${Math.round(y)}\n`);
  }

  stop(): void {
    const p = this.proc;
    if (!p) return;
    this.reset(p);
    try {
      p.stdin.end('q\n');
    } catch {
      /* already gone */
    }
    setTimeout(() => !p.killed && p.exitCode === null && p.kill(), 1500).unref();
  }

  private reset(p: ChildProcessWithoutNullStreams) {
    if (this.proc !== p) return;
    this.proc = null;
    this.ready = false;
  }
}

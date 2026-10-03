import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/**
 * Presses Ctrl+V in whatever app has the focus, so a copy picked from the clipboard history lands where you were
 * typing. Windows: a small hidden PowerShell started on first use and kept for the next paste (starting one each time
 * would add half a second). Linux: xdotool, when it is installed. macOS needs an accessibility permission for this, so
 * there FBRX only puts the copy on the clipboard and you press ⌘V.
 */
export class PasteKeys {
  private ps: ChildProcess | null = null;
  private xdotool: boolean | null = null;

  supported(): boolean {
    if (process.platform === 'win32') return true;
    if (process.platform === 'linux') {
      this.xdotool ??= spawnSync('xdotool', ['version'], { stdio: 'ignore', timeout: 2000 }).status === 0;
      return this.xdotool;
    }
    return false;
  }

  /** Starts the helper ahead of time (when the history opens), so the paste itself is instant. */
  warm(): void {
    if (process.platform !== 'win32' || this.ps) return;
    const script = "Add-Type -AssemblyName System.Windows.Forms; while (($l = [Console]::In.ReadLine()) -ne $null) { if ($l -eq 'v') { [System.Windows.Forms.SendKeys]::SendWait('^v') } }";
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    ps.on('exit', () => {
      if (this.ps === ps) this.ps = null;
    });
    ps.on('error', () => {
      if (this.ps === ps) this.ps = null;
    });
    this.ps = ps;
  }

  /** Presses the paste keys once. False when this system can't. */
  paste(): boolean {
    if (!this.supported()) return false;
    if (process.platform === 'win32') {
      this.warm();
      return !!this.ps?.stdin?.write('v\n');
    }
    spawn('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], { stdio: 'ignore' }).on('error', () => undefined);
    return true;
  }

  stop(): void {
    this.ps?.kill();
    this.ps = null;
  }
}

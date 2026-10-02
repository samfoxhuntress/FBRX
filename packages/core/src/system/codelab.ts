import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { CodeFile, CodeLanguage } from '@fbrx/shared';
import { CoreError } from '../errors';
import { openSandbox } from '../windows/security';

/**
 * The code lab's files: plain files in one folder of the data directory, so they can also be opened in VS Code or
 * PowerShell ISE. FBRX never runs them on this computer: JavaScript runs in the desktop app's network-blocked sandbox
 * window, PowerShell and batch files run only inside Windows Sandbox (a disposable Windows with networking off and
 * this folder read-only), and everything else is explained by the AI and run by you, outside FBRX, when you choose.
 */

export const EXTENSIONS: Record<string, CodeLanguage> = {
  ps1: 'powershell',
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  cs: 'csharp',
  java: 'java',
  go: 'go',
  rs: 'rust',
  c: 'c',
  cpp: 'cpp',
  rb: 'ruby',
  sh: 'bash',
  lua: 'lua',
  php: 'php',
  kt: 'kotlin',
  swift: 'swift',
  bat: 'batch',
  cmd: 'batch',
};

const NAME = /^[A-Za-z0-9][\w .()-]{0,79}\.([a-z0-9]+)$/;
const MAX = 512 * 1024;

function findOnPath(names: string[]): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  }
  return null;
}

export class CodeLab {
  constructor(private readonly dir: string) {}

  folder(): string {
    mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  private path(name: string): { path: string; language: CodeLanguage } {
    const m = NAME.exec(name);
    const language = m ? EXTENSIONS[m[1].toLowerCase()] : undefined;
    if (!m || !language) throw new CoreError('INVALID_ARGUMENT', 'Use a simple file name with a code extension, like rps.ps1 or game.py');
    return { path: join(this.folder(), name), language };
  }

  list(): CodeFile[] {
    return readdirSync(this.folder(), { withFileTypes: true })
      .filter((e) => e.isFile() && NAME.test(e.name) && EXTENSIONS[e.name.split('.').pop()!.toLowerCase()])
      .map((e) => {
        const st = statSync(join(this.dir, e.name));
        return { name: e.name, language: EXTENSIONS[e.name.split('.').pop()!.toLowerCase()], size: st.size, updatedAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  read(name: string): { name: string; content: string } {
    const { path } = this.path(name);
    if (!existsSync(path)) throw new CoreError('NOT_FOUND', `${name} is not in the code lab`);
    return { name, content: readFileSync(path, 'utf8') };
  }

  save(name: string, content: string): CodeFile {
    const { path, language } = this.path(name);
    if (Buffer.byteLength(content) > MAX) throw new CoreError('INVALID_ARGUMENT', 'Files in the code lab are limited to 512 KB');
    writeFileSync(path, content, 'utf8');
    const st = statSync(path);
    return { name, language, size: st.size, updatedAt: st.mtime.toISOString() };
  }

  remove(name: string): void {
    rmSync(this.path(name).path, { force: true });
  }

  private vscode(): string | null {
    if (process.platform === 'win32') {
      const cands = [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe')];
      return cands.find((p) => existsSync(p)) ?? null;
    }
    if (process.platform === 'darwin' && existsSync('/Applications/Visual Studio Code.app')) return '/Applications/Visual Studio Code.app';
    return findOnPath(['code']);
  }

  private ise(): string | null {
    if (process.platform !== 'win32') return null;
    const p = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell_ise.exe');
    return existsSync(p) ? p : null;
  }

  editors(): { vscode: boolean; ise: boolean; sandbox: boolean } {
    const sandbox = process.platform === 'win32' && existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsSandbox.exe'));
    return { vscode: !!this.vscode(), ise: !!this.ise(), sandbox };
  }

  open(name: string, app: 'vscode' | 'ise' | 'notepad' | 'folder'): void {
    const { path } = this.path(name);
    if (!existsSync(path)) throw new CoreError('NOT_FOUND', `Save ${name} first`);
    const go = (cmd: string, args: string[]) => spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    if (app === 'vscode') {
      const code = this.vscode();
      if (!code) throw new CoreError('UNAVAILABLE', 'Visual Studio Code is not installed. Get it free from code.visualstudio.com.');
      if (process.platform === 'darwin') go('open', ['-a', code, path]);
      else go(code, [path]);
    } else if (app === 'ise') {
      const ise = this.ise();
      if (!ise) throw new CoreError('UNAVAILABLE', 'PowerShell ISE is not available on this computer');
      go(ise, ['-File', path]);
    } else if (app === 'notepad') {
      if (process.platform === 'win32') go('notepad.exe', [path]);
      else if (process.platform === 'darwin') go('open', ['-e', path]);
      else go('xdg-open', [path]);
    } else if (process.platform === 'win32') go('explorer.exe', [`/select,${path}`]);
    else if (process.platform === 'darwin') go('open', ['-R', path]);
    else go('xdg-open', [this.folder()]);
  }

  /** Runs a PowerShell or batch file in Windows Sandbox: no network, no clipboard, the code lab folder read-only. */
  async sandbox(name: string, workDir: string): Promise<void> {
    const { path, language } = this.path(name);
    if (!existsSync(path)) throw new CoreError('NOT_FOUND', `Save ${name} first`);
    if (language !== 'powershell' && language !== 'batch') throw new CoreError('INVALID_ARGUMENT', 'Windows Sandbox can run PowerShell and batch files; other languages need their own tools installed');
    const inside = `C:\\Users\\WDAGUtilityAccount\\Desktop\\CodeLab\\${name}`;
    const command = language === 'powershell' ? `cmd.exe /c start "FBRX code lab" powershell.exe -NoExit -ExecutionPolicy Bypass -File "${inside}"` : `cmd.exe /c start "FBRX code lab" cmd.exe /k "${inside}"`;
    await openSandbox({ folder: this.folder(), folderName: 'CodeLab', networking: false, command }, workDir);
  }
}

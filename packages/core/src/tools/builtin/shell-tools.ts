import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ToolSpec } from '../types';
import { resolveToolPath } from './fs-tools';
import { truncate } from '../../util/misc';

export interface ShellDeps {
  workspace: string;
  timeoutSeconds: () => number;
}

function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command] };
  }
  const sh = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
  return { file: sh, args: ['-c', command] };
}

export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const { file, args } = shellCommand(command);
    const child = spawn(file, args, {
      cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const LIMIT = 400_000;
    child.stdout.on('data', (b: Buffer) => {
      if (stdout.length < LIMIT) stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      if (stderr.length < LIMIT) stderr += b.toString('utf8');
    });
    const kill = () => {
      if (child.exitCode !== null || !child.pid) return;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export function shellTools(d: ShellDeps): ToolSpec[] {
  return [
    {
      name: 'shell.run',
      title: 'Run command',
      description: `Run a command in ${process.platform === 'win32' ? 'PowerShell' : 'the system shell'} and return its output. Use for tasks no other tool covers.`,
      risk: 'execute',
      source: 'builtin',
      sourceId: null,
      timeoutMs: 3600_000,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', minLength: 1, maxLength: 8000 },
          cwd: { type: 'string', description: 'Working directory (defaults to the FBRX workspace)' },
          timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
        },
        required: ['command'],
      },
      resources: (i) => ({
        command: i.command,
        paths: [{ path: resolveToolPath(i.cwd ?? d.workspace, d.workspace), access: 'read' }],
      }),
      async run(i, ctx) {
        const cwd = resolveToolPath(i.cwd ?? d.workspace, d.workspace);
        const limit = Math.min(i.timeoutSeconds ?? d.timeoutSeconds(), d.timeoutSeconds());
        const r = await runShell(i.command, cwd, limit * 1000, ctx.signal);
        const parts = [`exit code: ${r.code ?? 'killed'}${r.timedOut ? ` (timed out after ${limit}s)` : ''}`];
        if (r.stdout.trim()) parts.push(`stdout:\n${truncate(r.stdout, 16_000)}`);
        if (r.stderr.trim()) parts.push(`stderr:\n${truncate(r.stderr, 6_000)}`);
        return { output: parts.join('\n'), data: { code: r.code, timedOut: r.timedOut } };
      },
    },
  ];
}

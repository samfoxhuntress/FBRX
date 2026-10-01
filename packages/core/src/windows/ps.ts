import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ElevatedResult } from '@fbrx/shared';
import { CoreError } from '../errors';

export const IS_WIN = process.platform === 'win32';

/** Throws UNAVAILABLE on anything but Windows. */
export function requireWindows(feature = 'This feature'): void {
  if (!IS_WIN) throw new CoreError('UNAVAILABLE', `${feature} is available on Windows`);
}

/**
 * PowerShell single-quoted string literal. Nothing inside it is expanded. PowerShell also treats the curly quotes
 * as quote characters, so every quote is doubled as itself to stay literal.
 */
export const psq = (s: unknown): string => `'${String(s ?? '').replace(/['‘’‚‛]/g, (c) => c + c)}'`;

export interface ExecResult {
  code: number | null;
  out: string;
  err: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs a program without a shell; never throws (a missing program reports code -1). */
export function exec(cmd: string, args: string[], o: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let buf = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { windowsHide: true, cwd: o.cwd, env: o.env ?? process.env });
    } catch (e) {
      resolve({ code: -1, out: '', err: (e as Error).message });
      return;
    }
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(kill, o.timeoutMs ?? 60_000);
    o.signal?.addEventListener('abort', kill, { once: true });
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      out += s;
      if (o.onLine) {
        buf += s;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          o.onLine(buf.slice(0, i).replace(/\r$/, ''));
          buf = buf.slice(i + 1);
        }
      }
    });
    child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      err += e.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', kill);
      if (o.onLine && buf) o.onLine(buf);
      resolve({ code: child.exitCode === null && code === null ? -1 : code, out, err });
    });
  });
}

/** Base64 of the UTF-16LE script, as `powershell -EncodedCommand` expects. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const PRELUDE = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ";

/**
 * Runs a PowerShell script. The script travels as `-EncodedCommand`, so no quoting is involved and nothing is
 * written to disk.
 */
export function ps(script: string, timeoutMs = 60_000, o: Omit<ExecOptions, 'timeoutMs'> = {}): Promise<ExecResult> {
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(PRELUDE + script)], {
    ...o,
    timeoutMs,
  });
}

/** Runs a script whose pipeline output is converted to JSON; always returns an array. */
export async function psJson<T = any>(script: string, timeoutMs = 60_000): Promise<T[]> {
  const r = await ps(`${script} | ConvertTo-Json -Depth 5 -Compress`, timeoutMs);
  const t = r.out.trim();
  if (!t) {
    if (r.err.trim() && r.code !== 0) throw new CoreError('INTERNAL', r.err.trim().slice(0, 400));
    return [];
  }
  try {
    const j = JSON.parse(t);
    return Array.isArray(j) ? j : [j];
  } catch {
    throw new CoreError('INTERNAL', (r.err || t).trim().slice(0, 400));
  }
}

/** Runs a script that prints a single JSON document. */
export async function psObject<T = any>(script: string, timeoutMs = 60_000, failure = 'PowerShell command failed'): Promise<T> {
  const r = await ps(script, timeoutMs);
  try {
    return JSON.parse(r.out.trim()) as T;
  } catch {
    throw new CoreError('INTERNAL', (r.err || r.out).trim().slice(0, 300) || failure);
  }
}

/** Normalizes a PowerShell JSON value that may be a single object, an array or null. */
export const arr = <T>(x: T | T[] | null | undefined): T[] => (Array.isArray(x) ? x : x == null ? [] : [x]);

/**
 * Runs a script with administrator rights through the Windows UAC prompt.
 *
 * The script is handed to the elevated PowerShell as `-EncodedCommand` (it is never written to a file the
 * unelevated user could swap before UAC approval). Output goes to a per-job folder that only the elevated job
 * writes and FBRX reads back.
 */
export async function elevated(script: string, opts: { timeoutMs?: number; workDir?: string } = {}): Promise<ElevatedResult> {
  requireWindows('Administrator actions');
  const dir = join(opts.workDir ?? tmpdir(), 'fbrx-elevated', randomBytes(8).toString('hex'));
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'output.log');
  const done = join(dir, 'done');
  const inner = [
    "$ErrorActionPreference='Continue'; $ProgressPreference='SilentlyContinue'",
    `try { & { ${script}\n } *>&1 | Out-File -FilePath ${psq(log)} -Encoding utf8 -Width 300 } catch { $_ | Out-File -FilePath ${psq(log)} -Append -Encoding utf8 }`,
    `'ok' | Out-File -FilePath ${psq(done)} -Encoding ascii`,
  ].join('\n');
  const b64 = encodeCommand(inner);
  if (b64.length > 30_000) throw new CoreError('INVALID_ARGUMENT', 'Administrator script is too long');
  try {
    const r = await ps(
      "try { Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$env:FBRX_ELEVATED_JOB; 'started' } catch { 'cancelled' }",
      opts.timeoutMs ?? 30 * 60_000,
      { env: { ...process.env, FBRX_ELEVATED_JOB: b64 } },
    );
    const output = existsSync(log) ? readFileSync(log, 'utf8').replace(/^﻿/, '').trim() : '';
    const finished = existsSync(done);
    if (/cancelled/.test(r.out) && !finished) throw new CoreError('CANCELLED', 'Administrator permission was declined (UAC)');
    return { ok: finished, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

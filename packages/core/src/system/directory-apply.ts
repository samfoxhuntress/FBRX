import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { directoryRulesWords, type DirectoryPolicy, type DirectoryPolicyUser, type DirectoryRules, type DirectoryStep } from '@fbrx/shared';
import { CoreError } from '../errors';
import { elevated, exec, psObject, psq } from '../windows/ps';

/**
 * Applying the FBRX directory on this computer: what its accounts are now, what would change, and the script the
 * system's administrator prompt runs. The directory only ever touches accounts it made or took over; it disables
 * accounts and never deletes them (or their files), and it never disables, or takes administrator rights from, the
 * account applying the changes.
 */

export type DirectoryOs = 'windows' | 'mac' | 'linux';

export interface LocalAccounts {
  /** By account name (small letters). */
  users: Map<string, { fullName: string }>;
  /** Members of the administrators group. */
  admins: Set<string>;
  /** Groups the directory may use, with their members. */
  groups: Map<string, Set<string>>;
  /** Linux: the group that gives administrator rights here (sudo, wheel or admin). */
  adminGroup: string;
}

/** What this computer remembers about the directory's own changes. */
export interface DirectoryMemory {
  /** Accounts the directory made or took over. */
  users: string[];
  /** Groups the directory made or put people in. */
  groups: string[];
  /** Accounts the directory disabled. */
  disabled: string[];
  /** The rules it last applied. */
  rules: DirectoryRules | null;
}

export const EMPTY_MEMORY: DirectoryMemory = { users: [], groups: [], disabled: [], rules: null };

/** A step with what the script needs to do it. */
export interface PlannedStep extends DirectoryStep {
  fullName?: string;
  /** create and password: the line of the passwords file that holds it (0-based), and its version. */
  passwordLine?: number;
  passwordVersion?: number;
  rules?: DirectoryRules;
  /** rules (Linux): the directory's accounts, for how long their passwords last. */
  accounts?: string[];
}

export interface DirectoryPlan {
  steps: PlannedStep[];
  /** The first passwords, one per line, in the order steps refer to them. */
  passwords: string[];
  /** What will not be done, in words. */
  problems: string[];
}

const sameRules = (a: DirectoryRules | null, b: DirectoryRules) => !!a && (Object.keys(b) as (keyof DirectoryRules)[]).every((k) => a[k] === b[k]);

/** What applying the policy would change here. `me` is the account applying it. */
export function planDirectory(policy: DirectoryPolicy, local: LocalAccounts, memory: DirectoryMemory, me: string): DirectoryPlan {
  const steps: PlannedStep[] = [];
  const passwords: string[] = [];
  const problems: string[] = [];
  const self = me.toLowerCase();
  const managed = new Set(memory.users);
  const disabled = new Set(memory.disabled);
  const dirGroups = new Set([...policy.groups, ...memory.groups]);
  const made = new Set<string>();
  const password = (u: DirectoryPolicyUser) => {
    passwords.push(u.password!.value);
    return { passwordLine: passwords.length - 1, passwordVersion: u.password!.version };
  };

  for (const u of policy.users) {
    const here = local.users.get(u.username);
    const isMe = u.username === self;
    if (!here) {
      if (!u.password) {
        problems.push(`${u.username} is not on this computer and its first password was already used here: ask the directory's administrator for a new one`);
        continue;
      }
      steps.push({ kind: 'create', user: u.username, fullName: u.fullName, ...password(u), words: `Adds the account ${u.username}${u.fullName ? ` (${u.fullName})` : ''}; they choose their own password when they first sign in` });
    } else {
      if (!managed.has(u.username)) steps.push({ kind: 'adopt', user: u.username, words: `The directory looks after the account ${u.username}, already on this computer (its password stays)` });
      else if (u.password) steps.push({ kind: 'password', user: u.username, ...password(u), words: `Sets a new first password for ${u.username}; they choose their own at their next sign-in` });
      if (u.fullName && u.fullName !== here.fullName) steps.push({ kind: 'rename', user: u.username, fullName: u.fullName, words: `${u.username}'s full name becomes ${u.fullName}` });
    }
    const isAdmin = !!here && local.admins.has(u.username);
    if (u.admin && !isAdmin) steps.push({ kind: 'admin', user: u.username, words: `${u.username} becomes an administrator` });
    if (!u.admin && isAdmin) {
      if (isMe) problems.push(`${u.username} keeps administrator rights here: it is the account applying the changes`);
      else steps.push({ kind: 'unadmin', user: u.username, words: `${u.username} is no longer an administrator` });
    }
    for (const g of u.groups) {
      if (!local.groups.has(g) && !made.has(g)) {
        made.add(g);
        steps.push({ kind: 'makeGroup', group: g, words: `Makes the group ${g}` });
      }
      if (!here || !local.groups.get(g)?.has(u.username)) steps.push({ kind: 'join', user: u.username, group: g, words: `${u.username} joins ${g}` });
    }
    if (here) for (const g of dirGroups) if (!u.groups.includes(g) && local.groups.get(g)?.has(u.username)) steps.push({ kind: 'leave', user: u.username, group: g, words: `${u.username} leaves ${g}` });
    if (!u.enabled && (!here || !disabled.has(u.username))) {
      if (isMe) problems.push(`${u.username} is not disabled here: it is the account applying the changes`);
      else steps.push({ kind: 'disable', user: u.username, words: `${u.username} is disabled (the account and its files stay)` });
    }
    if (u.enabled && here && disabled.has(u.username)) steps.push({ kind: 'enable', user: u.username, words: `${u.username} can sign in again` });
  }

  const wanted = new Set(policy.users.map((u) => u.username));
  for (const name of new Set(policy.retired)) {
    if (wanted.has(name) || !managed.has(name) || !local.users.has(name)) continue;
    if (name === self) {
      problems.push(`${name} left the directory, but it is the account applying the changes: it stays as it is`);
      continue;
    }
    if (!disabled.has(name)) steps.push({ kind: 'disable', user: name, words: `${name} left the directory: disabled (the account and its files stay)` });
    if (local.admins.has(name)) steps.push({ kind: 'unadmin', user: name, words: `${name} is no longer an administrator` });
  }

  if (!sameRules(memory.rules, policy.rules)) steps.push({ kind: 'rules', rules: policy.rules, accounts: [...wanted], words: `Password rules: ${directoryRulesWords(policy.rules).join('; ')}` });
  return { steps, passwords, problems };
}

/** A POSIX shell word: nothing inside is expanded. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const WIN_ADMINS = "'S-1-5-32-544'";

function winStep(s: PlannedStep): string {
  const u = s.user ? psq(s.user) : '';
  const pw = (line: number) => `(ConvertTo-SecureString $fbrxPw[${line}] -AsPlainText -Force)`;
  const net = (args: string) => `$o = (& net.exe ${args} 2>&1); if ($LASTEXITCODE) { throw ($o -join ' ') }`;
  switch (s.kind) {
    case 'create':
      return `New-LocalUser -Name ${u}${s.fullName ? ` -FullName ${psq(s.fullName)}` : ''} -Password ${pw(s.passwordLine!)} | Out-Null; ${net(`user ${u} /logonpasswordchg:yes`)}`;
    case 'password':
      return `Set-LocalUser -Name ${u} -Password ${pw(s.passwordLine!)}; ${net(`user ${u} /logonpasswordchg:yes`)}`;
    case 'adopt':
      return `Get-LocalUser -Name ${u} | Out-Null`;
    case 'rename':
      return `Set-LocalUser -Name ${u} -FullName ${psq(s.fullName ?? '')}`;
    case 'admin':
      return `Add-LocalGroupMember -SID ${WIN_ADMINS} -Member ${u}`;
    case 'unadmin':
      return `Remove-LocalGroupMember -SID ${WIN_ADMINS} -Member ${u}`;
    case 'makeGroup':
      return `if (-not (Get-LocalGroup -Name ${psq(s.group!)} -ErrorAction SilentlyContinue)) { New-LocalGroup -Name ${psq(s.group!)} -Description 'FBRX directory' | Out-Null }`;
    case 'join':
      return `Add-LocalGroupMember -Group ${psq(s.group!)} -Member ${u}`;
    case 'leave':
      return `Remove-LocalGroupMember -Group ${psq(s.group!)} -Member ${u}`;
    case 'disable':
      return `Disable-LocalUser -Name ${u}`;
    case 'enable':
      return `Enable-LocalUser -Name ${u}`;
    case 'rules': {
      const r = s.rules!;
      // net accounts sets at most 14 as the fewest characters; complexity is a security policy (secedit).
      return [
        net(`accounts /minpwlen:${Math.min(r.minLength, 14)} /maxpwage:${r.maxAgeDays ? r.maxAgeDays : 'UNLIMITED'}`),
        net(`accounts /lockoutthreshold:${r.lockoutAttempts}`),
        ...(r.lockoutAttempts ? [net(`accounts /lockoutwindow:${r.lockoutMinutes} /lockoutduration:${r.lockoutMinutes}`)] : []),
        `$f = Join-Path $env:TEMP ('fbrx-sec-' + [guid]::NewGuid().ToString('N') + '.inf'); secedit.exe /export /cfg $f /areas SECURITYPOLICY | Out-Null; ` +
          `(Get-Content -LiteralPath $f) -replace '^PasswordComplexity\\s*=.*', 'PasswordComplexity = ${r.complex ? 1 : 0}' | Set-Content -LiteralPath $f -Encoding Unicode; ` +
          `$o = (& secedit.exe /configure /db (Join-Path $env:windir 'security\\local.sdb') /cfg $f /areas SECURITYPOLICY 2>&1); $c = $LASTEXITCODE; Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue; if ($c) { throw ($o -join ' ') }`,
      ].join('; ');
    }
  }
}

/** The macOS account policies (pwpolicy -setaccountpolicies) for these rules. */
export function macPolicyPlist(r: DirectoryRules): string {
  const policy = (id: string, content: string, params: Record<string, number> = {}) =>
    `<dict><key>policyIdentifier</key><string>fbrx.${id}</string><key>policyContent</key><string>${content}</string>${
      Object.keys(params).length ? `<key>policyParameters</key><dict>${Object.entries(params).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join('')}</dict>` : ''
    }</dict>`;
  const content = [policy('minLength', `policyAttributePassword matches '.{${r.minLength},}'`)];
  if (r.complex) content.push(policy('upper', "policyAttributePassword matches '.*[A-Z].*'"), policy('lower', "policyAttributePassword matches '.*[a-z].*'"), policy('digit', "policyAttributePassword matches '.*[0-9].*'"));
  const change = r.maxAgeDays ? [policy('maxAge', 'policyAttributeCurrentTime &gt; policyAttributeLastPasswordChangeTime + (policyAttributeExpiresEveryNDays * 24 * 60 * 60)', { policyAttributeExpiresEveryNDays: r.maxAgeDays })] : [];
  const auth = r.lockoutAttempts
    ? [policy('lockout', '(policyAttributeFailedAuthentications &lt; policyAttributeMaximumFailedAuthentications) OR (policyAttributeCurrentTime &gt; (policyAttributeLastFailedAuthenticationTime + autoEnableInSeconds))', { policyAttributeMaximumFailedAuthentications: r.lockoutAttempts, autoEnableInSeconds: r.lockoutMinutes * 60 })]
    : [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>policyCategoryPasswordContent</key><array>${content.join('')}</array>`,
    `<key>policyCategoryPasswordChange</key><array>${change.join('')}</array>`,
    `<key>policyCategoryAuthentication</key><array>${auth.join('')}</array>`,
    '</dict></plist>',
  ].join('\n');
}

function macStep(s: PlannedStep): string {
  const u = s.user ? shq(s.user) : '';
  const line = (n: number) => `p=$(sed -n '${n + 1}p' "$FBRX_PW")`;
  switch (s.kind) {
    case 'create':
      // sysadminctl can answer 0 without making the account: id checks it. The first password is in its arguments
      // for the moment it runs (macOS has no other way to give it); the person replaces it at their first sign-in.
      return `${line(s.passwordLine!)} && sysadminctl -addUser ${u}${s.fullName ? ` -fullName ${shq(s.fullName)}` : ''} -password "$p" && id -u ${u} >/dev/null && pwpolicy -u ${u} -setpolicy newPasswordRequired=1`;
    case 'password':
      return `${line(s.passwordLine!)} && dscl . -passwd ${shq(`/Users/${s.user}`)} "$p" && pwpolicy -u ${u} -setpolicy newPasswordRequired=1`;
    case 'adopt':
      return `id -u ${u} >/dev/null`;
    case 'rename':
      return `dscl . -create ${shq(`/Users/${s.user}`)} RealName ${shq(s.fullName ?? '')}`;
    case 'admin':
      return `dseditgroup -o edit -a ${u} -t user admin`;
    case 'unadmin':
      return `dseditgroup -o edit -d ${u} -t user admin`;
    case 'makeGroup':
      return `dseditgroup -o read ${shq(s.group!)} >/dev/null 2>&1 || dseditgroup -o create -r ${shq(s.group!)} ${shq(s.group!)}`;
    case 'join':
      return `dseditgroup -o edit -a ${u} -t user ${shq(s.group!)}`;
    case 'leave':
      return `dseditgroup -o edit -d ${u} -t user ${shq(s.group!)}`;
    case 'disable':
      return `pwpolicy -u ${u} -disableuser`;
    case 'enable':
      return `pwpolicy -u ${u} -enableuser`;
    case 'rules':
      return `f=$(mktemp) && printf '%s\\n' ${shq(macPolicyPlist(s.rules!))} > "$f" && { pwpolicy -setaccountpolicies "$f"; c=$?; rm -f "$f"; [ "$c" -eq 0 ]; }`;
  }
}

function linuxStep(s: PlannedStep, adminGroup: string, passwords: string[]): string {
  const u = s.user ? shq(s.user) : '';
  const setPw = (n: number) => `printf '%s:%s\\n' ${u} ${shq(passwords[n] ?? '')} | chpasswd && chage -d 0 ${u}`;
  switch (s.kind) {
    case 'create':
      return `useradd -m -c ${shq(s.fullName ?? '')} -s "$(command -v bash || echo /bin/sh)" ${u} && ${setPw(s.passwordLine!)}`;
    case 'password':
      return setPw(s.passwordLine!);
    case 'adopt':
      return `id -u ${u} >/dev/null`;
    case 'rename':
      return `usermod -c ${shq(s.fullName ?? '')} ${u}`;
    case 'admin':
      return `gpasswd -a ${u} ${shq(adminGroup)} >/dev/null`;
    case 'unadmin':
      return `gpasswd -d ${u} ${shq(adminGroup)} >/dev/null`;
    case 'makeGroup':
      return `getent group ${shq(s.group!)} >/dev/null || groupadd ${shq(s.group!)}`;
    case 'join':
      return `gpasswd -a ${u} ${shq(s.group!)} >/dev/null`;
    case 'leave':
      return `gpasswd -d ${u} ${shq(s.group!)} >/dev/null`;
    case 'disable':
      // Locked, and expired so keys and other sign-ins stop too.
      return `usermod -L -e 1 ${u}`;
    case 'enable':
      return `usermod -U -e '' ${u}`;
    case 'rules': {
      const r = s.rules!;
      const ages = (s.accounts ?? []).map((a) => `if id -u ${shq(a)} >/dev/null 2>&1; then chage -M ${r.maxAgeDays || 99999} ${shq(a)}; fi`);
      // pwquality (where PAM uses it) for length and kinds of characters; faillock (where PAM uses it) for lockouts.
      return [
        `mkdir -p /etc/security/pwquality.conf.d && printf 'minlen = ${r.minLength}\\nminclass = ${r.complex ? 3 : 0}\\n' > /etc/security/pwquality.conf.d/fbrx.conf`,
        `if [ -f /etc/security/faillock.conf ]; then sed -i -E '/^[[:space:]]*(deny|unlock_time)[[:space:]]*=/d' /etc/security/faillock.conf${r.lockoutAttempts ? ` && printf 'deny = ${r.lockoutAttempts}\\nunlock_time = ${r.lockoutMinutes * 60}\\n' >> /etc/security/faillock.conf` : ''}; fi`,
        ...ages,
      ].join(' && ');
    }
  }
}

/**
 * The script for this computer's administrator prompt. Each step reports "FBRX-STEP <n> ok" or "FBRX-STEP <n> failed
 * <why>" and the rest still run. Nothing secret goes in a program's arguments where FBRX can help it: on Windows the
 * script (first passwords included) is a file the elevated job checks against its SHA-256 before running; on Linux
 * it goes to the shell on standard input; on macOS the first passwords are in a file that root copies and checks
 * against its SHA-256 before reading.
 */
export function directoryScript(os: DirectoryOs, plan: Pick<DirectoryPlan, 'steps' | 'passwords'>, o: { adminGroup?: string; passwordsFile?: string; passwordsHash?: string } = {}): string {
  const { steps, passwords } = plan;
  if (os === 'windows') {
    return [
      "$ErrorActionPreference = 'Stop'",
      `$fbrxPw = @(${passwords.map(psq).join(', ')})`,
      ...steps.map((s, i) => `try { ${winStep(s)}; 'FBRX-STEP ${i} ok' } catch { 'FBRX-STEP ${i} failed ' + ($_.Exception.Message -replace '\\s+', ' ') }`),
    ].join('\n');
  }
  const body = steps.map((s, i) => {
    const cmd = os === 'mac' ? macStep(s) : linuxStep(s, o.adminGroup ?? 'sudo', passwords);
    return `if out=$( { ${cmd}\n} 2>&1 </dev/null ); then echo 'FBRX-STEP ${i} ok'; else echo "FBRX-STEP ${i} failed $(printf '%s' "$out" | tr '\\n' ' ' | cut -c1-300)"; fi`;
  });
  const head = ['PATH=/usr/sbin:/usr/bin:/sbin:/bin:$PATH'];
  const tail = ['true'];
  if (os === 'mac' && passwords.length) {
    if (!o.passwordsFile || !o.passwordsHash) throw new Error('The first passwords file is missing');
    head.push(
      `FBRX_PW=$(mktemp) && cat ${shq(o.passwordsFile)} > "$FBRX_PW" && [ "$(shasum -a 256 "$FBRX_PW" | cut -d' ' -f1)" = ${shq(o.passwordsHash)} ] || { echo 'FBRX-ABORT The first passwords changed while the administrator prompt was open'; rm -f "$FBRX_PW"; exit 0; }`,
    );
    tail.unshift('rm -f "$FBRX_PW"');
  }
  return [...head, ...body, ...tail].join('\n');
}

/** Windows: the elevated job runs the script file only if it is still exactly the script FBRX wrote. */
export function windowsRunner(scriptFile: string, sha256: string): string {
  return [
    `$b = [IO.File]::ReadAllBytes(${psq(scriptFile)})`,
    "$h = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') })",
    `if ($h -ne ${psq(sha256)}) { 'FBRX-ABORT The script changed while the administrator prompt was open'; return }`,
    '& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b)))',
  ].join('\n');
}

/** Each step's outcome from the script's output (a step with no line did not run). */
export function stepResults(output: string, count: number): Array<{ ok: boolean; why: string | null }> {
  const out: Array<{ ok: boolean; why: string | null }> = Array.from({ length: count }, () => ({ ok: false, why: 'Did not run' }));
  for (const line of output.split(/\r\n|\r|\n/)) {
    const m = /^FBRX-STEP (\d+) (ok|failed)(?: (.*))?$/.exec(line.trim());
    if (!m) continue;
    const i = Number(m[1]);
    if (i < count) out[i] = m[2] === 'ok' ? { ok: true, why: null } : { ok: false, why: (m[3] ?? '').trim().slice(0, 300) || 'Failed' };
  }
  return out;
}

/** Linux: /etc/passwd and /etc/group as the directory needs them (no administrator rights needed to read them). */
export function linuxAccounts(passwd: string, group: string, wantedGroups: string[]): LocalAccounts {
  const users = new Map<string, { fullName: string }>();
  for (const line of passwd.split('\n')) {
    const f = line.split(':');
    if (f.length >= 7 && f[0]) users.set(f[0].toLowerCase(), { fullName: (f[4] ?? '').split(',')[0] });
  }
  const groups = new Map<string, Set<string>>();
  const all = new Map<string, Set<string>>();
  for (const line of group.split('\n')) {
    const f = line.split(':');
    if (f.length < 4 || !f[0]) continue;
    all.set(f[0], new Set(f[3].split(',').map((m) => m.trim().toLowerCase()).filter(Boolean)));
  }
  const adminGroup = ['sudo', 'wheel', 'admin'].find((g) => all.has(g)) ?? 'sudo';
  for (const g of wantedGroups) if (all.has(g)) groups.set(g, all.get(g)!);
  return { users, admins: all.get(adminGroup) ?? new Set(), groups, adminGroup };
}

export function readLinuxAccounts(wantedGroups: string[]): LocalAccounts {
  return linuxAccounts(readFileSync('/etc/passwd', 'utf8'), readFileSync('/etc/group', 'utf8'), wantedGroups);
}

type Run = (cmd: string, args: string[]) => Promise<{ code: number | null; out: string; err: string }>;

/** macOS: the accounts, admin members and wanted groups from the local directory (dscl). */
export async function readMacAccounts(run: Run, wantedGroups: string[]): Promise<LocalAccounts> {
  const users = new Map<string, { fullName: string }>();
  const names = await run('dscl', ['.', '-list', '/Users']);
  for (const n of names.out.split('\n').map((x) => x.trim()).filter(Boolean)) users.set(n.toLowerCase(), { fullName: '' });
  const real = await run('dscl', ['.', '-list', '/Users', 'RealName']);
  for (const line of real.out.split('\n')) {
    const m = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (m && users.has(m[1].toLowerCase())) users.set(m[1].toLowerCase(), { fullName: m[2].trim() });
  }
  const members = async (g: string): Promise<Set<string> | null> => {
    const r = await run('dscl', ['.', '-read', `/Groups/${g}`, 'GroupMembership']);
    if (r.code !== 0) return /GroupMembership/.test(r.out) ? new Set() : null;
    return new Set(r.out.replace(/^GroupMembership:/, '').split(/\s+/).map((x) => x.trim().toLowerCase()).filter(Boolean));
  };
  const groups = new Map<string, Set<string>>();
  for (const g of wantedGroups) {
    const m = await members(g);
    if (m) groups.set(g, m);
  }
  return { users, admins: (await members('admin')) ?? new Set(), groups, adminGroup: 'admin' };
}

/**
 * Windows: local accounts, the administrators group (by its SID, whatever its name in this language) and the groups
 * the directory uses.
 */
export const WINDOWS_ACCOUNTS_SCRIPT = (wantedGroups: string[]) => `
$users = @(Get-LocalUser | ForEach-Object { @{ name = $_.Name; fullName = [string]$_.FullName } })
function Members($g) { try { @(([ADSI]"WinNT://./$g,group").psbase.Invoke('Members') | ForEach-Object { $_.GetType().InvokeMember('Name', 'GetProperty', $null, $_, $null) }) } catch { $null } }
$adminName = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544').Translate([Security.Principal.NTAccount]).Value.Split('\\')[-1]
$groups = @{}
foreach ($g in @(${wantedGroups.map(psq).join(', ')})) { if (Get-LocalGroup -Name $g -ErrorAction SilentlyContinue) { $groups[$g] = @(Members $g) } }
@{ users = $users; admins = @(Members $adminName); groups = $groups } | ConvertTo-Json -Depth 4 -Compress`;

export function windowsAccounts(json: { users?: Array<{ name: string; fullName: string }>; admins?: string[] | null; groups?: Record<string, string[] | null> }): LocalAccounts {
  const lower = (xs: string[] | null | undefined) => new Set((xs ?? []).filter(Boolean).map((x) => String(x).toLowerCase()));
  return {
    users: new Map((json.users ?? []).map((u) => [u.name.toLowerCase(), { fullName: u.fullName ?? '' }])),
    admins: lower(json.admins),
    groups: new Map(Object.entries(json.groups ?? {}).map(([g, m]) => [g.toLowerCase(), lower(m)])),
    adminGroup: 'Administrators',
  };
}

/** Runs a program with text on its standard input (never in its arguments). */
export function runWithInput(cmd: string, args: string[], input: string, timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, out: '', err: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => (err += e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

/** The first passwords file for macOS (one per line, readable by this account only) and its SHA-256. */
export function writePasswordsFile(dir: string, passwords: string[]): { file: string; sha256: string } {
  const file = join(dir, 'first-passwords');
  const text = passwords.map((p) => `${p}\n`).join('');
  writeFileSync(file, text, { mode: 0o600 });
  return { file, sha256: createHash('sha256').update(text).digest('hex') };
}

/** The accounts on this computer, as the directory sees them. */
export async function readAccountsHere(os: DirectoryOs, groups: string[]): Promise<LocalAccounts> {
  if (os === 'linux') return readLinuxAccounts(groups);
  if (os === 'mac') return readMacAccounts(exec, groups);
  return windowsAccounts(await psObject(WINDOWS_ACCOUNTS_SCRIPT(groups), 60_000, 'Could not read the accounts on this computer'));
}

const RUN_FOR_MS = 15 * 60_000;
const appleString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/** Runs the plan through this system's administrator prompt (or straight away when FBRX runs as root). */
export async function runHere(os: DirectoryOs, plan: Pick<DirectoryPlan, 'steps' | 'passwords'>, local: LocalAccounts, workDir: string): Promise<{ output: string; cancelled: boolean }> {
  if (os === 'windows') {
    const script = directoryScript('windows', plan);
    const file = join(workDir, 'directory.ps1');
    writeFileSync(file, script, { encoding: 'utf8', mode: 0o600 });
    try {
      const r = await elevated(windowsRunner(file, createHash('sha256').update(script, 'utf8').digest('hex')), { timeoutMs: RUN_FOR_MS, workDir });
      return { output: r.output, cancelled: false };
    } catch (e) {
      if (e instanceof CoreError && e.code === 'CANCELLED') return { output: '', cancelled: true };
      throw e;
    }
  }
  const root = process.getuid?.() === 0;
  if (os === 'linux') {
    const script = directoryScript('linux', plan, { adminGroup: local.adminGroup });
    const r = root ? await runWithInput('/bin/sh', ['-s'], script, RUN_FOR_MS) : await runWithInput('pkexec', ['/bin/sh', '-s'], script, RUN_FOR_MS);
    if (/ENOENT/.test(r.err) && !r.out) throw new CoreError('UNAVAILABLE', 'Applying needs the system’s administrator prompt (pkexec, from polkit), which is not installed');
    if (!root && /no authentication agent/i.test(r.err)) throw new CoreError('UNAVAILABLE', 'There is no administrator prompt in this session (no polkit agent is running): apply from the desktop');
    // pkexec: 126 when the prompt was closed, 127 when the password was not accepted.
    if (!root && (r.code === 126 || r.code === 127) && !/FBRX-STEP/.test(r.out)) return { output: r.out, cancelled: true };
    return { output: r.out, cancelled: false };
  }
  const pw = plan.passwords.length ? writePasswordsFile(workDir, plan.passwords) : null;
  const script = directoryScript('mac', plan, { passwordsFile: pw?.file, passwordsHash: pw?.sha256 });
  if (root) return { output: (await runWithInput('/bin/sh', ['-s'], script, RUN_FOR_MS)).out, cancelled: false };
  // osascript reads the AppleScript from its standard input.
  const r = await runWithInput('osascript', [], `do shell script ${appleString(script)} with administrator privileges without altering line endings`, RUN_FOR_MS);
  if (/-128|User cancel/i.test(r.err)) return { output: '', cancelled: true };
  if (r.code !== 0 && !r.out.trim()) throw new CoreError('INTERNAL', r.err.trim().slice(0, 300) || 'The administrator prompt did not run');
  return { output: r.out, cancelled: false };
}

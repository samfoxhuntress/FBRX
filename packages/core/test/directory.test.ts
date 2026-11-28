import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_DIRECTORY_RULES, type DirectoryPolicy, type SavedServer } from '@fbrx/shared';
import { directoryScript, EMPTY_MEMORY, linuxAccounts, macPolicyPlist, planDirectory, stepResults, windowsAccounts, windowsRunner, type LocalAccounts } from '../src/system/directory-apply';
import { checkPolicy, DirectoryClient, type DirectoryClientDeps } from '../src/system/directory-client';
import { CoreError } from '../src/errors';

const work = mkdtempSync(join(tmpdir(), 'fbrx-dirtest-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const policy = (p: Partial<DirectoryPolicy> = {}): DirectoryPolicy => ({
  directory: 'Fox Lab',
  version: 3,
  rules: DEFAULT_DIRECTORY_RULES,
  groups: ['accounting'],
  retired: [],
  users: [
    { username: 'jane', fullName: 'Jane Doe', enabled: true, admin: true, groups: ['accounting'], password: { version: 1, value: "It's-Jane 123" } },
    { username: 'sam', fullName: 'Sam', enabled: true, admin: false, groups: [] },
  ],
  ...p,
});

const local = (p: Partial<LocalAccounts> = {}): LocalAccounts => ({
  users: new Map([
    ['sam', { fullName: 'Sam' }],
    ['olly', { fullName: 'Olly' }],
  ]),
  admins: new Set(['sam', 'olly']),
  groups: new Map(),
  adminGroup: 'sudo',
  ...p,
});

describe('planning the directory on this computer', () => {
  it('makes new accounts with their first password, takes over existing ones and never demotes the account applying', () => {
    const plan = planDirectory(policy(), local(), EMPTY_MEMORY, 'sam');
    const kinds = plan.steps.map((s) => `${s.kind}:${s.user ?? s.group ?? ''}`);
    expect(kinds).toEqual(['create:jane', 'admin:jane', 'makeGroup:accounting', 'join:jane', 'adopt:sam', 'rules:']);
    expect(plan.passwords).toEqual(["It's-Jane 123"]);
    expect(plan.steps[0]).toMatchObject({ passwordLine: 0, passwordVersion: 1, fullName: 'Jane Doe' });
    // sam is not an administrator in the directory, but it is the account applying the changes.
    expect(plan.problems.join(' ')).toMatch(/sam keeps administrator rights here/);
    expect(plan.steps.some((s) => s.kind === 'unadmin')).toBe(false);
  });

  it('disables (never deletes) accounts that left, only the directory\'s own, and repeats nothing already done', () => {
    const memory = { users: ['jane', 'olly'], groups: ['accounting'], disabled: [], rules: DEFAULT_DIRECTORY_RULES };
    const here = local({ users: new Map([['jane', { fullName: 'Jane Doe' }], ['olly', { fullName: 'Olly' }], ['bob', { fullName: '' }]]), admins: new Set(['jane', 'olly', 'bob']), groups: new Map([['accounting', new Set(['jane'])]]) });
    const p = policy({ users: [{ username: 'jane', fullName: 'Jane Doe', enabled: true, admin: true, groups: ['accounting'] }], retired: ['olly', 'bob'] });
    const plan = planDirectory(p, here, memory, 'sam');
    // bob was never the directory's: left alone. Nothing for jane: she is as the directory says.
    expect(plan.steps.map((s) => `${s.kind}:${s.user}`)).toEqual(['disable:olly', 'unadmin:olly']);
    expect(plan.passwords).toEqual([]);
  });

  it('says when an account is gone and its first password was already used here', () => {
    const p = policy({ users: [{ username: 'kim', fullName: '', enabled: true, admin: false, groups: [] }] });
    const plan = planDirectory(p, local(), { ...EMPTY_MEMORY, rules: DEFAULT_DIRECTORY_RULES }, 'sam');
    expect(plan.steps).toEqual([]);
    expect(plan.problems[0]).toMatch(/kim is not on this computer/);
  });

  it('leaves groups the directory no longer puts people in, and never disables the account applying', () => {
    const memory = { users: ['sam'], groups: ['accounting'], disabled: [], rules: DEFAULT_DIRECTORY_RULES };
    const here = local({ groups: new Map([['accounting', new Set(['sam'])]]) });
    const plan = planDirectory(policy({ users: [{ username: 'sam', fullName: 'Sam', enabled: false, admin: true, groups: [] }] }), here, memory, 'SAM');
    expect(plan.steps.map((s) => `${s.kind}:${s.user}:${s.group ?? ''}`)).toEqual(['leave:sam:accounting']);
    expect(plan.problems.join(' ')).toMatch(/not disabled here/);
  });
});

describe('what the server sends is checked here too', () => {
  it('leaves out names no system should get and passwords that cannot be used', () => {
    const raw = policy({
      groups: ['accounting', 'sudo', 'x; rm -rf /'],
      users: [
        { username: 'jane', fullName: 'Jane', enabled: true, admin: true, groups: ['accounting', 'sudo'] },
        { username: 'root', fullName: '', enabled: true, admin: true, groups: [] },
        { username: 'x$(reboot)', fullName: '', enabled: true, admin: false, groups: [] },
        { username: 'kim', fullName: 'Kim\nroot', enabled: true, admin: false, groups: [] },
        { username: 'lee', fullName: '', enabled: true, admin: false, groups: [], password: { version: 1, value: 'a\nroot:x' } },
      ],
      retired: ['olly', '../etc'],
    });
    const { policy: p, dropped } = checkPolicy(raw);
    expect(p.groups).toEqual(['accounting']);
    expect(p.users.map((u) => u.username)).toEqual(['jane']);
    expect(p.users[0].groups).toEqual(['accounting']);
    expect(p.retired).toEqual(['olly']);
    expect(dropped).toHaveLength(6);
  });
});

describe('the administrator scripts', () => {
  const plan = planDirectory(policy(), local(), EMPTY_MEMORY, 'sam');

  it('Windows: names quoted, the administrators group by its SID, the shortest password at most 14', () => {
    const script = directoryScript('windows', { ...plan, steps: plan.steps.map((s) => (s.kind === 'rules' ? { ...s, rules: { ...DEFAULT_DIRECTORY_RULES, minLength: 20 } } : s)) });
    expect(script).toContain("$fbrxPw = @('It''s-Jane 123')");
    expect(script).toContain("New-LocalUser -Name 'jane' -FullName 'Jane Doe' -Password (ConvertTo-SecureString $fbrxPw[0]");
    expect(script).toContain("net.exe user 'jane' /logonpasswordchg:yes");
    expect(script).toContain("Add-LocalGroupMember -SID 'S-1-5-32-544' -Member 'jane'");
    expect(script).toContain('/minpwlen:14');
    expect(script).toContain("'FBRX-STEP 5 ok'");
    // The elevated job runs the file only when it is exactly the one written.
    expect(windowsRunner('C:\\Temp\\d.ps1', 'ab12')).toMatch(/if \(\$h -ne 'ab12'\) \{ 'FBRX-ABORT/);
  });

  it('macOS and Linux scripts are valid shell, and macOS checks the first passwords file before reading it', () => {
    const mac = directoryScript('mac', plan, { passwordsFile: join(work, 'pw'), passwordsHash: 'ab'.repeat(32) });
    const linux = directoryScript('linux', plan, { adminGroup: 'wheel' });
    for (const s of [mac, linux]) expect(spawnSync('sh', ['-n'], { input: s }).status).toBe(0);
    expect(mac).toMatch(/shasum -a 256 "\$FBRX_PW"/);
    expect(mac).toContain("sysadminctl -addUser 'jane' -fullName 'Jane Doe' -password \"$p\"");
    expect(linux).toContain("gpasswd -a 'jane' 'wheel'");
    expect(linux).not.toContain('FBRX_PW');
    expect(() => directoryScript('mac', plan)).toThrow(/passwords file/);
  });

  it('the macOS account policies are a well-formed property list', () => {
    const xml = macPolicyPlist({ minLength: 12, complex: true, maxAgeDays: 90, lockoutAttempts: 5, lockoutMinutes: 10 });
    expect(xml).toContain("policyAttributePassword matches '.{12,}'");
    expect(xml).toContain('<integer>600</integer>');
    expect(xml).not.toMatch(/<string>[^<]*[<>][^<]*<\/string>/);
    if (spawnSync('xmllint', ['--version']).status === 0) expect(spawnSync('xmllint', ['--noout', '-'], { input: xml }).status).toBe(0);
  });

  // It runs the script with /bin/sh and stub commands, so not on Windows.
  it.skipIf(process.platform === 'win32')('Linux: runs each step, hands passwords to chpasswd on its input and reports each step', () => {
    // Stand-ins for the account commands record what they were asked; nothing on this computer changes.
    const bin = mkdtempSync(join(work, 'bin-'));
    const log = join(work, 'calls.log');
    writeFileSync(log, '');
    const stub = (name: string, body = '') => {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(log)}\n${body}\nexit 0\n`);
      chmodSync(join(bin, name), 0o755);
    };
    for (const c of ['useradd', 'usermod', 'chage', 'groupadd', 'id']) stub(c);
    stub('chpasswd', `printf 'stdin %s\\n' "$(cat)" >> ${JSON.stringify(log)}`);
    stub('getent', 'exit 2');
    stub('gpasswd', `case "$*" in *broken*) echo "gpasswd: group broken does not exist" >&2; exit 3;; esac`);
    for (const t of ['tr', 'cut', 'cat']) symlinkSync(execFileSync('sh', ['-c', `command -v ${t}`]).toString().trim(), join(bin, t));
    const p = policy({ groups: ['accounting', 'broken'] });
    p.users[0].groups = ['accounting', 'broken'];
    const steps = planDirectory(p, local(), { ...EMPTY_MEMORY, rules: DEFAULT_DIRECTORY_RULES }, 'sam');
    const script = directoryScript('linux', steps).replace(/^PATH=.*$/m, `PATH=${bin}`);
    const r = spawnSync('/bin/sh', ['-s'], { input: script, env: { PATH: bin } });
    const results = stepResults(r.stdout.toString(), steps.steps.length);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain("useradd -m -c Jane Doe -s /bin/sh jane");
    expect(calls).toContain("stdin jane:It's-Jane 123");
    expect(calls).toContain('chage -d 0 jane');
    expect(calls).toContain('groupadd accounting');
    expect(steps.steps.map((s, i) => `${s.kind}:${s.group ?? s.user}:${results[i].ok}`)).toEqual(['create:jane:true', 'admin:jane:true', 'makeGroup:accounting:true', 'join:accounting:true', 'makeGroup:broken:true', 'join:broken:false', 'adopt:sam:true']);
    expect(results[5].why).toMatch(/group broken does not exist/);
  });

  it('reads each step\'s outcome, whatever the line endings, and a missing line as not run', () => {
    expect(stepResults('FBRX-STEP 0 ok\rFBRX-STEP 1 failed Access is denied.\r\n', 3)).toEqual([{ ok: true, why: null }, { ok: false, why: 'Access is denied.' }, { ok: false, why: 'Did not run' }]);
  });
});

describe('reading the accounts on this computer', () => {
  it('Linux: /etc/passwd and /etc/group, with whichever administrators group the system has', () => {
    const a = linuxAccounts('root:x:0:0:root:/root:/bin/bash\njane:x:1000:1000:Jane Doe,,,:/home/jane:/bin/bash\n', 'root:x:0:\nwheel:x:10:jane,Sam\naccounting:x:1001:\n', ['accounting', 'missing']);
    expect(a.adminGroup).toBe('wheel');
    expect([...a.admins]).toEqual(['jane', 'sam']);
    expect(a.users.get('jane')).toEqual({ fullName: 'Jane Doe' });
    expect([...a.groups.keys()]).toEqual(['accounting']);
  });

  it('Windows: names in any case, and members PowerShell could not read', () => {
    const a = windowsAccounts({ users: [{ name: 'Jane', fullName: 'Jane Doe' }], admins: ['Administrator', null as unknown as string], groups: { Accounting: null } });
    expect(a.users.has('jane')).toBe(true);
    expect([...a.admins]).toEqual(['administrator']);
    expect(a.groups.get('accounting')?.size).toBe(0);
  });
});

describe('this computer in a directory', () => {
  function setup(over: Partial<DirectoryClientDeps> = {}) {
    const meta = new Map<string, unknown>();
    const vault = new Map<string, string>();
    const calls: Array<{ method: string; path: string; token: string | null; body?: unknown }> = [];
    const notes: string[] = [];
    let current = policy();
    const deps: DirectoryClientDeps = {
      meta: { get: (k: string) => meta.get(k) ?? null, set: (k: string, v: unknown) => void meta.set(k, structuredClone(v)), delete: (k: string) => void meta.delete(k) } as never,
      vault: { isUnlocked: true, get: (n: string) => vault.get(n), set: (e: { name: string; value: string }) => void vault.set(e.name, e.value), delete: (n: string) => void vault.delete(n) } as never,
      servers: {
        get: () => ({ id: 'srv_1', name: 'Lab server', host: '10.0.0.2' }) as SavedServer,
        call: (async (_id: string, method: string, path: string, token: string | null, body?: unknown) => {
          calls.push({ method, path, token, body });
          if (path === '/v1/directory/join') return (body as { code: string }).code === 'ABCDE-FGHJK' ? { computerId: 'dc_1', token: 'dc_1.secret', directory: 'Fox Lab' } : Promise.reject(new CoreError('UNAUTHENTICATED', 'nope'));
          if (path === '/v1/directory/policy') return structuredClone(current);
          return { ok: true };
        }) as never,
      },
      audit: () => undefined,
      os: 'linux',
      me: () => 'sam',
      computerName: () => 'Front desk',
      readAccounts: async () => local(),
      run: async (plan) => ({ output: plan.steps.map((_, i) => `FBRX-STEP ${i} ok`).join('\n'), cancelled: false }),
      tmpDir: work,
      notify: (title) => void notes.push(title),
      ...over,
    };
    return { client: new DirectoryClient(deps), calls, notes, vault, setPolicy: (p: DirectoryPolicy) => (current = p) };
  }

  it('joins with a code, says once that changes wait, applies them and tells the server which first passwords it set', async () => {
    const { client, calls, notes, vault } = setup();
    await expect(client.join('srv_1', 'WRONG-CODE0')).rejects.toThrow(/join code is not right/);
    const joined = await client.join('srv_1', 'ABCDE-FGHJK');
    expect(vault.get('fbrx.directory.token')).toBe('dc_1.secret');
    expect(joined).toMatchObject({ joined: true, directory: 'Fox Lab', serverName: 'Lab server' });
    expect(joined.plan.map((s) => s.kind)).toEqual(['create', 'admin', 'makeGroup', 'join', 'adopt', 'rules']);
    await client.sync();
    expect(notes).toEqual(['Fox Lab: 6 changes for this computer']);
    // The token is the computer's own, never in what the page sees.
    expect(JSON.stringify(client.status())).not.toContain('secret');
    expect(JSON.stringify(client.status())).not.toContain("It's-Jane");

    const done = await client.apply();
    const report = calls.find((c) => c.path === '/v1/directory/report')!;
    expect(report.token).toBe('dc_1.secret');
    expect(report.body).toEqual({ version: 3, ok: true, problems: ['sam keeps administrator rights here: it is the account applying the changes'], passwords: { jane: 1 } });
    expect(done).toMatchObject({ appliedVersion: 3, plan: [] });
  });

  it('changes nothing when the prompt is closed or the script was changed, and leaves cleanly', async () => {
    let output = '';
    const { client, calls, vault } = setup({ run: async () => ({ output, cancelled: !output }) });
    await client.join('srv_1', 'ABCDE-FGHJK');
    await expect(client.apply()).rejects.toThrow(/administrator prompt was closed/);
    output = 'FBRX-ABORT The script changed while the administrator prompt was open';
    await expect(client.apply()).rejects.toThrow(/script changed/);
    expect(calls.some((c) => c.path === '/v1/directory/report')).toBe(false);
    await client.leave();
    expect(vault.has('fbrx.directory.token')).toBe(false);
    expect(client.status().joined).toBe(false);
  });

  it('a step that fails is reported, and shows again as waiting', async () => {
    const { client, calls } = setup({ run: async (plan) => ({ output: plan.steps.map((_, i) => (i === 1 ? `FBRX-STEP ${i} failed Access is denied` : `FBRX-STEP ${i} ok`)).join('\n'), cancelled: false }) });
    await client.join('srv_1', 'ABCDE-FGHJK');
    await client.apply();
    const report = calls.find((c) => c.path === '/v1/directory/report')!.body as { ok: boolean; problems: string[] };
    expect(report.ok).toBe(false);
    expect(report.problems).toContain('jane becomes an administrator: Access is denied');
  });
});

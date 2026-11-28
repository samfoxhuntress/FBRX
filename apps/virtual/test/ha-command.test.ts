import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Db } from '@fbrx/shared/node';
import { CP_MIGRATIONS } from '../../control-plane/src/migrations';
import { CommandHa, type RunCommand } from '../src/ha/command';
import { HaCopy, type CopySource } from '../src/ha/copy';

// FBRX Command in a high-availability pair: its database copied to the standby, with the tables an update brings, and
// Command running on the active server only.
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A server with the command role: Command's settings, and its database as Command makes it. */
function server(name: string, run: RunCommand = async () => ({ code: 3, out: '' })) {
  const dir = mkdtempSync(join(tmpdir(), `fbrx-ha-command-${name}-`));
  dirs.push(dir);
  const data = join(dir, 'var');
  mkdirSync(data);
  const envFile = join(dir, 'fbrx-command.env');
  writeFileSync(envFile, `FBRX_CP_DATA_DIR=${data}\nFBRX_CP_PUBLIC_URL=https://192.168.50.1:8443\n`);
  const made = new Db(join(data, 'control-plane.db'));
  made.migrate(CP_MIGRATIONS);
  made.close();
  return new CommandHa({ envFile, secretsFile: join(dir, 'secrets.env'), run });
}

/** What the pair does over HTTPS, here in one go: batches, their answers, and full copies when due. */
function pump(active: HaCopy, standby: HaCopy) {
  for (let i = 0; i < 4; i++) {
    active.acked(standby.receive(active.outgoing(true)));
    for (const parts of active.snapshots()) active.acked(standby.receive(parts));
  }
}

describe('FBRX Command in a pair', () => {
  it('copies all of Command’s tables but the third vote’s leases, and everything again when an update changes them', () => {
    const a = server('a').source()!;
    const b = server('b').source()!;
    a.db.run("INSERT INTO meta (key, value) VALUES ('org', 'Fox Lab')");
    a.db.run("INSERT INTO ha_witness_leases (id, holder, term, lease_ms) VALUES ('k1', 'node-a', 1, 1000)");
    const A = new HaCopy([a], () => undefined);
    const B = new HaCopy([b], () => undefined);
    A.becomeActive();
    B.becomeStandby();
    pump(A, B);
    expect(b.db.get('SELECT value FROM meta WHERE key = ?', 'org')).toEqual({ value: 'Fox Lab' });
    expect(b.db.all('SELECT * FROM ha_witness_leases')).toEqual([]);
    expect(A.caughtUp()).toBe(true);
    // A change goes as it is made.
    a.db.run("UPDATE meta SET value = 'Fox Labs' WHERE key = 'org'");
    pump(A, B);
    expect(b.db.get('SELECT value FROM meta WHERE key = ?', 'org')).toEqual({ value: 'Fox Labs' });
    // An update brings a table (on both: the standby's tables are brought to its version too). The active server
    // notices within seconds, makes its triggers again, and the standby gets everything.
    for (const s of [a, b]) s.db.exec('CREATE TABLE ha_test_extra (id TEXT PRIMARY KEY, note TEXT)');
    a.db.run("INSERT INTO ha_test_extra (id, note) VALUES ('x1', 'new in this version')");
    const now = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now + 6000);
    try {
      pump(A, B);
      a.db.run("INSERT INTO ha_test_extra (id, note) VALUES ('x2', 'and copied as it changes')");
      pump(A, B);
    } finally {
      clock.mockRestore();
    }
    expect(b.db.all('SELECT id FROM ha_test_extra ORDER BY id')).toEqual([{ id: 'x1' }, { id: 'x2' }]);
  });

  it('leaves out a role the standby does not have, and does not wait for it', () => {
    const a = server('only-a').source()!;
    const other: CopySource = { ...server('other').source()!, name: 'other', label: 'Other' };
    const A = new HaCopy([a], () => undefined);
    const B = new HaCopy([other], () => undefined);
    A.becomeActive();
    B.becomeStandby();
    pump(A, B);
    expect(A.views()).toEqual([expect.objectContaining({ name: 'command', state: 'absent' })]);
    expect(A.caughtUp()).toBe(true);
    // Nothing piles up for it.
    a.db.run("INSERT INTO meta (key, value) VALUES ('k', 'v')");
    pump(A, B);
    expect(a.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ha_journal_command')!.n).toBe(0);
  });

  it('runs Command on the active server only, and says when its address or third vote cannot work in a pair', async () => {
    let running = true;
    const calls: string[] = [];
    const run: RunCommand = async (_cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'is-active') return { code: running ? 0 : 3, out: '' };
      running = args[0] === 'start';
      return { code: 0, out: '' };
    };
    const c = server('svc', run);
    c.source();
    const standby: boolean[] = [];
    c.onStandby = (ran) => standby.push(ran);
    expect((await c.deactivate()).map((s) => s.text)).toEqual([expect.stringMatching(/^FBRX Command stopped here/)]);
    expect(await c.deactivate()).toEqual([]);
    expect(standby).toEqual([true, false]);
    expect((await c.activate()).map((s) => s.text)).toEqual([expect.stringMatching(/^FBRX Command started here/)]);
    expect(calls).toEqual(['is-active --quiet fbrx-command.service', 'stop fbrx-command.service', 'is-active --quiet fbrx-command.service', 'start fbrx-command.service']);
    // Its keys, certificate and settings go to the standby too (the secret ones readable by their owner only).
    expect(c.files().map((f) => [f.name, !!f.secret])).toEqual([
      ['command-settings', false],
      ['command-secrets', true],
      ['command-jwt-key', true],
      ['command-master-key', true],
      ['command-license-key', true],
      ['command-tls-cert', false],
      ['command-tls-key', true],
    ]);
    // At the gate's address (which moves with the pair), with a third vote elsewhere: nothing to say.
    expect(c.warnings('https://command.example.org', ['192.168.50.1'], 'gate-b')).toEqual([]);
    // At an address of one server's own, or with itself as the third vote: said.
    expect(c.warnings(null, ['10.0.0.1'], 'gate-b')).toEqual([expect.stringMatching(/stays on one server: after a takeover they cannot find it on gate-b/)]);
    expect(c.warnings('https://192.168.50.1:8443', ['192.168.50.1'], 'gate-b')).toEqual([expect.stringMatching(/third vote is FBRX Command on this pair/)]);
  });
});

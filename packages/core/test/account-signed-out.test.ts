import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountService, type AccountDeps } from '../src/account/account-service';

/** An account's license stays on a computer whose sign-in ended, and leaves one that was signed out from elsewhere. */
describe('a computer whose FBRX account sign-in stops working', () => {
  let server: Server;
  let address = '';
  let answer: { code: string; message: string };
  const signedIn = () => {
    const meta = new Map<string, unknown>([
      ['account.server', address],
      ['account.id', 'acct_1'],
      ['account.licenseUntil', '2099-01-01T00:00:00.000Z'],
    ]);
    const applied: Array<string | null> = [];
    const account = new AccountService({
      meta: { get: (k: string) => meta.get(k), set: (k: string, v: unknown) => void meta.set(k, v), delete: (k: string) => void meta.delete(k) },
      vault: { isUnlocked: true, get: () => 'token', delete: () => undefined },
      license: { applyAccount: (key: string | null) => applied.push(key) },
      events: { emit: () => undefined },
      log: { warn: () => undefined },
      defaultServer: '',
    } as unknown as AccountDeps);
    return { account, meta, applied };
  };

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: answer }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('keeps the license of a sign-in that ended until it runs out', async () => {
    answer = { code: 'UNAUTHENTICATED', message: 'Your FBRX account sign-in has ended. Sign in again.' };
    const { account, meta, applied } = signedIn();
    const st = await account.refresh();
    expect(st).toMatchObject({ signedIn: false, licenseUntil: '2099-01-01T00:00:00.000Z' });
    expect(applied).toEqual([]);
    expect(meta.get('account.error')).toBe('Your FBRX account sign-in has ended: sign in again.');
  });

  it('gives the license back when the computer was signed out from elsewhere', async () => {
    answer = { code: 'SIGNED_OUT', message: 'You were signed out of your FBRX account here. Sign in again.' };
    const { account, meta, applied } = signedIn();
    const st = await account.refresh();
    expect(st).toMatchObject({ signedIn: false, licenseUntil: null });
    expect(applied).toEqual([null]);
    expect(meta.get('account.error')).toBe('This computer was signed out of your FBRX account: sign in again.');
  });
});

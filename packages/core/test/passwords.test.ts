import { describe, expect, it } from 'vitest';
import { generatePassword, loginMatch, passwordStrength, siteOf, titleForUrl, type Login, type LoginSummary } from '@fbrx/shared';
import { parseCsv, readLoginsCsv } from '../src/vault/passwords';
import { parseTotp, totpCode } from '../src/vault/totp';
import { makeKernel, USER } from './helpers';

const API = { origin: 'api' as const, actor: 'localapi:test' };

describe('the Vault password keeper', () => {
  it('rates passwords: common and short ones are very weak, long mixed ones and passphrases strong', () => {
    expect(passwordStrength('')).toBe(0);
    expect(passwordStrength('password123')).toBe(0);
    expect(passwordStrength('Qwerty123!')).toBe(0);
    expect(passwordStrength('abc')).toBe(0);
    expect(passwordStrength('aaaaaaaaaaaa')).toBe(0);
    expect(passwordStrength('Summer2026')).toBeLessThanOrEqual(2);
    expect(passwordStrength('Tr0ub4dor&3x')).toBeGreaterThanOrEqual(3);
    expect(passwordStrength('correct horse battery staple')).toBe(4);
    expect(passwordStrength(generatePassword())).toBe(4);
  });

  it('makes random passwords with every kind of character asked for', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generatePassword({ length: 12 });
      expect(p).toHaveLength(12);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/\d/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
      expect(p).not.toMatch(/[0O1lI]/);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
    expect(generatePassword({ length: 30, symbols: false })).toMatch(/^[A-Za-z0-9]{30}$/);
    expect(generatePassword({ length: 3 })).toHaveLength(8);
  });

  it('knows which site an address belongs to, and which sign-ins fit a page', () => {
    expect(siteOf('https://accounts.example.com/login')).toBe('example.com');
    expect(siteOf('example.co.uk')).toBe('example.co.uk');
    expect(siteOf('https://shop.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('https://alice.github.io')).toBe('alice.github.io');
    expect(siteOf('http://192.168.1.1:8080/admin')).toBe('192.168.1.1:8080');
    expect(siteOf('ftp://example.com')).toBeNull();
    expect(titleForUrl('https://www.netflix.com/login')).toBe('Netflix');

    expect(loginMatch(['https://example.com'], 'https://example.com/login')).toBe(2);
    expect(loginMatch(['https://example.com'], 'https://www.example.com/login')).toBe(2);
    expect(loginMatch(['https://example.com'], 'https://mail.example.com/')).toBe(1);
    expect(loginMatch(['https://alice.github.io'], 'https://mallory.github.io/')).toBe(0);
    expect(loginMatch(['https://example.com'], 'https://example.com.evil.net/')).toBe(0);
    // A sign-in for a secure page is never offered on an insecure one.
    expect(loginMatch(['https://example.com'], 'http://example.com/')).toBe(0);
    expect(loginMatch(['http://192.168.1.1'], 'http://192.168.1.1/login')).toBe(2);
  });

  it('makes 2-step codes as authenticator apps do (RFC 6238)', () => {
    // The RFC's own test: the key "12345678901234567890", eight digits, at 59 seconds.
    const rfc = parseTotp('otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8')!;
    expect(totpCode(rfc, 59_000)).toEqual({ code: '94287082', remaining: 1, period: 30 });
    expect(totpCode(rfc, 1_111_111_109_000).code).toBe('07081804');
    expect(parseTotp('gezd gnbv gy3t qojq')).toMatchObject({ digits: 6, period: 30, algorithm: 'sha1' });
    expect(parseTotp('not a key!')).toBeNull();
    expect(parseTotp('otpauth://hotp/x?secret=GEZDGNBV')).toBeNull();
  });

  it('reads the CSV files browsers and password managers export', () => {
    expect(parseCsv('a,"b, ""c""",d\r\n"line\nbreak",,\n')).toEqual([
      ['a', 'b, "c"', 'd'],
      ['line\nbreak', '', ''],
    ]);
    const browser = readLoginsCsv('﻿name,url,username,password,note\nShop,https://shop.example,me@example.com,s3cret-Pass,hi\n');
    expect(browser).toEqual([{ title: 'Shop', url: 'https://shop.example', username: 'me@example.com', password: 's3cret-Pass', notes: 'hi', totp: '', favorite: false }]);
    const manager = readLoginsCsv('folder,favorite,type,name,notes,login_uri,login_username,login_password,login_totp\n,1,login,Bank,,https://bank.example,me,pw-123456,\n,,note,Wifi,the key,,,,\n');
    expect(manager).toHaveLength(1);
    expect(manager[0]).toMatchObject({ title: 'Bank', username: 'me', favorite: true });
    expect(() => readLoginsCsv('title,notes\nA,B\n')).toThrow(/no username or password column/);
  });

  it('keeps sign-ins sealed in the vault: saves, lists without passwords, reveals, fills and forgets them', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const saved = (await kernel.call('passwords.save', { urls: ['netflix.com/login'], username: 'me@example.com', password: 'hunter22', totp: 'GEZDGNBVGY3TQOJQ' }, USER)) as LoginSummary;
      expect(saved).toMatchObject({ title: 'Netflix', urls: ['https://netflix.com/login'], username: 'me@example.com', strength: 1, reused: false, hasTotp: true });
      expect(saved).not.toHaveProperty('password');
      // Nothing readable in the database: the site and username are sealed too.
      const row = kernel.db.get<{ data_enc: string }>('SELECT data_enc FROM vault_logins WHERE id = ?', saved.id)!;
      expect(row.data_enc).not.toMatch(/netflix|hunter22|me@example/);

      await kernel.call('passwords.save', { title: 'Old account', username: 'old', password: 'hunter22' }, USER);
      const listed = (await kernel.call('passwords.list', undefined, USER)) as LoginSummary[];
      expect(listed.map((l) => [l.title, l.reused])).toEqual([
        ['Netflix', true],
        ['Old account', true],
      ]);
      expect(kernel.vault.status().loginCount).toBe(2);

      // A new password: the old one is kept in the history.
      await kernel.call('passwords.save', { id: saved.id, password: 'a much longer passphrase 2026', favorite: true }, USER);
      const full = (await kernel.call('passwords.reveal', { id: saved.id }, USER)) as Login;
      expect(full).toMatchObject({ password: 'a much longer passphrase 2026', favorite: true, strength: 4 });
      expect(full.history.map((h) => h.password)).toEqual(['hunter22']);

      expect(((await kernel.call('passwords.query', { url: 'https://www.netflix.com/browse' }, USER)) as LoginSummary[]).map((l) => l.id)).toEqual([saved.id]);
      expect(await kernel.call('passwords.query', { url: 'https://example.com/' }, USER)).toEqual([]);
      expect(await kernel.call('passwords.fill', { id: saved.id, url: 'https://netflix.com/login' }, USER)).toEqual({ username: 'me@example.com', password: 'a much longer passphrase 2026' });
      await expect(kernel.call('passwords.fill', { id: saved.id, url: 'https://netflix.com.evil.example/' }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await kernel.call('passwords.code', { id: saved.id }, USER)) as { code: string }).toMatchObject({ code: expect.stringMatching(/^\d{6}$/) });

      // The person at the computer only: never the Local API.
      await expect(kernel.call('passwords.list', undefined, API)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Passwords never reach a model, and never the audit log.
      expect(kernel.redactor.redact('it is a much longer passphrase 2026 here').count).toBe(1);
      expect(JSON.stringify(kernel.audit.query({ limit: 50 }))).not.toMatch(/passphrase 2026|hunter22/);

      await expect(kernel.call('passwords.save', { title: 'Empty' }, USER)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(kernel.call('passwords.save', { username: 'x', totp: 'nope!' }, USER)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(await kernel.call('passwords.remove', { id: saved.id }, USER)).toEqual({ removed: true });

      // Locked: nothing to list until the vault opens again.
      kernel.vault.lock();
      await expect(kernel.call('passwords.list', undefined, USER)).rejects.toMatchObject({ code: 'LOCKED' });
    } finally {
      await cleanup();
    }
  });

  it('imports an exported file, updating changed passwords and skipping the same sign-in twice', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      await kernel.call('passwords.save', { urls: ['https://bank.example'], username: 'me', password: 'first-Password-1' }, USER);
      const csv = 'name,url,username,password\nBank,https://www.bank.example/login,me,second-Password-2\nShop,shop.example,me,shop-Password-3\nShop,shop.example,me,shop-Password-3\n,,,\n';
      expect(await kernel.call('passwords.import', { csv }, USER)).toEqual({ added: 1, updated: 1, skipped: 1 });
      const bank = ((await kernel.call('passwords.list', undefined, USER)) as LoginSummary[]).find((l) => l.title === 'Bank')!;
      const full = (await kernel.call('passwords.reveal', { id: bank.id }, USER)) as Login;
      expect(full.password).toBe('second-Password-2');
      expect(full.history[0].password).toBe('first-Password-1');
    } finally {
      await cleanup();
    }
  });

  it('lets Fabrix find sign-ins and save one with a new password, never seeing a username or password', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      await kernel.call('passwords.save', { urls: ['https://shop.example'], username: 'buyer@example.com', password: 'password1' }, USER);
      const find = kernel.registry.get('passwords.find')!;
      expect(find.risk).toBe('read');
      const all = await find.run({}, {} as any);
      expect(all.output).toMatch(/1 sign-ins in the Vault: 1 with a weak password/);
      expect(all.output).toMatch(/Shop \(shop\.example\): very weak password/);
      expect(all.output).not.toMatch(/buyer@example|password1/);
      expect((await find.run({ query: 'bank' }, {} as any)).output).toMatch(/No sign-in matches "bank"/);

      const create = kernel.registry.get('passwords.create')!;
      // Saving asks first (write tools do, by default).
      expect(create.risk).toBe('write');
      const made = await create.run({ title: 'Shop', site: 'shop.example', username: 'buyer@example.com' }, {} as any);
      expect(made.output).toMatch(/Changed the password of "Shop" in the Vault; the old one is kept in its history\. .*new strong password \(20 characters\)/);
      const full = (await kernel.call('passwords.reveal', { id: (made.data as { id: string }).id }, USER)) as Login;
      expect(made.output).not.toContain(full.password);
      expect(full.strength).toBe(4);
      expect(full.history[0].password).toBe('password1');
      const fresh = await create.run({ title: 'Forum', site: 'forum.example', symbols: false, length: 16 }, {} as any);
      expect(fresh.output).toMatch(/Saved "Forum" in the Vault with a new strong password \(16 characters\)/);

      const asked: unknown[] = [];
      kernel.events.on('passwords.saveRequested', (d) => asked.push(d));
      await kernel.registry.get('passwords.offer_save')!.run({ title: 'Router', site: '192.168.1.1' }, {} as any);
      expect(asked).toEqual([{ title: 'Router', url: '192.168.1.1', username: '' }]);
    } finally {
      await cleanup();
    }
  });
});

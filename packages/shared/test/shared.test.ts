import { describe, expect, it } from 'vitest';
import { compareSemver, deepMerge, isPathLocked, satisfies, newId, decodeLicenseUnverified, parseVertical, productNameFor, resolveAudience, KIND_GROUPS, VERTICALS, VERTICAL_AUDIENCES, type LicensePayload } from '../src';
import { COMMAND_PLAN, EDITION_PLANS, SERVER_OFFER, TIERS, atLeast, formatPrice, maxTier, parseTier, priceOf, tenantMonthlyTotal } from '../src';
import { generateSigningKeyPair, hashPassword, licenseStatusFrom, openString, sealString, signLicense, verifyLicense, verifyPassword } from '../src/node';
import { randomBytes } from 'node:crypto';

const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  v: 1,
  lid: 'lic_1',
  tenantId: 'ten_1',
  customer: 'Acme Corp',
  edition: 'pro',
  seats: 25,
  features: ['fleet'],
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  maxMajorVersion: null,
  ...over,
});

describe('licensing', () => {
  const keys = generateSigningKeyPair();
  const other = generateSigningKeyPair();

  it('signs and verifies offline with Ed25519', () => {
    const key = signLicense(payload(), keys.privateKeyPem);
    expect(key.startsWith('FBRX1.')).toBe(true);
    const v = verifyLicense(key, [keys.publicKeyPem]);
    expect(v.ok && v.payload.customer).toBe('Acme Corp');
    expect(decodeLicenseUnverified(key)?.seats).toBe(25);
  });

  it('rejects keys signed by an untrusted vendor or tampered with', () => {
    const key = signLicense(payload(), other.privateKeyPem);
    expect(verifyLicense(key, [keys.publicKeyPem]).ok).toBe(false);
    const good = signLicense(payload(), keys.privateKeyPem);
    const [p, body, sig] = good.split('.');
    const forged = Buffer.from(body, 'base64url').toString().replace('"pro"', '"enterprise"');
    expect(verifyLicense(`${p}.${Buffer.from(forged).toString('base64url')}.${sig}`, [keys.publicKeyPem]).ok).toBe(false);
  });

  it('computes status: features, expiry and version caps', () => {
    const valid = licenseStatusFrom(signLicense(payload(), keys.privateKeyPem), [keys.publicKeyPem], 'local', 1);
    expect(valid.state).toBe('valid');
    expect(valid.features).toEqual(expect.arrayContaining(['plugins', 'agent.cloud', 'fleet']));
    const expired = licenseStatusFrom(signLicense(payload({ expiresAt: '2020-01-01T00:00:00.000Z' }), keys.privateKeyPem), [keys.publicKeyPem], 'local', 1);
    expect(expired.state).toBe('expired');
    expect(expired.edition).toBe('community');
    const capped = licenseStatusFrom(signLicense(payload({ maxMajorVersion: 1 }), keys.privateKeyPem), [keys.publicKeyPem], 'local', 2);
    expect(capped.state).toBe('invalid');
  });
});

describe('editions and prices', () => {
  it('orders the four editions, Black Hole having everything', () => {
    expect(TIERS).toEqual(['essentials', 'basic', 'ultra', 'blackhole']);
    expect(atLeast('blackhole', 'ultra')).toBe(true);
    expect(atLeast('ultra', 'blackhole')).toBe(false);
    expect(atLeast('basic', 'basic')).toBe(true);
    expect(atLeast(null, 'essentials')).toBe(false);
    expect(maxTier('basic', 'ultra')).toBe('ultra');
    expect(['Black Hole', 'black-hole', 'blackhole', 'Standard', 'ESSENTIALS'].map(parseTier)).toEqual(['blackhole', 'blackhole', 'blackhole', 'basic', 'essentials']);
  });

  it('carries the price list: Standard $4.99, Ultra $11.99, Black Hole $24.99 per computer in a tenant, FBRX Command $54.99', () => {
    expect([priceOf('essentials', 'personal'), priceOf('basic', 'personal'), priceOf('ultra', 'personal'), priceOf('blackhole', 'personal')]).toEqual([0, 499, 1199, null]);
    // 20% off Standard and Ultra in a tenant; Black Hole always full price; Essentials free everywhere.
    expect([priceOf('essentials', 'tenant'), priceOf('basic', 'tenant'), priceOf('ultra', 'tenant'), priceOf('blackhole', 'tenant')]).toEqual([0, 399, 959, 2499]);
    expect(COMMAND_PLAN.monthly).toBe(5499);
    expect(tenantMonthlyTotal({ essentials: 40, basic: 10, ultra: 2, blackhole: 1 })).toBe(5499 + 3990 + 1918 + 2499);
    expect(SERVER_OFFER).toMatchObject({ available: false, price: 10000 });
    expect([0, 499, 1199, 10000].map(formatPrice)).toEqual(['Free', '$4.99', '$11.99', '$100']);
    // Every paid edition has a product id for Stripe and the stores, and Black Hole is sold only in a tenant.
    for (const t of TIERS) expect(EDITION_PLANS[t].tenantProductId === null).toBe(t === 'essentials');
    expect(EDITION_PLANS.blackhole).toMatchObject({ sold: 'tenant', productId: null });
  });
});

describe('crypto', () => {
  it('seals and opens strings with AAD binding', () => {
    const k = randomBytes(32);
    const sealed = sealString(k, 'hello', 'ctx-a');
    expect(openString(k, sealed, 'ctx-a')).toBe('hello');
    expect(() => openString(k, sealed, 'ctx-b')).toThrow();
  });

  it('hashes passwords with scrypt', async () => {
    const h = await hashPassword('Correct-Horse-9');
    expect(await verifyPassword('Correct-Horse-9', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});

describe('utilities', () => {
  it('compares versions and ranges', () => {
    expect(compareSemver('1.2.0', '1.10.0')).toBe(-1);
    expect(compareSemver('2.0.0-beta.2', '2.0.0-beta.10')).toBe(-1);
    expect(compareSemver('2.0.0', '2.0.0-rc.1')).toBe(1);
    expect(satisfies('1.4.2', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
  });

  it('merges config layers and checks locks', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, l: [1] }, { a: { b: 3 }, l: [2] })).toEqual({ a: { b: 3, c: 2 }, l: [2] });
    expect(isPathLocked('ai.temperature', ['ai'])).toBe(true);
    expect(isPathLocked('ai', ['ai.temperature'])).toBe(true);
    expect(isPathLocked('general.theme', ['ai'])).toBe(false);
  });

  it('generates sortable ids', () => {
    const a = newId('x');
    const b = newId('x');
    expect(a < b || a.slice(0, 12) === b.slice(0, 12)).toBe(true);
    expect(a).toMatch(/^x_[0-9a-z]{22}$/);
  });
});

describe('kinds of tenant (Work, School, Home)', () => {
  it('reads the kind from its id or friendly name', () => {
    expect(parseVertical('Work')).toBe('business');
    expect(parseVertical(' school ')).toBe('education');
    expect(parseVertical('family')).toBe('home');
    expect(parseVertical('home')).toBe('home');
    expect(parseVertical('')).toBeNull();
    expect(parseVertical('castle')).toBeNull();
  });

  it('gives each computer an audience that fits the kind', () => {
    expect(resolveAudience('home', null)).toBe('parent');
    expect(resolveAudience('home', 'child')).toBe('child');
    // A computer asking to be a student computer in a family becomes a child's computer, and the other way round.
    expect(resolveAudience('home', 'parent', 'student')).toBe('child');
    expect(resolveAudience('education', null, 'child')).toBe('student');
    expect(resolveAudience('home', 'student')).toBe('child');
    // Staff tokens in a family mean a parent; a learner token can never be widened.
    expect(resolveAudience('home', 'staff')).toBe('parent');
    expect(resolveAudience('education', 'student', 'staff')).toBe('student');
    // Work has no learner computers.
    expect(resolveAudience('business', null, 'student')).toBe('staff');
    expect(productNameFor('ultra', 'home', 'child')).toBe('FBRX OS Home');
    expect(productNameFor('ultra', 'home', 'parent')).toBe('FBRX Endpoint Ultra');
  });

  it('has quick-setup groups that fit each kind', () => {
    for (const v of VERTICALS) {
      expect(KIND_GROUPS[v].length).toBeGreaterThan(0);
      for (const g of KIND_GROUPS[v]) expect(VERTICAL_AUDIENCES[v]).toContain(g.audience);
    }
    expect(KIND_GROUPS.home.map((g) => g.name)).toEqual(['Parents', 'Children']);
  });
});

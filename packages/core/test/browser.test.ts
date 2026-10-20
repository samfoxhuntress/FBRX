import { describe, expect, it } from 'vitest';
import { addressBarToUrl, hostMatches, policyAllows } from '@fbrx/shared';
import { makeKernel, USER } from './helpers';

describe('browser address bar and policy (shared)', () => {
  it('turns input into a URL or a search', () => {
    expect(addressBarToUrl('example.com', 'duckduckgo')).toBe('https://example.com');
    expect(addressBarToUrl('https://a.test/x', 'duckduckgo')).toBe('https://a.test/x');
    expect(addressBarToUrl('localhost:3000', 'duckduckgo')).toBe('http://localhost:3000');
    expect(addressBarToUrl('how tall is everest', 'duckduckgo')).toContain('duckduckgo.com');
    expect(addressBarToUrl('fbrx weather', 'google')).toContain('google.com/search');
  });
  it('matches hosts and applies allow/block lists', () => {
    expect(hostMatches('www.example.com', 'example.com')).toBe(true);
    expect(hostMatches('sub.example.com', 'example.com')).toBe(true);
    expect(hostMatches('notexample.com', 'example.com')).toBe(false);
    const blocked = policyAllows('https://bad.test/x', { allowed: [], blocked: ['bad.test'], managed: true, safeBrowsing: false });
    expect(blocked).toMatchObject({ ok: false, reason: 'blocked' });
    const notAllowed = policyAllows('https://other.test', { allowed: ['school.test'], blocked: [], managed: true, safeBrowsing: false });
    expect(notAllowed).toMatchObject({ ok: false, reason: 'not-allowed' });
    expect(policyAllows('https://school.test/a', { allowed: ['school.test'], blocked: [], managed: true, safeBrowsing: false })).toMatchObject({ ok: true });
  });
});

describe('browser service (kernel)', () => {
  it('keeps bookmarks and history, and honors the organization policy', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      // Record visits and bookmark one.
      await kernel.call('browser.visited', { url: 'https://a.test/1', title: 'A' }, USER);
      await kernel.call('browser.visited', { url: 'https://b.test/2', title: 'B' }, USER);
      const hist = (await kernel.call('browser.history', {}, USER)) as Array<{ url: string }>;
      expect(hist.map((h) => h.url)).toEqual(['https://b.test/2', 'https://a.test/1']);

      const marks = (await kernel.call('browser.bookmark', { url: 'https://b.test/2', title: 'B' }, USER)) as Array<{ url: string }>;
      expect(marks).toHaveLength(1);
      // The same URL is not bookmarked twice.
      expect((await kernel.call('browser.bookmark', { url: 'https://b.test/2', title: 'B again' }, USER)) as unknown[]).toHaveLength(1);

      // A personal block takes effect in check().
      await kernel.call('browser.addBlocked', { host: 'ads.test' }, USER);
      expect((await kernel.call('browser.check', { input: 'https://ads.test/x' }, USER)) as object).toMatchObject({ ok: false, reason: 'blocked' });
      expect((await kernel.call('browser.check', { input: 'example.com' }, USER)) as object).toMatchObject({ ok: true, url: 'https://example.com' });

      // The organization allow-list makes everything else not-allowed.
      kernel.settings.applyManaged({ browser: { allowed: ['school.test'] } }, ['browser.allowed']);
      expect((await kernel.call('browser.check', { input: 'https://news.test' }, USER)) as object).toMatchObject({ ok: false, reason: 'not-allowed' });
      expect((await kernel.call('browser.check', { input: 'https://school.test/home' }, USER)) as object).toMatchObject({ ok: true });
      expect((kernel.browser.state()).policy.managed).toBe(true);

      // Clear history.
      expect((await kernel.call('browser.clearHistory', {}, USER)) as object).toMatchObject({ cleared: 2 });
      expect((await kernel.call('browser.history', {}, USER)) as unknown[]).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

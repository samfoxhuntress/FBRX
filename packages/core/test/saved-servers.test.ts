import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createSelfSignedCertificate } from '@fbrx/shared/node';
import type { SavedServer, ServerCheck } from '@fbrx/shared';
import { SavedServers, certificateFingerprint, parseServerAddress } from '../src/system/saved-servers';
import { MetaStore } from '../src/storage/meta';
import { makeKernel, USER } from './helpers';

describe('saved servers (Lab → FBRX Server → Your servers)', () => {
  it('reads an address the way people type it', () => {
    expect(parseServerAddress('fbrx-server')).toEqual({ scheme: 'https', host: 'fbrx-server', port: 9443 });
    expect(parseServerAddress('192.168.1.20:9443')).toEqual({ scheme: 'https', host: '192.168.1.20', port: 9443 });
    expect(parseServerAddress(' https://NAS.local/ ')).toEqual({ scheme: 'https', host: 'nas.local', port: 443 });
    expect(parseServerAddress('http://10.0.0.5:8080/admin')).toEqual({ scheme: 'http', host: '10.0.0.5', port: 8080 });
    expect(parseServerAddress('fd00::20')).toEqual({ scheme: 'https', host: 'fd00::20', port: 9443 });
    expect(parseServerAddress('https://[fd00::20]:8006')).toEqual({ scheme: 'https', host: 'fd00::20', port: 8006 });
    expect(parseServerAddress('10.0.0.5', 8443).port).toBe(8443);
    expect(() => parseServerAddress('ftp://10.0.0.5')).toThrow(/https/);
    expect(() => parseServerAddress('https://admin:secret@10.0.0.5')).toThrow(/password/);
    expect(() => parseServerAddress('')).toThrow();
  });

  it('turns Electron\'s certificate fingerprint into the one FBRX Server prints', () => {
    const hex = 'ab'.repeat(32);
    const formatted = certificateFingerprint(hex);
    expect(formatted).toMatch(/^AB(:AB){31}$/);
    expect(certificateFingerprint(`sha256/${Buffer.from(hex, 'hex').toString('base64')}`)).toBe(formatted);
  });

  it('suggests the FBRX Servers on the mesh that are not saved yet', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const mesh = [
        { name: 'fbrx-server-1', host: '192.168.1.20', roles: ['virtual', 'ai'] },
        { name: 'office-laptop', host: '192.168.1.31', roles: [] },
      ];
      const servers = new SavedServers({ meta: kernel.meta as MetaStore, audit: () => undefined, meshServers: () => mesh });
      expect(servers.suggestions()).toEqual([{ name: 'fbrx-server-1', host: '192.168.1.20', port: 9443, roles: ['virtual', 'ai'] }]);
      servers.save({ address: '192.168.1.20' });
      expect(servers.suggestions()).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('saves a server, checks its own certificate, trusts it once, and the built-in browser accepts only that one', async () => {
    const cert = createSelfSignedCertificate({ commonName: 'fbrx-server', names: ['127.0.0.1'] });
    const https = createServer({ cert: cert.certPem, key: cert.keyPem }, (_q, s) => s.end('FBRX Virtual'));
    await new Promise<void>((r) => https.listen(0, '127.0.0.1', r));
    const port = (https.address() as AddressInfo).port;
    const { kernel, cleanup } = await makeKernel();
    try {
      const s = (await kernel.call('server.save', { address: `127.0.0.1:${port}`, name: 'Rack server' }, USER)) as SavedServer;
      expect(s).toMatchObject({ name: 'Rack server', scheme: 'https', host: '127.0.0.1', port, url: `https://127.0.0.1:${port}/`, fingerprint: null });
      // The same address again is the same entry.
      expect(((await kernel.call('server.save', { address: `https://127.0.0.1:${port}/`, notes: 'Top of the rack' }, USER)) as SavedServer).id).toBe(s.id);
      await expect(kernel.call('server.save', { id: 'srv_nope', address: '10.0.0.9' }, USER)).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // Its own certificate: shown to compare, not opened yet.
      const first = (await kernel.call('server.check', { id: s.id }, USER)) as ServerCheck;
      expect(first).toMatchObject({ reachable: true, ok: false, changed: false, certificate: { fingerprint: cert.fingerprint, trustedBySystem: false } });
      expect(kernel.servers.trustsCertificate(s.url, cert.fingerprint)).toBe(false);

      await kernel.call('server.trust', { id: s.id, fingerprint: first.certificate!.fingerprint }, USER);
      expect(((await kernel.call('server.check', { id: s.id }, USER)) as ServerCheck).ok).toBe(true);
      // The browser's certificate check: this exact certificate, at this exact address (also in Electron's format).
      const electronFp = `sha256/${Buffer.from(cert.fingerprint.replace(/:/g, ''), 'hex').toString('base64')}`;
      expect(kernel.servers.trustsCertificate(`https://127.0.0.1:${port}/vms`, electronFp)).toBe(true);
      expect(kernel.servers.trustsCertificate(`wss://127.0.0.1:${port}/v1/screen`, electronFp)).toBe(true);
      expect(kernel.servers.trustsCertificate(`https://127.0.0.1:${port + 1}/`, electronFp)).toBe(false);
      expect(kernel.servers.trustsCertificate(`https://localhost:${port}/`, electronFp)).toBe(false);
      expect(kernel.servers.trustsCertificate(`https://127.0.0.1:${port}/`, 'AA:'.repeat(31) + 'AA')).toBe(false);

      // A different certificate later is flagged, not accepted.
      const other = createSelfSignedCertificate({ commonName: 'someone-else' });
      https.setSecureContext({ cert: other.certPem, key: other.keyPem });
      const changed = (await kernel.call('server.check', { id: s.id }, USER)) as ServerCheck;
      expect(changed).toMatchObject({ ok: false, changed: true, certificate: { fingerprint: other.fingerprint } });
      expect(kernel.servers.trustsCertificate(s.url, other.fingerprint)).toBe(false);

      // Moving it to another address forgets the trusted certificate.
      const moved = (await kernel.call('server.save', { id: s.id, address: `127.0.0.1:${port + 1}` }, USER)) as SavedServer;
      expect(moved.fingerprint).toBeNull();
      const gone = (await kernel.call('server.check', { id: s.id }, USER)) as ServerCheck;
      expect(gone).toMatchObject({ reachable: false, ok: false, error: expect.stringContaining('nothing listens') });

      await kernel.call('server.opened', { id: s.id }, USER);
      const listed = (await kernel.call('server.saved', undefined, USER)) as { servers: SavedServer[] };
      expect(listed.servers[0]).toMatchObject({ id: s.id, notes: 'Top of the rack', lastOpenedAt: expect.any(String) });
      // Only the person at the computer: not the Local API.
      await expect(kernel.call('server.saved', undefined, { origin: 'api', actor: 'localapi:x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await kernel.call('server.remove', { id: s.id }, USER);
      expect(((await kernel.call('server.saved', undefined, USER)) as { servers: SavedServer[] }).servers).toEqual([]);
    } finally {
      https.close();
      await cleanup();
    }
  });
});

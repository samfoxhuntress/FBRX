import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSelfSignedCertificate } from '@fbrx/shared/node';
import { AccountService, type AccountDeps } from '../src/account/account-service';

/** FBRX Command on this computer or the home network: its own certificate, trusted by fingerprint. */
describe('an FBRX account on an FBRX Command with its own certificate', () => {
  const cert = createSelfSignedCertificate({ commonName: 'FBRX Command', names: ['127.0.0.1'] });
  let server: Server;
  let address: string;
  const meta = new Map<string, unknown>();
  const account = new AccountService({
    meta: { get: (k: string) => meta.get(k), set: (k: string, v: unknown) => void meta.set(k, v), delete: (k: string) => void meta.delete(k) },
    vault: { isUnlocked: true, get: () => 'token' },
    defaultServer: '',
  } as unknown as AccountDeps);

  beforeAll(async () => {
    server = createServer({ cert: cert.certPem, key: cert.keyPem }, (req, res) => {
      res.writeHead(req.url === '/v1/accounts/invitations/preview' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/v1/accounts/invitations/preview' ? { tenantName: 'Home', email: 'sam@example.com', tier: 'blackhole', accountExists: false } : {}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    address = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('asks for the certificate to be trusted before sending anything', async () => {
    await expect(account.previewInvitation({ code: 'FBRX-AAAA', server: address })).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('uses its own certificate') });
  });

  it('goes on once its fingerprint is trusted, and refuses another certificate', async () => {
    await expect(account.previewInvitation({ code: 'FBRX-AAAA', server: address, fingerprint: cert.fingerprint })).resolves.toMatchObject({ tenantName: 'Home', tier: 'blackhole' });
    const other = createSelfSignedCertificate({ commonName: 'Someone else' });
    await expect(account.previewInvitation({ code: 'FBRX-AAAA', server: address, fingerprint: other.fingerprint })).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('different certificate') });
    await expect(account.previewInvitation({ code: 'FBRX-AAAA', server: address, fingerprint: 'AB:CD' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it("keeps trusting the account's FBRX Command, FBRX Cloud AI included", async () => {
    meta.set('account.server', address);
    meta.set('account.fingerprint', cert.fingerprint);
    meta.set('account.id', 'acct_1');
    await expect(account.previewInvitation({ code: 'FBRX-AAAA' })).resolves.toMatchObject({ tenantName: 'Home' });
    expect(account.cloudAccess()).toMatchObject({ baseUrl: `${address}/v1/ai`, fingerprint: cert.fingerprint });
  });
});

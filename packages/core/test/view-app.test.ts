import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FBRX_APPS, VIEW_PAGES, type ViewOpen } from '@fbrx/shared';
import { makeKernel, tempDir, USER } from './helpers';
import { decodeRDCleanPathResponse, encodeRDCleanPathRequest } from '../src/view/rdcleanpath';

describe('FBRX View', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('is the app family’s remote desktop app, at Ultra', () => {
    expect(FBRX_APPS.view).toMatchObject({ name: 'FBRX View', edition: 'ultra', built: true, tag: 'view-v' });
    expect(VIEW_PAGES).toEqual(['view', 'settings', 'agent']);
  });

  it('runs none of Endpoint’s background work, and its AI has the consoles’ tools but no network tools', async () => {
    const { kernel, cleanup } = await makeKernel({ platform: { flavor: 'view', endpointDataDir: tempDir() } });
    cleanups.push(cleanup);
    expect(kernel.view && kernel.sideApp && !kernel.digger).toBe(true);
    const states = Object.fromEntries(kernel.services.list().map((s) => [s.name, s.state]));
    for (const name of ['runtime', 'backup', 'fleet', 'protection', 'calendar', 'mesh', 'localapi']) expect(states[name], name).toBe('disabled');
    expect(kernel.registry.get('device_console.sessions')).toBeTruthy();
    expect(kernel.registry.get('network_env.overview')).toBeFalsy();
  });

  it('opens a remote desktop for the person only: a ticket for the proxy, and the login kept in the vault', async () => {
    const { kernel, cleanup } = await makeKernel({ platform: { flavor: 'view', endpointDataDir: tempDir() } });
    cleanups.push(cleanup);

    // The AI never gets a login or a ticket.
    await expect(kernel.call('view.open', { protocol: 'rdp', host: '10.0.0.5', username: 'sam' }, { origin: 'agent', actor: 'agent' })).rejects.toBeTruthy();

    const first = (await kernel.call('view.open', { protocol: 'rdp', host: '10.0.0.5', username: 'OFFICE\\sam' }, USER)) as ViewOpen;
    expect(first).toMatchObject({ protocol: 'rdp', destination: '10.0.0.5:3389', username: 'sam', domain: 'OFFICE', password: '', saved: false });
    expect(first.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/rdp$/);
    expect(first.bookmark).toMatchObject({ host: '10.0.0.5', port: 3389, protocol: 'rdp', username: 'OFFICE\\sam', passwordSaved: false });

    await kernel.call('view.saveLogin', { protocol: 'rdp', host: '10.0.0.5', port: 3389, username: 'OFFICE\\sam', password: 'pw-1' }, USER);
    const again = (await kernel.call('view.open', { protocol: 'rdp', host: '10.0.0.5', username: 'OFFICE\\sam' }, USER)) as ViewOpen;
    expect(again).toMatchObject({ password: 'pw-1', saved: true });
    expect(again.bookmark.passwordSaved).toBe(true);
    expect(again.token).not.toBe(first.token);

    // VNC: a password and no user name.
    await kernel.call('view.saveLogin', { protocol: 'vnc', host: '10.0.0.6', port: 5900, password: 'v' }, USER);
    expect(await kernel.call('view.open', { protocol: 'vnc', host: '10.0.0.6' }, USER)).toMatchObject({ password: 'v', saved: true, bookmark: { passwordSaved: true } });

    // The ticket works once, for that computer only; what happened is in the audit log.
    const ws = new WebSocket(first.url);
    await new Promise((r) => ws.once('open', r));
    ws.send(encodeRDCleanPathRequest({ destination: '10.0.0.9:3389', proxyAuth: first.token, x224: Buffer.from('030000130ee000000000000100080003000000', 'hex') }));
    const res = decodeRDCleanPathResponse(await new Promise<Buffer>((r) => ws.once('message', (d) => r(d as Buffer))));
    expect(res.error).toMatchObject({ httpStatusCode: 403 });
    const audit = kernel.audit.query({ limit: 50 }).map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['view.open', 'view.session.refused']));
  });

  it('is FBRX View’s alone', async () => {
    const { kernel, cleanup } = await makeKernel();
    cleanups.push(cleanup);
    await expect(kernel.call('view.open', { protocol: 'rdp', host: '10.0.0.5' }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

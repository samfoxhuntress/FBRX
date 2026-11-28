import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { FBRX_APPS, VIEW_PAGES, type ViewOpen } from '@fbrx/shared';
import { makeKernel, tempDir, USER, waitFor } from './helpers';
import { decodeRDCleanPathResponse, encodeRDCleanPathRequest } from '../src/view/rdcleanpath';
import { parseConnectionFile } from '../src/view/imports';

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

  it('reads Remote Desktop files and Remote Desktop Manager exports, never their passwords', () => {
    const rdp = 'screen mode id:i:2\r\nfull address:s:dc01.office.lan:3390\r\nusername:s:sam\r\ndomain:s:OFFICE\r\npassword 51:b:01000000D08C9DDF\r\n';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rdp, 'utf16le')]);
    expect(parseConnectionFile(utf16, 'Domain controller.rdp')).toEqual({
      connections: [{ label: 'Domain controller', host: 'dc01.office.lan', port: 3390, protocol: 'rdp', username: 'OFFICE\\sam', notes: 'From a Remote Desktop file' }],
      skipped: 0,
    });
    const rdm = `<?xml version="1.0"?><ArrayOfConnection>
      <Connection><ConnectionType>Group</ConnectionType><Name>Servers</Name></Connection>
      <Connection><ConnectionType>RDPConfigured</ConnectionType><Group>Servers</Group><Name>File &amp; print</Name><Url>10.0.0.5</Url><RDP><UserName>admin</UserName><Domain>OFFICE</Domain></RDP><Password>secret-blob</Password></Connection>
      <Connection><ConnectionType>SSHShell</ConnectionType><Name>Core switch</Name><Terminal><Host>10.0.0.2</Host><HostPort>2222</HostPort><Username>netadmin</Username></Terminal></Connection>
      <Connection><ConnectionType>VNC</ConnectionType><Name>Lab Mac</Name><Url>10.0.0.9:5901</Url></Connection>
      <Connection><ConnectionType>WebBrowser</ConnectionType><Name>Router</Name><Url>https://10.0.0.1</Url></Connection>
    </ArrayOfConnection>`;
    const r = parseConnectionFile(Buffer.from(rdm), 'export.rdm');
    expect(r.skipped).toBe(2);
    expect(r.connections).toEqual([
      { label: 'File & print', host: '10.0.0.5', port: null, protocol: 'rdp', username: 'OFFICE\\admin', notes: 'From Remote Desktop Manager (folder Servers)' },
      { label: 'Core switch', host: '10.0.0.2', port: 2222, protocol: 'ssh', username: 'netadmin', notes: 'From Remote Desktop Manager' },
      { label: 'Lab Mac', host: '10.0.0.9', port: 5901, protocol: 'vnc', username: null, notes: 'From Remote Desktop Manager' },
    ]);
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(() => parseConnectionFile(Buffer.from('hello'), 'notes.txt')).toThrow(/imports Remote Desktop files/);
  });

  it('imports into the saved connections, and keeps quick commands', async () => {
    const { kernel, cleanup } = await makeKernel({ platform: { flavor: 'view', endpointDataDir: tempDir() } });
    cleanups.push(cleanup);
    const data = Buffer.from('full address:s:10.0.0.7\nusername:s:sam@office.lan\n').toString('base64');
    const r = (await kernel.call('view.import', { fileName: 'pc.rdp', data }, USER)) as { added: number; bookmarks: Array<{ host: string; username: string; protocol: string }> };
    expect(r.added).toBe(1);
    expect(r.bookmarks[0]).toMatchObject({ host: '10.0.0.7', username: 'sam@office.lan', protocol: 'rdp' });
    await expect(kernel.call('view.import', { fileName: 'x.txt', data: Buffer.from('nothing').toString('base64') }, USER)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const list = (await kernel.call('view.saveSnippet', { name: 'Interfaces', text: 'show ip interface brief' }, USER)) as Array<{ id: string }>;
    expect(await kernel.call('view.snippets', {}, USER)).toEqual([{ id: list[0]!.id, name: 'Interfaces', text: 'show ip interface brief' }]);
    await expect(kernel.call('view.saveSnippet', { name: 'x', text: 'reboot' }, { origin: 'agent', actor: 'agent' })).rejects.toBeTruthy();
    expect(await kernel.call('view.removeSnippet', { id: list[0]!.id }, USER)).toEqual([]);
  });

  it('takes a connection FBRX Endpoint hands over ("Open in View"), once and only while it is fresh', async () => {
    const apps = tempDir('fbrx-apps-');
    const endpointDir = join(apps, 'FBRX OS');
    mkdirSync(endpointDir);
    const exec = join(apps, 'FBRX Endpoint.exe');
    writeFileSync(exec, '');
    writeFileSync(join(endpointDir, 'app.json'), JSON.stringify({ id: 'os', version: '2.6.0', exec, at: new Date().toISOString() }));
    const request = (id: string, at: Date) => writeFileSync(join(endpointDir, 'view-request.json'), JSON.stringify({ id, at: at.toISOString(), protocol: 'rdp', host: '10.0.0.5', username: 'sam', label: 'Front desk' }));
    request('vr_old', new Date(Date.now() - 10 * 60_000));
    const { kernel, cleanup } = await makeKernel({ platform: { flavor: 'view', endpointDataDir: endpointDir, appsDir: apps, shell: 'desktop' } });
    cleanups.push(cleanup);
    expect(kernel.takeViewRequest()).toBeNull();
    request('vr_1', new Date());
    expect(await waitFor(() => kernel.takeViewRequest(), 6000)).toEqual({ protocol: 'rdp', host: '10.0.0.5', username: 'sam', label: 'Front desk' });
    // Once.
    await new Promise((r) => setTimeout(r, 2500));
    expect(kernel.takeViewRequest()).toBeNull();
    expect(kernel.audit.query({ limit: 50 }).some((e) => e.action === 'view.handedOver')).toBe(true);
  });

  it('is FBRX View’s alone', async () => {
    const { kernel, cleanup } = await makeKernel();
    cleanups.push(cleanup);
    await expect(kernel.call('view.open', { protocol: 'rdp', host: '10.0.0.5' }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

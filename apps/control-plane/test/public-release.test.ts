import { afterEach, describe, expect, it } from 'vitest';
import { forgetPublicRelease, installersOf, publicRelease } from '../src/services/public-release';

const manifest = { version: '2.3.0', download: 'https://example.com/fbrx.zip', page: 'https://example.com/v2.3.0' };
const assets = [
  { name: 'FBRX-OS-Setup-2.3.0.exe', browser_download_url: 'https://dl.example/FBRX-OS-Setup-2.3.0.exe', size: 10 },
  { name: 'FBRX-OS-Setup-2.3.0.exe.blockmap', browser_download_url: 'https://dl.example/x.blockmap', size: 1 },
  { name: 'FBRX-OS-2.3.0-arm64.dmg', browser_download_url: 'https://dl.example/FBRX-OS-2.3.0-arm64.dmg', size: 20 },
  { name: 'FBRX-OS-2.3.0-arm64.zip', browser_download_url: 'https://dl.example/FBRX-OS-2.3.0-arm64.zip', size: 20 },
  { name: 'FBRX-OS-2.3.0-x86_64.AppImage', browser_download_url: 'https://dl.example/FBRX-OS-2.3.0-x86_64.AppImage', size: 30 },
  { name: 'latest.yml', browser_download_url: 'https://dl.example/latest.yml', size: 1 },
  { name: 'FBRX-Digger-Setup-1.1.0.exe', browser_download_url: 'https://dl.example/digger.exe', size: 5 },
  { name: 'fbrx-server-1.4.0.tar.gz', browser_download_url: 'https://dl.example/server.tgz', size: 50 },
];

describe('the FBRX OS anyone can download, for Deploy & enroll', () => {
  afterEach(() => forgetPublicRelease());

  it('keeps the installers of FBRX OS only (not updates, FBRX Digger or FBRX Server)', () => {
    expect(installersOf(assets).map((f) => `${f.platform} ${f.fileName}`)).toEqual(['win32 FBRX-OS-Setup-2.3.0.exe', 'darwin FBRX-OS-2.3.0-arm64.dmg', 'linux FBRX-OS-2.3.0-x86_64.AppImage']);
  });

  it('reads release.json, then that version’s GitHub release, and keeps the answer for a while', async () => {
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(url.endsWith('release.json') ? manifest : { assets }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await publicRelease(fake);
    expect(r).toMatchObject({ version: '2.3.0', page: manifest.page });
    expect(r!.files.find((f) => f.platform === 'win32')!.url).toBe('https://dl.example/FBRX-OS-Setup-2.3.0.exe');
    expect(asked[1]).toMatch(/api\.github\.com\/repos\/.+\/releases\/tags\/v2\.3\.0$/);
    await publicRelease(fake);
    expect(asked).toHaveLength(2);
  });

  it('offline: none (the page then offers what was uploaded here)', async () => {
    const offline = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await publicRelease(offline)).toBeNull();
  });
});

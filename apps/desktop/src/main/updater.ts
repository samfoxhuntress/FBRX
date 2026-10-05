import { execFile } from 'node:child_process';
import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateController, UpdateFeedConfig } from '@fbrx/core';
import type { UpdateStatus } from '@fbrx/shared';

const { autoUpdater } = electronUpdater;

/** Windows' verdict on a file's Authenticode signature (status 0 = valid), or null when it cannot be read. */
function authenticode(file: string): Promise<{ status: number; subject: string | null } | null> {
  const literal = file.replace(/'/g, "''");
  const script = `Get-AuthenticodeSignature -LiteralPath '${literal}' | Select-Object @{n='Status';e={[int]$_.Status}}, @{n='Subject';e={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', script], { windowsHide: true, timeout: 20_000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(out) as { Status: number; Subject?: string | null };
        resolve({ status: Number(j.Status), subject: j.Subject ?? null });
      } catch {
        resolve(null);
      }
    });
  });
}

export const commonName = (dn: string | null | undefined): string | null => dn?.match(/(?:^|,\s*)CN=("?)([^",]+)\1/)?.[2]?.trim() ?? null;

/**
 * Which Windows updates get installed. electron-updater compares an update's signature with the publisher name
 * written into the build, which would refuse every update the day builds go from unsigned to signed. Instead:
 * a signed copy of FBRX only accepts updates validly signed by the same publisher as itself; an unsigned copy
 * (built from source, or before signing was set up) relies on the checksum in the update feed, as it always has.
 */
export async function verifyWindowsUpdate(file: string): Promise<string | null> {
  const [self, update] = await Promise.all([authenticode(process.execPath), authenticode(file)]);
  if (!self || self.status !== 0) return null;
  if (!update) return 'Windows could not check the signature of the update';
  if (update.status !== 0) return 'The update is not signed by the publisher of this copy of FBRX';
  const mine = commonName(self.subject);
  const theirs = commonName(update.subject);
  return mine && mine === theirs ? null : `The update is signed by ${theirs ?? 'someone else'}, not ${mine ?? 'the publisher of this copy'}`;
}

/**
 * electron-updater driven by the FBRX control plane. The feed URL and device credentials are injected once
 * the workstation enrolls; the server decides which version each device gets (channel, pin, rollout).
 */
export class ElectronUpdateController implements UpdateController {
  private state: UpdateStatus;
  private listeners = new Set<(s: UpdateStatus) => void>();
  private configured = false;

  constructor(private readonly getPrefs: () => { autoDownload: boolean; autoInstall: boolean; channel: UpdateStatus['channel'] }) {
    this.state = {
      state: app.isPackaged ? 'idle' : 'unsupported',
      currentVersion: app.getVersion(),
      availableVersion: null,
      progressPct: null,
      channel: getPrefs().channel,
      feedUrl: null,
      message: app.isPackaged ? 'Enroll with a control plane to receive managed updates' : 'Updates are disabled in development builds',
    };
    autoUpdater.logger = null;
    if (process.platform === 'win32') (autoUpdater as unknown as { verifyUpdateCodeSignature: (names: string[], file: string) => Promise<string | null> }).verifyUpdateCodeSignature = (_names, file) => verifyWindowsUpdate(file);
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', message: null }));
    autoUpdater.on('update-available', (i) => {
      this.set({ state: 'available', availableVersion: i.version });
      if (this.getPrefs().autoDownload) void autoUpdater.downloadUpdate().catch((e) => this.fail(e));
    });
    autoUpdater.on('update-not-available', () => this.set({ state: 'not-available', availableVersion: null, message: 'You are on the assigned version' }));
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', progressPct: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (i) => {
      this.set({ state: 'downloaded', availableVersion: i.version, progressPct: 100, message: 'Restart FBRX OS to finish updating' });
      if (this.getPrefs().autoInstall) setTimeout(() => autoUpdater.quitAndInstall(false, true), 3000);
    });
    autoUpdater.on('error', (e) => this.fail(e));
  }

  private fail(e: unknown) {
    this.set({ state: 'error', message: (e as Error)?.message?.split('\n')[0] ?? String(e) });
  }

  private set(patch: Partial<UpdateStatus>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  status() {
    return this.state;
  }

  configure(cfg: UpdateFeedConfig) {
    if (!app.isPackaged) return;
    if (!cfg.feedUrl) {
      this.configured = false;
      this.set({ state: 'idle', feedUrl: null, message: 'Not connected to a control plane' });
      return;
    }
    autoUpdater.setFeedURL({ provider: 'generic', url: cfg.feedUrl });
    autoUpdater.requestHeaders = cfg.headers;
    autoUpdater.allowDowngrade = cfg.allowDowngrade;
    this.configured = true;
    this.set({ feedUrl: cfg.feedUrl, channel: cfg.channel, message: null, state: this.state.state === 'unsupported' ? 'idle' : this.state.state });
  }

  async check() {
    if (!this.configured) return this.state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.fail(e);
    }
    return this.state;
  }

  async install(opts?: { restartNow?: boolean }) {
    if (!this.configured) throw new Error(this.state.message ?? 'Updates are not configured');
    if (this.state.state !== 'downloaded') {
      await autoUpdater.checkForUpdates();
      await autoUpdater.downloadUpdate();
    }
    if (opts?.restartNow) setTimeout(() => autoUpdater.quitAndInstall(false, true), 1000);
    return this.state;
  }

  onStatus(cb: (s: UpdateStatus) => void) {
    this.listeners.add(cb);
  }
}

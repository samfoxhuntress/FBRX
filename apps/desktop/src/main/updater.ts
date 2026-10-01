import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateController, UpdateFeedConfig } from '@fbrx/core';
import type { UpdateStatus } from '@fbrx/shared';

const { autoUpdater } = electronUpdater;

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

import { contextBridge, ipcRenderer } from 'electron';

/** The only bridge between the renderer and FBRX OS core. No Node APIs are exposed. */
const api = {
  async call(method: string, params?: unknown): Promise<unknown> {
    const r = await ipcRenderer.invoke('fbrx:call', method, params ?? {});
    if (!r?.ok) throw new Error(r?.error?.message ?? 'Request failed');
    return r.result;
  },
  on(cb: (event: string, payload: unknown) => void): () => void {
    const h = (_e: unknown, name: string, payload: unknown) => cb(name, payload);
    ipcRenderer.on('fbrx:event', h);
    return () => ipcRenderer.removeListener('fbrx:event', h);
  },
  onNavigate(cb: (route: string) => void): () => void {
    const h = (_e: unknown, route: string) => cb(route);
    ipcRenderer.on('fbrx:navigate', h);
    return () => ipcRenderer.removeListener('fbrx:navigate', h);
  },
  dialog: (opts: { kind: 'file' | 'folder' | 'save'; title?: string; filters?: Array<{ name: string; extensions: string[] }>; defaultPath?: string }) => ipcRenderer.invoke('fbrx:dialog', opts) as Promise<string | null>,
  reveal: (path: string) => ipcRenderer.invoke('fbrx:reveal', path),
  openExternal: (url: string) => ipcRenderer.invoke('fbrx:openExternal', url),
  appInfo: () => ipcRenderer.invoke('fbrx:app'),
  showSpotlight: () => void ipcRenderer.invoke('fbrx:spotlight', 'show'),
  spotlightHide: () => void ipcRenderer.invoke('fbrx:spotlight', 'hide'),
  openMain: (route: string) => void ipcRenderer.invoke('fbrx:spotlight', 'open', route),
  copyText: async (text: string) => void (await ipcRenderer.invoke('fbrx:copy', text)),
  goose: (action: string, on?: boolean) => ipcRenderer.invoke('fbrx:goose', action, on) as Promise<unknown>,
  onGoose(cb: (e: unknown) => void): () => void {
    const h = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('fbrx:goose', h);
    return () => ipcRenderer.removeListener('fbrx:goose', h);
  },
  clip: (action: 'list' | 'read' | 'remove' | 'pin' | 'clear', id?: number, on?: boolean) => ipcRenderer.invoke('fbrx:clip', action, id, on) as Promise<unknown>,
  onClips(cb: (entries: unknown) => void): () => void {
    const h = (_e: unknown, entries: unknown) => cb(entries);
    ipcRenderer.on('fbrx:clips', h);
    return () => ipcRenderer.removeListener('fbrx:clips', h);
  },
  clipPicker: (action: 'show' | 'hide' | 'enable' | 'paste', text?: string) => ipcRenderer.invoke('fbrx:clip-picker', action, text) as Promise<unknown>,
  onClipPicker(cb: (what: string) => void): () => void {
    const h = (_e: unknown, what: string) => cb(what);
    ipcRenderer.on('fbrx:clip-picker', h);
    return () => ipcRenderer.removeListener('fbrx:clip-picker', h);
  },
  runCode: (code: string, inputs: string[]) => ipcRenderer.invoke('fbrx:code-run', code, inputs) as Promise<unknown>,
  stopCode: () => ipcRenderer.invoke('fbrx:code-stop') as Promise<unknown>,
  micAccess: () => ipcRenderer.invoke('fbrx:mic-access') as Promise<{ granted: boolean; status: string }>,
  openVoiceSettings: () => ipcRenderer.invoke('fbrx:voice-settings') as Promise<boolean>,
  platform: process.platform,
};

contextBridge.exposeInMainWorld('fbrx', api);
export type FbrxBridge = typeof api;

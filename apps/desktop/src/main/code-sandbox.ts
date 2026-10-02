import { BrowserWindow, session } from 'electron';

/**
 * Runs JavaScript from the code lab in a throwaway, invisible browser window that can't reach anything: its own
 * in-memory session where every request is cancelled, WebRTC limited to a proxy that doesn't exist, no Node, no
 * preload, no permissions, no navigation and no pop-ups. The page is about:blank, so there is nothing to read either.
 * It's destroyed when the program finishes or after the time limit (an endless loop is simply cut off).
 */

export interface CodeRunLine {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}
export interface CodeRunResult {
  lines: CodeRunLine[];
  ms: number;
  timedOut: boolean;
  truncated: boolean;
}

const PARTITION = 'fbrx-codelab';
const MAX_LINES = 2000;
const MAX_CHARS = 200_000;
let prepared: Promise<void> | null = null;

async function sandboxSession() {
  const ses = session.fromPartition(PARTITION, { cache: false });
  prepared ??= (async () => {
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: d.url !== 'about:blank' }));
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (e) => e.preventDefault());
    await ses.setProxy({ proxyRules: 'http=127.0.0.1:9;https=127.0.0.1:9;socks=127.0.0.1:9', proxyBypassRules: '<-loopback>' });
  })();
  await prepared;
  return ses;
}

// prompt(), confirm() and alert() don't exist in a hidden window, so the program gets the answers typed in the code
// lab's Input box, one line per question. console output goes to the console-message listener.
const PRELUDE = (inputs: string[]) => `
(() => {
  const answers = ${JSON.stringify(inputs)};
  const show = (s) => console.info(String(s));
  window.prompt = (q, d) => { if (q !== undefined) show(q); const a = answers.length ? answers.shift() : (d ?? null); if (a !== null) show('> ' + a); return a; };
  window.confirm = (q) => { if (q !== undefined) show(q); const a = answers.length ? answers.shift() : ''; show('> ' + a); return /^(y|yes|ok|true|1)$/i.test(String(a).trim()); };
  window.alert = (m) => show(m ?? '');
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker']) { try { delete window[k]; window[k] = undefined; } catch {} }
})();`;

let running: BrowserWindow | null = null;

export async function runJavaScript(code: string, inputs: string[], timeoutMs = 10_000): Promise<CodeRunResult> {
  running?.destroy();
  const ses = await sandboxSession();
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webgl: false,
      plugins: false,
      spellcheck: false,
      devTools: false,
      navigateOnDragDrop: false,
      enableWebSQL: false,
      backgroundThrottling: false,
      session: ses,
    },
  });
  running = win;
  const wc = win.webContents;
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.setAudioMuted(true);

  const lines: CodeRunLine[] = [];
  let chars = 0;
  let truncated = false;
  const push = (level: CodeRunLine['level'], text: string) => {
    if (lines.length >= MAX_LINES || chars >= MAX_CHARS) {
      truncated = true;
      return;
    }
    const t = text.slice(0, MAX_CHARS - chars);
    chars += t.length;
    lines.push({ level, text: t });
  };
  // Electron passes a details object (newer) or positional arguments (older); accept both.
  wc.on('console-message', (e: any, lvl?: any, msg?: any) => {
    const message = String(e?.message ?? msg ?? '');
    const raw = e?.level ?? lvl;
    const level: CodeRunLine['level'] = raw === 'error' || raw === 3 ? 'error' : raw === 'warning' || raw === 2 ? 'warn' : raw === 'info' ? 'info' : 'log';
    // Electron's own development warnings are not the program's output.
    if (!started || /Electron (Security )?(Warning|Deprecation)/.test(message)) return;
    push(level, message);
  });

  let started = 0;
  let timedOut = false;
  try {
    await win.loadURL('about:blank');
    await wc.executeJavaScript(PRELUDE(inputs.slice(0, 200).map((s) => String(s).slice(0, 1000))), false);
    started = Date.now();
    // An async function body: top-level await works and syntax errors are reported instead of thrown at load.
    const body = JSON.stringify(code);
    const program = `(async () => { try { const AsyncFunction = (async function () {}).constructor; await new AsyncFunction(${body})(); } catch (e) { console.error(e && e.stack ? String(e.stack).split('\\n').slice(0, 4).join('\\n') : String(e)); } })()`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      wc.executeJavaScript(program, false),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    // Give the last console messages a moment to arrive.
    if (!timedOut) await new Promise((r) => setTimeout(r, 60));
  } catch (e) {
    push('error', (e as Error).message);
  } finally {
    if (timedOut) {
      push('error', `Stopped after ${Math.round(timeoutMs / 1000)} seconds. Is there an endless loop, or is it waiting for input?`);
      try {
        wc.forcefullyCrashRenderer();
      } catch {
        /* already gone */
      }
    }
    if (running === win) running = null;
    if (!win.isDestroyed()) win.destroy();
  }
  return { lines, ms: started ? Date.now() - started : 0, timedOut, truncated };
}

export function stopJavaScript(): void {
  if (!running) return;
  try {
    running.webContents.forcefullyCrashRenderer();
  } catch {
    /* already gone */
  }
  running.destroy();
  running = null;
}

// Closing FBRX OS on Linux before the installer replaces it or the uninstaller removes it.
//
// Stopping every FBRX OS process at once (pkill -f) is what Ubuntu's crash reporter sees as a crash: Electron's helper
// processes go down first, and its dialog offers to open FBRX OS again. So FBRX OS is asked to quit its own way
// (`fbrx-os --fbrx-quit`, the same as the Windows installer, which stops the local AI and closes the database), then
// only its main process gets a signal, and only what is still there after that is stopped outright. The built-in AI
// runtime (llama-server, under resources/runtime/ or the data folder) must be gone too before files are removed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';

const APP = /\/linux(-arm64)?-unpacked\/fbrx-os$/;
const RUNTIME = /\/llama-server$/;

/** Every process of this user's that runs one of these programs: its id, program and arguments. */
function processes(match) {
  const out = [];
  let ids = [];
  try {
    ids = readdirSync('/proc').filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid);
  } catch {
    return out;
  }
  for (const id of ids) {
    try {
      // A program rebuilt while it runs reads "… (deleted)".
      const exe = readlinkSync(`/proc/${id}/exe`).replace(/ \(deleted\)$/, '');
      if (!match(exe)) continue;
      const args = readFileSync(`/proc/${id}/cmdline`, 'utf8').split('\0').filter(Boolean);
      out.push({ pid: Number(id), exe, args });
    } catch {
      // Gone already, or another user's.
    }
  }
  return out;
}

/** FBRX OS built by the installer (x64 or arm64): the main process has no --type= (Electron's helpers do). */
export function appProcesses() {
  return processes((exe) => APP.test(exe)).map((p) => ({ ...p, main: !p.args.some((a) => a.startsWith('--type=')) }));
}

/** The built-in AI runtime that belongs to FBRX OS: inside an installed build, or in its data folder. */
export function runtimeProcesses(dataRoot) {
  return processes((exe) => RUNTIME.test(exe) && (/-unpacked\/resources\/runtime\//.test(exe) || (!!dataRoot && exe.startsWith(`${dataRoot}/`))));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(gone, ms) {
  for (let t = 0; t < ms && !gone(); t += 250) await sleep(250);
  return gone();
}

function signal(pids, sig) {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Closes FBRX OS and its AI runtime. Returns whether FBRX OS was running, and what is still running (nothing, unless
 * the processes would not stop). `waitMs` scales each wait (tests use short ones).
 */
export async function quitLinuxApp({ dataRoot, waitMs = 10_000 } = {}) {
  const running = appProcesses();
  if (running.length) {
    const appGone = () => appProcesses().length === 0;
    const main = running.filter((p) => p.main);
    // 1. Its own way: a second copy started with --fbrx-quit tells the running one to quit, and exits.
    const exe = main[0]?.exe;
    if (exe && existsSync(exe)) spawnSync(exe, ['--fbrx-quit'], { stdio: 'ignore', timeout: waitMs });
    // 2. Only the main process: it closes its helpers itself.
    if (!(await waitUntil(appGone, waitMs))) {
      signal(appProcesses().filter((p) => p.main).map((p) => p.pid), 'SIGTERM');
      // 3. Whatever is left (SIGKILL leaves no crash report), the main process first.
      if (!(await waitUntil(appGone, waitMs))) {
        const left = appProcesses().sort((a, b) => Number(b.main) - Number(a.main));
        signal(left.map((p) => p.pid), 'SIGKILL');
        await waitUntil(appGone, waitMs / 2);
      }
    }
  }
  // The AI runtime stops with FBRX OS; one left behind is asked to stop, then stopped.
  const runtimeGone = () => runtimeProcesses(dataRoot).length === 0;
  if (!(await waitUntil(runtimeGone, waitMs / 2))) {
    signal(runtimeProcesses(dataRoot).map((p) => p.pid), 'SIGTERM');
    if (!(await waitUntil(runtimeGone, waitMs / 2))) {
      signal(runtimeProcesses(dataRoot).map((p) => p.pid), 'SIGKILL');
      await waitUntil(runtimeGone, waitMs / 2);
    }
  }
  return { wasRunning: running.length > 0, left: [...appProcesses(), ...runtimeProcesses(dataRoot)] };
}

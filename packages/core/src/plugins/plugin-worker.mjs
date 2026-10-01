// FBRX OS plugin worker. Runs one plugin in an isolated Node process (under the Node permission model when
// sandboxing is on). Every capability is brokered by the host over IPC; see @fbrx/plugin-sdk for the protocol.
import module from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- Isolation, applied before any plugin code loads ---------------------------------------------------------------
// Node's permission model (enabled by the host) confines file access and blocks child processes, workers and native
// addons, but it does not cover the network. A plugin may only reach hosts its manifest declares, through the host's
// ctx.http broker, so direct network and process-control modules and globals are removed here.
const DENIED_BUILTINS = new Set(['net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises', 'child_process', 'cluster', 'worker_threads', 'inspector', 'inspector/promises']);
const isDenied = (id) => DENIED_BUILTINS.has(String(id).replace(/^node:/, ''));
const denied = (id) => Object.assign(new Error(`FBRX plugins cannot use "${id}". Declare "network:<host>" and call ctx.http.fetch instead.`), { code: 'ERR_ACCESS_DENIED' });
if (typeof module.registerHooks !== 'function') throw new Error('This FBRX OS build needs Node 22.15 or newer to run plugins safely');
module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isDenied(specifier)) throw denied(specifier);
    const resolved = nextResolve(specifier, context);
    if (resolved.url?.startsWith('node:') && isDenied(resolved.url)) throw denied(specifier);
    return resolved;
  },
});
// Plugins must not be able to install their own loader hooks in front of ours.
for (const key of ['registerHooks', 'register']) {
  if (typeof module[key] === 'function') module[key] = () => { throw denied(`module.${key}`); };
}
module.syncBuiltinESMExports();
const getBuiltinModule = process.getBuiltinModule?.bind(process);
if (getBuiltinModule) {
  process.getBuiltinModule = (id) => {
    if (isDenied(id)) throw denied(id);
    return getBuiltinModule(id);
  };
}
for (const name of ['fetch', 'WebSocket', 'EventSource']) {
  Object.defineProperty(globalThis, name, {
    configurable: false,
    enumerable: false,
    get() {
      throw denied(name);
    },
  });
}

let plugin = null;
let ctx = null;
let seq = 0;
const pending = new Map();
const inflight = new Map();

const send = (m) => {
  if (process.connected) process.send(m);
};

function request(method, params) {
  const id = `q${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ kind: 'request', id, method, params });
  });
}

const log = (level) => (message, data) => send({ kind: 'log', level, message: String(message), data });
console.log = (...a) => log('info')(a.map(String).join(' '));
console.info = console.log;
console.warn = (...a) => log('warn')(a.map(String).join(' '));
console.error = (...a) => log('error')(a.map(String).join(' '));
console.debug = (...a) => log('debug')(a.map(String).join(' '));

function makeContext(manifest, dataDir) {
  return {
    plugin: { id: manifest.id, version: manifest.version, dataDir },
    log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    storage: {
      get: (key) => request('storage.get', { key }),
      set: (key, value) => request('storage.set', { key, value }),
      delete: (key) => request('storage.delete', { key }),
      keys: () => request('storage.keys', {}),
    },
    secrets: { get: (name) => request('secrets.get', { name }) },
    http: { fetch: (url, init) => request('http.fetch', { url, init: init ?? {} }) },
    notify: (title, body) => request('notify', { title, body }),
  };
}

function describeTool(t) {
  return { name: t.name, title: t.title, description: t.description, risk: t.risk, inputSchema: t.inputSchema };
}

process.on('message', async (m) => {
  try {
    switch (m.kind) {
      case 'init': {
        const mod = await import(pathToFileURL(join(m.root, m.manifest.main)).href);
        plugin = mod.default ?? mod.plugin ?? mod;
        if (!plugin || typeof plugin !== 'object') throw new Error('Plugin entry must export definePlugin({...}) as default');
        ctx = makeContext(m.manifest, m.dataDir);
        if (typeof plugin.activate === 'function') await plugin.activate(ctx);
        const tools = Array.isArray(plugin.tools) ? plugin.tools : [];
        send({ kind: 'ready', tools: tools.map(describeTool) });
        break;
      }
      case 'invoke': {
        const tool = (plugin?.tools ?? []).find((t) => t.name === m.tool);
        if (!tool) {
          send({ kind: 'result', id: m.id, ok: false, error: `Unknown tool ${m.tool}` });
          break;
        }
        const controller = new AbortController();
        inflight.set(m.id, controller);
        try {
          const r = await tool.run(m.input, ctx, { callId: m.callId, origin: m.origin, signal: controller.signal });
          const result = typeof r === 'string' ? { output: r } : { output: String(r?.output ?? ''), data: r?.data };
          send({ kind: 'result', id: m.id, ok: true, result: JSON.parse(JSON.stringify(result)) });
        } catch (err) {
          send({ kind: 'result', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        } finally {
          inflight.delete(m.id);
        }
        break;
      }
      case 'cancel':
        inflight.get(m.id)?.abort();
        break;
      case 'response': {
        const p = pending.get(m.id);
        if (!p) break;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error ?? 'Host request failed'));
        break;
      }
      case 'shutdown':
        try {
          if (typeof plugin?.deactivate === 'function') await plugin.deactivate();
        } finally {
          process.exit(0);
        }
    }
  } catch (err) {
    if (m.kind === 'init') send({ kind: 'init-failed', error: err instanceof Error ? `${err.message}` : String(err) });
    else log('error')(`Worker error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', (err) => {
  log('error')(`Uncaught exception: ${err.message}`);
});
process.on('unhandledRejection', (err) => {
  log('error')(`Unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
});

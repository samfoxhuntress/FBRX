# Developing FBRX

How FBRX is built and how its parts work together, for anyone changing its code. [ARCHITECTURE.md](ARCHITECTURE.md)
goes deeper on the core's security design (governance, audit, fleet protocol); this guide is the map and the recipes.

## The pieces

FBRX is one TypeScript codebase (an npm workspace) that builds several programs:

| Program | What it is | Built from |
| --- | --- | --- |
| **FBRX OS** (the desktop app) | An Electron app: a window made of web pages, with the FBRX core running inside it | `apps/desktop` + `packages/core` |
| **FBRX Command** | The organization's server: devices, policy, licenses, updates, accounts; and its web console | `apps/control-plane` (server), `apps/admin-console` (web page) |
| **FBRX Server** | Debian set up the FBRX way, with roles: virtual machines, AI, gate, image backups | `apps/virtual` (service), `apps/virtual-console` (web page), `scripts/server` (installer) |
| **FBRX Gate, MiniDome** | The router/firewall engine and the threat watcher, used by FBRX Server | `packages/gate`, `packages/dome` |
| **The website** | The static pages with the price list and FBRX accounts | `apps/website` |
| **Phone apps** | The FBRX Mobile web app, also wrapped for the app stores | `packages/core/mobile`, `store/mobile` |

Shared by all of them:

| Package | What is in it |
| --- | --- |
| `packages/shared` | The contract: types, Zod schemas, the API method list, settings and policy shapes, editions, constants. No Node or browser APIs, so every program can import it. |
| `packages/core` | The FBRX core: everything FBRX *does* (AI agent, tools, vault, policy, storage, mesh, fleet agent…). Runs inside the desktop app, on FBRX Server (`fbrx-core` service) and without a screen (`fbrx-headless`). |
| `packages/ui` | The design system: tokens, components, icons, charts, the Markdown renderer. Used by the desktop app and both web consoles. |
| `packages/plugin-sdk` | What third-party plugins import. |

The toolchain: TypeScript everywhere, React for pages, Vite for the web bundles, esbuild for Node and Electron code,
Zod for validating everything that crosses a boundary, Fastify for the HTTP servers, Node's built-in `node:sqlite` for
databases, Vitest for tests, electron-builder for installers. There are **no native modules** (nothing compiled per
platform), so one build works on every operating system and processor.

## Getting started

Requirements: Node.js 22.15 or newer. Then, from the repository root:

```bash
npm install
npm run dev:desktop            # the desktop app with hot reload (development mode unlocks every edition)
npm run verify                 # typecheck + the test suite, as CI runs them
```

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-checks every package at once (one `tsconfig.json` at the root). |
| `npm test` / `npx vitest run packages/core/test/vault.test.ts` | All tests, or one file (always from the root, which holds the Vitest config). |
| `npm run dev:control-plane` + `npm run dev:console` | FBRX Command on :8787 and its console with hot reload on :5173. |
| `npm run dev:virtual` + `npm run dev:virtual-console` | FBRX Virtual with a simulated hypervisor, and its console. |
| `npm run headless -- --dev` | The core without a window (what FBRX Server's ai role runs). |
| `npm run knowledge` | Rebuilds Fabrix's built-in knowledge from README.md and docs/ (run it after changing any guide). |
| `npm run build` | Builds everything, as the release does. |

The app keeps its data in one folder (`%APPDATA%\FBRX OS`, `~/Library/Application Support/FBRX OS`,
`~/.config/fbrx-os`). Set `FBRX_HOME=/some/folder` to run against a throwaway copy while developing.

## How the desktop app works

An Electron app is three kinds of program working together. FBRX keeps them strictly apart:

```
┌──────────────────────── main process (Node.js) ─────────────────────────┐
│ apps/desktop/src/main/index.ts                                          │
│   windows, tray, menus, global shortcuts, updates, clipboard            │
│   ┌──────────────────────── the FBRX core ───────────────────────────┐  │
│   │ packages/core: Kernel → services → SQLite, vault, agent, tools…  │  │
│   └──────────────────────────────────────────────────────────────────┘  │
└───────────────▲──────────────────────────────────────┬──────────────────┘
   ipcRenderer.invoke('fbrx:call', method, params)     │ webContents.send('fbrx:event', name, payload)
┌───────────────┴──────── preload (bridge) ────────────▼──────────────────┐
│ apps/desktop/src/preload/index.ts: exposes window.fbrx, nothing else    │
└───────────────▲──────────────────────────────────────┬──────────────────┘
                │ window.fbrx.call(...)                │ window.fbrx.on(...)
┌───────────────┴──────── renderer (web page) ─────────▼──────────────────┐
│ apps/desktop/src/renderer: React, one page per route (#/vault, …)       │
└─────────────────────────────────────────────────────────────────────────┘
```

**The main process** (`src/main/index.ts`) starts first. It creates the `Kernel` with an Electron *platform adapter*
(`src/main/platform.ts`: the OS keychain through `safeStorage`, notifications, updates, the folders of this operating
system), opens the windows, and registers the IPC handlers (`registerIpc`). Every handler first checks `trusted(e)`:
only FBRX's own pages may call in, never a web page in FBRX Browser. It forwards every core event to every open window.
Other files in `src/main/` are the parts only Electron can do: FBRX Browser's window and its guards (`browser.ts`),
the clipboard history, FBRX Snapshot, the code lab's sandboxed runner, turning documents into PDFs, updates.

**The preload** (`src/preload/index.ts`) runs before the page, with access to Electron's IPC. It hands the page one
object, `window.fbrx` (`call`, `on`, dialogs, copy, open a window…), through `contextBridge`. Pages run with
`contextIsolation` and `sandbox` on: they cannot touch Node.js, the file system or Electron at all. Everything a page
does goes through `window.fbrx`. (`src/preload/autofill.ts` is a second, separate preload: the Vault's sign-in helper
in FBRX Browser's web pages, see [VAULT.md](VAULT.md).)

**The renderer** (`src/renderer/`) is a React single-page app. `main.tsx` mounts `app.tsx`, which holds the sidebar
(`all` nav items), the routes (`location.hash`, `#/vault/keys`) and lazily loaded pages (`pages/*.tsx`). Pages talk
to the core through `client.ts`:

* `call('passwords.list')`: one request, typed from the contract (wrong method names or parameters don't compile).
* `useCore('passwords.list', undefined, ['vault.changed'])` (`hooks.ts`): loads the data, and loads it again when
  one of the named events arrives. Most pages are built from this.
* `onEvent('passwords.saveRequested', cb)`: reacts to something the core announces.

The same renderer bundle serves the other windows (Spotlight, pop-outs, FBRX Browser, the clipboard picker, the
goose overlay): the main process opens it with a different route or query string (`?browser=1`, `?popout=1`).

### The life of a click

Saving a sign-in on the Vault page, end to end:

1. `pages/vault.tsx` → `call('passwords.save', { title, urls, username, password })`.
2. `client.ts` → `window.fbrx.call(...)` → the preload → `ipcRenderer.invoke('fbrx:call', 'passwords.save', params)`.
3. Main process, `ipcMain.handle('fbrx:call')` → `kernel.call('passwords.save', params, { origin: 'user', actor })`.
4. `Kernel.call` (`packages/core/src/kernel.ts`) finds the handler, refuses it if the method is *user only* and the
   origin is not a person at the computer (the Local API, a remote command, the agent), runs it, and writes an audit
   entry for anything that changes something (secrets scrubbed).
5. The handler (`packages/core/src/api/core-api.ts`) validates the parameters with Zod and calls the service:
   `k.passwords.save(LoginSchema.parse(p))`.
6. `Passwords.save` (`packages/core/src/vault/passwords.ts`) encrypts the sign-in with the vault key and writes it to
   SQLite, then announces `vault.changed` on the kernel's event bus.
7. The main process sends the event to every window; `useCore(..., ['vault.changed'])` on any open page reloads.

The result (or a `CoreError` with a code and a plain-words message) travels back the same way.

## The core (`packages/core`)

The core is a library: something creates a `Kernel` and calls it. The desktop app, `fbrx-headless` and FBRX Server's
`fbrx-core` service all do, with different platform adapters. Nothing in the core imports Electron.

```
packages/core/src/
  kernel.ts           the Kernel: creates every service, registers them, routes kernel.call to the API
  api/                the API handlers: core-api.ts (core methods), ext-api.ts (command-center methods)
  services/           ServiceManager: start order, health checks every 15 s, restart with backoff
  storage/            db.ts (node:sqlite), migrations.ts (the numbered schema changes), meta.ts
  settings/           settings in layers: defaults → local → managed (from FBRX Command, can lock paths)
  governance/         ToolGate, the policy engine, path/network guards, guardian, approvals, rate limits, redactor
  vault/              the vault (secrets), the password keeper, 2-step codes
  audit/              the hash-chained audit log
  ai/                 the agent loop, providers (local runtime, Ollama, OpenAI-compatible, Claude), memory,
                      conversations, attachments, thinking levels, the local runtime (llama-server) and models
  tools/              the tool registry and every built-in tool (tools/builtin/*.ts)
  plugins/ connectors/  third-party tools: plugins in sandboxed Node processes, MCP and REST connections
  mesh/ fleet/        FBRX Mesh (computers talking to each other) and the FBRX Command agent (enroll, sync, commands)
  system/ network/ windows/ protection/ …   the command-center features (monitor, net tools, PC care, Shield…)
  knowledge/          Fabrix's built-in knowledge (docs.generated.ts is generated: never edit it by hand)
```

**The contract.** Every method has a name and a type in `packages/shared/src/api.ts` (`CoreMethods`) or
`packages/shared/src/ext.ts` (`ExtMethods`), and a handler in `api/core-api.ts` or `api/ext-api.ts`. Events are typed
the same way (`CoreEvents`, `ExtEvents`). The renderer, the Local API and FBRX Command all call these same methods, so
a feature built once works from the page, from scripts and remotely, under the same rules.

**Origins.** Every call says who is asking: `user` (a person at this computer), `agent` (Fabrix), `api` (the Local
API), `remote` (FBRX Command), `scheduler`. Methods that reveal or change secrets, sign in, or change governance are
listed in `USER_ONLY` (core-api.ts) or `EXT_USER_ONLY` (shared/ext.ts): only a person at the computer may call them.

**Services.** Each subsystem registers itself in `Kernel` (`s.register({ name, dependsOn, start, stop, health })`).
`ServiceManager` starts them in dependency order, health-checks them, restarts a failed one with backoff and stops
retrying after five failures in ten minutes (the person and FBRX Command are told).

**Storage.** One SQLite database (`fbrx.db`). The schema only ever moves forward through `storage/migrations.ts`: each
entry has a `version`, a `name` and the SQL that takes the previous version to this one. Never edit a migration that
has shipped; add the next one.

**Settings and policy** are Zod schemas in `packages/shared/src/settings.ts` and `policy.ts`, with their defaults
(`DEFAULT_SETTINGS`). Values are stored in layers: the defaults, what the person changed (local) and what FBRX Command
manages (managed, which can *lock* a path so the page shows it read-only and the API refuses it).

### The agent

`ai/agent.ts` runs Fabrix's loop: build the request (instructions, the chat so far, the tools it may use), stream the
model's answer, run each tool call it asks for through the gate, add the results, and repeat until it answers or uses
up its steps (the *Thinking* level). Providers (`ai/providers/`) turn that one request shape into each service's own
API. A model on the computer or the local network gets a short list of tools (`ai/tool-shortlist.ts`) so it has less
to read; a cloud AI gets them all.

**Tools** are plain objects (`ToolSpec` in `tools/types.ts`): a dotted name (`passwords.find`), a title, a
description the model reads, a risk (`read`, `write`, `execute`, `network`, `sensitive`), a JSON Schema for its input,
and `run()`. Every call, from Fabrix, a page, a plugin or FBRX Command, goes through `ToolGate`
(`governance/tool-gate.ts`): license → enabled → input schema → rate limit → policy (folders, sites, commands, rules)
→ guardian (destructive commands, prompt injection) → approval (ask the person) → run with a timeout → scrub secrets
from the output → audit. The model only ever sees the tool's output after all of that.

## The servers

**FBRX Command** (`apps/control-plane`) is a Fastify server with its own SQLite database (`src/migrations.ts`) and
routes per area (`src/routes/`: devices, the admin API, accounts, billing, help desk, updates). Computers enroll with
a token and then hold a WebSocket open to it for settings, policy, commands and heartbeats (see *Fleet protocol* in
ARCHITECTURE.md). Its web console is `apps/admin-console`, a React app that calls the admin API (`src/api.ts`).

**FBRX Server** is Debian 13 plus:

* `fbrx-virtual` (`apps/virtual`): the web console's server on port 9443 and the roles' APIs (`src/routes/`: virtual
  machines through libvirt, the hardware map and BIOS, storage, FBRX Gate, MiniDome, FBRX Time, roles). Its console
  is `apps/virtual-console`.
* `fbrx-core`: the FBRX core in server mode (`packages/core/bin/fbrx-headless.ts`), for the ai role.
* `scripts/server/install.sh` installs and changes roles; `fbrx-server` is the server's command line (roles,
  updates, status); `bundle.sh` makes the tarball and `build-iso.sh` the installer ISO. Roles are listed in
  `SERVER_ROLE_CATALOG` (`packages/shared/src/virtual.ts`).

## Recipes

### Change a page

Find it in `apps/desktop/src/renderer/pages/` (the route name is the file name: `#/vault` → `vault.tsx`). Components
come from `@fbrx/ui` (`Button`, `Card`, `Toggle`, `Modal`, icons…); styles are in `desktop.css` (FBRX's classes) and
`theme.css` (the themes' colors, as CSS variables: use `var(--accent)` and friends, never fixed colors, so every theme
and dark mode work). With `npm run dev:desktop` running, saving the file updates the window.

### Add a setting

1. `packages/shared/src/settings.ts`: add the field to the schema (with a comment saying what it does) and its value
   to `DEFAULT_SETTINGS`.
2. Read it in the core with `this.settings.get().section.field` (or `kernel.settings.get()`).
3. Show it in `pages/settings.tsx`: `s.section.field` to read, `patch({ section: { field: value } })` to change it,
   `L('section.field')` to know whether FBRX Command locked it.

Existing installs pick up the default automatically: stored settings are merged over the defaults.

### Add a core method and call it from a page

1. The type: add `'area.verb': (p: {...}) => Result` to `CoreMethods` in `packages/shared/src/api.ts` (command-center
   features go in `ExtMethods`, `shared/src/ext.ts`).
2. The handler: in `api/core-api.ts` (or `ext-api.ts`), validate with Zod and call the service:
   `'area.verb': (p) => k.area.verb(Schema.parse(p))`.
3. If it reveals a secret or changes something only the person should, add it to `USER_ONLY`. If it only reads, make
   sure its name matches `READ_ONLY` (it then skips the audit log).
4. Call it: `await call('area.verb', {...})` or `useCore('area.verb', {...}, ['area.changed'])`.
5. Test it through the kernel (below).

### Add a database table

Add the next entry at the end of `packages/core/src/storage/migrations.ts`:

```ts
{
  version: 16,
  name: 'my-feature',
  up: `CREATE TABLE my_things (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);`,
},
```

The database migrates itself when FBRX starts. Anything private is stored sealed with the vault key (see
`vault/passwords.ts`, which calls `vault.seal()`), never as plain text.

### Give Fabrix a new tool

1. Write it in `packages/core/src/tools/builtin/` as a function returning `ToolSpec[]` (see `password-tools.ts`). The
   description is what the model reads: say what it does and when to use it, in plain words.
2. Pick the risk honestly: `read` runs without asking, `write`/`execute` ask by default, `network` is refused in an
   offline chat until the person allows it. The policy decides the rest.
3. Register it in `kernel.ts` (`this.registry.registerMany([...])` in the `tools` service).
4. If a local model should find it, add its name's prefix to a group in `ai/tool-shortlist.ts`, with the words that
   bring it in.

### Add a page to the sidebar

1. Write `pages/my-page.tsx` exporting `MyPage`.
2. In `app.tsx`: a `lazy(() => import('./pages/my-page')...)` line, the route name in the `Route` type, an entry in the
   `all` nav list (`{ id, label, icon, section, need? }`, where `need: 'ultra'` limits it to an edition) and a `case` in
   the page switch.

### Announce something from the core

Add the event and its payload to `CoreEvents` (or `ExtEvents`), then `this.events.emit('my.event', payload)` in the
core. The desktop app forwards every event to its windows; pages listen with `onEvent` or `useCore`'s event list.

### Make something depend on the edition

Editions and their features are in `packages/shared/src/license.ts` (`EDITION_FEATURES`). In the core, a tool takes
`feature: 'x'` or `unavailable: () => reason`; a service checks `this.license.has('x')`. In the renderer,
`useAtLeast('ultra')` (`edition.tsx`) or `need:` on a nav item. The core always enforces it; the page only hides it.

## Tests

Tests live next to each package (`packages/*/test`, `apps/*/test`) and run from the root with Vitest.

* **Core tests** create a real kernel in a temporary folder: `const { kernel, cleanup } = await makeKernel()`
  (`packages/core/test/helpers.ts`), then call it as a page would: `kernel.call('passwords.save', {...}, USER)`.
  `mock-llm.ts` is a fake AI service (OpenAI-compatible) that answers with whatever the test scripts, including tool
  calls, so agent behavior is tested without a model.
* **Server tests** start the Fastify app on a random port and call its HTTP API (`apps/control-plane/test`,
  `apps/virtual/test`); FBRX Virtual runs against a simulated hypervisor, and CI also runs it against a real one.
* **The desktop app** can be driven with Playwright's Electron support (`_electron.launch`) for end-to-end checks of
  windows and pages.
* `knowledge.test.ts` fails when the guides changed but `npm run knowledge` was not run.

## Building and releasing

* `apps/desktop/scripts/build.mjs` builds the app: esbuild for the main process (ESM) and the preloads (CommonJS),
  Vite for the renderer, plus the icons, the plugin worker, the MCP bridge and FBRX Mobile. `scripts/package.mjs` runs
  electron-builder (`electron-builder.yml`) for the installers: Windows (NSIS), macOS (dmg), Linux (AppImage, deb).
* **CI** (`.github/workflows/ci.yml`) runs the typecheck, the tests and every build on Linux, macOS and Windows, and
  tests FBRX Server against a real hypervisor and FBRX Gate as a real router.
* **Releases** go through the *Release* workflow (`release.yml`, started by a version tag or by hand): it builds
  and signs the installers, the FBRX Server bundle and ISO and the FBRX Command image, and publishes them as a GitHub
  release. Then `release.json` at the root is updated: it is what every installed FBRX reads to learn that a new
  version is out. The version numbers live in each app's `package.json`.

## Conventions

* **Words.** Everything a person reads is plain words, no jargon and no other companies' brand names. Errors say what
  happened and what to do (`CoreError('UNAVAILABLE', 'The Vault is locked: unlock it to fill in sign-ins')`).
* **Comments** say *why*, wrap at 120 columns, and match the code around them. Code follows the file it is in.
* **Security.** Validate every input that crosses a boundary with Zod. Never give a page Node.js or Electron. Secrets
  stay in the core: tools refer to them by name, and the redactor scrubs their values from anything a model sees.
  Anything the agent can do goes through the gate.
* **Docs.** A feature a person uses has a guide in `docs/`; after changing one, run `npm run knowledge` so Fabrix
  knows it too.

## Where to look

| When you want to change… | Look in |
| --- | --- |
| What a page shows or how it looks | `apps/desktop/src/renderer/pages/`, `desktop.css`, `theme.css`, `packages/ui` |
| The sidebar, routes, top bar | `apps/desktop/src/renderer/app.tsx` |
| Windows, tray, shortcuts, the clipboard | `apps/desktop/src/main/index.ts` |
| What a button does in the core | the method in `packages/core/src/api/*.ts`, then the service it calls |
| How Fabrix answers, its instructions | `packages/core/src/ai/agent.ts` (`systemPrompt`) |
| A tool Fabrix uses | `packages/core/src/tools/builtin/` |
| What is allowed, what asks first | `packages/shared/src/policy.ts` (defaults), `packages/core/src/governance/` |
| A setting and its default | `packages/shared/src/settings.ts` |
| Editions and prices | `packages/shared/src/license.ts`, `editions.ts`, `plans.ts` |
| The installer for people | `scripts/setup/` (the setup wizard), `apps/desktop/build/` (installer scripts) |
| FBRX Server | `apps/virtual`, `apps/virtual-console`, `scripts/server` |
| FBRX Command | `apps/control-plane`, `apps/admin-console` |

# FBRX OS: working in this repository

An npm workspaces monorepo: `packages/*` (core, shared, ui, gate, dome), `apps/*` (desktop, control-plane,
admin-console, virtual, website), `plugins/*`. The desktop app (FBRX OS, `apps/desktop`) runs the core
(`packages/core`) in Electron; FBRX Command is `apps/control-plane` with `apps/admin-console`.

## Checks before a commit

* `npx tsc -p tsconfig.json --noEmit` and the tests that cover the change: `npx vitest run <paths>`.
* After changing anything in `docs/`, run `npm run knowledge` (Fabrix answers from the generated
  `packages/core/src/knowledge/docs.generated.ts`; never edit or search that file by hand).
* Do not run prettier over whole files: the repository is not prettier-clean.
* Comments wrap at 120 columns. Keep the code consistent with what is around it.

## Docs: user guides only

* `docs/` holds the **user guides**: how to use FBRX, and nothing else. They ship inside the app (Fabrix's knowledge)
  and are the website's help. Building, releasing, selling and running the FBRX service go in `internal/`, which never
  ships; user guides do not link into it.
* There is no README: what FBRX is, and how to get it, is on the website (`apps/website`) and in `docs/INSTALL.md`.

## FBRX Digger follows the network tools

FBRX Digger (`docs/DIGGER.md`) is the desktop app's **digger flavor**: the Network Center on its own, with every
network tool. **Any change to the network tooling is a change to Digger**: the Network Center pages
(`apps/desktop/src/renderer/pages/network*.tsx`, `wifi-channels.tsx`, `../consoles.tsx`) and the core's
`packages/core/src/network`, consoles and network environments. With such a change:

1. Make sure it works in Digger: no dependency on the AI, on the edition (gate Ultra parts in the core with
   `kernel.networkTools()`, which is always on in Digger) or on pages Digger does not show.
2. A new page or settings tab joins `DIGGER_PAGES` or `DIGGER_SETTINGS` in `packages/shared/src/digger.ts`.
3. Update `docs/DIGGER.md`.
4. Raise `DIGGER_VERSION` and release Digger (the **FBRX Digger** workflow, `digger-v<version>`) alongside the FBRX OS
   release that carries the change; then add or update the `digger` entry in `release.json`.

## Releases

* `release.json` on the default branch is live: FBRX OS installs read it. Commit it only after the release it
  describes is published.
* FBRX OS releases come from the **Release** workflow (manual run: version, channel, release, installers); FBRX Digger
  from the **FBRX Digger** workflow.

## Wording

Product and marketing text names no other company's trademarked characters or brands beyond plain compatibility
facts (an app FBRX connects to, a file format).

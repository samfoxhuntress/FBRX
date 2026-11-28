import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { DIGGER_NAME, PRODUCT_NAME, VIEW_NAME, type AppFlavor } from '@fbrx/shared';

/**
 * Which app this build is: FBRX OS, FBRX Digger (the Network Center on its own) or FBRX View (the remote desktop app).
 * A Digger or View package says so in its package.json (electron-builder.digger.yml and electron-builder.view.yml add
 * fbrxFlavor); FBRX_FLAVOR=digger or FBRX_FLAVOR=view does the same in development. Each keeps its own name, and so its
 * own data folder and single-instance lock, next to an installed FBRX OS.
 */
const known = (v: unknown): AppFlavor | null => (v === 'digger' || v === 'view' ? v : null);

export const FLAVOR: AppFlavor = (() => {
  const env = known(process.env.FBRX_FLAVOR);
  if (env) return env;
  try {
    return known(JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).fbrxFlavor) ?? 'os';
  } catch {
    return 'os';
  }
})();

/** FBRX Digger or FBRX View: an app of the family beside FBRX Endpoint. */
export const SIDE_APP = FLAVOR !== 'os';

export const APP_NAME = FLAVOR === 'digger' ? DIGGER_NAME : FLAVOR === 'view' ? VIEW_NAME : PRODUCT_NAME;

/** The window and tray icon in the app's assets. */
export const APP_ICON = FLAVOR === 'digger' ? 'digger-icon.png' : FLAVOR === 'view' ? 'view-icon.png' : 'icon.png';

if (SIDE_APP && app.getName() !== APP_NAME) {
  app.setName(APP_NAME);
  app.setPath('userData', join(app.getPath('appData'), APP_NAME));
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { DIGGER_NAME, PRODUCT_NAME, type AppFlavor } from '@fbrx/shared';

/**
 * Which app this build is: FBRX OS, or FBRX Digger (the Network Center on its own). A Digger package says so in its
 * package.json (electron-builder.digger.yml adds fbrxFlavor); FBRX_FLAVOR=digger does the same in development. Digger
 * keeps its own name, and so its own data folder and single-instance lock, next to an installed FBRX OS.
 */
export const FLAVOR: AppFlavor = (() => {
  if (process.env.FBRX_FLAVOR === 'digger') return 'digger';
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).fbrxFlavor === 'digger' ? 'digger' : 'os';
  } catch {
    return 'os';
  }
})();

export const APP_NAME = FLAVOR === 'digger' ? DIGGER_NAME : PRODUCT_NAME;

if (FLAVOR === 'digger' && app.getName() !== DIGGER_NAME) {
  app.setName(DIGGER_NAME);
  app.setPath('userData', join(app.getPath('appData'), DIGGER_NAME));
}

// electron-builder afterPack hook (electron-builder.yml and electron-builder.digger.yml).
//
// On Linux the .deb and the AppImage take every file with the mode it has in the folder electron-builder made, and
// Electron's own files (the fbrx-os executable, its libraries, locales, snapshots) arrive there group- and
// world-writable (0666 and 0777): installed under /opt as root, anyone on the computer could replace the program the
// next person runs. So before the packages are made, every folder and program gets 0755 and every other file 0644.
const { chmodSync, lstatSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

/** 0755 for folders and anything executable, 0644 for the rest; links are left as they are. */
function normalize(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      chmodSync(path, 0o755);
      normalize(path);
    } else chmodSync(path, st.mode & 0o111 ? 0o755 : 0o644);
  }
}

exports.normalize = normalize;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  chmodSync(context.appOutDir, 0o755);
  normalize(context.appOutDir);
};

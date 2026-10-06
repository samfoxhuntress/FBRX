import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Db } from '@fbrx/shared/node';
import { Auth } from './auth';
import { Audit } from './audit';
import { loadConfig } from './config';
import { VIRTUAL_MIGRATIONS } from './migrations';

/**
 * Server-side helpers for FBRX Virtual, run on the server itself (fbrx-server reset-password ...): for when nobody can
 * sign in any more.
 */
const [cmd, ...args] = process.argv.slice(2);
const config = loadConfig();
const db = new Db(join(config.dataDir, 'virtual.db'));
db.migrate(VIRTUAL_MIGRATIONS);
const auth = new Auth(db, config.sessionHours);
const audit = new Audit(db);
const newPassword = () => randomBytes(12).toString('base64url');

try {
  switch (cmd) {
    case 'reset-password': {
      const username = args[0];
      const user = auth.listUsers().find((u) => u.username.toLowerCase() === String(username ?? '').toLowerCase());
      if (!user) throw new Error(username ? `No user called ${username}. Users: ${auth.listUsers().map((u) => u.username).join(', ') || 'none'}` : 'Usage: reset-password <username>');
      const password = newPassword();
      await auth.updateUser(user.id, { password });
      audit.record('console', 'user.password-reset', user.username);
      console.log(`New password for ${user.username}: ${password}\nSign in and change it (Users & audit → My password).`);
      break;
    }
    case 'create-admin': {
      const username = args[0] ?? 'admin';
      const password = newPassword();
      await auth.createUser({ username, name: username, password, role: 'admin' });
      audit.record('console', 'user.create', username, 'success', { role: 'admin' });
      console.log(`Administrator ${username} created. Password: ${password}`);
      break;
    }
    case 'users':
      for (const u of auth.listUsers()) console.log(`${u.username.padEnd(20)} ${u.role.padEnd(9)} last sign-in ${u.lastLoginAt ?? 'never'}`);
      break;
    default:
      console.log('FBRX Virtual server helpers:\n  users                     list who can sign in\n  reset-password <username> give someone a new password\n  create-admin [username]   add an administrator');
      process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}

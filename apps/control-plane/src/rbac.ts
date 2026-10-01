/** Roles: `superadmin` is the vendor/platform operator (no tenant); the rest are scoped to one tenant. */
export const ROLES = ['superadmin', 'owner', 'admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const TENANT_ROLES: Role[] = ['owner', 'admin', 'operator', 'viewer'];

export const PERMISSIONS = {
  'tenants.manage': ['superadmin'],
  'releases.manage': ['superadmin'],
  'licenses.manage': ['superadmin'],
  'licenses.read': ['superadmin', 'owner', 'admin'],
  'users.manage': ['superadmin', 'owner', 'admin'],
  'apikeys.manage': ['superadmin', 'owner', 'admin'],
  'devices.read': ['superadmin', 'owner', 'admin', 'operator', 'viewer'],
  'devices.manage': ['superadmin', 'owner', 'admin', 'operator'],
  'commands.send': ['superadmin', 'owner', 'admin', 'operator'],
  'commands.privileged': ['superadmin', 'owner', 'admin'],
  'config.manage': ['superadmin', 'owner', 'admin'],
  'secrets.manage': ['superadmin', 'owner', 'admin'],
  'enrollment.manage': ['superadmin', 'owner', 'admin'],
  'packages.manage': ['superadmin', 'owner', 'admin'],
  'snapshots.manage': ['superadmin', 'owner', 'admin'],
  'webhooks.manage': ['superadmin', 'owner', 'admin'],
  'audit.read': ['superadmin', 'owner', 'admin'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/** Roles a given role may assign to others (never above itself; only superadmins create superadmins). */
export function assignableRoles(role: Role): Role[] {
  switch (role) {
    case 'superadmin':
      return [...ROLES];
    case 'owner':
      return ['owner', 'admin', 'operator', 'viewer'];
    case 'admin':
      return ['admin', 'operator', 'viewer'];
    default:
      return [];
  }
}

/** Commands that can change data or run the agent need a more trusted role. */
export const PRIVILEGED_COMMANDS = new Set(['agent.run', 'plugin.install', 'plugin.uninstall', 'update.install', 'vault.lock', 'app.restart', 'backup.create']);

import { z } from 'zod';

/**
 * Remote commands an administrator can send from the control plane to a device.
 * Each command has a typed payload; devices reject unknown types.
 */
export const CommandPayloadSchemas = {
  ping: z.object({}).default({}),
  'config.sync': z.object({}).default({}),
  'update.check': z.object({}).default({}),
  'update.install': z.object({ restartNow: z.boolean().default(false) }).default({ restartNow: false }),
  'backup.create': z
    .object({
      label: z.string().max(120).optional(),
      /** Upload the encrypted snapshot to the control plane after creating it. */
      upload: z.boolean().default(true),
    })
    .default({ upload: true }),
  'plugin.install': z.object({ packageId: z.string(), url: z.string(), sha256: z.string().length(64) }),
  'plugin.setEnabled': z.object({ id: z.string(), enabled: z.boolean() }),
  'plugin.uninstall': z.object({ id: z.string() }),
  'service.restart': z.object({ name: z.string() }),
  'diagnostics.collect': z.object({ auditEntries: z.number().int().min(0).max(1000).default(100) }).default({ auditEntries: 100 }),
  notify: z.object({ title: z.string().max(200), body: z.string().max(2000) }),
  'agent.run': z.object({ prompt: z.string().min(1).max(20000), providerId: z.string().optional(), model: z.string().optional() }),
  'vault.lock': z.object({}).default({}),
  'app.restart': z.object({}).default({}),
} as const;

export type CommandType = keyof typeof CommandPayloadSchemas;
export const COMMAND_TYPES = Object.keys(CommandPayloadSchemas) as CommandType[];

export const COMMAND_DESCRIPTIONS: Record<CommandType, string> = {
  ping: 'Round-trip connectivity check',
  'config.sync': 'Pull the latest managed configuration, policy, secrets and license',
  'update.check': 'Check the update feed for a newer version',
  'update.install': 'Download and install the assigned version',
  'backup.create': 'Create an encrypted snapshot (optionally uploaded to the control plane)',
  'plugin.install': 'Install a plugin package from the control plane',
  'plugin.setEnabled': 'Enable or disable a plugin',
  'plugin.uninstall': 'Remove a plugin',
  'service.restart': 'Restart an internal service',
  'diagnostics.collect': 'Collect system, service and audit diagnostics',
  notify: 'Show a notification to the workstation user',
  'agent.run': 'Run the governed AI agent with a prompt and return its answer',
  'vault.lock': 'Lock the credential vault on the device',
  'app.restart': 'Restart the FBRX OS application',
};

export const COMMAND_STATUSES = ['queued', 'sent', 'running', 'succeeded', 'failed', 'expired', 'cancelled'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export interface DeviceCommand {
  id: string;
  type: CommandType;
  payload: unknown;
  createdAt: string;
  expiresAt: string | null;
}

export function isCommandType(t: string): t is CommandType {
  return Object.prototype.hasOwnProperty.call(CommandPayloadSchemas, t);
}

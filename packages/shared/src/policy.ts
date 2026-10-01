import { z } from 'zod';

export const RISK_LEVELS = ['read', 'write', 'execute', 'network', 'sensitive'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const POLICY_ACTIONS = ['allow', 'ask', 'deny'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const TOOL_SOURCES = ['builtin', 'plugin', 'connector', '*'] as const;

export const PolicyRuleSchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  match: z.object({
    /** Glob over tool names, e.g. `fs.*`, `mcp.github.*`. */
    tool: z.string().optional(),
    source: z.enum(TOOL_SOURCES).optional(),
    risk: z.enum(RISK_LEVELS).optional(),
  }),
  action: z.enum(POLICY_ACTIONS),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicySchema = z.object({
  version: z.literal(1),
  /** `enforce` blocks violations; `audit` records violations but lets the call proceed. */
  mode: z.enum(['enforce', 'audit']),
  defaultAction: z.enum(POLICY_ACTIONS),
  riskDefaults: z.object({
    read: z.enum(POLICY_ACTIONS),
    write: z.enum(POLICY_ACTIONS),
    execute: z.enum(POLICY_ACTIONS),
    network: z.enum(POLICY_ACTIONS),
    sensitive: z.enum(POLICY_ACTIONS),
  }),
  /** First matching rule wins. Rules are evaluated before risk defaults. */
  rules: z.array(PolicyRuleSchema),
  filesystem: z.object({
    /** Roots the agent may touch. Supports `~`, `${HOME}`, `${DOCUMENTS}`, `${DESKTOP}`, `${DOWNLOADS}`, `${WORKSPACE}`. */
    allowedRoots: z.array(z.string()),
    /** Globs that are never readable or writable (matched against absolute paths). */
    denyPatterns: z.array(z.string()),
    readOnly: z.boolean(),
    maxFileBytes: z.number().int().positive(),
  }),
  network: z.object({
    /** `*` permits all hosts. Entries may use a leading wildcard: `*.example.com`. */
    allowedDomains: z.array(z.string()),
    blockedDomains: z.array(z.string()),
    allowPrivateNetworks: z.boolean(),
  }),
  shell: z.object({
    enabled: z.boolean(),
    /** Regular expressions. A matching command is always denied, even if approved. */
    blockedPatterns: z.array(z.string()),
    timeoutSeconds: z.number().int().min(1).max(3600),
  }),
  ai: z.object({
    allowCloudProviders: z.boolean(),
    /** Provider ids allowed; empty means all configured providers. */
    allowedProviders: z.array(z.string()),
    maxStepsPerRun: z.number().int().min(1).max(100),
    maxToolCallsPerRun: z.number().int().min(0).max(500),
    /** Run the guardian's model-based review in addition to its deterministic checks. */
    guardianModelReview: z.boolean(),
  }),
  data: z.object({
    /** Scrub vault secret values and common credential formats from tool output before it reaches a model. */
    redactSecrets: z.boolean(),
  }),
  rateLimits: z.object({
    toolCallsPerMinute: z.number().int().min(1).max(10000),
  }),
  approvals: z.object({
    timeoutSeconds: z.number().int().min(10).max(86400),
    /** Allow "always allow this tool" choices that persist as local rules. */
    allowRemember: z.boolean(),
  }),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  version: 1,
  mode: 'enforce',
  defaultAction: 'ask',
  riskDefaults: {
    read: 'allow',
    write: 'ask',
    execute: 'ask',
    network: 'allow',
    sensitive: 'ask',
  },
  rules: [
    {
      id: 'builtin-memory',
      description: 'Agent memory never leaves FBRX OS, so remembering and forgetting needs no approval',
      match: { tool: 'memory.*', source: 'builtin' },
      action: 'allow',
    },
  ],
  filesystem: {
    allowedRoots: ['${HOME}', '${WORKSPACE}'],
    denyPatterns: [
      '**/.ssh/**',
      '**/.gnupg/**',
      '**/.aws/credentials',
      '**/.kube/config',
      '**/*.pem',
      '**/*.key',
      '**/id_rsa*',
      '**/id_ed25519*',
      '**/Library/Keychains/**',
      '**/AppData/Roaming/Microsoft/Credentials/**',
    ],
    readOnly: false,
    maxFileBytes: 5 * 1024 * 1024,
  },
  network: {
    allowedDomains: ['*'],
    blockedDomains: [],
    allowPrivateNetworks: false,
  },
  shell: {
    enabled: true,
    blockedPatterns: [
      String.raw`\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(/|~|\$HOME|\*)(\s|$)`,
      String.raw`\bmkfs(\.\w+)?\b`,
      String.raw`\bdd\s+.*\bof=/dev/`,
      String.raw`:\(\)\s*\{\s*:\|:&\s*\};:`,
      String.raw`\bformat\s+[a-zA-Z]:`,
      String.raw`\bdiskpart\b`,
      String.raw`\bshutdown\b`,
      String.raw`\bRemove-Item\b.*-Recurse.*\b[A-Za-z]:\\\s*$`,
      String.raw`\bcurl\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b`,
      String.raw`\bwget\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b`,
    ],
    timeoutSeconds: 120,
  },
  ai: {
    allowCloudProviders: true,
    allowedProviders: [],
    maxStepsPerRun: 12,
    maxToolCallsPerRun: 40,
    guardianModelReview: false,
  },
  data: {
    redactSecrets: true,
  },
  rateLimits: {
    toolCallsPerMinute: 60,
  },
  approvals: {
    timeoutSeconds: 300,
    allowRemember: true,
  },
};

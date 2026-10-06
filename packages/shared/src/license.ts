import { z } from 'zod';

export const EDITIONS = ['community', 'pro', 'enterprise'] as const;
export type Edition = (typeof EDITIONS)[number];

/** Feature flags that a license can unlock. */
export const FEATURES = {
  'agent.local': 'Built-in local AI agent',
  'agent.cloud': 'Cloud AI providers (Anthropic, OpenAI, …)',
  plugins: 'Third-party plugins',
  connectors: 'REST / webhook connectors',
  'connectors.mcp': 'Model Context Protocol connectors',
  'backup.scheduled': 'Scheduled encrypted backups',
  fleet: 'Fleet management via control plane',
  localapi: 'Local automation API',
  'guardian.model': 'Model-assisted guardian review',
} as const;
export type Feature = keyof typeof FEATURES;
export const ALL_FEATURES = Object.keys(FEATURES) as Feature[];

export const EDITION_FEATURES: Record<Edition, Feature[]> = {
  community: ['agent.local', 'agent.cloud', 'connectors', 'localapi'],
  pro: ['agent.local', 'agent.cloud', 'plugins', 'connectors', 'connectors.mcp', 'backup.scheduled', 'localapi'],
  enterprise: ALL_FEATURES,
};

/**
 * The two FBRX Endpoint products. **Basic** is what runs without a license key: the everyday tools and the AI agent,
 * with a plain light or dark look. **Ultra** is what a license key (or an FBRX Command tenant) turns on: expert tool
 * sets, Mesh and AI coordination, connections and plugins, the theme studio with its gradients and textures, and the
 * easter eggs.
 */
export const TIERS = ['basic', 'ultra'] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_NAMES: Record<Tier, string> = { basic: 'FBRX Endpoint Basic', ultra: 'FBRX Endpoint Ultra' };

/** Without a `tier` claim, a Community license runs Basic and Pro or Enterprise run Ultra. */
export function tierFor(edition: Edition, claim?: Tier | null): Tier {
  return claim ?? (edition === 'community' ? 'basic' : 'ultra');
}

/** The FBRX Command tenant a license belongs to: the device joins it on its own when the key is activated. */
export const LicenseCommandSchema = z.object({
  /** The tenant's FBRX Command address (https://…). */
  url: z.string().url(),
  /** An enrollment token for that tenant. */
  enrollmentToken: z.string().min(8),
  /** FBRX Command's own certificate fingerprint, when it has no publicly trusted certificate (pinned on join). */
  fingerprint: z.string().optional(),
});
export type LicenseCommand = z.infer<typeof LicenseCommandSchema>;

export const LicensePayloadSchema = z.object({
  v: z.literal(1),
  /** License id. */
  lid: z.string(),
  tenantId: z.string(),
  customer: z.string(),
  edition: z.enum(EDITIONS),
  seats: z.number().int().min(0),
  /** Extra features on top of the edition defaults. */
  features: z.array(z.string()),
  issuedAt: z.string(),
  expiresAt: z.string().nullable(),
  /** Optional: the newest app major version this license covers (`null` = all). */
  maxMajorVersion: z.number().int().nullable(),
  /** Optional: Basic or Ultra, when the tenant decides (otherwise it follows the edition, see tierFor). */
  tier: z.enum(TIERS).optional(),
  /** Optional: the FBRX Command tenant to join on activation. */
  command: LicenseCommandSchema.optional(),
  /** Optional: an Education (or Home) license; staff computers start in classroom mode (see editions.ts). */
  vertical: z.enum(['business', 'education', 'home']).optional(),
});
export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

export const LICENSE_PREFIX = 'FBRX1';

export interface LicenseStatus {
  state: 'unlicensed' | 'valid' | 'expired' | 'invalid' | 'development';
  edition: Edition;
  /** FBRX Endpoint Basic or Ultra (see TIERS). */
  tier: Tier;
  customer: string | null;
  tenantId: string | null;
  licenseId: string | null;
  seats: number | null;
  expiresAt: string | null;
  features: string[];
  message: string | null;
  source: 'none' | 'local' | 'managed' | 'development';
  /** The FBRX Command address this license joins, if it names one. */
  commandUrl: string | null;
  /** Education or Home licenses (null = business). */
  vertical: 'business' | 'education' | 'home' | null;
}

export function featuresFor(payload: Pick<LicensePayload, 'edition' | 'features'> & { command?: LicenseCommand }): string[] {
  // A license that names an FBRX Command tenant always lets the device join it.
  return [...new Set([...EDITION_FEATURES[payload.edition], ...payload.features, ...(payload.command ? ['fleet'] : [])])].sort();
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Splits a license key without verifying it. Use the node `verifyLicense` for trust decisions. */
export function decodeLicenseUnverified(key: string): LicensePayload | null {
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return null;
  try {
    const json = new TextDecoder().decode(base64UrlDecode(parts[1]));
    const parsed = LicensePayloadSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

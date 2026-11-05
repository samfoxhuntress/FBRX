import { z } from 'zod';
import { LICENSE_TIERS, type Tier } from './license';

/**
 * Support mode: the way an FBRX support engineer, or the person who runs an organization's FBRX Command, gets full
 * access to one computer's FBRX apps (FBRX OS and the browser) to troubleshoot, without that power being free for the
 * taking. Typing the support phrase alone does nothing; it asks for a **support pass**: a short-lived token, signed by
 * FBRX's own license key and tied to one computer, that the apps verify offline. While a valid pass is active the
 * computer runs as Black Hole with every feature on, settings the organization locked can be changed, and everything
 * done is written to the audit log (and reported to FBRX Command on a managed computer). The resume phrase, or the
 * pass running out, puts everything back exactly as it was.
 */

/** Typed in a license box, Spotlight, the browser's address bar or FBRX/1 to begin (then a pass is asked for). */
export const SUPPORT_ENTER_PHRASE = '418teapotadmin';
/** Typed anywhere support mode is active to end it and restore the computer to what it was. */
export const SUPPORT_EXIT_PHRASE = 'refusetobrew';

/** A support pass is for one computer; `scope` leaves room for other FBRX products later (servers decide their own). */
export const SUPPORT_SCOPES = ['endpoint'] as const;
export type SupportScope = (typeof SUPPORT_SCOPES)[number];

/** How long a freshly minted pass may last, at most: long enough for a support call, short enough to be safe. */
export const SUPPORT_PASS_MAX_HOURS = 12;
export const SUPPORT_PASS_DEFAULT_HOURS = 4;

export const SupportPassSchema = z.object({
  v: z.literal(1),
  /** The one computer this pass is for: its install id (meta `install.id`). */
  installId: z.string().min(1).max(200),
  /** The edition to run while the pass is active (Black Hole gives everything; a lighter one can be minted too). */
  tier: z.enum(LICENSE_TIERS),
  scope: z.enum(SUPPORT_SCOPES),
  /** Who the pass is for and why, shown in the app and written to the audit log (no secrets). */
  note: z.string().max(200),
  /** Who minted it (an email or name), for the audit trail. */
  issuedBy: z.string().max(200),
  issuedAt: z.string(),
  expiresAt: z.string(),
});
export type SupportPass = z.infer<typeof SupportPassSchema>;

/** A pass is `FBRXSUP1.<base64url(payload)>.<base64url(ed25519 signature)>`, signed by the same key as a license. */
export const SUPPORT_PASS_PREFIX = 'FBRXSUP1';

/** What the app shows while support mode is on (status.support). */
export interface SupportStatus {
  active: boolean;
  /** This computer's install id: what a support pass is minted for (shown in Settings → License and FBRX/1). */
  installId: string;
  /** The edition support mode is running (Black Hole unless a lighter pass was minted). */
  tier: Tier | null;
  /** Until when the pass is valid. */
  until: string | null;
  /** Who the pass was minted for/by, and its note. */
  issuedBy: string | null;
  note: string | null;
}

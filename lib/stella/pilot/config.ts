// lib/stella/pilot/config.ts
// Etapa B0 (modo piloto restringido, decisión del propietario 2026-07-26 —
// ver STELLA_DECISION_REGISTER.md#A3-DEFERRED-UNTIL-POST-PILOT). Server-only
// module — never import from a 'use client' component. Every default is the
// SAFE default: pilot disabled, provider disabled, every allowlist empty
// (empty means NO access, never "unrestricted"). Nothing here is ever sent
// to the client — see lib/stella/pilot/access.ts, which returns only a
// typed decision + non-leaky message, never the allowlists themselves.

import type { StellaRole } from '../adapter/types'

export type StellaPilotProviderMode = 'disabled' | 'mock' | 'paid_gemini'

const ALL_STELLA_ROLES: readonly StellaRole[] = ['advisor', 'validator', 'composer', 'proxy_reviewer', 'evidence_reviewer', 'audit_assistant']

/**
 * Only 'advisor' is enabled by default for B0 — see
 * STELLA_B0_CONTROLLED_PILOT_IMPLEMENTATION_REPORT.md#10 for why: it can be
 * exercised with synthetic context and produces non-numeric guidance.
 * Composer is deliberately excluded until its numeric guards (Etapa B2) are
 * verified; Validator/Reviewer are excluded while their prompts remain
 * generic (documented, not implemented safeguards yet).
 */
const DEFAULT_PILOT_ENABLED_ROLES: readonly StellaRole[] = ['advisor']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Parses a comma-separated list of IDs. Any entry that doesn't look like a UUID is DROPPED (fail-closed exclusion, never a thrown error, never silently "allow anyway") and logged server-side. */
function parseIdAllowlist(raw: string | undefined, envVarName: string): ReadonlySet<string> {
  if (!raw) return new Set()
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const valid = new Set<string>()
  for (const id of ids) {
    if (UUID_RE.test(id)) {
      valid.add(id.toLowerCase())
    } else {
      console.warn(`[stella-pilot] ${envVarName} contains a value that is not a valid UUID — excluded (fail-closed):`, id.length > 8 ? `${id.slice(0, 8)}…` : '(short value)')
    }
  }
  return valid
}

function parseProviderMode(raw: string | undefined): StellaPilotProviderMode {
  if (raw === 'mock' || raw === 'paid_gemini') return raw
  return 'disabled' // any unrecognized value fails closed to disabled, never assumed to be a valid mode
}

function parseRoleAllowlist(raw: string | undefined): ReadonlySet<StellaRole> {
  if (raw === undefined) return new Set(DEFAULT_PILOT_ENABLED_ROLES)
  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const valid = new Set<StellaRole>()
  for (const r of requested) {
    if ((ALL_STELLA_ROLES as readonly string[]).includes(r)) {
      valid.add(r as StellaRole)
    } else {
      console.warn('[stella-pilot] STELLA_PILOT_ENABLED_ROLES contains an unrecognized role — excluded (fail-closed):', r)
    }
  }
  return valid
}

export interface StellaPilotConfig {
  /** Master pilot-mode switch. false = every pilot check fails closed regardless of anything else. */
  enabled: boolean
  /** Highest-priority override — true always wins over `enabled`/allowlists/provider mode. */
  killSwitch: boolean
  providerMode: StellaPilotProviderMode
  /** Empty set = no organization is allowed (never "unrestricted"). */
  allowedOrganizationIds: ReadonlySet<string>
  /** Empty set = no user is allowed UNLESS allowAllUsersInAllowedOrganizations is true. */
  allowedUserIds: ReadonlySet<string>
  allowAllUsersInAllowedOrganizations: boolean
  /** Fixed at true — not configurable via env; the pilot's operative confirmation is always mandatory. */
  requireSyntheticDataConfirmation: true
  /** Fixed at true — not configurable via env; every pilot response requires human review. */
  requireHumanReview: true
  /** External confirmation gate — an API key is never treated as proof of a paid tier (see access.ts). */
  paidGeminiConfirmed: boolean
  /** Version stamp for the visible pilot notice (STELLA_PILOT_NOTICE_VERSION) — bumping it re-requires acceptance. */
  noticeVersion: string
  /** Which StellaRole values may reach the REAL provider during the pilot — see DEFAULT_PILOT_ENABLED_ROLES. */
  enabledStellaRoles: ReadonlySet<StellaRole>
}

/**
 * Deliberadamente NO es `NodeJS.ProcessEnv`: Next.js augmenta ese tipo con
 * campos obligatorios (`NODE_ENV`), lo que obligaría a cada prueba a
 * construir un entorno completo sólo para verificar una variable. Mismo
 * patrón que `db/guard.ts`'s `EnvLike`. `process.env` es asignable a este tipo.
 */
type EnvLike = Record<string, string | undefined>

export function getStellaPilotConfig(env: EnvLike = process.env): StellaPilotConfig {
  return {
    enabled: env.STELLA_PILOT_MODE === 'true',
    killSwitch: env.STELLA_PILOT_KILL_SWITCH === 'true',
    providerMode: parseProviderMode(env.STELLA_PILOT_PROVIDER_MODE),
    allowedOrganizationIds: parseIdAllowlist(env.STELLA_PILOT_ORGANIZATION_IDS, 'STELLA_PILOT_ORGANIZATION_IDS'),
    allowedUserIds: parseIdAllowlist(env.STELLA_PILOT_USER_IDS, 'STELLA_PILOT_USER_IDS'),
    allowAllUsersInAllowedOrganizations: env.STELLA_PILOT_ALLOW_ALL_ORG_USERS === 'true',
    requireSyntheticDataConfirmation: true,
    requireHumanReview: true,
    paidGeminiConfirmed: env.STELLA_PILOT_PAID_GEMINI_CONFIRMED === 'true',
    noticeVersion: env.STELLA_PILOT_NOTICE_VERSION ?? 'v1',
    enabledStellaRoles: parseRoleAllowlist(env.STELLA_PILOT_ENABLED_ROLES),
  }
}

/**
 * Roles permitted to TRIGGER a pilot request at all (membership role, not
 * StellaRole) — deliberately narrower than "every active member": pilot
 * participants are expected to be organization operators, not platform
 * administrators or read-only members. `super_admin` is intentionally
 * EXCLUDED — using Stella as a global platform role would blur who is
 * actually piloting, and the encargo explicitly forbids any super_admin
 * bypass. Separate from (and narrower than) DR-007's
 * ORG_WIDE_STELLA_ACCESS_ROLES, which governs reading past interactions,
 * not triggering new ones.
 */
export const PILOT_MEMBERSHIP_ROLE_ALLOWLIST: ReadonlySet<string> = new Set(['organization_admin', 'impact_manager', 'analyst'])

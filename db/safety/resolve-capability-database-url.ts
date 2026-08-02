// db/safety/resolve-capability-database-url.ts
//
// ONE VARIABLE PER CAPABILITY.
//
// `DATABASE_URL` used to mean three different things at once: the connection
// the application served traffic on, the connection migrations ran DDL on,
// and the connection audits read from. A single name for three capabilities
// is not a naming problem — it is an authorization problem, because the most
// privileged of the three necessarily wins. That is exactly how the runtime
// ended up holding BYPASSRLS and CREATEROLE while a least-privilege role sat
// unused next to it.
//
// After the cutover each capability reads its OWN variable, and the variables
// are provisioned from different files with different lifetimes:
//
//   UELLIX_RUNTIME_DATABASE_URL    .env.local             uellix_app
//   UELLIX_MIGRATOR_DATABASE_URL   .env.migration.local   uellix_migrator
//   UELLIX_AUDITOR_DATABASE_URL    .env.audit.local       uellix_auditor
//
// `.env.local` is the only one Next.js loads. `.env.migration.local` and
// `.env.audit.local` are NOT in Next's load list, so the migration credential
// is structurally unreachable from a rendering process rather than merely
// absent from it by convention.
//
// ERRORS NEVER CARRY THE URL. Every message here names the variable and the
// expected role; none of them interpolates the value, not even redacted. A
// connection string that reaches a log is a leaked credential regardless of
// how carefully the host was masked.

import type { EnvironmentSource } from './database-target'
import {
  AUDITOR_DATABASE_ROLE,
  FORBIDDEN_RUNTIME_DATABASE_ROLES,
  MIGRATOR_DATABASE_ROLE,
  RUNTIME_DATABASE_ROLE,
} from './database-role'

export const RUNTIME_DATABASE_URL_ENV_VAR = 'UELLIX_RUNTIME_DATABASE_URL'
export const MIGRATOR_DATABASE_URL_ENV_VAR = 'UELLIX_MIGRATOR_DATABASE_URL'
export const AUDITOR_DATABASE_URL_ENV_VAR = 'UELLIX_AUDITOR_DATABASE_URL'

/**
 * The pre-cutover name. Never read for a connection again — only detected, so
 * an operator who still exports it gets told it is inert instead of silently
 * running the old, over-privileged path.
 */
export const LEGACY_SHARED_DATABASE_URL_ENV_VAR = 'DATABASE_URL'

export type CapabilityUrlErrorCode =
  | 'DB_CAPABILITY_URL_MISSING'
  | 'DB_CAPABILITY_URL_UNPARSEABLE'
  | 'DB_CAPABILITY_URL_NO_ROLE'
  | 'DB_CAPABILITY_URL_WRONG_ROLE'

export class CapabilityDatabaseUrlError extends Error {
  readonly name = 'CapabilityDatabaseUrlError'
  readonly code: CapabilityUrlErrorCode
  readonly envVar: string

  constructor(code: CapabilityUrlErrorCode, envVar: string, message: string) {
    super(message)
    this.code = code
    this.envVar = envVar
  }
}

export interface ResolvedCapabilityDatabaseUrl {
  readonly url: string
  /** The role name parsed out of the URL's userinfo. Never a secret. */
  readonly declaredRole: string
  /** Credential-free notes worth surfacing before the operation runs. */
  readonly warnings: readonly string[]
}

/**
 * Read the login role out of a connection URL's userinfo.
 *
 * Returns `null` rather than throwing so callers can attach their own error
 * code, and never returns the password — `URL` parses it into a separate
 * field which this function simply does not read.
 */
export function parseDeclaredRole(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.username === '') return null
  try {
    return decodeURIComponent(parsed.username)
  } catch {
    // A malformed percent-escape in the username. Treat as absent rather than
    // guessing, so the caller fails closed.
    return null
  }
}

function resolveForRole(
  env: EnvironmentSource,
  envVar: string,
  expectedRole: string,
  forbiddenRoles: readonly string[]
): ResolvedCapabilityDatabaseUrl {
  const warnings: string[] = []

  if (typeof env[LEGACY_SHARED_DATABASE_URL_ENV_VAR] === 'string') {
    warnings.push(
      `${LEGACY_SHARED_DATABASE_URL_ENV_VAR} is set and is IGNORED: it used to mean the runtime, ` +
        'the migrator and the auditor at once, so the most privileged reading always won. ' +
        `Use ${envVar} for this capability.`
    )
  }

  const raw = env[envVar]
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new CapabilityDatabaseUrlError(
      'DB_CAPABILITY_URL_MISSING',
      envVar,
      `${envVar} is not set. This capability connects as "${expectedRole}" and has no fallback: ` +
        `${LEGACY_SHARED_DATABASE_URL_ENV_VAR} is deliberately not consulted.`
    )
  }
  const url = raw.trim()

  const declaredRole = parseDeclaredRole(url)
  if (declaredRole === null) {
    throw new CapabilityDatabaseUrlError(
      'DB_CAPABILITY_URL_NO_ROLE',
      envVar,
      `${envVar} carries no login role in its userinfo, so the connecting identity would be ` +
        `whatever the server defaults to rather than "${expectedRole}".`
    )
  }

  // A pre-check, NOT the guarantee. The URL is caller-controlled configuration
  // and only states an intent; the authoritative check is the bootstrap query
  // that asks the SERVER who it authenticated (db/runtime-bootstrap.ts). This
  // exists so the common misconfiguration fails before a socket is opened.
  if (declaredRole !== expectedRole) {
    const forbidden = forbiddenRoles.includes(declaredRole)
    throw new CapabilityDatabaseUrlError(
      'DB_CAPABILITY_URL_WRONG_ROLE',
      envVar,
      `${envVar} declares role "${declaredRole}" but this capability requires "${expectedRole}".` +
        (forbidden
          ? ` "${declaredRole}" is an administrative or migration identity and must never serve ` +
            'application traffic.'
          : '')
    )
  }

  return { url, declaredRole, warnings }
}

/** Resolve the Next.js runtime connection. Must be `uellix_app`. */
export function resolveRuntimeDatabaseUrl(
  env: EnvironmentSource = process.env
): ResolvedCapabilityDatabaseUrl {
  return resolveForRole(
    env,
    RUNTIME_DATABASE_URL_ENV_VAR,
    RUNTIME_DATABASE_ROLE,
    FORBIDDEN_RUNTIME_DATABASE_ROLES
  )
}

/** Resolve the migration connection. Must be `uellix_migrator`. */
export function resolveMigratorDatabaseUrl(
  env: EnvironmentSource = process.env
): ResolvedCapabilityDatabaseUrl {
  return resolveForRole(env, MIGRATOR_DATABASE_URL_ENV_VAR, MIGRATOR_DATABASE_ROLE, [])
}

/** Resolve the read-only audit connection. Must be `uellix_auditor`. */
export function resolveAuditorDatabaseUrl(
  env: EnvironmentSource = process.env
): ResolvedCapabilityDatabaseUrl {
  return resolveForRole(env, AUDITOR_DATABASE_URL_ENV_VAR, AUDITOR_DATABASE_ROLE, [])
}

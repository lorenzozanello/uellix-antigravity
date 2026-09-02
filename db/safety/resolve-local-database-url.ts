// db/safety/resolve-local-database-url.ts
//
// RESOLUTION LAYER: decides which URL a local-only entry point will use.
//
// THE INCIDENT THIS EXISTS FOR
//
// Local fixture scripts used to resolve their target from `DATABASE_URL` via
// `import 'dotenv/config'`. That is a silent-override hazard in both
// directions:
//
//   * dotenv does not override an already-exported variable, so an operator
//     who exported a local URL was safe — but only by accident;
//   * an operator who exported nothing got whatever `.env` happened to hold,
//     which on a developer machine is frequently a remote connection string.
//
// Either way the *intent* ("seed my local stack") and the *destination* were
// decided by different things. This module removes the ambiguity: a local
// entry point never consults `DATABASE_URL` at all. It uses this worktree's
// pinned local URL, and the only override it accepts —
// `UELLIX_LOCAL_DATABASE_URL` — must itself classify as local and sit on the
// expected port, or resolution fails.

import { classifyDatabaseTarget, redactHost, type EnvironmentSource } from './database-target'
import { LOCAL_CONTAINER_HOSTS, LOCAL_DATABASE_URL, LOCAL_DB_PORT } from './local-stack'

/** Explicit, auditable override for operators running a non-default stack. */
export const LOCAL_DATABASE_URL_ENV_VAR = 'UELLIX_LOCAL_DATABASE_URL'

export type LocalDatabaseUrlSource = 'pinned_local_stack' | 'explicit_local_override'

export interface ResolvedLocalDatabaseUrl {
  readonly url: string
  readonly source: LocalDatabaseUrlSource
  /** Credential-free notes worth printing before the operation runs. */
  readonly warnings: readonly string[]
}

export class LocalDatabaseUrlResolutionError extends Error {
  readonly name = 'LocalDatabaseUrlResolutionError'
  readonly code = 'DB_LOCAL_URL_OVERRIDE_REJECTED' as const
}

/**
 * Resolve the connection URL for a local-only capability.
 *
 * `DATABASE_URL` is ignored by construction — it is only read to warn that a
 * value which used to steer this script is now inert.
 */
export function resolveLocalDatabaseUrl(
  env: EnvironmentSource = process.env,
  options: { expectedLocalPort?: number; containerHosts?: readonly string[] } = {}
): ResolvedLocalDatabaseUrl {
  const expectedLocalPort = options.expectedLocalPort ?? LOCAL_DB_PORT
  const containerHosts = options.containerHosts ?? LOCAL_CONTAINER_HOSTS
  const warnings: string[] = []

  const ambient = env.DATABASE_URL
  if (typeof ambient === 'string' && ambient.trim() !== '') {
    const ambientTarget = classifyDatabaseTarget(ambient, { containerHosts })
    warnings.push(
      `DATABASE_URL is set (target=${ambientTarget.kind}, host=${ambientTarget.redactedHost}) ` +
        'and is IGNORED by local entry points. Use ' +
        `${LOCAL_DATABASE_URL_ENV_VAR} if you need to point at a different LOCAL stack.`
    )
  }

  const override = env[LOCAL_DATABASE_URL_ENV_VAR]
  if (typeof override === 'string' && override.trim() !== '') {
    const target = classifyDatabaseTarget(override, { containerHosts })
    if (target.kind !== 'local_loopback' && target.kind !== 'local_container') {
      throw new LocalDatabaseUrlResolutionError(
        `${LOCAL_DATABASE_URL_ENV_VAR} does not point at a local stack ` +
          `(target=${target.kind}, host=${redactHost(target.hostname, containerHosts)}). ` +
          'Local entry points accept loopback or an explicitly allow-listed container host only.'
      )
    }
    if (target.port !== expectedLocalPort) {
      throw new LocalDatabaseUrlResolutionError(
        `${LOCAL_DATABASE_URL_ENV_VAR} is on port ${target.port ?? 'unset'} but this entry point ` +
          `expects port ${expectedLocalPort}. Another local stack on this host is not a valid target.`
      )
    }
    return { url: override.trim(), source: 'explicit_local_override', warnings }
  }

  return { url: LOCAL_DATABASE_URL, source: 'pinned_local_stack', warnings }
}

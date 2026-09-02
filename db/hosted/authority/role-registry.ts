// db/hosted/authority/role-registry.ts
// COMMIT 3 — the closed set of roles the authority plan may name.
//
// Every role-generating primitive takes a `HostedRoleIdentifier` and nothing
// else. The alternative — accepting a string — has one failure mode and it is
// unrecoverable: the string reaches a `GRANT` by interpolation, and a typo
// (`uellix_ownerr`) either fails at apply time in the middle of a window, or,
// far worse, names a role that happens to exist for some other reason. There is
// no quoting discipline that makes an arbitrary role name safe to elevate to,
// because the danger is not injection, it is naming the wrong principal.
//
// The registry is also where "which roles may be elevated to" is written down
// once. `uellix_app` is in the registry because packages GRANT to it; it is not
// elevatable, because nothing in the chain should ever act as the runtime role.

import { AuthorityRefusal } from './window-contract'

export type HostedRoleIdentifier =
  | 'uellix_owner'
  | 'uellix_migrator'
  | 'uellix_app'
  | 'uellix_writer'
  | 'uellix_auditor'
  | 'uellix_cap_grounding'
  | 'uellix_cap_stella_quota'
  | 'uellix_cap_stella_ticket'

export type HostedRoleKind = 'installer' | 'owner' | 'capability' | 'runtime'

export interface HostedRole {
  readonly id: HostedRoleIdentifier
  readonly kind: HostedRoleKind
  /** Whether a window may `SET ROLE` into it. Runtime roles never may. */
  readonly elevatable: boolean
  /** Why it exists, in the words the chain's own packages use. */
  readonly purpose: string
}

export const AUTHORITY_ROLE_REGISTRY: readonly HostedRole[] = [
  {
    id: 'uellix_migrator',
    kind: 'installer',
    elevatable: false,
    purpose:
      'The applying identity. Holds CREATEROLE and membership in uellix_owner with SET TRUE, and ' +
      'is the only principal permitted to execute an installer-only statement.',
  },
  {
    id: 'uellix_owner',
    kind: 'owner',
    elevatable: true,
    purpose:
      'Owns the schemas, tables, policies and triggers the chain publishes, and holds CREATE on ' +
      'schema public. Never logs in.',
  },
  {
    id: 'uellix_cap_grounding',
    kind: 'capability',
    elevatable: true,
    purpose: 'Owns the SECURITY DEFINER functions of the grounding packages.',
  },
  {
    id: 'uellix_cap_stella_quota',
    kind: 'capability',
    elevatable: true,
    purpose: 'Owns the quota and capacity SECURITY DEFINER functions.',
  },
  {
    id: 'uellix_cap_stella_ticket',
    kind: 'capability',
    elevatable: true,
    purpose: 'Owns the operation-ticket SECURITY DEFINER functions.',
  },
  {
    id: 'uellix_app',
    kind: 'runtime',
    elevatable: false,
    purpose: 'The application runtime. Receives EXECUTE grants; is never elevated to.',
  },
  {
    id: 'uellix_writer',
    kind: 'runtime',
    elevatable: false,
    purpose: 'The background writer. Receives grants; is never elevated to.',
  },
  {
    id: 'uellix_auditor',
    kind: 'runtime',
    elevatable: false,
    purpose: 'Read-only audit identity. Receives grants; is never elevated to.',
  },
]

const BY_ID = new Map<string, HostedRole>(AUTHORITY_ROLE_REGISTRY.map((r) => [r.id, r]))

/** Looks up a role, or refuses. Never falls back to treating the input as a name. */
export function hostedRole(id: string): HostedRole {
  const found = BY_ID.get(id)
  if (found === undefined) {
    throw new AuthorityRefusal(
      'AUTHORITY_UNKNOWN_ROLE',
      `\`${id}\` is not a role this plan may name. Known roles: ` +
        `${AUTHORITY_ROLE_REGISTRY.map((r) => r.id).join(', ')}. A role-generating primitive never ` +
        `interpolates an unrecognised name: elevating to the wrong principal is not something ` +
        `quoting can make safe.`,
    )
  }
  return found
}

export function isCapabilityRole(id: string): boolean {
  return BY_ID.get(id)?.kind === 'capability'
}

/** Refuses a role that exists but must never be elevated to. */
export function assertElevatable(id: string): HostedRole {
  const role = hostedRole(id)
  if (!role.elevatable) {
    throw new AuthorityRefusal(
      'AUTHORITY_UNKNOWN_ROLE',
      `\`${id}\` is a ${role.kind} role and no window may act as it. ${role.purpose}`,
    )
  }
  return role
}

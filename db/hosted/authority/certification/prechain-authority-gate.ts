// db/hosted/authority/certification/prechain-authority-gate.ts
// COMMIT 5.1 — the gate that must pass BEFORE T1, so E-01/E-02/E-04 cannot be
// rediscovered halfway through a package.
//
// ---------------------------------------------------------------------------
// WHY A GATE AND NOT MORE PRECONDITIONS INSIDE T1
// ---------------------------------------------------------------------------
// T1 already refuses on its own preconditions, and that is what produced the
// three E-01 measurements — one at line 278, one at 398, one at 682, three
// separate runs, each after the previous statements had already executed inside
// the transaction. Every one of them rolled back cleanly, so nothing was
// damaged; what was lost was time, and the far more expensive thing: each run
// answered only "what breaks next", never "what does this chain need".
//
// This gate answers the second question, before anything runs. It is derived
// from the same plan the generator uses (prechain-requirements.ts), so it
// cannot fall behind the chain it is gating: add a package that grants on a new
// baseline object and the requirement appears here without anybody editing a
// list.
//
// ---------------------------------------------------------------------------
// WHAT IT REFUSES ON, AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------------------------------
// It refuses when the chain WOULD fail: a privilege missing, an installer that
// cannot create a role, a membership row that confers SET where none should.
// It does not refuse on things that are merely unusual — an extra grant to a
// role the chain never names is not its business, and a gate that policed the
// whole cluster would be turned off the first time it was wrong.

import {
  collapseByObject,
  derivePrechainRequirements,
  type PrechainObjectContract,
} from './prechain-requirements'

/** The installer the governed chain names. Kept in one place. */
export const HOSTED_INSTALLER = 'uellix_migrator'
export const OWNER = 'uellix_owner'

/** Roles the chain creates and whose membership topology E-04 pins. */
export const CAPABILITY_ROLES: readonly string[] = [
  'uellix_cap_grounding',
  'uellix_cap_stella_quota',
  'uellix_cap_stella_ticket',
]

export type PrechainRefusalCode =
  | 'PRECHAIN_INSTALLER_CANNOT_CREATE_ROLE'
  | 'PRECHAIN_INSTALLER_CANNOT_BECOME_OWNER'
  | 'PRECHAIN_INSTALLER_NOT_LOGIN'
  | 'PRECHAIN_OBJECT_ABSENT'
  | 'PRECHAIN_PRIVILEGE_MISSING'
  | 'PRECHAIN_SCHEMA_NOT_WRITABLE'
  | 'PRECHAIN_MEMBERSHIP_TOPOLOGY_UNEXPECTED'
  | 'PRECHAIN_CAPABILITY_REACHABLE'
  | 'PRECHAIN_OBSERVATION_INCOMPLETE'

export interface PrechainRefusal {
  readonly code: PrechainRefusalCode
  readonly detail: string
}

/* -------------------------------------------------------------------------- */
/* The observation this gate consumes                                          */
/* -------------------------------------------------------------------------- */

export interface ObservedRole {
  readonly name: string
  readonly canLogin: boolean
  readonly createRole: boolean
  readonly isSuper: boolean
}

export interface ObservedMembership {
  readonly role: string
  readonly member: string
  readonly grantor: string
  readonly adminOption: boolean
  readonly inheritOption: boolean
  readonly setOption: boolean
}

/** What `uellix_owner` holds on ONE prechain object, measured. */
export interface ObservedObjectPrivileges {
  readonly object: string
  readonly present: boolean
  readonly owner: string | null
  /** `SELECT`, `INSERT`, `REFERENCES`, `EXECUTE` -> held at all. */
  readonly held: Readonly<Record<string, boolean>>
  /** The same privileges, but WITH GRANT OPTION. */
  readonly heldWithGrantOption: Readonly<Record<string, boolean>>
}

export interface PrechainObservation {
  readonly roles: readonly ObservedRole[]
  readonly memberships: readonly ObservedMembership[]
  readonly objects: readonly ObservedObjectPrivileges[]
  /** `schema -> uellix_owner may CREATE in it`. */
  readonly schemaCreate: Readonly<Record<string, boolean>>
  /** Whether the installer may `SET ROLE uellix_owner`, per pg_has_role. */
  readonly installerCanSetOwner: boolean
  /** Roles that can SET ROLE into each capability role, excluding superusers. */
  readonly capabilityReachableBy: Readonly<Record<string, readonly string[]>>
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether ownership already satisfies a contract.
 *
 * Ownership subsumes every privilege AND the grant option, so an object owned
 * by uellix_owner needs nothing further. This is why the remediation in
 * stella_hosted_0001 §5d skips such objects instead of granting on them: a
 * GRANT issued by a role that is not the owner would fail, and one issued by
 * the owner to itself is a statement that changes nothing.
 */
const ownedByOwner = (observed: ObservedObjectPrivileges): boolean => observed.owner === OWNER

/** Privileges that must carry the grant option, per the derived contract. */
function requiredWithGrantOption(contract: PrechainObjectContract): string[] {
  if (
    !contract.privileges.includes('EXECUTE_WITH_GRANT_OPTION') &&
    !contract.privileges.includes('TABLE_PRIVILEGE_WITH_GRANT_OPTION')
  ) {
    return []
  }
  // REFERENCES is needed by uellix_owner itself and is never passed on, so it
  // is not in this set even when it travels in the same GRANT statement.
  return contract.privilegeNames.filter((p) => p !== 'REFERENCES')
}

export function validateHostedPrechainAuthorityContract(
  observation: PrechainObservation,
  contracts: readonly PrechainObjectContract[] = collapseByObject(derivePrechainRequirements()),
): PrechainRefusal[] {
  const refusals: PrechainRefusal[] = []
  const role = (name: string): ObservedRole | undefined =>
    observation.roles.find((r) => r.name === name)

  /* E-02 — the installer contract ---------------------------------------- */
  const installer = role(HOSTED_INSTALLER)
  if (installer === undefined) {
    refusals.push({
      code: 'PRECHAIN_OBSERVATION_INCOMPLETE',
      detail: `${HOSTED_INSTALLER} was not observed at all. The chain names it in every temporary elevation it emits; a database without it cannot run a single package.`,
    })
  } else {
    if (!installer.canLogin) {
      refusals.push({
        code: 'PRECHAIN_INSTALLER_NOT_LOGIN',
        detail: `${HOSTED_INSTALLER} cannot log in, and the chain must be applied AS it — every generated \`GRANT ... TO ${HOSTED_INSTALLER}; SET ROLE ...\` pair is refused for any other session with \`permission denied to set role\`.`,
      })
    }
    if (!installer.createRole) {
      refusals.push({
        code: 'PRECHAIN_INSTALLER_CANNOT_CREATE_ROLE',
        detail: `${HOSTED_INSTALLER} lacks CREATEROLE. Six of the nine packages create a capability role, and \`assert_hosted_capabilities\` (C1) refuses at the FIRST statement of T1. This is E-02: measured, the chain had no session that could apply it.`,
      })
    }
  }
  if (!observation.installerCanSetOwner) {
    refusals.push({
      code: 'PRECHAIN_INSTALLER_CANNOT_BECOME_OWNER',
      detail: `${HOSTED_INSTALLER} cannot SET ROLE ${OWNER}. Every owner window opens with exactly that, and PostgreSQL 16+ makes \`set_option\` a separate grant option — being a MEMBER is not enough (lab M1).`,
    })
  }

  /* E-01 — the prechain object contract ----------------------------------- */
  for (const contract of contracts) {
    const observed = observation.objects.find((o) => o.object === contract.object)
    if (observed === undefined) {
      refusals.push({
        code: 'PRECHAIN_OBSERVATION_INCOMPLETE',
        detail: `${contract.object} is required by ${contract.firstDependant} and was not measured. Unmeasured is not satisfied.`,
      })
      continue
    }
    if (!observed.present) {
      refusals.push({
        code: 'PRECHAIN_OBJECT_ABSENT',
        detail: `${contract.object} does not exist, and ${contract.firstDependant} depends on it. The database is not at the expected migration baseline.`,
      })
      continue
    }
    if (ownedByOwner(observed)) continue

    const needsGrantOption = new Set(requiredWithGrantOption(contract))
    for (const privilege of contract.privilegeNames) {
      const held = observed.held[privilege] === true
      const withOption = observed.heldWithGrantOption[privilege] === true
      if (!held) {
        refusals.push({
          code: 'PRECHAIN_PRIVILEGE_MISSING',
          detail: `${OWNER} does not hold ${privilege} on ${contract.object} (owned by ${observed.owner ?? 'unknown'}), which ${contract.firstDependant} requires.`,
        })
        continue
      }
      if (needsGrantOption.has(privilege) && !withOption) {
        refusals.push({
          code: 'PRECHAIN_PRIVILEGE_MISSING',
          detail: `${OWNER} holds ${privilege} on ${contract.object} but NOT with the grant option, and ${contract.firstDependant} re-grants it. Holding a privilege is not the same as being able to pass it on — this is exactly what the engine refused at T1 line 278.`,
        })
      }
    }
  }

  /* The schemas the chain creates tables in ------------------------------- */
  for (const [schema, mayCreate] of Object.entries(observation.schemaCreate)) {
    if (!mayCreate) {
      refusals.push({
        code: 'PRECHAIN_SCHEMA_NOT_WRITABLE',
        detail: `${OWNER} cannot CREATE in schema ${schema}. PostgreSQL checks CREATE on the containing namespace against the NEW owner (S1-DEFECT-001), so the canonical owner contexts would fail.`,
      })
    }
  }

  /* E-04 — the capability membership topology ----------------------------- */
  for (const capability of CAPABILITY_ROLES) {
    if (role(capability) === undefined) continue // not created yet: PRECHAIN is exactly this
    for (const membership of observation.memberships.filter((m) => m.role === capability)) {
      const isAutomatic =
        membership.adminOption && !membership.inheritOption && !membership.setOption
      if (!isAutomatic) {
        refusals.push({
          code: 'PRECHAIN_MEMBERSHIP_TOPOLOGY_UNEXPECTED',
          detail: `${capability} carries a membership from ${membership.member} (granted by ${membership.grantor}) with admin=${membership.adminOption} inherit=${membership.inheritOption} set=${membership.setOption}. The only permitted row is the one PostgreSQL creates automatically for the creator (RR-02): ADMIN, and neither INHERIT nor SET.`,
        })
      }
    }
    const reachable = observation.capabilityReachableBy[capability] ?? []
    if (reachable.length > 0) {
      refusals.push({
        code: 'PRECHAIN_CAPABILITY_REACHABLE',
        detail: `${reachable.join(', ')} can SET ROLE to ${capability}. That is a write path around every policy the packages install, and it is the property the old "zero members" count was standing in for.`,
      })
    }
  }

  return refusals
}

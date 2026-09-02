// tests/hosted/authority/prechain-authority-contract.test.ts
// COMMIT 5.1 — the contract that has to hold BEFORE T1, and the three engine
// blockers it closes.
//
// ---------------------------------------------------------------------------
// WHY THESE ARE OFFLINE TESTS OF AN ENGINE FINDING
// ---------------------------------------------------------------------------
// E-01, E-02 and E-04 were all found the same way: a package refused, three
// hundred lines in, for a privilege nobody had stated. The remediation is a
// CONTRACT — a derived set of prerequisites and a gate that refuses when they
// are not met — and a contract is only worth having if it fails when it should.
// So the tests below feed the gate observations that are wrong in exactly the
// ways the engine was wrong, and assert the refusal.
//
// The engine half lives in `pnpm certify:pg176`; these are the properties that
// must hold without Docker, and the derivation that must not fall behind the
// chain it is gating.

import { describe, expect, it } from 'vitest'

import {
  collapseByObject,
  derivePrechainRequirements,
} from '@/db/hosted/authority/certification/prechain-requirements'
import {
  CAPABILITY_ROLES,
  HOSTED_INSTALLER,
  OWNER,
  validateHostedPrechainAuthorityContract,
  type PrechainObservation,
} from '@/db/hosted/authority/certification/prechain-authority-gate'

const contracts = collapseByObject(derivePrechainRequirements())

/** An observation in which everything the contract asks for is satisfied. */
function healthyObservation(): PrechainObservation {
  return {
    roles: [
      { name: HOSTED_INSTALLER, canLogin: true, createRole: true, isSuper: false },
      { name: OWNER, canLogin: false, createRole: false, isSuper: false },
    ],
    memberships: [],
    objects: contracts.map((c) => ({
      object: c.object,
      present: true,
      owner: OWNER,
      held: {},
      heldWithGrantOption: {},
    })),
    schemaCreate: { public: true, uellix_grounding: true },
    installerCanSetOwner: true,
    capabilityReachableBy: {},
  }
}

/* -------------------------------------------------------------------------- */
/* The derivation                                                              */
/* -------------------------------------------------------------------------- */

describe('the prechain requirement set is derived, minimal and typed', () => {
  it('is eight objects, not the forty-six stella_0004 transfers', () => {
    // The point of deriving instead of copying. `stella_0004` moves 38 tables
    // and 8 functions to uellix_owner; the hosted chain only DEPENDS on eight,
    // and a remediation that moved all forty-six would be a far larger
    // authority change than the engine evidence justifies.
    expect(contracts).toHaveLength(8)
    expect(contracts.map((c) => c.object).sort()).toEqual([
      'public.current_user_is_super_admin',
      'public.current_user_org_ids',
      'public.evidence_items',
      'public.organizations',
      'public.projects',
      'public.stella_interactions',
      'public.uellix_forbid_mutation()',
      'public.users',
    ])
  })

  it('distinguishes the three privileges the engine refused on separately', () => {
    // Three statements, three privileges, three object classes — and none of
    // them named in the statement that failed. Collapsing these into "needs
    // access" is what produced three consecutive diagnostic rounds.
    const byObject = new Map(contracts.map((c) => [c.object, c]))

    expect(byObject.get('public.current_user_org_ids')?.privileges).toContain(
      'EXECUTE_WITH_GRANT_OPTION',
    )
    expect(byObject.get('public.organizations')?.privileges).toContain('REFERENCES')
    expect(byObject.get('public.uellix_forbid_mutation()')?.privileges).toEqual(['EXECUTE'])
    expect(byObject.get('public.stella_interactions')?.privileges).toContain('OWNERSHIP')
  })

  it('resolves triggers, policies, columns and constraints to their table', () => {
    // A trigger is not an object a privilege is held on: PostgreSQL checks the
    // owner of the table it hangs off. The first derivation reported nine of
    // them as tables needing OWNERSHIP — every one belonging to a table the
    // chain itself creates, so every one a false positive.
    for (const contract of contracts) {
      expect(contract.object, contract.object).not.toMatch(/^public\.trg_/)
      expect(contract.object, contract.object).not.toMatch(/_select$/)
    }
  })

  it('excludes everything the chain creates for itself', () => {
    for (const contract of contracts) {
      expect(contract.object, contract.object).not.toMatch(/^uellix_/)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

describe('the gate passes a healthy prechain and refuses each engine blocker', () => {
  it('passes when every prerequisite holds', () => {
    expect(validateHostedPrechainAuthorityContract(healthyObservation(), contracts)).toEqual([])
  })

  it('E-02: refuses an installer without CREATEROLE', () => {
    // Measured: `assert_hosted_capabilities` C1 refuses at the FIRST statement
    // of T1, and the array-literal defect used to mask even that.
    const observation = healthyObservation()
    const refusals = validateHostedPrechainAuthorityContract(
      {
        ...observation,
        roles: observation.roles.map((r) =>
          r.name === HOSTED_INSTALLER ? { ...r, createRole: false } : r,
        ),
      },
      contracts,
    )
    expect(refusals.map((r) => r.code)).toContain('PRECHAIN_INSTALLER_CANNOT_CREATE_ROLE')
  })

  it('E-02: refuses an installer that cannot log in', () => {
    const observation = healthyObservation()
    const refusals = validateHostedPrechainAuthorityContract(
      {
        ...observation,
        roles: observation.roles.map((r) =>
          r.name === HOSTED_INSTALLER ? { ...r, canLogin: false } : r,
        ),
      },
      contracts,
    )
    expect(refusals.map((r) => r.code)).toContain('PRECHAIN_INSTALLER_NOT_LOGIN')
  })

  it('E-02: refuses an installer that cannot become the owner', () => {
    // Membership is not the right to SET ROLE on PostgreSQL 16+ (lab M1), and
    // the owner window now depends on the PERSISTENT membership alone.
    const refusals = validateHostedPrechainAuthorityContract(
      { ...healthyObservation(), installerCanSetOwner: false },
      contracts,
    )
    expect(refusals.map((r) => r.code)).toContain('PRECHAIN_INSTALLER_CANNOT_BECOME_OWNER')
  })

  it('E-01: refuses a privilege held WITHOUT the grant option', () => {
    // THE EXACT SHAPE OF T1 LINE 278. The privilege is held; the chain re-grants
    // it; a grantor must hold the option. A gate that only asked "does it hold
    // SELECT" would pass this and the package would still refuse.
    const observation = healthyObservation()
    const refusals = validateHostedPrechainAuthorityContract(
      {
        ...observation,
        objects: observation.objects.map((o) =>
          o.object === 'public.current_user_org_ids'
            ? {
                ...o,
                owner: 'postgres',
                held: { EXECUTE: true },
                heldWithGrantOption: { EXECUTE: false },
              }
            : o,
        ),
      },
      contracts,
    )
    expect(refusals.map((r) => r.code)).toContain('PRECHAIN_PRIVILEGE_MISSING')
    expect(refusals.map((r) => r.detail).join('\n')).toMatch(/NOT with the grant option/)
  })

  it('E-01: accepts the same privilege WITH the grant option', () => {
    const observation = healthyObservation()
    const refusals = validateHostedPrechainAuthorityContract(
      {
        ...observation,
        objects: observation.objects.map((o) => ({
          ...o,
          owner: 'postgres',
          held: Object.fromEntries(
            (contracts.find((c) => c.object === o.object)?.privilegeNames ?? []).map((p) => [p, true]),
          ),
          heldWithGrantOption: Object.fromEntries(
            (contracts.find((c) => c.object === o.object)?.privilegeNames ?? []).map((p) => [p, true]),
          ),
        })),
      },
      contracts,
    )
    expect(refusals).toEqual([])
  })

  it('E-01: refuses an object that is simply absent', () => {
    const observation = healthyObservation()
    const refusals = validateHostedPrechainAuthorityContract(
      {
        ...observation,
        objects: observation.objects.map((o) =>
          o.object === 'public.organizations' ? { ...o, present: false, owner: null } : o,
        ),
      },
      contracts,
    )
    expect(refusals.map((r) => r.code)).toContain('PRECHAIN_OBJECT_ABSENT')
  })

  it('E-01: refuses an object nobody measured, rather than assuming it', () => {
    const observation = healthyObservation()
    const refusals = validateHostedPrechainAuthorityContract(
      { ...observation, objects: observation.objects.slice(1) },
      contracts,
    )
    expect(refusals.map((r) => r.code)).toContain('PRECHAIN_OBSERVATION_INCOMPLETE')
  })

  it('refuses a schema the owner cannot create in', () => {
    const refusals = validateHostedPrechainAuthorityContract(
      { ...healthyObservation(), schemaCreate: { public: false } },
      contracts,
    )
    expect(refusals.map((r) => r.code)).toContain('PRECHAIN_SCHEMA_NOT_WRITABLE')
  })
})

/* -------------------------------------------------------------------------- */
/* E-04                                                                        */
/* -------------------------------------------------------------------------- */

describe('E-04: the capability membership topology, not a row count', () => {
  const withCapability = (
    memberships: PrechainObservation['memberships'],
    reachable: Readonly<Record<string, readonly string[]>> = {},
  ): PrechainObservation => {
    const base = healthyObservation()
    return {
      ...base,
      roles: [
        ...base.roles,
        ...CAPABILITY_ROLES.map((name) => ({
          name,
          canLogin: false,
          createRole: false,
          isSuper: false,
        })),
      ],
      memberships,
      capabilityReachableBy: reachable,
    }
  }

  it('ACCEPTS the row RR-02 creates, which a zero-count rule cannot', () => {
    // MEASURED, PG 17.6, createrole_self_grant empty: creating a role grants the
    // creator ADMIN and nothing else, with the bootstrap superuser as grantor.
    // pg_has_role(installer, capability, 'SET') stays FALSE — the property the
    // old rule protected holds while its test of it could never pass.
    const refusals = validateHostedPrechainAuthorityContract(
      withCapability([
        {
          role: 'uellix_cap_grounding',
          member: HOSTED_INSTALLER,
          grantor: 'supabase_admin',
          adminOption: true,
          inheritOption: false,
          setOption: false,
        },
      ]),
      contracts,
    )
    expect(refusals).toEqual([])
  })

  it('REFUSES the same row with SET, which `count <= 1` would have admitted', () => {
    // This is why the replacement is topology and not a loosened count. A rule
    // that allowed "at most one member" would accept exactly this row.
    const refusals = validateHostedPrechainAuthorityContract(
      withCapability([
        {
          role: 'uellix_cap_grounding',
          member: HOSTED_INSTALLER,
          grantor: 'supabase_admin',
          adminOption: true,
          inheritOption: false,
          setOption: true,
        },
      ]),
      contracts,
    )
    expect(refusals.map((r) => r.code)).toContain('PRECHAIN_MEMBERSHIP_TOPOLOGY_UNEXPECTED')
  })

  it('REFUSES the same row with INHERIT', () => {
    const refusals = validateHostedPrechainAuthorityContract(
      withCapability([
        {
          role: 'uellix_cap_stella_quota',
          member: HOSTED_INSTALLER,
          grantor: 'supabase_admin',
          adminOption: true,
          inheritOption: true,
          setOption: false,
        },
      ]),
      contracts,
    )
    expect(refusals.map((r) => r.code)).toContain('PRECHAIN_MEMBERSHIP_TOPOLOGY_UNEXPECTED')
  })

  it('REFUSES any principal that can SET ROLE into a capability', () => {
    // Asked over pg_has_role rather than over the rows, so the transitive path
    // lab M4 measured — reachable through an intermediate — is closed too.
    const refusals = validateHostedPrechainAuthorityContract(
      withCapability([], { uellix_cap_stella_ticket: ['uellix_app'] }),
      contracts,
    )
    expect(refusals.map((r) => r.code)).toContain('PRECHAIN_CAPABILITY_REACHABLE')
  })

  it('says nothing about capability roles that do not exist yet — that IS PRECHAIN', () => {
    const refusals = validateHostedPrechainAuthorityContract(healthyObservation(), contracts)
    expect(refusals).toEqual([])
  })
})

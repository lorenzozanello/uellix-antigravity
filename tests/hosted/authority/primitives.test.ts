// tests/hosted/authority/primitives.test.ts
// COMMIT 3 — the authority primitives, and the tripwire that guards them.
//
// Every expectation below that concerns PostgreSQL behaviour is anchored on a
// measurement taken in the disposable 17.6 laboratory
// (db/hosted/authority/lab/pg176-authority-lab.sql), not on documentation and
// not on recollection. The measurement identifiers M1..M7 appear in the test
// names so a reader can go and re-run the one that justifies a given rule.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import { splitSqlStatements } from '@/db/hosted/authority/sql-statements'
import { CHAIN_PACKAGE_FILES } from '@/db/hosted/authority/window-plan'
import {
  AUTHORITY_ROLE_REGISTRY,
  hostedRole,
  isCapabilityRole,
  type HostedRoleIdentifier,
} from '@/db/hosted/authority/role-registry'
import {
  assertNoSessionRoleGrantee,
  SESSION_ROLE_KEYWORDS,
} from '@/db/hosted/authority/membership-tripwire'
import { parseMembershipStatement } from '@/db/hosted/authority/membership'
import {
  assertCleanupComplete,
  assertNoTransitiveElevation,
  AuthorityStateMachine,
  capabilityWindowPrimitive,
  membershipEdges,
  ownerTransferPrimitive,
  ownerWindowPrimitive,
} from '@/db/hosted/authority/primitives'
import { AuthorityRefusal } from '@/db/hosted/authority/window-contract'

/* -------------------------------------------------------------------------- */
/* Role registry                                                               */
/* -------------------------------------------------------------------------- */

describe('the role registry is typed, not stringly', () => {
  it('knows every role the hosted chain installs', () => {
    const ids = AUTHORITY_ROLE_REGISTRY.map((r) => r.id)

    expect(ids).toContain('uellix_owner')
    expect(ids).toContain('uellix_migrator')
    expect(ids).toContain('uellix_cap_grounding')
    expect(ids).toContain('uellix_cap_stella_quota')
    expect(ids).toContain('uellix_cap_stella_ticket')
  })

  it('refuses a role it does not know, instead of interpolating it into SQL', () => {
    // A primitive that accepted an arbitrary string would let a typo, or an
    // attacker-controlled name, reach a GRANT. Every role-generating primitive
    // takes a HostedRoleIdentifier and nothing else.
    expect(() => hostedRole('uellix_ownerr')).toThrow(/AUTHORITY_UNKNOWN_ROLE/)
    expect(() => hostedRole('postgres')).toThrow(/AUTHORITY_UNKNOWN_ROLE/)
  })

  it('separates capability roles from the owner role', () => {
    expect(isCapabilityRole('uellix_cap_grounding')).toBe(true)
    expect(isCapabilityRole('uellix_owner')).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* RT-09 — the session-role tripwire                                           */
/* -------------------------------------------------------------------------- */

describe('RT-09: a membership statement may never name the session role', () => {
  it('governs all three spellings', () => {
    expect([...SESSION_ROLE_KEYWORDS].sort()).toEqual([
      'CURRENT_ROLE',
      'CURRENT_USER',
      'SESSION_USER',
    ])
  })

  it.each(['CURRENT_USER', 'SESSION_USER', 'CURRENT_ROLE'])(
    'refuses GRANT ... TO %s',
    (keyword) => {
      expect(() => assertNoSessionRoleGrantee(`GRANT uellix_owner TO ${keyword};`)).toThrow(
        /AUTHORITY_MEMBERSHIP_SELF_REFERENCE/,
      )
    },
  )

  it.each(['CURRENT_USER', 'SESSION_USER', 'CURRENT_ROLE'])(
    'refuses REVOKE ... FROM %s',
    (keyword) => {
      expect(() => assertNoSessionRoleGrantee(`REVOKE uellix_owner FROM ${keyword};`)).toThrow(
        /AUTHORITY_MEMBERSHIP_SELF_REFERENCE/,
      )
    },
  )

  it('refuses it inside dynamic SQL, where the text only exists at run time', () => {
    const statement = [
      'DO $$',
      'BEGIN',
      "  EXECUTE 'GRANT uellix_owner TO CURRENT_USER';",
      'END $$;',
    ].join('\n')

    expect(() => assertNoSessionRoleGrantee(statement)).toThrow(
      /AUTHORITY_MEMBERSHIP_SELF_REFERENCE/,
    )
  })

  it('refuses it inside dynamic SQL built with format()', () => {
    const statement = [
      'DO $$',
      'BEGIN',
      "  EXECUTE format('GRANT %I TO SESSION_USER', 'uellix_owner');",
      'END $$;',
    ].join('\n')

    expect(() => assertNoSessionRoleGrantee(statement)).toThrow(
      /AUTHORITY_MEMBERSHIP_SELF_REFERENCE/,
    )
  })

  it('does not fire on a comment that mentions the keyword', () => {
    const statement = [
      '-- Never write GRANT uellix_owner TO CURRENT_USER: see RT-09.',
      'GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE, SET TRUE;',
    ].join('\n')

    expect(() => assertNoSessionRoleGrantee(statement)).not.toThrow()
  })

  it('does not fire on a RAISE message that quotes the forbidden form', () => {
    // A refusal message is the single most likely place for this text to appear
    // legitimately — the package that FORBIDS the pattern has to name it.
    const statement = [
      'DO $$',
      'BEGIN',
      "  RAISE EXCEPTION 'refusing: GRANT uellix_owner TO CURRENT_USER is never permitted here';",
      'END $$;',
    ].join('\n')

    expect(() => assertNoSessionRoleGrantee(statement)).not.toThrow()
  })

  it('does not fire on prose inside a function body', () => {
    const statement = [
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.helper() RETURNS void AS $$',
      'BEGIN',
      '  -- SESSION_USER is deliberately not used as a grantee anywhere below.',
      '  PERFORM 1;',
      'END $$ LANGUAGE plpgsql;',
    ].join('\n')

    expect(() => assertNoSessionRoleGrantee(statement)).not.toThrow()
  })

  it('does not fire on a legitimate reference to SESSION_USER that is not a grantee', () => {
    const statement = "SELECT 1 WHERE SESSION_USER = 'uellix_migrator';"

    expect(() => assertNoSessionRoleGrantee(statement)).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* The state machine                                                           */
/* -------------------------------------------------------------------------- */

describe('AuthorityStateMachine (M6: RESET ROLE is not a stack)', () => {
  it('starts as the installer', () => {
    expect(new AuthorityStateMachine().state).toBe('installer')
  })

  it('opens and closes an owner window', () => {
    const machine = new AuthorityStateMachine()
    machine.enter('owner')
    expect(machine.state).toBe('owner')
    machine.leave()
    expect(machine.state).toBe('installer')
  })

  it('refuses to go from owner straight to capability', () => {
    // Measured (M6): `SET ROLE a; SET ROLE b; RESET ROLE` lands on the SESSION
    // role, not on `a`. So a nested elevation has no way back to its outer
    // level, and the plan must return to the installer between windows rather
    // than pretend a stack exists.
    const machine = new AuthorityStateMachine()
    machine.enter('owner')

    expect(() => machine.enter('capability')).toThrow(/AUTHORITY_STATE_TRANSITION_INVALID/)
  })

  it('refuses to leave a window it never entered', () => {
    expect(() => new AuthorityStateMachine().leave()).toThrow(
      /AUTHORITY_STATE_TRANSITION_INVALID/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* The primitives                                                              */
/* -------------------------------------------------------------------------- */

describe('ownerWindowPrimitive', () => {
  const primitive = ownerWindowPrimitive('uellix_migrator')

  it('grants membership scoped to a named grantor, so cleanup can be scoped too (M3a)', () => {
    expect(primitive.open.join('\n')).toContain(
      'GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE, SET TRUE;',
    )
  })

  it('closes with RESET ROLE and a revoke, in that order', () => {
    expect(primitive.close[0]).toBe('RESET ROLE;')
    expect(primitive.close.join('\n')).toContain('REVOKE uellix_owner FROM uellix_migrator')
  })

  it('emits nothing a membership tripwire would refuse', () => {
    for (const statement of [...primitive.open, ...primitive.close]) {
      expect(() => assertNoSessionRoleGrantee(statement), statement).not.toThrow()
    }
  })
})

describe('capabilityWindowPrimitive', () => {
  it('does not touch schema CREATE when the window does not need it', () => {
    const primitive = capabilityWindowPrimitive({
      installer: 'uellix_migrator',
      capabilityRole: 'uellix_cap_stella_ticket',
      schema: 'uellix_stella_ops',
      needsTemporarySchemaCreate: false,
    })

    expect(primitive.open.join('\n')).not.toContain('GRANT CREATE ON SCHEMA')
    expect(primitive.close.join('\n')).not.toContain('REVOKE CREATE ON SCHEMA')
  })

  it('nests the temporary CREATE grant inside an owner window (M5)', () => {
    // Measured: the installer cannot GRANT CREATE on a schema owned by
    // uellix_owner — membership with INHERIT FALSE is not enough and PostgreSQL
    // answers `permission denied for schema`. So the grant is issued as the
    // owner, and the owner elevation is closed again before the capability role
    // is entered.
    const primitive = capabilityWindowPrimitive({
      installer: 'uellix_migrator',
      capabilityRole: 'uellix_cap_grounding',
      schema: 'uellix_grounding',
      needsTemporarySchemaCreate: true,
    })
    const open = primitive.open.join('\n')

    expect(open).toContain('SET ROLE uellix_owner;')
    expect(open).toContain('GRANT CREATE ON SCHEMA uellix_grounding TO uellix_cap_grounding;')
    expect(open.indexOf('SET ROLE uellix_owner;')).toBeLessThan(
      open.indexOf('GRANT CREATE ON SCHEMA'),
    )
    expect(open.indexOf('GRANT CREATE ON SCHEMA')).toBeLessThan(
      open.indexOf('SET ROLE uellix_cap_grounding;'),
    )
  })

  it('revokes the temporary CREATE as the owner, because the grant was made as the owner', () => {
    const primitive = capabilityWindowPrimitive({
      installer: 'uellix_migrator',
      capabilityRole: 'uellix_cap_grounding',
      schema: 'uellix_grounding',
      needsTemporarySchemaCreate: true,
    })
    const close = primitive.close.join('\n')

    expect(close).toContain('REVOKE CREATE ON SCHEMA uellix_grounding FROM uellix_cap_grounding;')
    expect(close.indexOf('SET ROLE uellix_owner;')).toBeLessThan(close.indexOf('REVOKE CREATE'))
  })
})

describe('ownerTransferPrimitive', () => {
  it('holds membership in BOTH the outgoing and the incoming owner', () => {
    const primitive = ownerTransferPrimitive({
      installer: 'uellix_migrator',
      from: 'uellix_owner',
      to: 'uellix_cap_stella_quota',
    })
    const open = primitive.open.join('\n')

    expect(open).toContain('GRANT uellix_owner TO uellix_migrator')
    expect(open).toContain('GRANT uellix_cap_stella_quota TO uellix_migrator')
  })
})

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                     */
/* -------------------------------------------------------------------------- */

describe('assertCleanupComplete', () => {
  it('accepts a primitive whose every grant is matched by a scoped revoke', () => {
    const primitive = ownerWindowPrimitive('uellix_migrator')

    expect(() => assertCleanupComplete('T1/W01', primitive)).not.toThrow()
  })

  it('refuses a window that grants membership and never revokes it', () => {
    const leaky = {
      open: ['GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE, SET TRUE;', 'SET ROLE uellix_owner;'],
      close: ['RESET ROLE;'],
    }

    expect(() => assertCleanupComplete('T1/W01', leaky)).toThrow(AuthorityRefusal)
    expect(() => assertCleanupComplete('T1/W01', leaky)).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })

  it('refuses a window that grants schema CREATE and never revokes it', () => {
    const leaky = {
      open: [
        'SET ROLE uellix_owner;',
        'GRANT CREATE ON SCHEMA uellix_grounding TO uellix_cap_grounding;',
        'RESET ROLE;',
      ],
      close: ['RESET ROLE;'],
    }

    expect(() => assertCleanupComplete('T1/W02', leaky)).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })

  it('refuses a revoke that does not name the same grantor as its grant (M3a)', () => {
    // Measured: an unqualified REVOKE removes only the issuing grantor's row.
    // A cleanup issued by a different identity than the grant would therefore
    // remove nothing and report success.
    const mismatched = {
      open: ['GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE, SET TRUE;'],
      close: ['RESET ROLE;', 'REVOKE uellix_owner FROM uellix_app;'],
    }

    expect(() => assertCleanupComplete('T1/W03', mismatched)).toThrow(
      /AUTHORITY_CLEANUP_INCOMPLETE/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* RT-07 — transitive SET reachability                                         */
/* -------------------------------------------------------------------------- */

describe('assertNoTransitiveElevation (M4: SET reachability is transitive)', () => {
  it('reads an edge only from a grant that carries SET TRUE', () => {
    const edges = membershipEdges([
      'GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE, SET TRUE;',
      'GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE;',
    ])

    // The second grant confers privileges without conferring the ability to
    // BECOME the role, so it is not an elevation path and must not be one here.
    expect(edges).toEqual([{ role: 'uellix_owner', member: 'uellix_migrator' }])
  })

  it('accepts a graph in which every reachable role is also granted directly', () => {
    expect(() =>
      assertNoTransitiveElevation(
        'T1/W01',
        membershipEdges([
          'GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE, SET TRUE;',
          'GRANT uellix_cap_grounding TO uellix_migrator WITH INHERIT FALSE, SET TRUE;',
        ]),
      ),
    ).not.toThrow()
  })

  it('refuses a role reachable only through an intermediate', () => {
    // Exactly the M4b shape: the installer is granted one innocuous role, and
    // gains a capability role nobody wrote down.
    expect(() =>
      assertNoTransitiveElevation(
        'T1/W01',
        membershipEdges([
          'GRANT uellix_cap_stella_quota TO uellix_owner WITH INHERIT FALSE, SET TRUE;',
          'GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE, SET TRUE;',
        ]),
      ),
    ).toThrow(/AUTHORITY_STATE_TRANSITION_INVALID/)
  })

  it('finds no transitive path in what the primitives themselves emit', () => {
    const emitted = [
      ...ownerWindowPrimitive('uellix_migrator').open,
      ...capabilityWindowPrimitive({
        installer: 'uellix_migrator',
        capabilityRole: 'uellix_cap_grounding',
        schema: 'uellix_grounding',
        needsTemporarySchemaCreate: true,
      }).open,
      ...ownerTransferPrimitive({
        installer: 'uellix_migrator',
        from: 'uellix_owner',
        to: 'uellix_cap_stella_quota',
      }).open,
    ]

    expect(() => assertNoTransitiveElevation('all primitives', membershipEdges(emitted))).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* The tripwire against the real packages                                      */
/* -------------------------------------------------------------------------- */

describe('RT-09 over the nine chain packages', () => {
  it('does not fire on any statement of any package as they stand today', () => {
    // The false-positive half of the tripwire, measured against the only corpus
    // that matters. These packages contain comments and RAISE messages naming
    // role mechanics at length; a scanner that fired on them would be turned off
    // within a day and would then be protecting nothing.
    for (const { packageId, sourceFile } of CHAIN_PACKAGE_FILES) {
      const statements = splitSqlStatements(readFileSync(`db/prepared/${sourceFile}`, 'utf8'))
      for (const statement of statements) {
        expect(
          () => assertNoSessionRoleGrantee(statement.raw),
          `${packageId} statement ${statement.index}`,
        ).not.toThrow()
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/* F2 — a bare GRANT confers SET, and must not be invisible                    */
/* -------------------------------------------------------------------------- */

describe('F2: membership is read structurally, not by a regex that demands WITH', () => {
  it('parses a bare GRANT and models set_option as TRUE, as measured on 17.6', () => {
    // MEASURED, disposable 17.6 lab, image 17.6.1.143, network none:
    //   GRANT lab_cap TO lab_owner;   ->  admin_option=f inherit_option=f set_option=t
    //   pg_has_role('lab_owner','lab_cap','SET') = TRUE
    // So the option that decides elevation is granted BY DEFAULT. A checker that
    // only looked at statements containing `WITH` would have seen nothing here.
    const parsed = parseMembershipStatement('GRANT uellix_cap_grounding TO uellix_owner;')

    expect(parsed).not.toBeNull()
    expect(parsed!.kind).toBe('grant')
    expect(parsed!.roles).toEqual(['uellix_cap_grounding'])
    expect(parsed!.members).toEqual(['uellix_owner'])
    expect(parsed!.setOption).toBe(true)
  })

  it('honours an explicit SET FALSE', () => {
    const parsed = parseMembershipStatement(
      'GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE;',
    )

    expect(parsed!.setOption).toBe(false)
  })

  it('returns null for a privilege grant, which is a different act entirely', () => {
    expect(parseMembershipStatement('GRANT SELECT ON public.projects TO uellix_app;')).toBeNull()
  })

  it('yields a membership edge for a bare GRANT — the F2 regression', () => {
    const edges = membershipEdges(['GRANT uellix_cap_grounding TO uellix_owner;'])

    expect(edges).toEqual([{ role: 'uellix_cap_grounding', member: 'uellix_owner' }])
  })

  it('makes a bare GRANT visible to the transitive reachability check', () => {
    expect(() =>
      assertNoTransitiveElevation(
        'T1/W01',
        membershipEdges([
          'GRANT uellix_cap_stella_quota TO uellix_owner;',
          'GRANT uellix_owner TO uellix_migrator;',
        ]),
      ),
    ).toThrow(/AUTHORITY_STATE_TRANSITION_INVALID/)
  })

  it('fires the RT-09 tripwire on a bare GRANT to a session role', () => {
    expect(() => assertNoSessionRoleGrantee('GRANT uellix_owner TO CURRENT_USER;')).toThrow(
      /AUTHORITY_MEMBERSHIP_SELF_REFERENCE/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* F1 — cleanup must inspect every phase, not only `open`                      */
/* -------------------------------------------------------------------------- */

describe('F1: an acquisition in any phase must be released', () => {
  it('refuses membership acquired in close and never revoked', () => {
    expect(() =>
      assertCleanupComplete('T1/W01', {
        open: [],
        close: ['GRANT uellix_cap_grounding TO uellix_owner;'],
      }),
    ).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })

  it('refuses schema CREATE acquired in close and never revoked', () => {
    expect(() =>
      assertCleanupComplete('T1/W02', {
        open: [],
        close: ['GRANT CREATE ON SCHEMA uellix_grounding TO uellix_cap_grounding;'],
      }),
    ).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })

  it('refuses membership acquired in the body phase and never revoked', () => {
    expect(() =>
      assertCleanupComplete('T1/W03', {
        open: ['SET ROLE uellix_owner;'],
        body: ['GRANT uellix_cap_stella_ticket TO uellix_migrator;'],
        close: ['RESET ROLE;'],
      }),
    ).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })

  it('accepts an acquisition in body that the same phase releases', () => {
    expect(() =>
      assertCleanupComplete('T1/W04', {
        open: ['SET ROLE uellix_owner;'],
        body: [
          'GRANT CREATE ON SCHEMA uellix_grounding TO uellix_cap_grounding;',
          'REVOKE CREATE ON SCHEMA uellix_grounding FROM uellix_cap_grounding;',
        ],
        close: ['RESET ROLE;'],
      }),
    ).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* Typing                                                                      */
/* -------------------------------------------------------------------------- */

describe('role-generating primitives take identifiers, not strings', () => {
  it('accepts only registry members at the type level and at run time', () => {
    const role: HostedRoleIdentifier = 'uellix_cap_stella_quota'

    expect(hostedRole(role).kind).toBe('capability')
  })
})

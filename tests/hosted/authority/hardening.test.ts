// tests/hosted/authority/hardening.test.ts
// COMMIT 3.1 — the findings of the independent formal review, each closed and
// each attacked.
//
// Every test here is written from the failure, not from the fix: the case
// describes what would have gone wrong in the generator, and then asserts the
// refusal. A finding closed without a test that fails when the fix is removed
// is a finding closed on paper.

import { describe, expect, it } from 'vitest'

import {
  buildAuthorityPlan,
  segmentWindowForTest,
} from '@/db/hosted/authority/classification-manifest'
import { canonicalRoleContextOf } from '@/db/hosted/authority/canonical-role-context'
import {
  resolveExecutionDispositions,
  validateResolvedAuthorityPlanForGeneration,
} from '@/db/hosted/authority/execution-disposition'
import { assertNoSessionRoleGrantee } from '@/db/hosted/authority/membership-tripwire'
import { parseMembershipStatement } from '@/db/hosted/authority/membership'
import {
  assertCleanupComplete,
  capabilityWindowPrimitive,
  ownerWindowPrimitive,
} from '@/db/hosted/authority/primitives'
import {
  formatObjectIdentity,
  parseStatementIdentity,
  statementIdentityKey,
} from '@/db/hosted/authority/structural-identity'
import { normalizeExecutable, splitSqlStatements } from '@/db/hosted/authority/sql-statements'
import { INSTALLER_OWNER, OWNER_ROLE, type SimulatedStatement } from '@/db/hosted/authority/ownership-simulation'
import { AuthorityRefusal } from '@/db/hosted/authority/window-contract'

const plan = buildAuthorityPlan()
const gate = validateResolvedAuthorityPlanForGeneration(plan)

/* -------------------------------------------------------------------------- */
/* F-01 — the canonical role-context seam                                      */
/* -------------------------------------------------------------------------- */

describe('F-01: a statement outside every window can still require an elevated role', () => {
  it('finds exactly three such statements, and they are the three CREATE TABLEs', () => {
    // The failure this prevents is silent. `CREATE TABLE` makes the executing
    // role the OWNER, so running these as the installer would create three
    // tables owned by postgres. Nothing would error — every later GRANT,
    // POLICY and ALTER on them would still work, because the installer owns
    // them — and the whole ownership model would be wrong.
    const contexts = gate.canonicalRoleContexts

    expect(contexts).toHaveLength(3)
    expect(
      contexts.map((c) => `${c.packageId}:${c.statementIdentity}`),
    ).toEqual([
      'T1:create-table:table:public.evidence_document_versions',
      'T2:create-table:table:public.evidence_chunks',
      'T5:create-table:table:uellix_stella_ops.operation_tickets',
    ])
    for (const context of contexts) {
      expect(context.requiredExecutor).toBe(OWNER_ROLE)
      expect(context.provenance).toBe('CANONICAL_SET_ROLE_SPAN')
      expect(context.digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('derives the role from the SET ROLE statements, not from the previous statement', () => {
    const rows = splitSqlStatements(
      ['SET ROLE uellix_owner;', 'CREATE TABLE s.x (id int);', 'RESET ROLE;', 'SELECT 1;'].join('\n'),
    ).map((statement) => ({
      packageId: 'TX',
      statement,
      identity: parseStatementIdentity(statement.raw),
      ownerBefore: null,
      ownerDestination: null,
    })) as unknown as SimulatedStatement[]

    const contexts = canonicalRoleContextOf('TX', rows)

    expect(contexts.map((c) => c.context)).toEqual([
      INSTALLER_OWNER, // the SET ROLE itself
      OWNER_ROLE, // the CREATE TABLE
      INSTALLER_OWNER, // the RESET ROLE
      INSTALLER_OWNER, // after it
    ])
  })

  it('refuses a nested SET ROLE, because PostgreSQL cannot unwind one', () => {
    const rows = splitSqlStatements(
      ['SET ROLE uellix_owner;', 'SET ROLE uellix_cap_grounding;', 'RESET ROLE;'].join('\n'),
    ).map((statement) => ({
      packageId: 'TX',
      statement,
      identity: parseStatementIdentity(statement.raw),
      ownerBefore: null,
      ownerDestination: null,
    })) as unknown as SimulatedStatement[]

    expect(() => canonicalRoleContextOf('TX', rows)).toThrow(/AUTHORITY_ROLE_CONTEXT_AMBIGUOUS/)
  })

  it('refuses a span left open at end of package', () => {
    const rows = splitSqlStatements(['SET ROLE uellix_owner;', 'SELECT 1;'].join('\n')).map(
      (statement) => ({
        packageId: 'TX',
        statement,
        identity: parseStatementIdentity(statement.raw),
        ownerBefore: null,
        ownerDestination: null,
      }),
    ) as unknown as SimulatedStatement[]

    expect(() => canonicalRoleContextOf('TX', rows)).toThrow(/AUTHORITY_ROLE_CONTEXT_AMBIGUOUS/)
  })

  it('refuses a RESET ROLE with nothing open', () => {
    const rows = splitSqlStatements('RESET ROLE;').map((statement) => ({
      packageId: 'TX',
      statement,
      identity: parseStatementIdentity(statement.raw),
      ownerBefore: null,
      ownerDestination: null,
    })) as unknown as SimulatedStatement[]

    expect(() => canonicalRoleContextOf('TX', rows)).toThrow(/AUTHORITY_ROLE_CONTEXT_AMBIGUOUS/)
  })

  it('keeps an owner-context CREATE TABLE out of the installer disposition', () => {
    const dispositions = resolveExecutionDispositions(plan)
    const createTables = dispositions.filter((d) =>
      d.statementIdentity.startsWith('create-table:'),
    )

    expect(createTables).toHaveLength(3)
    for (const disposition of createTables) {
      expect(disposition.kind).toBe('CANONICAL_ROLE_CONTEXT')
      expect(disposition.requiredExecutor).toBe(OWNER_ROLE)
      expect(disposition.requiredExecutor).not.toBe(INSTALLER_OWNER)
    }
  })

  it('does not touch the provenance metrics it is not allowed to touch', () => {
    // The recovered partition still says INSTALLER = 8. The execution model is
    // a SEPARATE axis on which three of those eight are owner-context. Merging
    // the two would have rewritten provenance to make the generator convenient.
    const dispositions = resolveExecutionDispositions(plan)
    const installerDisposition = dispositions.filter((d) => d.kind === 'INSTALLER')

    expect(installerDisposition).toHaveLength(5)
    expect(gate.canonicalRoleContexts).toHaveLength(3)
    expect(installerDisposition.length + gate.canonicalRoleContexts.length).toBe(8)
  })
})

/* -------------------------------------------------------------------------- */
/* F-01 crosscheck — no residual bucket                                        */
/* -------------------------------------------------------------------------- */

describe('every statement resolves to a named disposition', () => {
  it('covers every statement of every package, with no "everything else"', () => {
    const dispositions = resolveExecutionDispositions(plan)
    const total = [...plan.rowsByPackage.values()].reduce((n, rows) => n + rows.length, 0)

    expect(dispositions).toHaveLength(total)
    for (const disposition of dispositions) {
      expect(disposition.reason.length, disposition.statementIdentity).toBeGreaterThan(20)
    }
  })

  it('gives every installer disposition a POSITIVE justification, not a default', () => {
    const dispositions = resolveExecutionDispositions(plan)
    for (const disposition of dispositions.filter((d) => d.kind === 'INSTALLER')) {
      expect(disposition.reason).toMatch(/CREATE SCHEMA is a database-level act|owned by the installer/)
    }
  })

  it('refuses a statement it cannot place instead of calling it an installer statement', () => {
    // Synthesised: a GRANT on a capability-owned function, outside every window
    // and outside every SET ROLE span. There is no honest disposition for it.
    const rows = splitSqlStatements(
      'GRANT EXECUTE ON FUNCTION uellix_stella.f(uuid) TO uellix_app;',
    ).map((statement) => ({
      packageId: 'TX',
      statement,
      identity: parseStatementIdentity(statement.raw),
      ownerBefore: 'uellix_cap_stella_quota',
      ownerDestination: null,
    })) as unknown as SimulatedStatement[]

    const orphanPlan = {
      windows: [],
      segments: [],
      rowsByPackage: new Map([['T1', rows]]),
    } as unknown as typeof plan

    expect(() => resolveExecutionDispositions(orphanPlan)).toThrow(
      /AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* F-03 — the cleanup event model fails closed                                 */
/* -------------------------------------------------------------------------- */

describe('F-03: an authority-changing statement inside a primitive is never ignored', () => {
  it('models a multi-role GRANT as its cross product, and refuses when unbalanced', () => {
    expect(() =>
      assertCleanupComplete('attack', {
        open: ['GRANT uellix_cap_grounding, uellix_cap_stella_quota TO uellix_migrator;'],
        close: ['REVOKE uellix_cap_grounding FROM uellix_migrator;'],
      }),
    ).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })

  it('models a multi-member GRANT the same way', () => {
    expect(() =>
      assertCleanupComplete('attack', {
        open: ['GRANT uellix_owner TO uellix_migrator, uellix_app;'],
        close: ['REVOKE uellix_owner FROM uellix_migrator;'],
      }),
    ).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })

  it('accepts a multi-pair form that IS fully released', () => {
    expect(() =>
      assertCleanupComplete('balanced', {
        open: ['GRANT uellix_cap_grounding, uellix_cap_stella_quota TO uellix_migrator;'],
        close: [
          'REVOKE uellix_cap_grounding FROM uellix_migrator;',
          'REVOKE uellix_cap_stella_quota FROM uellix_migrator;',
        ],
      }),
    ).not.toThrow()
  })

  it('sees GRANT ALL ON SCHEMA, which confers CREATE without naming it', () => {
    expect(() =>
      assertCleanupComplete('attack', {
        open: ['GRANT ALL ON SCHEMA uellix_grounding TO uellix_cap_grounding;'],
        close: [],
      }),
    ).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })

  it('refuses REVOKE ADMIN OPTION FOR, which narrows a membership without removing it', () => {
    expect(() =>
      assertCleanupComplete('attack', {
        open: ['GRANT uellix_owner TO uellix_migrator WITH ADMIN OPTION;'],
        close: ['REVOKE ADMIN OPTION FOR uellix_owner FROM uellix_migrator;'],
      }),
    ).toThrow(/AUTHORITY_PRIVILEGE_EVENT_UNSUPPORTED/)
  })

  it('reports option-only revokes structurally, not by guesswork', () => {
    const parsed = parseMembershipStatement('REVOKE ADMIN OPTION FOR uellix_owner FROM uellix_migrator;')

    expect(parsed?.optionOnly).toBe(true)
    expect(parseMembershipStatement('REVOKE uellix_owner FROM uellix_migrator;')?.optionOnly).toBe(false)
  })

  it('refuses an unmodelled statement form inside a primitive rather than stepping over it', () => {
    expect(() =>
      assertCleanupComplete('attack', { open: ['MERGE INTO t USING s ON true;'], close: [] }),
    ).toThrow(/UNSUPPORTED_STRUCTURAL_IDENTITY/)
  })
})

/* -------------------------------------------------------------------------- */
/* F-04 — the session principal as an expression                               */
/* -------------------------------------------------------------------------- */

describe('F-04: a session principal supplied as an EXECUTE expression', () => {
  it.each(['current_user', 'session_user', 'current_role'])(
    'refuses string concatenation with %s',
    (keyword) => {
      const statement = [
        'DO $$',
        'BEGIN',
        `  EXECUTE 'GRANT uellix_owner TO ' || ${keyword};`,
        'END $$;',
      ].join('\n')

      expect(() => assertNoSessionRoleGrantee(statement)).toThrow(
        /AUTHORITY_MEMBERSHIP_SELF_REFERENCE/,
      )
    },
  )

  it.each(['current_user', 'session_user', 'current_role'])(
    'refuses format() with %s as an argument',
    (keyword) => {
      const statement = [
        'DO $$',
        'BEGIN',
        `  EXECUTE format('GRANT %I TO %I', 'uellix_owner', ${keyword});`,
        'END $$;',
      ].join('\n')

      expect(() => assertNoSessionRoleGrantee(statement)).toThrow(
        /AUTHORITY_MEMBERSHIP_SELF_REFERENCE/,
      )
    },
  )

  it('still does not fire on a RAISE message that names the principal', () => {
    const statement = [
      'DO $$',
      'BEGIN',
      "  RAISE EXCEPTION 'refusing: GRANT uellix_owner TO %', current_user;",
      'END $$;',
    ].join('\n')

    expect(() => assertNoSessionRoleGrantee(statement)).not.toThrow()
  })

  it('still does not fire on an ordinary predicate that is not building a grant', () => {
    const statement = [
      'DO $$',
      'BEGIN',
      "  IF current_user <> 'uellix_migrator' THEN",
      "    RAISE EXCEPTION 'wrong applier';",
      '  END IF;',
      'END $$;',
    ].join('\n')

    expect(() => assertNoSessionRoleGrantee(statement)).not.toThrow()
  })

  it('still does not fire on dynamic SQL that builds no membership statement', () => {
    const statement = [
      'DO $$',
      'BEGIN',
      "  EXECUTE 'SET search_path = ' || current_user;",
      'END $$;',
    ].join('\n')

    expect(() => assertNoSessionRoleGrantee(statement)).not.toThrow()
  })

  it('does not fire on any statement of the real chain', () => {
    for (const [packageId, rows] of plan.rowsByPackage) {
      for (const row of rows) {
        expect(
          () => assertNoSessionRoleGrantee(row.statement.raw),
          `${packageId}[${row.statement.index}]`,
        ).not.toThrow()
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/* F-05 — a runtime role can never be the temporary member                     */
/* -------------------------------------------------------------------------- */

describe('F-05: temporary elevation is granted only to the installer', () => {
  // COMMIT 5.1 re-points these at the CAPABILITY window. The owner window no
  // longer grants a membership at all — PG 17.6 refuses the grant unless the
  // installer holds ADMIN on uellix_owner, and the persistent membership from
  // stella_hosted_0001 §2b makes it unnecessary — so it no longer reaches the
  // guard. The guard itself is unchanged and still governs every primitive that
  // DOES grant: the capability window and the transfer.
  const capabilityWindowFor = (member: string) =>
    capabilityWindowPrimitive({
      installer: member as never,
      capabilityRole: 'uellix_cap_grounding',
      schema: 'uellix_grounding',
      needsTemporarySchemaCreate: false,
    })

  it.each(['uellix_app', 'uellix_writer', 'uellix_auditor'])(
    'refuses %s as the member, at run time and not only in the type',
    (role) => {
      expect(() => capabilityWindowFor(role)).toThrow(/AUTHORITY_TEMP_MEMBER_NOT_INSTALLER/)
    },
  )

  it('refuses a capability role as the member', () => {
    expect(() => capabilityWindowFor('uellix_cap_stella_quota')).toThrow(
      /AUTHORITY_TEMP_MEMBER_NOT_INSTALLER/,
    )
  })

  it('refuses the owner as its own member', () => {
    expect(() => capabilityWindowFor('uellix_owner')).toThrow(
      /AUTHORITY_TEMP_MEMBER_NOT_INSTALLER/,
    )
  })

  it('accepts the installer', () => {
    expect(() => capabilityWindowFor('uellix_migrator')).not.toThrow()
    expect(() => ownerWindowPrimitive('uellix_migrator')).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* F-06 — CREATE SCHEMA AUTHORIZATION is part of the identity                  */
/* -------------------------------------------------------------------------- */

describe('F-06: CREATE SCHEMA carries its AUTHORIZATION target', () => {
  it('separates two schemas of the same name authorized to different roles', () => {
    const a = parseStatementIdentity('CREATE SCHEMA IF NOT EXISTS s AUTHORIZATION uellix_owner;')
    const b = parseStatementIdentity('CREATE SCHEMA IF NOT EXISTS s AUTHORIZATION uellix_app;')

    expect(formatObjectIdentity(a.object!)).toBe(formatObjectIdentity(b.object!))
    expect(statementIdentityKey(a)).not.toBe(statementIdentityKey(b))
  })

  it('reads AUTHORIZATION on the three real CREATE SCHEMA statements', () => {
    const creations = [...plan.rowsByPackage.values()]
      .flat()
      .filter((row) => row.identity.statementClass === 'create-schema')

    expect(creations).toHaveLength(3)
    for (const row of creations) {
      expect(row.identity.operands).toEqual([OWNER_ROLE])
    }
  })

  it('keeps a schema created without AUTHORIZATION distinguishable', () => {
    const bare = parseStatementIdentity('CREATE SCHEMA s;')
    const owned = parseStatementIdentity('CREATE SCHEMA s AUTHORIZATION uellix_owner;')

    expect(statementIdentityKey(bare)).not.toBe(statementIdentityKey(owned))
  })
})

/* -------------------------------------------------------------------------- */
/* F-07 — an unknown owner never becomes the owner role                        */
/* -------------------------------------------------------------------------- */

describe('F-07: a capability statement with unknown ownership refuses', () => {
  it('does not fall back to uellix_owner', () => {
    // The old fallback promoted an unclassifiable statement to the most
    // privileged executor in the plan — the unsafe direction by construction.
    const rows = splitSqlStatements('COMMENT ON FUNCTION s.f(uuid) IS \'x\';').map((statement) => ({
      packageId: 'T1',
      statement,
      identity: parseStatementIdentity(statement.raw),
      ownerBefore: null,
      ownerDestination: null,
    })) as unknown as SimulatedStatement[]

    const window = {
      ...plan.windows.find((w) => w.authorityClass === 'CAPABILITY')!,
      members: rows,
      structuralStatementCount: 1,
    }
    expect(() => segmentWindowForTest(window)).toThrow(/AUTHORITY_EXECUTOR_OWNER_UNKNOWN/)
  })
})

/* -------------------------------------------------------------------------- */
/* F-08 — one gate, and no misleading scalar                                   */
/* -------------------------------------------------------------------------- */

describe('F-08: the pre-generation gate', () => {
  it('passes on the real resolved plan and names every check it ran', () => {
    expect(gate.checks.length).toBeGreaterThanOrEqual(9)
    expect(gate.dispositions.length).toBeGreaterThan(0)
  })

  it('fails when a segment executor is mutated, even though the window is untouched', () => {
    const mutated = {
      ...plan,
      segments: plan.segments.map((s) =>
        s.segmentId === 'W38.S2' ? { ...s, executor: 'uellix_cap_stella_quota' } : s,
      ),
    }

    expect(() => validateResolvedAuthorityPlanForGeneration(mutated)).toThrow(AuthorityRefusal)
    expect(() => validateResolvedAuthorityPlanForGeneration(mutated)).toThrow(
      /AUTHORITY_EXECUTOR_ROLE_MISMATCH/,
    )
  })

  it('fails when a window loses a digest', () => {
    const mutated = {
      ...plan,
      windows: plan.windows.map((w) =>
        w.windowId === 'W05'
          ? { ...w, statementDigestSequence: w.statementDigestSequence.slice(1) }
          : w,
      ),
    }

    expect(() => validateResolvedAuthorityPlanForGeneration(mutated)).toThrow(
      /AUTHORITY_WINDOW_DIGEST_DRIFT/,
    )
  })

  it('fails when segmentation stops covering a window', () => {
    const mutated = {
      ...plan,
      segments: plan.segments.filter((s) => s.segmentId !== 'W47.S3'),
    }

    expect(() => validateResolvedAuthorityPlanForGeneration(mutated)).toThrow(AuthorityRefusal)
  })
})

/* -------------------------------------------------------------------------- */
/* F-08C — a comment cannot satisfy a boundary predicate                       */
/* -------------------------------------------------------------------------- */

describe('F-08C: boundary disambiguators read executable text, not source', () => {
  it('ignores a comment that quotes a disambiguator fragment', () => {
    // A reviewer writing `-- see pg_get_constraintdef above` over the wrong DO
    // block would otherwise make it answer to another window's anchor, and the
    // ambiguity refusal that followed would name the wrong statement.
    const withComment = splitSqlStatements(
      ['-- pg_get_constraintdef is read by the block below', 'SELECT 1;'].join('\n'),
    )[0]

    expect(normalizeExecutable(withComment.raw)).not.toContain('pg_get_constraintdef')
  })

  it('still resolves all 51 boundaries against executable text alone', () => {
    expect(plan.windows).toHaveLength(51)
  })
})

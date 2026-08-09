// tests/hosted/managed-compatibility.test.ts
// TRAIN 5B — Phases 11 and 12.
//
// ---------------------------------------------------------------------------
// WHAT THIS FIXTURE IS, AND WHAT IT HONESTLY IS NOT
// ---------------------------------------------------------------------------
// Phase 11 asks for a fixture that SIMULATES managed constraints. Docker is
// prohibited for this unit and no remote database may be contacted, so this
// cannot be a live PostgreSQL running as a non-superuser. It is a STRUCTURAL
// simulation: it reads the artefacts that would actually be sent and asserts
// the managed constraints over them.
//
// The instruction states the limit itself — "la simulación no sustituye la
// inspección hosted futura, pero debe detectar cualquier dependencia explícita
// de rolsuper" — and that lower bar is exactly what a structural check CAN
// guarantee, because an explicit dependency is a textual fact. What it cannot
// guarantee is behaviour under real privileges; that is CHECKPOINT A / gate G12
// and is listed in `missingForHosted`, not quietly assumed here.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildHostedArtefacts } from '@/db/hosted/artefacts'
import { HOSTED_CHAIN } from '@/db/hosted/hosted-package-manifest'
import { planHostedApply } from '@/db/hosted/hosted-migrator'
import { redactForHostedLog } from '@/db/hosted/target-identity'

const ARTEFACTS = buildHostedArtefacts()
const DERIVED = ARTEFACTS.filter((a) => a.packageName !== 'stella_hosted_0001_managed_role_bootstrap')
const BOOTSTRAP = readFileSync(
  path.join(process.cwd(), 'db', 'prepared', 'stella_hosted_0001_managed_role_bootstrap.sql'),
  'utf8',
).replace(/\r\n?/g, '\n')
const ROLLBACK = readFileSync(
  path.join(process.cwd(), 'db', 'prepared', 'stella_hosted_0001_rollback.sql'),
  'utf8',
).replace(/\r\n?/g, '\n')

/** Executable lines only — comments and string literals are prose, not SQL. */
function executableLines(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => {
      const t = line.trimStart()
      return t.length > 0 && !t.startsWith('--')
    })
}

describe('Phase 11 — no hosted artefact depends on rolsuper', () => {
  it.each(DERIVED.map((a) => [a.packageName] as const))(
    '%s has no superuser GUARD left on the hosted path',
    (name) => {
      const artefact = ARTEFACTS.find((a) => a.packageName === name)!
      expect(artefact.sql).not.toContain(
        'IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN',
      )
    },
  )

  it.each(DERIVED.map((a) => [a.packageName] as const))(
    '%s calls the capability assertion instead',
    (name) => {
      const artefact = ARTEFACTS.find((a) => a.packageName === name)!
      expect(artefact.sql).toContain(`PERFORM uellix_bootstrap.assert_hosted_capabilities('${name}')`)
    },
  )

  it('no artefact anywhere asks to become a superuser', () => {
    for (const artefact of ARTEFACTS) {
      for (const line of executableLines(artefact.sql)) {
        expect(line).not.toMatch(/ALTER\s+(ROLE|USER)\b[^;]*\s(?<!NO)SUPERUSER/i)
      }
    }
  })

  it('the surviving rolsuper mentions are POSTCONDITIONS about roles we create, never guards', () => {
    for (const artefact of DERIVED) {
      for (const line of executableLines(artefact.sql)) {
        if (!line.includes('rolsuper')) continue
        // Two shapes are legitimate: asserting a capability role holds none of
        // the dangerous attributes, and excluding superusers from an exhaustive
        // privilege sweep (a superuser always has every privilege).
        expect(
          line.includes('rolcanlogin OR rolsuper OR rolbypassrls') || line.includes('NOT r.rolsuper'),
        ).toBe(true)
      }
    }
  })
})

describe('Phase 11 — no runtime role gains BYPASSRLS or service_role anywhere', () => {
  it('the bootstrap creates every role NOBYPASSRLS', () => {
    const statements = BOOTSTRAP.match(/\b(CREATE|ALTER)\s+ROLE\b[^;]*/gi) ?? []
    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) {
      expect(statement).not.toMatch(/(?<!NO)BYPASSRLS/)
    }
  })

  it('the bootstrap format() role template itself pins NOBYPASSRLS and NOSUPERUSER', () => {
    expect(BOOTSTRAP).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT')
  })

  it('no artefact grants anything TO service_role', () => {
    for (const artefact of ARTEFACTS) {
      for (const line of executableLines(artefact.sql)) {
        expect(line).not.toMatch(/\bGRANT\b[^;]*\bTO\b[^;]*\bservice_role\b/i)
      }
    }
  })

  it('stella_0017 still REVOKES from service_role — the closure is preserved by the rewrite', () => {
    const a = ARTEFACTS.find((x) => x.packageName === 'stella_0017_governed_stella_consumption')!
    expect(a.sql).toContain('service_role')
    expect(a.sql).toMatch(/REVOKE[\s\S]{0,400}service_role/)
  })
})

describe('Phase 11 — actor, org, project and category binding survive the rewrite', () => {
  it('every rewritten actor site resolves the SESSION, never an argument', () => {
    for (const artefact of DERIVED) {
      for (const line of executableLines(artefact.sql)) {
        if (!line.includes('public.uellix_auth_uid()')) continue
        // The shim takes no argument. A rewrite that had introduced one would
        // mean the actor became caller-chosen, which is the whole defect class
        // R6a belongs to.
        expect(line).not.toMatch(/uellix_auth_uid\s*\([^)]/)
      }
    }
  })

  it('stella_0015 keeps the project on all four verbs', () => {
    const a = ARTEFACTS.find((x) => x.packageName === 'stella_0015_project_bound_operation_tickets')!
    expect(a.sql).toContain('p_expected_project_id')
    expect(a.sql).toContain('U0110')
  })

  it('stella_0016 keeps the reservation-aware arithmetic (R1)', () => {
    const a = ARTEFACTS.find((x) => x.packageName === 'stella_0016_reserved_quota_semantics')!
    expect(a.sql).toContain('U0111')
    expect(a.sql).toContain('stella_capacity')
  })

  it('stella_0018 keeps the mandatory expected capability (R6a) and the withdrawn grant (R6b)', () => {
    const a = ARTEFACTS.find((x) => x.packageName === 'stella_0018_category_bound_operation_tickets')!
    expect(a.sql).toContain('U0112')
    expect(a.sql).toContain('U0106')
    expect(a.sql).toMatch(/REVOKE[\s\S]{0,200}consume_stella_capacity/)
  })

  it('every SECURITY DEFINER function keeps an empty search_path', () => {
    for (const artefact of DERIVED) {
      const definers = (artefact.sql.match(/SECURITY DEFINER/g) ?? []).length
      if (definers === 0) continue
      expect(artefact.sql).toContain("SET search_path = ''")
    }
  })
})

describe('Phase 12 — attacks that must fail closed', () => {
  // The REAL staging ref: verifyStagingTarget is pinned, so a made-up ref is
  // now refused before these attacks reach the code they are aimed at.
  const REF = 'bvyzblhqymxruxdguaee'
  const sources: Record<string, string> = Object.fromEntries(
    HOSTED_CHAIN.map((n) => [
      n,
      readFileSync(
        path.join(
          process.cwd(),
          'db',
          'prepared',
          `${n === 'stella_hosted_0001_managed_role_bootstrap' ? n : n}.sql`,
        ),
        'utf8',
      ),
    ]),
  )

  function attack(overrides: Record<string, unknown>) {
    return planHostedApply({
      target: {
        declaredEnvironment: 'staging',
        declaredProjectRef: REF,
        connectionHost: `db.${REF}.supabase.co`,
        sentinel: { environment: 'staging', projectRef: REF },
      },
      packages: [...HOSTED_CHAIN],
      mode: 'dry-run',
      installedProbes: {},
      sources,
      ...overrides,
    } as Parameters<typeof planHostedApply>[0])
  }

  it('a production connection presented as staging is refused', () => {
    const plan = attack({
      target: {
        declaredEnvironment: 'staging',
        declaredProjectRef: REF,
        connectionHost: 'app.uellix.com',
        sentinel: { environment: 'staging', projectRef: REF },
      },
    })
    expect(plan.ok).toBe(false)
  })

  it('a modified package hash is refused', () => {
    const tampered = { ...sources }
    tampered['stella_0018_category_bound_operation_tickets'] += '\n-- tampered\n'
    const plan = attack({ sources: tampered })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_SOURCE_SHA_MISMATCH')
  })

  it('omitting stella_0018 is refused — R6a and R6b would stay open', () => {
    const plan = attack({
      packages: HOSTED_CHAIN.filter((n) => n !== 'stella_0018_category_bound_operation_tickets'),
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_TICKET_CHAIN_INCOMPLETE')
  })

  it('omitting the grounding chain is refused', () => {
    const plan = attack({ packages: HOSTED_CHAIN.filter((n) => !n.startsWith('grounding_')) })
    expect(plan.ok).toBe(false)
  })

  it('no refusal message can carry a connection string', () => {
    const plan = attack({
      target: {
        declaredEnvironment: 'postgresql://uellix_migrator:hunter2@db.x.supabase.co/postgres',
        declaredProjectRef: REF,
        connectionHost: `db.${REF}.supabase.co`,
        sentinel: null,
      },
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.message).not.toContain('hunter2')
      expect(plan.message).not.toContain('postgresql://')
    }
  })

  it('the bootstrap refuses an undeclared environment', () => {
    expect(BOOTSTRAP).toContain("uellix.bootstrap_environment")
    expect(BOOTSTRAP).toContain("IS DISTINCT FROM 'staging'")
  })

  it('the bootstrap refuses a caller without CREATEROLE, by name', () => {
    expect(BOOTSTRAP).toMatch(/lacks CREATEROLE/)
  })

  it('the bootstrap refuses a caller that cannot CREATE in public', () => {
    expect(BOOTSTRAP).toMatch(/cannot CREATE in schema public/)
  })

  it('the bootstrap refuses when auth is unreachable, and names the blocker', () => {
    expect(BOOTSTRAP).toContain('STELLA_TRAIN_5B_BLOCKED_AUTH_SCHEMA')
  })

  it('the capability assertion refuses without a staging sentinel row, from INSIDE the transaction', () => {
    expect(BOOTSTRAP).toContain('staging_sentinel row declaring environment=staging')
  })

  it('the rollback refuses while any chain package is still installed', () => {
    expect(ROLLBACK).toContain('stella_hosted_0001_rollback refused: chain package(s) still installed')
  })

  it('the rollback refuses an undeclared environment too', () => {
    expect(ROLLBACK).toContain("uellix.bootstrap_environment must be exactly ''staging''")
  })

  it('the rollback leaves no residue, and asserts it', () => {
    expect(ROLLBACK).toContain('the auth shim survived')
  })
})

// ---------------------------------------------------------------------------
// S1-DEFECT-001 — the schema-privilege block stella_0004 has and the hosted
// variant dropped.
//
// The first real apply of stella_hosted_0001 against managed staging failed at
// `ALTER TABLE public.stella_interactions OWNER TO uellix_owner` with
// `permission denied for schema public`. The error names the executor's problem
// but describes the NEW OWNER's: PostgreSQL's ATExecChangeOwner skips every
// permission check when the executor is a superuser, and when it is not, checks
// ACL_CREATE on the table's namespace against `newOwnerId`. Measured on
// PostgreSQL 17.6 — with the installer holding CREATE on public and SET on the
// owner, the statement still fails while the owner holds no CREATE, and
// succeeds the moment it does, one variable moved.
//
// Locally this never showed: `stella_0004` lines 418-421 grant exactly this,
// and the offline suite is textual and never runs Postgres.
//
// THE PRIVILEGE IS PERSISTENT ON PURPOSE. Five chain packages open
// `SET ROLE uellix_owner` and then CREATE a new table in `public`
// (grounding_0002, grounding_0003, stella_0007, stella_0008, stella_0010), so a
// grant/transfer/revoke window would move the failure from S1 into the chain.
// ---------------------------------------------------------------------------

describe('S1-DEFECT-001 — uellix_owner can own and create in schema public', () => {
  const upToTransfer = BOOTSTRAP.slice(
    0,
    BOOTSTRAP.indexOf('ALTER TABLE public.stella_interactions OWNER TO uellix_owner'),
  )

  /**
   * The package with every comment line removed.
   *
   * A test that asks "does this package NEVER issue statement X" cannot read
   * the raw text: this package explains at length WHY it does not revoke
   * CREATE from PUBLIC, and quoting the statement in that explanation made the
   * assertion fire on its own rationale. Stripping comments makes the question
   * answerable exactly as asked — what the package EXECUTES — instead of
   * loosening it to something weaker that a real regression could slip past.
   */
  const STATEMENTS = BOOTSTRAP.split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')

  /**
   * The grant as a STATEMENT — a whole line of its own — not as text.
   *
   * Found by mutation: deleting the statement outright left both of the tests
   * below green, because §2b-bis's refusal message quotes the remedy verbatim
   * ("Run, as the owner of schema public: GRANT CREATE ON SCHEMA public TO
   * uellix_owner;"). `toContain` cannot tell a statement from a string inside a
   * RAISE, and the one mutation that reproduces the actual production defect
   * was the one that slipped through.
   */
  const GRANT_STATEMENT = /^GRANT CREATE ON SCHEMA public TO uellix_owner;\s*$/m

  it('grants CREATE on schema public to uellix_owner', () => {
    expect(BOOTSTRAP).toMatch(GRANT_STATEMENT)
  })

  it('grants it BEFORE the ownership transfer that needs it', () => {
    // Order is the whole property. The same statement after the transfer is a
    // grant nobody used and an apply that still fails.
    expect(BOOTSTRAP).toContain('ALTER TABLE public.stella_interactions OWNER TO uellix_owner')
    expect(upToTransfer).toMatch(GRANT_STATEMENT)
  })

  it('VERIFIES the grant took, because a GRANT the issuer cannot make is only a WARNING', () => {
    // Measured: as a role holding CREATE on public but not owning it,
    // `GRANT CREATE ON SCHEMA public TO x` emits
    // `WARNING: no privileges were granted` and returns success. Without this
    // assertion the apply would proceed and fail three statements later with
    // the same opaque `permission denied for schema public`.
    expect(upToTransfer).toContain("has_schema_privilege('uellix_owner', 'public', 'CREATE')")
    expect(BOOTSTRAP).toMatch(/GRANT is only a WARNING|no privileges were granted/)
  })

  it('grants USAGE to all five roles, so the runtime can reach the schema at all', () => {
    expect(upToTransfer).toMatch(
      /GRANT USAGE\s+ON SCHEMA public TO uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;/,
    )
  })

  it('withholds CREATE from every role that is not the owner', () => {
    expect(upToTransfer).toContain(
      'REVOKE CREATE ON SCHEMA public FROM uellix_migrator, uellix_app, uellix_writer, uellix_auditor;',
    )
  })

  it('does NOT revoke CREATE on public FROM PUBLIC — that is baseline surface', () => {
    // stella_0004 line 425 does this locally. Here it would change an ACL this
    // package did not create and does not own the decision for, and §5c
    // promises the baseline keeps exactly the surface it had.
    expect(STATEMENTS).not.toMatch(/REVOKE\s+CREATE\s+ON\s+SCHEMA\s+public\s+FROM\s+PUBLIC/i)
    // ...and the reason is written down, so the omission reads as a decision.
    expect(BOOTSTRAP).toContain('baseline surface §5c promises')
  })

  it('states WHY the privilege is persistent, naming every package that needs it', () => {
    // A privilege with no recorded reason is the one a later reviewer removes.
    // Anchored to the slice BEFORE the transfer: the first version of this test
    // asserted the names appeared anywhere in the file and passed against the
    // unfixed package, because `grounding_0002` is already cited at line 655
    // about an unrelated defect. A test that passes before the fix proves
    // nothing.
    for (const pkg of [
      'grounding_0002',
      'grounding_0003',
      'stella_0007',
      'stella_0008',
      'stella_0010',
    ]) {
      expect(upToTransfer, `${pkg} creates a table in public as uellix_owner`).toContain(pkg)
    }
  })

  it('asserts the end state in section 6, in the transaction that built it', () => {
    // Anchored to the wording only check (7) uses. The first version matched
    // `/FAILED verification:[^']*CREATE on schema public/`, which check (8)'s
    // message ("role(s) % hold CREATE on schema public") also satisfies — so
    // deleting check (7) entirely left this green. Mutation found it.
    expect(BOOTSTRAP).toContain(
      'FAILED verification: uellix_owner lacks CREATE on schema public',
    )
  })

  it('leaves the owner as the only new role holding CREATE, asserted not assumed', () => {
    expect(BOOTSTRAP).toMatch(/FAILED verification: role\(s\) % hold CREATE on schema public/)
  })
})

describe('S1-DEFECT-001 — the rollback still drops the roles it created', () => {
  it('revokes the schema privileges before DROP ROLE', () => {
    // Measured on PostgreSQL 17.6: DROP ROLE fails with
    // `role "x" cannot be dropped because some objects depend on it /
    //  DETAIL: privileges for schema public` while any such grant survives.
    // Adding the grant without this makes the rollback inapplicable, which
    // would only be discovered while trying to undo a half-built staging.
    const dropIndex = ROLLBACK.indexOf('DROP ROLE IF EXISTS uellix_app;')
    expect(dropIndex).toBeGreaterThan(-1)
    expect(ROLLBACK.slice(0, dropIndex)).toContain('REVOKE ALL ON SCHEMA public FROM')
  })

  it('names every role the package granted on, so none blocks its own DROP', () => {
    const dropIndex = ROLLBACK.indexOf('DROP ROLE IF EXISTS uellix_app;')
    const before = ROLLBACK.slice(0, dropIndex)
    for (const role of ['uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor']) {
      expect(before, `${role} must be revoked before it is dropped`).toMatch(
        new RegExp(`REVOKE ALL ON SCHEMA public FROM[^;]*${role}`),
      )
    }
  })

  it('records why the REVOKE is load-bearing rather than tidiness', () => {
    expect(ROLLBACK).toMatch(/cannot be dropped|privileges for schema public/)
  })
})

describe('Phase 12 — R6h may not be validated prematurely', () => {
  it('no artefact emits VALIDATE CONSTRAINT', () => {
    for (const artefact of ARTEFACTS) {
      expect(artefact.sql).not.toMatch(/VALIDATE\s+CONSTRAINT/i)
    }
  })

  it('the generated stella_0017 still adds the CHECK as NOT VALID', () => {
    const a = ARTEFACTS.find((x) => x.packageName === 'stella_0017_governed_stella_consumption')!
    expect(a.sql).toContain('CHECK (idempotency_key IS NOT NULL) NOT VALID')
  })

  it('the generated stella_0017 still ABORTS if it finds the constraint validated', () => {
    const a = ARTEFACTS.find((x) => x.packageName === 'stella_0017_governed_stella_consumption')!
    expect(a.sql).toContain('is VALIDATED. Every row filed before this package carries no key')
  })
})

describe('Phase 12 — feature flags', () => {
  it('no artefact turns a Stella flag on — flags are environment, not SQL', () => {
    for (const artefact of ARTEFACTS) {
      expect(artefact.sql).not.toMatch(/STELLA_[A-Z_]*ENABLED\s*=\s*true/i)
    }
  })
})

describe('redactForHostedLog is applied where it matters', () => {
  it('scrubs a driver-shaped error that embeds the host and userinfo', () => {
    const scrubbed = redactForHostedLog(
      'write ECONNRESET postgresql://uellix_app:p%40ss@db.abcdefghijklmnopqrst.supabase.co:5432',
    )
    expect(scrubbed).not.toContain('p%40ss')
    expect(scrubbed).toContain('[redacted]')
  })
})

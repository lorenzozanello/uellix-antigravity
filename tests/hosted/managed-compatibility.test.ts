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

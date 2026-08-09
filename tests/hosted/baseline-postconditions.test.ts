// tests/hosted/baseline-postconditions.test.ts
// TRAIN 5C0 — Phase 10. The postconditions, and the reason to believe them.
//
// The load-bearing test in this file is the negative-control sweep. A
// postcondition that ignores its input passes any observation it is given,
// including its own mutation — so running every check against its own broken
// state is what separates a check from a paragraph. If somebody later "fixes" a
// flaky postcondition by making it return `{ passed: true }`, this file fails.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import { BASELINE_ORDER } from '@/db/hosted/baseline-manifest'
import { KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'
import {
  BASELINE_POSTCONDITIONS,
  deriveExpectedBaselineState,
  evaluateBaselinePostconditions,
  type BaselineObservation,
} from '@/db/hosted/baseline-postconditions'

const ROOT = process.cwd()
const readSql = (file: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8')
  } catch {
    return null
  }
}

const EXPECTED = deriveExpectedBaselineState(readSql)

/**
 * A database that received the baseline exactly as the manifest describes.
 *
 * The schema-shaped fields come from the derivation on purpose — the question
 * those checks answer is "did the database receive what the corpus says", and
 * the conforming case is by definition the one where it did. The fields the
 * derivation CANNOT produce (roles, grants, row counts, extensions, columns,
 * constraints) are written out here, which is also where the interesting
 * postconditions live.
 */
function conforming(): BaselineObservation {
  return {
    schemas: ['public', 'auth', 'storage', 'extensions', 'graphql', 'realtime'],
    tables: [...EXPECTED.tables],
    columns: {
      'public.users': ['id', 'email', 'full_name', 'avatar_url', 'is_super_admin', 'created_at', 'updated_at'],
      'public.stella_interactions': ['id', 'organization_id', 'stella_role', 'created_at'],
      'public.project_investments': ['id', 'funder_id', 'amount', 'amount_usd', 'currency', 'contribution_type'],
      'public.financial_proxies': ['id', 'value', 'value_usd', 'currency', 'review_status'],
      'public.marketing_leads': ['id', 'email', 'company_name', 'source', 'created_at'],
    },
    constraints: [
      'approved_proxy_check',
      'project_investments_contribution_type_check',
      'project_investments_in_kind_notes_check',
      'organizations_slug_unique',
      'users_email_unique',
    ],
    functions: [...EXPECTED.functions],
    triggers: [...EXPECTED.triggers],
    rlsEnabledTables: [...EXPECTED.rlsEnabledTables],
    policies: [...EXPECTED.policies],
    roles: ['postgres', 'anon', 'authenticated', 'service_role', 'supabase_auth_admin'],
    grants: ['authenticated:SELECT:public.users', 'service_role:INSERT:public.audit_logs'],
    rowCounts: Object.fromEntries(EXPECTED.tables.map((t) => [t, 0])),
    extensions: ['pgcrypto', 'uuid-ossp', 'pg_graphql', 'pg_stat_statements'],
    storageBuckets: ['uellix-evidence'],

    storagePolicies: [

      { schemaname: 'storage', tablename: 'objects', policyname: 'select_evidence', roles: '{authenticated}', cmd: 'SELECT', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_read_evidence_object(name, auth.uid()))", withCheck: null },

      { schemaname: 'storage', tablename: 'objects', policyname: 'insert_evidence', roles: '{authenticated}', cmd: 'INSERT', qual: null, withCheck: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))" },

      { schemaname: 'storage', tablename: 'objects', policyname: 'delete_evidence', roles: '{authenticated}', cmd: 'DELETE', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))", withCheck: null },

    ],
    environmentSecretNames: ['UELLIX_RUNTIME_DATABASE_URL', 'NEXT_PUBLIC_SITE_URL'],

    // B0-17. Effective ACL, so a NULL proacl — a REVOKE that never ran — reads
    // as the implicit PUBLIC EXECUTE it really is rather than as "no grants".
    functionGrants: [
      'authenticated:EXECUTE:public.current_user_is_super_admin',
      'authenticated:EXECUTE:public.current_user_org_ids',
      'authenticated:EXECUTE:public.current_user_role_in_org',
      'authenticated:EXECUTE:public.can_read_evidence_object',
      'authenticated:EXECUTE:public.can_write_evidence_object',
      'postgres:EXECUTE:public.current_user_is_super_admin',
    ],

    // B0-18. One row per unit, in application order.
    journal: {
      packages: [...BASELINE_ORDER],
      environments: ['staging'],
      projectRefs: [KNOWN_STAGING_PROJECT_REF],
      statuses: ['APPLIED'],
    },
  }
}

describe('the derivation reads the corpus, not the manifest counts', () => {
  it('finds the tables, functions, triggers, RLS tables and policies the units create', () => {
    expect(EXPECTED.tables.length).toBeGreaterThan(25)
    expect(EXPECTED.tables).toContain('public.marketing_leads')
    expect(EXPECTED.tables).toContain('public.stella_interactions')

    // The two storage helpers are the reason the Supabase units are in the
    // corpus at all; if they vanish, the 0039 ordering defect is back.
    expect(EXPECTED.functions).toContain('public.can_read_evidence_object')
    expect(EXPECTED.functions).toContain('public.can_write_evidence_object')
    expect(EXPECTED.functions).toContain('public.current_user_is_super_admin')

    expect(EXPECTED.triggers).toContain('trg_audit_logs_append_only')
    expect(EXPECTED.triggers).toContain('on_auth_user_created')

    // marketing_leads gets RLS from policy 008 and from nowhere else.
    expect(EXPECTED.rlsEnabledTables).toContain('public.marketing_leads')
  })

  it('agrees with an INDEPENDENTLY authored enumeration, so a scanner blind spot cannot shrink the bar', () => {
    // Adversarial review B: `deriveExpectedBaselineState` calls the same lexical
    // scanner the postconditions are meant to be independent of. Its
    // independence from the OBSERVATION is real; its independence from the
    // SCANNER'S BLIND SPOTS is not. If a unit created a table the scanner failed
    // to see, the expectation would never include it, and B0-02 would report
    // "all N tables present" — true, vacuously, because N excluded the one that
    // mattered.
    //
    // This is the second opinion: a deliberately dumb line-oriented count that
    // shares no code with splitSqlStatements. If the two ever disagree, one of
    // them is wrong and neither should be trusted until it is known which.
    const naiveTables = new Set<string>()
    for (const unit of BASELINE_UNITS) {
      const sql = readSql(unit.file)
      if (sql === null) continue
      for (const line of sql.replace(/\r\n?/g, '\n').split('\n')) {
        const m = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w.]+)"?/i.exec(line)
        if (m && !line.trimStart().startsWith('--')) {
          naiveTables.add(m[1].includes('.') ? m[1] : `public.${m[1]}`)
        }
      }
    }

    expect([...naiveTables].sort()).toEqual([...EXPECTED.tables].sort())
    expect(naiveTables.size).toBeGreaterThan(25)
  })

  it('excludes policies the corpus retires rather than demanding them', () => {
    // 0031 issues 71 DROP POLICY IF EXISTS against 69 CREATE POLICY. An
    // expectation that ignored the drops would demand two policies the baseline
    // deliberately removes, and every real database would fail B0-08.
    expect(EXPECTED.policies.length).toBeGreaterThan(90)
    expect(EXPECTED.policies).toContain('public.marketing_leads.anon_insert_marketing_leads')
  })
})

describe('every postcondition passes against a conforming database', () => {
  it('all of them, with no exceptions carved out', () => {
    const failures = evaluateBaselinePostconditions(conforming(), EXPECTED).filter((r) => !r.passed)
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([])
  })
})

describe('NEGATIVE CONTROLS — every postcondition fails against its own mutation', () => {
  it.each(BASELINE_POSTCONDITIONS.map((p) => [p.id, p] as const))(
    '%s fails when: %s',
    (_id, postcondition) => {
      const broken = postcondition.negativeControl.mutate(conforming())
      const result = postcondition.check(broken, EXPECTED)
      expect(
        result.passed,
        `${postcondition.id} PASSED its own negative control (${postcondition.negativeControl.description}). ` +
          `A check that cannot fail is documentation, not verification.`,
      ).toBe(false)
      expect(result.detail.length).toBeGreaterThan(10)
    },
  )

  it('covers all eighteen, so none can be added without a negative control', () => {
    // UPDATED 2026-08-08: B0-17 (the 042 function EXECUTE grants) and B0-18 (the
    // 50/50 journal) were added when CHECKPOINT B0 was wired to hosted. The
    // count is pinned so a check can never arrive without its own mutation.
    expect(BASELINE_POSTCONDITIONS).toHaveLength(18)
    expect(BASELINE_POSTCONDITIONS.map((p) => p.id)).toEqual(
      expect.arrayContaining(['B0-17-function-execute-grants', 'B0-18-journal-complete']),
    )
    for (const p of BASELINE_POSTCONDITIONS) {
      expect(p.negativeControl.description.length, p.id).toBeGreaterThan(10)
      expect(typeof p.negativeControl.mutate, p.id).toBe('function')
    }
  })

  it('every probe is read-only — no postcondition can change what it measures', () => {
    const WRITES = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i
    for (const p of BASELINE_POSTCONDITIONS) {
      // A probe is either a SELECT or a comment-only operator instruction.
      // B0-14 is the second kind on purpose: SUPABASE_SERVICE_ROLE_KEY lives in
      // a secret manager, not in PostgreSQL, so no query could answer it and
      // pretending otherwise would be the decorative-check failure in a new
      // costume.
      expect(p.probeSql, p.id).toMatch(/^\s*(SELECT\b|--)/i)
      expect(WRITES.test(p.probeSql), `${p.id}: ${p.probeSql}`).toBe(false)
    }
  })

  it('names the probes that are operator attestations rather than queries', () => {
    const attestations = BASELINE_POSTCONDITIONS.filter((p) => !/^\s*SELECT\b/i.test(p.probeSql))
    expect(attestations.map((p) => p.id)).toEqual(['B0-14-no-service-role-key'])
  })
})

describe('the postconditions that carry the Phase 5 and Phase 6 claims', () => {
  it('B0-11 refuses a database with any row at all', () => {
    const o = conforming()
    const check = BASELINE_POSTCONDITIONS.find((p) => p.id === 'B0-11-zero-production-data')!
    expect(check.check(o, EXPECTED).passed).toBe(true)
    expect(check.check({ ...o, rowCounts: { ...o.rowCounts, 'public.users': 1 } }, EXPECTED).passed).toBe(false)
    // "Not measured" must not read as "empty".
    expect(check.check({ ...o, rowCounts: {} }, EXPECTED).passed).toBe(false)
  })

  it('B0-10 is the check that keeps policy 008 inert', () => {
    const o = conforming()
    const check = BASELINE_POSTCONDITIONS.find((p) => p.id === 'B0-10-no-anon-write-surface')!
    expect(check.check(o, EXPECTED).passed).toBe(true)
    const withGrant = { ...o, grants: [...o.grants, 'anon:INSERT:public.marketing_leads'] }
    const result = check.check(withGrant, EXPECTED)
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('marketing_leads')
  })

  it('B0-12 requires the baseline ledger and forbids the capability schemas', () => {
    const o = conforming()
    const check = BASELINE_POSTCONDITIONS.find((p) => p.id === 'B0-12-no-stella-surface')!
    expect(check.check(o, EXPECTED).passed).toBe(true)
    // stella_interactions is BASELINE (0012). Its absence is a failure, not a pass.
    expect(
      check.check({ ...o, tables: o.tables.filter((t) => t !== 'public.stella_interactions') }, EXPECTED).passed,
    ).toBe(false)
    expect(check.check({ ...o, schemas: [...o.schemas, 'uellix_grounding'] }, EXPECTED).passed).toBe(false)
  })

  it('B0-05 is the check that would have caught the 0039 ordering defect', () => {
    const o = conforming()
    const check = BASELINE_POSTCONDITIONS.find((p) => p.id === 'B0-05-functions')!
    const withoutStorageHelpers = {
      ...o,
      functions: o.functions.filter((f) => !f.includes('evidence_object')),
    }
    const result = check.check(withoutStorageHelpers, EXPECTED)
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('can_read_evidence_object')
  })
})

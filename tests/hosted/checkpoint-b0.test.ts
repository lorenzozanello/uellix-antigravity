// tests/hosted/checkpoint-b0.test.ts
//
// The adversarial suite for the CHECKPOINT B0 wire.
//
// The wire's job is to make the eighteen canonical postconditions reachable from
// a hosted observation WITHOUT becoming a second B0. So the tests here are about
// two things and nothing else: does an untrustworthy observation get refused,
// and does a trustworthy one reach the CANONICAL evaluator unchanged.
//
// Every refusal is paired with the same input corrected, so a wire that refused
// everything would fail too.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BASELINE_ORDER } from '@/db/hosted/baseline-manifest'
import {
  BASELINE_POSTCONDITIONS,
  UNIT_042_GRANTED_FUNCTIONS,
  deriveExpectedBaselineState,
} from '@/db/hosted/baseline-postconditions'
import {
  B0_OBSERVATION_SQL,
  buildB0ObservationSql,
  evaluateB0,
  parseB0Observation,
} from '@/db/hosted/checkpoint-b0'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const readSql = (file: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8')
  } catch {
    return null
  }
}
const EXPECTED = deriveExpectedBaselineState(readSql)
const PROD = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]!

/** An observation of a database that received the baseline exactly as described. */
const conforming = () => ({
  projectRef: KNOWN_STAGING_PROJECT_REF,
  measuredOn: '2026-08-08',
  schemas: ['public', 'auth', 'storage', 'extensions'],
  tables: [...EXPECTED.tables],
  columns: {
    'public.users': ['id', 'email', 'full_name', 'avatar_url', 'is_super_admin', 'created_at'],
    'public.stella_interactions': ['id', 'organization_id'],
    'public.project_investments': ['id', 'funder_id', 'amount_usd'],
    'public.financial_proxies': ['id', 'value_usd'],
    'public.marketing_leads': ['id', 'email'],
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
  roles: ['postgres', 'anon', 'authenticated', 'service_role'],
  grants: [],
  rowCounts: Object.fromEntries(EXPECTED.tables.map((t) => [t, 0])),
  extensions: ['pgcrypto'],
  storageBuckets: ['uellix-evidence'],
  storagePolicies: [
    { schemaname: 'storage', tablename: 'objects', policyname: 'select_evidence', roles: '{authenticated}', cmd: 'SELECT', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_read_evidence_object(name, auth.uid()))", withCheck: null },
    { schemaname: 'storage', tablename: 'objects', policyname: 'insert_evidence', roles: '{authenticated}', cmd: 'INSERT', qual: null, withCheck: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))" },
    { schemaname: 'storage', tablename: 'objects', policyname: 'delete_evidence', roles: '{authenticated}', cmd: 'DELETE', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))", withCheck: null },
  ],
  environmentSecretNames: ['UELLIX_RUNTIME_DATABASE_URL'],
  functionGrants: UNIT_042_GRANTED_FUNCTIONS.map((fn) => `authenticated:EXECUTE:${fn}`),
  journal: {
    packages: [...BASELINE_ORDER],
    environments: ['staging'],
    projectRefs: [KNOWN_STAGING_PROJECT_REF],
    statuses: ['APPLIED'],
  },
})

const json = (o: unknown) => JSON.stringify(o)
const evalOf = (o: unknown) => evaluateB0(json(o), EXPECTED)
const codeOf = (raw: string | null) => {
  const v = parseB0Observation(raw)
  return v.ok ? 'OK' : v.code
}

// ---------------------------------------------------------------------------
// The positive control. Without it every refusal below proves nothing.
// ---------------------------------------------------------------------------

describe('a conforming hosted observation reaches the canonical evaluator', () => {
  it('passes all eighteen', () => {
    const v = evalOf(conforming())
    expect(v.failing.map((f) => `${f.id}: ${f.detail}`)).toEqual([])
    expect(v.checkpointPassed).toBe(true)
    expect(v.checkCount).toBe(BASELINE_POSTCONDITIONS.length)
    expect(v.projectRef).toBe(KNOWN_STAGING_PROJECT_REF)
  })

  it('runs the CANONICAL postconditions, not a second set', () => {
    // The wire must not grow its own checks. If these ever diverge, one of the
    // two is the parallel B0 the instruction forbids.
    expect(evalOf(conforming()).checkCount).toBe(BASELINE_POSTCONDITIONS.length)
  })
})

// ---------------------------------------------------------------------------
// FASE 9 — the refusals
// ---------------------------------------------------------------------------

describe('the observation is refused unless it is trustworthy', () => {
  it('refuses an absent artefact', () => {
    expect(codeOf(null)).toBe('B0_OBSERVATION_ABSENT')
    expect(evaluateB0(null, EXPECTED).checkpointPassed).toBe(false)
  })

  it('refuses malformed JSON, and an array or scalar masquerading as one', () => {
    expect(codeOf('{not json')).toBe('B0_OBSERVATION_MALFORMED')
    expect(codeOf('[]')).toBe('B0_OBSERVATION_MALFORMED')
    expect(codeOf('"a string"')).toBe('B0_OBSERVATION_MALFORMED')
  })

  it('refuses an observation with no projectRef', () => {
    const rest = conforming() as Record<string, unknown>
    delete rest.projectRef
    expect(codeOf(json(rest))).toBe('B0_OBSERVATION_PROJECT_REF_MISSING')
  })

  it('refuses an observation of ANOTHER project', () => {
    expect(codeOf(json({ ...conforming(), projectRef: 'aaaaaaaaaaaaaaaaaaaa' }))).toBe(
      'B0_OBSERVATION_PROJECT_REF_MISMATCH',
    )
  })

  it('refuses a PRODUCTION observation by the check that names production', () => {
    // Not by the mismatch check that would also reject it today. If the target
    // ever became the production ref, the veto must still be the thing refusing.
    expect(codeOf(json({ ...conforming(), projectRef: PROD }))).toBe('B0_OBSERVATION_PRODUCTION_REF')
    const asTarget = parseB0Observation(json({ ...conforming(), projectRef: PROD }), PROD)
    expect(asTarget.ok).toBe(false)
    if (!asTarget.ok) expect(asTarget.code).toBe('B0_OBSERVATION_PRODUCTION_REF')
  })

  it('refuses an INCOMPLETE observation rather than defaulting the gap', () => {
    for (const field of ['tables', 'policies', 'functionGrants', 'journal', 'storagePolicies']) {
      const o = conforming() as Record<string, unknown>
      delete o[field]
      expect(codeOf(json(o)), field).toBe('B0_OBSERVATION_INCOMPLETE')
    }
  })

  it('refuses anything shaped like a credential in environmentSecretNames', () => {
    for (const leak of [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'postgresql://postgres:not-a-real-password@db.x.supabase.co:5432/postgres',
      'sbp_notARealPersonalAccessToken00',
    ]) {
      expect(codeOf(json({ ...conforming(), environmentSecretNames: [leak] })), leak.slice(0, 12)).toBe(
        'B0_OBSERVATION_CARRIES_SECRET',
      )
    }
  })

  it('accepts NAMES, which is what B0-14 asks for', () => {
    expect(codeOf(json({ ...conforming(), environmentSecretNames: ['UELLIX_RUNTIME_DATABASE_URL'] }))).toBe('OK')
  })
})

// ---------------------------------------------------------------------------
// FASE 9 — the checks themselves still bite through the wire
// ---------------------------------------------------------------------------

describe('the canonical checks still fail through the wire', () => {
  const failing = (o: unknown) => evalOf(o).failing.map((f) => f.id)

  it('B0-14 fails when the secret inventory is absent, and is not assumed to pass', () => {
    expect(failing({ ...conforming(), environmentSecretNames: null })).toContain('B0-14-no-service-role-key')
  })

  it('B0-17 fails on an unexpected PUBLIC EXECUTE', () => {
    const o = conforming()
    expect(
      failing({ ...o, functionGrants: [...o.functionGrants, 'PUBLIC:EXECUTE:public.current_user_is_super_admin'] }),
    ).toContain('B0-17-function-execute-grants')
  })

  it('B0-17 fails on an unexpected anon EXECUTE', () => {
    const o = conforming()
    expect(
      failing({ ...o, functionGrants: [...o.functionGrants, 'anon:EXECUTE:public.current_user_org_ids'] }),
    ).toContain('B0-17-function-execute-grants')
  })

  it('B0-17 fails when authenticated lost one of the five 042 grants', () => {
    const o = conforming()
    expect(failing({ ...o, functionGrants: o.functionGrants.slice(1) })).toContain(
      'B0-17-function-execute-grants',
    )
  })

  it('B0-18 fails on a 49-row journal', () => {
    const o = conforming()
    expect(failing({ ...o, journal: { ...o.journal, packages: o.journal.packages.slice(0, 49) } })).toContain(
      'B0-18-journal-complete',
    )
  })

  it('B0-18 fails on fifty rows with a gap and a duplicate', () => {
    const o = conforming()
    const withGap = [...o.journal.packages.slice(0, 49), o.journal.packages[0]!]
    expect(failing({ ...o, journal: { ...o.journal, packages: withGap } })).toContain('B0-18-journal-complete')
  })

  it('B0-18 fails when a row names production', () => {
    const o = conforming()
    expect(
      failing({ ...o, journal: { ...o.journal, projectRefs: [KNOWN_STAGING_PROJECT_REF, PROD] } }),
    ).toContain('B0-18-journal-complete')
  })

  it('B0-18 fails on a non-APPLIED status or a non-staging environment', () => {
    const o = conforming()
    expect(failing({ ...o, journal: { ...o.journal, statuses: ['APPLIED', 'FAILED'] } })).toContain('B0-18-journal-complete')
    expect(failing({ ...o, journal: { ...o.journal, environments: ['production'] } })).toContain('B0-18-journal-complete')
  })

  it('B0-18 fails when the journal was not measured at all', () => {
    expect(failing({ ...conforming(), journal: null })).toContain('B0-18-journal-complete')
  })

  it('B0-15 fails when the evidence bucket is absent', () => {
    expect(failing({ ...conforming(), storageBuckets: [] })).toContain('B0-15-evidence-bucket-exists')
  })

  it('B0-10 fails when anon holds a table privilege — the marketing-leads containment', () => {
    // The policy `anon_insert_marketing_leads` is INTENTIONAL and stays. What
    // keeps it inert is the grant layer, and THAT is what B0-10 measures.
    expect(failing({ ...conforming(), grants: ['anon:INSERT:public.marketing_leads'] })).toContain(
      'B0-10-no-anon-write-surface',
    )
  })

  it('B0-16 fails on a widened storage predicate that still contains the canonical text', () => {
    const o = conforming()
    const widened = o.storagePolicies.map((p) =>
      p.policyname === 'select_evidence' ? { ...p, qual: `((${p.qual}) OR true)` } : p,
    )
    expect(failing({ ...o, storagePolicies: widened })).toContain('B0-16-storage-policy-surface')
  })
})

// ---------------------------------------------------------------------------
// FASE 2 — the probe is generated from the corpus and is read-only
// ---------------------------------------------------------------------------

describe('the observation probe', () => {
  const sql = readSql(B0_OBSERVATION_SQL)

  it('is committed to the repository, not produced ad hoc', () => {
    expect(sql, `${B0_OBSERVATION_SQL} is missing — run pnpm b0:observation:generate`).not.toBeNull()
  })

  it('regenerates byte-identically from the corpus', () => {
    expect(sql?.replace(/\r\n?/g, '\n')).toBe(buildB0ObservationSql(EXPECTED.tables))
  })

  it('never writes', () => {
    expect(sql).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|CREATE\s|DROP\s|ALTER\s|GRANT\s|REVOKE\s)/i)
  })

  it('runs read-only and rolls back', () => {
    expect(sql).toContain('BEGIN READ ONLY;')
    expect(sql?.trimEnd().endsWith('ROLLBACK;')).toBe(true)
  })

  it('pins the deparse representation, as the storage probe learned to', () => {
    expect(sql).toContain("SET LOCAL search_path = ''")
  })

  it('refuses to run without a project ref rather than emitting an unattributed observation', () => {
    expect(sql).toContain('\\if :{?uellix_project_ref}')
    expect(sql).toContain('REFUSED')
  })

  it('asks one row-count arm per table the corpus creates', () => {
    for (const t of EXPECTED.tables) expect(sql, t).toContain(`'${t}' AS t`)
  })

  it('uses the effective ACL for function grants, so a NULL proacl cannot read as no privilege', () => {
    expect(sql).toContain("acldefault('f', p.proowner)")
  })

  it('emits environmentSecretNames as null, because PostgreSQL cannot answer B0-14', () => {
    expect(sql).toContain("'environmentSecretNames', NULL")
  })
})

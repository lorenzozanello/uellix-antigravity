// tests/hosted/baseline-manifest.test.ts
// TRAIN 5C0 — Phase 3/4/8. The baseline manifest against the actual files, and
// the three claims about the corpus that the provisioning contract now rests on.
//
// The equivalence tests below are the point of this file. `db/policies/001` and
// `db/migrations/0031` being the same 765 lines is not a curiosity: the contract
// tells an operator to apply both, and whether that is harmless or catastrophic
// depends entirely on facts nobody had checked. These assert them.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  BASELINE_DELIBERATE_EXCLUSIONS,
  BASELINE_GLOBAL_INVARIANTS,
  BASELINE_NON_REAPPLYABLE,
  BASELINE_ORDER,
  BASELINE_UNITS,
  baselineUnit,
  verifyBaselineManifest,
} from '@/db/hosted/baseline-manifest'
import {
  scanBaselineSql,
  sha256OfBaselineSql,
  splitSqlStatements,
  stripSqlComments,
} from '@/db/hosted/baseline-scanner'

const ROOT = process.cwd()

const read = (file: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8')
  } catch {
    return null
  }
}

const readOrThrow = (file: string): string => {
  const sql = read(file)
  if (sql === null) throw new Error(`fixture missing: ${file}`)
  return sql
}

function discovered(): string[] {
  const dirs: [string, (n: string) => boolean][] = [
    ['db/migrations', (n) => /^\d{4}_.*\.sql$/.test(n)],
    ['supabase/migrations', (n) => n.endsWith('.sql')],
    ['db/policies', (n) => n.endsWith('.sql')],
  ]
  const out: string[] = []
  for (const [dir, accept] of dirs) {
    for (const name of readdirSync(path.join(ROOT, dir)).sort()) {
      if (accept(name)) out.push(`${dir}/${name}`)
    }
  }
  return out
}

/** Normalized statement set — comments stripped, whitespace collapsed. */
function statementSet(sql: string): string[] {
  return splitSqlStatements(stripSqlComments(sql.replace(/\r\n?/g, '\n')))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

describe('the baseline manifest describes the corpus that is actually checked in', () => {
  it('verifies clean: order, hashes, derived scan and orphan detection', () => {
    const problems = verifyBaselineManifest(read, scanBaselineSql, discovered())
    expect(problems, JSON.stringify(problems.slice(0, 5), null, 2)).toEqual([])
  })

  it('covers every SQL file in the three baseline directories, with none left over', () => {
    expect([...BASELINE_UNITS].map((u) => u.file).sort()).toEqual(discovered().sort())
  })

  // W2-B2 (FIBIU-08/09/10) — re-derived, not fitted: FIB Wave 2 B1 closure
  // left 53 Drizzle units; FIBIU-08 added 0053 (53+1=54), FIBIU-09 added
  // 0054's rubric CHECK constraints (54+1=55), FIBIU-10 added 0055's
  // material-fields registry (55+1=56). Supabase and policy counts unchanged.
  it('has 67 units: 56 Drizzle, 2 Supabase, 9 policies', () => {
    expect(BASELINE_UNITS).toHaveLength(67)
    const byKind = (k: string) => BASELINE_UNITS.filter((u) => u.kind === k).length
    expect(byKind('drizzle-migration')).toBe(56)
    expect(byKind('supabase-migration')).toBe(2)
    expect(byKind('policy')).toBe(9)
  })

  it('numbers ordinals 1..67 contiguously, and BASELINE_ORDER is derived from them', () => {
    expect(BASELINE_UNITS.map((u) => u.ordinal)).toEqual(
      Array.from({ length: 67 }, (_, i) => i + 1),
    )
    expect(BASELINE_ORDER).toEqual(BASELINE_UNITS.map((u) => u.id))
    expect(new Set(BASELINE_ORDER).size).toBe(67)
  })

  it('throws on an unknown unit rather than returning undefined', () => {
    expect(() => baselineUnit('0040_does_not_exist.sql')).toThrow(/BASELINE_MANIFEST_UNKNOWN_UNIT/)
  })
})

describe('the SQL the baseline deliberately leaves out', () => {
  it('every exclusion names a real file, and every superseding unit is in the manifest', () => {
    for (const exclusion of BASELINE_DELIBERATE_EXCLUSIONS) {
      expect(read(exclusion.path), `${exclusion.path} does not exist`).not.toBeNull()
      expect(exclusion.reason.length).toBeGreaterThan(40)
      for (const id of exclusion.supersededBy) {
        expect(() => baselineUnit(id), `${exclusion.path} -> ${id}`).not.toThrow()
      }
    }
  })

  it('accounts for every db/manual-migrations SQL file, so none is silently skipped', () => {
    const manual = readdirSync(path.join(ROOT, 'db/manual-migrations'))
      .filter((n) => n.endsWith('.sql'))
      .map((n) => `db/manual-migrations/${n}`)
      .sort()
    const accounted = BASELINE_DELIBERATE_EXCLUSIONS.map((e) => e.path)
      .filter((p) => p.startsWith('db/manual-migrations/'))
      .sort()
    expect(accounted).toEqual(manual)
  })

  it('proves the supersession rather than asserting it', () => {
    // 001 -> 0029: the same two unique indexes.
    const i0029 = readOrThrow('db/migrations/0029_integrity.sql')
    expect(i0029).toContain('uq_active_outcome_proxy_assignment')
    expect(i0029).toContain('uq_sroi_run_project_version')

    // 002 -> 0030: the append-only function and its three triggers.
    const i0030 = readOrThrow('db/migrations/0030_immutability.sql')
    expect(i0030).toContain('uellix_forbid_mutation')
    for (const t of ['audit_logs', 'sroi_calculation_runs', 'sroi_calculation_line_items']) {
      expect(i0030).toContain(t)
    }

    // 003 -> 0016: the same varchar -> numeric conversions.
    const i0016 = readOrThrow('db/migrations/0016_fat_mac_gargan.sql')
    for (const c of ['financial_proxies', 'project_investments', 'sroi_assignment_inputs']) {
      expect(i0016).toMatch(new RegExp(`ALTER TABLE "${c}" ALTER COLUMN [^\\n]*numeric`))
    }
  })

  it('does not treat db/baseline/ as the baseline, despite the name', () => {
    // The directory that A1 sounds like it means holds a pg_dump of a Supabase
    // database, complete with schemas a managed project owns for itself.
    const dump = readOrThrow('db/baseline/stella_g2_schema.sql')
    expect(dump).toContain('CREATE SCHEMA')
    expect(BASELINE_UNITS.some((u) => u.file.startsWith('db/baseline/'))).toBe(false)
    expect(BASELINE_DELIBERATE_EXCLUSIONS.some((e) => e.path.startsWith('db/baseline/'))).toBe(true)
  })
})

describe('the ordering defect Train 5C0 found: 0039 depends on a Supabase unit', () => {
  it('0039 grants EXECUTE on two functions no Drizzle migration defines', () => {
    const sql = readOrThrow('db/migrations/0039_grant_rls_helper_execution.sql')
    expect(sql).toContain('public.can_read_evidence_object(text, uuid)')
    expect(sql).toContain('public.can_write_evidence_object(text, uuid)')

    // Nothing in db/migrations creates them. If this ever becomes false, the
    // interleaving below stops being necessary and the manifest should say so.
    const definedInDrizzle = BASELINE_UNITS.filter((u) => u.kind === 'drizzle-migration').some((u) =>
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.can_(read|write)_evidence_object/i.test(
        readOrThrow(u.file),
      ),
    )
    expect(definedInDrizzle).toBe(false)
  })

  it('only supabase/migrations/20260716000001 defines them', () => {
    const facts = scanBaselineSql(readOrThrow('supabase/migrations/20260716000001_storage_policies.sql'))
    expect(facts.functionsCreated).toContain('public.can_read_evidence_object')
    expect(facts.functionsCreated).toContain('public.can_write_evidence_object')
  })

  it('the manifest therefore orders both Supabase units BEFORE 0039', () => {
    const at = (id: string) => baselineUnit(id).ordinal
    expect(at('20260716000000_auth_trigger.sql')).toBeLessThan(at('0039_grant_rls_helper_execution.sql'))
    expect(at('20260716000001_storage_policies.sql')).toBeLessThan(at('0039_grant_rls_helper_execution.sql'))
    // …and AFTER 0033, whose sweep would otherwise strip the grants they issue.
    expect(at('0033_public_api_grants.sql')).toBeLessThan(at('20260716000001_storage_policies.sql'))
    expect(baselineUnit('0039_grant_rls_helper_execution.sql').dependsOn).toContain(
      '20260716000001_storage_policies.sql',
    )
  })

  it('the auth trigger sits after 0002, which adds the column its INSERT names', () => {
    expect(readOrThrow('supabase/migrations/20260716000000_auth_trigger.sql')).toContain('is_super_admin')
    expect(readOrThrow('db/migrations/0002_huge_namorita.sql')).toContain('is_super_admin')
    expect(baselineUnit('20260716000000_auth_trigger.sql').ordinal).toBeGreaterThan(
      baselineUnit('0002_huge_namorita.sql').ordinal,
    )
  })
})

describe('A2 is almost entirely a re-application of A1', () => {
  it('policy 001 is BYTE-IDENTICAL to migration 0031', () => {
    const a = sha256OfBaselineSql(readOrThrow('db/migrations/0031_rls_core.sql'))
    const b = sha256OfBaselineSql(readOrThrow('db/policies/001_initial_auth_rls.sql'))
    expect(b).toBe(a)
    expect(baselineUnit('001_initial_auth_rls.sql').equivalentTo).toBe('0031_rls_core.sql')
  })

  it('migration 0032 contains no statement that policies 002..007 lack', () => {
    const m32 = statementSet(readOrThrow('db/migrations/0032_rls_specialized.sql'))
    const policies = new Set(
      BASELINE_UNITS.filter((u) => u.kind === 'policy' && u.equivalentTo === '0032_rls_specialized.sql')
        .flatMap((u) => statementSet(readOrThrow(u.file))),
    )
    expect(m32.filter((s) => !policies.has(s))).toEqual([])
  })

  it('008 and 009 are the only policies carrying content the migration chain never applies', () => {
    const chain = new Set(
      BASELINE_UNITS.filter((u) => u.kind !== 'policy').flatMap((u) => statementSet(readOrThrow(u.file))),
    )
    const novel = BASELINE_UNITS.filter((u) => u.kind === 'policy')
      .map((u) => [u.id, statementSet(readOrThrow(u.file)).filter((s) => !chain.has(s))] as const)
      .filter(([, s]) => s.length > 0)

    // 001…007 duplicate the Drizzle chain (equivalentTo); 008 and 009 are the
    // two independent A2-only policies — 008 pre-dates Wave 1, 009 is the one
    // Wave-1 policy claim (governed_model_registry, no Drizzle equivalent).
    expect(novel.map(([id]) => id)).toEqual([
      '008_marketing_leads_rls.sql',
      '009_governed_model_registry_rls.sql',
    ])
    expect(novel[0][1]).toHaveLength(4)
    expect(novel[1][1]).toHaveLength(3)
  })

  it('re-applying 001..007 is safe because every CREATE POLICY is guarded — and 008 is not', () => {
    for (const unit of BASELINE_UNITS.filter((u) => u.kind === 'policy')) {
      const facts = scanBaselineSql(readOrThrow(unit.file))
      if (unit.id === '008_marketing_leads_rls.sql') {
        expect(facts.unguardedPolicyCreates).toHaveLength(3)
        expect(unit.reapply).toBe('refuses-on-reapply')
      } else {
        expect(facts.unguardedPolicyCreates).toEqual([])
        expect(unit.reapply).toBe('idempotent')
      }
    }
  })

  it('names 008 as the only unit of the whole baseline that refuses a second application', () => {
    // The Drizzle chain is forward-only, so its units are destructive-on-reapply
    // rather than refusing; the distinction matters to the recovery table.
    expect(
      BASELINE_UNITS.filter((u) => u.reapply === 'refuses-on-reapply').map((u) => u.id),
    ).toEqual(['008_marketing_leads_rls.sql'])
    expect(BASELINE_NON_REAPPLYABLE).toContain('008_marketing_leads_rls.sql')
  })
})

describe('Phase 6 — managed-Supabase compatibility, measured not assumed', () => {
  it('no baseline unit depends on superuser, creates a role, transfers ownership or installs an extension', () => {
    for (const unit of BASELINE_UNITS) {
      const facts = scanBaselineSql(readOrThrow(unit.file))
      expect(facts.superuserDependencies, unit.id).toEqual([])
      expect(facts.roleStatements, unit.id).toEqual([])
      expect(facts.ownershipStatements, unit.id).toEqual([])
      expect(facts.extensionStatements, unit.id).toEqual([])
    }
    expect(BASELINE_GLOBAL_INVARIANTS).toEqual({
      superuserDependencies: 0,
      roleStatements: 0,
      ownershipStatements: 0,
      extensionStatements: 0,
    })
  })

  it('0033 is the ONLY unit that grants to service_role, and the manifest pins it', () => {
    const granters = BASELINE_UNITS.filter((u) => scanBaselineSql(readOrThrow(u.file)).grantsToServiceRole)
    expect(granters.map((u) => u.id)).toEqual(['0033_public_api_grants.sql'])
    expect(baselineUnit('0033_public_api_grants.sql').expect.grantsToServiceRole).toBe(true)
  })

  it('classifies every unit, and flags nothing as must-not-run', () => {
    const classes = new Set(BASELINE_UNITS.map((u) => u.managed))
    expect(classes.has('D-must-not-run-on-new-staging')).toBe(false)
    // Two units act on objects the PLATFORM owns, and neither privilege is
    // verifiable offline. Adversarial review A caught the second one being
    // classified B: CREATE POLICY on storage.objects requires OWNERSHIP of that
    // table, which is a stricter requirement than the TRIGGER privilege that
    // earned unit 40 its C.
    expect(BASELINE_UNITS.filter((u) => u.managed === 'C-requires-adaptation').map((u) => u.id)).toEqual([
      '20260716000000_auth_trigger.sql',
      '20260716000001_storage_policies.sql',
    ])
  })
})

describe('Phase 5 — data', () => {
  // W2-B1-R1 (R-B1-03) — 0048 genuinely added: db/migrations/0048_fib_
  // evidence_versions.sql's stage-B backfill (one v1 shell row per existing
  // evidence_items row) is real INSERT DML, verified below, not asserted on
  // the manifest's say-so. This is the explicit governance whitelist of
  // which migrations are PERMITTED to carry DML — extending it is a
  // statement about the corpus, never a number chased to pass.
  // W2-B2 (FIBIU-10) — 0055 genuinely added: db/migrations/0055_fib_proxy_
  // material_change_registry.sql's literal 39-row field->category seed,
  // mirroring 0040's own global-catalog-seed treatment exactly (same
  // governance whitelist reasoning as the 0048 entry above).
  it('0018, 0040, 0041, 0047, 0048 and 0055 are the only units with DML', () => {
    const withDml = BASELINE_UNITS.filter(
      (u) => scanBaselineSql(readOrThrow(u.file)).dmlStatements.length > 0,
    )
    expect(withDml.map((u) => u.id)).toEqual([
      '0018_redundant_firebird.sql',
      '0040_governed_model_registry.sql',
      '0041_pc01b_regime_boundary_backfill.sql',
      '0047_fib_taxonomy_mapping_governance_regime.sql',
      '0048_fib_evidence_versions.sql',
      '0055_fib_proxy_material_change_registry.sql',
    ])

    const facts0018 = scanBaselineSql(readOrThrow('db/migrations/0018_redundant_firebird.sql'))
    expect(facts0018.dmlStatements).toHaveLength(4)
    // The "zero production/tenant data" claim reduces to this assertion for the
    // two structural-backfill units: every row they could write is SELECTed
    // from a table that is empty on a fresh database.
    expect(facts0018.literalRowSources).toEqual([])
    expect(baselineUnit('0018_redundant_firebird.sql').dml).toBe('structural-backfill')

    const facts0041 = scanBaselineSql(readOrThrow('db/migrations/0041_pc01b_regime_boundary_backfill.sql'))
    expect(facts0041.literalRowSources).toEqual([])
    expect(baselineUnit('0041_pc01b_regime_boundary_backfill.sql').dml).toBe('structural-backfill')

    const facts0047 = scanBaselineSql(readOrThrow('db/migrations/0047_fib_taxonomy_mapping_governance_regime.sql'))
    expect(facts0047.literalRowSources).toEqual([])
    expect(baselineUnit('0047_fib_taxonomy_mapping_governance_regime.sql').dml).toBe('structural-backfill')

    const facts0048 = scanBaselineSql(readOrThrow('db/migrations/0048_fib_evidence_versions.sql'))
    // Same class as 0018/0041/0047: the backfill SELECTs from evidence_items
    // (a table that is empty on a fresh database) — no literal row source.
    expect(facts0048.literalRowSources).toEqual([])
    expect(baselineUnit('0048_fib_evidence_versions.sql').dml).toBe('structural-backfill')

    // 0040 is the one deliberate exception: a literal, deploy-time seed of 8
    // fixed universal-reference rows (FIBC-003) — global-catalog, not tenant
    // data, and not one of the three forbidden DML classes checked below.
    const facts0040 = scanBaselineSql(readOrThrow('db/migrations/0040_governed_model_registry.sql'))
    expect(facts0040.literalRowSources).toHaveLength(1)
    expect(baselineUnit('0040_governed_model_registry.sql').dml).toBe('global-catalog')
  })

  it('no unit is classified as carrying production data, a fixture or a development seed', () => {
    const forbidden = new Set(['production-data', 'fixture', 'development-seed'])
    expect(BASELINE_UNITS.filter((u) => forbidden.has(u.dml)).map((u) => u.id)).toEqual([])
  })
})

describe('verifyBaselineManifest fails closed on a mutated corpus', () => {
  const mutate = (target: string, transform: (sql: string) => string) => (file: string) => {
    const sql = read(file)
    if (sql === null) return null
    return file === target ? transform(sql) : sql
  }

  it('detects a changed hash', () => {
    const problems = verifyBaselineManifest(
      mutate('db/migrations/0000_quick_husk.sql', (s) => `${s}\n-- drift\n`),
      scanBaselineSql,
    )
    expect(problems.some((p) => p.kind === 'SHA_MISMATCH')).toBe(true)
  })

  it('reports the semantic change TOO, not just the hash', () => {
    // The failure mode this guards: a reviewer sees SHA_MISMATCH, updates the
    // pin, and never learns the file gained a service_role grant.
    const problems = verifyBaselineManifest(
      mutate(
        'db/migrations/0000_quick_husk.sql',
        (s) => `${s}\nGRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;\n`,
      ),
      scanBaselineSql,
    )
    expect(problems.some((p) => p.kind === 'SHA_MISMATCH')).toBe(true)
    expect(
      problems.some((p) => p.kind === 'SCAN_MISMATCH' && p.detail.includes('grantsToServiceRole')),
    ).toBe(true)
  })

  it('detects a missing file', () => {
    const problems = verifyBaselineManifest(
      (file) => (file === 'db/policies/008_marketing_leads_rls.sql' ? null : read(file)),
      scanBaselineSql,
    )
    expect(problems.some((p) => p.kind === 'MISSING_FILE')).toBe(true)
  })

  it('detects an orphan file nobody claims', () => {
    const problems = verifyBaselineManifest(read, scanBaselineSql, [
      ...discovered(),
      'db/migrations/0040_smuggled.sql',
    ])
    expect(problems.some((p) => p.kind === 'UNKNOWN_FILE')).toBe(true)
  })

  it('detects a superuser dependency introduced anywhere, with no per-unit opt-out', () => {
    const problems = verifyBaselineManifest(
      mutate('db/migrations/0010_crazy_warhawk.sql', (s) => `${s}\nALTER ROLE postgres SUPERUSER;\n`),
      scanBaselineSql,
    )
    const invariant = problems.filter((p) => p.kind === 'GLOBAL_INVARIANT_VIOLATED')
    expect(invariant.some((p) => p.detail.startsWith('superuserDependencies'))).toBe(true)
    expect(invariant.some((p) => p.detail.startsWith('roleStatements'))).toBe(true)
  })
})

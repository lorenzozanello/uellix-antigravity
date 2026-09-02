// tests/fib-audit-migrations.test.ts
// FIBIU-28 — static content checks for the three DB items this unit owns
// (FIBDB-034/035/036). No DB connection: these assert against the migration
// SQL files themselves, the same "repo-owned static migration scanner" style
// as lib/pipeline/governed-model-registry.test.ts's migration-content test.
//
// DB_RUNTIME_TEST_DEFERRED=YES — actually applying these migrations and
// observing the resulting catalog state (trigger firing on TRUNCATE, policy
// enforcement under RLS, constraint validation) requires a live PostgreSQL
// connection, which this environment is not authorized to open.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'db', 'migrations')

function readMigration(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')
}

describe('FIBDB-035 — audit_logs INSERT policy (stage A, idempotent)', () => {
  const sql = readMigration('0042_fib_audit_insert_policy.sql')

  it('drops the policy before recreating it (idempotent supersession)', () => {
    const dropIdx = sql.indexOf('DROP POLICY IF EXISTS "audit_logs_insert_member_or_admin" ON audit_logs')
    const createIdx = sql.indexOf('CREATE POLICY "audit_logs_insert_member_or_admin"')
    expect(dropIdx).toBeGreaterThanOrEqual(0)
    expect(createIdx).toBeGreaterThan(dropIdx)
  })

  it('scopes the policy to uellix_app, matching the G2-measured clause exactly', () => {
    expect(sql).toContain('TO uellix_app')
    expect(sql).toContain('actor_user_id = auth.uid()')
    expect(sql).toContain('organization_id = ANY(current_user_org_ids())')
    expect(sql).toContain('current_user_is_super_admin()')
  })

  it('is FOR INSERT only — it must not broaden to any other command', () => {
    expect(sql).toContain('ON audit_logs FOR INSERT')
    expect(sql).not.toMatch(/FOR (SELECT|UPDATE|DELETE|ALL)/)
  })

  it('appears exactly once (not duplicated)', () => {
    const occurrences = sql.split('CREATE POLICY "audit_logs_insert_member_or_admin"').length - 1
    expect(occurrences).toBe(1)
  })
})

describe('FIBDB-036 — audit_logs.project_id FK (stage B, validate-then-add)', () => {
  const sql = readMigration('0043_fib_audit_project_id_fk.sql')

  it('adds the FK as NOT VALID — validation is stage-E, deferred', () => {
    expect(sql).toContain('FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")')
    expect(sql).toMatch(/NOT VALID;\s*$/m)
  })

  it('does not perform stage-E hardening prematurely (no VALIDATE CONSTRAINT here)', () => {
    expect(sql).not.toMatch(/VALIDATE CONSTRAINT/i)
  })

  it('does not absorb the unrelated stella_interactions.model_used drift', () => {
    const executableSql = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    expect(executableSql).not.toContain('model_used')
  })
})

describe('FIBDB-034 — append-only + no-truncate trigger supersession (stage E, idempotent)', () => {
  const sql = readMigration('0044_fib_audit_hardening_supersession.sql')

  const TRIGGERS = [
    { name: 'trg_stella_interactions_append_only', table: 'stella_interactions' },
    { name: 'trg_audit_logs_no_truncate', table: 'audit_logs' },
    { name: 'trg_sroi_calculation_runs_no_truncate', table: 'sroi_calculation_runs' },
    { name: 'trg_sroi_calculation_line_items_no_truncate', table: 'sroi_calculation_line_items' },
    { name: 'trg_stella_interactions_no_truncate', table: 'stella_interactions' },
    { name: 'trg_stella_suggestion_decisions_no_truncate', table: 'stella_suggestion_decisions' },
  ]

  it('covers exactly the six triggers FIBDB-034 names — one append-only plus five no-truncate siblings', () => {
    expect(TRIGGERS).toHaveLength(6)
  })

  it.each(TRIGGERS)('drops $name before recreating it, exactly once each (idempotent, no duplicates)', ({ name, table }) => {
    const dropRe = new RegExp(`DROP TRIGGER IF EXISTS ${name} ON ${table}`, 'g')
    const createRe = new RegExp(`CREATE TRIGGER ${name}\\b`, 'g')
    const drops = sql.match(dropRe) ?? []
    const creates = sql.match(createRe) ?? []
    expect(drops).toHaveLength(1)
    expect(creates).toHaveLength(1)
    expect(sql.indexOf(drops[0] as string)).toBeLessThan(sql.indexOf(creates[0] as string))
  })

  it('reuses the existing uellix_forbid_mutation() function unchanged (no redefinition)', () => {
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i)
    const usages = sql.match(/EXECUTE FUNCTION uellix_forbid_mutation\(\)/g) ?? []
    expect(usages).toHaveLength(6)
  })

  it('never truncates or drops data — every statement is DROP TRIGGER / CREATE TRIGGER, or the relation guard around the sixth pair', () => {
    const statements = sql
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
    for (const line of statements) {
      // HPO-ODS-W2-03: the stella_suggestion_decisions pair sits inside a DO
      // block guarded on to_regclass. The guard's tokens are admitted by NAME;
      // nothing else is — no CREATE TABLE, no TRUNCATE, no DELETE.
      expect(line).toMatch(
        /^(DROP TRIGGER|CREATE TRIGGER|BEFORE|FOR EACH|DO \$\$$|BEGIN$|IF to_regclass\('public\.stella_suggestion_decisions'\) IS NOT NULL THEN$|ELSE$|RAISE NOTICE '0044_fib_audit_hardening_supersession: |END IF;$|END \$\$;$)/,
      )
    }
  })

  // HPO-ODS-W2-03 — FIBDB-034 applicability correction.
  it('guards ONLY the stella_suggestion_decisions pair on the relation existing — the other five stay unconditional', () => {
    const guardStart = sql.indexOf("IF to_regclass('public.stella_suggestion_decisions') IS NOT NULL THEN")
    const guardEnd = sql.indexOf('END $$;', guardStart)
    expect(guardStart).toBeGreaterThan(0)
    expect(guardEnd).toBeGreaterThan(guardStart)
    const guarded = sql.slice(guardStart, guardEnd)
    const outside = sql.slice(0, guardStart) + sql.slice(guardEnd)

    expect(guarded).toContain('DROP TRIGGER IF EXISTS trg_stella_suggestion_decisions_no_truncate ON stella_suggestion_decisions')
    expect(guarded).toContain('CREATE TRIGGER trg_stella_suggestion_decisions_no_truncate')
    for (const t of TRIGGERS.filter((x) => x.name !== 'trg_stella_suggestion_decisions_no_truncate')) {
      expect(guarded).not.toContain(`CREATE TRIGGER ${t.name}`)
      expect(outside.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')).toContain(`CREATE TRIGGER ${t.name}`)
    }
  })

  it('skips deterministically with a NOTICE when the relation is absent, and never creates the table', () => {
    expect(sql).toMatch(/ELSE\s+RAISE NOTICE '0044_fib_audit_hardening_supersession: public\.stella_suggestion_decisions is absent/)
    const executable = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(executable).not.toMatch(/CREATE\s+TABLE/i)
    expect(executable).not.toMatch(/ALTER\s+TABLE/i)
  })
})

describe('FIBIU-01 non-regression — 0040/0041 migrations untouched by FIBIU-28', () => {
  it('0040 still seeds exactly eight governed-model rows (unchanged by this unit)', () => {
    const sql = readMigration('0040_governed_model_registry.sql')
    const tupleRe = /\('([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g
    let count = 0
    while (tupleRe.exec(sql) !== null) count++
    expect(count).toBe(8)
  })

  it('0041 still only backfills governance_regime on projects (unchanged by this unit)', () => {
    const sql = readMigration('0041_pc01b_regime_boundary_backfill.sql')
    expect(sql).toContain("UPDATE \"projects\" SET \"governance_regime\" = 'pre_pc01b'")
  })
})

describe('W1-05-RM1 R-6/G-1 (HPO-DEC-1) — governance_regime extended to outcome_taxonomy_mappings', () => {
  const sql = readMigration('0047_fib_taxonomy_mapping_governance_regime.sql')

  it('adds the additive column and its closed CHECK vocabulary (stage A)', () => {
    expect(sql).toContain('ALTER TABLE "outcome_taxonomy_mappings" ADD COLUMN "governance_regime" varchar(20)')
    expect(sql).toContain(
      'CHECK ("outcome_taxonomy_mappings"."governance_regime" IN (\'pre_pc01b\', \'pc01b\'))'
    )
  })

  it('backfills existing rows to pre_pc01b, derived from existing content only (stage B)', () => {
    expect(sql).toContain(
      'UPDATE "outcome_taxonomy_mappings" SET "governance_regime" = \'pre_pc01b\' WHERE "governance_regime" IS NULL'
    )
  })

  // Comment-stripped view: the header prose intentionally NAMES
  // stella_interactions/model_used to explain why the drizzle-kit-proposed
  // DROP DEFAULT statement was removed (same precedent as 0043/0045's own
  // headers) — these structural assertions must scan executable SQL only.
  const executableSql = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  it('touches only outcome_taxonomy_mappings — no other table is altered by this unit', () => {
    const alteredTables = new Set(
      Array.from(executableSql.matchAll(/ALTER TABLE "([^"]+)"/g)).map((m) => m[1])
    );
    const updatedTables = new Set(
      Array.from(executableSql.matchAll(/UPDATE "([^"]+)"/g)).map((m) => m[1])
    );
    expect(alteredTables).toEqual(new Set(['outcome_taxonomy_mappings']))
    expect(updatedTables).toEqual(new Set(['outcome_taxonomy_mappings']))
  })

  it('does not opportunistically extend governance_regime to later-wave objects', () => {
    const LATER_WAVE_TABLES = [
      'outcomes', 'indicators', 'stakeholder_groups', 'evidence_items',
      'financial_proxies', 'proxy_sources', 'outcome_proxy_assignments',
      'sroi_filter_sets', 'project_investments', 'sroi_run_reviews',
      'sroi_reports', 'impact_narratives',
    ]
    for (const table of LATER_WAVE_TABLES) {
      expect(executableSql).not.toContain(`ALTER TABLE "${table}"`)
    }
  })

  it('does not re-add the pre-existing, out-of-scope stella_interactions.model_used drift as an executable statement', () => {
    expect(executableSql).not.toContain('model_used')
  })

  it('0040/0041 remain untouched by this extension (append-only migration chain)', () => {
    const sql0040 = readMigration('0040_governed_model_registry.sql')
    expect(sql0040).not.toContain('outcome_taxonomy_mappings')
  })
})

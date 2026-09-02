// db/hosted/global-catalog-seeds.ts
// HPO-ODS-W2-04 — the closed-world registry of governed baseline global-catalog
// seeds, consumed by B0-11-zero-production-data.
//
// ---------------------------------------------------------------------------
// WHAT "ZERO PRODUCTION DATA" ACTUALLY MEANS
// ---------------------------------------------------------------------------
// B0-11's own requirement was "every probed table holds zero rows", stated
// before the manifest ever classified a unit `dml: 'global-catalog'`. The
// first complete 64-unit rehearsal (HPO-ODS-W2-03) found the postcondition
// disagreeing with the manifest it is supposed to police: 0040 seeds eight
// literal, universal-reference rows into governed_model_registry — model,
// engine and methodology identities, not tenant data — and the manifest has
// said so (dml: 'global-catalog') since 2026-08-31. "Zero production data"
// means no TENANT/USER/TRANSACTIONAL/APPLICATION-PRODUCTION data; an explicit,
// governed, universal catalog seed is not that.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A CLOSED WORLD, NOT AN ALLOWLIST
// ---------------------------------------------------------------------------
// A table-name allowlist ("governed_model_registry may hold rows") would
// admit ANY row count and would silently cover a future unit that reused the
// name. What is frozen here is narrower on three axes at once: the manifest
// unit's OWN classification (dml='global-catalog', the sole source of truth —
// this module never re-classifies), the exact migration content that
// classification was reviewed against (a hash pin, independent of the
// manifest's own pin, so an edited migration that nobody re-derived the seed
// against is caught as drift rather than silently trusted), and the exact
// expected row count. A unit classified global-catalog with no spec here is a
// failure; a spec here whose unit is absent or no longer global-catalog is
// also a failure. Nothing is inferred for a future migration.

import { BASELINE_UNITS, type BaselineUnit } from './baseline-manifest'
import { sha256OfSql } from './hosted-package-manifest'

export interface GlobalCatalogSeedSpec {
  /** `BaselineUnit.id` — the manifest's own identifier, never restated as a separate name. */
  readonly unitId: string
  /** Repo-relative path, matched against the manifest unit's own `file` as a consistency check. */
  readonly file: string
  /** The table the seed populates, qualified exactly as the observation reports it. */
  readonly table: string
  /**
   * SHA-256 (LF-normalized) of the migration AS REVIEWED when this spec's row
   * count was derived. Independent of `BaselineUnit.sha256` on purpose: that
   * pin only proves the checked-in file matches what the MANIFEST expects,
   * which says nothing about whether THIS spec was ever re-derived against a
   * later edit. Two pins agreeing is the only way "the row count still
   * describes this file" is a checked fact rather than an assumption.
   */
  readonly expectedMigrationSha256: string
  /**
   * Exact expected row count THIS seed contributes to `table`. Not "greater
   * than zero" — exact, both directions. A table seeded by more than one
   * governed unit (0040 and 0056 both append to governed_model_registry;
   * 0055 and 0056 both populate proxy_material_fields_registry) holds the
   * SUM of its specs — see expectedRowCountsFromClosedWorld.
   */
  readonly expectedRowCount: number
}

/**
 * The governed global-catalog seeds, one spec per (unit, table) seed.
 *
 * HPO-ODS-W2-04 (the freeze): `db/migrations/0040_governed_model_registry.sql`
 * was the only file in the 64-unit corpus carrying `dml: 'global-catalog'`
 * (grep -oE "dml: '[a-z-]+'" over the manifest — one 'global-catalog', four
 * 'structural-backfill', the rest 'none'), and its single `INSERT … VALUES`
 * statement carries exactly eight literal tuples, counted by hand from the
 * checked-in SQL, guarded by `ON CONFLICT ("model_id","version") DO NOTHING`.
 *
 * COMMERCIAL-V1-WAVE2-RECONCILIATION-R1 (HPO-ODS-W2-08): the reconciled
 * 73-unit corpus carries the closed Wave2 B2 units 0055 and 0056, both
 * classified `dml: 'global-catalog'` by the Wave2 manifest (the sole source of
 * truth — this module never re-classifies). Derived mechanically from the
 * checked-in SQL, the same way 0040's count was:
 *   - 0055 `INSERT INTO "proxy_material_fields_registry" … VALUES` carries
 *     exactly 39 literal tuples (registry_version '1.0.0'), guarded by
 *     `ON CONFLICT ("registry_version","table_name","field_name") DO NOTHING`.
 *   - 0056 carries TWO seeds: 70 literal tuples into
 *     "proxy_material_fields_registry" (registry_version '1.1.0', same
 *     ON CONFLICT guard) and ONE literal tuple appended to
 *     "governed_model_registry" (`ON CONFLICT ("model_id","version") DO NOTHING`).
 * Each spec pins the manifest's own sha256 for its unit; the per-table
 * expectation B0-11 compares against is the SUM: governed_model_registry
 * 8 + 1 = 9, proxy_material_fields_registry 39 + 70 = 109.
 */
export const GLOBAL_CATALOG_SEED_SPECS: readonly GlobalCatalogSeedSpec[] = [
  {
    unitId: '0040_governed_model_registry.sql',
    file: 'db/migrations/0040_governed_model_registry.sql',
    table: 'public.governed_model_registry',
    expectedMigrationSha256: '269a354c4cc487eb506b88313e7077f265530fb1464fc3e93e2e0f221430c48f',
    expectedRowCount: 8,
  },
  {
    unitId: '0055_fib_proxy_material_change_registry.sql',
    file: 'db/migrations/0055_fib_proxy_material_change_registry.sql',
    table: 'public.proxy_material_fields_registry',
    expectedMigrationSha256: '58924853da26b4c1fcd5ac0af00bade9a8fa5d3fe4977d84b7032e8c4e7ea0ce',
    expectedRowCount: 39,
  },
  {
    unitId: '0056_fib_proxy_material_fields_editability.sql',
    file: 'db/migrations/0056_fib_proxy_material_fields_editability.sql',
    table: 'public.proxy_material_fields_registry',
    expectedMigrationSha256: '86d7d22347425aa02678a7aeb1ebf185f0febcd014bc994d238df88bd9f34557',
    expectedRowCount: 70,
  },
  {
    unitId: '0056_fib_proxy_material_fields_editability.sql',
    file: 'db/migrations/0056_fib_proxy_material_fields_editability.sql',
    table: 'public.governed_model_registry',
    expectedMigrationSha256: '86d7d22347425aa02678a7aeb1ebf185f0febcd014bc994d238df88bd9f34557',
    expectedRowCount: 1,
  },
]

export interface ClosedWorldViolation {
  readonly kind:
    | 'UNREGISTERED_GLOBAL_CATALOG_UNIT'
    | 'ORPHANED_SEED_SPEC'
    | 'SEED_SPEC_UNIT_NOT_GLOBAL_CATALOG'
    | 'SEED_SPEC_FILE_MISMATCH'
    | 'SEED_SPEC_HASH_DRIFT'
    | 'DUPLICATE_SEED_SPEC'
  readonly detail: string
}

/**
 * The bijection. Every manifest unit classified `dml: 'global-catalog'` has
 * at least one spec here, and EXACTLY one per (unit, table) seed it carries;
 * every spec here names a unit that EXISTS and is STILL classified
 * `dml: 'global-catalog'`, at the EXACT file the spec declares, with the
 * EXACT hash the spec was derived against.
 *
 * Called from BOTH a dedicated static test (tests/hosted/global-catalog-seeds.test.ts)
 * and from B0-11 itself at evaluation time — the manifest classification is
 * consulted LIVE, never assumed, the same discipline every other governed
 * closed-world check in this directory follows (HPO-ODS-W2-03's role
 * identities, the hosted package manifest's source pins).
 */
export function validateGlobalCatalogClosedWorld(
  units: readonly BaselineUnit[] = BASELINE_UNITS,
  specs: readonly GlobalCatalogSeedSpec[] = GLOBAL_CATALOG_SEED_SPECS,
): { readonly ok: boolean; readonly violations: readonly ClosedWorldViolation[] } {
  const violations: ClosedWorldViolation[] = []
  const byId = new Map(units.map((u) => [u.id, u]))
  const seenUnitIds = new Set<string>()
  // A unit may legitimately carry more than one seed (0056 populates two
  // tables); what is never allowed is two specs for the SAME (unit, table).
  const seenSeedKeys = new Set<string>()

  for (const spec of specs) {
    const seedKey = `${spec.unitId}\u0000${spec.table}`
    if (seenSeedKeys.has(seedKey)) {
      violations.push({ kind: 'DUPLICATE_SEED_SPEC', detail: `${spec.unitId} has more than one seed specification for ${spec.table}.` })
      continue
    }
    seenSeedKeys.add(seedKey)
    seenUnitIds.add(spec.unitId)

    const unit = byId.get(spec.unitId)
    if (!unit) {
      violations.push({ kind: 'ORPHANED_SEED_SPEC', detail: `seed spec names unit ${spec.unitId}, which does not exist in BASELINE_UNITS.` })
      continue
    }
    if (unit.dml !== 'global-catalog') {
      violations.push({
        kind: 'SEED_SPEC_UNIT_NOT_GLOBAL_CATALOG',
        detail: `seed spec names unit ${spec.unitId}, whose manifest classification is dml='${unit.dml}', not 'global-catalog'.`,
      })
    }
    if (unit.file !== spec.file) {
      violations.push({
        kind: 'SEED_SPEC_FILE_MISMATCH',
        detail: `seed spec for ${spec.unitId} declares file ${spec.file}, manifest declares ${unit.file}.`,
      })
    }
    if (unit.sha256 !== spec.expectedMigrationSha256) {
      violations.push({
        kind: 'SEED_SPEC_HASH_DRIFT',
        detail: `${spec.unitId} was reviewed at ${spec.expectedMigrationSha256.slice(0, 12)}…; the manifest now pins ${unit.sha256.slice(0, 12)}…. Re-derive the expected seed row count against the new content and repin both in the same commit.`,
      })
    }
  }

  for (const unit of units) {
    if (unit.dml === 'global-catalog' && !seenUnitIds.has(unit.id)) {
      violations.push({
        kind: 'UNREGISTERED_GLOBAL_CATALOG_UNIT',
        detail: `manifest unit ${unit.id} is classified dml='global-catalog' but has no seed specification in GLOBAL_CATALOG_SEED_SPECS.`,
      })
    }
  }

  return { ok: violations.length === 0, violations }
}

/**
 * The per-table row-count expectation B0-11 compares the observation against:
 * zero for every baseline table, except a table named by one or more specs,
 * which must hold EXACTLY the SUM of their `expectedRowCount`s — not merely
 * "more than zero", and never the last spec's count alone (0040 + 0056 both
 * seed governed_model_registry; 0055 + 0056 both seed
 * proxy_material_fields_registry).
 */
export function expectedRowCountsFromClosedWorld(
  tables: readonly string[],
  specs: readonly GlobalCatalogSeedSpec[] = GLOBAL_CATALOG_SEED_SPECS,
): ReadonlyMap<string, number> {
  const map = new Map<string, number>(tables.map((t) => [t, 0]))
  for (const spec of specs) map.set(spec.table, (map.get(spec.table) ?? 0) + spec.expectedRowCount)
  return map
}

/** Re-derives a spec's pin from the migration's live text — the drift-detection tool a repin uses. */
export function currentMigrationSha256(sql: string): string {
  return sha256OfSql(sql)
}

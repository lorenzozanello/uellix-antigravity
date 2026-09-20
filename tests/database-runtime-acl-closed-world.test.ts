/**
 * The closed-world guard for the runtime ACL contract.
 *
 * WHAT IT EXISTS TO PREVENT, stated as the defect it is the twin of. Before
 * db/prepared/stella_0021_current_schema_runtime_acl_contract.sql, a migration
 * could add a public table and NOTHING in this repository turned red. The
 * table simply had no ACL class, the runtime received SQLSTATE 42501 on it in
 * production, and the first observation was an outage. Twenty tables reached
 * that state before anybody counted them.
 *
 * THE CLAIM. Let
 *
 *     U = the public tables the governed schema sources create
 *     C = the class arrays of the package, plus its declared conditional
 *         member, plus its named capability-only exclusions
 *
 * then U == C as sets, and every name occurs in C exactly once. A name in
 * U \ C is UNCLASSIFIED; a name in C \ U is a PHANTOM classification; a name
 * twice in C is two contracts for one table.
 *
 * THE DIRECTION OF DERIVATION IS THE WHOLE POINT. U is computed from
 * db/migrations/** and cross-checked against the pgTable() declarations in
 * db/schema.ts — two sources written independently of each other and both
 * written independently of the package. U is NEVER read from the file under
 * test. A guard that derived its expectation from the same declaration it
 * checks would pass for any declaration at all, which is the vacuous shape
 * this repository has caught before and which the mutation controls below
 * exist to prove this one does not have.
 *
 * DB-FREE, deliberately. It is vitest and nothing else, so it runs on every CI
 * push rather than behind UELLIX_PG_TESTS=1. Its Real-PG twin —
 * tests/postgres/current-schema-runtime-acl.pg.test.ts, PG-04 and PG-05 —
 * proves the same closed world against a live catalog, where this one proves
 * it against the corpus.
 *
 * Authority: docs/ops/staging/CURRENT_SCHEMA_RUNTIME_ACL_SUCCESSOR_AUTHORITY_v1.0.0.json
 * SECTION_10 (the guard), SECTION_2/2B/3 (the membership it checks).
 * Manifest controls: CW-P-01, CW-P-02, CW-N-01, CW-N-02, CW-N-03,
 * M-CW-01, M-CW-02, M-CW-03.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const MIGRATIONS = path.join(ROOT, 'db', 'migrations')
const SCHEMA_TS = path.join(ROOT, 'db', 'schema.ts')
const PACKAGE = path.join(
  ROOT,
  'db',
  'prepared',
  'stella_0021_current_schema_runtime_acl_contract.sql',
)

/**
 * The prepared-chain packages that create a public table no migration does.
 *
 * Enumerated here as (name -> creating file) so the universe carries its
 * provenance rather than a bare string, and so a reader can check each claim
 * without running anything. Authority SECTION_3.
 *
 * stella_suggestion_decisions is the only one of these that is a MEMBER of the
 * closed world (it is the conditional class); the other six are the named
 * exclusions, which the package grants nothing on and asserts the posture of.
 */
const CHAIN_CREATED_PUBLIC_TABLES: ReadonlyMap<string, string> = new Map([
  ['stella_suggestion_decisions', 'db/prepared/stella_0003_suggestion_decisions.sql'],
  ['evidence_document_versions', 'db/prepared/grounding_0002_document_versions.sql'],
  ['evidence_chunks', 'db/prepared/grounding_0003_evidence_chunks.sql'],
  ['report_public_disclosures', 'db/prepared/stella_0007_public_verification_capability.sql'],
  ['capability_verification_hits', 'db/prepared/stella_0007_public_verification_capability.sql'],
  ['stripe_webhook_events', 'db/prepared/stella_0008_stripe_webhook_identity.sql'],
  ['capability_bootstrap_attempts', 'db/prepared/stella_0010_organization_bootstrap_capability.sql'],
])

/**
 * Public tables created by db/migrations/**, as a set.
 *
 * The regex is ANCHORED at the start of a line, which is what excludes the
 * known prose false positive: db/migrations/0070 and 0072 both open with the
 * Drizzle banner "-- CREATE TABLE statements above the first
 * statement-breakpoint are generated", and a comment line begins with `--`
 * rather than with whitespace. An UNANCHORED scan reports a table called
 * `statements`, which is the exact false positive the authority's own census
 * had to filter by hand.
 *
 * DROP TABLE is subtracted rather than assumed absent: the corpus has none
 * today, and a guard that silently depended on that would be wrong the first
 * time one landed.
 */
function universeFromMigrations(): { created: Map<string, string>; dropped: string[] } {
  const created = new Map<string, string>()
  const dropped: string[] = []
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8')
    for (const m of sql.matchAll(
      /^[ \t]*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gim,
    )) {
      if (!created.has(m[1])) created.set(m[1], `db/migrations/${file}`)
    }
    for (const m of sql.matchAll(
      /^[ \t]*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gim,
    )) {
      dropped.push(m[1])
      created.delete(m[1])
    }
  }
  return { created, dropped }
}

/** The pgTable() declarations of db/schema.ts — the independent cross-check. */
function universeFromSchemaTs(): Set<string> {
  const src = readFileSync(SCHEMA_TS, 'utf8')
  return new Set([...src.matchAll(/pgTable\(\s*'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]))
}

/**
 * The class arrays of the package, read from its fixed-literal DECLARE block.
 *
 * Anchored on `\n  <name> text[] := ARRAY[` so that reading `append_only` can
 * never accidentally match `append_only_legacy`: without the leading newline
 * and indentation the shorter name is a prefix of the longer one and the
 * shorter array would silently absorb the longer array's members, which would
 * make the duplicate check below unable to fire.
 */
function classArray(sql: string, name: string): string[] {
  const re = new RegExp(`\\n  ${name}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\];`)
  const m = re.exec(sql)
  if (m === null) throw new Error(`the package declares no class array named ${name}`)
  return [...m[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((x) => x[1])
}

/** Every class array of the package, by name. This is C, before flattening. */
const CLASS_ARRAY_NAMES = [
  'append_only',
  'operational_iu',
  'read_only',
  'no_runtime_access',
  'operational_legacy',
  'append_only_legacy',
  'governed_read_legacy',
  'conditional_append_only',
  'no_runtime_access_ce3',
] as const

type Problems = {
  unclassified: string[]
  phantom: string[]
  duplicated: string[]
}

/**
 * The guard itself, as a PURE function of two sets.
 *
 * Factored out rather than inlined so the mutation controls can feed it
 * deliberately broken inputs and assert that it reports the specific problem —
 * which is what makes "this test would go red" a measurement instead of a
 * claim about a procedure nobody runs.
 */
export function evaluateClosedWorld(universe: Iterable<string>, classified: readonly string[]): Problems {
  const u = new Set(universe)
  const c = new Set(classified)
  const seen = new Map<string, number>()
  for (const name of classified) seen.set(name, (seen.get(name) ?? 0) + 1)

  return {
    unclassified: [...u].filter((n) => !c.has(n)).sort(),
    phantom: [...c].filter((n) => !u.has(n)).sort(),
    duplicated: [...seen].filter(([, n]) => n > 1).map(([name]) => name).sort(),
  }
}

const packageSql = readFileSync(PACKAGE, 'utf8')
const migrationUniverse = universeFromMigrations()
const schemaUniverse = universeFromSchemaTs()

/** C, flattened: every classified name, WITH duplicates preserved. */
const classified: string[] = CLASS_ARRAY_NAMES.flatMap((n) => classArray(packageSql, n))
/** The six named exclusions, which are accounted for but not classified. */
const exclusions: string[] = classArray(packageSql, 'capability_only')

/** U: migration-created tables plus the chain-created ones, by provenance. */
const universe: string[] = [
  ...migrationUniverse.created.keys(),
  ...CHAIN_CREATED_PUBLIC_TABLES.keys(),
]

describe('CW-P-01 — the universe U is derived independently of the package', () => {
  it('db/migrations/** and db/schema.ts agree on the migration-created tables', () => {
    // M-CW-03. The two sources are written by different mechanisms — hand-written
    // SQL and Drizzle declarations — so agreement between them is evidence, and
    // substituting one for the other must not change the answer.
    const fromMigrations = new Set(migrationUniverse.created.keys())
    expect([...fromMigrations].sort()).toEqual([...schemaUniverse].sort())
  })

  it('reports no DROP TABLE, which is a measurement and not an assumption', () => {
    expect(migrationUniverse.dropped).toEqual([])
  })

  it('does NOT admit the `statements` prose false positive', () => {
    // The anchored regex is load-bearing. An unanchored one matches the Drizzle
    // banner comment in db/migrations/0070 and 0072 and reports a table named
    // `statements`, which would then show up as permanently UNCLASSIFIED.
    expect(migrationUniverse.created.has('statements')).toBe(false)

    // POSITIVE CONTROL for that claim: the banner really is there, so the
    // exclusion above is doing work rather than describing a case that never
    // arises.
    const banner = readFileSync(
      path.join(MIGRATIONS, '0070_customer_lifecycle_cl1_legal_acceptance.sql'),
      'utf8',
    )
    expect(banner).toMatch(/--\s*CREATE TABLE statements/)
  })

  it('names a creating file for every member of U', () => {
    for (const name of migrationUniverse.created.keys()) {
      expect(migrationUniverse.created.get(name), name).toMatch(/^db\/migrations\/\d{4}_/)
    }
    for (const [name, file] of CHAIN_CREATED_PUBLIC_TABLES) {
      expect(file, name).toMatch(/^db\/prepared\//)
    }
  })
})

describe('CW-P-02 — U == C, read from the package and never from itself', () => {
  it('every class array the contract declares is present and non-empty', () => {
    for (const name of CLASS_ARRAY_NAMES) {
      expect(classArray(packageSql, name).length, name).toBeGreaterThan(0)
    }
    expect(exclusions.length).toBe(6)
  })

  it('classifies every public table exactly once, with no phantom and no duplicate', () => {
    const problems = evaluateClosedWorld(universe, [...classified, ...exclusions])
    expect(problems.unclassified, 'public tables with NO ACL class').toEqual([])
    expect(problems.phantom, 'classified names no source creates').toEqual([])
    expect(problems.duplicated, 'names carrying two contracts').toEqual([])
  })

  it('reproduces the frozen arithmetic from the arrays rather than from a count field', () => {
    const size = (n: (typeof CLASS_ARRAY_NAMES)[number]) => classArray(packageSql, n).length

    // Authority SECTION_2: the nineteen that stella_0004 never classified.
    expect(
      size('append_only') + size('operational_iu') + size('read_only') + size('no_runtime_access'),
    ).toBe(19)
    expect(size('append_only')).toBe(8)
    expect(size('operational_iu')).toBe(6)
    expect(size('read_only')).toBe(4)
    expect(size('no_runtime_access')).toBe(1)

    // Authority SECTION_2B: the legacy thirty-eight, at their amended end-state.
    expect(
      size('operational_legacy') +
        size('append_only_legacy') +
        size('governed_read_legacy') +
        size('conditional_append_only'),
    ).toBe(38)
    expect(size('operational_legacy')).toBe(33)
    expect(size('append_only_legacy')).toBe(3)
    expect(size('governed_read_legacy')).toBe(1)
    expect(size('conditional_append_only')).toBe(1)

    // Authority SECTION_3: the one migration 0073 added.
    expect(size('no_runtime_access_ce3')).toBe(1)

    // 19 + 38 + 1 = 58 CLASSIFIED names.
    expect(classified.length).toBe(58)

    // The universe is larger than the closed world, and the difference is
    // exactly the six exclusions. Those six ARE public tables — so U must
    // account for them or they would read as unclassified — but they are not
    // MEMBERS of the contract: the package grants nothing on them and asserts
    // their posture instead. Stating the two numbers separately is what keeps
    // "accounted for" and "classified" from collapsing into one another.
    expect(new Set(universe).size).toBe(64)
    expect(classified.length + exclusions.length).toBe(64)

    // And the split is by provenance, not by preference: all 58 classified
    // names but the conditional member are migration-created, and all six
    // exclusions are prepared-chain-created.
    expect(migrationUniverse.created.size).toBe(57)
    expect(CHAIN_CREATED_PUBLIC_TABLES.size).toBe(7)
    for (const name of exclusions) {
      expect(CHAIN_CREATED_PUBLIC_TABLES.has(name), `${name} is not chain-created`).toBe(true)
      expect(migrationUniverse.created.has(name), `${name} is migration-created`).toBe(false)
    }
  })

  it('pins the membership decisions the authority argues for by name', () => {
    // marketing_leads is OPERATIONAL_legacy at the INSTALLED end-state. It is
    // the authority's R2 material correction: stella_0009 WOULD revoke its four
    // privileges, but it is DESIGN and NOT INSTALLED, and a REVOKE inside an
    // unapplied file is a no-op. A future edit that moved it would be freezing
    // an unapplied design package.
    expect(classArray(packageSql, 'operational_legacy')).toContain('marketing_leads')

    // stella_interactions is GOVERNED_READ, not APPEND_ONLY: stella_0017 is
    // INSTALLED on the hosted chain and withdrew its INSERT (R6-INT).
    expect(classArray(packageSql, 'governed_read_legacy')).toEqual(['stella_interactions'])
    expect(classArray(packageSql, 'append_only_legacy')).not.toContain('stella_interactions')

    // The two tables no runtime role may touch at all.
    expect(classArray(packageSql, 'no_runtime_access')).toEqual(['commercial_accounts'])
    expect(classArray(packageSql, 'no_runtime_access_ce3')).toEqual(['entitlement_grants'])

    // The conditional member, and the six exclusions, exactly.
    expect(classArray(packageSql, 'conditional_append_only')).toEqual(['stella_suggestion_decisions'])
    expect([...exclusions].sort()).toEqual([
      'capability_bootstrap_attempts',
      'capability_verification_hits',
      'evidence_chunks',
      'evidence_document_versions',
      'report_public_disclosures',
      'stripe_webhook_events',
    ])
  })

  it('keeps the class arrays pairwise disjoint', () => {
    for (const a of CLASS_ARRAY_NAMES) {
      for (const b of CLASS_ARRAY_NAMES) {
        if (a >= b) continue
        const left = new Set(classArray(packageSql, a))
        const overlap = classArray(packageSql, b).filter((n) => left.has(n))
        expect(overlap, `${a} and ${b} overlap`).toEqual([])
      }
    }
  })
})

describe('the guard is FALSIFIABLE — each mutation is applied, not described', () => {
  const allAccounted = [...classified, ...exclusions]

  it('M-CW-01 — removing ONE name from a class array reports it as unclassified', () => {
    const victim = 'readiness_assessments'
    expect(classified).toContain(victim)

    const mutated = allAccounted.filter((n) => n !== victim)
    const problems = evaluateClosedWorld(universe, mutated)

    expect(problems.unclassified).toEqual([victim])
    expect(problems.phantom).toEqual([])
    expect(problems.duplicated).toEqual([])
  })

  it('M-CW-01b — removing any ONE name at all is caught, not just the sampled one', () => {
    // A single sampled victim proves the mechanism; sweeping every member proves
    // there is no member the guard happens to be blind to. The distinction has
    // bitten this repository before, where a control passed on the one row its
    // author picked.
    for (const victim of allAccounted) {
      const problems = evaluateClosedWorld(
        universe,
        allAccounted.filter((n) => n !== victim),
      )
      expect(problems.unclassified, `removing ${victim} went unnoticed`).toEqual([victim])
    }
  })

  it('M-CW-02 — adding ONE fixture table to U reports it as unclassified', () => {
    // Simulates the exact defect this guard exists for: a new migration creates
    // a public table and nobody classifies it.
    const problems = evaluateClosedWorld([...universe, 'zz_new_migration_table'], allAccounted)

    expect(problems.unclassified).toEqual(['zz_new_migration_table'])
    expect(problems.phantom).toEqual([])
  })

  it('CW-N-02 — a phantom classification is reported, in the other direction', () => {
    const problems = evaluateClosedWorld(universe, [...allAccounted, 'zz_phantom_table'])

    expect(problems.phantom).toEqual(['zz_phantom_table'])
    expect(problems.unclassified).toEqual([])
  })

  it('CW-N-03 — a name in two classes is reported as duplicated', () => {
    const problems = evaluateClosedWorld(universe, [...allAccounted, 'readiness_assessments'])

    expect(problems.duplicated).toEqual(['readiness_assessments'])
    // And the set comparison alone would NOT have caught it, which is why the
    // duplicate check is a separate arm rather than a consequence of the others.
    expect(problems.unclassified).toEqual([])
    expect(problems.phantom).toEqual([])
  })

  it('M-CW-03 — substituting the db/schema.ts universe changes nothing', () => {
    const viaSchema = [...schemaUniverse, ...CHAIN_CREATED_PUBLIC_TABLES.keys()]
    const problems = evaluateClosedWorld(viaSchema, allAccounted)

    expect(problems.unclassified).toEqual([])
    expect(problems.phantom).toEqual([])
    expect(problems.duplicated).toEqual([])
  })

  it('the class-array reader cannot be fooled by a prefix name', () => {
    // `append_only` is a strict prefix of `append_only_legacy`. An unanchored
    // reader returns the WRONG array for the shorter name, which would make the
    // disjointness and duplicate checks compare an array against itself and
    // pass vacuously.
    const shorter = classArray(packageSql, 'append_only')
    const longer = classArray(packageSql, 'append_only_legacy')
    expect(shorter).not.toEqual(longer)
    expect(shorter).toHaveLength(8)
    expect(longer).toHaveLength(3)
    expect(shorter).not.toContain('audit_logs')
    expect(longer).toContain('audit_logs')
  })

  it('reading a class array that does not exist THROWS rather than returning empty', () => {
    // An empty return would make every downstream check pass for a package that
    // had silently dropped a class.
    expect(() => classArray(packageSql, 'no_such_class')).toThrow(/declares no class array/)
  })
})

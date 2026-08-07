// db/hosted/baseline-manifest.ts
// TRAIN 5C0 — Phase 8. The source of truth for the UELLIX BASELINE, the part of
// a hosted provisioning that runs BEFORE Stella exists at all.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE HAD TO EXIST
// ---------------------------------------------------------------------------
// STELLA_STAGING_PROVISIONING_REQUIREMENTS.md §2 asked for two things before the
// bootstrap — "migraciones base 0000…0039" and "db/policies/001…008" — and
// neither had a runner, a manifest, an order or a verification anywhere in the
// repository. `db/policies/**` is referenced by exactly one comment in one test
// and by no executable code at all. So "apply the baseline" was a sentence in a
// document, and the first hosted write was going to be an operator reading that
// sentence and improvising.
//
// Deriving the real inventory produced three facts the sentence did not contain:
//
//   1. THE CHAIN AS WRITTEN CANNOT COMPLETE. `0039_grant_rls_helper_execution.sql`
//      grants EXECUTE on `public.can_read_evidence_object(text, uuid)` and
//      `public.can_write_evidence_object(text, uuid)`. Those functions are created
//      ONLY in `supabase/migrations/20260716000001_storage_policies.sql`, which is
//      in neither A1 nor A2. GRANT on a non-existent function raises 42883, so
//      applying "0000…0039" alone aborts on the last unit.
//
//      It works locally because it never runs alone locally: `supabase/config.toml`
//      sets `[db.migrations] enabled = true`, so `supabase start` applies both
//      Supabase units before `pnpm db:migrate:local` runs a single drizzle file.
//      The local pipeline was hiding the ordering defect, which is precisely the
//      failure mode the instruction "no declares el baseline compatible sólo porque
//      funciona localmente" names.
//
//   2. A2 IS ALMOST ENTIRELY A RE-APPLICATION. `db/policies/001_initial_auth_rls.sql`
//      is BYTE-IDENTICAL to `db/migrations/0031_rls_core.sql` (both
//      e525b1ee…c054ef), and `db/policies/002…007` concatenated are
//      statement-for-statement `0032_rls_specialized.sql` — 0032 contains no
//      statement the policies lack. Only `008_marketing_leads_rls.sql` carries
//      content the migration chain never applies.
//
//   3. 008 IS THE ONE UNIT THAT REFUSES A SECOND APPLICATION. It is the only file
//      in the whole baseline whose CREATE POLICY statements have no preceding
//      DROP POLICY IF EXISTS. 001…007 have 103 guarded creates between them; 008
//      has three unguarded ones and raises 42710 on re-apply.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE PINS, AND WHAT IT REFUSES TO PIN
// ---------------------------------------------------------------------------
// It pins ORDER, HASHES, DEPENDENCIES and the JUDGEMENTS a human made (data
// class, managed-compatibility class, reapply behaviour, rollback). It does NOT
// restate the SQL, and it does not hand-transcribe the structural properties of
// 50 files: `db/hosted/baseline-scanner.ts` derives those, and this manifest
// pins the derivation's EXPECTED result.
//
// The split matters. A hash alone catches an unannounced edit. It does not catch
// an ANNOUNCED edit — the normal case, where somebody changes a migration and
// updates the pin in the same commit — that also happens to introduce a
// service_role grant. Pinning the scan closes that: the reviewer sees
// `grantsToServiceRole: false` turn into `true` in the diff, next to the hash.

import { sha256OfSql } from './hosted-package-manifest'
import { splitSqlStatements, stripSqlComments } from './baseline-scanner'
import type {
  BaselineDmlClass,
  BaselineManagedClass,
  BaselineReapplyClass,
  BaselineScanFacts,
} from './baseline-scanner'

/** Which of the three checked-in sets a unit comes from. */
export type BaselineUnitKind =
  /** `db/migrations/NNNN_*.sql` — the drizzle chain, forward-only. */
  | 'drizzle-migration'
  /** `supabase/migrations/*.sql` — applied by `supabase start` locally, by NOBODY hosted. */
  | 'supabase-migration'
  /** `db/policies/NNN_*.sql` — the A2 set. */
  | 'policy'

/**
 * The scan properties this manifest pins PER UNIT.
 *
 * Only the exceptions are listed. Everything a unit does not declare is asserted
 * to be the safe default by `BASELINE_GLOBAL_INVARIANTS` below, for every unit,
 * with no opt-out — so a new unit that quietly grants to service_role fails the
 * verification by DEFAULT rather than by somebody remembering to add a pin.
 */
export interface BaselineExpectedScan {
  readonly usesServiceRole?: boolean
  readonly grantsToServiceRole?: boolean
  readonly usesAnon?: boolean
  readonly usesAuthenticated?: boolean
  readonly referencesAuthSchema?: boolean
  readonly referencesStorageSchema?: boolean
  readonly rlsEnabledTableCount?: number
  readonly policiesCreatedCount?: number
  readonly functionsCreatedCount?: number
  readonly securityDefinerCount?: number
  /** Exact `SET search_path` values, in order of appearance. */
  readonly searchPathSettings?: readonly string[]
  readonly triggersCreatedCount?: number
  readonly dmlStatementCount?: number
  /** DML rows that come from a literal VALUES list. Phase 5's tripwire. */
  readonly literalRowSourceCount?: number
  readonly unguardedPolicyCreateCount?: number
  /**
   * SHA-256 over every policy predicate and SECURITY DEFINER body in the unit.
   *
   * The counts above answer "how many policies?"; this answers "saying what?".
   * Adversarial review B showed the difference is the whole game: rewriting
   * `USING (id = auth.uid())` to `USING (true)`, or a definer body to
   * `SELECT true`, moves not one count. Omitted means the unit has no policy and
   * no definer, and the verifier expects the digest of the empty string.
   */
  readonly securitySurfaceDigest?: string
}

/** SHA-256 of the empty string — the digest of a unit with no access-control surface. */
export const EMPTY_SECURITY_SURFACE_DIGEST =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export interface BaselineUnit {
  /** 1-based position in the ONE true order. Contiguous, no gaps. */
  readonly ordinal: number
  /** Stable id. The basename — unique across all three sets. */
  readonly id: string
  readonly kind: BaselineUnitKind
  /** Repo-relative path, POSIX separators. */
  readonly file: string
  /** SHA-256 of the LF-normalized file. */
  readonly sha256: string
  /**
   * Units that MUST already be applied. Ids, not ordinals: an insertion in the
   * middle must not silently re-point a dependency at a different unit.
   */
  readonly dependsOn: readonly string[]
  readonly dml: BaselineDmlClass
  readonly managed: BaselineManagedClass
  readonly reapply: BaselineReapplyClass
  /** Why the managed class is what it is. One reviewable sentence. */
  readonly managedNote: string
  /** What happens if this unit fails, and whether it can be undone. */
  readonly rollback: string
  /**
   * For the A2 policies: the migration whose content this unit repeats. A test
   * PROVES the relation rather than trusting this string.
   */
  readonly equivalentTo?: string
  readonly expect: BaselineExpectedScan
}

/**
 * SQL the repository holds that the baseline deliberately does NOT apply, and
 * the evidence for each exclusion.
 *
 * "Which files did you leave out?" is the first question an omitted-migration
 * review asks, and "the three directories I scanned" is not an answer — it is a
 * restatement of the scan. So the exclusions are enumerated, each with the unit
 * that already carries its effect, and a test asserts those units are in the
 * manifest.
 */
export const BASELINE_DELIBERATE_EXCLUSIONS: readonly {
  readonly path: string
  readonly supersededBy: readonly string[]
  readonly reason: string
}[] = [
  {
    path: 'db/manual-migrations/001_unique_constraints.sql',
    supersededBy: ['0029_integrity.sql'],
    reason:
      'Applied BY HAND to production in July 2026, before the Drizzle snapshot drift was resolved. ' +
      '0029 carries the same two CREATE UNIQUE INDEX IF NOT EXISTS statements. Its own README said the ' +
      'DDL would be folded into a generated migration once the drift cleared; it was.',
  },
  {
    path: 'db/manual-migrations/002_append_only.sql',
    supersededBy: ['0030_immutability.sql'],
    reason:
      'Same history. 0030 installs uellix_forbid_mutation() and the three append-only triggers on ' +
      'audit_logs, sroi_calculation_runs and sroi_calculation_line_items.',
  },
  {
    path: 'db/manual-migrations/003_numeric_columns.sql',
    supersededBy: ['0016_fat_mac_gargan.sql'],
    reason:
      'Same history, and this one would ACTIVELY FAIL if re-applied: it converts varchar money columns ' +
      'with `USING nullif(amount, \'\')::numeric`, and after 0016 those columns are already ' +
      'numeric(20,4), so nullif(numeric, text) has no matching operator. Running it against a new ' +
      'staging project is not redundant, it is an error.',
  },
  {
    path: 'db/baseline/stella_g2_schema.sql',
    supersededBy: [],
    reason:
      'A pg_dump of a Supabase database, used by the Train 4 E2E harness to stand up a disposable ' +
      'container quickly. It is NOT the Uellix baseline despite the directory name — it carries ' +
      'auth/storage/realtime/graphql schemas a managed project provides for itself, and restoring it ' +
      'over a new project would fight the platform. The name collision is the hazard: A1 says ' +
      '"baseline" and db/baseline/ is not it.',
  },
  {
    path: 'db/audit/canonical_acl.sql',
    supersededBy: [],
    reason: 'A read-only audit query, not a migration. It creates nothing.',
  },
]

/**
 * Properties every unit must have, checked with no per-unit opt-out.
 *
 * These are the Phase 6 questions. The answer for the entire baseline is "none",
 * and that is a measured result, not an aspiration: the scanner finds zero
 * superuser dependencies, zero role statements, zero ownership transfers and
 * zero extension statements across all fifty units.
 */
export const BASELINE_GLOBAL_INVARIANTS = {
  superuserDependencies: 0,
  roleStatements: 0,
  ownershipStatements: 0,
  extensionStatements: 0,
} as const

const D = 'drizzle-migration' as const
const S = 'supabase-migration' as const
const P = 'policy' as const

/** Shorthand for the overwhelmingly common case: pure forward-only Drizzle DDL. */
const PLAIN_DDL = {
  dml: 'none',
  managed: 'A-hosted-compatible',
  reapply: 'destructive-on-reapply',
  managedNote:
    'Pure DDL on schema public: CREATE TABLE / ADD COLUMN / ADD CONSTRAINT / CREATE INDEX. ' +
    'Managed Supabase grants `postgres` everything this needs.',
  rollback:
    'Applied with psql -1, so a failure inside the unit rolls the unit back whole. There is no ' +
    'reverse script: the drizzle chain is forward-only and a partially advanced chain is recovered ' +
    'by DESTROY_AND_REPROVISION, not by hand.',
} satisfies Pick<BaselineUnit, 'dml' | 'managed' | 'reapply' | 'managedNote' | 'rollback'>

/**
 * THE ORDER.
 *
 * Drizzle 0000…0038, then the two Supabase units, then 0039, then the policies.
 *
 * The two Supabase units sit between 0038 and 0039 and neither end of that
 * bracket is arbitrary:
 *
 *   - AFTER 0033, because 0033 does `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA
 *     public FROM PUBLIC, anon, authenticated`. A storage helper created before
 *     that sweep loses the grant its own file issued, and only 0039 puts it back.
 *     Creating them after the sweep means the file's own REVOKE/GRANT pair is the
 *     state that survives, and 0039 is then a re-assertion rather than a repair.
 *   - BEFORE 0039, because 0039 grants EXECUTE on the two functions they create.
 *     This is the hard constraint: violate it and the chain aborts with 42883.
 *
 * 0039's own header already said "must run after that baseline (and after the
 * Storage helpers)". The instruction was correct and had no runner to obey it.
 */
export const BASELINE_UNITS: readonly BaselineUnit[] = [
  { ordinal: 1, id: '0000_quick_husk.sql', kind: D, file: 'db/migrations/0000_quick_husk.sql', sha256: 'b818022f9931ebf15eedcb97fd932dc27be5d313cf9977e975e26b745173b94d', dependsOn: [], ...PLAIN_DDL, expect: {} },
  { ordinal: 2, id: '0001_noisy_chameleon.sql', kind: D, file: 'db/migrations/0001_noisy_chameleon.sql', sha256: 'f51cf80ee032b6e19237dde0879908853b05f87ead9a3bcc23a52fc19e9c3c20', dependsOn: ['0000_quick_husk.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 3, id: '0002_huge_namorita.sql', kind: D, file: 'db/migrations/0002_huge_namorita.sql', sha256: '9bd7aff8af7f6e293c6ae5677952a20e966fbdce81d83d58f9d6dc2e30ccacaa', dependsOn: ['0000_quick_husk.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 4, id: '0003_curvy_tempest.sql', kind: D, file: 'db/migrations/0003_curvy_tempest.sql', sha256: 'ed64c61ed8ae3f3c4f57df94697a84b7f9370de033346b285b1a48db0694b681', dependsOn: ['0002_huge_namorita.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 5, id: '0004_thick_mentor.sql', kind: D, file: 'db/migrations/0004_thick_mentor.sql', sha256: '71313051a29a52a80b1d8690531644877683662bf107c4e0f1a0beee313abc0b', dependsOn: ['0003_curvy_tempest.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 6, id: '0005_daffy_dreaming_celestial.sql', kind: D, file: 'db/migrations/0005_daffy_dreaming_celestial.sql', sha256: '11da84d34e52d1bdb9824d573bc787c3200b2e36d6da1cba8822a83d5aca86a6', dependsOn: ['0004_thick_mentor.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 7, id: '0006_outstanding_vindicator.sql', kind: D, file: 'db/migrations/0006_outstanding_vindicator.sql', sha256: 'e0b01f5558488a601177b806d63ffa5b0d40f336525a7a2f5d42fcfac529a5b8', dependsOn: ['0005_daffy_dreaming_celestial.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 8, id: '0007_black_imperial_guard.sql', kind: D, file: 'db/migrations/0007_black_imperial_guard.sql', sha256: '054e9361a1103af350dc6c39bae6eef9a8767e6109df731c4759b73ade1cbfdd', dependsOn: ['0006_outstanding_vindicator.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 9, id: '0008_bored_pretty_boy.sql', kind: D, file: 'db/migrations/0008_bored_pretty_boy.sql', sha256: '45b2c1eed6309cb4c3875a0b7a17b4501a2c8d220a2632e6bd5526b95a144f9c', dependsOn: ['0007_black_imperial_guard.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 10, id: '0009_motionless_peter_parker.sql', kind: D, file: 'db/migrations/0009_motionless_peter_parker.sql', sha256: '2c89ca5e86189c3d18c2eb21f54b9f55b2c3f26db0d369c9a4a939d55d87d41c', dependsOn: ['0008_bored_pretty_boy.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 11, id: '0010_crazy_warhawk.sql', kind: D, file: 'db/migrations/0010_crazy_warhawk.sql', sha256: 'b8768d534f82e72e893359643dfcb837594b162b3ba936b651e0f5e0b7b5d34e', dependsOn: ['0009_motionless_peter_parker.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 12, id: '0011_sroi_results_report_foundation.sql', kind: D, file: 'db/migrations/0011_sroi_results_report_foundation.sql', sha256: '415404b111b810a609b3d749d51085b73e21aca1573ad4dad754bb978dd0a43f', dependsOn: ['0010_crazy_warhawk.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 13, id: '0012_stella_interactions.sql', kind: D, file: 'db/migrations/0012_stella_interactions.sql', sha256: 'ad536216e912fb4a52ec5d01ae4104d43aca77b9824704d5f5fe4aedc945d1ff', dependsOn: ['0011_sroi_results_report_foundation.sql'], ...PLAIN_DDL,
    managedNote:
      'Creates public.stella_interactions — the LEDGER. It is baseline, not Stella: the table predates ' +
      'the capability chain, and stella_hosted_0001 moves its OWNER. Nothing here is Stella surface in ' +
      'the sense CHECKPOINT A0 probed for, which looked for schema uellix_stella.',
    expect: {} },
  { ordinal: 14, id: '0013_performance_indexes.sql', kind: D, file: 'db/migrations/0013_performance_indexes.sql', sha256: 'c2459cb7c1ccf58fc07d8b994280aac643c300990bbd6add23a9ccdaae96a0c0', dependsOn: ['0012_stella_interactions.sql'], ...PLAIN_DDL, reapply: 'idempotent',
    rollback: 'Every index is CREATE INDEX IF NOT EXISTS; re-running converges. Dropping is safe and lossless.',
    expect: {} },
  { ordinal: 15, id: '0014_fine_blade.sql', kind: D, file: 'db/migrations/0014_fine_blade.sql', sha256: 'fbc231b673c803b0eefd110c589ad7f4c4d5b2398945d4f8036792df1373b209', dependsOn: ['0013_performance_indexes.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 16, id: '0015_misty_lorna_dane.sql', kind: D, file: 'db/migrations/0015_misty_lorna_dane.sql', sha256: 'a5c05d3fc4c563c15cc16f9ba620310f64e96bee9bc6f8784992328c9860b05a', dependsOn: ['0014_fine_blade.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 17, id: '0016_fat_mac_gargan.sql', kind: D, file: 'db/migrations/0016_fat_mac_gargan.sql', sha256: 'feaaf18afcea0e8310dd9dae82faf87d1f84bbd0c9a4f62d5663558ae95d4e39', dependsOn: ['0015_misty_lorna_dane.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 18, id: '0017_striped_legion.sql', kind: D, file: 'db/migrations/0017_striped_legion.sql', sha256: '23859cbe9335078dd46658272de937467a4b647c54fe3ec73092d68b502f414b', dependsOn: ['0016_fat_mac_gargan.sql'], ...PLAIN_DDL, expect: {} },
  {
    ordinal: 19,
    id: '0018_redundant_firebird.sql',
    kind: D,
    file: 'db/migrations/0018_redundant_firebird.sql',
    sha256: '9705a5ae5bc2e49348cdfbcf22e4b3ab234b3e7f73f1cce48760f60c897ca1c4',
    dependsOn: ['0017_striped_legion.sql'],
    // THE ONLY DML IN THE ENTIRE BASELINE, and the classification is mechanical
    // rather than asserted: the scanner reports four DML statements and ZERO
    // literal row sources. Every row comes from a SELECT over tables in the same
    // database, so on an empty database all four affect exactly zero rows. The
    // string 'Financiador no especificado' is a placeholder the backfill would
    // write for pre-existing investments; with no investments, it is never
    // written. A staging project provisioned from empty therefore receives the
    // schema change and no rows — which is what "cero datos productivos" has to
    // mean if it is to mean anything checkable.
    dml: 'structural-backfill',
    managed: 'A-hosted-compatible',
    reapply: 'destructive-on-reapply',
    managedNote:
      'Backfill-then-tighten: adds columns nullable, backfills by SELECT, then SET NOT NULL and ' +
      'ADD CONSTRAINT. No managed-Supabase surface involved.',
    rollback:
      'Its own header marks it DEPLOY-COUPLED against a live app. Against an EMPTY staging project ' +
      'that coupling is inert — there are no rows to break — but the unit still cannot be re-run: ' +
      'ADD CONSTRAINT has no IF NOT EXISTS.',
    expect: { dmlStatementCount: 4, literalRowSourceCount: 0 },
  },
  { ordinal: 20, id: '0019_lazy_overlord.sql', kind: D, file: 'db/migrations/0019_lazy_overlord.sql', sha256: 'dea903f29e6852049c11dc6bd61a5940e9689d4a5ef310afa54a70fc0a83f884', dependsOn: ['0018_redundant_firebird.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 21, id: '0020_long_squadron_supreme.sql', kind: D, file: 'db/migrations/0020_long_squadron_supreme.sql', sha256: '793bcfd8ee78c63df632e9760a4774ae75b24fb2477ece747f99dfe7bac617cd', dependsOn: ['0019_lazy_overlord.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 22, id: '0021_glorious_sandman.sql', kind: D, file: 'db/migrations/0021_glorious_sandman.sql', sha256: '0c0ef0ab0ee36c6b7d8b8240e8b7c274cc81ff85c2d39bcaf760ac4c690b26d9', dependsOn: ['0020_long_squadron_supreme.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 23, id: '0022_abandoned_karma.sql', kind: D, file: 'db/migrations/0022_abandoned_karma.sql', sha256: '1ef5fbbbe6ee57bde0bf1f5204454c6107db53b69e5064b9b4317c0b65b570c7', dependsOn: ['0021_glorious_sandman.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 24, id: '0023_faulty_silver_sable.sql', kind: D, file: 'db/migrations/0023_faulty_silver_sable.sql', sha256: '8f75bde661c36a70ef378784965173001d7e10b871c22a9cbf6052a5aff06eb8', dependsOn: ['0022_abandoned_karma.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 25, id: '0024_outstanding_enchantress.sql', kind: D, file: 'db/migrations/0024_outstanding_enchantress.sql', sha256: 'b501f3f883e04388c84c7104366d4c63b548688e07a2ce21ec64280bf8675407', dependsOn: ['0023_faulty_silver_sable.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 26, id: '0025_shallow_mattie_franklin.sql', kind: D, file: 'db/migrations/0025_shallow_mattie_franklin.sql', sha256: 'b319e3002202892d94a4d268cfe514143e6effd2ce3495924c738753a6aaa8e0', dependsOn: ['0024_outstanding_enchantress.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 27, id: '0026_violet_selene.sql', kind: D, file: 'db/migrations/0026_violet_selene.sql', sha256: '77dc38edd47892ff1f8d5f630b70107eb4dbc38c31b03be80c3469e8948de508', dependsOn: ['0025_shallow_mattie_franklin.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 28, id: '0027_little_midnight.sql', kind: D, file: 'db/migrations/0027_little_midnight.sql', sha256: 'fe90355b15a7182485806a0279ad28a043540bfd05071c58ce60789bfbfd7fb0', dependsOn: ['0026_violet_selene.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 29, id: '0028_keen_iron_patriot.sql', kind: D, file: 'db/migrations/0028_keen_iron_patriot.sql', sha256: 'f7e20bc5baea483a72072f61eef530e1d0f85dc8b7cd1293164bd4a96bef61bd', dependsOn: ['0027_little_midnight.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 30, id: '0029_integrity.sql', kind: D, file: 'db/migrations/0029_integrity.sql', sha256: '1958730c812c3171695a47b051a36c2e75122b54371a4bf7271faf4be4ec2d11', dependsOn: ['0028_keen_iron_patriot.sql'], ...PLAIN_DDL, reapply: 'idempotent',
    rollback: 'Two CREATE UNIQUE INDEX IF NOT EXISTS. Converges on re-apply; dropping is lossless.',
    expect: {} },
  {
    ordinal: 31,
    id: '0030_immutability.sql',
    kind: D,
    file: 'db/migrations/0030_immutability.sql',
    sha256: 'fbb9d9ac0c27ffebe4c59d8520288f94d1c0738cfeda64ed39a6acfb7d936c59',
    dependsOn: ['0029_integrity.sql'],
    ...PLAIN_DDL,
    reapply: 'idempotent',
    managedNote:
      'Installs uellix_forbid_mutation() and three BEFORE UPDATE OR DELETE triggers making audit_logs, ' +
      'sroi_calculation_runs and sroi_calculation_line_items append-only. Plain plpgsql, no privileged ' +
      'surface. Note these are ordinary triggers, not ENABLE ALWAYS: a session that sets ' +
      'session_replication_role = replica bypasses them, which managed Supabase does not permit anyway.',
    rollback: 'CREATE OR REPLACE FUNCTION plus DROP TRIGGER IF EXISTS before each CREATE. Converges.',
    expect: { functionsCreatedCount: 1, triggersCreatedCount: 3 },
  },
  {
    ordinal: 32,
    id: '0031_rls_core.sql',
    kind: D,
    file: 'db/migrations/0031_rls_core.sql',
    sha256: 'e525b1eefa723bb38db5121a08b5cc416126f64c0563687ada6fcc2a7cc054ef',
    dependsOn: ['0030_immutability.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'idempotent',
    managedNote:
      'Calls auth.uid() from three SECURITY DEFINER helpers and from policy predicates. On managed ' +
      'Supabase auth.uid() EXISTS and is callable — the RR-09 problem Train 5A measured is about ' +
      'GRANTING schema auth to a role WE create, which this unit never does: its definers are owned by ' +
      'the installing role (postgres), which already holds USAGE on auth. So it needs no rewrite. It ' +
      'would fail on a bare PostgreSQL with no auth schema, which is why the local rehearsal runs ' +
      'against the Supabase CLI stack and not against plain postgres.',
    rollback:
      'Fully guarded: 71 DROP POLICY IF EXISTS ahead of 69 CREATE POLICY, three CREATE OR REPLACE ' +
      'FUNCTION, and ENABLE ROW LEVEL SECURITY which is a no-op when already on. Re-applying converges, ' +
      'which is exactly what makes A2 step 001 harmless.',
    expect: {
      securitySurfaceDigest: 'dc0692ed31f7154649619be7f836fc89cbe88594f50097721821b2211ddbf1ce',
      referencesAuthSchema: true,
      rlsEnabledTableCount: 24,
      policiesCreatedCount: 69,
      functionsCreatedCount: 3,
      securityDefinerCount: 3,
      // Not `''`. These three run with search_path = public, unlike the two
      // Supabase units which pin the empty path. Pinned so a future hardening of
      // one and not the other is visible here rather than discovered in an audit.
      searchPathSettings: ['public', 'public', 'public'],
    },
  },
  {
    ordinal: 33,
    id: '0032_rls_specialized.sql',
    kind: D,
    file: 'db/migrations/0032_rls_specialized.sql',
    sha256: '935037d43e3c196b4e17afbc46974059de493b130d285770f713ca46ec1d94b6',
    dependsOn: ['0031_rls_core.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'idempotent',
    managedNote: 'Same posture as 0031: consumes its SECURITY DEFINER helpers, adds no new privileged surface.',
    rollback: '32 DROP POLICY IF EXISTS ahead of 31 CREATE POLICY. Converges.',
    expect: {
      securitySurfaceDigest: 'a9210e9d594a53928b439db3bb1679b2fe003a67d321bcc617738032fb8d1c1c', referencesAuthSchema: true, rlsEnabledTableCount: 12, policiesCreatedCount: 31 },
  },
  {
    ordinal: 34,
    id: '0033_public_api_grants.sql',
    kind: D,
    file: 'db/migrations/0033_public_api_grants.sql',
    sha256: '73c03e579c1f2ce0b9a8db11911dbfff1ec26bc4b1509527f3ab24a935c8dfef',
    dependsOn: ['0032_rls_specialized.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'idempotent',
    // The one unit in the baseline that names service_role as a grantee, and the
    // instruction for this train is "NO uses service_role". That instruction
    // governs what this train DOES; it does not let the train pretend the
    // baseline does not contain this. So it is recorded, not hidden, and the
    // compensating control is named:
    //
    //   the GRANT is inert without a key. §4.4 of the provisioning requirements
    //   already forbids provisioning SUPABASE_SERVICE_ROLE_KEY at all, and
    //   stella_0017 later REVOKEs write on the ledger from every runtime
    //   principal including this one. A privilege nobody can authenticate as is
    //   a privilege nobody holds — but it is still a privilege, so the baseline
    //   postconditions assert the key's ABSENCE from the environment rather than
    //   treating the grant as harmless.
    managedNote:
      'Requires roles anon / authenticated / service_role to EXIST. Managed Supabase creates all three; ' +
      'a bare PostgreSQL has none of them and this unit would raise 42704. GRANTs ALL PRIVILEGES on ' +
      'every public table to service_role — recorded, not endorsed: see grantsToServiceRole below and ' +
      'the compensating control in the manifest comment.',
    rollback: 'Pure GRANT/REVOKE. Re-running produces the same ACL. Converges.',
    expect: { usesServiceRole: true, grantsToServiceRole: true, usesAnon: true, usesAuthenticated: true },
  },
  { ordinal: 35, id: '0034_phase3_white_label.sql', kind: D, file: 'db/migrations/0034_phase3_white_label.sql', sha256: '0483d3bc2ecc415bf10afec1094d4b57b60e97ef260036c8022b30382bde9696', dependsOn: ['0033_public_api_grants.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 36, id: '0035_phase5_marketing_leads.sql', kind: D, file: 'db/migrations/0035_phase5_marketing_leads.sql', sha256: 'c93e1c1f1a4ef4a0a98dc9f33f2c34bf7329d5bdc0e9436b7b9d642fd6743a53', dependsOn: ['0034_phase3_white_label.sql'], ...PLAIN_DDL,
    // CORRECTED by adversarial review A. The previous note said "no role has any
    // privilege on it until something grants one, and nothing in the baseline
    // does". That is FALSE, and the repository contains the proof: 0033 line 13
    // is `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO
    // postgres, service_role`, marketing_leads is created after it, and
    // db/baseline/stella_g2_schema.sql:11091 shows the grant materialized as
    // `GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.marketing_leads TO
    // service_role`. A default-privileges grant never names the table, so the
    // lexical search that produced the original claim could not have found it —
    // which is exactly why the claim needed a catalog probe behind it and not a
    // grep.
    managedNote:
      'Creates public.marketing_leads AFTER 0033. It therefore receives none of 0033\'s per-table ' +
      'grants, but it DOES receive 0033\'s ALTER DEFAULT PRIVILEGES grant: service_role holds ALL on ' +
      'it from creation. `anon` does not — 0033 revokes anon from the schema default — and that, not ' +
      'a blanket absence of grants, is what keeps policy 008\'s anon INSERT inert. Postcondition B0-10 ' +
      'probes the real ACL with aclexplode rather than information_schema, because the latter cannot ' +
      'express PUBLIC (db/audit/canonical_acl.sql bans it as a gate criterion for that reason).',
    expect: {} },
  { ordinal: 37, id: '0036_phase2_onboarding.sql', kind: D, file: 'db/migrations/0036_phase2_onboarding.sql', sha256: 'bed0320f7bf1466506d7a06ebc15bacabb200b2775f589337dbed14f1aa8d321', dependsOn: ['0035_phase5_marketing_leads.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 38, id: '0037_phase1_stripe.sql', kind: D, file: 'db/migrations/0037_phase1_stripe.sql', sha256: '2259d9fabe023889ced71ab77e9c62904d35de245c2711875c23aec4157d2858', dependsOn: ['0036_phase2_onboarding.sql'], ...PLAIN_DDL, expect: {} },
  { ordinal: 39, id: '0038_sprint_a_gdpr_users.sql', kind: D, file: 'db/migrations/0038_sprint_a_gdpr_users.sql', sha256: 'bec15a5a7a3e97237ab7dd6eed44a05cf9ec2eaddc60577b24377a41eb3a822c', dependsOn: ['0037_phase1_stripe.sql'], ...PLAIN_DDL, expect: {} },
  {
    ordinal: 40,
    id: '20260716000000_auth_trigger.sql',
    kind: S,
    file: 'supabase/migrations/20260716000000_auth_trigger.sql',
    sha256: '40079a37cb0027a8ed7112eab7c817945aa5a56196ce8aba7138c668eb6b5d07',
    dependsOn: ['0000_quick_husk.sql', '0002_huge_namorita.sql', '0038_sprint_a_gdpr_users.sql'],
    dml: 'none',
    managed: 'C-requires-adaptation',
    reapply: 'idempotent',
    // Class C, and the reason is a privilege this repository cannot verify offline.
    managedNote:
      'CREATE TRIGGER on auth.users. Schema auth is owned by supabase_auth_admin, and whether the ' +
      '`postgres` role of a 2026 managed project may still create triggers on auth.users is a fact ' +
      'about that project, not about this repository — the same class of unknown RR-09 is. It is ' +
      'therefore C: the hosted runner must PROBE the privilege before the phase and refuse rather than ' +
      'discover it mid-chain. Locally it succeeds, and that is not evidence. Its INSERT into ' +
      'public.users names is_super_admin, hence the dependency on 0002.',
    rollback:
      'CREATE OR REPLACE FUNCTION and DROP TRIGGER IF EXISTS before each CREATE TRIGGER: converges. ' +
      'Reversible by dropping the two triggers, which only stops profile sync — no data is lost.',
    expect: {
      securitySurfaceDigest: '475501a649b6adb66832efca150b3ad585ec458f344e4a2c19e44e88467ca009',
      usesAnon: true,
      usesAuthenticated: true,
      referencesAuthSchema: true,
      functionsCreatedCount: 2,
      securityDefinerCount: 2,
      searchPathSettings: ["''", "''"],
      triggersCreatedCount: 2,
    },
  },
  {
    ordinal: 41,
    id: '20260716000001_storage_policies.sql',
    kind: S,
    file: 'supabase/migrations/20260716000001_storage_policies.sql',
    sha256: '9be368785d709ca600324e0988b42e5e61bc4629ec9e9d8fe8ef52b7bb6b825c',
    dependsOn: ['0033_public_api_grants.sql', '20260716000000_auth_trigger.sql'],
    dml: 'none',
    // RECLASSIFIED B -> C by adversarial review A, and the argument is exact.
    // Unit 40 was C because it creates a trigger on auth.users, owned by
    // supabase_auth_admin. This unit creates POLICIES on storage.objects, owned
    // by supabase_storage_admin — and CREATE POLICY requires OWNERSHIP of the
    // table, which is a stricter requirement than the TRIGGER privilege unit 40
    // needs. Classifying the weaker dependency C and the stronger one B was
    // simply an oversight, and it mattered: unit 41 aborting means 40 committed
    // units and a reprovisioning.
    managed: 'C-requires-adaptation',
    reapply: 'idempotent',
    managedNote:
      'Creates the two storage helpers 0039 grants on, and four policies on storage.objects. Two ' +
      'platform-owned dependencies, both probed before PHASE_BASELINE (see PrivilegeProbes):\n' +
      ' 1. OWNERSHIP of storage.objects, which CREATE POLICY requires. The schema belongs to ' +
      '    supabase_storage_admin; whether this project\'s role holds it is a fact about the project.\n' +
      ' 2. The `uellix-evidence` bucket, which all three policies gate on and which NOTHING in the ' +
      '    fifty units creates. Locally `supabase/config.toml` declares it and the CLI creates it at ' +
      '    start — the same local/hosted asymmetry that hid the 0039 defect, in a second place.\n' +
      'The helper BODIES are guarded with to_regclass so they can be created before the tables they ' +
      'read; the POLICIES cannot.',
    rollback: 'DROP POLICY IF EXISTS before each CREATE POLICY, CREATE OR REPLACE for both functions. Converges.',
    expect: {
      securitySurfaceDigest: '86399f1580e580460cf95b53cc60b26746201b5d71179331ed08b428ecdd1804',
      usesAnon: true,
      usesAuthenticated: true,
      referencesAuthSchema: true,
      referencesStorageSchema: true,
      policiesCreatedCount: 3,
      functionsCreatedCount: 2,
      securityDefinerCount: 2,
      searchPathSettings: ["''", "''"],
    },
  },
  {
    ordinal: 42,
    id: '0039_grant_rls_helper_execution.sql',
    kind: D,
    file: 'db/migrations/0039_grant_rls_helper_execution.sql',
    sha256: '69e20347c387033fa17af952ff104371122cb7a12d0cd1007ddc79157dd320ab',
    // THE DEPENDENCY THAT WAS MISSING FROM THE CONTRACT.
    dependsOn: ['0031_rls_core.sql', '0033_public_api_grants.sql', '20260716000001_storage_policies.sql'],
    dml: 'none',
    managed: 'A-hosted-compatible',
    reapply: 'idempotent',
    managedNote:
      'Five GRANT EXECUTE. Three target helpers from 0031; TWO target functions that exist only in ' +
      '20260716000001_storage_policies.sql. Applying "0000…0039" without the Supabase units aborts here ' +
      'with 42883 undefined_function — this unit is the proof that A1 as originally written was not a ' +
      'runnable sequence.',
    rollback: 'Pure GRANT. Converges.',
    expect: { usesAuthenticated: true },
  },

  /* ---------------------------------------------------------------------- *
   * A2 — the policies. Seven of the eight repeat content the chain already   *
   * applied; the eighth is the only one that adds anything, and the only one *
   * that cannot be run twice.                                                *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 43,
    id: '001_initial_auth_rls.sql',
    kind: P,
    file: 'db/policies/001_initial_auth_rls.sql',
    sha256: 'e525b1eefa723bb38db5121a08b5cc416126f64c0563687ada6fcc2a7cc054ef',
    dependsOn: ['0031_rls_core.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'idempotent',
    equivalentTo: '0031_rls_core.sql',
    managedNote:
      'BYTE-IDENTICAL to 0031_rls_core.sql — same SHA-256. Applying A2 step 001 after A1 re-runs 765 ' +
      'lines already applied. Harmless because every statement is guarded, and a test proves the ' +
      'identity rather than trusting this note.',
    rollback: 'Identical to 0031.',
    expect: {
      securitySurfaceDigest: 'dc0692ed31f7154649619be7f836fc89cbe88594f50097721821b2211ddbf1ce',
      referencesAuthSchema: true,
      rlsEnabledTableCount: 24,
      policiesCreatedCount: 69,
      functionsCreatedCount: 3,
      securityDefinerCount: 3,
      searchPathSettings: ['public', 'public', 'public'],
    },
  },
  { ordinal: 44, id: '002_stella_interactions_rls.sql', kind: P, file: 'db/policies/002_stella_interactions_rls.sql', sha256: 'c21b00d58dc0fc42585625598cfb2ebe46667cc8934b173d0dd7a82af524603c', dependsOn: ['0032_rls_specialized.sql'], dml: 'none', managed: 'A-hosted-compatible', reapply: 'idempotent', equivalentTo: '0032_rls_specialized.sql',
    managedNote: 'Statement subset of 0032_rls_specialized.sql. Guarded; re-application converges.',
    rollback: 'Two DROP POLICY IF EXISTS ahead of one CREATE POLICY.',
    expect: {
      securitySurfaceDigest: '60a799e4f15564f0cbf31f384b569813a7b7849617c3b282a5484faa2b63515b', rlsEnabledTableCount: 1, policiesCreatedCount: 1 } },
  { ordinal: 45, id: '003_signup_allowlist_rls.sql', kind: P, file: 'db/policies/003_signup_allowlist_rls.sql', sha256: '258491c5a5dbc9e5b4fb7749d66bb62a5693fdb5d49a58c504de22dc0f066bf0', dependsOn: ['0032_rls_specialized.sql'], dml: 'none', managed: 'A-hosted-compatible', reapply: 'idempotent', equivalentTo: '0032_rls_specialized.sql',
    managedNote: 'Statement subset of 0032_rls_specialized.sql.',
    rollback: 'Three guarded creates.',
    expect: {
      securitySurfaceDigest: '1bf7cb6acd8232e91a7031b0cc0a0eec5e5d3b04de6d05461df0064679216fa1', rlsEnabledTableCount: 1, policiesCreatedCount: 3 } },
  { ordinal: 46, id: '004_fx_tables_rls.sql', kind: P, file: 'db/policies/004_fx_tables_rls.sql', sha256: '9c03c719b4e6cf2e6989592d144881b28d3cc1e82ce76acffffb1e39f2de4130', dependsOn: ['0032_rls_specialized.sql'], dml: 'none', managed: 'B-hosted-compatible-given-supabase', reapply: 'idempotent', equivalentTo: '0032_rls_specialized.sql',
    managedNote: 'Statement subset of 0032_rls_specialized.sql. Names auth.uid() in a predicate.',
    rollback: 'Nine guarded creates.',
    expect: {
      securitySurfaceDigest: 'e5cb3eea69624805f5b0177a7317e70e47890b093f80a4b689abd0f55b488a6b', referencesAuthSchema: true, rlsEnabledTableCount: 3, policiesCreatedCount: 9 } },
  { ordinal: 47, id: '005_theory_of_change_rls.sql', kind: P, file: 'db/policies/005_theory_of_change_rls.sql', sha256: '703aa74bf1b579c237391af9520ee649605ab6953dcac739ab2bd8636cf04b30', dependsOn: ['0032_rls_specialized.sql'], dml: 'none', managed: 'A-hosted-compatible', reapply: 'idempotent', equivalentTo: '0032_rls_specialized.sql',
    managedNote: 'Statement subset of 0032_rls_specialized.sql.',
    rollback: 'Six guarded creates.',
    expect: {
      securitySurfaceDigest: '4e176456fc80183db545adb02c7b1677d6b8188cf89ad089de06b7daf88c9ae6', rlsEnabledTableCount: 2, policiesCreatedCount: 6 } },
  { ordinal: 48, id: '006_methodology_review_rls.sql', kind: P, file: 'db/policies/006_methodology_review_rls.sql', sha256: '0528affc777557fb827611edddd5e6581020ef0fd80e97b38f50ddd4f6b5bd05', dependsOn: ['0032_rls_specialized.sql'], dml: 'none', managed: 'A-hosted-compatible', reapply: 'idempotent', equivalentTo: '0032_rls_specialized.sql',
    managedNote: 'Statement subset of 0032_rls_specialized.sql.',
    rollback: 'Six guarded creates.',
    expect: {
      securitySurfaceDigest: '1ca448cb3db87b1464741d1ec5829b4df2dd8d9a5b7165f38d48b67b1bd0ee3e', rlsEnabledTableCount: 2, policiesCreatedCount: 6 } },
  { ordinal: 49, id: '007_taxonomy_rls.sql', kind: P, file: 'db/policies/007_taxonomy_rls.sql', sha256: '3a33a1bf60520363402a696211faff3f5e755b2326a457f438ac9171b409b34d', dependsOn: ['0032_rls_specialized.sql'], dml: 'none', managed: 'A-hosted-compatible', reapply: 'idempotent', equivalentTo: '0032_rls_specialized.sql',
    managedNote: 'Statement subset of 0032_rls_specialized.sql.',
    rollback: 'Six guarded creates.',
    expect: {
      securitySurfaceDigest: '2d1cd88121ade1690b4570d29e537738425b9f9664014dcc6855d6477ce3aae2', rlsEnabledTableCount: 3, policiesCreatedCount: 6 } },
  {
    ordinal: 50,
    id: '008_marketing_leads_rls.sql',
    kind: P,
    file: 'db/policies/008_marketing_leads_rls.sql',
    sha256: '33f6032ef6fb1203f32d7d072ed47b94a58394fe3ea41e3bb2f885b8603085c7',
    dependsOn: ['0031_rls_core.sql', '0035_phase5_marketing_leads.sql'],
    dml: 'none',
    managed: 'A-hosted-compatible',
    // THE ONLY NON-IDEMPOTENT UNIT IN THE BASELINE.
    reapply: 'refuses-on-reapply',
    managedNote:
      'The ONLY policy file whose content the migration chain never applies, and the only one whose ' +
      'three CREATE POLICY statements have no preceding DROP POLICY IF EXISTS. A second application ' +
      'raises 42710 duplicate_object. The runner must probe and skip, never retry.\n' +
      '\n' +
      'On its anon INSERT policy: it is a permission WIDENING on paper — TO anon WITH CHECK (true) — ' +
      'and it is inert in practice, because RLS is the SECOND gate and anon holds no table privilege ' +
      'to get past the first. The precise reason matters and an earlier draft got it wrong: it is not ' +
      'that marketing_leads has no grants at all — 0033\'s ALTER DEFAULT PRIVILEGES gives service_role ' +
      'ALL on it from creation — it is that 0033 REVOKEs anon from the schema default, so anon ' +
      'specifically receives nothing. Postcondition B0-10 probes that with aclexplode over the real ' +
      'ACL, covering PUBLIC as well as anon, so a future grant that made the policy live fails a check ' +
      'instead of quietly opening an unauthenticated public write path on staging.',
    rollback:
      'DROP POLICY the three by name. There is nothing to preserve — the table is empty on a new ' +
      'staging project and the policies carry no data.',
    expect: {
      securitySurfaceDigest: '59b9954bb8b382634bdcb786bd9eb1cf7270427bfa683ae8656577af82237c92',
      usesAnon: true,
      usesAuthenticated: true,
      rlsEnabledTableCount: 1,
      policiesCreatedCount: 3,
      unguardedPolicyCreateCount: 3,
    },
  },
]

/** The order, derived so the two cannot disagree. */
export const BASELINE_ORDER: readonly string[] = BASELINE_UNITS.map((u) => u.id)

/**
 * A digest over the manifest's identity: ordinal, id and hash of every unit.
 *
 * Exists so a recorded rehearsal can say WHICH manifest it exercised. A
 * rehearsal result from before a manifest edit is not evidence about the
 * manifest after it, and without a freshness check the artefact would age into a
 * rubber stamp — which is the failure mode adversarial review B found in the
 * gate that consumed it.
 */
export function baselineManifestDigest(): string {
  return sha256OfSql(BASELINE_UNITS.map((u) => `${u.ordinal}:${u.id}:${u.sha256}`).join('\n'))
}

/** Where a completed local rehearsal records itself, repo-relative. */
export const REHEARSAL_ARTEFACT = 'artifacts/baseline-rehearsal/latest.json'

/** Units that must never be applied twice, by id. Consumed by the runner. */
export const BASELINE_NON_REAPPLYABLE: readonly string[] = BASELINE_UNITS.filter(
  (u) => u.reapply !== 'idempotent',
).map((u) => u.id)

/** Looks up one unit, or throws. A typo must never silently skip a unit. */
export function baselineUnit(id: string): BaselineUnit {
  const found = BASELINE_UNITS.find((u) => u.id === id)
  if (!found) {
    throw new Error(
      `BASELINE_MANIFEST_UNKNOWN_UNIT: ${id} is not part of the Uellix baseline. ` +
        `The baseline has ${BASELINE_UNITS.length} units; see db/hosted/baseline-manifest.ts.`,
    )
  }
  return found
}

export type BaselineVerificationProblem = {
  readonly unit: string
  readonly kind:
    | 'MISSING_FILE'
    | 'SHA_MISMATCH'
    | 'SCAN_MISMATCH'
    | 'GLOBAL_INVARIANT_VIOLATED'
    | 'ORDER_BROKEN'
    | 'DUPLICATE_UNIT'
    | 'EQUIVALENCE_BROKEN'
    | 'UNKNOWN_FILE'
  readonly detail: string
}

/**
 * The A2 duplication, checked AT PLAN TIME rather than only in a unit test.
 *
 * ---------------------------------------------------------------------------
 * THE ATTACK THIS CLOSES
 * ---------------------------------------------------------------------------
 * Adversarial review B: fix a real RLS bug in `db/migrations/0031_rls_core.sql`
 * and update that unit's `sha256` pin. Nothing else changes.
 * `db/policies/001_initial_auth_rls.sql` is untouched, so ITS pin still matches
 * ITS file and no SHA_MISMATCH fires. `verifyBaselineManifest` reports zero
 * problems — and it is the function `planBaselinePhase` calls to gate a hosted
 * apply. Then the plan runs 001 at ordinal 43, AFTER 0031 at ordinal 32, and its
 * stale `DROP POLICY IF EXISTS … CREATE POLICY …` reverts the fix on the way
 * past.
 *
 * The equality was asserted only in a Vitest file the provisioning gate never
 * consults. A test that is not run before an apply is a comment.
 *
 * ---------------------------------------------------------------------------
 * WHY EQUIVALENCE AND NOT DEDUPLICATION
 * ---------------------------------------------------------------------------
 * Deleting `db/policies/001…007` would be the better answer and is not this
 * train's to make: those files are the checked-in A2 contract, other processes
 * may reference them, and removing production SQL on the strength of a
 * statement-set comparison is a bigger change than the defect warrants. So the
 * duplication stays and is POLICED — but at the layer that gates the write.
 */
function verifyEquivalences(
  read: (file: string) => string | null,
  scan: (sql: string) => BaselineScanFacts,
): BaselineVerificationProblem[] {
  const problems: BaselineVerificationProblem[] = []

  for (const unit of BASELINE_UNITS) {
    if (!unit.equivalentTo) continue

    let source: BaselineUnit
    try {
      source = baselineUnit(unit.equivalentTo)
    } catch {
      problems.push({
        unit: unit.id,
        kind: 'EQUIVALENCE_BROKEN',
        detail: `declares equivalentTo ${unit.equivalentTo}, which is not a unit of this manifest.`,
      })
      continue
    }

    if (source.ordinal > unit.ordinal) {
      problems.push({
        unit: unit.id,
        kind: 'EQUIVALENCE_BROKEN',
        detail: `runs at ordinal ${unit.ordinal}, BEFORE its equivalent ${source.id} at ${source.ordinal}. The later copy is the one that wins, so the order decides which version of the SQL the database ends up with.`,
      })
    }

    const own = read(unit.file)
    const other = read(source.file)
    if (own === null || other === null) continue // MISSING_FILE already reported.

    // Byte-identical pair (001 <-> 0031): the strongest available check.
    if (unit.sha256 === source.sha256) {
      const a = sha256OfSql(own)
      const b = sha256OfSql(other)
      if (a !== b) {
        problems.push({
          unit: unit.id,
          kind: 'EQUIVALENCE_BROKEN',
          detail:
            `${unit.id} and ${source.id} were byte-identical and are no longer: ` +
            `${a.slice(0, 12)}… vs ${b.slice(0, 12)}…. Editing one and not the other means the copy that ` +
            `runs LAST silently overwrites the other's version — and ${unit.id} runs last.`,
        })
      }
      continue
    }

    // Subset pair (002..007 <-> 0032): every statement of the policy file must
    // still appear in its source migration. Compared as statement SETS, because
    // a policy file is a slice of a larger migration and identical bytes were
    // never the claim.
    const ownStatements = new Set(normalizedStatements(own))
    const otherStatements = new Set(normalizedStatements(other))
    const drifted = [...ownStatements].filter((s) => !otherStatements.has(s))
    if (drifted.length > 0) {
      problems.push({
        unit: unit.id,
        kind: 'EQUIVALENCE_BROKEN',
        detail:
          `${drifted.length} statement(s) of ${unit.id} no longer appear in ${source.id}. First: ` +
          `${drifted[0].slice(0, 120)}. The two copies have diverged, and ${unit.id} runs later.`,
      })
    }

    // And the access-control substance, which is what the counts miss.
    const ownSurface = scan(own).securitySurfaceDigest
    const otherFacts = scan(other)
    if (unit.sha256 === source.sha256 && ownSurface !== otherFacts.securitySurfaceDigest) {
      problems.push({
        unit: unit.id,
        kind: 'EQUIVALENCE_BROKEN',
        detail: `${unit.id} and ${source.id} no longer share a security surface digest.`,
      })
    }
  }

  return problems
}

/** Comments stripped, whitespace collapsed. Shared by the equivalence check. */
function normalizedStatements(sql: string): string[] {
  return splitSqlStatements(stripSqlComments(sql.replace(/\r\n?/g, '\n')))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Order, duplication and dependency direction — over an INJECTED unit list.
 *
 * Takes the units as an argument rather than reading the module constant so the
 * attack matrix can actually reorder the chain and watch this refuse. A check
 * that can only ever be handed the correct input is a check that has never been
 * observed to fail, which is not the same as one that works.
 */
export function verifyBaselineOrder(
  units: readonly BaselineUnit[],
): readonly BaselineVerificationProblem[] {
  const problems: BaselineVerificationProblem[] = []
  const seen = new Set<string>()
  const filesSeen = new Map<string, string>()

  units.forEach((unit, index) => {
    if (unit.ordinal !== index + 1) {
      problems.push({
        unit: unit.id,
        kind: 'ORDER_BROKEN',
        detail: `ordinal ${unit.ordinal} at array position ${index + 1}. Ordinals are the order; a gap means a unit was removed without renumbering, and a repeat means one was inserted without it.`,
      })
    }

    if (seen.has(unit.id)) {
      problems.push({
        unit: unit.id,
        kind: 'DUPLICATE_UNIT',
        detail: `appears more than once. A duplicated unit is applied twice, and 28 of the 40 Drizzle units raise on a second application.`,
      })
    }

    const previousId = filesSeen.get(unit.file)
    if (previousId !== undefined && previousId !== unit.id) {
      problems.push({
        unit: unit.id,
        kind: 'DUPLICATE_UNIT',
        detail: `points at ${unit.file}, which ${previousId} already claims. One file, one unit.`,
      })
    }
    filesSeen.set(unit.file, unit.id)

    for (const dependency of unit.dependsOn) {
      if (!seen.has(dependency)) {
        problems.push({
          unit: unit.id,
          kind: 'ORDER_BROKEN',
          detail: `depends on ${dependency}, which does not appear earlier in the order. A dependency listed later is not a slow dependency, it is a chain that cannot run — this is what catches "policy before its table" and "0039 before the Supabase units".`,
        })
      }
    }
    seen.add(unit.id)
  })

  return problems
}

/**
 * Verifies the manifest against the files, given a reader.
 *
 * Takes a reader rather than touching the filesystem so the attack matrix can
 * feed it a mutated corpus — a changed hash, a dropped unit, a reordered chain —
 * without writing to the repository to do it.
 */
export function verifyBaselineManifest(
  read: (file: string) => string | null,
  scan: (sql: string) => BaselineScanFacts,
  /** Every SQL file the three directories actually contain. Detects orphans. */
  discovered?: readonly string[],
): readonly BaselineVerificationProblem[] {
  const problems: BaselineVerificationProblem[] = [
    ...verifyBaselineOrder(BASELINE_UNITS),
    ...verifyEquivalences(read, scan),
  ]

  for (const unit of BASELINE_UNITS) {
    const sql = read(unit.file)
    if (sql === null) {
      problems.push({ unit: unit.id, kind: 'MISSING_FILE', detail: `${unit.file} could not be read.` })
      continue
    }

    const actualSha = sha256OfSql(sql)
    if (actualSha !== unit.sha256) {
      problems.push({
        unit: unit.id,
        kind: 'SHA_MISMATCH',
        detail: `pinned ${unit.sha256.slice(0, 12)}…, file is ${actualSha.slice(0, 12)}…. If the edit is intended, update the pin AND re-derive the expected scan in the same commit.`,
      })
      // Deliberately NOT `continue`: a changed file should report BOTH what moved
      // and what that movement did to the semantics. Reporting only the hash
      // would let a reviewer fix the pin and never learn the file gained a grant.
    }

    const facts = scan(sql)

    for (const [key, allowed] of Object.entries(BASELINE_GLOBAL_INVARIANTS)) {
      const actual = (facts as unknown as Record<string, readonly unknown[]>)[key]
      if (actual.length !== allowed) {
        problems.push({
          unit: unit.id,
          kind: 'GLOBAL_INVARIANT_VIOLATED',
          detail: `${key}: expected ${allowed}, found ${actual.length} — ${JSON.stringify(actual).slice(0, 200)}. No baseline unit may introduce this; there is no per-unit opt-out.`,
        })
      }
    }

    const expected: Required<BaselineExpectedScan> = {
      usesServiceRole: false,
      grantsToServiceRole: false,
      usesAnon: false,
      usesAuthenticated: false,
      referencesAuthSchema: false,
      referencesStorageSchema: false,
      rlsEnabledTableCount: 0,
      policiesCreatedCount: 0,
      functionsCreatedCount: 0,
      securityDefinerCount: 0,
      searchPathSettings: [],
      triggersCreatedCount: 0,
      dmlStatementCount: 0,
      literalRowSourceCount: 0,
      unguardedPolicyCreateCount: 0,
      securitySurfaceDigest: EMPTY_SECURITY_SURFACE_DIGEST,
      ...unit.expect,
    }

    const actual: Required<BaselineExpectedScan> = {
      usesServiceRole: facts.usesServiceRole,
      grantsToServiceRole: facts.grantsToServiceRole,
      usesAnon: facts.usesAnon,
      usesAuthenticated: facts.usesAuthenticated,
      referencesAuthSchema: facts.referencesAuthSchema,
      referencesStorageSchema: facts.referencesStorageSchema,
      rlsEnabledTableCount: facts.rlsEnabledTables.length,
      policiesCreatedCount: facts.policiesCreated.length,
      functionsCreatedCount: facts.functionsCreated.length,
      securityDefinerCount: facts.securityDefinerFunctions.length,
      searchPathSettings: facts.searchPathSettings,
      triggersCreatedCount: facts.triggersCreated.length,
      dmlStatementCount: facts.dmlStatements.length,
      literalRowSourceCount: facts.literalRowSources.length,
      unguardedPolicyCreateCount: facts.unguardedPolicyCreates.length,
      securitySurfaceDigest: facts.securitySurfaceDigest,
    }

    for (const key of Object.keys(expected) as (keyof BaselineExpectedScan)[]) {
      const want = expected[key]
      const got = actual[key]
      const same = Array.isArray(want) ? JSON.stringify(want) === JSON.stringify(got) : want === got
      if (!same) {
        problems.push({
          unit: unit.id,
          kind: 'SCAN_MISMATCH',
          detail: `${key}: manifest expects ${JSON.stringify(want)}, file yields ${JSON.stringify(got)}.`,
        })
      }
    }

    // The one derived claim the manifest makes that a scan cannot check: that a
    // unit marked non-idempotent really is. Asserted from the scan so the label
    // and the SQL cannot drift apart.
    const looksReapplyable = facts.unguardedPolicyCreates.length === 0
    if (unit.reapply === 'refuses-on-reapply' && looksReapplyable && unit.kind === 'policy') {
      problems.push({
        unit: unit.id,
        kind: 'SCAN_MISMATCH',
        detail:
          'marked refuses-on-reapply, but every CREATE POLICY is now guarded by a DROP IF EXISTS. ' +
          'If it was made idempotent, say so here — a stale refusal makes the runner skip a unit it could apply.',
      })
    }
  }

  if (discovered) {
    const known = new Set(BASELINE_UNITS.map((u) => u.file))
    for (const file of discovered) {
      if (!known.has(file)) {
        problems.push({
          unit: file,
          kind: 'UNKNOWN_FILE',
          detail:
            `${file} exists on disk but no manifest unit claims it. An unclaimed migration is a ` +
            `migration nobody applies hosted and everybody applies locally — the exact asymmetry that ` +
            `hid the 0039 ordering defect.`,
        })
      }
    }
  }

  return problems
}

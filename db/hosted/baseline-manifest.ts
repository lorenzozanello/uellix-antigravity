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

  /* ---------------------------------------------------------------------- *
   * WAVE 1 — the five sealed FIB implementation units (FIBIU-01, FIBIU-28,   *
   * FIBIU-03, FIBIU-02; FIBIU-29 adds no SQL). Appended after the original   *
   * 50-unit baseline rather than interleaved into it, so no existing        *
   * ordinal changes meaning. The seven new files are later files in the     *
   * same forward-only Drizzle chain (0040…0046 come after 0039 at ordinal   *
   * 42), and the one new A2 policy runs last because A2 is documented above *
   * as the step that runs after all of A1 completes.                        *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 51,
    id: '0040_governed_model_registry.sql',
    kind: D,
    file: 'db/migrations/0040_governed_model_registry.sql',
    sha256: '269a354c4cc487eb506b88313e7077f265530fb1464fc3e93e2e0f221430c48f',
    dependsOn: ['0039_grant_rls_helper_execution.sql'],
    dml: 'global-catalog',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'destructive-on-reapply',
    managedNote:
      'FIBIU-01 stage A (FIBC-003/FIBDB-002, FIBC-004/FIBDB-003/FIBDB-042). CREATE TABLE ' +
      'governed_model_registry, GRANT SELECT to authenticated (requires that role to exist, hence B not ' +
      'A), and an idempotent ON CONFLICT DO NOTHING seed of 8 literal universal-reference rows (governed ' +
      'model/engine/methodology identities — not tenant data). Also adds projects.governance_regime ' +
      '(nullable, stage A) with a CHECK constraint.',
    rollback:
      'Applied with psql -1; a mid-unit failure rolls back whole. The seed INSERT is idempotent ' +
      '(ON CONFLICT DO NOTHING) but the CREATE TABLE and ADD CONSTRAINT are not — no reverse script, ' +
      'forward-only chain, recovered by DESTROY_AND_REPROVISION like the rest of A1.',
    expect: { usesAuthenticated: true, dmlStatementCount: 1, literalRowSourceCount: 1 },
  },
  {
    ordinal: 52,
    id: '0041_pc01b_regime_boundary_backfill.sql',
    kind: D,
    file: 'db/migrations/0041_pc01b_regime_boundary_backfill.sql',
    sha256: '941e960859fdebcd5922fc06f69d5ec400b78b0d4e5e4448fa4de29190cae1c5',
    dependsOn: ['0040_governed_model_registry.sql'],
    dml: 'structural-backfill',
    managed: 'A-hosted-compatible',
    reapply: 'idempotent',
    managedNote:
      "FIBIU-01 stage B (FIBDB-003/FIBC-004). UPDATE projects SET governance_regime = 'pre_pc01b' WHERE " +
      'governance_regime IS NULL — the row set is derived from existing content, so on an empty database ' +
      'it affects zero rows, the same class as unit 19 (0018_redundant_firebird.sql).',
    rollback: 'A single UPDATE guarded by WHERE … IS NULL; re-running converges on zero affected rows.',
    expect: { dmlStatementCount: 1 },
  },
  {
    ordinal: 53,
    id: '0042_fib_audit_insert_policy.sql',
    kind: D,
    file: 'db/migrations/0042_fib_audit_insert_policy.sql',
    sha256: '5812a4ee760c7a68c4f0e0828cd37050efd728166eb950c58839e07bf911a9f5',
    dependsOn: ['0031_rls_core.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'idempotent',
    managedNote:
      'FIBIU-28 stage A (FIBC-029/FIBC-040/FIBDB-035). DROP POLICY IF EXISTS / CREATE POLICY on ' +
      'audit_logs, following the 0031_rls_core.sql pattern and reusing its current_user_org_ids() / ' +
      'current_user_is_super_admin() SECURITY DEFINER helpers plus auth.uid(). MEASURED STATE ' +
      'CORRECTION: supersedes the policy clause already applied in G2 by db/prepared/stella_0005c — see ' +
      'db/prepared/README.md and db/prepared-package-order.ts for the full disposition record.',
    rollback: 'One guarded DROP POLICY IF EXISTS ahead of one CREATE POLICY. Converges.',
    expect: {
      referencesAuthSchema: true,
      policiesCreatedCount: 1,
      securitySurfaceDigest: '610f7a42d7d76840b572e356839460da7dc73dfdfe62056a9a823cb6811eb46b',
    },
  },
  {
    ordinal: 54,
    id: '0043_fib_audit_project_id_fk.sql',
    kind: D,
    file: 'db/migrations/0043_fib_audit_project_id_fk.sql',
    sha256: '6c063adbf293b60fda8c143b44ff2386975c37a8273e1dbc59da75beacf06907',
    // Stage B after stage A of the same FIBIU-28 unit.
    dependsOn: ['0042_fib_audit_insert_policy.sql'],
    ...PLAIN_DDL,
    managedNote:
      'FIBIU-28 stage B (FIBC-040/FIBDB-036). ALTER TABLE audit_logs ADD CONSTRAINT … FOREIGN KEY ' +
      '(project_id) REFERENCES projects(id) NOT VALID — validate-then-add; VALIDATE CONSTRAINT against ' +
      'historical rows is stage-E hardening, deferred to a later unit. Pure DDL on schema public.',
    expect: {},
  },
  {
    ordinal: 55,
    id: '0044_fib_audit_hardening_supersession.sql',
    kind: D,
    file: 'db/migrations/0044_fib_audit_hardening_supersession.sql',
    // Re-pinned for HPO-ODS-W2-03 (the to_regclass guard around the sixth pair).
    sha256: 'bf9023f06f697422ba50a70c1482ab159e1989b910dd3d0ddf9d18671fe80510',
    // Stage E after stage B of the same FIBIU-28 unit, plus the function it reuses.
    dependsOn: ['0030_immutability.sql', '0043_fib_audit_project_id_fk.sql'],
    dml: 'none',
    managed: 'A-hosted-compatible',
    reapply: 'idempotent',
    managedNote:
      'FIBIU-28 stage E (FIBC-029/FIBC-040/FIBDB-034). STAGE=E, EXECUTED=NO: baseline-managed does not ' +
      'mean applied. Six DROP TRIGGER IF EXISTS / CREATE TRIGGER pairs reusing ' +
      'public.uellix_forbid_mutation() from 0030_immutability.sql unchanged — no new function, no ' +
      'privileged surface. MEASURED STATE CORRECTION: supersedes trigger objects already applied in G2 ' +
      'by the retired prepared units stella_0002 / stella_0002b (and, for one trigger, stella_0003, ' +
      'which itself remains NO_COLLISION and untouched). HPO-ODS-W2-03: the stella_suggestion_decisions ' +
      'pair is guarded on to_regclass — that table is gate-managed (stella_0003) and absent from a ' +
      'baseline target, where even DROP TRIGGER IF EXISTS raised 42P01. Five pairs are unconditional ' +
      'statements the scanner counts; the sixth lives inside a DO block and is installed only when the ' +
      'relation exists. The migration never creates the table.',
    rollback: 'Six DROP TRIGGER IF EXISTS ahead of six CREATE TRIGGER (the sixth pair conditional on its relation). Converges; dropping is safe.',
    expect: { triggersCreatedCount: 5 },
  },
  {
    ordinal: 56,
    id: '0045_fib_domain_object_version_lineage.sql',
    kind: D,
    file: 'db/migrations/0045_fib_domain_object_version_lineage.sql',
    sha256: 'a29aa402ff58eee4b885bb563e938138564a0412cb6b723f727fb441921f6c06',
    dependsOn: ['0030_immutability.sql', '0031_rls_core.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'destructive-on-reapply',
    managedNote:
      'FIBIU-03 stage A/B (FIBC-002/FIBC-045/FIBDB-004), plus the indicators/stakeholder_groups archive ' +
      'columns their exit gate requires. CREATE TABLE domain_object_versions (self-referencing FK, hand- ' +
      'added), an append-only trigger reusing uellix_forbid_mutation() (0030), and RLS mirroring ' +
      'audit_logs (org-scoped SELECT via current_user_org_ids()/current_user_is_super_admin() from 0031, ' +
      'actor+org-scoped INSERT, no UPDATE/DELETE policy — denied by omission).',
    rollback:
      "The CREATE TABLE / ADD COLUMN / ADD CONSTRAINT / CREATE INDEX statements have no IF NOT EXISTS " +
      "guard; the trailing trigger and two policies are guarded but do not change the unit's overall " +
      'class. No reverse script — forward-only, recovered by DESTROY_AND_REPROVISION.',
    expect: {
      referencesAuthSchema: true,
      rlsEnabledTableCount: 1,
      policiesCreatedCount: 2,
      triggersCreatedCount: 1,
      securitySurfaceDigest: '82244ec10e01ea1a696d3b9577be53e83c98300fa6a57c4d6c12f24f607c2141',
    },
  },
  {
    ordinal: 57,
    id: '0046_fib_run_version_identity.sql',
    kind: D,
    file: 'db/migrations/0046_fib_run_version_identity.sql',
    sha256: 'c9b177a99be45abda9369a04e3052a9c5159a5a1c35892a3450ebfb1abcc9b03',
    dependsOn: ['0009_motionless_peter_parker.sql'],
    ...PLAIN_DDL,
    managedNote:
      'FIBIU-02 stage A (FIBC-001/FIBDB-001). Adds three nullable columns to sroi_calculation_runs ' +
      '(methodology_version, calculation_engine_version, build_identity) — no CHECK constraint; the ' +
      'fail-closed guarantee is enforced in the service layer (lib/pipeline/run-version-identity.ts), ' +
      'not the schema. Write-once via the existing 0030_immutability.sql trigger on this table.',
    expect: {},
  },

  /* ---------------------------------------------------------------------- *
   * The one new A2 unit Wave 1 adds. Unlike 001…007 it duplicates no        *
   * existing Drizzle migration — equivalentTo does not apply — and unlike   *
   * 008 its CREATE POLICY is guarded, so it is idempotent.                  *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 58,
    id: '009_governed_model_registry_rls.sql',
    kind: P,
    file: 'db/policies/009_governed_model_registry_rls.sql',
    sha256: '0b63ac513205f3ac1020fc7e0d0869f277a4597a126656e9dd12d1b424260a4b',
    dependsOn: ['0040_governed_model_registry.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'idempotent',
    managedNote:
      'RLS for governed_model_registry (FIBIU-01/FIBDB-002): read for any authenticated user via ' +
      'auth.uid() IS NOT NULL — a global, org-agnostic registry with no organization_id to scope by. No ' +
      'INSERT/UPDATE/DELETE policy; writes are structurally immutable outside the seed path in unit 51.',
    rollback:
      'One guarded DROP POLICY IF EXISTS ahead of one CREATE POLICY; ENABLE ROW LEVEL SECURITY is a ' +
      'no-op when already on. Converges.',
    expect: {
      referencesAuthSchema: true,
      rlsEnabledTableCount: 1,
      policiesCreatedCount: 1,
      securitySurfaceDigest: '14910e3f962c7a93766ec4a1e8fbe82dc4aa6bf32730fbbcc9bb70f937dca85d',
    },
  },

  /* ---------------------------------------------------------------------- *
   * W1-05-RM1 R-6/G-1 (HPO-DEC-1) — FIBIU-01's regime boundary extended to  *
   * outcome_taxonomy_mappings, authorized by the RM2 addendum. Appended     *
   * after the Wave-1 corpus above rather than interleaved, for the same     *
   * reason unit 51 was appended after the original 50-unit baseline.        *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 59,
    id: '0047_fib_taxonomy_mapping_governance_regime.sql',
    kind: D,
    file: 'db/migrations/0047_fib_taxonomy_mapping_governance_regime.sql',
    sha256: '39c8346666378a8899330124939a0178786a799cfe6d73adf006d549a1ad6d67',
    dependsOn: ['0026_violet_selene.sql'],
    dml: 'structural-backfill',
    managed: 'A-hosted-compatible',
    reapply: 'idempotent',
    managedNote:
      'FIBIU-01 regime boundary extended (FIBC-004/FIBDB-003/FIBDB-042/FIBDB-054), stage A/B. Adds ' +
      'governance_regime (nullable, CHECK) to outcome_taxonomy_mappings, then UPDATE … SET ' +
      '\'pre_pc01b\' WHERE governance_regime IS NULL — derived from existing content, so on an empty ' +
      'database the backfill affects zero rows, the same class as unit 19 (0018) and unit 52 (0041).',
    rollback:
      'The ADD COLUMN/ADD CONSTRAINT have no reverse script — forward-only, recovered by ' +
      'DESTROY_AND_REPROVISION. The UPDATE re-runs to zero affected rows.',
    expect: { dmlStatementCount: 1 },
  },

  /* ---------------------------------------------------------------------- *
   * W2-B1 (Wave 2, Batch 1 — Evidence). FIBIU-04/05/06/07. Appended after   *
   * the Wave-1 corpus + unit 59, same convention unit 59 itself followed.   *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 60,
    id: '0048_fib_evidence_versions.sql',
    kind: D,
    file: 'db/migrations/0048_fib_evidence_versions.sql',
    sha256: 'dc3c978b48338dc8e76886882a2a97405068aba8183c0019716385b8cffe9dac',
    dependsOn: ['0030_immutability.sql', '0031_rls_core.sql'],
    dml: 'structural-backfill',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'destructive-on-reapply',
    managedNote:
      'FIBIU-04 stage A/B (FIBC-005/FIBC-006/FIBDB-005/FIBDB-037). CREATE TABLE evidence_versions ' +
      '(self-referencing supersedes_version_id FK, hand-added, same gap 0045 hand-filled), a NOT VALID ' +
      'SHA-256 format CHECK on the pre-existing evidence_items.content_hash, a stage-B backfill (one v1 ' +
      'shell row per existing evidence_items row, content NULL, legacy_content_unverifiable true only ' +
      'for type=text), and RLS mirroring evidence_items (0031_rls_core.sql): org-scoped SELECT, INSERT/ ' +
      'UPDATE restricted to the same role floor, no DELETE policy.',
    rollback:
      'The CREATE TABLE / ADD CONSTRAINT / CREATE INDEX statements have no IF NOT EXISTS guard; the ' +
      'trailing INSERT backfill and two policies are guarded/idempotent but do not change the unit\'s ' +
      'overall class. No reverse script — forward-only, recovered by DESTROY_AND_REPROVISION.',
    expect: {
      referencesAuthSchema: false,
      rlsEnabledTableCount: 1,
      policiesCreatedCount: 3,
      dmlStatementCount: 1,
      securitySurfaceDigest: '446acc6cf990c9cf8f5fa82c2b64907ffd1749057d333ae006fd67bdc7dc6767',
    },
  },
  {
    ordinal: 61,
    id: '0049_fib_evidence_sensitivity_vocabulary.sql',
    kind: D,
    file: 'db/migrations/0049_fib_evidence_sensitivity_vocabulary.sql',
    sha256: '3fcec066bdca95b6428641ca4cb22b9057fcea8ccc890b3fc70ffbb366256af5',
    dependsOn: ['0048_fib_evidence_versions.sql'],
    ...PLAIN_DDL,
    managedNote:
      'FIBIU-05 stage A (FIBC-007), FIBDB-043\'s evidence_versions slice only (FIBIU-07 owns the ' +
      'erasure_state slice, unit 63). Three ADD CONSTRAINT statements on columns FIBIU-04 already ' +
      'created — sensitivity_classification vocabulary, treatment vocabulary, and the pairing rule ' +
      '(treatment required when classification is set and not non_sensitive). No new table, no RLS.',
    expect: {},
  },
  {
    ordinal: 62,
    id: '0050_fib_evidence_sufficiency_determinations.sql',
    kind: D,
    file: 'db/migrations/0050_fib_evidence_sufficiency_determinations.sql',
    sha256: '4ef9a6ac9e930691db62b36ce65c1f000d727b3f967f9329d3ef68de01817952',
    dependsOn: ['0030_immutability.sql', '0031_rls_core.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'destructive-on-reapply',
    managedNote:
      'FIBIU-06 stage A (FIBC-008/FIBDB-014). CREATE TABLE evidence_sufficiency_determinations — one ' +
      'append-only row per governed human determination over an outcome\'s evidence set, never per ' +
      'evidence item. RLS: org-scoped SELECT, INSERT restricted to impact_manager+ (actor_user_id = ' +
      'auth.uid(), matching FIBC-008\'s "impact_manager+ determines"), no UPDATE/DELETE policy.',
    rollback:
      'The CREATE TABLE / ADD CONSTRAINT / CREATE INDEX statements have no IF NOT EXISTS guard; the ' +
      'trailing two policies are guarded but do not change the unit\'s overall class. No reverse script ' +
      '— forward-only, recovered by DESTROY_AND_REPROVISION.',
    expect: {
      referencesAuthSchema: true,
      rlsEnabledTableCount: 1,
      policiesCreatedCount: 2,
      securitySurfaceDigest: '405f3dc246667d012a5c73f4de5c32109b86bf316307bc182a4f87b4bd9d96f6',
    },
  },
  {
    ordinal: 63,
    id: '0051_fib_evidence_erasure_substrate.sql',
    kind: D,
    file: 'db/migrations/0051_fib_evidence_erasure_substrate.sql',
    sha256: 'a2c73abf3a4aeae988df3315e4d274a23598da7513d47008ed9a99a999291eff',
    dependsOn: ['0030_immutability.sql', '0031_rls_core.sql', '0048_fib_evidence_versions.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'destructive-on-reapply',
    managedNote:
      'FIBIU-07 stage A ONLY (FIBC-009/FIBDB-031, plus the erasure_state slice of FIBDB-043 on ' +
      'evidence_versions). CREATE TABLE evidence_tombstones (append-only terminal-outcome record) and ' +
      'the erasure_state vocabulary CHECK. STAGE RULE: FIBDB-032 (revoke evidence_items DELETE from ' +
      'authenticated) and FIBDB-033 (explicit DELETE-rejection trigger) are stage-E hardening that must ' +
      'ship together per FIB §4 — deliberately NOT executed here; today\'s ambiguous DELETE path ' +
      '(0033:35 grant / 0031:418-419 absent policy) is unchanged. RLS: org-scoped SELECT, INSERT ' +
      'restricted to organization_admin+ (FIBC-009: "canEraseEvidenceContent, organization_admin+"), no ' +
      'UPDATE/DELETE policy.',
    rollback:
      'The CREATE TABLE / ADD CONSTRAINT / CREATE INDEX statements have no IF NOT EXISTS guard; the ' +
      'trailing two policies are guarded but do not change the unit\'s overall class. No reverse script ' +
      '— forward-only, recovered by DESTROY_AND_REPROVISION.',
    expect: {
      referencesAuthSchema: true,
      rlsEnabledTableCount: 1,
      policiesCreatedCount: 2,
      securitySurfaceDigest: '848b68d6467753f23b25e5601c49c1a62480f24c6053d81fef14320478e10515',
    },
  },

  /* ---------------------------------------------------------------------- *
   * W2-B1-R3 (R-B1-04, M-1 remediation). Appended after the B1 corpus, same *
   * convention unit 60-63 themselves followed for unit 59.                  *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 64,
    id: '0052_fib_evidence_sufficiency_run_binding.sql',
    kind: D,
    file: 'db/migrations/0052_fib_evidence_sufficiency_run_binding.sql',
    sha256: '3fc4df227c7e128058573498f0dd53ce1219b93126c937cbb1e96b400c3ea541',
    dependsOn: ['0050_fib_evidence_sufficiency_determinations.sql'],
    ...PLAIN_DDL,
    managedNote:
      'W2-B1-R3 remediation (R-B1-04/M-1, FIBDB-014: "Per monetized outcome per run"). Adds ' +
      'calculation_run_id (NOT NULL, FK to sroi_calculation_runs) to evidence_sufficiency_determinations ' +
      'and re-scopes the ordinal uniqueness from (outcome_id, ordinal) to (outcome_id, ' +
      'calculation_run_id, ordinal). Safe as NOT NULL with no default: this table was created in the ' +
      'same Wave 2 batch (unit 62) and has never been applied to any hosted database, so there is no ' +
      'historical row to violate the new constraint.',
    expect: {},
  },

  /* ---------------------------------------------------------------------- *
   * W2-B2 (FIBIU-08). Proxy batch, following the same append convention     *
   * unit 64 (W2-B1-R3) established.                                         *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 65,
    id: '0053_fib_proxy_versions_provenance.sql',
    kind: D,
    file: 'db/migrations/0053_fib_proxy_versions_provenance.sql',
    sha256: '5778f649a09b48092436385c9642cefbf6e2f6773d357a361489f8a6c17836c5',
    dependsOn: ['0031_rls_core.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'destructive-on-reapply',
    managedNote:
      'FIBIU-08 stage A (FIBC-010/FIBC-012/FIBDB-006/FIBDB-039). CREATE TABLE financial_proxy_versions ' +
      '(the FIBC-002 specialization for proxies, mirroring evidence_versions\' treatment) plus ' +
      'outcome_proxy_assignments.financial_proxy_version_id. Rubric factor columns (FIBDB-006 field ' +
      'list) land here with no CHECK yet — FIBDB-044\'s range/derived-consistency CHECKs are FIBIU-09\'s ' +
      'own migration. RLS mirrors financial_proxies exactly: org-scoped or approved-global SELECT, ' +
      'INSERT/UPDATE at the same role floor as financial_proxies/proxy_sources, no DELETE policy.',
    rollback:
      'The CREATE TABLE / ADD CONSTRAINT / CREATE INDEX statements have no IF NOT EXISTS guard; the ' +
      'trailing three policies are guarded but do not change the unit\'s overall class. No reverse ' +
      'script — forward-only, recovered by DESTROY_AND_REPROVISION.',
    expect: {
      referencesAuthSchema: true,
      rlsEnabledTableCount: 1,
      policiesCreatedCount: 3,
      securitySurfaceDigest: '1fb6e2415a9a69dd82c9763caf068039a631b0e7f708d1b9d824ff2e92a7d901',
    },
  },
  {
    ordinal: 66,
    id: '0054_fib_proxy_rubric_constraints.sql',
    kind: D,
    file: 'db/migrations/0054_fib_proxy_rubric_constraints.sql',
    sha256: '2237b3247cdb22f792f30e83b24edfc202abfd9b59918be272116014ffa67ae7',
    dependsOn: ['0053_fib_proxy_versions_provenance.sql'],
    ...PLAIN_DDL,
    managedNote:
      'FIBIU-09 (FIBC-011/FIBDB-044). Five ADD CONSTRAINT CHECKs on financial_proxy_versions: rubric ' +
      'factor range (0-3), confidence/risk derived-score-formula consistency, and confidence-ceiling/ ' +
      'risk-floor implications. Defense-in-depth only — lib/pipeline/financial-proxy-rubric.ts\'s ' +
      'deriveRubricClassification() is the sole AUTHORITATIVE, fully-tested derivation; these five ' +
      'CHECKs have never been executed against a live Postgres instance in this DB-free-test ' +
      'repository and are flagged here for adversarial review rather than claimed as proven.',
    expect: {},
  },
  {
    ordinal: 67,
    id: '0055_fib_proxy_material_change_registry.sql',
    kind: D,
    file: 'db/migrations/0055_fib_proxy_material_change_registry.sql',
    sha256: '58924853da26b4c1fcd5ac0af00bade9a8fa5d3fe4977d84b7032e8c4e7ea0ce',
    dependsOn: ['0053_fib_proxy_versions_provenance.sql'],
    dml: 'global-catalog',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'destructive-on-reapply',
    managedNote:
      'FIBIU-10 stage A (FIBC-013/FIBDB-007). CREATE TABLE proxy_material_fields_registry, GRANT SELECT ' +
      'to authenticated (requires that role to exist, hence B not A — same reasoning as unit 51\'s ' +
      'governed_model_registry), and an idempotent ON CONFLICT DO NOTHING seed of 39 literal field-> ' +
      'category rows (universal reference data, not tenant data) for registry_version 1.0.0, matching ' +
      'the PROXY_MATERIAL_FIELDS row already seeded in governed_model_registry (unit 51). RLS is NOT ' +
      'enabled by this unit; it arrives as policies unit 69 (010_proxy_material_fields_registry_rls.sql), ' +
      'exactly as unit 58 supplies it for governed_model_registry. CORRECTION (W2-B2-R1 / R-B2-07, ' +
      'AG-B2-2): an earlier form of this note called that a stage-B/E deferral — FIBDB-007 declares ' +
      'migration_stage [A] only and "RLS: read-all members", so RLS is a stage-A requirement, not a ' +
      'deferrable one. Description-only edit; the SQL file and its sha256 are untouched.',
    rollback:
      'Applied with psql -1; a mid-unit failure rolls back whole. The seed INSERT is idempotent ' +
      '(ON CONFLICT DO NOTHING); the CREATE TABLE is not, so a partial re-apply after a table already ' +
      'exists fails loudly rather than silently diverging. No reverse script — forward-only, recovered ' +
      'by DESTROY_AND_REPROVISION.',
    expect: { usesAuthenticated: true, dmlStatementCount: 1, literalRowSourceCount: 1 },
  },

  /* ---------------------------------------------------------------------- *
   * W2-B2-R1 (B2 remediation, W2_B2_REMEDIATION_AUTHORITY_v1.0.0).          *
   * Forward-only correction units; 0053/0054/0055 are journaled, hashed and  *
   * untouched.                                                               *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 68,
    id: '0056_fib_proxy_material_fields_editability.sql',
    kind: D,
    file: 'db/migrations/0056_fib_proxy_material_fields_editability.sql',
    sha256: '86d7d22347425aa02678a7aeb1ebf185f0febcd014bc994d238df88bd9f34557',
    dependsOn: ['0055_fib_proxy_material_change_registry.sql', '0040_governed_model_registry.sql'],
    dml: 'global-catalog',
    managed: 'A-hosted-compatible',
    reapply: 'destructive-on-reapply',
    managedNote:
      'R-B2-03 (FIBC-013/FIBDB-007; closes M4 and AG-B2-3-DERIVED). ADD COLUMN editability (NULLable, ' +
      'no default, CHECK over user_editable/system_derived/system_sealed) on proxy_material_fields_registry; ' +
      'an idempotent ON CONFLICT DO NOTHING seed of 70 literal rows — one per persisted column of ' +
      'financial_proxies (24) and financial_proxy_versions (46) — as NEW registry_version 1.1.0 (the 39 ' +
      'rows of 1.0.0 are historical record, untouched: FIBDB-007 immutable per version); and the ' +
      'append-only governed_model_registry row (PROXY_MATERIAL_FIELDS, 1.1.0), same convention as unit 51. ' +
      'Universal reference data, not tenant data. No grant, no RLS change (RLS for this table is unit 69).',
    rollback:
      'Applied with psql -1; a mid-unit failure rolls back whole. Both INSERTs are idempotent; ADD ' +
      'COLUMN / ADD CONSTRAINT are not, so a partial re-apply fails loudly. No reverse script — ' +
      'forward-only, recovered by DESTROY_AND_REPROVISION.',
    expect: { dmlStatementCount: 2, literalRowSourceCount: 2 },
  },
  {
    ordinal: 69,
    id: '010_proxy_material_fields_registry_rls.sql',
    kind: P,
    file: 'db/policies/010_proxy_material_fields_registry_rls.sql',
    sha256: '1778707b22e83dad7046ae013bb58bf8c5f3faadd1d0183bcbd1d41799b43c03',
    dependsOn: ['0056_fib_proxy_material_fields_editability.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'idempotent',
    managedNote:
      'R-B2-07 (AG-B2-2 A_RLS_REQUIRED_IN_STAGE_A; FIBDB-007 "RLS: read-all members", migration_stage [A] ' +
      'only). RLS for proxy_material_fields_registry: ENABLE (never FORCE — the seed is migration-owner ' +
      'DML), one SELECT policy USING auth.uid() IS NOT NULL, no INSERT/UPDATE/DELETE policy, so rows are ' +
      'structurally immutable to every non-owner role. Same shape as unit 58 for governed_model_registry. ' +
      'The 0055 GRANT SELECT TO authenticated is retained unchanged; no new grant.',
    rollback:
      'One guarded DROP POLICY IF EXISTS ahead of one CREATE POLICY; ENABLE ROW LEVEL SECURITY is a ' +
      'no-op when already on. Converges.',
    expect: {
      referencesAuthSchema: true,
      rlsEnabledTableCount: 1,
      policiesCreatedCount: 1,
      securitySurfaceDigest: 'a1122391d6d558216fdf7ce14398c6e06ed504b818b7d5b1964d5845eb276785',
    },
  },

  /* ---------------------------------------------------------------------- *
   * W2-B3 (FIBIU-11, Wave 2 batch B3: Outcome and filters).                 *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 70,
    id: '0057_fib_outcome_materiality_classification.sql',
    kind: D,
    file: 'db/migrations/0057_fib_outcome_materiality_classification.sql',
    sha256: '2baf675c70d35b8aa8b8fc65e4fc6c1d669c1c714d0db23d080c80a8f8531f2c',
    dependsOn: ['0056_fib_proxy_material_fields_editability.sql'],
    ...PLAIN_DDL,
    managedNote:
      'FIBIU-11 (FIBC-015/FIBDB-008/FIBDB-045). ADD COLUMN materiality_classification ' +
      '(NULLable varchar(20), CHECK material/not_material) and ' +
      'materiality_classification_justification (NULLable text) on outcomes, plus the pair CHECK ' +
      'requiring both set or both NULL. Deliberately distinct from the pre-existing ' +
      'materiality_score/materiality_rationale columns and their own pair CHECK: FIBC-015 forbids ' +
      'auto-converting the 1-5 score into this classification (NPDD-03), so the two column pairs are ' +
      'independent and this unit touches neither the score column nor its CHECK.',
    expect: {},
  },
  {
    ordinal: 71,
    id: '0058_fib_filter_set_justification_columns.sql',
    kind: D,
    file: 'db/migrations/0058_fib_filter_set_justification_columns.sql',
    sha256: '4de23a6717d628abd4a605344934e1d3beb74adafe046c9e1df07a0421681b00',
    dependsOn: ['0057_fib_outcome_materiality_classification.sql'],
    ...PLAIN_DDL,
    managedNote:
      'FIBIU-13 (FIBC-017/FIBDB-010, implementation form frozen at R1, superseding FIB-01A\'s ' +
      'originally declared NEW_CONSTRAINT). ADD COLUMN deadweight_justification, ' +
      'attribution_justification, displacement_justification, dropoff_justification, and ' +
      'duration_justification (all NULLable text) on sroi_filter_sets, one per filter, so ' +
      'FILTER_JUSTIFICATION_MISSING is verifiable independently per filter instead of degenerating ' +
      'to "the shared justification column is non-empty". Deliberately no NOT NULL, no presence ' +
      'CHECK, and no new percentage-range CHECK: the four existing per-filter range CHECKs and the ' +
      'legacy shared justification column are untouched. discount_rate_pct lives on projects, not ' +
      'this table, and is out of scope for this unit.',
    expect: {},
  },

  /* ---------------------------------------------------------------------- *
   * W2-B3 (FIBIU-12, Wave 2 batch B3: Outcome and filters).                 *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 72,
    id: '0059_fib_outcome_monetization_dispositions.sql',
    kind: D,
    file: 'db/migrations/0059_fib_outcome_monetization_dispositions.sql',
    sha256: 'a6d64e7f30f6fa321040936c79e84339ff9130d13fd79c738bb7bde773ea8a01',
    dependsOn: ['0058_fib_filter_set_justification_columns.sql', '0031_rls_core.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'destructive-on-reapply',
    managedNote:
      'FIBIU-12 stage A (FIBC-016/FIBDB-009/045). CREATE TABLE outcome_monetization_dispositions — ' +
      'one append-only row per (outcome, calculation_run): disposition monetized/not_monetized, reason ' +
      '(one of 7 governed values, required when not_monetized), justification (required whenever ' +
      'reason is set). RLS: org-scoped SELECT, INSERT restricted to the same analyst+ floor ' +
      'upsertSroiFilterSet/outcomes.ts already use for this pipeline (created_by = auth.uid()), no ' +
      'UPDATE/DELETE policy — matches the evidence_sufficiency_determinations pattern (unit 62).',
    rollback:
      'The CREATE TABLE / ADD CONSTRAINT / CREATE INDEX statements have no IF NOT EXISTS guard; the ' +
      'trailing two policies are guarded but do not change the unit\'s overall class. No reverse script ' +
      '— forward-only, recovered by DESTROY_AND_REPROVISION.',
    expect: {
      referencesAuthSchema: true,
      rlsEnabledTableCount: 1,
      policiesCreatedCount: 2,
      securitySurfaceDigest: 'b478a797ff4da24bae5a65dafa196892d14b636c420e016c29c2cbaafb358c0e',
    },
  },

  /* ---------------------------------------------------------------------- *
   * W2-B3 completeness (FIBIU-12 stage B, AG-B3-6 / PG-12 —                 *
   * docs/ops/wave2/W2_B3_COMPLETENESS_AUTHORITY_v1.0.0.json).               *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 73,
    id: '0060_fib_outcome_monetization_dispositions_governance.sql',
    kind: D,
    file: 'db/migrations/0060_fib_outcome_monetization_dispositions_governance.sql',
    sha256: '9456eb0d93c34e49ed7333a9a306f22992f55a031b94fa2fd807e7d5e567a2bb',
    dependsOn: ['0059_fib_outcome_monetization_dispositions.sql', '0031_rls_core.sql', '0030_immutability.sql'],
    dml: 'none',
    managed: 'A-hosted-compatible',
    reapply: 'idempotent',
    managedNote:
      'FIBIU-12 stage B (FIBDB-009/045), successor to sealed 0059 (never edited). Adds the same-tenant ' +
      'analyst+ UPDATE policy 0059 lacked (PG-12 measured RLS_ENFORCED_UPDATE_DENIED_OR_ZERO under the ' +
      'runtime identity) and DB-enforced, race-safe approved-run immutability: a SECURITY DEFINER guard ' +
      '(BEFORE INSERT/UPDATE/DELETE) refusing writes once sroi_run_reviews carries an approved review for ' +
      'the run and freezing the identity columns, coordinated with an approval-side trigger on ' +
      'sroi_run_reviews through transaction-scoped advisory locks (60, hashtext(run_id)) — no table ' +
      'privilege is needed for advisory locks, so the protocol is independent of the hosted GRANT posture. ' +
      'Uses only 0031 helpers on schema public; no auth./storage. reference.',
    rollback:
      'Fully guarded: DROP POLICY IF EXISTS / CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS before ' +
      'each CREATE. Converges on reapply; applied with psql -1 so a failure rolls the unit back whole.',
    expect: {
      policiesCreatedCount: 1,
      functionsCreatedCount: 2,
      securityDefinerCount: 1,
      searchPathSettings: ['public', 'public'],
      triggersCreatedCount: 2,
      securitySurfaceDigest: '857695d664847e2d10f686d57b50d93f13d0f07490ef3693058f437a08d89a00',
    },
  },

  /* ---------------------------------------------------------------------- *
   * COMMERCIAL-V1-WAVE2-RECONCILIATION successor remediation (HPO-ODS-W2-09, *
   * docs/ops/integration/COMMERCIAL_V1_WAVE2_RECONCILIATION_AUTHORITY_v1.0.1 *
   * .json). Appended after the closed Wave2 B3 corpus, same convention.     *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 74,
    id: '0061_fib_disposition_governance_function_execute_revocation.sql',
    kind: D,
    file: 'db/migrations/0061_fib_disposition_governance_function_execute_revocation.sql',
    sha256: '3aeb49965697bee70b14fb59f8f5ff43cd3e15279c39d12575fe703867b646e7',
    dependsOn: ['0060_fib_outcome_monetization_dispositions_governance.sql'],
    ...PLAIN_DDL,
    // REVOKE of a privilege not held is a no-op: the unit converges on reapply.
    reapply: 'idempotent',
    rollback: 'Two REVOKE EXECUTE … FROM PUBLIC statements; re-running them is a no-op. Reverting would re-expose the functions to PUBLIC and re-fail B0-17 — never done.',
    managedNote:
      'B0-17 security successor to sealed 0060 (never edited). Exactly two REVOKE EXECUTE … FROM PUBLIC ' +
      'statements on the two functions 0060 created in schema public (uellix_guard_disposition_run_approval, ' +
      'uellix_lock_run_dispositions_on_approval), re-applying the 0033/042 discipline (no function in public ' +
      'EXECUTE-able by anon or PUBLIC) that no unit after 0033 had needed until 0060. Trigger firing does not ' +
      'depend on the invoking role\'s EXECUTE, so the approved-run guard and the approval-side lock behave ' +
      'exactly as 0060 installed them. No GRANT, no DDL, no DML, no policy, no auth./storage. reference.',
    expect: {},
  },

  /* ---------------------------------------------------------------------- *
   * Wave 2 batch B4 (FIBIU-15/14, HPO-ODS-W2-12,                            *
   * docs/ops/wave2/W2_B4_AUTHORITY_v1.0.0.json). Certified SERIAL_CONTRACT  *
   * 15->{14,16}: FIBDB-012/013/047 (this unit) precede FIBDB-011/046        *
   * (the next unit). FIBIU-16 materializes no unit here — NO_DB_OBJECT.     *
   * ---------------------------------------------------------------------- */
  {
    ordinal: 75,
    id: '0062_fib_methodological_assumptions.sql',
    kind: D,
    file: 'db/migrations/0062_fib_methodological_assumptions.sql',
    sha256: '7b73b99ffc46a8d1ded7734d5625b59e1deb79e56018e37da9a287847fde4940',
    dependsOn: ['0061_fib_disposition_governance_function_execute_revocation.sql', '0031_rls_core.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'destructive-on-reapply',
    managedNote:
      'FIBIU-15 stage A (FIBC-019/FIBDB-012/013/047). CREATE TABLE methodological_assumptions and ' +
      'assumption_object_links. RLS: org-scoped SELECT on both; INSERT restricted to the same analyst+ ' +
      'floor upsertSroiFilterSet/outcome_monetization_dispositions already use (created_by = auth.uid()); ' +
      'methodological_assumptions additionally carries an org-scoped, same-floor UPDATE policy — unlike ' +
      '0059\'s append-only precedent — because a material modification updates the row in place (its id ' +
      'is the assumption\'s permanent identity) while lib/pipeline/domain-object-versions.ts preserves the ' +
      'prior content as history; assumption_object_links has no UPDATE/DELETE policy (append-only, ' +
      'FIBDB-013 "immutability: none beyond the assumption\'s own versioning"). SEC-ACL-1: no new ' +
      'function or SECURITY DEFINER surface — the hosted disposition is RLS-only, identical in class to ' +
      'unit 72; nothing here needs a service_role/anon/authenticated grant of any kind.',
    rollback:
      'The CREATE TABLE / ADD CONSTRAINT / CREATE INDEX statements have no IF NOT EXISTS guard; the ' +
      'trailing policies are guarded but do not change the unit\'s overall class. No reverse script — ' +
      'forward-only, recovered by DESTROY_AND_REPROVISION.',
    expect: {
      referencesAuthSchema: true,
      rlsEnabledTableCount: 2,
      policiesCreatedCount: 5,
      securitySurfaceDigest: '91d247fe13c6343bcaaadfb3828d095eb8375dcb487991d78fe8a420a764ad3b',
    },
  },
  {
    ordinal: 76,
    id: '0063_fib_counterfactual_assessments.sql',
    kind: D,
    file: 'db/migrations/0063_fib_counterfactual_assessments.sql',
    sha256: '66418b303421e3e9286b1b96d0eb03931f0d7c81a4caf67a4a1957af9497b188',
    dependsOn: ['0062_fib_methodological_assumptions.sql', '0031_rls_core.sql'],
    dml: 'none',
    managed: 'B-hosted-compatible-given-supabase',
    reapply: 'destructive-on-reapply',
    managedNote:
      'FIBIU-14 stage A (FIBC-018/FIBDB-011/046). CREATE TABLE counterfactual_assessments — one row per ' +
      '(outcome, calculation_run): baseline_availability/basis_kind/deadweight_support_state vocabularies, ' +
      'baseline value/period/source/context required exactly when baseline_availability=available. RLS: ' +
      'org-scoped SELECT, INSERT and UPDATE at the same analyst+ floor as unit 75 — UPDATE because this ' +
      'object is refined create-or-update until the run is approved, mirroring ' +
      'recordOutcomeMonetizationDisposition\'s own shape rather than FIBDB-013\'s append-only one. ' +
      'SEC-ACL-1: no new function or SECURITY DEFINER surface — RLS-only, same class as unit 72/75.',
    rollback:
      'The CREATE TABLE / ADD CONSTRAINT / CREATE INDEX statements have no IF NOT EXISTS guard; the ' +
      'trailing policies are guarded but do not change the unit\'s overall class. No reverse script — ' +
      'forward-only, recovered by DESTROY_AND_REPROVISION.',
    expect: {
      referencesAuthSchema: true,
      rlsEnabledTableCount: 1,
      policiesCreatedCount: 3,
      securitySurfaceDigest: '38d7e1cd4f92aa38323d2228b6f7cc017431dbc9416a956b8343b97b0a3b7bd4',
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

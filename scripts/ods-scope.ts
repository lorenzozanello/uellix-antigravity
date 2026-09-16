// scripts/ods-scope.ts — ODS-C4, the explicit forbidden-scope/diff gate.
//
//   pnpm ods:scope --base <sha> --allow <path-or-pattern> [--allow ...]
//                   [--protected-authority <id> ...]
//
// Deterministically proves a diff stays inside explicitly authorized
// surfaces. Covers committed changes since --base, staged changes,
// unstaged changes, and untracked files. Renames are checked on BOTH
// endpoints so a rename cannot smuggle a path across the boundary.
//
// Governance rule: a changed file is authorized ONLY if the caller
// explicitly allowed its path. Being changed is never itself permission.
// A fixed set of high-risk surfaces (authority documents, migrations,
// prepared SQL, the frozen ODS authority artifact) is protected by
// default — an ordinary --allow can never override that classification by
// itself.
//
// HPO-ODS-W2-01 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.1.json):
// a protected path may be authorized ONLY via a --protected-authority id
// resolved against the repository-local PROTECTED_GRANTS registry below —
// never from a user-supplied pattern, an env var, a branch name alone, or
// the fact that a path was named in --allow. A grant is scoped to one
// branch and an exact set of protected patterns; the ordinary --allow
// list remains additionally mandatory for every granted path. Future
// waves require their own explicit HPO grant entry, not a broader one.
//
// COMMERCIAL_V1_POST_INTEGRATION_MAINTENANCE_AUTHORITY_v1.0.0.json (M1):
// --protected-authority MAY be repeated. Every occurrence is resolved
// independently against PROTECTED_GRANTS and the authorized protected
// surface becomes the exact UNION of every id's own patterns — never "any
// one supplied grant authorizes the whole diff". An id that fails to
// resolve (unknown, or granted on a different branch) contributes zero
// patterns to the union; it can never subtract from, or be papered over
// by, another supplied id's grant. A single --protected-authority id
// remains byte-for-byte compatible with prior single-grant behavior.

import { spawnSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Pure primitives — pattern matching and path classification.
// ---------------------------------------------------------------------------

/** Supports exact literal paths and a trailing/embedded `**` (match any depth). No other glob syntax is needed by this gate's callers. */
export function patternToRegExp(pattern: string): RegExp {
  const segments = pattern.split('**')
  const escaped = segments
    .map((segment) =>
      segment
        .split('*')
        .map((literal) => literal.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

export function matchesPattern(filePath: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(filePath)
}

export function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(filePath, p))
}

// HPO-ODS-C4-CASE-01 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.2.json):
// case-insensitive DETECTION only, used to catch a path that is trying to
// enter a protected surface via a non-canonical casing on a case-sensitive
// host (e.g. DB/migrations/x.sql vs the canonical db/migrations/**).
// Authorization is never derived from this — see classifyPaths below.
export function matchesPatternCaseInsensitive(filePath: string, pattern: string): boolean {
  return new RegExp(patternToRegExp(pattern).source, 'i').test(filePath)
}

export function matchesAnyPatternCaseInsensitive(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPatternCaseInsensitive(filePath, p))
}

/**
 * Default-protected, high-risk surfaces. Unconditional: no --allow pattern
 * in this version of the gate can authorize a change here.
 */
export const DEFAULT_PROTECTED_PATTERNS: string[] = [
  'docs/ops/fib/**',
  'docs/ops/pc01b/**',
  'docs/ops/im01b/**',
  'db/migrations/**',
  'db/prepared/**',
  'db/baseline/**',
  'docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json',
]

export interface ScopeClassification {
  protectedViolations: string[]
  unauthorized: string[]
  ok: string[]
  /** Subset of `ok` that was protected by default and authorized only via a resolved grant. */
  grantAuthorized: string[]
  /**
   * Case-insensitively inside a protected surface but NOT using its
   * canonical casing (e.g. DB/migrations/x.sql). Always a failure,
   * unconditionally — never authorizable, even under a valid grant. See
   * HPO-ODS-C4-CASE-01.
   */
  nonCanonicalProtectedPaths: string[]
}

/**
 * Pure: classifies a deduplicated path list against protected + allowed
 * patterns, and zero or more already-resolved protected-surface grants.
 *
 * Every element of `grant` must already be branch-validated by the caller
 * (see `resolveProtectedGrant`/`resolveProtectedGrants`) — this function
 * only checks whether the CONCRETE path matches one of the SUPPLIED
 * grants' own patterns (their exact union), never the broader default
 * protected pattern that made the path protected in the first place. That
 * is what keeps a grant for db/prepared/journal/** from ever authorizing
 * db/prepared/sibling.sql: the sibling matches DEFAULT_PROTECTED_PATTERNS'
 * db/prepared/** but not the grant's own narrower db/prepared/journal/**.
 * Passing multiple grants authorizes their exact union — never "any one
 * grant individually authorizes the whole diff" — and a path covered by
 * more than one supplied grant is not double-counted (Set-deduplicated
 * paths in, `.some()` union check, no per-grant counting).
 *
 * `grant` accepts a single `ProtectedGrant`, an array of them, or
 * `undefined` — the single-grant form is preserved unchanged for every
 * existing caller (e.g. scripts/audit-batch.ts) so this signature change
 * is purely additive.
 *
 * Casing: a path that only enters a protected surface case-insensitively
 * (not via its canonical declared casing) is classified as
 * nonCanonicalProtectedPaths and fails unconditionally — checked BEFORE
 * the ordinary --allow branch, so it can never be authorized by any
 * combination of grant or --allow. Detection is case-insensitive;
 * authorization stays bound to the canonical concrete path only.
 */
export function classifyPaths(
  paths: string[],
  protectedPatterns: string[],
  allowedPatterns: string[],
  grant?: ProtectedGrant | ProtectedGrant[],
): ScopeClassification {
  const grants: ProtectedGrant[] = grant === undefined ? [] : Array.isArray(grant) ? grant : [grant]
  const protectedViolations: string[] = []
  const unauthorized: string[] = []
  const ok: string[] = []
  const grantAuthorized: string[] = []
  const nonCanonicalProtectedPaths: string[] = []

  for (const p of new Set(paths)) {
    if (matchesAnyPattern(p, protectedPatterns)) {
      // Protected by default (canonical casing). Authorized ONLY if the
      // UNION of the supplied grants' own (narrower) patterns covers this
      // exact path AND the ordinary task --allow also covers it — both
      // mandatory, neither can stand in for the other.
      const grantCovers = grants.some((g) => matchesAnyPattern(p, g.patterns))
      const taskAllows = matchesAnyPattern(p, allowedPatterns)
      if (grantCovers && taskAllows) {
        ok.push(p)
        grantAuthorized.push(p)
      } else {
        protectedViolations.push(p)
      }
    } else if (matchesAnyPatternCaseInsensitive(p, protectedPatterns)) {
      // Case-insensitively protected but not canonically. Unconditional
      // failure — never reaches the grant/--allow branch below.
      nonCanonicalProtectedPaths.push(p)
    } else if (!matchesAnyPattern(p, allowedPatterns)) {
      unauthorized.push(p)
    } else {
      ok.push(p)
    }
  }

  return { protectedViolations, unauthorized, ok, grantAuthorized, nonCanonicalProtectedPaths }
}

// ---------------------------------------------------------------------------
// HPO-ODS-W2-01 — protected-surface explicit grants.
//
// A repository-local STATIC registry. No user-supplied arbitrary pattern
// can become authoritative: the only inputs a caller controls are which
// authority id to name and which branch they happen to be on, and both
// are checked against this fixed table, never trusted directly.
// ---------------------------------------------------------------------------

export interface ProtectedGrant {
  authorityId: string
  branch: string
  patterns: string[]
}

/**
 * Frozen by docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.1.json,
 * HPO-ODS-W2-01. Exists only to permit FIB Wave 2 governed migration and
 * journal materialization. Future waves require their own explicit entry
 * here via a new HPO authority update — never a broadened existing one.
 *
 * HPO-ODS-W2-02 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.3.json):
 * a successor, additive grant. It does not modify or widen HPO-ODS-W2-01
 * above. It exists ONLY to permit transporting the already-closed final
 * Wave2-B1 state at d058b36007e584f48d8f3f860c532924229c636a onto
 * codex/u0-u9-reengineering-resume-r1. Its patterns are the 75 exact
 * literal protected paths of that closed B1 state — no glob, no
 * subset/wildcard widening. It does not authorize B2, B3, any future
 * migration/journal file, or generic db/migrations/**, db/prepared/**, or
 * db/baseline/** on this branch.
 */
export const PROTECTED_GRANTS: ProtectedGrant[] = [
  {
    authorityId: 'HPO-ODS-W2-01',
    branch: 'codex/w2-methodology-objects-r1',
    patterns: ['db/migrations/**', 'db/prepared/journal/**'],
  },
  {
    authorityId: 'HPO-ODS-W2-02',
    branch: 'codex/u0-u9-reengineering-resume-r1',
    patterns: [
      'db/migrations/0048_fib_evidence_versions.sql',
      'db/migrations/0049_fib_evidence_sensitivity_vocabulary.sql',
      'db/migrations/0050_fib_evidence_sufficiency_determinations.sql',
      'db/migrations/0051_fib_evidence_erasure_substrate.sql',
      'db/migrations/0052_fib_evidence_sufficiency_run_binding.sql',
      'db/migrations/meta/0048_snapshot.json',
      'db/migrations/meta/0049_snapshot.json',
      'db/migrations/meta/0050_snapshot.json',
      'db/migrations/meta/0051_snapshot.json',
      'db/migrations/meta/0052_snapshot.json',
      'db/migrations/meta/_journal.json',
      'db/prepared/journal/001_0000_quick_husk.sql',
      'db/prepared/journal/002_0001_noisy_chameleon.sql',
      'db/prepared/journal/003_0002_huge_namorita.sql',
      'db/prepared/journal/004_0003_curvy_tempest.sql',
      'db/prepared/journal/005_0004_thick_mentor.sql',
      'db/prepared/journal/006_0005_daffy_dreaming_celestial.sql',
      'db/prepared/journal/007_0006_outstanding_vindicator.sql',
      'db/prepared/journal/008_0007_black_imperial_guard.sql',
      'db/prepared/journal/009_0008_bored_pretty_boy.sql',
      'db/prepared/journal/010_0009_motionless_peter_parker.sql',
      'db/prepared/journal/011_0010_crazy_warhawk.sql',
      'db/prepared/journal/012_0011_sroi_results_report_foundation.sql',
      'db/prepared/journal/013_0012_stella_interactions.sql',
      'db/prepared/journal/014_0013_performance_indexes.sql',
      'db/prepared/journal/015_0014_fine_blade.sql',
      'db/prepared/journal/016_0015_misty_lorna_dane.sql',
      'db/prepared/journal/017_0016_fat_mac_gargan.sql',
      'db/prepared/journal/018_0017_striped_legion.sql',
      'db/prepared/journal/019_0018_redundant_firebird.sql',
      'db/prepared/journal/020_0019_lazy_overlord.sql',
      'db/prepared/journal/021_0020_long_squadron_supreme.sql',
      'db/prepared/journal/022_0021_glorious_sandman.sql',
      'db/prepared/journal/023_0022_abandoned_karma.sql',
      'db/prepared/journal/024_0023_faulty_silver_sable.sql',
      'db/prepared/journal/025_0024_outstanding_enchantress.sql',
      'db/prepared/journal/026_0025_shallow_mattie_franklin.sql',
      'db/prepared/journal/027_0026_violet_selene.sql',
      'db/prepared/journal/028_0027_little_midnight.sql',
      'db/prepared/journal/029_0028_keen_iron_patriot.sql',
      'db/prepared/journal/030_0029_integrity.sql',
      'db/prepared/journal/031_0030_immutability.sql',
      'db/prepared/journal/032_0031_rls_core.sql',
      'db/prepared/journal/033_0032_rls_specialized.sql',
      'db/prepared/journal/034_0033_public_api_grants.sql',
      'db/prepared/journal/035_0034_phase3_white_label.sql',
      'db/prepared/journal/036_0035_phase5_marketing_leads.sql',
      'db/prepared/journal/037_0036_phase2_onboarding.sql',
      'db/prepared/journal/038_0037_phase1_stripe.sql',
      'db/prepared/journal/039_0038_sprint_a_gdpr_users.sql',
      'db/prepared/journal/040_20260716000000_auth_trigger.sql',
      'db/prepared/journal/041_20260716000001_storage_policies.sql',
      'db/prepared/journal/042_0039_grant_rls_helper_execution.sql',
      'db/prepared/journal/043_001_initial_auth_rls.sql',
      'db/prepared/journal/044_002_stella_interactions_rls.sql',
      'db/prepared/journal/045_003_signup_allowlist_rls.sql',
      'db/prepared/journal/046_004_fx_tables_rls.sql',
      'db/prepared/journal/047_005_theory_of_change_rls.sql',
      'db/prepared/journal/048_006_methodology_review_rls.sql',
      'db/prepared/journal/049_007_taxonomy_rls.sql',
      'db/prepared/journal/050_008_marketing_leads_rls.sql',
      'db/prepared/journal/051_0040_governed_model_registry.sql',
      'db/prepared/journal/052_0041_pc01b_regime_boundary_backfill.sql',
      'db/prepared/journal/053_0042_fib_audit_insert_policy.sql',
      'db/prepared/journal/054_0043_fib_audit_project_id_fk.sql',
      'db/prepared/journal/055_0044_fib_audit_hardening_supersession.sql',
      'db/prepared/journal/056_0045_fib_domain_object_version_lineage.sql',
      'db/prepared/journal/057_0046_fib_run_version_identity.sql',
      'db/prepared/journal/058_009_governed_model_registry_rls.sql',
      'db/prepared/journal/059_0047_fib_taxonomy_mapping_governance_regime.sql',
      'db/prepared/journal/060_0048_fib_evidence_versions.sql',
      'db/prepared/journal/061_0049_fib_evidence_sensitivity_vocabulary.sql',
      'db/prepared/journal/062_0050_fib_evidence_sufficiency_determinations.sql',
      'db/prepared/journal/063_0051_fib_evidence_erasure_substrate.sql',
      'db/prepared/journal/064_0052_fib_evidence_sufficiency_run_binding.sql',
    ],
  },
  // HPO-ODS-W2-03 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.4.json):
  // the baseline provisioning repair. Exactly the eight literal protected
  // paths that repair touches: the 0044 conditional-trigger correction and
  // its regenerated journal wrapper, the new pre-baseline managed-role
  // identity unit (+ rollback), the refactored post-baseline bootstrap
  // (+ rollback), its regenerated native-hosted artefact, and the prepared
  // registry README. No glob. Not 0042/0045, not 0048..0052, not
  // db/baseline/**, not stella_0003, not any other journal wrapper.
  {
    authorityId: 'HPO-ODS-W2-03',
    branch: 'codex/u0-u9-reengineering-resume-r1',
    patterns: [
      'db/migrations/0044_fib_audit_hardening_supersession.sql',
      'db/prepared/journal/055_0044_fib_audit_hardening_supersession.sql',
      'db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql',
      'db/prepared/stella_hosted_0000_rollback.sql',
      'db/prepared/stella_hosted_0001_managed_role_bootstrap.sql',
      'db/prepared/stella_hosted_0001_rollback.sql',
      'db/prepared/hosted/stella_hosted_0001_managed_role_bootstrap.hosted.sql',
      'db/prepared/README.md',
    ],
  },
  // HPO-ODS-W2-07 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.8.json):
  // canonical-generator regeneration of the checkpoint-b0 observation probe
  // on the Product PR-candidate successor branch, after migration 0045 added
  // public.domain_object_versions to the corpus without a probe refresh.
  // Exactly the one generated artifact — no glob, no other prepared SQL.
  {
    authorityId: 'HPO-ODS-W2-07',
    branch: 'codex/product-commercial-v1-pr-r1',
    patterns: ['db/prepared/checkpoint-b0/observation.sql'],
  },
  // HPO-ODS-W2-08 (docs/ops/integration/COMMERCIAL_V1_WAVE2_RECONCILIATION_AUTHORITY_v1.0.0.json,
  // HPO mission COMMERCIAL-V1-WAVE2-RECONCILIATION-R1): reconciliation of the
  // closed Wave2 B2/B3 lineage (codex/w2-methodology-objects-r1 @ 102a75cc)
  // into the Product-integrated lineage (integration/commercial-v1 @ d56d44a3)
  // on the candidate branch codex/commercial-v1-wave2-reconciliation-r1.
  // Exactly the 98 literal protected paths by which the two-parent merge
  // commit differs from EITHER parent, measured read-only before the merge:
  // the closed B2/B3 migrations 0053..0060 + their Drizzle snapshots + the
  // journal (Wave2 side, relative to the Product parent); the 73 journal
  // wrappers regenerated by the canonical generator; the HPO-ODS-W2-03 /
  // W2-07 protected paths (Product side, relative to the Wave2 parent); and
  // the checkpoint-b0 observation probe regenerated for the enlarged corpus.
  // No glob. Not any new migration, not db/baseline/**, not any frozen
  // authority artifact, not any hand edit of a generated file.
  {
    authorityId: 'HPO-ODS-W2-08',
    branch: 'codex/commercial-v1-wave2-reconciliation-r1',
    patterns: [
      'db/migrations/0044_fib_audit_hardening_supersession.sql',
      'db/migrations/0053_fib_proxy_versions_provenance.sql',
      'db/migrations/0054_fib_proxy_rubric_constraints.sql',
      'db/migrations/0055_fib_proxy_material_change_registry.sql',
      'db/migrations/0056_fib_proxy_material_fields_editability.sql',
      'db/migrations/0057_fib_outcome_materiality_classification.sql',
      'db/migrations/0058_fib_filter_set_justification_columns.sql',
      'db/migrations/0059_fib_outcome_monetization_dispositions.sql',
      'db/migrations/0060_fib_outcome_monetization_dispositions_governance.sql',
      'db/migrations/meta/0053_snapshot.json',
      'db/migrations/meta/0054_snapshot.json',
      'db/migrations/meta/0055_snapshot.json',
      'db/migrations/meta/0056_snapshot.json',
      'db/migrations/meta/0057_snapshot.json',
      'db/migrations/meta/0058_snapshot.json',
      'db/migrations/meta/0059_snapshot.json',
      'db/migrations/meta/0060_snapshot.json',
      'db/migrations/meta/_journal.json',
      'db/prepared/README.md',
      'db/prepared/checkpoint-b0/observation.sql',
      'db/prepared/hosted/stella_hosted_0001_managed_role_bootstrap.hosted.sql',
      'db/prepared/journal/001_0000_quick_husk.sql',
      'db/prepared/journal/002_0001_noisy_chameleon.sql',
      'db/prepared/journal/003_0002_huge_namorita.sql',
      'db/prepared/journal/004_0003_curvy_tempest.sql',
      'db/prepared/journal/005_0004_thick_mentor.sql',
      'db/prepared/journal/006_0005_daffy_dreaming_celestial.sql',
      'db/prepared/journal/007_0006_outstanding_vindicator.sql',
      'db/prepared/journal/008_0007_black_imperial_guard.sql',
      'db/prepared/journal/009_0008_bored_pretty_boy.sql',
      'db/prepared/journal/010_0009_motionless_peter_parker.sql',
      'db/prepared/journal/011_0010_crazy_warhawk.sql',
      'db/prepared/journal/012_0011_sroi_results_report_foundation.sql',
      'db/prepared/journal/013_0012_stella_interactions.sql',
      'db/prepared/journal/014_0013_performance_indexes.sql',
      'db/prepared/journal/015_0014_fine_blade.sql',
      'db/prepared/journal/016_0015_misty_lorna_dane.sql',
      'db/prepared/journal/017_0016_fat_mac_gargan.sql',
      'db/prepared/journal/018_0017_striped_legion.sql',
      'db/prepared/journal/019_0018_redundant_firebird.sql',
      'db/prepared/journal/020_0019_lazy_overlord.sql',
      'db/prepared/journal/021_0020_long_squadron_supreme.sql',
      'db/prepared/journal/022_0021_glorious_sandman.sql',
      'db/prepared/journal/023_0022_abandoned_karma.sql',
      'db/prepared/journal/024_0023_faulty_silver_sable.sql',
      'db/prepared/journal/025_0024_outstanding_enchantress.sql',
      'db/prepared/journal/026_0025_shallow_mattie_franklin.sql',
      'db/prepared/journal/027_0026_violet_selene.sql',
      'db/prepared/journal/028_0027_little_midnight.sql',
      'db/prepared/journal/029_0028_keen_iron_patriot.sql',
      'db/prepared/journal/030_0029_integrity.sql',
      'db/prepared/journal/031_0030_immutability.sql',
      'db/prepared/journal/032_0031_rls_core.sql',
      'db/prepared/journal/033_0032_rls_specialized.sql',
      'db/prepared/journal/034_0033_public_api_grants.sql',
      'db/prepared/journal/035_0034_phase3_white_label.sql',
      'db/prepared/journal/036_0035_phase5_marketing_leads.sql',
      'db/prepared/journal/037_0036_phase2_onboarding.sql',
      'db/prepared/journal/038_0037_phase1_stripe.sql',
      'db/prepared/journal/039_0038_sprint_a_gdpr_users.sql',
      'db/prepared/journal/040_20260716000000_auth_trigger.sql',
      'db/prepared/journal/041_20260716000001_storage_policies.sql',
      'db/prepared/journal/042_0039_grant_rls_helper_execution.sql',
      'db/prepared/journal/043_001_initial_auth_rls.sql',
      'db/prepared/journal/044_002_stella_interactions_rls.sql',
      'db/prepared/journal/045_003_signup_allowlist_rls.sql',
      'db/prepared/journal/046_004_fx_tables_rls.sql',
      'db/prepared/journal/047_005_theory_of_change_rls.sql',
      'db/prepared/journal/048_006_methodology_review_rls.sql',
      'db/prepared/journal/049_007_taxonomy_rls.sql',
      'db/prepared/journal/050_008_marketing_leads_rls.sql',
      'db/prepared/journal/051_0040_governed_model_registry.sql',
      'db/prepared/journal/052_0041_pc01b_regime_boundary_backfill.sql',
      'db/prepared/journal/053_0042_fib_audit_insert_policy.sql',
      'db/prepared/journal/054_0043_fib_audit_project_id_fk.sql',
      'db/prepared/journal/055_0044_fib_audit_hardening_supersession.sql',
      'db/prepared/journal/056_0045_fib_domain_object_version_lineage.sql',
      'db/prepared/journal/057_0046_fib_run_version_identity.sql',
      'db/prepared/journal/058_009_governed_model_registry_rls.sql',
      'db/prepared/journal/059_0047_fib_taxonomy_mapping_governance_regime.sql',
      'db/prepared/journal/060_0048_fib_evidence_versions.sql',
      'db/prepared/journal/061_0049_fib_evidence_sensitivity_vocabulary.sql',
      'db/prepared/journal/062_0050_fib_evidence_sufficiency_determinations.sql',
      'db/prepared/journal/063_0051_fib_evidence_erasure_substrate.sql',
      'db/prepared/journal/064_0052_fib_evidence_sufficiency_run_binding.sql',
      'db/prepared/journal/065_0053_fib_proxy_versions_provenance.sql',
      'db/prepared/journal/066_0054_fib_proxy_rubric_constraints.sql',
      'db/prepared/journal/067_0055_fib_proxy_material_change_registry.sql',
      'db/prepared/journal/068_0056_fib_proxy_material_fields_editability.sql',
      'db/prepared/journal/069_010_proxy_material_fields_registry_rls.sql',
      'db/prepared/journal/070_0057_fib_outcome_materiality_classification.sql',
      'db/prepared/journal/071_0058_fib_filter_set_justification_columns.sql',
      'db/prepared/journal/072_0059_fib_outcome_monetization_dispositions.sql',
      'db/prepared/journal/073_0060_fib_outcome_monetization_dispositions_governance.sql',
      'db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql',
      'db/prepared/stella_hosted_0000_rollback.sql',
      'db/prepared/stella_hosted_0001_managed_role_bootstrap.sql',
      'db/prepared/stella_hosted_0001_rollback.sql',
    ],
  },
  // HPO-ODS-W2-09 (docs/ops/integration/COMMERCIAL_V1_WAVE2_RECONCILIATION_AUTHORITY_v1.0.1.json,
  // HPO mission COMMERCIAL-V1-WAVE2-RECONCILIATION-SUCCESSOR-REMEDIATION-R2):
  // the security successor migration 0061 that revokes EXECUTE FROM PUBLIC on
  // the two functions closed Wave2 unit 0060 created (B0-17), as canonical
  // baseline unit ordinal 74. Exactly the four literal protected paths that
  // successor materializes: the migration, its Drizzle snapshot, the journal
  // entry and the regenerated wrapper. Additive to HPO-ODS-W2-08 (unchanged).
  // No glob. Not 0060, not any other migration, snapshot or wrapper.
  {
    authorityId: 'HPO-ODS-W2-09',
    branch: 'codex/commercial-v1-wave2-reconciliation-r1',
    patterns: [
      'db/migrations/0061_fib_disposition_governance_function_execute_revocation.sql',
      'db/migrations/meta/0061_snapshot.json',
      'db/migrations/meta/_journal.json',
      'db/prepared/journal/074_0061_fib_disposition_governance_function_execute_revocation.sql',
    ],
  },
  // HPO-ODS-W2-11 (docs/ops/p1a/P1A_FULL_BOOTSTRAP_AUTHORITY_v1.0.0.json,
  // companion docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.10.json,
  // HPO mission P1A-FULL-BOOTSTRAP-AUTHORITY-MATERIALIZATION-R1): the
  // canonical LOCAL/CI clean-bootstrap-from-zero node. Exactly three literal
  // protected paths, no glob: the NEW local pre-baseline role identity
  // package, the EXISTING local role topology package (authorized only to
  // convert its two already-canonical grants at lines 176 and 181 into
  // fail-closed assertions), and the prepared-SQL registry that
  // tests/prepared-sql-source-of-truth.test.ts checks.
  //
  // Deliberately NOT db/prepared/** and NOT db/migrations/**. The HOSTED
  // managed-role packages (stella_hosted_0000/0001) are a separate surface
  // and are absent here on purpose, as is baseline unit 41
  // (db/prepared/storage/20260716000001_part_a_helpers.psql.sql), which the
  // future gate applies VERBATIM and SHA-verified rather than editing.
  {
    authorityId: 'HPO-ODS-W2-11',
    branch: 'codex/p1a-full-bootstrap-r1',
    patterns: [
      'db/prepared/stella_local_0000_local_role_identity_bootstrap.sql',
      'db/prepared/stella_0001_role_topology_bootstrap.sql',
      'db/prepared/README.md',
    ],
  },
  // HPO-ODS-W2-12 (docs/ops/wave2/W2_B4_AUTHORITY_v1.0.0.json, companion
  // docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.11.json): Wave 2 batch B4
  // — FIBIU-15/14/16 assumptions and causality — on its own branch. Two
  // patterns, mechanically identical in shape to HPO-ODS-W2-01 because B4
  // occupies the same two Wave 2 surfaces; W2-01 is frozen and NOT reused,
  // since a grant is bound to exactly one branch. Deliberately NOT
  // db/prepared/** — that would reach the hosted and local bootstrap files
  // HPO-ODS-W2-03, W2-05 and W2-11 own. The concrete migration ordinals
  // cannot be literals here: W2_B4_AUTHORITY_v1.0.0.json refuses to freeze a
  // slot before its P1A sync point re-measures it.
  {
    authorityId: 'HPO-ODS-W2-12',
    branch: 'codex/w2-b4-r1',
    patterns: ['db/migrations/**', 'db/prepared/journal/**'],
  },
  // HPO-ODS-W2-16 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.15.json): the
  // W2-B4 remediation grant for the checkpoint-b0 observation probe. ONE exact
  // literal path, no glob — db/prepared/checkpoint-b0/ holds exactly that one
  // file, so even a directory pattern would grant strictly more than the
  // classifier can justify. Same branch as W2-12 and deliberately a SEPARATE
  // entry: W2-12 is FROZEN at its two patterns and is never widened, and
  // resolveProtectedGrants unions only the ids a caller actually supplies.
  // Mechanically identical in shape to HPO-ODS-W2-07, the same probe's
  // regeneration grant on the Product PR-candidate branch.
  {
    authorityId: 'HPO-ODS-W2-16',
    branch: 'codex/w2-b4-r1',
    patterns: ['db/prepared/checkpoint-b0/observation.sql'],
  },
  // HPO-ODS-W2-17 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.16.json,
  // companion docs/ops/wave2/W2_B5_AUTHORITY_v1.0.0.json): Wave 2 batch B5 -
  // FIBIU-17 readiness and FIBIU-18 sensitivity - on its own branch. THREE
  // patterns, because B5 needs one surface W2-B4's grant did not: registering
  // two governed baseline units adds three tables to the corpus that
  // scripts/b0-observation-sql.ts reads, so the generated checkpoint-b0 probe
  // is stale by construction and its canonical regenerator is the only correct
  // repair - the same mechanism HPO-ODS-W2-07 and HPO-ODS-W2-16 each addressed
  // on their own branches. Deliberately NOT db/prepared/**: that would reach
  // the hosted and local bootstrap files the P1A and hosted lanes own, and
  // db/prepared/checkpoint-a1/corroboration.sql, which the B5 authority
  // protects as a historical measurement. The third pattern is one exact
  // literal path, no glob - db/prepared/checkpoint-b0/ holds exactly that one
  // file. W2-12 and W2-16 are FROZEN, bound to codex/w2-b4-r1, and are neither
  // widened nor reused: a grant is bound to exactly one branch. The concrete
  // migration ordinals cannot be literals here - W2_B5_AUTHORITY_v1.0.0.json
  // sets MIGRATION_SLOT_FROZEN = NO and re-measures at SYNC_POINT.
  {
    authorityId: 'HPO-ODS-W2-17',
    branch: 'codex/w2-b5-r1',
    patterns: ['db/migrations/**', 'db/prepared/journal/**', 'db/prepared/checkpoint-b0/observation.sql'],
  },
  // HPO-ODS-W2-20 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.19.json,
  // companion docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_v1.0.0.json):
  // multi-org S1 (founder traceability) on its own branch. ONE pattern -
  // db/migrations/** - because CP-1 is a single global ordinal sequence and
  // pinning the ordinal at authority time would manufacture the collision the
  // grant exists to avoid. Registered by the S1 implementing mission, as the
  // addendum instructs. Deliberately NOT db/prepared/**.
  {
    authorityId: 'HPO-ODS-W2-20',
    branch: 'codex/multiorg-s1-founder-traceability-r1',
    patterns: ['db/migrations/**'],
  },
  // HPO-ODS-W2-21 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.20.json,
  // companion docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.1.json):
  // the journal-wrapper family an ordinary migration drags with it. ONE
  // pattern - db/prepared/journal/** - a STRICT SUBSET of db/prepared/** that
  // reaches neither the stella_* hosted units nor checkpoint-b0. A SEPARATE
  // entry sharing W2-20's branch, on the v1.0.15 precedent: W2-20 keeps its
  // single pattern and is never widened; resolveProtectedGrants unions only
  // the ids a caller actually supplies. HPO-ODS-W2-22 is an ADDENDUM IDENTITY
  // (v1.0.21, protected_grant=null) and is deliberately NOT registered.
  {
    authorityId: 'HPO-ODS-W2-21',
    branch: 'codex/multiorg-s1-founder-traceability-r1',
    patterns: ['db/prepared/journal/**'],
  },
  // HPO-ODS-W2-25 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.25.json,
  // companion docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.6.json):
  // the multi-org S3 refusal-audit implementation. TWO patterns, because a
  // policy reaches the database only as a migration PLUS the journal wrapper
  // that commits its journal row in the same transaction - so authorising one
  // without the other authorises nothing that can actually be applied.
  //
  // db/prepared/journal/** is load-bearing beyond the ONE new wrapper: the
  // generator stamps BASELINE_UNITS.length into the header of EVERY wrapper
  // (db/hosted/baseline-journal-wrapper.ts), so appending one baseline unit
  // rewrites all 79 existing wrappers as well. The pattern is still a STRICT
  // SUBSET of db/prepared/** and reaches neither the stella_* hosted units nor
  // checkpoint-b0.
  //
  // GRANT ID REUSED, NOT REALLOCATED. W2-25 was declared by v1.0.24 and
  // carried field-for-field into v1.0.25; the version bump corrects the
  // ceiling's REPRESENTATION of the journal family, not the grant. W2-20/W2-21
  // carry the same surfaces but resolve only on the S1 branch, so neither can
  // stand in for this one.
  {
    authorityId: 'HPO-ODS-W2-25',
    branch: 'codex/multiorg-s3-refusal-audit-implementation-r1',
    patterns: ['db/migrations/**', 'db/prepared/journal/**'],
  },
  // HPO-ODS-W2-26 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json,
  // refined by the minimal append-only successor
  // docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.29.json): the Commercial
  // Account CE-1 implementation. THREE patterns, carried field for field from
  // the frozen CE-1 execution authority amendment via v1.0.28 — the migration
  // family, the journal wrapper family that a migration necessarily drags with
  // it, and ONE literal checkpoint-b0 observation file.
  //
  // NOT db/prepared/**. The third pattern is the single literal
  // db/prepared/checkpoint-b0/observation.sql and is deliberately NOT
  // generalized to db/prepared/checkpoint-b0/** or to a blanket
  // db/prepared/**: the stella_* hosted units and every other checkpoint file
  // stay protected violations on this branch even with the grant supplied.
  // W2-07, W2-08, W2-16 and W2-17 carry that same observation literal, and
  // W2-01/W2-20/W2-21/W2-25 carry the same migration and journal families, but
  // every one of them resolves only on its own branch — so none can stand in
  // for this one on the CE-1 branch.
  //
  // ORDER IS PART OF THE ROW'S IDENTITY. v1.0.29 asserts the row with a
  // whole-object equality rather than a set comparison, so the three patterns
  // are registered in the order the authority states them.
  //
  // GRANT ID REUSED, NOT NEWLY ALLOCATED. W2-26 was DECLARED by v1.0.28 and
  // left DECLARED_NOT_REGISTERED; v1.0.29 refines the same act on the same two
  // paths for the same id. Declaring a grant is safe; registering it here is
  // the separate governed act, and this row is that act.
  {
    authorityId: 'HPO-ODS-W2-26',
    branch: 'codex/commercial-account-ce1-implementation-r1',
    patterns: [
      'db/migrations/**',
      'db/prepared/journal/**',
      'db/prepared/checkpoint-b0/observation.sql',
    ],
  },
  // HPO-ODS-W2-27 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json):
  // the FIBDB-052 phase P1 index sub-package. TWO patterns, carried field for
  // field from that authority's own `protected_grant` declaration — the
  // migration family, and the journal wrapper family a migration necessarily
  // drags with it because the generator stamps BASELINE_UNITS.length into the
  // header of EVERY wrapper, so appending one baseline unit rewrites all of
  // them.
  //
  // TWO PATTERNS, NOT THREE. The predecessor W2-26 directly above carries a
  // THIRD pattern, the literal db/prepared/checkpoint-b0/observation.sql. It
  // is DELIBERATELY ABSENT here. v1.0.30 CHECKPOINT_B0_EXCLUSION measured that
  // probe to be index-insensitive — it reads no pg_index/pg_indexes, and both
  // of its pg_class sites filter relkind to tables/partitions/views, excluding
  // index relkinds — so P1 does not move it and the authority's condition for
  // inclusion ("proves that it does", not "might") is not met. Copying the
  // predecessor's grant shape is the most likely way this registration would
  // have silently widened the protected surface while looking like
  // precedent-following.
  //
  // NOT db/prepared/**. The DEFAULT protected pattern above is the broad
  // db/prepared/**, but the breadth of the PROTECTION is not a licence for
  // breadth in the GRANT: a blanket pattern would additionally authorize
  // db/prepared/hosted/** and db/prepared/hosted/governed/**, which are
  // G2-gated apply surfaces P1 has no business touching. A sibling under
  // db/prepared/ that matches the default pattern but not this narrower one is
  // correctly refused.
  //
  // W2-01, W2-07, W2-16, W2-20, W2-21 and W2-25 carry the same migration
  // and/or journal families, and W2-26 carries them too, but every one of them
  // is bound to a DIFFERENT branch and resolution is by exact branch equality
  // — so on codex/fibdb052-p1-implementation-r1 all of them contribute zero
  // patterns and none can stand in for this row.
  //
  // DECLARED BY v1.0.30, REGISTERED HERE. Declaring a grant and registering it
  // are separate governed acts on separate surfaces. The P1 implementation
  // mission is PROHIBITED from performing this one for itself: a node that
  // registers the grant it is about to rely on has authorized its own diff.
  {
    authorityId: 'HPO-ODS-W2-27',
    branch: 'codex/fibdb052-p1-implementation-r1',
    patterns: ['db/migrations/**', 'db/prepared/journal/**'],
  },
  // HPO-ODS-W2-28 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json):
  // the Customer Lifecycle CL-1 legal-acceptance substrate. THREE patterns,
  // carried field for field from that authority's own `protected_grant`
  // declaration and in the order it states them — under v1.0.31
  // ORDER_IS_BINDING the order is part of the row's identity, because the
  // registration control asserts the row as a whole-object equality rather
  // than as a set comparison.
  //
  // THREE PATTERNS, NOT TWO. The predecessor W2-27 directly above carries
  // only the migration and journal families and DELIBERATELY excludes
  // db/prepared/checkpoint-b0/observation.sql. Copying the most recent
  // grant's shape — the most likely way this registration would have
  // silently UNDER-granted while looking like precedent-following — would
  // have produced two patterns here and stopped the CL-1 mission on a scope
  // violation it could not lawfully route around. v1.0.31
  // WHY_THREE_PATTERNS_AND_NOT_TWO measured the discriminator in BOTH
  // directions on real commits: observation.sql builds its rowCounts key
  // from a UNION ALL chain with one arm per governed relation, so a
  // TABLE-creating commit rewrites its bytes (CE-1 at 8ca2ff9b, 2
  // insertions) while an INDEX-only commit leaves the path absent from the
  // commit entirely (P1 at e9c84ff3). CL-1 creates relations; P1 created
  // only indexes. The exclusion was correct for W2-27 and would be wrong
  // here.
  //
  // NOT db/prepared/**. The DEFAULT protected pattern above is the broad
  // db/prepared/**, but the breadth of the PROTECTION is not a licence for
  // breadth in the GRANT: a blanket pattern would additionally authorize
  // db/prepared/hosted/** and db/prepared/hosted/governed/**, which are
  // G2-gated apply surfaces CL-1 has no business touching, and the separate
  // db/prepared/stella_*.sql numbering family CL-1 does not extend. A
  // sibling under db/prepared/ that matches the default pattern but not
  // these two narrower ones is correctly refused.
  //
  // NO EXISTING ROW CAN STAND IN. Measured against this registry, not
  // asserted: EIGHT rows already carry db/migrations/** and/or
  // db/prepared/journal/** (W2-01, W2-12, W2-17, W2-20, W2-21, W2-25, W2-26
  // and W2-27) and FIVE already carry the observation literal (W2-07,
  // W2-08, W2-16, W2-17 and W2-26). Every one of them is bound to a
  // DIFFERENT branch, and resolution is by exact string equality, so on
  // codex/customer-lifecycle-cl1-implementation-r1 all of them contribute
  // zero patterns.
  //
  // THIS ROW ALLOCATES NO ORDINAL AND NO CONTROLLER. v1.0.31
  // MIGRATION_ORDINAL_DISPOSITION is posture B: no migration ordinal is
  // allocated, reserved or implied, and the implementing mission re-derives
  // it at its OWN head by the normal drizzle-kit generate path. The
  // Controller IMMUTABLE_BY_CONVENTION array gates the NEXT LINEAGE
  // allocation and can never prevent a grant from resolving — two
  // independent registries with independent controls.
  //
  // DECLARED BY v1.0.31, REGISTERED HERE. Declaring a grant and registering
  // it are separate governed acts on separate surfaces; v1.0.31 lists this
  // very file under EXPLICITLY_NOT_AUTHORIZED for exactly that reason. The
  // CL-1 implementation mission is PROHIBITED from performing this act for
  // itself: a node that registers the grant it is about to rely on has
  // authorized its own diff.
  {
    authorityId: 'HPO-ODS-W2-28',
    branch: 'codex/customer-lifecycle-cl1-implementation-r1',
    patterns: [
      'db/migrations/**',
      'db/prepared/journal/**',
      'db/prepared/checkpoint-b0/observation.sql',
    ],
  },
  // HPO-ODS-W2-29 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.32.json):
  // the Customer Lifecycle L1 ORGANIZATION-class commercial acceptance
  // substrate and its enforcement. THREE patterns, carried field for field
  // from that authority's own protected_grant declaration and in the order
  // it states them — under v1.0.32 ORDER_IS_BINDING the order is part of the
  // row's identity, because the registration control asserts the row as a
  // whole-object equality rather than as a set comparison.
  //
  // THE SAME THREE PATTERNS AS W2-28, RE-DERIVED AND NOT INHERITED. The
  // predecessor W2-28 directly above carries a byte-identical pattern list,
  // so its rationale CANNOT be reused here. What justified W2-28 carrying a
  // third pattern was a contrast with ITS predecessor W2-27, which
  // deliberately EXCLUDED the observation literal; W2-29 has no such
  // predecessor contrast, and restating one would be a false historical
  // statement written to preserve comment symmetry. v1.0.32
  // WHY_THESE_THREE_PATTERNS_RE_DERIVED_NOT_INHERITED therefore re-derives
  // each pattern against the ACTUAL CL-1 merge diff at cbd1eb82, measured by
  // git diff --numstat cbd1eb82^1 cbd1eb82 — never --stat, which abbreviates
  // long paths (so a directory-prefix grep under-counts in silence) and sums
  // insertions with deletions (so a one-line rewrite reads as 2):
  //
  //   1. db/migrations/** — FIVE paths moved: two SQL files, two per-ordinal
  //      snapshots and the _journal.json append. A migration is never one
  //      file, and the ordinal is not knowable in advance, so no literal-path
  //      grant is constructible. L1 creates one relation with RLS and two
  //      triggers and may emit more than one migration, as CL-1 in fact did.
  //
  //   2. db/prepared/journal/** — EIGHTY-FOUR wrapper paths moved, in exactly
  //      two numstat buckets: 82 at (1 insertion, 1 deletion) and 2 at
  //      (65, 0). Each wrapper header carries the literal
  //      Unit <ordinal>/<BASELINE_UNITS.length>, so appending a baseline unit
  //      increments the DENOMINATOR and rewrites that ONE header line in
  //      every pre-existing wrapper; the two (65, 0) rows are the two NEW
  //      wrappers CL-1 added. This is generated-artefact REGENERATION, not an
  //      edit of unrelated files. A grant naming only the new wrapper would
  //      refuse 82 regenerated siblings, and enumerating 84 literals that will
  //      be 85 next time is a stale list rather than a grant.
  //
  //   3. db/prepared/checkpoint-b0/observation.sql — moved with (6, 0). The
  //      file builds its rowCounts key from an explicit UNION ALL chain with
  //      one arm per governed relation, so adding an arm changes the FILE
  //      BYTES and not merely the query output. The discriminator is
  //      validated in BOTH directions on real commits: a TABLE-creating
  //      lineage moves the file and the line count scales with the relation
  //      count (CL-1 created three relations and moved it by 6 lines), while
  //      an INDEX-only lineage leaves the path absent from the commit
  //      entirely (P1 at e9c84ff3 touches ZERO paths under
  //      db/prepared/checkpoint-b0/). L1 creates ONE new governed relation,
  //      so it adds ONE arm and falls on the SAME side of that discriminator
  //      as CL-1 and the OPPOSITE side from P1. A LITERAL and never
  //      db/prepared/checkpoint-b0/**: only this one file needs to move.
  //
  // NOT db/prepared/**. The DEFAULT protected pattern above is the broad
  // db/prepared/**, but the breadth of the PROTECTION is not a licence for
  // breadth in the GRANT: a blanket pattern would additionally authorize
  // db/prepared/hosted/** and db/prepared/hosted/governed/**, which are
  // G2-gated apply surfaces L1 has no business touching, and the separate
  // db/prepared/stella_*.sql numbering family L1 does not extend. A sibling
  // under db/prepared/ that matches the default pattern but not these two
  // narrower ones is CORRECTLY refused (v1.0.32 NO_DB_PREPARED_WIDENING).
  //
  // NO EXISTING ROW CAN STAND IN — INCLUDING THE BYTE-IDENTICAL W2-28.
  // MEASURED against this registry rather than asserted: NINE rows carry
  // db/migrations/** and/or db/prepared/journal/** (W2-01, W2-12, W2-17,
  // W2-20, W2-21, W2-25, W2-26, W2-27 and W2-28) and SIX carry the
  // observation literal (W2-07, W2-08, W2-16, W2-17, W2-26 and W2-28 — W2-08
  // carries it inside its 98-entry literal family). Every one of them is
  // bound to a DIFFERENT branch, and resolution is by exact string equality,
  // so on codex/l1-organization-commercial-acceptance-implementation-r1 all
  // of them contribute ZERO patterns. W2-28 in particular, whose three
  // patterns are byte-identical to this row's, is bound to
  // codex/customer-lifecycle-cl1-implementation-r1 and resolves nowhere for
  // L1. That is exactly why a duplicate-LOOKING row is doing real work: a
  // grant is keyed on its BRANCH as well as its patterns, and this registry
  // already contains valid same-branch pairs (W2-20 with W2-21 on
  // codex/multiorg-s1-founder-traceability-r1, W2-12 with W2-16 on
  // codex/w2-b4-r1) for the mirror-image structural reason.
  //
  // THIS ROW ALLOCATES NO ORDINAL AND NO CONTROLLER. The migration pattern is
  // a GLOB and never a specific ordinal, so registering this row reserves no
  // number and the implementing mission re-derives one at its OWN head. The
  // Controller IMMUTABLE_BY_CONVENTION array gates the NEXT LINEAGE
  // allocation and can never prevent a grant from resolving (v1.0.32
  // DECOUPLING_PRESERVED) — two independent registries with independent
  // controls.
  //
  // DECLARED BY v1.0.32, REGISTERED HERE. Declaring a grant and registering
  // it are separate governed acts on separate surfaces; v1.0.32 names this
  // very file under EXPLICITLY_NOT_AUTHORIZED for exactly that reason, and
  // the L1 implementation mission is PROHIBITED from performing this act for
  // itself — a node that registers the grant it is about to rely on has
  // authorized its own diff. The bound branch does NOT exist at the time of
  // this registration, which is correct and expected: the grant is declared
  // and registered BEFORE the implementation branch is cut.
  {
    authorityId: 'HPO-ODS-W2-29',
    branch: 'codex/l1-organization-commercial-acceptance-implementation-r1',
    patterns: [
      'db/migrations/**',
      'db/prepared/journal/**',
      'db/prepared/checkpoint-b0/observation.sql',
    ],
  },
  // HPO-ODS-W2-30 — Commercial Account CE-3 entitlement-grant implementation.
  //
  // DECLARED BY docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.33.json,
  // REGISTERED HERE. Declaring a grant and registering it are separate
  // governed acts on separate surfaces: v1.0.33 names THIS file under
  // EXPLICITLY_NOT_AUTHORIZED for exactly that reason, and the CE-3
  // implementation mission is PROHIBITED from performing this act for itself —
  // a node that registers the grant it is about to rely on has authorized its
  // own diff. The bound branch does NOT exist at the time of this
  // registration, which is correct and expected: the grant is declared and
  // registered BEFORE the implementation branch is cut, and appending a row
  // creates no ref.
  //
  // THE THREE PATTERNS ARE RE-DERIVED AND NOT INHERITED. W2-28 and W2-29 carry
  // these same three patterns in this same order, and byte-identical patterns
  // are precisely the case where inheritance is invisible. v1.0.33
  // WHY_THESE_THREE_PATTERNS_RE_DERIVED_NOT_INHERITED therefore re-measures
  // each one against the L1 merge 0d5ea914 — a precedent one generation NEWER
  // than the CL-1 merge the CE-3 execution authority itself used — by
  // git diff --numstat 0d5ea914^1 0d5ea914, never --stat, which abbreviates
  // long paths so a directory-prefix grep under-counts in silence and sums
  // insertions with deletions so a one-line rewrite reads as 2:
  //
  //   1. db/migrations/** — THREE paths moved: the SQL file, its per-ordinal
  //      snapshot and the _journal.json append, all emitted by one drizzle-kit
  //      generate. CE-3 creates the relation entitlement_grants with RLS, so
  //      it produces at least those three and may produce more than one
  //      migration. The ordinal is not knowable in advance, so no literal-path
  //      grant is constructible.
  //
  //   2. db/prepared/journal/** — EIGHTY-FIVE wrapper paths moved, in exactly
  //      two numstat buckets: 84 at (1 insertion, 1 deletion) and 1 at
  //      (65, 0). Each wrapper header carries the literal
  //      Unit <ordinal>/<BASELINE_UNITS.length>, so appending a baseline unit
  //      increments the DENOMINATOR and rewrites that ONE header line in every
  //      pre-existing wrapper; the single (65, 0) row is the NEW wrapper. This
  //      is generated-artefact REGENERATION and not an edit of unrelated
  //      files, and the (1, 1) bucket has grown by exactly one per landed
  //      migration across four consecutive precedents, so the mechanism is
  //      understood rather than merely observed. A grant naming only the new
  //      wrapper would refuse its regenerated siblings, and enumerating
  //      literals that will be one longer next time is a stale list rather
  //      than a grant.
  //
  //   3. db/prepared/checkpoint-b0/observation.sql — moved with (2, 0). The
  //      file builds its rowCounts key from an explicit UNION ALL chain with
  //      ONE ARM PER GOVERNED RELATION and is GENERATED -- DO NOT EDIT, so
  //      adding an arm changes the FILE BYTES and not merely the query output.
  //      W2-27 deliberately EXCLUDED this literal under a rule permitting
  //      inclusion ONLY IF a live re-measurement proves the mission changes
  //      the file; that rule is APPLIED here rather than assumed away. The
  //      discriminator is validated in BOTH directions on real commits —
  //      relation-creating lineages move the file by two lines per relation,
  //      while the index-only P1 lineage leaves the path absent from its
  //      commit entirely. CE-3 creates ONE relation and observation.sql
  //      contains ZERO occurrences of entitlement_grants, so the arm is
  //      genuinely absent and genuinely will be added. A LITERAL and never
  //      db/prepared/checkpoint-b0/**: that directory holds exactly one file,
  //      so even a directory pattern would grant strictly more than the
  //      classifier can justify.
  //
  // NOT db/prepared/**. The DEFAULT protected pattern above IS the broad
  // db/prepared/**, but the breadth of the PROTECTION is not a licence for
  // breadth in the GRANT: a blanket pattern would additionally authorize
  // db/prepared/hosted/** and db/prepared/hosted/governed/**, which are
  // G2-gated apply surfaces CE-3 has no business touching, plus
  // db/prepared/storage/**, db/prepared/checkpoint-a1/corroboration.sql and
  // the separate db/prepared/stella_*.sql numbering family CE-3 does not
  // extend. A sibling under db/prepared/ that matches the default pattern but
  // not these two narrower ones is CORRECTLY refused (v1.0.33
  // NO_DB_PREPARED_WIDENING).
  //
  // NO EXISTING ROW CAN STAND IN — INCLUDING THE BYTE-IDENTICAL W2-28 AND
  // W2-29. MEASURED against this registry rather than asserted: of the
  // SEVENTEEN predecessor rows, TEN carry db/migrations/** and/or
  // db/prepared/journal/** (W2-01, W2-12, W2-17, W2-20, W2-21, W2-25, W2-26,
  // W2-27, W2-28 and W2-29) and SEVEN carry the observation literal (W2-07,
  // W2-08, W2-16, W2-17, W2-26, W2-28 and W2-29 — W2-08 carries it inside its
  // 98-entry literal family). Every one of them is bound to a DIFFERENT
  // branch, and resolution is by exact string equality, so on
  // codex/commercial-account-ce3-implementation-r1 all seventeen contribute
  // ZERO patterns. What separates this row from W2-28 and W2-29 is the BRANCH
  // and nothing else, which is exactly why their pattern rationalisation is
  // NOT reusable here, why the binding is stated as exact-string, and why a
  // duplicate-LOOKING row is doing real work.
  //
  // THIS ROW ALLOCATES NO ORDINAL AND NO CONTROLLER ACT. The migration pattern
  // is a GLOB and never a specific ordinal, so registering this row reserves
  // no number and the implementing mission re-derives one at its OWN head. The
  // Controller IMMUTABLE_BY_CONVENTION array gates the NEXT LINEAGE allocation
  // and can never prevent a grant from resolving (v1.0.32
  // DECOUPLING_PRESERVED) — two independent registries with independent
  // controls, and this act leaves the Controller untouched. Nothing here
  // implements CE-3 or authorizes it to be implemented: no CE-3 runtime
  // exists, and a resolved grant still requires an ordinary --allow pattern
  // covering the same path (v1.0.33 grant_does_not_replace_allow).
  {
    authorityId: 'HPO-ODS-W2-30',
    branch: 'codex/commercial-account-ce3-implementation-r1',
    patterns: [
      'db/migrations/**',
      'db/prepared/journal/**',
      'db/prepared/checkpoint-b0/observation.sql',
    ],
  },
  // HPO-ODS-W2-31 — Commercial Account CE-3 definer-ownership hosted package.
  //
  // DECLARED BY docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.34.json,
  // REGISTERED HERE, by a separate governed act exactly as W2-30 was. v1.0.34
  // carries registration_status DECLARED_NOT_REGISTERED and states that the
  // hosted-package mission MAY NOT register its own grant: a mission that can
  // grant itself a protected surface has no protected surface. That frozen
  // status is a fact about v1.0.34's OWN act and is NOT rewritten by this one.
  //
  // SAME BRANCH AS W2-30, AND THAT CONFERS NOTHING. Both rows name
  // codex/commercial-account-ce3-implementation-r1, but resolution is by
  // SUPPLIED ID and the authorized set is the union of the grants actually
  // named on the command line — never the union of everything bound to the
  // branch. Supplying W2-30 alone leaves both paths below refused, and
  // supplying W2-31 alone leaves all three W2-30 families refused. The two
  // pattern sets are disjoint, so neither row widens the other.
  //
  // TWO EXACT FILE LITERALS, NO GLOB. The filename is frozen in advance by the
  // integrated amendment's FUTURE_HOSTED_SQL_PATH, so a literal is
  // constructible and a glob would grant more than the evidence justifies. The
  // README is the prepared-corpus index — measured across four prior hosted
  // additions, every one of which also touched it. No journal, migration,
  // checkpoint-b0, hosted/** or rollback path is granted; the rollback file in
  // particular is FORBIDDEN by the amendment's FORWARD_ONLY_CONTRACT, so
  // granting it would authorize an act the authority prohibits. As always, a
  // resolved grant still requires an ordinary --allow covering the same path.
  {
    authorityId: 'HPO-ODS-W2-31',
    branch: 'codex/commercial-account-ce3-implementation-r1',
    patterns: [
      'db/prepared/stella_hosted_0009_entitlement_evaluator_ownership.sql',
      'db/prepared/README.md',
    ],
  },
  // HPO-ODS-W2-32 — Commercial Account CE-3 entitlement-grants ACL-hardening
  // hosted package.
  //
  // DECLARED BY docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.35.json,
  // REGISTERED HERE, by a separate governed act exactly as W2-30 and W2-31
  // each were. v1.0.35 carries registration_status DECLARED_NOT_REGISTERED and
  // states THE_IMPLEMENTATION_WRITER_MAY_NOT_SELF_REGISTER: a mission that
  // could grant itself a protected surface has no protected surface, and a
  // hosted0010 writer that finds this row absent must STOP rather than add it,
  // not even if the row it would add is byte-identical. The gate is about
  // PROVENANCE, not content. That frozen status is a historical fact about
  // v1.0.35's OWN act and is NOT rewritten by this one: v1.0.35 still records
  // PROTECTED_GRANTS_CHANGED false, count 19 before and 19 after, and tail
  // W2-31 on both sides, all of which remain true of the act it describes.
  //
  // THIRD ROW ON THE CE-3 BRANCH, AND THAT CONFERS NOTHING. W2-30, W2-31 and
  // this row all name codex/commercial-account-ce3-implementation-r1, and none
  // of them becomes ambient on it. Resolution is by SUPPLIED ID and the
  // authorized set is the union of the grants actually named on the command
  // line — never the union of everything bound to the branch. Supplying W2-30
  // or W2-31 alone leaves both patterns below refused; supplying this row
  // alone leaves W2-30's three families and W2-31's 0009 package refused.
  //
  // TWO EXACT FILE LITERALS, NO GLOB, ORDER BINDING. The filename is frozen in
  // advance and identically by the integrated amendment's FUTURE_HOSTED_SQL_PATH
  // and the node amendment's HOSTED0010_CONTRACT, so a literal IS constructible
  // and a glob would grant strictly more than the evidence justifies. Neither
  // pattern contains a glob metacharacter, so this grant authorizes at most TWO
  // concrete files however the repository grows. The package SQL is first and
  // the README second, matching v1.0.35 ORDER_IS_BINDING, because the
  // registration control asserts this row by whole-object equality and not by
  // set comparison.
  //
  // THE README DUPLICATION IS THE ADJUDICATED OVERLAP AND IS NOT DEDUPLICATED.
  // W2-31 and this row both carry db/prepared/README.md; the intersection is
  // EXACTLY that one pattern, and the intersection with W2-30 is EMPTY. Both
  // packages are hosted prepared packages and every hosted prepared package in
  // this repository documents itself in the prepared-corpus index — four for
  // four across the 0003, 0006, 0007 and 0008 additions. Collapsing the
  // duplicate would silently strip a pattern one of the two packages needs.
  // Sharing a pattern merges nothing: it does not make W2-31's 0009 package
  // reachable through this id, and it does not make the README reachable
  // without naming SOME grant that carries it plus an ordinary --allow.
  //
  // NO THIRD PATTERN. db/migrations/** and db/prepared/journal/** are absent:
  // the journal-wrapper regeneration is driven by appending a BASELINE UNIT,
  // which is what a MIGRATION does, and a hosted prechain package appends none
  // — measured, none of the four precedent commits touched db/prepared/journal/.
  // db/prepared/checkpoint-b0/observation.sql is absent: it gains an arm per
  // governed RELATION and this package is REVOKE-only against two EXISTING
  // objects, so it does not move. W2-30 already covers all three for the
  // relation-creating half of CE-3. db/prepared/stella_hosted_0009_*.sql is
  // absent: it belongs to W2-31, and including it would widen this row into
  // W2-31's surface and defeat the separation that lets each package be
  // certified independently. db/prepared/stella_hosted_0010_rollback.sql is
  // absent and its absence is BINDING rather than an oversight — the integrated
  // FORWARD_ONLY_CONTRACT_0010 fixes ROLLBACK_FILE = NONE and states that
  // writing one would be an act against the amendment, so granting the path
  // would authorize the forbidden act.
  //
  // NOT db/prepared/**. The DEFAULT protected pattern above IS the broad
  // db/prepared/**, but the breadth of the PROTECTION is not a licence for
  // breadth in the GRANT: classifyPaths checks a concrete path against the
  // SUPPLIED grant's own patterns, never against the default that made it
  // protected. A blanket pattern would additionally authorize
  // db/prepared/hosted/** and db/prepared/hosted/governed/**,
  // db/prepared/storage/**, db/prepared/journal/**,
  // db/prepared/checkpoint-a1/corroboration.sql,
  // db/prepared/checkpoint-b0/observation.sql, the rollback sibling the
  // forward-only contract forbids, and the whole stella_NNNN and
  // stella_hosted_NNNN families including W2-31's 0009 package. Measured: ZERO
  // of the twenty rows here carry db/prepared/**, so a blanket grant would also
  // be without precedent.
  //
  // THIS ACT DOES NOT CONSUME THE GRANT IT CREATES. The registration lane's own
  // changed paths — this file and tests/ods/ods-scope.test.ts — are NOT members
  // of DEFAULT_PROTECTED_PATTERNS, so its scope gate runs with an ordinary
  // --allow list and PROTECTED_AUTHORITY=NONE. A registering act that supplied
  // its own new id would have authorized its own diff. The future hosted0010
  // writer MUST supply --protected-authority HPO-ODS-W2-32 explicitly, plus an
  // ordinary --allow covering the same two paths: a resolved grant never
  // replaces --allow.
  {
    authorityId: 'HPO-ODS-W2-32',
    branch: 'codex/commercial-account-ce3-implementation-r1',
    patterns: [
      'db/prepared/stella_hosted_0010_entitlement_grants_acl_hardening.sql',
      'db/prepared/README.md',
    ],
  },
]

export interface ProtectedGrantResolution {
  grant?: ProtectedGrant
  authorityId?: string
  reason: string
}

/**
 * Pure: resolves a --protected-authority id against PROTECTED_GRANTS and
 * the caller's already-known current branch. Returns `grant: undefined`
 * for every failure mode (absent, unknown, or branch-mismatched id) —
 * callers must not distinguish these for authorization purposes, only for
 * diagnostics, so a wrong-branch attempt fails exactly like no id at all.
 */
export function resolveProtectedGrant(authorityId: string | undefined, currentBranch: string): ProtectedGrantResolution {
  if (!authorityId) {
    return { reason: 'no --protected-authority supplied' }
  }
  const grant = PROTECTED_GRANTS.find((g) => g.authorityId === authorityId)
  if (!grant) {
    return { authorityId, reason: `unknown protected authority "${authorityId}"` }
  }
  if (grant.branch !== currentBranch) {
    return { authorityId, reason: `"${authorityId}" is granted on branch "${grant.branch}", not current branch "${currentBranch}"` }
  }
  return { grant, authorityId, reason: `"${authorityId}" resolved on branch "${currentBranch}"` }
}

/**
 * COMMERCIAL_V1_POST_INTEGRATION_MAINTENANCE_AUTHORITY_v1.0.0.json (M1):
 * resolves zero or more --protected-authority ids, each INDEPENDENTLY via
 * `resolveProtectedGrant` (no reimplemented resolution logic). Every
 * resolution is returned for diagnostics; `grants` collects only the ones
 * that actually resolved, in input order, WITHOUT deduplicating — a
 * duplicate id resolves to the same grant twice, which `classifyPaths`'s
 * `.some()` union check treats identically to resolving it once
 * (deterministic, no double-counting). An id that fails to resolve
 * contributes nothing to `grants`; it never broadens, narrows, or
 * invalidates what any OTHER supplied id resolved. Passing a single id
 * behaves exactly like the singular `resolveProtectedGrant` wrapped in a
 * one-element array.
 */
export function resolveProtectedGrants(
  authorityIds: string[],
  currentBranch: string,
): { resolutions: ProtectedGrantResolution[]; grants: ProtectedGrant[] } {
  const resolutions = authorityIds.map((id) => resolveProtectedGrant(id, currentBranch))
  const grants = resolutions.map((r) => r.grant).filter((g): g is ProtectedGrant => g !== undefined)
  return { resolutions, grants }
}

// ---------------------------------------------------------------------------
// NUL-delimited git output parsing. Robust against filenames with spaces —
// a measured Windows/portability hazard for this project.
// ---------------------------------------------------------------------------

export interface ChangedPathEntry {
  status: string
  path: string
  oldPath?: string
}

/** Parses `git diff --name-status -z <a> <b>` output. Rename/copy records ("R###"/"C###") carry both old and new paths. */
export function parseDiffNameStatusZ(raw: string): ChangedPathEntry[] {
  const tokens = raw.split('\0').filter((t) => t.length > 0)
  const entries: ChangedPathEntry[] = []
  let i = 0
  while (i < tokens.length) {
    const status = tokens[i++]
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[i++]
      const newPath = tokens[i++]
      entries.push({ status, path: newPath, oldPath })
    } else {
      const p = tokens[i++]
      entries.push({ status, path: p })
    }
  }
  return entries
}

/** Parses `git status --porcelain=v1 --find-renames -z` output. */
export function parseStatusPorcelainZ(raw: string): ChangedPathEntry[] {
  const tokens = raw.split('\0').filter((t) => t.length > 0)
  const entries: ChangedPathEntry[] = []
  let i = 0
  while (i < tokens.length) {
    const record = tokens[i++]
    const xy = record.slice(0, 2)
    const p = record.slice(3)
    if (xy.includes('R') || xy.includes('C')) {
      const oldPath = tokens[i++]
      entries.push({ status: xy, path: p, oldPath })
    } else {
      entries.push({ status: xy, path: p })
    }
  }
  return entries
}

/** All paths a set of entries touches — both endpoints of a rename/copy included. */
export function allTouchedPaths(entries: ChangedPathEntry[]): string[] {
  const paths: string[] = []
  for (const e of entries) {
    paths.push(e.path)
    if (e.oldPath) paths.push(e.oldPath)
  }
  return paths
}

// ---------------------------------------------------------------------------
// Git-backed I/O.
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Current branch, read fresh from git — never trusted from a caller-supplied claim. */
export function getCurrentBranch(cwd: string): string {
  const res = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (res.code !== 0) throw new Error(`git rev-parse --abbrev-ref HEAD failed: ${res.stderr}`)
  return res.stdout.trim()
}

/** All paths touched since `base`: committed (base..HEAD), staged, unstaged, and untracked. */
export function collectChangedPaths(cwd: string, base: string): string[] {
  const committed = git(cwd, ['diff', '--name-status', '--find-renames', '-z', base, 'HEAD'])
  if (committed.code !== 0) throw new Error(`git diff --name-status ${base} HEAD failed: ${committed.stderr}`)

  // --untracked-files=all: without it, git summarizes a whole new untracked
  // directory as one entry (e.g. "lib/") instead of listing the files inside
  // it, which would let an unauthorized file hide behind an allowed sibling.
  const uncommitted = git(cwd, ['status', '--porcelain=v1', '--find-renames', '--untracked-files=all', '-z'])
  if (uncommitted.code !== 0) throw new Error(`git status --porcelain failed: ${uncommitted.stderr}`)

  return [...allTouchedPaths(parseDiffNameStatusZ(committed.stdout)), ...allTouchedPaths(parseStatusPorcelainZ(uncommitted.stdout))]
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ScopeArgs {
  base?: string
  allow: string[]
  /** Every --protected-authority occurrence, in input order, unresolved and undeduplicated. See resolveProtectedGrants. */
  protectedAuthorities: string[]
}

// HPO-ODS-M1D CLI hygiene: recognized flags, used only to detect whether a
// --protected-authority operand slot was actually consumed by another flag
// rather than a real identifier. Scoped narrowly to this one flag per the
// authorizing addendum — --base/--allow's existing (weaker) operand
// handling is explicitly out of scope for this remediation.
const SCOPE_RECOGNIZED_FLAGS = new Set(['--base', '--allow', '--protected-authority'])

function looksLikeMissingProtectedAuthorityOperand(token: string | undefined): boolean {
  return token === undefined || token === '--' || SCOPE_RECOGNIZED_FLAGS.has(token)
}

function parseArgs(argv: string[]): ScopeArgs {
  const result: ScopeArgs = { allow: [], protectedAuthorities: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue // see scripts/ods-prestate.ts for why
    if (arg === '--base') result.base = argv[++i]
    else if (arg === '--allow') result.allow.push(argv[++i])
    else if (arg === '--protected-authority') {
      const value = argv[i + 1]
      if (looksLikeMissingProtectedAuthorityOperand(value)) {
        console.error('ods:scope: --protected-authority requires a value')
        process.exit(2)
      }
      i++
      // Repeatable: each occurrence appends one id (M1). A single
      // occurrence is byte-identical in effect to the prior scalar field.
      result.protectedAuthorities.push(value)
    } else {
      console.error(`ods:scope: unrecognized argument "${arg}"`)
      process.exit(2)
    }
  }
  return result
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args.base) {
    console.error('ods:scope: --base <sha> is required')
    console.log('ODS_SCOPE=USAGE_ERROR')
    process.exit(2)
  }

  const cwd = process.cwd()
  const currentBranch = getCurrentBranch(cwd)
  const { resolutions, grants } = resolveProtectedGrants(args.protectedAuthorities, currentBranch)

  const changed = collectChangedPaths(cwd, args.base)
  const unique = [...new Set(changed)]
  const result = classifyPaths(unique, DEFAULT_PROTECTED_PATTERNS, args.allow, grants)

  const lines: string[] = []
  lines.push(`SCOPE_BASE=${args.base}`)
  lines.push(`CHANGED_FILE_COUNT=${unique.length}`)
  // Single-id invocations render byte-identically to prior versions
  // (join of one element == that element; exactly one reason line).
  lines.push(`PROTECTED_AUTHORITY=${resolutions.length > 0 ? resolutions.map((r) => r.authorityId ?? 'NONE').join(',') : 'NONE'}`)
  for (const r of resolutions) lines.push(`  ${r.reason}`)
  lines.push(`PROTECTED_AUTHORIZED_PATH_COUNT=${result.grantAuthorized.length}`)
  for (const p of result.protectedViolations) lines.push(`PROTECTED_PATH_VIOLATION=${p}`)
  for (const p of result.nonCanonicalProtectedPaths) lines.push(`NON_CANONICAL_PROTECTED_PATH=${p}`)
  for (const p of result.unauthorized) lines.push(`UNAUTHORIZED_PATH=${p}`)
  lines.push(`PROTECTED_PATH_VIOLATIONS=${result.protectedViolations.length}`)
  lines.push(`NON_CANONICAL_PROTECTED_PATHS=${result.nonCanonicalProtectedPaths.length}`)
  lines.push(`UNAUTHORIZED_PATHS=${result.unauthorized.length}`)

  const pass =
    result.protectedViolations.length === 0 && result.nonCanonicalProtectedPaths.length === 0 && result.unauthorized.length === 0
  lines.push(`ODS_SCOPE=${pass ? 'PASS' : 'FAIL'}`)
  console.log(lines.join('\n'))
  process.exit(pass ? 0 : 1)
}

// Only when run as a script — tests/ods/ods-scope.test.ts imports the pure
// functions above. See scripts/authority-seal-verify.ts for why argv is
// checked rather than `import.meta.url`.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ods-scope.ts')

if (invokedDirectly) main()

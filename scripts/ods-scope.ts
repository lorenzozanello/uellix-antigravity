// scripts/ods-scope.ts — ODS-C4, the explicit forbidden-scope/diff gate.
//
//   pnpm ods:scope --base <sha> --allow <path-or-pattern> [--allow ...]
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
 * patterns, and an optional already-resolved protected-surface grant.
 *
 * `grant` must already be branch-validated by the caller (see
 * `resolveProtectedGrant`) — this function only checks whether the
 * CONCRETE path matches one of the grant's own patterns, never the
 * broader default protected pattern that made the path protected in the
 * first place. That is what keeps a grant for db/prepared/journal/**
 * from ever authorizing db/prepared/sibling.sql: the sibling matches
 * DEFAULT_PROTECTED_PATTERNS' db/prepared/** but not the grant's own
 * narrower db/prepared/journal/**.
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
  grant?: ProtectedGrant,
): ScopeClassification {
  const protectedViolations: string[] = []
  const unauthorized: string[] = []
  const ok: string[] = []
  const grantAuthorized: string[] = []
  const nonCanonicalProtectedPaths: string[] = []

  for (const p of new Set(paths)) {
    if (matchesAnyPattern(p, protectedPatterns)) {
      // Protected by default (canonical casing). Authorized ONLY if the
      // grant's own (narrower) patterns cover this exact path AND the
      // ordinary task --allow also covers it — both mandatory, neither
      // can stand in for the other.
      const grantCovers = grant !== undefined && matchesAnyPattern(p, grant.patterns)
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
  protectedAuthority?: string
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
  const result: ScopeArgs = { allow: [] }
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
      result.protectedAuthority = value
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
  const grantResolution = resolveProtectedGrant(args.protectedAuthority, currentBranch)

  const changed = collectChangedPaths(cwd, args.base)
  const unique = [...new Set(changed)]
  const result = classifyPaths(unique, DEFAULT_PROTECTED_PATTERNS, args.allow, grantResolution.grant)

  const lines: string[] = []
  lines.push(`SCOPE_BASE=${args.base}`)
  lines.push(`CHANGED_FILE_COUNT=${unique.length}`)
  lines.push(`PROTECTED_AUTHORITY=${grantResolution.authorityId ?? 'NONE'}`)
  if (args.protectedAuthority) lines.push(`  ${grantResolution.reason}`)
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

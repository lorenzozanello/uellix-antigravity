// lib/stella/consent/versions.ts
// Etapa A2.1 (STL-A21-002, DR-005 aprobado 2026-07-25) — single source of
// truth for the currently-in-force AI terms and data-governance-policy
// versions, plus the fixed capability scope used by the first pass of
// consent (global authorization for all of Stella, not per-role — see
// STELLA_A2_DR005_IMPLEMENTATION_REPORT.md#3 for why a finer-grained scope
// would be false granularity the UI cannot manage yet).
//
// Bump these ONLY when the actual terms text or data policy materially
// changes (see STELLA_AI_DATA_GOVERNANCE_POLICY_DRAFT.md) — never
// automatically, never from a date. A version bump here means every
// organization's existing acceptance becomes 'outdated' until a new
// organization_admin re-accepts (lib/stella/consent/consent-status.ts).
// Nothing else in the codebase should hardcode these version strings.

export const STELLA_AI_TERMS_VERSION = 'v1'
export const STELLA_DATA_POLICY_VERSION = 'v1'

/** First-pass scope: acceptance authorizes all of Stella, not individual roles. */
export const STELLA_CONSENT_SCOPE_ALL: readonly string[] = ['all']

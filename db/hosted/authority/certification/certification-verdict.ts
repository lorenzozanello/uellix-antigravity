// db/hosted/authority/certification/certification-verdict.ts
// F-1 — what COMPLETE means, as a conjunction that can be tested without Docker.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS CLOSES
// ---------------------------------------------------------------------------
// `scripts/pg176-certify.ts` computed its verdict from ONE predicate:
//
//     report.verdict = chainComplete ? 'COMPLETE' : 'CHAIN_INCOMPLETE_INJECTIONS_RUN'
//
// The refusal exercises and the failure injections were RECORDED beside it and
// gated nothing. So when the unknown-package probe stopped refusing — M-8 made
// its literal `'T10'` a real package — the artefact carried
//
//     "id": "UNKNOWN_PACKAGE", "refused": false
//     "verdict": "COMPLETE"
//
// at the same time, and that file is versioned evidence. A negative control
// that cannot fail the run is decoration; the fix is not a better probe, it is
// putting the probe inside the verdict.
//
// ---------------------------------------------------------------------------
// WHY IT IS A PURE FUNCTION AND NOT AN `if` IN THE SCRIPT
// ---------------------------------------------------------------------------
// So that "a resolving unknown package makes COMPLETE impossible" is a test
// somebody can run in three milliseconds without a 2 GB image, and so the
// predicate set can be written into the artefact next to the verdict it
// produced. A verdict that does not say what it required cannot be audited for
// the thing that went wrong here.

import { REQUIRED_REFUSAL_IDS } from './refusal-exercises'

/** The observations the verdict is a function of. Nothing else may enter it. */
export interface CertificationEvidence {
  /** Baseline units + bootstrap + sentinel all landed. */
  readonly provisioningComplete: boolean
  /** Every chain package measured ABSENT before the chain ran. */
  readonly prechainClean: boolean
  /** The derived object-authority contract held before a governed statement ran. */
  readonly prechainAuthorityGatePassed: boolean
  /** Every declared package applied and measured INSTALLED. */
  readonly chainComplete: boolean
  /**
   * M-2. The Storage role matrix, driven through the REAL storage.objects
   * policies on the final managed shape.
   *
   * SEPARATE FROM `chainComplete` because the two are independent, and that
   * independence is the whole finding: T11 was measured INSTALLED — function
   * present, four roles in the body, owner and ACL intact, all three policies
   * untouched — on a database where every one of the nine cases was refused,
   * because uellix_owner could not SELECT public.organization_members and the
   * helper bodies swallow their own permission error. Structural witnesses
   * cannot see that. COMPLETE now requires calling the thing.
   */
  readonly storageFunctionalProbe: { readonly ran: boolean; readonly passed: boolean; readonly detail: string }
  readonly refusals: readonly { readonly id: string; readonly refused: boolean }[]
  readonly injections: readonly {
    readonly id: string
    readonly failed: boolean
    readonly rolledBack: boolean
  }[]
}

export type CertificationPredicateId =
  | 'PROVISIONING_COMPLETE'
  | 'PRECHAIN_CLEAN'
  | 'PRECHAIN_AUTHORITY_GATE_PASSED'
  | 'CHAIN_COMPLETE'
  | 'STORAGE_HELPER_FUNCTIONAL_PROBE'
  | 'ALL_REQUIRED_REFUSALS_REFUSED'
  | 'ALL_FAILURE_INJECTIONS_FAILED_AND_ROLLED_BACK'

export interface CertificationPredicate {
  readonly id: CertificationPredicateId
  readonly holds: boolean
  /** What was required and what was observed. Written into the artefact. */
  readonly detail: string
}

/**
 * The verdict a failing predicate produces.
 *
 * The first four are the strings the harness ALREADY emitted, kept exactly:
 * existing artefacts, runbooks and the status scripts read them, and renaming
 * a verdict while fixing a gate would be two changes wearing one commit.
 */
const VERDICT_WHEN_FAILED: Readonly<Record<CertificationPredicateId, string>> = {
  PROVISIONING_COMPLETE: 'PROVISIONING_FAILED',
  PRECHAIN_CLEAN: 'PRECHAIN_INVALID',
  PRECHAIN_AUTHORITY_GATE_PASSED: 'PRECHAIN_AUTHORITY_GATE_FAILED',
  CHAIN_COMPLETE: 'CHAIN_INCOMPLETE_INJECTIONS_RUN',
  // A NEW string, deliberately: a chain that installed and a surface that
  // denies everyone are different outcomes, and collapsing the second into
  // CHAIN_INCOMPLETE would say the installation failed when it did not — which
  // is the sentence that would send the next reader to the wrong place.
  STORAGE_HELPER_FUNCTIONAL_PROBE: 'STORAGE_HELPER_FUNCTIONAL_PROBE_FAILED',
  ALL_REQUIRED_REFUSALS_REFUSED: 'REQUIRED_REFUSAL_NOT_REFUSED',
  ALL_FAILURE_INJECTIONS_FAILED_AND_ROLLED_BACK: 'FAILURE_INJECTION_NOT_CONTAINED',
}

/**
 * Every required refusal was ATTEMPTED and REFUSED.
 *
 * Absence fails the same way `refused: false` does. Without that, deleting the
 * exercise would be a way to pass it — and the exercise that broke is exactly
 * the one a future edit would be tempted to delete.
 */
function refusalsHold(evidence: CertificationEvidence): CertificationPredicate {
  const missing: string[] = []
  const notRefused: string[] = []
  for (const id of REQUIRED_REFUSAL_IDS) {
    const recorded = evidence.refusals.find((r) => r.id === id)
    if (recorded === undefined) missing.push(id)
    else if (!recorded.refused) notRefused.push(id)
  }
  return {
    id: 'ALL_REQUIRED_REFUSALS_REFUSED',
    holds: missing.length === 0 && notRefused.length === 0,
    detail:
      `required: ${REQUIRED_REFUSAL_IDS.join(', ')}` +
      (missing.length > 0 ? `; NOT ATTEMPTED: ${missing.join(', ')}` : '') +
      (notRefused.length > 0 ? `; RESOLVED INSTEAD OF REFUSING: ${notRefused.join(', ')}` : ''),
  }
}

/**
 * Every injection made its package fail AND left its witnessed state unchanged.
 *
 * `failed` alone also covers the SKIPPED case, which records `failed: false`:
 * an injection whose prerequisite state the chain never reached measured
 * nothing, and counting it would be counting an absence as a pass.
 */
function injectionsHold(evidence: CertificationEvidence): CertificationPredicate {
  const uncontained = evidence.injections.filter((i) => !i.failed || !i.rolledBack)
  return {
    id: 'ALL_FAILURE_INJECTIONS_FAILED_AND_ROLLED_BACK',
    holds: evidence.injections.length > 0 && uncontained.length === 0,
    detail:
      `${evidence.injections.length - uncontained.length}/${evidence.injections.length} failed and rolled back` +
      (uncontained.length > 0 ? `; NOT CONTAINED: ${uncontained.map((i) => i.id).join(', ')}` : ''),
  }
}

/** The full conjunction, in the order a run establishes it. */
export function certificationPredicates(
  evidence: CertificationEvidence,
): readonly CertificationPredicate[] {
  return [
    {
      id: 'PROVISIONING_COMPLETE',
      holds: evidence.provisioningComplete,
      detail: 'baseline units, bootstrap and the staging sentinel all applied',
    },
    {
      id: 'PRECHAIN_CLEAN',
      holds: evidence.prechainClean,
      detail: 'every chain package measured ABSENT before the first governed statement',
    },
    {
      id: 'PRECHAIN_AUTHORITY_GATE_PASSED',
      holds: evidence.prechainAuthorityGatePassed,
      detail: 'the derived object-authority contract held, with zero refusals',
    },
    {
      id: 'CHAIN_COMPLETE',
      holds: evidence.chainComplete,
      detail: 'every declared package applied and measured INSTALLED',
    },
    {
      id: 'STORAGE_HELPER_FUNCTIONAL_PROBE',
      // `ran && passed`, never `passed` alone. A probe that did not run reports
      // passed=false already, but stating the conjunction here means a future
      // shape that forgets to set one of the two cannot default into a pass.
      holds: evidence.storageFunctionalProbe.ran && evidence.storageFunctionalProbe.passed,
      detail: `the Storage role matrix, driven through the real storage.objects policies — ${evidence.storageFunctionalProbe.detail}`,
    },
    refusalsHold(evidence),
    injectionsHold(evidence),
  ]
}

/**
 * COMPLETE, or the name of the FIRST predicate that did not hold.
 *
 * First rather than a list because the verdict is one string in an artefact
 * many things read; the full predicate set is recorded alongside it, so nothing
 * is lost by the collapse.
 */
export function certificationVerdict(evidence: CertificationEvidence): string {
  const failed = certificationPredicates(evidence).find((p) => !p.holds)
  return failed === undefined ? 'COMPLETE' : VERDICT_WHEN_FAILED[failed.id]
}

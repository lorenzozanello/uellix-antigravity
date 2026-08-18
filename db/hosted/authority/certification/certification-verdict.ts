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
  /**
   * G1-B. The administrative units whose apply window is POSTCHAIN.
   *
   * SEPARATE FROM `chainComplete`, and separate from the prechain units, for
   * the reason the whole file exists: the harness APPLIED them and recorded the
   * result beside a verdict that could not see it. A run where
   * `stella_0020` aborted and every other predicate held reported COMPLETE and
   * exited 0 — the same shape as the UNKNOWN_PACKAGE defect this module was
   * written to close, one window later.
   *
   * `ran` is not redundant with `allApplied`. An empty apply set satisfies
   * `every()` vacuously, so a future edit that stopped invoking the loop would
   * pass `allApplied` while measuring nothing. Both are required, and only when
   * there was a complete chain to apply them onto.
   */
  readonly postchainAdministrative: { readonly ran: boolean; readonly allApplied: boolean }
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
  | 'POSTCHAIN_ADMINISTRATIVE_UNITS_APPLIED'
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
  // A NEW string, for the same reason STORAGE_HELPER_FUNCTIONAL_PROBE has one:
  // a chain that installed and an administrative unit that refused after it are
  // different outcomes, and reporting the second as CHAIN_INCOMPLETE would send
  // the next reader to look at the chain, which is fine.
  POSTCHAIN_ADMINISTRATIVE_UNITS_APPLIED: 'POSTCHAIN_ADMINISTRATIVE_UNIT_FAILED',
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
 * The token every harness in this repository reads as "this gate did not hold".
 *
 * Exported so that the value `administrativeUnitVerdicts()` PRODUCES and the
 * value `scripts/remediation-certify.ts` FILTERS ON are the same constant
 * rather than two spellings that agree today. A gate that emits `'FAILED'`
 * into a filter looking for `'FAIL'` is silent, passes, and looks correct in
 * review — which is the shape of the defect this whole delta is fixing.
 */
export const HARNESS_FAIL = 'FAIL'

/** PASS, FAIL, or "the chain did not get far enough for this to mean anything". */
export type AdministrativeUnitVerdict = 'PASS' | typeof HARNESS_FAIL | 'SKIPPED_CHAIN_INCOMPLETE'

/** One window's outcome: was the whole declared set attempted, and did it apply. */
export interface AdministrativeWindowOutcome {
  readonly ran: boolean
  readonly allApplied: boolean
}

export interface AdministrativeUnitEvidence {
  readonly chainComplete: boolean
  readonly prechain: AdministrativeWindowOutcome
  readonly postchain: AdministrativeWindowOutcome
}

export interface AdministrativeUnitVerdicts {
  readonly PRECHAIN_ADMINISTRATIVE_UNITS: AdministrativeUnitVerdict
  readonly POSTCHAIN_ADMINISTRATIVE_UNITS: AdministrativeUnitVerdict
}

/**
 * The two administrative windows, as verdict tokens the remediation harness
 * already knows how to fail on.
 *
 * A PURE FUNCTION for the same reason `certificationVerdict` is one: the defect
 * being closed is that these facts were MEASURED and then not read, and a rule
 * living inline in a 1400-line script is a rule nobody can test in three
 * milliseconds. `scripts/remediation-certify.ts` calls this in two places — its
 * `--only=chain` early return and its full verdict record — so those two cannot
 * drift into judging the same two facts differently.
 *
 * ASYMMETRY, and it is deliberate: PRECHAIN is unconditional because it runs
 * BEFORE the chain, so a failure there is a failure whatever the chain then
 * does. POSTCHAIN is conditional because it runs after, so on an incomplete
 * chain there was nothing to apply it onto — and that is reported as SKIPPED,
 * never as PASS. The incomplete chain is failed by the chain's own verdict.
 */
export function administrativeUnitVerdicts(
  evidence: AdministrativeUnitEvidence,
): AdministrativeUnitVerdicts {
  const holds = (w: AdministrativeWindowOutcome): boolean => w.ran && w.allApplied
  return {
    PRECHAIN_ADMINISTRATIVE_UNITS: holds(evidence.prechain) ? 'PASS' : HARNESS_FAIL,
    POSTCHAIN_ADMINISTRATIVE_UNITS: !evidence.chainComplete
      ? 'SKIPPED_CHAIN_INCOMPLETE'
      : holds(evidence.postchain)
        ? 'PASS'
        : HARNESS_FAIL,
  }
}

/**
 * The POSTCHAIN administrative units all applied — when there was a chain to
 * apply them onto.
 *
 * EXPORTED, and that is not incidental. `scripts/pg176-certify.ts` has an
 * early return for `--only=chain` that produces its own verdict string, and
 * that return sits AFTER the postchain apply: a run under that flag mutates the
 * primary and then reports on it. Rather than write a second rule there — which
 * is how one gate becomes two that disagree — the early return calls THIS
 * function and reports the same predicate under the same name.
 *
 * `chainComplete` is a parameter rather than a captured value because the
 * conditional is the whole contract: an incomplete chain must not be turned
 * into a postchain failure (CHAIN_COMPLETE already fails, and it is ordered
 * first), and must not be turned into a postchain PASS either. It is NOT
 * APPLICABLE, and the detail says so instead of pretending a measurement
 * happened.
 */
export function postchainAdministrativeHolds(
  evidence: Pick<CertificationEvidence, 'chainComplete' | 'postchainAdministrative'>,
): CertificationPredicate {
  const { ran, allApplied } = evidence.postchainAdministrative
  if (!evidence.chainComplete) {
    return {
      id: 'POSTCHAIN_ADMINISTRATIVE_UNITS_APPLIED',
      holds: true,
      detail:
        'NOT APPLICABLE: the chain did not complete, so there was no certified shape to apply a ' +
        'postchain unit onto. CHAIN_COMPLETE is the predicate that fails here, and it is ordered ' +
        'before this one so the verdict names the real blocker.',
    }
  }
  return {
    id: 'POSTCHAIN_ADMINISTRATIVE_UNITS_APPLIED',
    holds: ran && allApplied,
    detail: ran
      ? allApplied
        ? 'every postchain administrative unit applied cleanly after the chain'
        : 'a postchain administrative unit did NOT apply — see postchainAdministrative.units'
      : 'the chain completed but the postchain administrative units were NEVER RUN, so nothing was measured',
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
    // Ordered immediately AFTER CHAIN_COMPLETE, and before the functional
    // probe: the postchain units are the last thing applied to the shape the
    // probe then drives, so a reader following the list reads the run in the
    // order it happened.
    postchainAdministrativeHolds(evidence),
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

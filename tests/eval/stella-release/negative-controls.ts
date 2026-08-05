// tests/eval/stella-release/negative-controls.ts
// RELEASE line — the adversarial half of every check
// (STELLA_RELEASE_EVALUATION_HARDENING_TRAIN_2, Fase 2).
//
// WHY THIS FILE EXISTS
//
// The train 1 adversarial review found two checks (B-M4, B-M5) that asserted a
// property about the system while only ever evaluating data the check itself
// had just constructed. Both were green and both would have stayed green
// through the exact regression they claimed to guard: B-M4 passed with all
// thirteen CAP files truncated to zero bytes, B-M5 matched a regex against two
// string literals written three lines above it.
//
// Rewriting those two functions would not have prevented the third one. The
// defect is structural, so the fix is structural: a check no longer proves
// anything by returning ok. It must ALSO demonstrate that it rejects an input
// where the property is deliberately broken. The two runs go through the SAME
// evaluator — a negative control that calls different code than the check is
// worth nothing.
//
// Consequence, enforced by `withNegativeControls` below: a check that passes
// while its own mutation also passes is reported as `system-error` with a
// TAUTOLOGICAL prefix. It fails the harness and it fails the process. That is
// the intended severity — a check that cannot fail is worse than a missing
// check, because it reports coverage that does not exist.

/** A single mutated-input probe attached to a check. */
export interface NegativeControlResult {
  controlId: string
  /** The property the mutation breaks, in one sentence. */
  property: string
  /** True when the mutated input WAS rejected — i.e. the check discriminates. */
  detected: boolean
  detail: string
}

export type NegativeControlProbe = () => { detected: boolean; detail: string }

function describeThrown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Runs one probe. A probe that throws counts as NOT detected: an exception
 * means the control could not establish that the check discriminates, and
 * "could not establish" must never read as "established".
 */
export function runNegativeControl(
  controlId: string,
  property: string,
  probe: NegativeControlProbe,
): NegativeControlResult {
  try {
    const { detected, detail } = probe()
    return { controlId, property, detected, detail }
  } catch (error) {
    return {
      controlId,
      property,
      detected: false,
      detail: `control probe threw before it could establish detection: ${describeThrown(error)}`,
    }
  }
}

/**
 * For evaluators that report problems as a list of strings: the mutation is
 * detected exactly when the same evaluator returns at least one violation.
 */
export function controlExpectsViolations(
  controlId: string,
  property: string,
  evaluate: () => readonly string[],
): NegativeControlResult {
  return runNegativeControl(controlId, property, () => {
    const violations = evaluate()
    return violations.length > 0
      ? { detected: true, detail: `mutation rejected with ${violations.length} violation(s): ${violations.join(' | ')}` }
      : { detected: false, detail: 'mutation produced ZERO violations — the evaluator cannot see the property it claims to measure' }
  })
}

/**
 * For evaluators that reject by throwing: the mutation is detected exactly
 * when the expected error type is thrown. A different error type is NOT a
 * detection — rejecting for the wrong reason is how a check keeps passing
 * after the reason it was written for has stopped applying.
 */
export function controlExpectsThrow(
  controlId: string,
  property: string,
  expectedError: new (...args: never[]) => Error,
  act: () => unknown,
): NegativeControlResult {
  return runNegativeControl(controlId, property, () => {
    try {
      act()
      return { detected: false, detail: `mutation was ACCEPTED — expected ${expectedError.name}` }
    } catch (error) {
      if (error instanceof expectedError) {
        return { detected: true, detail: `mutation rejected with ${describeThrown(error)}` }
      }
      return { detected: false, detail: `rejected for the wrong reason (expected ${expectedError.name}): ${describeThrown(error)}` }
    }
  })
}

/** For boolean discriminators: detected when the mutated input flips the verdict. */
export function controlExpectsVerdict(
  controlId: string,
  property: string,
  actual: () => boolean,
  expected: boolean,
): NegativeControlResult {
  return runNegativeControl(controlId, property, () => {
    const verdict = actual()
    return verdict === expected
      ? { detected: true, detail: `mutated input correctly evaluated to ${verdict}` }
      : { detected: false, detail: `mutated input evaluated to ${verdict}, expected ${expected} — detector does not discriminate` }
  })
}

export function undetectedControls(controls: readonly NegativeControlResult[]): NegativeControlResult[] {
  return controls.filter((c) => !c.detected)
}

/** Stable, human-readable rendering of the controls that failed to detect. */
export function describeUndetected(controls: readonly NegativeControlResult[]): string {
  return undetectedControls(controls)
    .map((c) => `${c.controlId} (${c.property}) → ${c.detail}`)
    .join('; ')
}

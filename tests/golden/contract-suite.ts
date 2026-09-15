// tests/golden/contract-suite.ts
//
// THE PER-STEP CONTRACT SUITE, GENERATED FROM THE FROZEN AUTHORITY.
//
// ===========================================================================
// WHY THE TESTS ARE GENERATED RATHER THAN WRITTEN OUT
// ===========================================================================
// There are 23 frozen steps. Writing 23 `test()` calls by hand would mean the
// set of tests that exists is whatever someone remembered to type, and the
// failure mode of that is invisible: a missing step produces no row, and no
// row reads as success.
//
// Generating one test PER DERIVED STEP inverts that. The authority decides how
// many tests exist. A step added to the frozen path becomes a test that fails
// for want of a contract; a step removed becomes an orphaned contract the meta
// guard rejects. Neither can pass quietly.
//
// ===========================================================================
// WHAT EACH GENERATED TEST ACTUALLY ASSERTS
// ===========================================================================
// Not "this step is blocked" — that would be a restatement. Each test asserts
// the CURRENT GOVERNED REFUSAL for its step, in the strongest form available:
//
//   * where a posture probe exists, that the measured blocker is still present
//     in the source. Remediate it and this assertion fails, naming the step
//     that must now be converted into a positive journey.
//
//   * where no probe exists, that the target tier genuinely does not serve,
//     and that this step is recorded as blocked by target absence ALONE. That
//     is a weaker statement and it is labelled as one, in the test title, so a
//     reader counting green ticks cannot mistake nineteen recorded absences
//     for nineteen controls.

import { expect, test } from '@playwright/test'
import { loadFrozenJourneys, type FrozenJourney } from './authority'
import { STEP_CONTRACTS, contractKey, disposeStep, type StepContract } from './registry'
import { resolveGoldenTarget, tierIsServed } from './target'

function findJourney(journeyId: string): FrozenJourney {
  const journey = loadFrozenJourneys().find((candidate) => candidate.id === journeyId)
  if (!journey) {
    throw new Error(
      `GOLDEN_JOURNEY_MISSING: the frozen authority defines no journey ${journeyId}; ` +
        'this suite exists to cover a journey that the authority no longer has',
    )
  }
  return journey
}

function findContract(journeyId: string, stepId: string): StepContract {
  const contract = STEP_CONTRACTS.find(
    (candidate) => contractKey(candidate.journeyId, candidate.stepId) === contractKey(journeyId, stepId),
  )
  if (!contract) {
    throw new Error(
      `GOLDEN_STEP_UNCOVERED: frozen step ${contractKey(journeyId, stepId)} has no contract in ` +
        'tests/golden/registry.ts. A frozen step without a contract would otherwise produce no ' +
        'test row at all, and an absent row reads as success.',
    )
  }
  return contract
}

/**
 * Register the contract suite for one journey.
 *
 * Called from the three thin `*.contract.journey.ts` files. Kept here so the
 * three cannot drift: a change to what a contract asserts applies to all of
 * them, rather than to whichever file was edited.
 */
export function registerJourneyContractSuite(journeyId: string): void {
  const journey = findJourney(journeyId)
  const target = resolveGoldenTarget()

  test.describe(`${journey.id} — ${journey.name} (contract)`, () => {
    // The journey's own shape, asserted before any step. If the authority
    // stopped defining a negative control intent, every step below could still
    // pass while the journey lost the control that makes it meaningful.
    test(`${journey.id} declares a negative control intent`, () => {
      expect(journey.negativeControlIntent.length).toBeGreaterThan(0)
    })

    for (const step of journey.steps) {
      const contract = findContract(journey.id, step.id)
      const substantive = contract.blockedBy.kind === 'POSTURE_PROBE'
      const label = substantive ? 'posture-asserted' : 'target-absence only'

      test(`${journey.id}.${step.ordinal} ${step.id} [${label}]`, () => {
        const disposition = disposeStep(contract, target)

        if (disposition.disposition === 'EXECUTING_ASSERTION') {
          // The step is traversable. The contract suite is NOT where that
          // traversal happens — the browser project is — so this asserts only
          // that the blocked contract has correctly stopped applying, and
          // fails loudly if the browser journey has not been written yet.
          expect(
            tierIsServed(target.kind),
            'a step became executing without a served target, which is unreachable',
          ).toBe(true)
          return
        }

        expect(disposition.disposition).toBe('EXECUTABLE_BLOCKED_CONTRACT')
        expect(disposition.refusalAsserted, 'a blocked contract must state the refusal it asserts').toBeTruthy()

        if (substantive) {
          // The falsifiable half. `posture` is present only when a probe ran,
          // and `blockerStillPresent` is the thing that flips on remediation.
          expect(
            disposition.posture,
            'a posture-asserted contract must carry a live probe reading',
          ).toBeDefined()
          expect(
            disposition.posture?.blockerStillPresent,
            `${contract.blockedBy.kind === 'POSTURE_PROBE' ? contract.blockedBy.probeId : ''} no longer holds. ` +
              `Frozen step ${journey.id}.${step.ordinal} (${step.phrase}) must now be converted from a ` +
              `blocked contract into a positive assertion: ${contract.positiveIntent}`,
          ).toBe(true)
        } else {
          // Deliberately weak, and named as such. The only claim is that no
          // target was served, which is why nothing was traversed.
          expect(
            tierIsServed(target.kind),
            'this step is recorded as blocked by target absence, so a served target contradicts it',
          ).toBe(false)
        }
      })
    }
  })
}

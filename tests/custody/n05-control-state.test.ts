// tests/custody/n05-control-state.test.ts
//
// THE CONTROLS THAT KILL MUTANT NM1.
//
// NM1 is the N05 test manifest's own most important mutation control:
//
//   "MUTANT — REPORT A SKIPPED PLATFORM CONTROL AS A PASS. Run the
//    PLATFORM_DEPENDENT controls NP9 through NP12 on a non-Windows runner,
//    which is the only kind the repository has, and let the platform guard
//    skip them. Expected: the run reports NOT_RUN, never PASSED, and any
//    aggregate that counts them as satisfied goes RED. ... If this mutant
//    survives, the platform split of this manifest is decoration."
//
// The mutant is killed HERE rather than in the Windows demonstration, and that
// placement is the whole design: these tests run on ubuntu-latest, which is
// the runner the mutant targets. A control that only ran on Windows could not
// catch a defect whose entire premise is that Windows controls did not run.

import { describe, expect, it } from 'vitest'

import {
  N05_DEMONSTRATION_CONTROL_IDS,
  failClosedToken,
  isSatisfied,
  summarizeN05Controls,
  type ControlState,
  type N05ControlId,
  type N05ControlOutcomes,
} from '@/db/custody/n05-control-state'

const ALL_STATES: readonly ControlState[] = ['PASSED', 'FAILED', 'NOT_RUN']

const outcomesWhere = (state: ControlState): N05ControlOutcomes =>
  Object.fromEntries(N05_DEMONSTRATION_CONTROL_IDS.map((id) => [id, state])) as N05ControlOutcomes

const withOne = (base: ControlState, id: N05ControlId, state: ControlState): N05ControlOutcomes => ({
  ...outcomesWhere(base),
  [id]: state,
})

describe('isSatisfied is total and true for exactly one state', () => {
  it('is true only for PASSED', () => {
    const satisfying = ALL_STATES.filter((s) => isSatisfied(s))
    expect(satisfying).toEqual(['PASSED'])
  })

  it.each(ALL_STATES)('returns a boolean for %s, never undefined', (state) => {
    expect(typeof isSatisfied(state)).toBe('boolean')
  })
})

describe('NM1: a control that did not run is never a control that passed', () => {
  it('reports NOT_SATISFIED when every control is NOT_RUN', () => {
    const summary = summarizeN05Controls(outcomesWhere('NOT_RUN'))
    expect(summary.overall).toBe('NOT_SATISFIED')
    expect(summary.passed).toHaveLength(0)
    expect(summary.notRun).toEqual([...N05_DEMONSTRATION_CONTROL_IDS])
  })

  it.each([...N05_DEMONSTRATION_CONTROL_IDS])(
    'reports NOT_SATISFIED when only %s is NOT_RUN and every other control passed',
    (id) => {
      const summary = summarizeN05Controls(withOne('PASSED', id, 'NOT_RUN'))
      expect(summary.overall).toBe('NOT_SATISFIED')
      expect(summary.notRun).toEqual([id])
    }
  )

  it('names the NOT_RUN controls rather than only counting them', () => {
    const summary = summarizeN05Controls(withOne('PASSED', 'NP9_FRESH_SHELL_ABSENT', 'NOT_RUN'))
    expect(summary.blockingReasons.join(' ')).toContain('NP9_FRESH_SHELL_ABSENT')
    expect(summary.blockingReasons.join(' ')).toContain('not a control that passed')
  })

  it('distinguishes NOT_RUN from FAILED in the summary', () => {
    const mixed: N05ControlOutcomes = {
      ...outcomesWhere('PASSED'),
      NP9_FRESH_SHELL_ABSENT: 'NOT_RUN',
      NP10_EXTERNAL_COMMAND_LINE_CLEAN: 'FAILED',
    }
    const summary = summarizeN05Controls(mixed)
    expect(summary.notRun).toEqual(['NP9_FRESH_SHELL_ABSENT'])
    expect(summary.failed).toEqual(['NP10_EXTERNAL_COMMAND_LINE_CLEAN'])
    // Two distinct reasons, not one merged "some controls are not green".
    expect(summary.blockingReasons).toHaveLength(2)
  })
})

describe('NM9: the conjunction is total — seven of eight is a stop, not a partial pass', () => {
  it.each([...N05_DEMONSTRATION_CONTROL_IDS])(
    'refuses SATISFIED_CANDIDATE when only %s failed',
    (id) => {
      expect(summarizeN05Controls(withOne('PASSED', id, 'FAILED')).overall).toBe('NOT_SATISFIED')
    }
  )

  it('reaches SATISFIED_CANDIDATE only when every single control passed', () => {
    const summary = summarizeN05Controls(outcomesWhere('PASSED'))
    expect(summary.overall).toBe('SATISFIED_CANDIDATE')
    expect(summary.blockingReasons).toHaveLength(0)
    expect(summary.passed).toHaveLength(N05_DEMONSTRATION_CONTROL_IDS.length)
  })
})

describe('the fail-closed token', () => {
  it('is the token the certified DAG already places at N05, spelled byte-identically', () => {
    const token = failClosedToken(summarizeN05Controls(outcomesWhere('NOT_RUN')))
    expect(token).toBe('STOP_SECRET_DELIVERY_NONCOMPLIANT')
  })

  it('fires on NOT_RUN exactly as it fires on FAILED', () => {
    expect(failClosedToken(summarizeN05Controls(outcomesWhere('NOT_RUN')))).toBe(
      failClosedToken(summarizeN05Controls(outcomesWhere('FAILED')))
    )
  })

  it('is null, and only null, when the conjunction holds', () => {
    expect(failClosedToken(summarizeN05Controls(outcomesWhere('PASSED')))).toBeNull()
  })

  it('invents no second token name', () => {
    // NN4 of the N05 test manifest: any second token, variant spelling or
    // renaming is RED. There is exactly one token this module can produce.
    const produced = new Set(
      ALL_STATES.map((s) => failClosedToken(summarizeN05Controls(outcomesWhere(s))))
    )
    produced.delete(null)
    expect([...produced]).toEqual(['STOP_SECRET_DELIVERY_NONCOMPLIANT'])
  })
})

describe('the control set itself', () => {
  it('has no duplicate ids', () => {
    expect(new Set(N05_DEMONSTRATION_CONTROL_IDS).size).toBe(N05_DEMONSTRATION_CONTROL_IDS.length)
  })

  it('covers all four PLATFORM_DEPENDENT controls the N05 test manifest names', () => {
    for (const id of ['NP9', 'NP10', 'NP11', 'NP12']) {
      expect(N05_DEMONSTRATION_CONTROL_IDS.some((c) => c.startsWith(`${id}_`))).toBe(true)
    }
  })
})

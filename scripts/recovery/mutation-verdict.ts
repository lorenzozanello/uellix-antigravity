// scripts/recovery/mutation-verdict.ts — the PURE verdict logic of the recovery
// mutation battery (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-10).
//
// Kept apart from the runner and unit-tested on its own because a battery's
// summary can be self-fulfilling: a precedent in this repository computed
// `(RED && KILLED) || (RED && SURVIVED)` after a global edit and reported
// every row AS_EXPECTED no matter what happened. The rules here are small
// enough to read in one pass and each has a test that makes it fail:
//
//   - a row is AS_EXPECTED only when observed === expected, the anchor was
//     found, and the mutated file was restored byte-identical;
//   - ERROR (no parsable summary, crash, timeout, load failure) is NEVER a kill;
//   - the battery FAILS on one unexpected row, on an empty battery, and when
//     the unmutated suite was not green first (otherwise everything "dies").

export type Expectation = 'KILLED' | 'SURVIVED'
export type Observation = 'KILLED' | 'SURVIVED' | 'ERROR'

export interface MutantOutcome {
  id: string
  expect: Expectation
  observed: Observation
  anchorFound: boolean
  restoredByteIdentical: boolean
}

export type RowVerdict = 'AS_EXPECTED' | 'UNEXPECTED'

export function classifyMutant(o: MutantOutcome): RowVerdict {
  if (!o.anchorFound || !o.restoredByteIdentical) return 'UNEXPECTED'
  if (o.observed === 'ERROR') return 'UNEXPECTED'
  return o.observed === o.expect ? 'AS_EXPECTED' : 'UNEXPECTED'
}

export function aggregateBattery(outcomes: readonly MutantOutcome[], baselineGreen: boolean): { battery: 'PASS' | 'FAIL'; reasons: string[] } {
  const reasons: string[] = []
  if (!baselineGreen) reasons.push('BASELINE_NOT_GREEN')
  if (outcomes.length === 0) reasons.push('EMPTY_BATTERY')
  for (const o of outcomes) if (classifyMutant(o) === 'UNEXPECTED') reasons.push(`UNEXPECTED_${o.id}`)
  return { battery: reasons.length === 0 ? 'PASS' : 'FAIL', reasons }
}

/**
 * Read a vitest run. KILLED needs a non-zero exit AND a reported failing test;
 * SURVIVED needs exit 0 AND a reported passing count with no failure; anything
 * else (a file that failed to load, no summary, a signal) is ERROR.
 */
export function observeVitest(exitCode: number | null, output: string): Observation {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '')
  const failed = plain.match(/Tests\s+(\d+)\s+failed/)
  const passed = plain.match(/Tests\s+(?:\d+\s+failed\s+\|\s+)?(\d+)\s+passed/)
  if (exitCode !== 0 && failed && Number(failed[1]) > 0) return 'KILLED'
  if (exitCode === 0 && passed && Number(passed[1]) > 0 && !failed) return 'SURVIVED'
  return 'ERROR'
}

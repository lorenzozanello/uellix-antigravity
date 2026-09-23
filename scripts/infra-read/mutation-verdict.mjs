// scripts/infra-read/mutation-verdict.mjs — pure verdict logic of the mutation battery (v1.0.5).
//
// The v1.0.4 battery computed
//   ok = (expect === 'RED' && verdict === 'KILLED') || (expect === 'RED' && verdict === 'SURVIVED')
// (a global text substitution had rewritten the second clause), so a SURVIVED
// mutant was reported AS_EXPECTED and the aggregate could not fail. The logic
// now lives here, is unit-tested (tests/infra-read/mutation-verdict.test.ts),
// and the battery's --self-test feeds it a real surviving mutant.

/** Outcome of one suite run under a mutant. ERROR (crash, timeout, no summary) never counts as a kill. */
export function verdictOf(status, output) {
  if (status === 0) return 'SURVIVED'
  if (status === null || status === undefined) return 'ERROR'
  if (/Test Files\s+\d+ failed/.test(output) || /Tests\s+\d+ failed/.test(output)) return 'KILLED'
  return 'ERROR'
}

/** A row is AS_EXPECTED only when the observed verdict EQUALS the expectation. */
export function classify(expect, verdict) {
  if (expect !== 'KILLED' && expect !== 'SURVIVED') return 'UNEXPECTED'
  if (verdict !== 'KILLED' && verdict !== 'SURVIVED') return 'UNEXPECTED'
  return verdict === expect ? 'AS_EXPECTED' : 'UNEXPECTED'
}

/** PASS only if at least one mutant ran and every row is AS_EXPECTED. */
export function aggregate(rows) {
  const unexpected = rows.filter((r) => r.classification !== 'AS_EXPECTED').length
  return { total: rows.length, asExpected: rows.length - unexpected, unexpected, pass: rows.length > 0 && unexpected === 0 }
}

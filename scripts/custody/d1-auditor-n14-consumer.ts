// scripts/custody/d1-auditor-n14-consumer.ts
//
// THE PRODUCTION CONSUMER FOR DAG N14 (Phase P1 prestate observation).
//
// Its own delivery, its own session: the shared read session re-runs the
// identity preflight (KP-1, KP-2, sentinel with verifyStagingTarget required)
// and then N14's body in ONE BEGIN READ ONLY transaction closed by an
// unconditional ROLLBACK. See db/custody/n14-observation.ts.

import { runN14Observation } from '../../db/custody/n14-observation'
import { consumerMain, runIfEntry } from './d1-consumer-shell'

export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
  return consumerMain('N14', argv, env, async (e, connect) => {
    const r = await runN14Observation({ env: e, connect })
    return {
      resolved: r.session.failedAt !== 'RESOLVE',
      connected: r.session.preflight.connected,
      ok: r.exitMet,
      report: { failedAt: r.session.failedAt, code: r.session.code, token: r.token, notMeasuredBecause: r.notMeasuredBecause, prestate: r.prestate, statementsIssued: r.session.statementsIssued, rolledBack: r.session.rolledBack },
    }
  })
}

runIfEntry(/d1-auditor-n14-consumer\.(ts|js)$/, 'N14', main)

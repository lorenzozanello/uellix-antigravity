// scripts/custody/d1-auditor-n22-consumer.ts
//
// THE PRODUCTION CONSUMER FOR DAG N22 (Phase P3 poststate verification and
// read-only proof) and, with --node=N21, for the conditional DAG N21 (MR-3
// poststate verification). Both ASSERT; neither merely prints. See
// db/custody/n22-poststate.ts.
//
// --node is not a value channel: it selects between two fixed, pinned
// statement sets and is refused unless it is exactly N22 or N21.

import { runN21Mr3Poststate, runN22Poststate } from '../../db/custody/n22-poststate'
import { consumerMain, runIfEntry } from './d1-consumer-shell'

export function parseNode(argv: readonly string[]): { node: 'N22' | 'N21'; rest: string[] } {
  const flags = argv.filter((a) => a.startsWith('--node='))
  if (flags.length > 1) throw Object.assign(new Error('--node given more than once.'), { code: 'CONSUMER_UNKNOWN_ARGUMENT' })
  const value = flags.length === 0 ? 'N22' : flags[0].slice('--node='.length)
  if (value !== 'N22' && value !== 'N21') throw Object.assign(new Error('--node must be N22 or N21 (not echoed).'), { code: 'CONSUMER_UNKNOWN_ARGUMENT' })
  return { node: value, rest: argv.filter((a) => !a.startsWith('--node=')) }
}

export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const { node, rest } = parseNode(argv)
  return consumerMain(node, rest, env, async (e, connect) => {
    if (node === 'N21') {
      const r = await runN21Mr3Poststate({ env: e, connect })
      return {
        resolved: r.session.failedAt !== 'RESOLVE',
        connected: r.session.preflight.connected,
        ok: r.exitMet,
        report: { failedAt: r.session.failedAt, code: r.session.code, rows: r.rows, statementsIssued: r.session.statementsIssued, rolledBack: r.session.rolledBack },
      }
    }
    const r = await runN22Poststate({ env: e, connect })
    return {
      resolved: r.session.failedAt !== 'RESOLVE',
      connected: r.session.preflight.connected,
      ok: r.exitMet,
      report: { failedAt: r.session.failedAt, code: r.session.code, blockedBy: r.blockedBy, rows: r.rows, readOnlyProof: r.readOnlyProof, reissued: r.reissued, statementsIssued: r.session.statementsIssued, rolledBack: r.session.rolledBack },
    }
  })
}

runIfEntry(/d1-auditor-n22-consumer\.(ts|js)$/, 'N22', main)

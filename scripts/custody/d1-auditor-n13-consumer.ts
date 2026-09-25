// scripts/custody/d1-auditor-n13-consumer.ts
//
// THE PRODUCTION CONSUMER FOR DAG N13 (first authenticated session, KP-1,
// KP-2, target identity arm B; under DAG v1.0.4 also N11's usability proof).
//
// Built to plain CommonJS by build-production-entrypoints.ts and started ONLY
// by the N05 delivery path (scripts/custody/d1-deliver-n13.ts), which puts the
// value into this process's environment block as UELLIX_AUDITOR_DATABASE_URL
// at CreateProcess time and nowhere else. Arguments, modes and output are the
// shared consumer shell's (scripts/custody/d1-consumer-shell.ts).

import { runN13Verification } from '../../db/custody/n13-verification'
import { assertKnownArguments, consumerMain, postgresTransport, runIfEntry } from './d1-consumer-shell'

export { assertKnownArguments, postgresTransport }

export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
  return consumerMain('N13', argv, env, async (e, connect) => {
    const result = await runN13Verification({ env: e, connect })
    return { resolved: result.failedAt !== 'RESOLVE', connected: result.connected, ok: result.ok, report: { ...result } }
  })
}

runIfEntry(/d1-auditor-n13-consumer\.(ts|js)$/, 'N13', main)

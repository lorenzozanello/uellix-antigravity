// scripts/custody/d1-n30-deposit.ts
//
// DAG NODE N30: the production deposit of the D-1 auditor credential.
//
// Built to plain CommonJS by build-production-entrypoints.ts and run under
// BARE node, from a console, fed through a PIPE:
//
//   <the owner's producer> | node <out>/scripts/custody/d1-n30-deposit.js
//
// In production it takes NO argument, so nothing credential-shaped can arrive
// on the command line, and it refuses a terminal on stdin, so nothing is typed
// where a scrollback can keep it. The one accepted argument,
// --synthetic-target=<sentinel namespace>, exists for the topology
// demonstration: it switches to the synthetic shape (an RFC 6761 .invalid
// host), so no real value can be deposited through it.
//
// It writes exactly one entry, proves it by a read of the same scope, prints
// booleans, and exits non-zero unless N30's exit holds. It never removes:
// that is scripts/custody/d1-wcm-remove.ts.

import { acquireSecretFromStdin } from '../../db/custody/secret-intake'
import { d1AuditorWcmTarget, depositGovernedCredential } from '../../db/custody/production-custody'
import { CustodyError } from '../../db/custody/wcm-credential-store'

export function parseDepositorArgs(argv: readonly string[]): { target: string; shape: 'production' | 'synthetic' } {
  if (argv.length === 0) return { target: d1AuditorWcmTarget(), shape: 'production' }
  if (argv.length === 1 && argv[0].startsWith('--synthetic-target=')) {
    return { target: argv[0].slice('--synthetic-target='.length), shape: 'synthetic' }
  }
  throw new CustodyError(
    'CUSTODY_DEPOSIT_FAILED',
    'N30 REFUSED: in production this command takes no arguments; the value arrives on a stdin pipe only.'
  )
}

export async function main(argv: readonly string[], stdin: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<number> {
  const { target, shape } = parseDepositorArgs(argv)
  const value = await acquireSecretFromStdin(stdin, argv)
  try {
    const record = await depositGovernedCredential({ value, target, shape })
    process.stdout.write(`${JSON.stringify({ node: 'N30', shape, ...record })}\n`)
    return record.n30ExitMet ? 0 : 1
  } finally {
    value.fill(0)
  }
}

if (/d1-n30-deposit\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2), process.stdin)
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      // A CustodyError's message is an author-fixed sentence that never
      // interpolates the value. Anything else is reported by class only.
      const line =
        e instanceof CustodyError ? { node: 'N30', failed: true, code: e.code, message: e.message } : { node: 'N30', failed: true, code: 'N30_UNEXPECTED' }
      process.stdout.write(`${JSON.stringify(line)}\n`)
      process.exitCode = 3
    })
}

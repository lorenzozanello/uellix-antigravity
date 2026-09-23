// scripts/custody/n05-kill-depositor.ts
//
// THE PROCESS THE DEMONSTRATION KILLS. OF-CUST-3, MEASURED RATHER THAN STATED.
//
// It reads a sentinel from stdin through the real acquisition stage, deposits
// it through the real deposit stage, reports DEPOSITED, and then waits to be
// killed. It never cleans up: the point is to leave a vault entry behind the
// way a crashed or killed depositor would, so the demonstration can show that
// the entry SURVIVES the kill (by design: CRED_PERSIST_LOCAL_MACHINE) and that
// the bounded recovery sweep finds and removes it.
//
// It refuses any target outside the sweepable sentinel namespace, so it can
// never be pointed at a real credential entry.

import { acquireSecretFromStdin } from '../../db/custody/secret-intake'
import { SWEEPABLE_TARGET_PREFIXES, depositCredential } from '../../db/custody/wcm-credential-store'

async function main(): Promise<void> {
  const target = process.argv.find((a) => a.startsWith('--target='))?.slice('--target='.length) ?? ''
  if (!SWEEPABLE_TARGET_PREFIXES.some((p) => target.startsWith(`${p}-`))) {
    throw new Error('The kill depositor only writes inside the sweepable sentinel namespace.')
  }
  const value = await acquireSecretFromStdin(process.stdin, process.argv)
  try {
    await depositCredential({ target, username: 'uellix_auditor', secret: value })
  } finally {
    value.fill(0)
  }
  process.stdout.write('DEPOSITED\n')
  // Wait to be killed. If nobody kills it, exit without cleanup anyway, so the
  // demonstration's recovery path is exercised either way.
  await new Promise((r) => setTimeout(r, 60_000))
}

main().catch((error: unknown) => {
  process.stdout.write(`KILL_DEPOSITOR_FAILED ${(error as Error).message}\n`)
  process.exitCode = 1
})

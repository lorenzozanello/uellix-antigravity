// scripts/custody/d1-wcm-remove.ts
//
// THE GOVERNED REMOVAL OF THE D-1 AUDITOR CUSTODY ENTRY (N24 re-rotation,
// N28 closure, or a post-mint compensation). Separate from the deposit path
// on purpose: a deposit that could also delete is a capability nobody asked
// for. It removes the ONE derived entry by exact name, never by sweep, and
// then proves absence by a read of the same scope.
//
//   node <out>/scripts/custody/d1-wcm-remove.js --confirm-remove-d1-auditor-entry

import { d1AuditorWcmTarget } from '../../db/custody/production-custody'
import { probeCredential, removeCredential } from '../../db/custody/wcm-credential-store'

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1 || argv[0] !== '--confirm-remove-d1-auditor-entry') {
    process.stdout.write('REMOVAL REFUSED: pass exactly --confirm-remove-d1-auditor-entry.\n')
    return 2
  }
  const target = d1AuditorWcmTarget()
  const deleted = await removeCredential(target)
  const absentAfter = !(await probeCredential(target))
  process.stdout.write(`${JSON.stringify({ act: 'D1_AUDITOR_WCM_REMOVAL', deleted, positiveAbsenceCheck: absentAfter })}\n`)
  return absentAfter ? 0 : 1
}

if (/d1-wcm-remove\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      process.stdout.write(`REMOVAL FAILED: ${(e as { code?: string }).code ?? 'UNKNOWN'}\n`)
      process.exitCode = 3
    })
}

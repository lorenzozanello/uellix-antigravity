// scripts/ci-assert-local-targets.ts
//
// CI gate: assert that the targets exported by `supabase status` really are
// THIS stack's loopback endpoints, using the repository's own classifier.
//
// It replaces a pair of shell checks of the form
//   grep -qvE "127.0.0.1|localhost|::1"
// which are the exact bug class db/safety/ exists to remove: they match on
// substrings, so `https://localhost.attacker.example/` passes, the unescaped
// dots also match `127x0x0x1`, and neither checks the PORT — and this project
// runs several local Supabase stacks side by side.
//
// Reads `SB_URL` / `DB_URL` from the environment. Prints only the
// classification and a redacted host; never the values themselves.

import { classifyDatabaseTarget, classifySupabaseApiTarget } from '../db/safety/database-target'
import { LOCAL_API_PORT, LOCAL_DB_PORT } from '../db/safety/local-stack'

const checks = [
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL',
    target: classifySupabaseApiTarget(process.env.SB_URL),
    expectedPort: LOCAL_API_PORT,
  },
  {
    name: 'DATABASE_URL',
    target: classifyDatabaseTarget(process.env.DB_URL),
    expectedPort: LOCAL_DB_PORT,
  },
]

let failed = false

for (const { name, target, expectedPort } of checks) {
  console.log(
    `${name}: kind=${target.kind} host=${target.redactedHost} port=${target.port ?? 'unset'}`
  )
  if (target.kind !== 'local_loopback') {
    console.error(`🚨 ${name} is not loopback (classified "${target.kind}").`)
    failed = true
  } else if (target.port !== expectedPort) {
    console.error(
      `🚨 ${name} is loopback but on port ${target.port ?? 'unset'}; this stack expects ${expectedPort}. ` +
        'Another local stack is not a valid target.'
    )
    failed = true
  }
}

if (failed) process.exit(1)
console.log('✅ Both targets are this stack\'s loopback endpoints.')

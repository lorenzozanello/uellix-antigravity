// scripts/guard-local-reset.ts
//
// Precondition gate for `pnpm db:reset:local`, which stops the Supabase
// stack, discards its volumes and rebuilds from migrations + seeds. It is the
// most destructive command in the repository, and it used to run with no
// confirmation at all.
//
// This script connects to nothing. It only classifies the intended target and
// evaluates the `local_reset` capability, which requires all of:
//
//   * a local target on this worktree's expected port;
//   * a non-production environment;
//   * the declared project id;
//   * an exact confirmation token supplied out of band.
//
// It exits non-zero on refusal, which stops the `&&` chain in package.json
// before `supabase stop` runs.

import {
  assertDatabaseOperationAllowed,
  DatabaseSafetyError,
} from '../db/safety/database-access'
import {
  LOCAL_DB_PORT,
  LOCAL_PROJECT_ID,
  LOCAL_RESET_CONFIRMATION,
} from '../db/safety/local-stack'
import { resolveLocalDatabaseUrl } from '../db/safety/resolve-local-database-url'

const CONFIRMATION_ENV_VAR = 'UELLIX_DB_LOCAL_RESET_CONFIRM'

function refuse(message: string): never {
  console.error('\n================================================================')
  console.error('LOCAL RESET REFUSED')
  console.error('================================================================')
  console.error(message)
  console.error('')
  console.error('`db:reset:local` destroys this stack\'s data and rebuilds it. To')
  console.error('proceed, set the confirmation for THIS project explicitly:')
  console.error('')
  console.error(`  PowerShell:  $env:${CONFIRMATION_ENV_VAR}="${LOCAL_RESET_CONFIRMATION}"`)
  console.error(`  bash:        export ${CONFIRMATION_ENV_VAR}="${LOCAL_RESET_CONFIRMATION}"`)
  console.error('')
  console.error('The token is compared exactly: surrounding whitespace or a')
  console.error('different case is a mismatch, and a token minted for another')
  console.error('local stack does not confirm this one.')
  console.error('================================================================\n')
  process.exit(1)
}

function main(): void {
  let url: string
  try {
    url = resolveLocalDatabaseUrl(process.env, { expectedLocalPort: LOCAL_DB_PORT }).url
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error))
  }

  try {
    const decision = assertDatabaseOperationAllowed({
      url,
      capability: 'local_reset',
      expectedLocalPort: LOCAL_DB_PORT,
      expectedProjectId: LOCAL_PROJECT_ID,
      confirmation: process.env[CONFIRMATION_ENV_VAR],
    })
    console.log(`[db:reset:local] ${decision.auditLine}`)
    console.log(`[db:reset:local] confirmation accepted — proceeding with the rebuild.`)
  } catch (error) {
    if (error instanceof DatabaseSafetyError) refuse(error.message)
    refuse(error instanceof Error ? error.message : String(error))
  }
}

main()

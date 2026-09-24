// tests/infra-read/diag-harness.ts — child-process harness for the value-exposure tests
// (safe-diagnostic.test.ts). NOT a test file. It drives the REAL executor against the
// fake provider world with one synthetic secret-shaped value planted in V-R2.S2, and
// then writes the refusal to every channel the entry point uses (stderr, exactly as
// run-governed-reads main() does) plus the serialized forms a caller could produce.
// No network: the runner is the fake world.
import { inspect } from 'node:util'
import { SafeReadExecutor } from '../../scripts/infra-read/executor'
import { Refusal } from '../../scripts/infra-read/ops'
import { CTX, TEAM, fakeRunner, world } from './fixtures'
import { projectsListWith, syntheticSecret } from './diag-fixtures'

const field = process.argv[2]
const ctx = { ...CTX, xcc1Env: {}, xcc1Cwd: '/tmp/unused' }
const ex = new SafeReadExecutor(fakeRunner(world(projectsListWith(field, syntheticSecret(field)))), ctx)
try {
  ex.run('G-R1')
  ex.run('G-R3')
  ex.run('V-R2.S1')
  ex.run('V-R2.S2', { teamId: TEAM })
  console.log('NO_REFUSAL')
} catch (e) {
  // Exactly what run-governed-reads.ts main() prints.
  console.error(e instanceof Refusal ? e.message : `STOP_UNEXPECTED: ${(e as Error).message}`)
  // Every other serialization a caller could reasonably produce.
  console.log(JSON.stringify(e))
  console.log(String(e))
  console.log((e as Error).stack ?? '')
  console.log(inspect(e, { depth: 10 }))
}

// @vitest-environment node
// tests/recovery/skipped-e2e-residue.test.ts — NB-6.
//
// Measured by the recert of ec573e9b: the Docker e2e allocated its artifact
// directory with mkdtempSync in the describe BODY, which runs at COLLECTION
// time, so every SKIPPED run (CI, any machine without UELLIX_PG_TESTS=1) left
// an empty uellix-recovery-battery-* directory in the OS temp directory.
//
// Oracle: run the gated files exactly as a default (CI-like) run would — a real
// vitest child process with UELLIX_PG_TESTS removed from its environment — and
// require that the set of uellix-recovery-* entries in the temp directory is
// unchanged. (uellix-recovery-unit-* is excluded: unit tests in THIS process
// allocate and remove those inside their own lifecycle.)

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const GATED = ['tests/postgres/recovery-offline.pg.test.ts', 'tests/recovery/principal-reachability.pg.test.ts']

const residue = () =>
  readdirSync(tmpdir())
    .filter((n) => n.startsWith('uellix-recovery-') && !n.startsWith('uellix-recovery-unit-'))
    .sort()

describe('NB-6: a skipped Docker e2e allocates nothing', () => {
  it('running the gated files without UELLIX_PG_TESTS leaves zero new uellix-recovery-* temp entries', { timeout: 180_000 }, () => {
    const before = residue()
    const env = { ...process.env }
    delete env.UELLIX_PG_TESTS
    const run = spawnSync(process.execPath, [VITEST, 'run', ...GATED], { cwd: ROOT, env, encoding: 'utf8', timeout: 170_000, windowsHide: true })
    const out = `${run.stdout}\n${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, '')
    // The gated files were really collected and really skipped — not absent.
    expect(out).toMatch(/Test Files\s+2 skipped/)
    expect(run.status).toBe(0)
    expect(residue()).toEqual(before)
  })
})

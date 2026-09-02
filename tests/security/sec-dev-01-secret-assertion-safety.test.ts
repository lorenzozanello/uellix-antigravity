import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'

/**
 * SEC-DEV-01 negative control.
 *
 * The defect class this closes: `expect(process.env.SECRET).toBeUndefined()`.
 * When that assertion fails (the secret IS present), Vitest's failure
 * message interpolates the actual received value — so a credential leaks
 * into CI logs / terminal output at the moment it should never appear.
 *
 * This spawns two disposable child processes with a synthetic sentinel
 * (never a real credential) injected as an env var, and proves:
 *   1. the UNSAFE pattern reproduces the leak (sentinel value appears in
 *      the failure output) — the vulnerability is real and reproducible;
 *   2. the SAFE pattern (`expect('NAME' in process.env).toBe(false)`) still
 *      fails under the same violated contract, but its failure output
 *      carries only boolean/presence state — the sentinel value never
 *      appears anywhere in stdout/stderr.
 */

const SENTINEL_VAR = 'SEC_DEV_01_SENTINEL_VAR'
const SENTINEL_VALUE = 'SEC_DEV_01_SENTINEL_DO_NOT_PRINT'

function runChild(script: string) {
  return spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, [SENTINEL_VAR]: SENTINEL_VALUE },
    encoding: 'utf8',
  })
}

describe('SEC-DEV-01: secret-disclosing assertion negative control', () => {
  it('reproduces the vulnerability: the unsafe pattern prints the sentinel value on failure', () => {
    const result = runChild(
      `const assert = require('node:assert');` +
        `assert.strictEqual(process.env.${SENTINEL_VAR}, undefined);`,
    )
    const output = `${result.stdout}${result.stderr}`

    expect(result.status, 'the unsafe assertion must fail when the credential is present').not.toBe(0)
    expect(output, 'unsafe pattern should reproduce the leak in this control').toContain(SENTINEL_VALUE)
  })

  it('proves the fix: the safe presence-only pattern fails without ever printing the sentinel value', () => {
    const result = runChild(
      `const assert = require('node:assert');` +
        `assert.strictEqual('${SENTINEL_VAR}' in process.env, false);`,
    )
    const output = `${result.stdout}${result.stderr}`

    expect(result.status, 'the safe assertion must still fail when the credential is present').not.toBe(0)
    expect(output, 'sentinel value must never appear in failure output').not.toContain(SENTINEL_VALUE)
    // Failure output is boolean/presence-only: the two operands compared are `true` and `false`.
    expect(output).toMatch(/true/)
    expect(output).toMatch(/false/)
  })
})

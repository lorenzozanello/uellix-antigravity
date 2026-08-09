// tests/hosted/evidence-immutability.test.ts
//
// THE SUITE MAY NOT DELETE, MODIFY OR RESERIALIZE A REAL MEASUREMENT.
//
// This exists because it happened. 8df0c72 records a CLI round-trip that
// asserted the two CHECKPOINT A1 artefacts were absent, wrote fixtures over
// their real paths and removed both in a `finally` — correct exactly once, on a
// repository where A1 had not been measured. The moment the operator's
// corroboration was committed, `pnpm test` DELETED IT and then failed on the
// assertion rather than on the deletion, so the failure named the wrong thing.
//
// The fix there was a guard on that one test. This is the general form: every
// governed evidence artefact, enumerated from the registries that own them, held
// to the bytes git has for it. Any test in any file that writes to one of these
// paths fails HERE, with a message that says what was destroyed.
//
// ---------------------------------------------------------------------------
// WHY IT COMPARES AGAINST GIT AND NOT AGAINST A SNAPSHOT TAKEN AT STARTUP
// ---------------------------------------------------------------------------
// A snapshot taken in a `beforeAll` only catches damage done after this file
// loads, and vitest gives no ordering guarantee across files. The committed blob
// is a fixed point that does not depend on when anything ran: if the working
// copy differs from it, something changed a measurement, whether that was a test
// or a person. An UNCOMMITTED evidence file is skipped rather than failed — it
// is a measurement in flight, and demanding it be committed would block the
// operator between `:write` and `git commit`.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { CHAIN_EVIDENCE_REGISTRY } from '@/db/hosted/chain-evidence'
import { A1_CORROBORATION_ARTEFACT, A1_STATUS_ARTEFACT } from '@/db/hosted/checkpoint-a1'
import { S1_EVIDENCE_REGISTRY } from '@/db/hosted/bootstrap-postconditions'

const ROOT = process.cwd()

const git = (args: readonly string[]): string | null => {
  try {
    return execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * Every path a registry declares as evidence, deduplicated.
 *
 * ENUMERATED FROM THE REGISTRIES, never hand-listed. A new step, a new phase or
 * a renamed artefact is protected the moment it is declared, which is the same
 * rule `deriveEmptinessProbes` follows and for the same reason: a guard that
 * only covers what somebody remembered to add is a guard with a hole in it.
 */
const GOVERNED_EVIDENCE: readonly string[] = [
  ...new Set([
    ...S1_EVIDENCE_REGISTRY.flatMap((e) => [e.path, e.statusPath]),
    A1_CORROBORATION_ARTEFACT,
    A1_STATUS_ARTEFACT,
    ...CHAIN_EVIDENCE_REGISTRY.flatMap((e) => [e.observationPath, e.statusPath]),
  ]),
]

describe('governed evidence is byte-identical to what git has for it', () => {
  it('enumerates every declared evidence path from the registries', () => {
    // Four for S1/S3, two for A1, eighteen for the chain — with the A1 pair
    // shared, because PRECHAIN points at it by reference rather than copying it.
    expect(GOVERNED_EVIDENCE.length).toBe(4 + 2 + 18)
    expect(GOVERNED_EVIDENCE).toContain(A1_CORROBORATION_ARTEFACT)
    expect(GOVERNED_EVIDENCE.filter((p) => p === A1_CORROBORATION_ARTEFACT)).toHaveLength(1)
  })

  for (const rel of GOVERNED_EVIDENCE) {
    it(`${rel} is unchanged`, () => {
      const absolute = path.join(ROOT, rel)
      const committed = git(['rev-parse', `HEAD:${rel}`])

      if (committed === null) {
        // Not committed. Either it has never been measured, or it is a
        // measurement in flight between `:write` and `git commit`. Neither is a
        // failure; a test that DELETED it would show up as the file vanishing,
        // which the next case covers.
        return
      }

      expect(
        existsSync(absolute),
        `${rel} is committed at HEAD and MISSING from the working tree. Something in this suite deleted a real measurement — recover it with \`git restore ${rel}\` and guard whatever wrote there. This is the defect 8df0c72 fixed.`,
      ).toBe(true)

      const worktree = git(['hash-object', '--', rel])
      expect(
        worktree,
        `${rel} DIFFERS from the blob committed at HEAD. A measurement is a historical fact; it is not re-serialized to fit new plumbing, and nothing in a test run may edit one.`,
      ).toBe(committed)
    })
  }

  it('the A1 pair is present and readable, since the chain computes deltas against it', () => {
    for (const rel of [A1_CORROBORATION_ARTEFACT, A1_STATUS_ARTEFACT]) {
      const raw = readFileSync(path.join(ROOT, rel), 'utf8')
      expect(raw.length, rel).toBeGreaterThan(0)
      expect(() => JSON.parse(raw) as unknown, rel).not.toThrow()
    }
  })
})

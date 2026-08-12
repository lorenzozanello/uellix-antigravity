// db/hosted/authority/certification/refusal-exercises.ts
// F-1 — the negative controls of the PG 17.6 certification, in ONE place.
//
// ---------------------------------------------------------------------------
// WHY THESE LEFT THE SCRIPT
// ---------------------------------------------------------------------------
// They used to live inside `scripts/pg176-certify.ts`, which cannot be imported:
// it starts containers at module load. So the offline suite tested a SECOND
// implementation of the same four exercises — and the two drifted. The fixture
// derived its unknown-package sentinel from the chain; the script spelled it
// `'T10'`, which M-8 turned into a real package. The executed probe resolved,
// recorded `refused=false`, and the run still reported `verdict=COMPLETE`.
//
// A test over a parallel fixture could not have caught that, and no amount of
// care in the fixture would have helped. So the exercises live here, the script
// calls this, and the tests call the same function the script calls.
//
// ---------------------------------------------------------------------------
// WHAT A REFUSAL EXERCISE IS
// ---------------------------------------------------------------------------
// A thing the harness must refuse to DO, attempted for real, with the refusal
// recorded. Every one of them must be decided BEFORE any SQL reaches a server —
// `reachedServer` is part of the record precisely so that ordering is evidence
// rather than an assumption. "PostgreSQL would have rejected it anyway" is not
// a safety argument about statements that sit inside an open transaction with
// ownership transfers in it.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  assertGovernedPath,
  GovernedInputRefusal,
  resolveGovernedInput,
  UNKNOWN_PACKAGE_ID,
} from './governed-input'

/**
 * The exercises a COMPLETE certification must have refused, all of them.
 *
 * This list is what `certificationVerdict` gates on, so deleting an exercise is
 * not a way to pass it: a required id with no recorded outcome fails the
 * predicate exactly like a recorded `refused=false` does.
 */
export const REQUIRED_REFUSAL_IDS = [
  'PIN',
  'UNGOVERNED_BYTES',
  'UNGOVERNED_PATH',
  'UNKNOWN_PACKAGE',
] as const

export type RequiredRefusalId = (typeof REQUIRED_REFUSAL_IDS)[number]

export interface RefusalExercise {
  readonly id: RequiredRefusalId
  /** Names what was attempted, INCLUDING the derived inputs it was attempted with. */
  readonly attempted: string
  readonly refused: boolean
  readonly code: string | null
  /** Always false for these four. Recorded, not assumed — that is the claim. */
  readonly reachedServer: boolean
}

/** Runs one attempt and records how it was refused, or that it was not. */
function exercise(
  id: RequiredRefusalId,
  attempted: string,
  attempt: () => void,
): RefusalExercise {
  try {
    attempt()
    return { id, attempted, refused: false, code: null, reachedServer: false }
  } catch (error) {
    return {
      id,
      attempted,
      // A GovernedInputRefusal is the harness refusing. Any other throw is the
      // harness breaking, and must not be recorded as a passed negative control.
      refused: error instanceof GovernedInputRefusal,
      code: error instanceof GovernedInputRefusal ? error.code : null,
      reachedServer: false,
    }
  }
}

/**
 * Attempts every required refusal, in order.
 *
 * Pure with respect to the database: nothing here opens a connection, and the
 * only I/O is reading artefacts off disk to hand the resolver bytes it must
 * reject.
 */
export function refusalExercises(root: string): readonly RefusalExercise[] {
  return [
    // 21 — a governed artefact whose bytes moved.
    exercise('PIN', 'apply a governed artefact whose bytes moved', () => {
      resolveGovernedInput('T1', root, (p) => `${readFileSync(p, 'utf8')}\n-- tampered\n`)
    }),

    // 22 — the UNGOVERNED artefact the operational runners once referenced. Same
    // package, same pinned path, the OTHER artefact's contents: the two apply
    // against the same database without error and carry different authority
    // models, which is what staging paid for.
    exercise('UNGOVERNED_BYTES', 'feed T1 the ungoverned .hosted.sql bytes', () => {
      resolveGovernedInput('T1', root, (p) =>
        readFileSync(
          p.replace(/[\\/]governed[\\/]/, '/').replace('.governed.sql', '.hosted.sql'),
          'utf8',
        ),
      )
    }),

    // 22 — and the path itself, which never gets as far as being read.
    exercise('UNGOVERNED_PATH', 'resolve a path outside db/prepared/hosted/governed/', () => {
      assertGovernedPath(path.join(root, 'db/prepared/hosted/grounding_0002_document_versions.hosted.sql'))
    }),

    // An unknown package id: no basename fallback, no glob. The id is DERIVED
    // from the chain and NAMED in the record — an exercise that says only "a
    // package the chain does not declare" cannot be audited for F-1 at all,
    // which is how a probe against a real package survived a review.
    exercise(
      'UNKNOWN_PACKAGE',
      `resolve ${UNKNOWN_PACKAGE_ID}, a package the chain does not declare`,
      () => {
        resolveGovernedInput(UNKNOWN_PACKAGE_ID, root)
      },
    ),
  ]
}

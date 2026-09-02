// tests/helpers/source-text.ts
// INTEGRATION — Train 4.2, FASE 9.
//
// ONE reader for every suite that asserts a MULTI-LINE anchor over a source
// file, and one explicit normalization: CRLF and lone CR become LF.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, MEASURED RATHER THAN ARGUED
// ---------------------------------------------------------------------------
// The repository is checked out with `core.autocrlf=true`. `.gitattributes`
// pins `db/prepared/**`, `db/baseline/**` and `*.sh` to LF — CT-CAP-003 closed
// that in Train 1 — and pins NOTHING for `.ts`/`.tsx`. So a TypeScript source
// is LF or CRLF in the working tree depending on which tool last wrote it,
// which is not a property any assertion should depend on.
//
// Three assertions did depend on it, and they were found by flipping every
// LF source in the tree to CRLF and running the suite:
//
//   tests/cross-workstream/ticket-idempotency.test.ts
//     · "el ticket sólo lo emite el servidor" — anchors on
//       `issueStellaGroundedQueryTicketForProject(\n  projectId: string,\n)`
//     · "el ticket viaja SEPARADO" — anchors on the three lines of
//       `StellaGroundedQueryRunner`
//   tests/cross-workstream/runtime-grounded-query.test.ts
//     · "a compliance trail IS written" — slices the audit function's body at
//       `'\n}\n'`, which under CRLF never matches, so the slice ran to the end
//       of the file and the "no query text" assertion read the wrong function
//
// The last one is the reason this is a correctness fix and not tidiness: a
// failed `indexOf('\n}\n')` returns -1, `slice(start, -1)` silently yields
// almost the whole file, and the assertion then judged text it was never
// pointed at. It happened to go RED; it could as easily have gone green over
// the wrong bytes.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT DO
// ---------------------------------------------------------------------------
// It does not touch a single production file. Normalizing sources on disk to
// make an assertion pass would be moving the evidence rather than reading it:
// the file's bytes are the environment's business (`.gitattributes`, the
// editor, git), and a TEST that only works for one of the two legal
// materializations is a defect in the test.
//
// It is also not a general "clean the text" helper. Line endings and nothing
// else: no trim, no whitespace collapsing, no comment stripping. A helper that
// quietly normalized more would let an assertion pass over text that does not
// exist in any checkout.

import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * CRLF and lone CR become LF. Idempotent, and total: text already in LF is
 * returned unchanged.
 *
 * The lone-CR case is included because it is the same class of accident (a
 * classic-Mac or truncated-CRLF write) and because leaving it out would make
 * this function's name a half-truth. It matches `lib/grounding/chunk.ts`'s own
 * `normalizeForAnchors`, deliberately: the product already decided what
 * "normalize line endings for anchoring" means, and a test helper that decided
 * it differently would be a second definition of the same word.
 */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Read a repo-relative source file as text with line endings normalized.
 *
 * Use this — never a bare `readFileSync` — wherever the assertion that follows
 * anchors on more than one line.
 */
export function readSourceText(relativePath: string, root: string = process.cwd()): string {
  return toLf(readFileSync(path.resolve(root, relativePath), 'utf8'))
}

/**
 * The same text in both legal materializations, for suites that must show an
 * assertion bites identically either way.
 *
 * Returned as a labelled pair rather than two calls so a `for` loop over it
 * reports WHICH materialization failed.
 */
export function bothLineEndings(text: string): ReadonlyArray<readonly [label: 'LF' | 'CRLF', text: string]> {
  const lf = toLf(text)
  return [
    ['LF', lf],
    ['CRLF', lf.replace(/\n/g, '\r\n')],
  ] as const
}

// lib/grounding/ingest/normalize.ts
// GROUNDING line — deterministic text normalization and controlled noise removal.
//
// This module defines the COORDINATE SPACE that every anchor in the system
// addresses. Its output text is the only string a citation span is meaningful
// against, which is why its hash travels on every chunk location.
//
// Two properties hold, and both are tested:
//
//   DETERMINISM  normalizeDocumentText(x) is a pure function of x. No clock,
//                no locale, no randomness, no dependency on call order.
//   IDEMPOTENCE  normalizing the output again returns identical text and
//                reports zero steps. A pipeline that is not a fixpoint quietly
//                moves every anchor in the corpus on the next reindex.
//
// "Controlled" noise removal means every step names itself and reports how
// much it removed. An auditor who sees 4 200 characters missing from a
// document can ask which step took them; nothing disappears anonymously.
//
// STEP ORDER IS LOAD-BEARING, and specifically: every step that DELETES
// characters runs after every step that could introduce work for it, and
// deletions carry an offset map so page boundaries recorded earlier still
// point at the right place afterwards. Getting this wrong does not fail
// loudly — it silently shifts citations by a few characters.

import {
  type NormalizationStep,
  type NormalizationStepId,
  type PromptInjectionSignal,
} from '../contracts'
import { scanRawText } from './injection-scan'

/** Hard cap on normalized text length; mirrors extract.MAX_EXTRACTED_TEXT_CHARS. */
export const MAX_NORMALIZED_CHARS = 1_000_000

export interface NormalizationOutput {
  readonly text: string
  readonly steps: readonly NormalizationStep[]
  /** Signals found in the RAW text — chiefly what the cleanup then removed. */
  readonly rawSignals: readonly PromptInjectionSignal[]
  /**
   * Offsets in the FINAL text where a page boundary was detected. Each is the
   * first character of a new page; page 1 starts at 0 implicitly.
   */
  readonly pageBreakOffsets: readonly number[]
  readonly truncated: boolean
  readonly rawChars: number
}

/**
 * Characters removed outright: invisible to a human reader, carrying no
 * content, and the standard vehicle for hiding text from a reviewer while
 * leaving it perfectly legible to a model.
 *
 * Tab (U+0009) and LF (U+000A) are content. CR is already gone by this point.
 * Form feed (U+000C) is a page boundary and has its own step.
 */
const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

/** Space-like characters folded to U+0020 so tokenisation is stable. */
const NBSP_LIKE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g

function makeStep(
  id: NormalizationStepId,
  description: string,
  charsRemoved: number,
  charsReplaced = 0,
): NormalizationStep {
  return { id, description, charsRemoved, charsReplaced }
}

/** A deletion applied to the text: `count` characters starting at `start`. */
interface Deletion {
  readonly start: number
  readonly count: number
}

/**
 * Apply deletions (given in ascending, non-overlapping order) and carry a set
 * of marker offsets across the edit.
 *
 * A marker inside a deleted region clamps to the region's start — the passage
 * it pointed at no longer exists, and the nearest surviving position is the
 * only honest answer.
 */
function applyDeletions(
  text: string,
  deletions: readonly Deletion[],
  markers: readonly number[],
): { text: string; markers: number[]; removed: number } {
  if (deletions.length === 0) return { text, markers: [...markers], removed: 0 }

  let out = ''
  let cursor = 0
  for (const deletion of deletions) {
    out += text.slice(cursor, deletion.start)
    cursor = deletion.start + deletion.count
  }
  out += text.slice(cursor)

  const movedMarkers = markers.map((marker) => {
    let shift = 0
    for (const deletion of deletions) {
      if (deletion.start >= marker) break
      shift += Math.min(deletion.count, marker - deletion.start)
    }
    return marker - shift
  })

  const removed = deletions.reduce((sum, d) => sum + d.count, 0)
  return { text: out, markers: movedMarkers, removed }
}

/** Collect deletions for every match of `pattern`, keeping `keep` chars of it. */
function deletionsFor(text: string, pattern: RegExp, keep: number): Deletion[] {
  // Fresh regex per call: a /g/ regex carries lastIndex, and reusing one across
  // documents would make the result depend on call order — exactly the class of
  // bug a module claiming determinism cannot afford.
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  const deletions: Deletion[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const count = match[0].length - keep
    if (count > 0) deletions.push({ start: match.index + keep, count })
    if (match[0].length === 0) re.lastIndex++ // guard against zero-width matches
  }
  return deletions
}

function countMatches(text: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  let count = 0
  while (re.exec(text) !== null) count++
  return count
}

/**
 * Normalize raw extracted text into the anchor coordinate space.
 *
 * Deleting steps (invisible characters, form feeds, trailing whitespace, blank
 * runs, truncation) run in an order chosen so the result is a fixpoint: after
 * one pass the text contains no CR, no invisible characters, no form feed, no
 * exotic space, no trailing whitespace on any line, and no run of three or
 * more newlines — so a second pass has nothing left to do.
 */
export function normalizeDocumentText(raw: string): NormalizationOutput {
  const rawChars = raw.length
  // Scan BEFORE cleanup: hidden characters cease to exist one step from now,
  // and they are precisely the signal a human reviewer cannot see unaided.
  const rawSignals = scanRawText(raw)

  const steps: NormalizationStep[] = []
  let text = raw
  let pageBreaks: number[] = []

  // 1. BOM. Only a leading one is a BOM; interior U+FEFF is handled as invisible.
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
    steps.push(makeStep('strip_bom', 'Removed a leading UTF-8 byte order mark', 1))
  }

  // 2. Line endings. CRLF and lone CR both become LF. CRLF loses a character,
  //    so it is a deletion; no page break has been recorded yet.
  const crlfCount = countMatches(text, /\r\n/g)
  const loneCrCount = countMatches(text, /\r(?!\n)/g)
  if (crlfCount > 0 || loneCrCount > 0) {
    text = text.replace(/\r\n?/g, '\n')
    steps.push(makeStep('crlf_to_lf', 'Unified CRLF and lone CR line endings to LF', crlfCount, loneCrCount))
  }

  // 3. Invisible characters. Removed, not substituted: they carry no content,
  //    and replacing them with a space would invent word boundaries that
  //    change tokenisation and therefore retrieval.
  const invisibleDeletions = deletionsFor(text, INVISIBLE_CHARS, 0)
  if (invisibleDeletions.length > 0) {
    const applied = applyDeletions(text, invisibleDeletions, pageBreaks)
    text = applied.text
    pageBreaks = applied.markers
    steps.push(
      makeStep(
        'remove_invisible_characters',
        'Removed zero-width, bidi-control and C0 control characters (rawSignals records what was found)',
        applied.removed,
      ),
    )
  }

  // 4. Space-like characters. Length preserving, so no offset moves.
  const nbspCount = countMatches(text, NBSP_LIKE)
  if (nbspCount > 0) {
    text = text.replace(NBSP_LIKE, ' ')
    steps.push(makeStep('nbsp_to_space', 'Folded non-breaking and exotic spaces to U+0020', 0, nbspCount))
  }

  // 5. Form feeds are page boundaries. The character is removed and its
  //    position recorded as the first character of the next page; every later
  //    deleting step carries those positions along.
  const formFeedDeletions = deletionsFor(text, /\f/g, 0)
  if (formFeedDeletions.length > 0) {
    pageBreaks = formFeedDeletions.map((d) => d.start)
    const applied = applyDeletions(text, formFeedDeletions, pageBreaks)
    text = applied.text
    pageBreaks = applied.markers
    steps.push(
      makeStep(
        'form_feed_to_page_break',
        'Recorded form feeds as page boundaries and removed the control character',
        applied.removed,
      ),
    )
  }

  // 6. Trailing whitespace per line and at end of document.
  const trailingDeletions = [
    ...deletionsFor(text, /[ \t]+(?=\n)/g, 0),
    ...deletionsFor(text, /[ \t]+$/g, 0),
  ].sort((a, b) => a.start - b.start)
  if (trailingDeletions.length > 0) {
    const applied = applyDeletions(text, dedupeAdjacent(trailingDeletions), pageBreaks)
    text = applied.text
    pageBreaks = applied.markers
    steps.push(
      makeStep('strip_trailing_line_whitespace', 'Removed trailing spaces and tabs from every line', applied.removed),
    )
  }

  // 7. Runs of three or more newlines collapse to a blank line. Paragraph
  //    structure survives (the chunker prefers to break on "\n\n"); page-filling
  //    whitespace does not.
  const blankRunDeletions = deletionsFor(text, /\n{3,}/g, 2)
  if (blankRunDeletions.length > 0) {
    const applied = applyDeletions(text, blankRunDeletions, pageBreaks)
    text = applied.text
    pageBreaks = applied.markers
    steps.push(makeStep('collapse_blank_runs', 'Collapsed runs of 3+ newlines to a blank line', applied.removed))
  }

  // 8. Cap. Last, so it bounds exactly the text anchors address. The trailing
  //    trim keeps the whole function a fixpoint: a second pass over the
  //    truncated output must find nothing left to do.
  let truncated = false
  if (text.length > MAX_NORMALIZED_CHARS) {
    const before = text.length
    text = text.slice(0, MAX_NORMALIZED_CHARS).replace(/[ \t]+$/, '')
    truncated = true
    steps.push(
      makeStep(
        'truncate_to_char_cap',
        `Truncated to the ${MAX_NORMALIZED_CHARS}-character cap; anchors cover only the retained prefix`,
        before - text.length,
      ),
    )
  }

  // A page that fell entirely past the cap has no text left to anchor.
  const survivingBreaks = pageBreaks.filter((offset) => offset < text.length)

  return { text, steps, rawSignals, pageBreakOffsets: survivingBreaks, truncated, rawChars }
}

/**
 * The two trailing-whitespace patterns can both match the same run when a
 * document ends with spaces followed by a newline at EOF; merge overlaps so a
 * character is never counted, or deleted, twice.
 */
function dedupeAdjacent(deletions: readonly Deletion[]): Deletion[] {
  const merged: Deletion[] = []
  for (const deletion of deletions) {
    const last = merged[merged.length - 1]
    if (last && deletion.start < last.start + last.count) {
      const end = Math.max(last.start + last.count, deletion.start + deletion.count)
      merged[merged.length - 1] = { start: last.start, count: end - last.start }
      continue
    }
    merged.push(deletion)
  }
  return merged
}

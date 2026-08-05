// lib/grounding/retrieve/extractive-generator.ts
// GROUNDING line — a real, local, deterministic answer generator.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
// ---------------------------------------------------------------------------
// A production {@link AnswerDraftProvider} that answers by QUOTING. It reads
// the passages retrieval actually returned, selects the sentences that carry
// the query's terms, and emits each selection verbatim as an evidence claim
// citing the chunk it came from.
//
// It is not a mock, not a fixture, and not a stub. It has no seeded data, no
// hard-coded answers, no branch that returns a canned response, and no
// dependency on any test file. Given a repository with real chunks, it produces
// a real, citable answer offline.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT
// ---------------------------------------------------------------------------
// It is NOT equivalent to a generative model and must never be presented as
// one. It cannot synthesise, summarise, compare, translate, or answer a
// question whose answer is not literally written in one of the retrieved
// passages. Asked "why did outcomes fall in Q3?", it returns the sentences that
// mention outcomes and Q3 — not a reason. That limitation is the price of the
// guarantee below, and it is the right price for an evidence layer, but it is a
// real limitation and the release notes must say so.
//
// It is also NOT a fallback. It must never be selected because a database is
// down, a SQL package is missing, authorization failed, or the repository
// threw: those are operational failures, and answering them with quotations
// from an empty or partial retrieval would present a system fault as an
// evidence finding. It is an EXPLICIT strategy, chosen by configuration.
//
// ---------------------------------------------------------------------------
// THE INVARIANT
// ---------------------------------------------------------------------------
//   Every emitted statement, with its quotation marks removed, is an EXACT
//   SUBSTRING of the text of at least one chunk it cites.
//
// That single property is what makes the whole thing safe, and it is checked by
// test rather than asserted in prose. Because a statement can only be a slice
// of a retrieved passage:
//
//   - it cannot invent causality — there is nowhere to write a "because";
//   - it cannot compute an SROI, a ratio, or any figure the document does not
//     already state — arithmetic has no output channel;
//   - it cannot approve a methodology or certify an impact — an approval is a
//     sentence no evidence document contains about this request;
//   - a citation cannot drift from its statement, because the statement was cut
//     out of the cited text.
//
// Construction, not validation. `buildGroundedAnswer` already refuses to take
// `quotedTextHash`, `versionId` or `location` from a draft; this generator adds
// that it does not author the prose either.

import {
  GroundingScopeViolationError,
  isSameScope,
  type ContentHash,
  type GroundingChunk,
} from '../contracts'
import { tokenize } from '../embedding-provider'
import type { AnswerDraft, DraftClaim, DraftContradiction, DraftContradictionSide } from './grounded-answer'
import type { AnswerDraftProvider, AnswerDraftRequest } from './orchestrate'
import { normalizeQueryText } from './scorer'

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const EXTRACTIVE_GENERATOR_NAME = 'grounding-local-extractive' as const

/**
 * Version of the EXTRACTION CONTRACT: which sentences are selected and how they
 * are assembled into a statement. Bumping it means two runs over the same
 * retrieval can differ, so a stored answer is only reproducible against the
 * version that produced it — the same reason `ChunkScorer.id` and
 * `EXTRACTOR_VERSION` are versioned.
 */
export const EXTRACTIVE_GENERATOR_VERSION = 'extractive-1' as const

/** Recorded in orchestration provenance; see {@link AnswerDraftProvider.id}. */
export const EXTRACTIVE_GENERATOR_ID = `${EXTRACTIVE_GENERATOR_NAME}/${EXTRACTIVE_GENERATOR_VERSION}` as const

/**
 * The quotation marks a statement is wrapped in.
 *
 * Present so a reader is never shown extracted text formatted as though Stella
 * had written it, and exported so a consumer can recover the raw passage
 * without guessing the convention. Angle quotes rather than `"` because the
 * evidence corpus is Spanish-language and `"` occurs inside documents.
 */
export const EXTRACTIVE_QUOTE_OPEN = '«' as const
export const EXTRACTIVE_QUOTE_CLOSE = '»' as const

/** Recover the verbatim passage from a statement this generator produced. */
export function unwrapExtractiveStatement(statement: string): string {
  if (statement.startsWith(EXTRACTIVE_QUOTE_OPEN) && statement.endsWith(EXTRACTIVE_QUOTE_CLOSE)) {
    return statement.slice(EXTRACTIVE_QUOTE_OPEN.length, statement.length - EXTRACTIVE_QUOTE_CLOSE.length)
  }
  return statement
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * A contradiction someone else established, transported into the draft.
 *
 * THIS GENERATOR NEVER DETECTS CONTRADICTIONS. Deciding that two passages
 * cannot both be true is a semantic judgement, and a lexical extractor making
 * it would be inventing exactly the kind of claim this module exists to avoid —
 * two documents stating different figures may be measuring different things.
 * So contradictions arrive as explicit markers naming two chunk ids, from a
 * reviewer or from a detector that is not this one, and the generator only
 * carries them to the answer builder, which independently requires BOTH sides
 * to resolve to retrieved chunks.
 */
export interface DeclaredContradiction {
  readonly summary: string
  readonly sideAChunkId: ContentHash
  readonly sideBChunkId: ContentHash
}

export interface ExtractiveGeneratorOptions {
  /**
   * Distinct query terms a sentence must contain to be quotable. FIRST-PASS
   * and unmeasured, like every threshold in this module's neighbours: 1 means
   * "mentions something the question asked about", which is the weakest defensible
   * floor and the one that keeps retrieval's `minScore` as the real filter.
   */
  readonly minTermMatches?: number
  /**
   * How many contiguous sentences one quotation may span. Two, so a figure and
   * the clause that qualifies it can travel together; more would start quoting
   * whole passages, which is what the chunk itself already is. Unmeasured.
   */
  readonly maxSentencesPerClaim?: number
  /** Contradictions established elsewhere. Never inferred here. */
  readonly contradictions?: readonly DeclaredContradiction[]
}

export const DEFAULT_MIN_TERM_MATCHES = 1
export const DEFAULT_MAX_SENTENCES_PER_CLAIM = 2

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Build the local extractive answer provider.
 *
 * Returns an {@link AnswerDraftProvider}, so it plugs into
 * `orchestrateGroundedResponse` at the same seam a model would and the
 * orchestrator cannot tell the difference — which is the point of that seam.
 */
export function createExtractiveAnswerProvider(
  options: ExtractiveGeneratorOptions = {},
): AnswerDraftProvider {
  return {
    id: EXTRACTIVE_GENERATOR_ID,
    async draftAnswer(request: AnswerDraftRequest): Promise<AnswerDraft> {
      return draftExtractiveAnswer(request, options)
    },
  }
}

/**
 * The generator itself, as a pure synchronous function.
 *
 * Exported separately from the provider because it is a pure function of
 * (request, options) and testing it directly is what pins determinism. The
 * provider wrapper adds only the `Promise` the interface requires.
 *
 * THROWS only on a scope violation between the request and the retrieval it
 * carries — a composition defect, not an evidence condition. Every other
 * "cannot answer" is a returned draft with zero claims, which
 * `buildGroundedAnswer` turns into an abstention. That distinction is the whole
 * of "evidence gap is not provider failure": a throw from here becomes
 * `provider_unavailable`, so throwing when the evidence is merely silent would
 * tell a reviewer the system broke when in fact their corpus did not cover the
 * question.
 */
export function draftExtractiveAnswer(
  request: AnswerDraftRequest,
  options: ExtractiveGeneratorOptions = {},
): AnswerDraft {
  if (!isSameScope(request.scope, request.retrieval.query.scope)) {
    throw new GroundingScopeViolationError(
      request.scope,
      request.retrieval.query.scope,
      'the retrieval result handed to the extractive generator',
    )
  }

  const minTermMatches = options.minTermMatches ?? DEFAULT_MIN_TERM_MATCHES
  const maxSentences = options.maxSentencesPerClaim ?? DEFAULT_MAX_SENTENCES_PER_CLAIM
  const terms = new Set(normalizeQueryText(request.text).terms)

  // Rank order is retrieval's decision and is already deterministic (score,
  // then evidenceId, chunkIndex, chunkId). Re-sorting here would be a second,
  // divergent ranking.
  const candidates = [...request.retrieval.candidates].sort((a, b) => a.rank - b.rank)

  // Passages that yielded the same quotation are ONE claim citing several
  // chunks, not several claims saying the same thing. Grouping by the folded
  // quotation rather than by the raw slice means a document repeated with
  // different spacing still corroborates instead of duplicating.
  const groups = new Map<string, { passage: string; chunkIds: ContentHash[] }>()
  const groupOrder: string[] = []
  let unquotable = 0

  for (const candidate of candidates) {
    const passage = selectPassage(candidate.chunk, terms, minTermMatches, maxSentences)
    if (passage === null) {
      unquotable++
      continue
    }

    const key = foldForCorroboration(passage)
    const existing = groups.get(key)
    if (existing) {
      existing.chunkIds.push(candidate.chunk.chunkId)
      continue
    }
    groups.set(key, { passage, chunkIds: [candidate.chunk.chunkId] })
    groupOrder.push(key)
  }

  const claims: DraftClaim[] = groupOrder.map((key) => {
    const group = groups.get(key)!
    return {
      kind: 'evidence',
      statement: `${EXTRACTIVE_QUOTE_OPEN}${group.passage}${EXTRACTIVE_QUOTE_CLOSE}`,
      chunkIds: group.chunkIds,
    }
  })

  const contradictions = (options.contradictions ?? []).map((declared) =>
    toDraftContradiction(declared, claims),
  )

  return {
    claims,
    contradictions,
    // Stated only when something really was left out. A constant disclaimer
    // would push every answer to `partially_grounded` and make the distinction
    // between a complete and an incomplete answer carry no information.
    unanswered:
      unquotable > 0
        ? `${unquotable} retrieved passage(s) contain no sentence stating the question's terms, and this strategy quotes rather than summarises, so they were not used.`
        : null,
  }
}

// ---------------------------------------------------------------------------
// Passage selection
// ---------------------------------------------------------------------------

interface SentenceSpan {
  readonly start: number
  readonly end: number
}

/**
 * The best contiguous run of at most `maxSentences` sentences in this chunk,
 * or null when no sentence carries enough of the query's terms.
 *
 * "Best" is: most distinct query terms covered; ties to the SHORTEST run, then
 * to the EARLIEST. Shortest-first matters — preferring the longer window on a
 * tie would quote a whole chunk whenever one sentence already sufficed, and a
 * quotation that includes unrelated sentences is how an extractive answer
 * starts implying things it never said.
 *
 * Returned verbatim: `text.slice(start, end)` of the chunk. This is where the
 * module's invariant is actually created.
 */
function selectPassage(
  chunk: GroundingChunk,
  terms: ReadonlySet<string>,
  minTermMatches: number,
  maxSentences: number,
): string | null {
  if (terms.size === 0) return null

  const sentences = splitSentences(chunk.text)
  if (sentences.length === 0) return null

  let best: { start: number; end: number; covered: number; length: number } | null = null

  for (let i = 0; i < sentences.length; i++) {
    for (let span = 1; span <= maxSentences && i + span <= sentences.length; span++) {
      const start = sentences[i].start
      const end = sentences[i + span - 1].end
      const covered = countCoveredTerms(chunk.text.slice(start, end), terms)
      if (covered < minTermMatches) continue

      const length = end - start
      if (
        best === null ||
        covered > best.covered ||
        (covered === best.covered && length < best.length) ||
        (covered === best.covered && length === best.length && start < best.start)
      ) {
        best = { start, end, covered, length }
      }
    }
  }

  if (best === null) return null
  return chunk.text.slice(best.start, best.end)
}

function countCoveredTerms(text: string, terms: ReadonlySet<string>): number {
  const present = new Set<string>()
  for (const token of tokenize(text)) {
    if (terms.has(token)) present.add(token)
  }
  return present.size
}

/**
 * Split into sentence spans, preserving offsets into the original text.
 *
 * A sentence ends at `.`, `!`, `?`, `…` followed by whitespace or end of text,
 * or at a line break — line breaks matter because much of the evidence corpus
 * is CSV rows and bullet lists, where a row IS the unit of meaning and no
 * terminator is written. Leading whitespace is excluded from a span and
 * trailing whitespace is trimmed, so a quotation never opens or closes on a
 * blank; the offsets stay exact, so the slice stays verbatim.
 *
 * Abbreviations ("art. 5", "S.A.") over-split. That is accepted: an over-split
 * quotation is short and still verbatim, whereas an abbreviation dictionary
 * would be a language-specific list that silently decides where meaning ends.
 */
function splitSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = []
  let cursor = 0

  const push = (start: number, end: number) => {
    let from = start
    let to = end
    while (from < to && isWhitespace(text[from])) from++
    while (to > from && isWhitespace(text[to - 1])) to--
    if (to > from) spans.push({ start: from, end: to })
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') {
      push(cursor, i)
      cursor = i + 1
      continue
    }
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      // Consume a run of terminators ("?!", "...") so they stay with the
      // sentence they end rather than opening the next one.
      let end = i + 1
      while (end < text.length && (text[end] === '.' || text[end] === '!' || text[end] === '?' || text[end] === '…')) {
        end++
      }
      if (end >= text.length || isWhitespace(text[end])) {
        push(cursor, end)
        cursor = end
        i = end - 1
      }
    }
  }

  push(cursor, text.length)
  return spans
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
}

/**
 * The key two passages must share to count as corroboration rather than as two
 * separate findings. Folded through the same `tokenize` retrieval scores with,
 * so "El total fue 42." and "el total fue 42" corroborate.
 */
function foldForCorroboration(passage: string): string {
  return tokenize(passage).join(' ')
}

// ---------------------------------------------------------------------------
// Contradictions
// ---------------------------------------------------------------------------

/**
 * Turn a declared contradiction into the draft shape, attributing each side to
 * the claim that quoted that chunk when there is one.
 *
 * Attribution is OMITTED rather than fabricated when no claim quoted a side's
 * chunk: `DraftContradictionSide` names a claim the generator made, and naming
 * one it did not make would put a statement into the attribution that appears
 * nowhere in the answer. The contradiction still travels — `buildGroundedAnswer`
 * validates both sides against the retrieved set independently of attribution.
 */
function toDraftContradiction(
  declared: DeclaredContradiction,
  claims: readonly DraftClaim[],
): DraftContradiction {
  return {
    summary: declared.summary,
    sideAChunkIds: [declared.sideAChunkId],
    sideBChunkIds: [declared.sideBChunkId],
    sideAClaim: attributionFor(declared.sideAChunkId, claims),
    sideBClaim: attributionFor(declared.sideBChunkId, claims),
  }
}

/**
 * `claimId` names the CLAIM, not the contradiction it appears in: the same
 * claim sustaining two different contradictions must carry the same id, or a
 * consumer tracking claim identity would see two claims where there is one.
 * `assertionHash` — derived inside `buildGroundedAnswer`, never here — is what
 * distinguishes two claims that happen to cite the same chunk.
 */
function attributionFor(
  chunkId: ContentHash,
  claims: readonly DraftClaim[],
): DraftContradictionSide | null {
  const claimIndex = claims.findIndex((claim) => claim.chunkIds.includes(chunkId))
  if (claimIndex === -1) return null
  return {
    // Derived from position, not from a counter or a clock: the same retrieval
    // produces the same ids on every run.
    claimId: `${EXTRACTIVE_GENERATOR_NAME}-claim-${claimIndex}`,
    statement: claims[claimIndex].statement,
  }
}

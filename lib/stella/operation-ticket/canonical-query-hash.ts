// lib/stella/operation-ticket/canonical-query-hash.ts
// INTEGRATION — Train 4.1, INT-INT-001 §7 (1).
//
// The Node half of the query-digest contract. `db/prepared/stella_0014` states
// the SQL half in one sentence and deliberately implements none of it:
//
//   "El texto de la consulta nunca cruza la frontera de la base."
//
// The ticket table has no column able to hold a query, and no published
// function accepts text — precisely so the question cannot reach a server log
// through the database. What the database imposes is only the SHAPE (64
// lowercase hex, write-once, and a refusal of a different digest on the same
// ticket, `U0107`). Everything upstream of that shape lives here.
//
// ---------------------------------------------------------------------------
// THE CONTRACT, VERBATIM FROM INT-INT-001 §5
// ---------------------------------------------------------------------------
//
//   canonical(q) = collapse_ws(trim(NFC(q)))
//       NFC          Unicode NFC normalization
//       trim         strip leading and trailing whitespace
//       collapse_ws  every internal whitespace run -> a single U+0020
//       NO case folding
//
//   query_hash = sha256_hex(utf8('stella/query/v1' || LF || canonical(q)))
//
// ---------------------------------------------------------------------------
// WHY THE ORDER IS NFC FIRST
// ---------------------------------------------------------------------------
// NFC composes decomposed sequences (a bare "e" followed by U+0301 becomes a
// single precomposed code point). Trimming or collapsing first would operate
// on a string whose code-point boundaries are about to move, and two spellings
// of the same accented word would then agree only if the whitespace around
// them happened to agree too. Normalizing first makes the later two steps
// operate on an already-canonical code-point sequence.
//
// ---------------------------------------------------------------------------
// WHY NO CASE FOLDING — AND WHY THAT IS THE CONSERVATIVE CHOICE
// ---------------------------------------------------------------------------
// The digest's job is to detect that a RETRY carries the SAME question. An
// automatic retry resends identical bytes, so preserving case costs the retry
// path nothing. Folding, by contrast, is locale-dependent (the Turkish dotless
// i is the standard example) and can only ever make two DIFFERENT questions
// collide — which, in this protocol, means a second legitimate question
// silently reusing a ticket and going free. Distinguishing more than necessary
// is free; distinguishing less is a billing error.
//
// ---------------------------------------------------------------------------
// WHY COLLAPSING WHITESPACE IS SAFE WHERE FOLDING IS NOT
// ---------------------------------------------------------------------------
// Re-serialization (a textarea normalizing newlines, a transport re-wrapping a
// paragraph) perturbs whitespace and nothing else, and collapsing absorbs
// exactly that class of difference. It cannot merge two semantically distinct
// questions, because no pair of distinct questions differs ONLY by whitespace
// runs — the words still have to match, in order, with matching case.

import { createHash } from 'node:crypto'

/**
 * The version namespace. Present in the digest input so that a future change
 * to the canonicalization rules produces a DIFFERENT digest for the same text
 * rather than silently colliding with digests minted under the old rules — a
 * collision that, here, would let a v2 retry replay a v1 ticket.
 *
 * Deliberately a different string from the namespace `stella_0014` uses to
 * derive the CHARGE key (`stella/ticket/charge/v1`), so a query digest can
 * never be presented as a charge key or the reverse.
 */
export const CANONICAL_QUERY_NAMESPACE = 'stella/query/v1'

/**
 * The separator. U+000A, written as an escape rather than as a literal newline
 * inside a template, so that a file-level CRLF conversion — which this
 * repository has hit before — cannot silently change the digest of every query
 * in the product.
 */
const LF = '\n'

/**
 * Unicode whitespace, as ECMAScript defines `\s`: form feed, line feed,
 * carriage return, tab, vertical tab, space, NBSP, Ogham space mark, the
 * U+2000-U+200A block, line and paragraph separators, narrow NBSP, medium
 * mathematical space, ideographic space and BOM.
 *
 * Written out as ESCAPE TEXT rather than left as `\s` for two reasons. First,
 * "what counts as whitespace" becomes a fact stated in this file and testable
 * against a fixed vector list, instead of a property of whichever ECMAScript
 * version the runtime implements. Second, a source file holding a literal
 * U+00A0 or U+FEFF is one editor save away from losing it silently — and
 * losing it would change the digest of every query containing one without
 * changing a single visible character of this file.
 *
 * NBSP and the ideographic space are the two that matter in practice: both are
 * produced by real editors, and both must collapse, or a paste from a word
 * processor becomes a different question than the same words typed by hand.
 */
const WHITESPACE_CLASS =
  '\\f\\n\\r\\t\\v\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'

const WHITESPACE_RUN = new RegExp(`[${WHITESPACE_CLASS}]+`, 'gu')
const EDGE_WHITESPACE = new RegExp(`^[${WHITESPACE_CLASS}]+|[${WHITESPACE_CLASS}]+$`, 'gu')

/**
 * `canonical(q)` — the exact three steps of INT-INT-001 §5, in order.
 *
 * Exported separately from the digest because the cross-engine vector test
 * needs the intermediate value: it hands this string to PostgreSQL and asks
 * the database to compute the digest itself, which is what proves the two
 * engines frame `sha256(namespace || LF || canonical)` identically. A test
 * that only compared two Node results would be comparing a function with
 * itself.
 */
export function canonicalizeQuery(query: string): string {
  // NFC first — see the header.
  const normalized = query.normalize('NFC')
  // Trim, then collapse. Trimming first means a leading run never becomes a
  // leading U+0020 that the trim would afterwards have to remove again.
  return normalized.replace(EDGE_WHITESPACE, '').replace(WHITESPACE_RUN, ' ')
}

/**
 * `query_hash` — 64 lowercase hex characters, the shape
 * `operation_tickets_query_hash_shape_check` and every one of `stella_0014`'s
 * functions enforce with `~ '^[0-9a-f]{64}$'`.
 *
 * `convert_to(..., 'UTF8')` on the SQL side and `Buffer.from(s, 'utf8')` here
 * are the same bytes. The digest is taken over BYTES, never over a JavaScript
 * string, so an astral-plane character cannot hash differently depending on
 * how an engine counts characters.
 */
export function canonicalQueryHash(query: string): string {
  const canonical = canonicalizeQuery(query)
  return createHash('sha256')
    .update(Buffer.from(`${CANONICAL_QUERY_NAMESPACE}${LF}${canonical}`, 'utf8'))
    .digest('hex')
}

/**
 * Whether a value has the shape the database will accept. Used at the adapter
 * boundary so a malformed digest is refused in Node with a typed result rather
 * than reaching PostgreSQL and coming back as a `U0100` exception the caller
 * would then have to classify.
 */
export function isCanonicalQueryHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

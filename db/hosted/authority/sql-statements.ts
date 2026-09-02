// db/hosted/authority/sql-statements.ts
// COMMIT 3 — the lexical layer the authority plan stands on.
//
// ---------------------------------------------------------------------------
// WHY A LEXER AND NOT A REGEX
// ---------------------------------------------------------------------------
// `db/hosted/rewrite-rules.ts` gets away with regexes because every rule it owns
// is anchored on a whole, textually uniform statement it can afford to miss
// loudly (the manifest pins how many times each fires). The authority plan
// cannot afford that. It has to answer "which statements sit between these two"
// over files that contain, inside dollar-quoted PL/pgSQL bodies:
//
//   - semicolons             (`PERFORM 1;` inside a DO block);
//   - `--` inside strings    (`RAISE NOTICE 'a -- b'`);
//   - whole SQL statements   (`EXECUTE 'ALTER FUNCTION ... OWNER TO ...'`).
//
// A regex that splits on `;` turns one DO block into fourteen statements and
// then reports a window count that looks plausible. So: one scanner, applied
// once, and every consumer reads segments rather than characters.
//
// ---------------------------------------------------------------------------
// WHAT "NORMALIZED EXECUTABLE" MEANS, PRECISELY
// ---------------------------------------------------------------------------
// Comments out. Whitespace between tokens collapsed to one space. Everything
// inside a string literal, a dollar-quoted body or a quoted identifier kept
// BYTE FOR BYTE — because `RAISE EXCEPTION 'a  b'` and `RAISE EXCEPTION 'a b'`
// are two different messages an operator will read at three in the morning, and
// a normalizer that flattened them would let one become the other silently.
//
// The one deliberate exception is recursion: a DO body, and a plpgsql/sql
// function body, ARE code, so the same normalization is applied *inside* them.
// That is what makes a comment added inside a DO block semantically neutral
// while a changed `PERFORM` is not. The recursion re-enters this same scanner,
// so a string literal nested three levels down is still protected.

/** What a run of characters is, lexically. Everything is exactly one of these. */
export type SqlSegmentKind =
  | 'code'
  | 'line-comment'
  | 'block-comment'
  | 'string'
  | 'dollar-string'
  | 'quoted-identifier'

export interface SqlSegment {
  readonly kind: SqlSegmentKind
  /** Verbatim source, including the delimiters. */
  readonly text: string
  readonly start: number
  readonly end: number
  /** For `dollar-string` only: the tag, without the `$` signs. `$$` gives ''. */
  readonly dollarTag?: string
  /** For `dollar-string` only: the body between the delimiters. */
  readonly dollarBody?: string
}

const IDENT_START = /[A-Za-z_\u0080-\uffff]/
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/

/** Matches a dollar-quote opener at `i`, returning the whole `$tag$` or null. */
function dollarOpenerAt(sql: string, i: number): string | null {
  if (sql[i] !== '$') return null
  // `$1` is a positional parameter, not a quote opener. `a$$` is a continuation
  // of an identifier, not an opener — PostgreSQL allows `$` inside identifiers.
  if (i > 0 && IDENT_CHAR.test(sql[i - 1])) return null

  let j = i + 1
  while (j < sql.length && sql[j] !== '$') {
    const c = sql[j]
    const ok = j === i + 1 ? IDENT_START.test(c) : IDENT_CHAR.test(c) && c !== '$'
    if (!ok) return null
    j += 1
  }
  if (j >= sql.length) return null
  return sql.slice(i, j + 1)
}

/**
 * Splits `sql` into segments. Total coverage: concatenating every `text` in
 * order reproduces the input exactly. That property is asserted by a test, and
 * it is what lets the normalizer rebuild a statement without losing a byte it
 * did not mean to lose.
 */
export function lexSql(sql: string): SqlSegment[] {
  const segments: SqlSegment[] = []
  let codeStart = 0
  let i = 0

  const flushCode = (upTo: number): void => {
    if (upTo > codeStart) {
      segments.push({ kind: 'code', text: sql.slice(codeStart, upTo), start: codeStart, end: upTo })
    }
  }

  while (i < sql.length) {
    const c = sql[i]

    if (c === '-' && sql[i + 1] === '-') {
      flushCode(i)
      let j = sql.indexOf('\n', i)
      if (j === -1) j = sql.length
      segments.push({ kind: 'line-comment', text: sql.slice(i, j), start: i, end: j })
      codeStart = j
      i = j
      continue
    }

    if (c === '/' && sql[i + 1] === '*') {
      flushCode(i)
      // PostgreSQL block comments NEST. A non-nesting scanner ends the comment
      // at the first `*/` and hands the rest of a nested comment back as code,
      // where a stray `'` inside it would open a phantom string literal.
      let depth = 1
      let j = i + 2
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1
          j += 2
        } else {
          j += 1
        }
      }
      segments.push({ kind: 'block-comment', text: sql.slice(i, j), start: i, end: j })
      codeStart = j
      i = j
      continue
    }

    if (c === "'" || ((c === 'E' || c === 'e') && sql[i + 1] === "'")) {
      const escapeString = c !== "'"
      const open = escapeString ? i + 1 : i
      flushCode(i)
      let j = open + 1
      while (j < sql.length) {
        if (escapeString && sql[j] === '\\') {
          j += 2
          continue
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      segments.push({ kind: 'string', text: sql.slice(i, j), start: i, end: j })
      codeStart = j
      i = j
      continue
    }

    if (c === '"') {
      flushCode(i)
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      segments.push({ kind: 'quoted-identifier', text: sql.slice(i, j), start: i, end: j })
      codeStart = j
      i = j
      continue
    }

    const opener = dollarOpenerAt(sql, i)
    if (opener !== null) {
      flushCode(i)
      const closeAt = sql.indexOf(opener, i + opener.length)
      const j = closeAt === -1 ? sql.length : closeAt + opener.length
      const body =
        closeAt === -1 ? sql.slice(i + opener.length) : sql.slice(i + opener.length, closeAt)
      segments.push({
        kind: 'dollar-string',
        text: sql.slice(i, j),
        start: i,
        end: j,
        dollarTag: opener.slice(1, -1),
        dollarBody: body,
      })
      codeStart = j
      i = j
      continue
    }

    i += 1
  }

  flushCode(sql.length)
  return segments
}

export interface SqlStatement {
  /** Position in the file, from zero. The plan's only use of ordinal position. */
  readonly index: number
  /** Verbatim, from just after the previous terminator to this one inclusive. */
  readonly raw: string
  /** Comments out, whitespace collapsed, literals verbatim. Top level only. */
  readonly executable: string
  readonly startOffset: number
  readonly endOffset: number
}

/**
 * Collapses a run of segments into normalized executable text.
 *
 * `recurseIntoBodies` is what separates "this DO block gained a comment" from
 * "this DO block gained a statement". It is decided per statement by
 * {@link statementBodiesAreCode}, never guessed per segment: a dollar-quoted
 * blob in a package that is not a DO block and not a plpgsql routine is DATA,
 * and stripping comments out of data would corrupt it.
 */
function normalizeSegments(segments: readonly SqlSegment[], recurseIntoBodies: boolean): string {
  /**
   * Two kinds of part, and the distinction is the whole point.
   *
   * `collapsible` parts are code and comments: runs of whitespace in them mean
   * nothing, so they collapse. `verbatim` parts are literals: every byte in them
   * is content. An earlier version collapsed whitespace over the JOINED string,
   * which was wrong in a way a test caught — it turned `RAISE EXCEPTION 'a  b'`
   * into `'a b'`, so an operator-facing message could be edited without the
   * digest noticing.
   */
  const parts: { text: string; collapsible: boolean }[] = []

  for (const segment of segments) {
    switch (segment.kind) {
      case 'code':
        parts.push({ text: segment.text, collapsible: true })
        break
      case 'line-comment':
      case 'block-comment':
        // A space, not nothing: `SELECT 1/*x*/+2` must not become `SELECT 1+2`
        // in a way that could ever glue two tokens into one.
        parts.push({ text: ' ', collapsible: true })
        break
      case 'string':
      case 'quoted-identifier':
        parts.push({ text: segment.text, collapsible: false })
        break
      case 'dollar-string': {
        if (!recurseIntoBodies) {
          parts.push({ text: segment.text, collapsible: false })
          break
        }
        const tag = `$${segment.dollarTag ?? ''}$`
        const inner = normalizeSegments(lexSql(segment.dollarBody ?? ''), true)
        parts.push({ text: `${tag}${inner}${tag}`, collapsible: false })
        break
      }
    }
  }

  const out: string[] = []
  let pendingSpace = false

  for (const part of parts) {
    if (!part.collapsible) {
      if (pendingSpace && out.length > 0) out.push(' ')
      pendingSpace = false
      out.push(part.text)
      continue
    }

    let text = part.text.replace(/\s+/g, ' ')
    if (text === ' ') {
      pendingSpace = true
      continue
    }
    if (text.startsWith(' ')) {
      pendingSpace = true
      text = text.slice(1)
    }
    const trailing = text.endsWith(' ')
    if (trailing) text = text.slice(0, -1)

    if (pendingSpace && out.length > 0) out.push(' ')
    pendingSpace = trailing
    if (text.length > 0) out.push(text)
  }

  return out.join('')
}

/**
 * True when the dollar-quoted regions of `statement` are code rather than data.
 *
 * Deliberately narrow. `DO` always is. A routine is only if it declares itself
 * `LANGUAGE plpgsql` or `LANGUAGE sql` — the two languages whose comment syntax
 * this scanner actually models. Anything else falls back to treating the body
 * as an opaque literal, which makes the digest STRICTER (a comment change would
 * invalidate it) rather than looser. Stricter is the safe direction to be wrong
 * in: it refuses, it does not admit.
 */
function statementBodiesAreCode(topLevelCode: string): boolean {
  const head = topLevelCode.trimStart().slice(0, 400).toUpperCase()
  if (/^DO\b/.test(head)) return true
  if (!/^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/.test(head)) return false
  return /\bLANGUAGE\s+(PLPGSQL|SQL)\b/.test(topLevelCode.toUpperCase())
}

/** Comments out, whitespace collapsed, literals verbatim, bodies left opaque. */
export function normalizeTopLevel(sql: string): string {
  return normalizeSegments(lexSql(sql), false)
}

/**
 * Comments out at EVERY level, whitespace collapsed at every level, string
 * literals verbatim at every level. This is the text the digest hashes.
 */
export function normalizeExecutable(sql: string): string {
  const segments = lexSql(sql)
  const topLevelCode = segments
    .filter((s) => s.kind === 'code')
    .map((s) => s.text)
    .join(' ')
  return normalizeSegments(segments, statementBodiesAreCode(topLevelCode))
}

/**
 * Splits a package into top-level statements.
 *
 * Terminators are recognised only in `code` segments at parenthesis depth zero.
 * The depth test is not decoration: `CREATE TABLE t (a int, b int);` has no
 * nested semicolon today, but a future `CHECK (...)` containing one would be
 * split into two half-statements, and the second half would be classified as
 * `unknown` — a refusal, which is survivable, rather than two windows that
 * happen to add up, which is not.
 *
 * Trailing text with no terminator is returned as a final statement so that a
 * truncated file refuses at classification instead of losing its tail.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const normalized = sql.replace(/\r\n?/g, '\n')
  const segments = lexSql(normalized)
  const statements: SqlStatement[] = []

  let statementStart = 0
  let depth = 0

  const push = (endOffset: number): void => {
    const raw = normalized.slice(statementStart, endOffset)
    if (raw.trim().length === 0) return
    const executable = normalizeTopLevel(raw)
    if (executable.length === 0) return
    statements.push({
      index: statements.length,
      raw,
      executable,
      startOffset: statementStart,
      endOffset,
    })
  }

  for (const segment of segments) {
    if (segment.kind !== 'code') continue
    for (let k = 0; k < segment.text.length; k += 1) {
      const c = segment.text[k]
      if (c === '(') depth += 1
      else if (c === ')') depth = Math.max(0, depth - 1)
      else if (c === ';' && depth === 0) {
        const endOffset = segment.start + k + 1
        push(endOffset)
        statementStart = endOffset
      }
    }
  }

  push(normalized.length)
  return statements
}

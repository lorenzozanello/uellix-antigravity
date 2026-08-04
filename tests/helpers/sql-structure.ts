// tests/helpers/sql-structure.ts
//
// A structural reader for the DDL the capability packages are made of.
//
// It exists because existence regexes cannot express the properties the design
// claims. "There are nine cap_invitation_* policies and three say RESTRICTIVE"
// is true of the correct package AND of a package whose RESTRICTIVE policy now
// names uellix_app, or whose USING clause now reads `true`. The gate has to
// compare TUPLES, so something has to produce them.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE WAS REBUILT AS A LEXER RATHER THAN A MASK
// ---------------------------------------------------------------------------
// The first version masked comments and string literals and then ran regexes
// over the mask. That construction is why eight PostgreSQL-equivalent ways of
// expressing a security operation went undetected:
//
//   1. Masking makes a `$$ \u2026 $$` body OPAQUE, so DDL inside a DO block \u2014 either
//      written out or executed from a literal built with format() \u2014 was not
//      merely unparsed, it was invisible.
//   2. Every identifier pattern was `[A-Za-z_][\w$]*`. `"uellix_cap_lead"`,
//      `"public"."marketing_leads"` and `"cap_escape_policy"` match none of
//      them, so a quoted grantee, a quoted table and a quoted policy name each
//      removed the statement from the parser's view entirely.
//   3. `parseAcl` took the FIRST `TO` and never split the member list, so
//      `GRANT uellix_owner, uellix_writer TO uellix_cap_lead` was rejected by
//      `/^[A-Za-z_][\w$]*$/` and skipped by a bare `continue`.
//   4. The role-attribute gate anchored on a BARE role name, so
//      `ALTER ROLE "uellix_cap_lead" BYPASSRLS SUPERUSER;` did not match the
//      statement it was written to find.
//   5. `REASSIGN OWNED` and `DROP OWNED` appear in no pattern at all.
//   6. `/* \u2026 */` was treated as non-nesting. PostgreSQL NESTS block comments,
//      so `/* outer /* inner */ REVOKE \u2026 ; */` executes nothing while the old
//      masker believed the REVOKE survived \u2014 and the gate that requires it
//      stayed green.
//
// Every one of those is the same defect wearing a different hat: the parser had
// its own idea of PostgreSQL's lexical structure, and where the two diverged
// the divergence was SILENT. A missing match was read as an absent statement,
// which is the exact inversion a security gate must never make.
//
// So the model here is:
//
//   lex()        one pass, PostgreSQL's own lexical rules, producing tokens
//                and a per-character region map
//   scan()       walk the token stream for statement OPENERS, at any position,
//                including inside executable bodies
//   classify()   turn each opener's statement into a typed record, or into an
//                EXPLICIT `unparsed` finding
//
// The last line is the whole point. There is no path from "the parser did not
// understand this" to "there is nothing here". Anything that opens like a
// security statement and does not classify becomes a finding with a file, an
// offset and a reason.
//
// The extraction views (codeOnly / predicate text) still read the ORIGINAL
// characters with comments blanked, because that is what the contract compares
// \u2014 a predicate must be judged as written, not as re-serialised.

// ---------------------------------------------------------------------------
// 1. Lexer
// ---------------------------------------------------------------------------

/** What a character belongs to. Used to build the length-preserving views. */
const REGION_CODE = 0
const REGION_COMMENT = 1
const REGION_STRING = 2
const REGION_QUOTED_IDENT = 3

export type TokenKind = 'word' | 'ident' | 'string' | 'number' | 'punct' | 'param'

export interface SqlToken {
  readonly kind: TokenKind
  /**
   * The NORMALISED value, which is what PostgreSQL compares.
   *
   * Unquoted words fold to lower case; a double-quoted identifier keeps its
   * case and loses its quotes and its `""` escapes. That is the whole of
   * identifier equality in PostgreSQL, and it is why `"uellix_cap_lead"` and
   * `uellix_cap_lead` are the same role while `"RoleName"` and `rolename` are
   * two different ones.
   */
  readonly value: string
  /** Upper-cased `value` for words; '' for everything else. Keyword matching. */
  readonly upper: string
  /** Decoded contents of a string literal; '' otherwise. */
  readonly text: string
  /** The dollar-quote tag (`$$` -> '', `$body$` -> 'body'), or null. */
  readonly dollarTag: string | null
  /**
   * False when this token's TEXT is not the text PostgreSQL would see.
   *
   * `U&'…'` and `U&"…"` carry Unicode escapes whose meaning depends on an
   * optional UESCAPE clause. This model does not decode them, and a decoded
   * form that is merely CLOSE is worse than none: `EXECUTE U&'\0047RANT …'`
   * would re-lex as a word that opens nothing, and open nothing is exactly how
   * a statement disappears. Undecodable tokens make their statement a finding.
   */
  readonly decoded: boolean
  readonly start: number
  readonly end: number
  readonly quoted: boolean
}

const IDENT_START = /[A-Za-z_\u0080-\uffff]/
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uffff]/

/**
 * Decode ONE backslash escape of an `E''` string, PostgreSQL's rules.
 *
 * The first version of this function knew `\n`, `\t` and `\r` and dropped the
 * backslash from everything else. That is not a rounding error, it is a
 * fail-open: `EXECUTE E'\x47RANT SELECT ON public.marketing_leads TO
 * uellix_cap_lead'` decodes to a real GRANT for the server and to the text
 * `x47RANT …` for the parser — whose first word opens nothing, so the scanner
 * recorded no statement AND raised no finding. One escaped character in the
 * verb, ordinary everywhere else.
 *
 * Returns the decoded text and how many source characters it consumed,
 * counting the backslash.
 */
function decodeEscape(sql: string, at: number): { text: string; len: number } {
  const c = sql[at + 1]
  if (c === undefined) return { text: '', len: 1 }
  switch (c) {
    case 'b': return { text: '\b', len: 2 }
    case 'f': return { text: '\f', len: 2 }
    case 'n': return { text: '\n', len: 2 }
    case 'r': return { text: '\r', len: 2 }
    case 't': return { text: '\t', len: 2 }
    case 'v': return { text: '\v', len: 2 }
    default: break
  }
  // \xh, \xhh
  if (c === 'x') {
    const m = /^[0-9A-Fa-f]{1,2}/.exec(sql.slice(at + 2))
    if (m) return { text: String.fromCodePoint(parseInt(m[0], 16)), len: 2 + m[0].length }
    return { text: 'x', len: 2 }
  }
  // \uXXXX and \UXXXXXXXX
  if (c === 'u' || c === 'U') {
    const width = c === 'u' ? 4 : 8
    const m = new RegExp(`^[0-9A-Fa-f]{${width}}`).exec(sql.slice(at + 2))
    if (m) {
      const cp = parseInt(m[0], 16)
      // A lone surrogate is not a code point; PostgreSQL rejects it, and
      // String.fromCodePoint would throw.
      if (cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff))
        return { text: String.fromCodePoint(cp), len: 2 + width }
    }
    return { text: c, len: 2 }
  }
  // \o, \oo, \ooo — octal
  if (c >= '0' && c <= '7') {
    const m = /^[0-7]{1,3}/.exec(sql.slice(at + 1))!
    return { text: String.fromCodePoint(parseInt(m[0], 8)), len: 1 + m[0].length }
  }
  // Anything else: the backslash is dropped and the character stands.
  return { text: c, len: 2 }
}

/** String-literal prefixes PostgreSQL accepts before the opening quote. */
function stringPrefixAt(
  sql: string,
  i: number,
): { len: number; escapes: boolean; decoded: boolean } | null {
  const c = sql[i]
  const c1 = sql[i + 1]
  // A bare quote always opens a string, whatever precedes it.
  if (c === "'") return { len: 0, escapes: false, decoded: true }
  if (!c1) return null
  // A PREFIX only applies when it is not the tail of an identifier:
  // `some_value'x'` is an identifier followed by a string, not an E-string, and
  // reading it as one swallows the closing quote and shifts every token after
  // it — after which the file is either invisible or mis-terminated.
  const prev = i > 0 ? sql[i - 1] : ''
  if (prev && IDENT_PART.test(prev)) return null
  const up = c.toUpperCase()
  if (c1 === "'") {
    if (up === 'E') return { len: 1, escapes: true, decoded: true }
    if (up === 'B' || up === 'X' || up === 'N') return { len: 1, escapes: false, decoded: true }
    return null
  }
  // U&'\u2026' \u2014 Unicode escapes whose escape character is settable with UESCAPE.
  // NOT decoded here: a decoding that is merely close is worse than none,
  // because the near-miss re-lexes as a word that opens nothing. Marked
  // undecoded so the statement containing it becomes a finding.
  if (up === 'U' && c1 === '&' && sql[i + 2] === "'") return { len: 2, escapes: false, decoded: false }
  return null
}

interface Lexed {
  readonly src: string
  readonly region: Uint8Array
  readonly tokens: readonly SqlToken[]
  /**
   * Literals and bodies that never closed.
   *
   * An unterminated `'…'` or `$body$…` swallows the REST OF THE FILE as one
   * string token. Every statement after it becomes invisible, and invisible is
   * the one outcome this parser exists to prevent — the `unterminated-body`
   * reason was declared and never emitted, so the lexer failed open on exactly
   * the condition it named. The only backstop was a `$$`-parity count, which
   * cannot see a TAGGED quote or a single-quoted string, and which ran over the
   * forward files only.
   */
  readonly unterminated: ReadonlyArray<{ offset: number; kind: string }>
}

const LEX_CACHE = new Map<string, Lexed>()

/**
 * One pass over `sql`, producing every token and a per-character region map.
 *
 * Memoised because the gates call the parsers many times over the same ten
 * files and each call would otherwise re-lex 40 KB. The cache key is the text
 * itself, so a mutated copy is a different entry \u2014 mutants never read a cached
 * parse of the original, which is the property that matters here.
 */
function lex(sql: string): Lexed {
  const cached = LEX_CACHE.get(sql)
  if (cached) return cached

  const n = sql.length
  const region = new Uint8Array(n)
  region.fill(REGION_CODE)
  const tokens: SqlToken[] = []
  const unterminated: Array<{ offset: number; kind: string }> = []
  let i = 0

  const paint = (from: number, to: number, kind: number) => {
    for (let k = from; k < to && k < n; k++) region[k] = kind
  }

  while (i < n) {
    const c = sql[i]

    // -- whitespace ---------------------------------------------------------
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i++
      continue
    }

    // -- line comment -------------------------------------------------------
    if (c === '-' && sql[i + 1] === '-') {
      const start = i
      while (i < n && sql[i] !== '\n') i++
      paint(start, i, REGION_COMMENT)
      continue
    }

    // -- block comment, NESTED ----------------------------------------------
    //
    // PostgreSQL nests these. A parser that does not is not merely imprecise:
    // `/* outer /* inner */ REVOKE \u2026 ; */` leaves the REVOKE inside a comment
    // for the server and outside one for the parser, so the gate that requires
    // the REVOKE passes on a file that does not contain it.
    if (c === '/' && sql[i + 1] === '*') {
      const start = i
      let depth = 0
      while (i < n) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
          continue
        }
        if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
          if (depth === 0) break
          continue
        }
        i++
      }
      paint(start, i, REGION_COMMENT)
      continue
    }

    // -- dollar quoting -----------------------------------------------------
    if (c === '$') {
      const tagM = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(sql.slice(i))
      if (tagM) {
        const tag = tagM[0]
        const start = i
        const bodyStart = i + tag.length
        const close = sql.indexOf(tag, bodyStart)
        if (close === -1) unterminated.push({ offset: start, kind: `dollar quote ${tag}` })
        const bodyEnd = close === -1 ? n : close
        const end = close === -1 ? n : close + tag.length
        paint(start, end, REGION_STRING)
        tokens.push({
          kind: 'string',
          value: '',
          upper: '',
          text: sql.slice(bodyStart, bodyEnd),
          dollarTag: tagM[1] ?? '',
          start,
          end,
          quoted: true,
          decoded: true,
        })
        i = end
        continue
      }
      // $1, $2 \u2014 positional parameters.
      const paramM = /^\$\d+/.exec(sql.slice(i))
      if (paramM) {
        tokens.push({ kind: 'param', value: paramM[0], upper: '', text: '', dollarTag: null, start: i, end: i + paramM[0].length, quoted: false, decoded: true })
        i += paramM[0].length
        continue
      }
      tokens.push({ kind: 'punct', value: '$', upper: '', text: '', dollarTag: null, start: i, end: i + 1, quoted: false, decoded: true })
      i++
      continue
    }

    // -- string literals, with their prefixes -------------------------------
    const prefix = stringPrefixAt(sql, i)
    if (prefix) {
      const start = i
      i += prefix.len + 1 // past the prefix and the opening quote
      let buf = ''
      let closed = false
      while (i < n) {
        if (prefix.escapes && sql[i] === '\\') {
          // E'' honours backslash escapes, so \' does NOT close the string —
          // and \x47 is the letter G, not the three characters x47.
          const dec = decodeEscape(sql, i)
          buf += dec.text
          i += dec.len
          continue
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          buf += "'"
          i += 2
          continue
        }
        if (sql[i] === "'") {
          i++
          closed = true
          // Adjacent literals separated only by a newline are ONE string in
          // PostgreSQL. Not exercised by these packages, and folding them here
          // would be a second lexical rule to get wrong; the literal simply
          // ends, and any continuation lexes as its own string token \u2014 which
          // is conservative in the safe direction, since both halves are still
          // scanned.
          break
        }
        buf += sql[i++]
      }
      if (!closed) unterminated.push({ offset: start, kind: 'string literal' })
      paint(start, i, REGION_STRING)
      tokens.push({ kind: 'string', value: '', upper: '', text: buf, dollarTag: null, start, end: i, quoted: true, decoded: prefix.decoded })
      continue
    }

    // -- quoted identifier, and the U& form ---------------------------------
    //
    // `U&"…"` carries Unicode escapes. Lexed naively it becomes the word `U`,
    // the operator `&` and an identifier — which makes `readQualifiedName`
    // return `u` and the statement name a completely different object from the
    // one PostgreSQL applies. Consumed as ONE undecoded identifier instead, so
    // its statement becomes a finding rather than a wrong answer.
    const uAmp =
      (c === 'U' || c === 'u') &&
      sql[i + 1] === '&' &&
      sql[i + 2] === '"' &&
      !(i > 0 && IDENT_PART.test(sql[i - 1]))
    if (c === '"' || uAmp) {
      const identDecoded = !uAmp
      const start = i
      i += uAmp ? 3 : 1
      let buf = ''
      let identClosed = false
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          buf += '"'
          i += 2
          continue
        }
        if (sql[i] === '"') {
          i++
          identClosed = true
          break
        }
        buf += sql[i++]
      }
      if (!identClosed) unterminated.push({ offset: start, kind: 'quoted identifier' })
      paint(start, i, REGION_QUOTED_IDENT)
      tokens.push({ kind: 'ident', value: buf, upper: buf.toUpperCase(), text: '', dollarTag: null, start, end: i, quoted: true, decoded: identDecoded })
      continue
    }

    // -- word / unquoted identifier ----------------------------------------
    if (IDENT_START.test(c)) {
      const start = i
      while (i < n && IDENT_PART.test(sql[i])) i++
      const word = sql.slice(start, i)
      tokens.push({
        kind: 'word',
        value: word.toLowerCase(),
        upper: word.toUpperCase(),
        text: '',
        dollarTag: null,
        start,
        end: i,
        quoted: false,
        decoded: true,
      })
      continue
    }

    // -- number -------------------------------------------------------------
    if (/[0-9]/.test(c)) {
      const start = i
      while (i < n && /[0-9._]/.test(sql[i])) i++
      tokens.push({ kind: 'number', value: sql.slice(start, i), upper: '', text: '', dollarTag: null, start, end: i, quoted: false, decoded: true })
      continue
    }

    // -- punctuation, longest match first -----------------------------------
    const two = sql.slice(i, i + 2)
    const len = ['||', '::', ':=', '<>', '<=', '>=', '!=', '!~', '~*', '->', '=>'].includes(two) ? 2 : 1
    tokens.push({ kind: 'punct', value: sql.slice(i, i + len), upper: '', text: '', dollarTag: null, start: i, end: i + len, quoted: false, decoded: true })
    i += len
  }

  // A dollar-quoted body is a STRING to the enclosing statement and SOURCE CODE
  // to PostgreSQL. Both readings matter, and they differ on exactly one point:
  // a `--` inside a function body is a comment, not data. Prose describing a
  // rule must never be mistaken for the rule — CAP-03's body explains at length
  // why the client_reference_id branch was removed, and a `codeOnly` view that
  // kept that prose would report the branch as still present.
  //
  // Dollar bodies carry no escapes, so the body is a verbatim slice and inner
  // offsets map one-to-one onto the parent.
  for (const t of tokens) {
    if (t.kind !== 'string' || t.dollarTag === null) continue
    const bodyStart = t.start + t.dollarTag.length + 2
    const innerRegion = lex(t.text).region
    for (let k = 0; k < innerRegion.length; k++) {
      if (innerRegion[k] === REGION_COMMENT) region[bodyStart + k] = REGION_COMMENT
    }
  }

  const out: Lexed = { src: sql, region, tokens, unterminated }
  if (LEX_CACHE.size > 256) LEX_CACHE.clear()
  LEX_CACHE.set(sql, out)
  return out
}

// ---------------------------------------------------------------------------
// 2. Length-preserving views
// ---------------------------------------------------------------------------

const CODE_CACHE = new Map<string, string>()

/**
 * `sql` with every comment blanked and everything else intact.
 *
 * The one definition of "what is code" in this repository. Length is preserved
 * on purpose: the `mask-desync` gate compares it, and every extraction below
 * slices this string at token offsets taken from the original.
 */
export function stripComments(sql: string): string {
  const hit = CODE_CACHE.get(sql)
  if (hit !== undefined) return hit
  const { region } = lex(sql)
  const out = sql.split('')
  for (let k = 0; k < out.length; k++) {
    if (region[k] === REGION_COMMENT && out[k] !== '\n') out[k] = ' '
  }
  const joined = out.join('')
  if (CODE_CACHE.size > 256) CODE_CACHE.clear()
  CODE_CACHE.set(sql, joined)
  return joined
}

/** Collapse whitespace so reformatting is not a difference but a token is. */
export function normalizeExpr(expr: string): string {
  return expr.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// 3. Token-stream helpers
// ---------------------------------------------------------------------------

/** A window into a token array: [from, to). */
interface Span {
  readonly toks: readonly SqlToken[]
  readonly from: number
  readonly to: number
}

const kw = (t: SqlToken | undefined, word: string): boolean =>
  t !== undefined && t.kind === 'word' && t.upper === word

const isPunct = (t: SqlToken | undefined, p: string): boolean =>
  t !== undefined && t.kind === 'punct' && t.value === p

/** True when `toks[at\u2026]` begins with the given keyword sequence. */
function matches(toks: readonly SqlToken[], at: number, words: readonly string[]): boolean {
  for (let k = 0; k < words.length; k++) if (!kw(toks[at + k], words[k])) return false
  return true
}

/** The index just past the statement that opens at `at`: its `;` at depth 0. */
function statementSpan(toks: readonly SqlToken[], at: number, limit: number): Span {
  let depth = 0
  for (let k = at; k < limit; k++) {
    const t = toks[k]
    if (t.kind !== 'punct') continue
    if (t.value === '(') depth++
    else if (t.value === ')') depth--
    else if (t.value === ';' && depth <= 0) return { toks, from: at, to: k }
  }
  return { toks, from: at, to: limit }
}

/**
 * Read a possibly-qualified identifier at `at`, normalised.
 *
 * `public.marketing_leads`, `"public"."marketing_leads"` and
 * `PUBLIC.Marketing_Leads` all come back as `public.marketing_leads`;
 * `"Public"."marketing_leads"` comes back as `Public.marketing_leads`, which is
 * a DIFFERENT object and must read as one.
 */
function readQualifiedName(
  toks: readonly SqlToken[],
  at: number,
  limit: number,
): { name: string; next: number } | null {
  const parts: string[] = []
  let k = at
  for (;;) {
    const t = toks[k]
    if (!t || (t.kind !== 'word' && t.kind !== 'ident')) break
    parts.push(t.value)
    k++
    if (k < limit && isPunct(toks[k], '.')) {
      k++
      continue
    }
    break
  }
  if (parts.length === 0) return null
  return { name: parts.join('.'), next: k }
}

/** Skip a balanced `( \u2026 )` starting at `at`, if there is one. */
function skipParens(toks: readonly SqlToken[], at: number, limit: number): number {
  if (!isPunct(toks[at], '(')) return at
  let depth = 0
  for (let k = at; k < limit; k++) {
    if (isPunct(toks[k], '(')) depth++
    else if (isPunct(toks[k], ')')) {
      depth--
      if (depth === 0) return k + 1
    }
  }
  return limit
}

/** Comma-separated identifier list at `at`, stopping at `stopWords`. */
function readNameList(
  toks: readonly SqlToken[],
  at: number,
  limit: number,
  stopWords: readonly string[],
): { names: string[]; next: number } {
  const names: string[] = []
  let k = at
  for (;;) {
    const t = toks[k]
    if (!t) break
    if (t.kind === 'word' && stopWords.includes(t.upper)) break
    const q = readQualifiedName(toks, k, limit)
    if (!q) break
    names.push(q.name)
    k = q.next
    if (k < limit && isPunct(toks[k], ',')) {
      k++
      continue
    }
    break
  }
  return { names, next: k }
}

/** The 1-based line of `offset` in `sql`. */
function lineOf(sql: string, offset: number): number {
  let line = 1
  for (let k = 0; k < offset && k < sql.length; k++) if (sql[k] === '\n') line++
  return line
}

// ---------------------------------------------------------------------------
// 4. The security-statement model
// ---------------------------------------------------------------------------

export interface ParsedPolicy {
  readonly name: string
  readonly table: string
  readonly permissive: 'PERMISSIVE' | 'RESTRICTIVE'
  readonly command: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  /** Normalised. EMPTY when the statement has no TO clause \u2014 which is TO PUBLIC. */
  readonly roles: readonly string[]
  readonly using: string | null
  readonly withCheck: string | null
  readonly raw: string
  /** Where the statement came from: '' for the file itself. */
  readonly origin: StatementOrigin
}

export interface ParsedPrivilege {
  readonly privilege: string
  /** null = table-wide. A list = column-scoped. */
  readonly columns: readonly string[] | null
}

export interface ParsedGrant {
  readonly privileges: readonly ParsedPrivilege[]
  /**
   * `ROLE` is a GRANT with no ON clause \u2014 `GRANT uellix_owner TO r`, i.e. role
   * MEMBERSHIP. The first version of this parser skipped those statements
   * entirely (`if (onAt === -1) continue`), which made the inbound direction of
   * a membership grant invisible: the gate looked for `GRANT <caprole> TO \u2026`
   * and never for `GRANT <owner> TO <caprole>` \u2014 the one that gives a
   * capability role the table owner's privileges, and with them the
   * ownership-based RLS exemption.
   *
   * A membership statement may name SEVERAL roles on each side.
   * `GRANT uellix_owner, uellix_writer TO uellix_cap_lead` is TWO memberships
   * and the previous parser produced ZERO, because it required the member list
   * to match `/^[A-Za-z_][\w$]*$/` and dropped the statement on a bare
   * `continue` when it did not.
   */
  readonly objectType: 'TABLE' | 'FUNCTION' | 'SCHEMA' | 'SEQUENCE' | 'ROLE' | 'UNKNOWN'
  readonly object: string
  /** Normalised; `public` for PUBLIC. */
  readonly grantees: readonly string[]
  /** WITH GRANT OPTION: the grantee may re-grant. Part of the signature. */
  readonly grantOption: boolean
  /** WITH ADMIN OPTION on a role membership: the grantee may re-grant it. */
  readonly adminOption: boolean
  /** WITH INHERIT TRUE / SET TRUE / ADMIN TRUE on a role membership. */
  readonly withClause: string
  readonly raw: string
  readonly origin: StatementOrigin
}

export interface ParsedOwnership {
  readonly objectType: string
  readonly object: string
  readonly owner: string
  readonly origin: StatementOrigin
}

export interface RlsToggle {
  readonly table: string
  readonly action: 'ENABLE' | 'DISABLE' | 'FORCE' | 'NO FORCE'
  readonly origin: StatementOrigin
}

export interface ParsedIndex {
  readonly name: string
  readonly table: string
  readonly unique: boolean
}

/** Every ALTER/CREATE ROLE for a role, in the order PostgreSQL applies them. */
export interface ParsedRoleStatement {
  readonly verb: 'CREATE' | 'ALTER' | 'DROP'
  readonly role: string
  /** Upper-cased attribute words, e.g. ['NOSUPERUSER', 'BYPASSRLS']. */
  readonly attributes: readonly string[]
  readonly raw: string
  readonly origin: StatementOrigin
}

/** REASSIGN OWNED BY \u2026 TO \u2026 and DROP OWNED BY \u2026. */
export interface ParsedOwnedStatement {
  readonly verb: 'REASSIGN' | 'DROP'
  readonly from: readonly string[]
  readonly to: string | null
  readonly raw: string
  readonly origin: StatementOrigin
}

export interface ParsedDefaultPrivilege {
  readonly action: 'GRANT' | 'REVOKE'
  readonly forRoles: readonly string[]
  readonly inSchemas: readonly string[]
  readonly privileges: readonly string[]
  readonly objectKind: string
  readonly grantees: readonly string[]
  readonly raw: string
  readonly origin: StatementOrigin
}

/**
 * Where a statement was found.
 *
 * `file` is the text as written. `do-block` and `function-body` are executable
 * bodies the previous parser treated as opaque strings. `executed-literal` is a
 * string that reaches the server through EXECUTE \u2014 DDL that is no less applied
 * for having been quoted.
 */
export type StatementOrigin = 'file' | 'do-block' | 'function-body' | 'executed-literal'

/**
 * A statement that OPENS like a security operation and did not classify.
 *
 * This type is the reason the file was rewritten. Every silent discard the old
 * parser made \u2014 an unmatched regex, a `continue` on a shape it did not expect,
 * a masked function body \u2014 becomes one of these instead of becoming nothing.
 */
export interface UnparsedSecurityStatement {
  /** A stable slug for the gate message. */
  readonly reason:
    | 'unmodelled-form'
    | 'dynamic-sql'
    | 'incomplete-statement'
    | 'unterminated-body'
  /** The leading KEYWORDS only. Never a literal, so no secret can reach a log. */
  readonly lead: string
  readonly origin: StatementOrigin
  readonly offset: number
  readonly line: number
  readonly detail: string
}

export interface SecurityAnalysis {
  readonly policies: readonly ParsedPolicy[]
  readonly droppedPolicies: readonly { name: string; table: string; origin: StatementOrigin }[]
  readonly grants: readonly ParsedGrant[]
  readonly revokes: readonly ParsedGrant[]
  readonly ownerships: readonly ParsedOwnership[]
  readonly rlsToggles: readonly RlsToggle[]
  readonly roleStatements: readonly ParsedRoleStatement[]
  readonly ownedStatements: readonly ParsedOwnedStatement[]
  readonly defaultPrivileges: readonly ParsedDefaultPrivilege[]
  readonly indexes: readonly ParsedIndex[]
  readonly unparsed: readonly UnparsedSecurityStatement[]
}

const EMPTY_ANALYSIS: SecurityAnalysis = {
  policies: [],
  droppedPolicies: [],
  grants: [],
  revokes: [],
  ownerships: [],
  rlsToggles: [],
  roleStatements: [],
  ownedStatements: [],
  defaultPrivileges: [],
  indexes: [],
  unparsed: [],
}

// ---------------------------------------------------------------------------
// 5. The scanner
// ---------------------------------------------------------------------------

/**
 * Object kinds whose ALTER form can carry OWNER TO.
 *
 * Listed rather than matched with `\w+`, because an unlisted kind must become
 * an `unmodelled-form` finding and not a silently skipped statement.
 */
const OWNABLE_KINDS = [
  'TABLE', 'FUNCTION', 'PROCEDURE', 'ROUTINE', 'AGGREGATE', 'SCHEMA', 'SEQUENCE',
  'VIEW', 'TYPE', 'DOMAIN', 'DATABASE', 'TABLESPACE', 'COLLATION', 'CONVERSION',
  'OPERATOR', 'PUBLICATION', 'STATISTICS', 'SUBSCRIPTION',
] as const

/** ALTER TABLE actions that are ABOUT security and must classify exactly. */
const SECURITY_ALTER_TABLE_WORDS = ['OWNER', 'POLICY']

/** Every verb `classifyAt` reacts to. Used only by the undecodable-token guard. */
const OPENER_VERBS = new Set([
  'CREATE', 'ALTER', 'DROP', 'REASSIGN', 'GRANT', 'REVOKE', 'SECURITY', 'SET', 'DO', 'EXECUTE',
])

const ROLE_ATTRIBUTE_WORDS = new Set([
  'SUPERUSER', 'NOSUPERUSER', 'CREATEDB', 'NOCREATEDB', 'CREATEROLE', 'NOCREATEROLE',
  'INHERIT', 'NOINHERIT', 'LOGIN', 'NOLOGIN', 'REPLICATION', 'NOREPLICATION',
  'BYPASSRLS', 'NOBYPASSRLS', 'CONNECTION', 'LIMIT', 'PASSWORD', 'ENCRYPTED',
  'VALID', 'UNTIL', 'ADMIN', 'ROLE', 'USER', 'IN', 'SYSID',
])

interface ScanContext {
  readonly src: string
  readonly code: string
  readonly origin: StatementOrigin
  /** Added to every offset so a nested body reports a file position. */
  readonly baseOffset: number
  readonly out: {
    policies: ParsedPolicy[]
    droppedPolicies: { name: string; table: string; origin: StatementOrigin }[]
    grants: ParsedGrant[]
    revokes: ParsedGrant[]
    ownerships: ParsedOwnership[]
    rlsToggles: RlsToggle[]
    roleStatements: ParsedRoleStatement[]
    ownedStatements: ParsedOwnedStatement[]
    defaultPrivileges: ParsedDefaultPrivilege[]
    indexes: ParsedIndex[]
    unparsed: UnparsedSecurityStatement[]
  }
  /** Guards against a pathological body nesting. */
  readonly depth: number
}

/** Statement text as WRITTEN, comments blanked. What the contract compares. */
function spanText(ctx: ScanContext, span: Span): string {
  const first = span.toks[span.from]
  const last = span.toks[span.to - 1] ?? first
  if (!first) return ''
  return ctx.code.slice(first.start, last.end)
}

function fail(
  ctx: ScanContext,
  span: Span,
  reason: UnparsedSecurityStatement['reason'],
  detail: string,
): void {
  const first = span.toks[span.from]
  const offset = (first?.start ?? 0) + ctx.baseOffset
  // KEYWORDS ONLY. A finding is written into a test message and a report; a
  // statement's literals may carry a token hash or a connection string, and
  // nothing here is worth leaking one for.
  const lead = span.toks
    .slice(span.from, span.from + 6)
    .filter((t) => t.kind === 'word' || t.kind === 'ident' || t.kind === 'punct')
    .map((t) => (t.kind === 'word' ? t.upper : t.kind === 'ident' ? `"${t.value}"` : t.value))
    .join(' ')
  ctx.out.unparsed.push({
    reason,
    lead,
    origin: ctx.origin,
    offset,
    line: lineOf(ctx.src, first?.start ?? 0),
    detail,
  })
}

/**
 * Walk a token stream and classify every security statement it contains.
 *
 * Openers are recognised AT ANY POSITION, not only after a `;`. Inside a
 * PL/pgSQL body a statement can begin after THEN, ELSE, LOOP or BEGIN, and
 * anchoring on `;` alone would have left `IF \u2026 THEN EXECUTE '\u2026GRANT\u2026'; END IF;`
 * looking like one statement whose first word is IF.
 */
function scan(ctx: ScanContext, toks: readonly SqlToken[]): void {
  const limit = toks.length
  let k = 0
  while (k < limit) {
    const t = toks[k]
    if (t.kind !== 'word') {
      k++
      continue
    }
    const consumed = classifyAt(ctx, toks, k, limit)
    k = consumed > k ? consumed : k + 1
  }
}

/**
 * Classify the statement opening at `at`. Returns the index to resume from,
 * or `at` when nothing opened here.
 *
 * THE SKIP CONTRACT, because this is where the old parser lost statements.
 *
 * There are exactly two ways out of this function that do not produce a record:
 *
 *   1. `return at` — the token is NOT a security-statement opener. The caller
 *      then advances ONE TOKEN and asks again, so nothing is skipped except the
 *      token itself; a security statement later in the same text is still
 *      found. `ON CONFLICT DO NOTHING` leaves through here, and so does
 *      `CREATE TABLE`.
 *   2. `return span().to` — the statement IS understood and carries nothing the
 *      contract judges (`CREATE SCHEMA`, `DROP TABLE`, `SET ROLE`).
 *
 * Every other exit either pushes a parsed record or calls `fail()`. There is no
 * `continue` on an unrecognised shape and no empty `catch` anywhere in this
 * file — the two constructions that turned "I could not read this" into "this
 * is not here".
 */
function classifyAt(ctx: ScanContext, toks: readonly SqlToken[], at: number, limit: number): number {
  const t = toks[at]
  const span = () => statementSpan(toks, at, limit)

  /**
   * A statement whose text is not the text PostgreSQL sees cannot be judged.
   *
   * Checked once, at the top, for every opener: a `U&'…'` or `U&"…"` anywhere
   * inside a security statement makes the whole statement a finding. Decoding
   * it approximately would be worse — a near-miss re-lexes as a word that opens
   * nothing, and open nothing is how a statement disappears.
   */
  const undecodable = (s: Span): boolean => {
    for (let k = s.from; k < s.to; k++) if (!s.toks[k].decoded) return true
    return false
  }
  const guard = (s: Span): number | null => {
    if (!undecodable(s)) return null
    fail(ctx, s, 'unmodelled-form', 'the statement carries a U& escape this model does not decode')
    return s.to
  }
  // Applied to every statement that STARTS with a verb this classifier reacts
  // to, before deciding which form it is. Deliberately a little wide — a
  // `CREATE TABLE … DEFAULT U&'x'` is refused too — because narrowing it would
  // mean deciding the statement's kind first, and deciding the kind is exactly
  // what an undecoded identifier makes unreliable. No package contains a U&
  // literal, so the width costs nothing and the alternative costs correctness.
  if (OPENER_VERBS.has(t.upper)) {
    const refused = guard(span())
    if (refused !== null) return refused
  }

  switch (t.upper) {
    case 'CREATE': {
      // CREATE [OR REPLACE] POLICY / ROLE / USER / GROUP / SCHEMA / INDEX / FUNCTION
      let h = at + 1
      if (matches(toks, h, ['OR', 'REPLACE'])) h += 2
      const head = toks[h]
      if (!head || head.kind !== 'word') return at
      if (head.upper === 'POLICY') return parsePolicyStatement(ctx, span())
      if (head.upper === 'ROLE' || head.upper === 'USER' || head.upper === 'GROUP') {
        if (kw(toks[h + 1], 'MAPPING')) {
          const s = span()
          fail(ctx, s, 'unmodelled-form', 'CREATE USER MAPPING is not modelled by the capability contract')
          return s.to
        }
        return parseRoleStatement(ctx, span(), 'CREATE', h + 1)
      }
      // CREATE SCHEMA … AUTHORIZATION <role> sets the schema's OWNER, which
      // confers CREATE and DROP over everything in it. The previous comment
      // here said ownership was "read from AUTHORIZATION below" and NOTHING
      // read it — a comment that states the opposite of the code is worse than
      // the omission, because a reviewer checking the coverage stops there.
      if (head.upper === 'SCHEMA') {
        const s = span()
        let j = h + 1
        if (matches(toks, j, ['IF', 'NOT', 'EXISTS'])) j += 3
        const nameRef = readQualifiedName(toks, j, s.to)
        for (let q = j; q < s.to; q++) {
          if (!kw(toks[q], 'AUTHORIZATION')) continue
          const owner = readQualifiedName(toks, q + 1, s.to)
          if (!owner || !nameRef) {
            fail(ctx, s, 'incomplete-statement', 'CREATE SCHEMA … AUTHORIZATION without a readable name or role')
            return s.to
          }
          ctx.out.ownerships.push({
            objectType: 'SCHEMA',
            object: nameRef.name,
            owner: owner.name,
            origin: ctx.origin,
          })
          break
        }
        return s.to
      }
      if (head.upper === 'INDEX' || head.upper === 'UNIQUE') return parseIndexStatement(ctx, span())
      if (head.upper === 'FUNCTION' || head.upper === 'PROCEDURE') return parseFunctionStatement(ctx, span())
      // A RULE rewrites the query the server ends up running, and a TRIGGER can
      // run arbitrary code with the table owner's authority. Neither is
      // expressible in the capability contract and neither appears in any of
      // the ten packages, so both are refused rather than skipped — a rewrite
      // rule on a protected table is a way to change what RLS is applied to.
      if (head.upper === 'RULE' || head.upper === 'TRIGGER') {
        const s = span()
        fail(ctx, s, 'unmodelled-form', `CREATE ${head.upper} can change what the server executes on a protected table`)
        return s.to
      }
      // Anything else — CREATE TABLE, CREATE VIEW, CREATE EXTENSION — is not a
      // security statement in this contract. Returning `at` means "no opener
      // here", and the scanner advances ONE token and re-examines, so a
      // security statement later in the same text is still found. This is the
      // only shape of skip in this file, and it never skips a statement: it
      // skips a token.
      return at
    }

    case 'ALTER': {
      const head = toks[at + 1]
      if (!head || head.kind !== 'word') return at
      if (head.upper === 'POLICY') {
        const s = span()
        // ALTER POLICY can retarget TO and rewrite USING. Nothing in the
        // campaign uses it, and modelling it as a mutation of an earlier
        // CREATE would be a second policy model; it is refused instead.
        fail(ctx, s, 'unmodelled-form', 'ALTER POLICY changes a policy the contract pins by its CREATE')
        return s.to
      }
      if (head.upper === 'ROLE' || head.upper === 'USER' || head.upper === 'GROUP') {
        return parseRoleStatement(ctx, span(), 'ALTER', at + 2)
      }
      if (matches(toks, at + 1, ['DEFAULT', 'PRIVILEGES'])) {
        return parseDefaultPrivilegesStatement(ctx, span())
      }
      if (head.upper === 'TABLE') return parseAlterTable(ctx, span())
      if ((OWNABLE_KINDS as readonly string[]).includes(head.upper)) {
        return parseAlterOwnable(ctx, span(), head.upper)
      }
      if (matches(toks, at + 1, ['MATERIALIZED', 'VIEW'])) return parseAlterOwnable(ctx, span(), 'MATERIALIZED VIEW')
      if (matches(toks, at + 1, ['LARGE', 'OBJECT'])) return parseAlterOwnable(ctx, span(), 'LARGE OBJECT')
      if (matches(toks, at + 1, ['FOREIGN', 'TABLE'])) return parseAlterOwnable(ctx, span(), 'FOREIGN TABLE')
      if (matches(toks, at + 1, ['TEXT', 'SEARCH'])) return span().to
      if (head.upper === 'INDEX' || head.upper === 'SYSTEM' || head.upper === 'EXTENSION') return span().to
      // An ALTER of something the model has never seen. If it mentions OWNER it
      // is a re-owning, and re-owning is RLS exemption.
      const s = span()
      const words = toks.slice(s.from, s.to).map((x) => x.upper)
      if (words.includes('OWNER') || words.includes('SECURITY')) {
        fail(ctx, s, 'unmodelled-form', `ALTER ${head.upper} carries OWNER or SECURITY and is not modelled`)
      }
      return s.to
    }

    case 'DROP': {
      const head = toks[at + 1]
      if (!head || head.kind !== 'word') return at
      if (head.upper === 'POLICY') return parseDropPolicy(ctx, span())
      if (head.upper === 'OWNED') return parseOwnedStatement(ctx, span(), 'DROP')
      if (head.upper === 'ROLE' || head.upper === 'USER' || head.upper === 'GROUP') {
        if (kw(toks[at + 2], 'MAPPING')) {
          const s = span()
          fail(ctx, s, 'unmodelled-form', 'DROP USER MAPPING is not modelled')
          return s.to
        }
        return parseRoleStatement(ctx, span(), 'DROP', at + 2)
      }
      return span().to
    }

    case 'REASSIGN':
      if (kw(toks[at + 1], 'OWNED')) return parseOwnedStatement(ctx, span(), 'REASSIGN')
      return at

    case 'GRANT':
      return parseAclStatement(ctx, span(), 'GRANT')

    case 'REVOKE':
      return parseAclStatement(ctx, span(), 'REVOKE')

    case 'SECURITY':
      if (kw(toks[at + 1], 'LABEL')) {
        const s = span()
        fail(ctx, s, 'unmodelled-form', 'SECURITY LABEL can rewrite an RLS or SELinux label')
        return s.to
      }
      return at

    case 'SET': {
      // SET ROLE / SET SESSION AUTHORIZATION change who the following
      // statements run as. They are recorded but not refused: every package
      // opens an owner window with SET ROLE uellix_owner, by design.
      if (kw(toks[at + 1], 'ROLE') || matches(toks, at + 1, ['SESSION', 'AUTHORIZATION'])) {
        return span().to
      }
      return at
    }

    case 'DO': {
      // `DO $$\u2026$$` \u2014 an executable body. `ON CONFLICT DO NOTHING` and
      // `DO UPDATE SET` also start with DO, so the body must actually be a
      // string for this to be a DO block.
      let h = at + 1
      if (kw(toks[h], 'LANGUAGE')) h += 2
      const body = toks[h]
      if (!body || body.kind !== 'string') return at
      descend(ctx, body, 'do-block')
      return statementSpan(toks, at, limit).to
    }

    case 'EXECUTE': {
      // PL/pgSQL dynamic execution. `GRANT EXECUTE ON \u2026` never reaches here
      // because the GRANT consumed its own statement first.
      return parseExecute(ctx, toks, at, limit)
    }

    default:
      return at
  }
}

/** Re-lex an executable body and scan it, mapping offsets back to the file. */
function descend(ctx: ScanContext, body: SqlToken, origin: StatementOrigin): void {
  const inner = body.text
  if (inner.length === 0) return
  if (!body.decoded) {
    fail(ctx, { toks: [body], from: 0, to: 1 }, 'unmodelled-form', 'an executable body carrying a U& escape cannot be read')
    return
  }
  // The depth cap is a backstop against a pathological nesting, and a backstop
  // that RETURNS SILENTLY is a fail-open: five nested executable bodies would
  // have hidden the sixth completely. Refusing costs nothing — nothing in the
  // campaign nests more than two deep — and keeps the file's one promise, that
  // "the parser did not understand this" never becomes "there is nothing here".
  if (ctx.depth > 4) {
    fail(
      ctx,
      { toks: [body], from: 0, to: 1 },
      'unmodelled-form',
      'executable bodies nested deeper than the model reads; the innermost is not judged',
    )
    return
  }
  const tagLen = body.dollarTag === null ? 0 : body.dollarTag.length + 2
  const lexed = lex(inner)
  const innerCtx: ScanContext = {
    src: ctx.src,
    code: stripComments(inner),
    origin,
    baseOffset: ctx.baseOffset + body.start + tagLen,
    out: ctx.out,
    depth: ctx.depth + 1,
  }
  scan(innerCtx, lexed.tokens)
}

/**
 * `EXECUTE <expr>` inside an executable body.
 *
 * A self-contained literal is re-scanned as SQL \u2014 that text reaches the server
 * and must be judged by the same rules as text that was written out. Anything
 * else \u2014 `format(\u2026)`, a variable, a concatenation \u2014 cannot be resolved from the
 * file, and the ONLY safe reading of an unresolvable DDL string is that it
 * might be a security statement. It becomes a `dynamic-sql` finding.
 */
function parseExecute(ctx: ScanContext, toks: readonly SqlToken[], at: number, limit: number): number {
  const span = statementSpan(toks, at, limit)
  const arg = toks[at + 1]
  // `EXECUTE 'literal'` with nothing else before INTO/USING/; is resolvable.
  if (arg && arg.kind === 'string') {
    const after = toks[at + 2]
    const terminated =
      after === undefined ||
      span.to === at + 2 ||
      (after.kind === 'word' && (after.upper === 'INTO' || after.upper === 'USING'))
    if (terminated) {
      const lexed = lex(arg.text)
      const innerCtx: ScanContext = {
        src: ctx.src,
        code: stripComments(arg.text),
        origin: 'executed-literal',
        // The decoded literal has its own coordinate space; reporting the
        // EXECUTE's own position is the only offset that means anything in the
        // file, so the whole literal is attributed to it.
        baseOffset: 0,
        out: ctx.out,
        depth: ctx.depth + 1,
      }
      // Offsets inside a decoded literal are not file offsets. Attribute the
      // statement to the EXECUTE keyword.
      const before = ctx.out.unparsed.length
      scan(innerCtx, lexed.tokens)
      for (let i = before; i < ctx.out.unparsed.length; i++) {
        const u = ctx.out.unparsed[i]
        ctx.out.unparsed[i] = {
          ...u,
          offset: at + ctx.baseOffset,
          line: lineOf(ctx.src, (toks[at]?.start ?? 0) + ctx.baseOffset),
        }
      }
      return span.to
    }
  }
  fail(
    ctx,
    span,
    'dynamic-sql',
    'EXECUTE takes an expression the file cannot resolve, so its DDL cannot be judged',
  )
  return span.to
}

/**
 * CREATE FUNCTION: its body is executable, and its options carry SECURITY.
 *
 * EVERY string in the statement is descended into, not only the dollar-quoted
 * ones. The first version tested `tok.dollarTag !== null`, which meant a body
 * written the other legal way —
 *
 *     CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS
 *     'BEGIN EXECUTE ''GRANT SELECT ON public.marketing_leads TO cap''; END';
 *
 * — was skipped entirely. The asymmetry was invisible because DO blocks and
 * EXECUTE already accepted any string; only this one place insisted on `$$`.
 * Worse, the SECURITY DEFINER gate finds functions with a regex anchored on
 * `AS $$`, so such a function was outside that inventory too.
 *
 * The non-dollar form is ALSO refused outright: every capability function in
 * the campaign uses `AS $$ … $$`, and a body that has to be read through two
 * layers of quote-doubling is not a form this contract models.
 */
function parseFunctionStatement(ctx: ScanContext, span: Span): number {
  for (let k = span.from; k < span.to; k++) {
    const tok = span.toks[k]
    if (tok.kind !== 'string') continue
    if (tok.dollarTag === null && kw(span.toks[k - 1], 'AS')) {
      fail(
        ctx,
        span,
        'unmodelled-form',
        'a function body written as a single-quoted literal is not the form this contract models',
      )
    }
    descend(ctx, tok, 'function-body')
  }
  return span.to
}

function parsePolicyStatement(ctx: ScanContext, span: Span): number {
  const { toks, from, to } = span
  const raw = spanText(ctx, span)

  // CREATE POLICY <name> ON <table> [AS \u2026] [FOR \u2026] [TO \u2026] [USING (\u2026)] [WITH CHECK (\u2026)]
  let k = from + 2
  const nameTok = toks[k]
  if (!nameTok || (nameTok.kind !== 'word' && nameTok.kind !== 'ident')) {
    fail(ctx, span, 'incomplete-statement', 'CREATE POLICY without a readable name')
    return to
  }
  const name = nameTok.value
  k++
  if (!kw(toks[k], 'ON')) {
    fail(ctx, span, 'incomplete-statement', 'CREATE POLICY without an ON clause')
    return to
  }
  k++
  const tableRef = readQualifiedName(toks, k, to)
  if (!tableRef) {
    fail(ctx, span, 'incomplete-statement', 'CREATE POLICY without a readable table')
    return to
  }
  const table = tableRef.name
  k = tableRef.next

  let permissive: ParsedPolicy['permissive'] = 'PERMISSIVE'
  let command: ParsedPolicy['command'] = 'ALL'
  let roles: string[] = []
  let using: string | null = null
  let withCheck: string | null = null

  while (k < to) {
    const tok = toks[k]
    if (tok.kind === 'word' && tok.upper === 'AS') {
      const mode = toks[k + 1]
      if (kw(mode, 'RESTRICTIVE')) permissive = 'RESTRICTIVE'
      else if (kw(mode, 'PERMISSIVE')) permissive = 'PERMISSIVE'
      else {
        fail(ctx, span, 'unmodelled-form', `CREATE POLICY ${name}: AS is followed by neither PERMISSIVE nor RESTRICTIVE`)
        return to
      }
      k += 2
      continue
    }
    if (tok.kind === 'word' && tok.upper === 'FOR') {
      const cmd = toks[k + 1]
      if (cmd && cmd.kind === 'word' && ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(cmd.upper)) {
        command = cmd.upper as ParsedPolicy['command']
        k += 2
        continue
      }
      fail(ctx, span, 'unmodelled-form', `CREATE POLICY ${name}: FOR names an unknown command`)
      return to
    }
    if (tok.kind === 'word' && tok.upper === 'TO') {
      const list = readNameList(toks, k + 1, to, ['USING', 'WITH'])
      roles = list.names
      k = list.next
      continue
    }
    if (tok.kind === 'word' && tok.upper === 'USING' && isPunct(toks[k + 1], '(')) {
      const end = skipParens(toks, k + 1, to)
      using = normalizeExpr(ctx.code.slice(toks[k + 1].end, toks[end - 1].start))
      k = end
      continue
    }
    if (tok.kind === 'word' && tok.upper === 'WITH' && kw(toks[k + 1], 'CHECK') && isPunct(toks[k + 2], '(')) {
      const end = skipParens(toks, k + 2, to)
      withCheck = normalizeExpr(ctx.code.slice(toks[k + 2].end, toks[end - 1].start))
      k = end
      continue
    }
    fail(
      ctx,
      span,
      'unmodelled-form',
      `CREATE POLICY ${name}: unrecognised clause at token ${tok.kind === 'word' ? tok.upper : tok.kind}`,
    )
    return to
  }

  ctx.out.policies.push({
    name,
    table,
    permissive,
    command,
    roles,
    using,
    withCheck,
    raw,
    origin: ctx.origin,
  })
  return to
}

function parseDropPolicy(ctx: ScanContext, span: Span): number {
  const { toks, from, to } = span
  let k = from + 2
  if (matches(toks, k, ['IF', 'EXISTS'])) k += 2
  const nameTok = toks[k]
  if (!nameTok || (nameTok.kind !== 'word' && nameTok.kind !== 'ident')) {
    fail(ctx, span, 'incomplete-statement', 'DROP POLICY without a readable name')
    return to
  }
  k++
  let table = ''
  if (kw(toks[k], 'ON')) {
    const q = readQualifiedName(toks, k + 1, to)
    if (q) table = q.name
  }
  ctx.out.droppedPolicies.push({ name: nameTok.value, table, origin: ctx.origin })
  return to
}

function parseRoleStatement(
  ctx: ScanContext,
  span: Span,
  verb: ParsedRoleStatement['verb'],
  nameAt: number,
): number {
  const { toks, to } = span
  let k = nameAt
  if (matches(toks, k, ['IF', 'EXISTS'])) k += 2
  if (kw(toks[k], 'CURRENT_USER') || kw(toks[k], 'SESSION_USER')) {
    // Valid targets, but nothing in the campaign uses them and treating them as
    // a named role would compare against the wrong thing.
    fail(ctx, span, 'unmodelled-form', `${verb} ROLE targets CURRENT_USER or SESSION_USER`)
    return to
  }
  const nameRef = readQualifiedName(toks, k, to)
  if (!nameRef) {
    fail(ctx, span, 'incomplete-statement', `${verb} ROLE without a readable role name`)
    return to
  }
  k = nameRef.next
  const attributes: string[] = []
  for (let j = k; j < to; j++) {
    const tok = toks[j]
    if (tok.kind !== 'word') continue
    if (tok.upper === 'SET' || tok.upper === 'RESET') {
      // ALTER ROLE \u2026 SET parameter \u2014 a GUC, not an attribute. `uellix_stripe`
      // carries statement_timeout that way.
      break
    }
    if (tok.upper === 'WITH') continue
    if (ROLE_ATTRIBUTE_WORDS.has(tok.upper)) {
      attributes.push(tok.upper)
      continue
    }
    // A word inside an ALTER ROLE that is neither an attribute nor SET is a
    // form the model does not know. Refusing it is the difference between
    // "there is no dangerous attribute here" and "no dangerous attribute was
    // recognised here".
    fail(ctx, span, 'unmodelled-form', `${verb} ROLE ${nameRef.name}: unrecognised attribute ${tok.upper}`)
    return to
  }
  ctx.out.roleStatements.push({
    verb,
    role: nameRef.name,
    attributes,
    raw: spanText(ctx, span),
    origin: ctx.origin,
  })
  return to
}

function parseOwnedStatement(ctx: ScanContext, span: Span, verb: 'REASSIGN' | 'DROP'): number {
  const { toks, from, to } = span
  let k = from + 2
  if (!kw(toks[k], 'BY')) {
    fail(ctx, span, 'incomplete-statement', `${verb} OWNED without BY`)
    return to
  }
  const fromList = readNameList(toks, k + 1, to, ['TO', 'CASCADE', 'RESTRICT'])
  k = fromList.next
  let target: string | null = null
  if (kw(toks[k], 'TO')) {
    const q = readQualifiedName(toks, k + 1, to)
    if (!q) {
      fail(ctx, span, 'incomplete-statement', 'REASSIGN OWNED without a readable target role')
      return to
    }
    target = q.name
  } else if (verb === 'REASSIGN') {
    fail(ctx, span, 'incomplete-statement', 'REASSIGN OWNED without TO')
    return to
  }
  ctx.out.ownedStatements.push({
    verb,
    from: fromList.names,
    to: target,
    raw: spanText(ctx, span),
    origin: ctx.origin,
  })
  return to
}

function parseAlterOwnable(ctx: ScanContext, span: Span, kind: string): number {
  const { toks, from, to } = span
  let k = from + 1 + kind.split(' ').length
  if (matches(toks, k, ['IF', 'EXISTS'])) k += 2
  const nameRef = readQualifiedName(toks, k, to)
  if (!nameRef) {
    // An object this reader cannot NAME, in a statement that may re-own it.
    // `ALTER LARGE OBJECT 12345 OWNER TO r` is the concrete case: the target is
    // a numeric OID, readQualifiedName returns null, and the previous code
    // returned silently — "I could not read this" becoming "there is nothing
    // here", one more time.
    for (let j = k; j < to; j++) {
      if (kw(toks[j], 'OWNER') && kw(toks[j + 1], 'TO')) {
        fail(ctx, span, 'incomplete-statement', `ALTER ${kind} … OWNER TO with an unreadable object name`)
        return to
      }
    }
    return to
  }
  k = skipParens(toks, nameRef.next, to)
  // Find OWNER TO anywhere in the remainder.
  for (let j = k; j < to; j++) {
    if (kw(toks[j], 'OWNER') && kw(toks[j + 1], 'TO')) {
      const owner = readQualifiedName(toks, j + 2, to)
      if (!owner) {
        fail(ctx, span, 'incomplete-statement', `ALTER ${kind} \u2026 OWNER TO without a readable role`)
        return to
      }
      ctx.out.ownerships.push({
        objectType: kind,
        object: nameRef.name,
        owner: owner.name,
        origin: ctx.origin,
      })
      return to
    }
  }
  return to
}

function parseAlterTable(ctx: ScanContext, span: Span): number {
  const { toks, from, to } = span
  let k = from + 2
  if (kw(toks[k], 'ONLY')) k++
  if (matches(toks, k, ['IF', 'EXISTS'])) k += 2
  const nameRef = readQualifiedName(toks, k, to)
  if (!nameRef) {
    fail(ctx, span, 'incomplete-statement', 'ALTER TABLE without a readable table name')
    return to
  }
  k = nameRef.next

  let matchedSecurityAction = false
  for (let j = k; j < to; j++) {
    // ROW LEVEL SECURITY, in all four forms.
    if (matches(toks, j, ['ROW', 'LEVEL', 'SECURITY'])) {
      const prev1 = toks[j - 1]
      const prev2 = toks[j - 2]
      let action: RlsToggle['action'] | null = null
      if (kw(prev1, 'ENABLE')) action = 'ENABLE'
      else if (kw(prev1, 'DISABLE')) action = 'DISABLE'
      else if (kw(prev1, 'FORCE')) action = kw(prev2, 'NO') ? 'NO FORCE' : 'FORCE'
      if (action === null) {
        fail(ctx, span, 'unmodelled-form', `ALTER TABLE ${nameRef.name}: ROW LEVEL SECURITY with an unknown verb`)
        return to
      }
      ctx.out.rlsToggles.push({ table: nameRef.name, action, origin: ctx.origin })
      matchedSecurityAction = true
      continue
    }
    if (kw(toks[j], 'OWNER') && kw(toks[j + 1], 'TO')) {
      const owner = readQualifiedName(toks, j + 2, to)
      if (!owner) {
        fail(ctx, span, 'incomplete-statement', 'ALTER TABLE \u2026 OWNER TO without a readable role')
        return to
      }
      ctx.out.ownerships.push({
        objectType: 'TABLE',
        object: nameRef.name,
        owner: owner.name,
        origin: ctx.origin,
      })
      matchedSecurityAction = true
      continue
    }
  }
  if (!matchedSecurityAction) {
    // An ALTER TABLE that MENTIONS a security word without matching a modelled
    // form is refused. `ADD COLUMN`, `SET DEFAULT` and friends mention none of
    // them and pass through as ordinary DDL.
    const words = new Set(toks.slice(from, to).map((x) => x.upper))
    for (const w of SECURITY_ALTER_TABLE_WORDS) {
      if (words.has(w)) {
        fail(ctx, span, 'unmodelled-form', `ALTER TABLE ${nameRef.name} mentions ${w} in a form the model does not read`)
        return to
      }
    }
  }
  return to
}

function parseIndexStatement(ctx: ScanContext, span: Span): number {
  const { toks, from, to } = span
  let k = from + 1
  let unique = false
  if (kw(toks[k], 'UNIQUE')) {
    unique = true
    k++
  }
  if (!kw(toks[k], 'INDEX')) return to
  k++
  if (kw(toks[k], 'CONCURRENTLY')) k++
  if (matches(toks, k, ['IF', 'NOT', 'EXISTS'])) k += 3
  const nameRef = readQualifiedName(toks, k, to)
  if (!nameRef) return to
  k = nameRef.next
  if (!kw(toks[k], 'ON')) return to
  const tableRef = readQualifiedName(toks, k + 1, to)
  ctx.out.indexes.push({ name: nameRef.name, table: tableRef ? tableRef.name : '', unique })
  return to
}

/** Privilege list of a GRANT/REVOKE, split at depth 0 so column lists survive. */
function readPrivileges(
  ctx: ScanContext,
  toks: readonly SqlToken[],
  at: number,
  end: number,
): ParsedPrivilege[] {
  const out: ParsedPrivilege[] = []
  let k = at
  while (k < end) {
    const words: string[] = []
    while (k < end) {
      const tok = toks[k]
      if (tok.kind === 'word') {
        words.push(tok.upper)
        k++
        continue
      }
      break
    }
    let columns: string[] | null = null
    if (isPunct(toks[k], '(')) {
      const close = skipParens(toks, k, end)
      const list = readNameList(toks, k + 1, close - 1, [])
      columns = list.names
      k = close
    }
    if (words.length > 0) {
      out.push({ privilege: words.join(' '), columns })
    }
    if (isPunct(toks[k], ',')) {
      k++
      continue
    }
    break
  }
  return out
}

function parseAclStatement(ctx: ScanContext, span: Span, keyword: 'GRANT' | 'REVOKE'): number {
  const { toks, from, to } = span
  const raw = spanText(ctx, span)
  let k = from + 1

  let grantOption = false
  let adminOption = false
  if (keyword === 'REVOKE') {
    if (matches(toks, k, ['GRANT', 'OPTION', 'FOR'])) {
      grantOption = true
      k += 3
    } else if (matches(toks, k, ['ADMIN', 'OPTION', 'FOR'])) {
      adminOption = true
      k += 3
    }
  }

  // Locate ON and the tail (TO / FROM) at depth 0.
  let onAt = -1
  let tailAt = -1
  let depth = 0
  const tailWord = keyword === 'GRANT' ? 'TO' : 'FROM'
  for (let j = k; j < to; j++) {
    const tok = toks[j]
    if (tok.kind === 'punct') {
      if (tok.value === '(') depth++
      else if (tok.value === ')') depth--
      continue
    }
    if (tok.kind !== 'word' || depth !== 0) continue
    if (tok.upper === 'ON' && onAt === -1) onAt = j
    if (tok.upper === tailWord && j > Math.max(onAt, k - 1)) {
      tailAt = j
      break
    }
  }
  if (tailAt === -1) {
    fail(ctx, span, 'incomplete-statement', `${keyword} without a ${tailWord} clause`)
    return to
  }

  // Grantees, and the WITH \u2026 OPTION tail.
  let granteeEnd = to
  for (let j = tailAt + 1; j < to; j++) {
    if (kw(toks[j], 'WITH') || kw(toks[j], 'GRANTED') || kw(toks[j], 'CASCADE') || kw(toks[j], 'RESTRICT')) {
      granteeEnd = j
      break
    }
  }
  const granteeList = readNameList(toks, tailAt + 1, granteeEnd, [])
  const grantees = granteeList.names
  if (grantees.length === 0) {
    fail(ctx, span, 'incomplete-statement', `${keyword}: no readable grantee`)
    return to
  }
  // TRUNCATION IS A FINDING. readNameList stops at the first element it cannot
  // read, so `TO a, <something odd>, b` used to yield [a] — a shorter, safer
  // looking statement than the one PostgreSQL applies.
  if (granteeList.next !== granteeEnd) {
    fail(ctx, span, 'incomplete-statement', `${keyword}: the grantee list does not read to its end`)
    return to
  }
  const withWords: string[] = []
  for (let j = granteeEnd; j < to; j++) {
    const tok = toks[j]
    if (tok.kind === 'word') withWords.push(tok.upper)
  }
  const withClause = normalizeExpr(withWords.join(' '))
  if (/\bGRANT OPTION\b/.test(withClause)) grantOption = true
  if (/\bADMIN OPTION\b/.test(withClause) || /\bADMIN TRUE\b/.test(withClause)) adminOption = true

  // -- role MEMBERSHIP: a GRANT/REVOKE with no ON clause --------------------
  if (onAt === -1) {
    const memberList = readNameList(toks, k, tailAt, ['TO', 'FROM'])
    if (memberList.names.length === 0 || memberList.next !== tailAt) {
      fail(ctx, span, 'incomplete-statement', `${keyword}: role membership list is not readable`)
      return to
    }
    const bucket = keyword === 'GRANT' ? ctx.out.grants : ctx.out.revokes
    // ONE RECORD PER MEMBER. `GRANT uellix_owner, uellix_writer TO r` is two
    // memberships; the previous parser produced zero.
    for (const member of memberList.names) {
      bucket.push({
        privileges: [{ privilege: 'MEMBERSHIP', columns: null }],
        objectType: 'ROLE',
        object: member,
        grantees,
        grantOption,
        adminOption,
        withClause,
        raw,
        origin: ctx.origin,
      })
    }
    return to
  }

  const privileges = readPrivileges(ctx, toks, k, onAt)
  if (privileges.length === 0) {
    fail(ctx, span, 'incomplete-statement', `${keyword}: no readable privilege list`)
    return to
  }

  // Object type and name.
  let j = onAt + 1
  let objectType: ParsedGrant['objectType'] = 'TABLE'
  const kindTok = toks[j]
  if (kindTok && kindTok.kind === 'word') {
    const up = kindTok.upper
    if (up === 'TABLE') {
      objectType = 'TABLE'
      j++
    } else if (up === 'FUNCTION' || up === 'ROUTINE' || up === 'PROCEDURE') {
      objectType = 'FUNCTION'
      j++
    } else if (up === 'SCHEMA') {
      objectType = 'SCHEMA'
      j++
    } else if (up === 'SEQUENCE') {
      objectType = 'SEQUENCE'
      j++
    } else if (up === 'ALL' || up === 'DATABASE' || up === 'LARGE' || up === 'FOREIGN' || up === 'TABLESPACE' || up === 'TYPE' || up === 'DOMAIN' || up === 'LANGUAGE' || up === 'PARAMETER') {
      objectType = 'UNKNOWN'
    }
  }
  const objRef = readQualifiedName(toks, j, tailAt)
  if (!objRef && objectType !== 'UNKNOWN') {
    fail(ctx, span, 'incomplete-statement', `${keyword}: object name is not readable`)
    return to
  }
  const object = objRef ? objRef.name : normalizeExpr(spanText(ctx, { toks, from: j, to: tailAt }))

  const bucket = keyword === 'GRANT' ? ctx.out.grants : ctx.out.revokes
  bucket.push({
    privileges,
    objectType,
    object,
    grantees,
    grantOption,
    adminOption,
    withClause,
    raw,
    origin: ctx.origin,
  })
  return to
}

function parseDefaultPrivilegesStatement(ctx: ScanContext, span: Span): number {
  const { toks, from, to } = span
  let k = from + 3 // ALTER DEFAULT PRIVILEGES
  const forRoles: string[] = []
  const inSchemas: string[] = []
  while (k < to) {
    if (kw(toks[k], 'FOR') && (kw(toks[k + 1], 'ROLE') || kw(toks[k + 1], 'USER'))) {
      const list = readNameList(toks, k + 2, to, ['IN', 'GRANT', 'REVOKE'])
      forRoles.push(...list.names)
      k = list.next
      continue
    }
    if (kw(toks[k], 'IN') && kw(toks[k + 1], 'SCHEMA')) {
      const list = readNameList(toks, k + 2, to, ['FOR', 'GRANT', 'REVOKE'])
      inSchemas.push(...list.names)
      k = list.next
      continue
    }
    break
  }
  const action = kw(toks[k], 'GRANT') ? 'GRANT' : kw(toks[k], 'REVOKE') ? 'REVOKE' : null
  if (action === null) {
    fail(ctx, span, 'incomplete-statement', 'ALTER DEFAULT PRIVILEGES without GRANT or REVOKE')
    return to
  }
  k++
  const tailWord = action === 'GRANT' ? 'TO' : 'FROM'
  let onAt = -1
  let tailAt = -1
  for (let j = k; j < to; j++) {
    if (kw(toks[j], 'ON') && onAt === -1) onAt = j
    if (kw(toks[j], tailWord) && j > onAt) {
      tailAt = j
      break
    }
  }
  if (onAt === -1 || tailAt === -1) {
    fail(ctx, span, 'incomplete-statement', 'ALTER DEFAULT PRIVILEGES without ON or a grantee clause')
    return to
  }
  const privileges = toks.slice(k, onAt).filter((t) => t.kind === 'word').map((t) => t.upper)
  const objectKind = toks.slice(onAt + 1, tailAt).filter((t) => t.kind === 'word').map((t) => t.upper).join(' ')
  const granteeList = readNameList(toks, tailAt + 1, to, ['WITH'])
  ctx.out.defaultPrivileges.push({
    action,
    forRoles,
    inSchemas,
    privileges,
    objectKind,
    grantees: granteeList.names,
    raw: spanText(ctx, span),
    origin: ctx.origin,
  })
  return to
}

// ---------------------------------------------------------------------------
// 6. Public API
// ---------------------------------------------------------------------------

const ANALYSIS_CACHE = new Map<string, SecurityAnalysis>()

/**
 * Everything the security contract can be evaluated against, plus everything
 * the parser could NOT read.
 *
 * The second half is not a diagnostic. `unparsed` is consumed by a gate, so an
 * expression of a security operation this parser does not model is a RED TEST
 * rather than an absence of evidence.
 */
export function analyzeSecurity(sql: string): SecurityAnalysis {
  if (sql.length === 0) return EMPTY_ANALYSIS
  const cached = ANALYSIS_CACHE.get(sql)
  if (cached) return cached

  const out: ScanContext['out'] = {
    policies: [],
    droppedPolicies: [],
    grants: [],
    revokes: [],
    ownerships: [],
    rlsToggles: [],
    roleStatements: [],
    ownedStatements: [],
    defaultPrivileges: [],
    indexes: [],
    unparsed: [],
  }
  const ctx: ScanContext = {
    src: sql,
    code: stripComments(sql),
    origin: 'file',
    baseOffset: 0,
    out,
    depth: 0,
  }
  const lexed = lex(sql)
  scan(ctx, lexed.tokens)

  // A literal or a body that never closed swallows everything after it. That
  // is not a parse detail, it is the whole tail of the file going quiet, and
  // the gates would report the silence as compliance.
  for (const u of lexed.unterminated) {
    out.unparsed.push({
      reason: 'unterminated-body',
      lead: u.kind.toUpperCase(),
      origin: 'file',
      offset: u.offset,
      line: lineOf(sql, u.offset),
      detail: `an unterminated ${u.kind} swallows the rest of the text, so nothing after it is judged`,
    })
  }

  const result: SecurityAnalysis = {
    policies: out.policies,
    droppedPolicies: out.droppedPolicies,
    grants: out.grants,
    revokes: out.revokes,
    ownerships: out.ownerships,
    rlsToggles: out.rlsToggles,
    roleStatements: out.roleStatements,
    ownedStatements: out.ownedStatements,
    defaultPrivileges: out.defaultPrivileges,
    indexes: out.indexes,
    unparsed: out.unparsed,
  }
  if (ANALYSIS_CACHE.size > 256) ANALYSIS_CACHE.clear()
  ANALYSIS_CACHE.set(sql, result)
  return result
}

export function parsePolicies(sql: string): ParsedPolicy[] {
  return [...analyzeSecurity(sql).policies]
}

export function parseDroppedPolicies(sql: string): Array<{ name: string; table: string }> {
  return analyzeSecurity(sql).droppedPolicies.map((d) => ({ name: d.name, table: d.table }))
}

export function parseGrants(sql: string): ParsedGrant[] {
  return [...analyzeSecurity(sql).grants]
}

export function parseRevokes(sql: string): ParsedGrant[] {
  return [...analyzeSecurity(sql).revokes]
}

export function parseOwnerships(sql: string): ParsedOwnership[] {
  return [...analyzeSecurity(sql).ownerships]
}

export function parseRlsToggles(sql: string): RlsToggle[] {
  return [...analyzeSecurity(sql).rlsToggles]
}

export function parseIndexes(sql: string): ParsedIndex[] {
  return [...analyzeSecurity(sql).indexes]
}

export function parseRoleStatements(sql: string): ParsedRoleStatement[] {
  return [...analyzeSecurity(sql).roleStatements]
}

export function parseOwnedStatements(sql: string): ParsedOwnedStatement[] {
  return [...analyzeSecurity(sql).ownedStatements]
}

export function parseDefaultPrivileges(sql: string): ParsedDefaultPrivilege[] {
  return [...analyzeSecurity(sql).defaultPrivileges]
}

export function unparsedSecurityStatements(sql: string): UnparsedSecurityStatement[] {
  return [...analyzeSecurity(sql).unparsed]
}

/**
 * The CONTENTS of every `EXECUTE '<literal>'`, with '' unescaped.
 *
 * Retained because the parser tests read it directly and because it names the
 * property plainly. The GATES no longer append these to the source: the scanner
 * descends into executable bodies natively, and appending would have counted
 * every executed statement twice.
 */
export function executedLiterals(sql: string): string[] {
  const out: string[] = []
  const toks = lex(sql).tokens
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].kind === 'word' && toks[k].upper === 'EXECUTE') {
      const arg = toks[k + 1]
      if (arg && arg.kind === 'string') out.push(arg.text)
    }
    if (toks[k].kind === 'string' && toks[k].dollarTag !== null) {
      out.push(...executedLiterals(toks[k].text))
    }
  }
  return out
}

/** `sql` with every executed literal appended as if it had been written out. */
export function withExecutedLiterals(sql: string): string {
  const extra = executedLiterals(sql)
  return extra.length === 0 ? sql : `${sql}\n${extra.map((s) => `${s};`).join('\n')}`
}

/** Every privilege a grantee receives on an object, flattened. */
export function privilegesFor(
  grants: readonly ParsedGrant[],
  object: string,
  grantee: string,
): ParsedPrivilege[] {
  return grants
    .filter((g) => g.object === object && g.grantees.includes(grantee.toLowerCase()))
    .flatMap((g) => g.privileges as ParsedPrivilege[])
}

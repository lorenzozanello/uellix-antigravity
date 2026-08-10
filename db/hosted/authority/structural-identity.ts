// db/hosted/authority/structural-identity.ts
// COMMIT 3 — what a governed statement IS, independently of where it sits.
//
// ---------------------------------------------------------------------------
// THE THREE QUESTIONS, AND WHY THEY ARE THREE
// ---------------------------------------------------------------------------
//   ObjectIdentity              WHICH OBJECT does this touch?
//   StatementIdentity           WHICH OPERATION on it, exactly?
//   normalizedExecutableDigest  Is the CONTENT that was audited still the same?
//
// Collapsing any two of them loses something the plan needs. Object alone
// cannot separate `GRANT EXECUTE ON f` from `ALTER FUNCTION f OWNER TO r`, and
// a window that starts at "the statement about f" would start at whichever came
// first. Statement alone cannot notice that a function BODY changed while its
// signature did not — which is the mutation an authority review most needs to
// see. Digest alone cannot be written down in a manifest a human reviews,
// because a reviewer cannot check a hash against a package by reading it.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY REFUSED
// ---------------------------------------------------------------------------
// This is NOT a PostgreSQL parser and must never grow into one. It models the
// statement forms the nine chain packages actually contain — measured, not
// assumed — and throws `UNSUPPORTED_STRUCTURAL_IDENTITY` on everything else.
//
// The rejected alternative was a textual fallback: lowercase whatever arrives,
// keep going, and hope. That fails in the worst possible direction. A type
// spelled two ways would produce two identities for one routine, an anchor
// would resolve to zero statements, and the operator would be told "anchor
// missing" about a statement plainly present in the file. A refusal naming the
// unmodelled form is a smaller problem than an identity that is quietly wrong.

import { createHash } from 'node:crypto'

import { lexSql, normalizeExecutable, type SqlSegment } from './sql-statements'

export class UnsupportedStructuralIdentityError extends Error {
  readonly code = 'UNSUPPORTED_STRUCTURAL_IDENTITY'
  constructor(what: string, sample: string) {
    super(
      `UNSUPPORTED_STRUCTURAL_IDENTITY: ${what}. The authority plan models only the statement and ` +
        `type forms the nine chain packages were measured to contain; extending it is a deliberate ` +
        `edit to db/hosted/authority/structural-identity.ts, reviewed like any other authority ` +
        `change. Refused rather than approximated.\n  at: ${sample.slice(0, 200)}`,
    )
    this.name = 'UnsupportedStructuralIdentityError'
  }
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

type TokenKind = 'word' | 'quoted-ident' | 'string' | 'dollar' | 'punct' | 'number'

interface Token {
  readonly kind: TokenKind
  /** For `quoted-ident`, the unescaped content. Otherwise the raw text. */
  readonly value: string
}

/**
 * Tokenizes a statement.
 *
 * Comments are dropped, and string / dollar-quoted regions become ONE opaque
 * token each. That single decision is what makes prose non-anchoring: a
 * `RAISE EXCEPTION 'GRANT EXECUTE ON FUNCTION ...'` contributes one `string`
 * token, and a function body contributes one `dollar` token, so no parser below
 * can ever mistake either for the statement it describes.
 */
function tokenize(statement: string): Token[] {
  const tokens: Token[] = []
  for (const segment of lexSql(statement)) {
    switch (segment.kind) {
      case 'line-comment':
      case 'block-comment':
        break
      case 'string':
        tokens.push({ kind: 'string', value: segment.text })
        break
      case 'dollar-string':
        tokens.push({ kind: 'dollar', value: segment.text })
        break
      case 'quoted-identifier':
        tokens.push({ kind: 'quoted-ident', value: unquoteIdentifier(segment.text) })
        break
      case 'code':
        tokens.push(...tokenizeCode(segment))
        break
    }
  }
  return tokens
}

function unquoteIdentifier(raw: string): string {
  const inner = raw.startsWith('"') ? raw.slice(1, raw.endsWith('"') ? -1 : undefined) : raw
  return inner.replace(/""/g, '"')
}

function tokenizeCode(segment: SqlSegment): Token[] {
  const tokens: Token[] = []
  const text = segment.text
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) {
      i += 1
      continue
    }
    if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_$\u0080-\uffff]/.test(text[j])) j += 1
      tokens.push({ kind: 'word', value: text.slice(i, j) })
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j += 1
      tokens.push({ kind: 'number', value: text.slice(i, j) })
      i = j
      continue
    }
    tokens.push({ kind: 'punct', value: c })
    i += 1
  }
  return tokens
}

/* -------------------------------------------------------------------------- */
/* Identifier folding                                                         */
/* -------------------------------------------------------------------------- */

/**
 * PostgreSQL folds an unquoted identifier to lower case and leaves a quoted one
 * alone. So `foo`, `FOO` and `"foo"` are one object and `"Foo"` is another.
 *
 * Folding both to lower case would be friendlier and wrong: it would merge two
 * objects that can coexist in one schema, and an authority window pinned to one
 * of them would silently cover the other.
 */
function foldIdentifier(token: Token): string {
  if (token.kind === 'quoted-ident') return token.value
  if (token.kind === 'word') return token.value.toLowerCase()
  throw new UnsupportedStructuralIdentityError(
    `expected an identifier, found ${token.kind}`,
    token.value,
  )
}

/* -------------------------------------------------------------------------- */
/* Type normalization                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The CLOSED table of argument types this plan models.
 *
 * Measured, on 2026-08-10, over every routine signature in the nine chain
 * packages: the surface is exactly uuid, char(N), character, varchar(N),
 * character varying, integer and jsonb. `text` is included because the brief
 * names it and because it is the one form most likely to arrive next.
 *
 * Anything absent from this table is a refusal, not a guess. Adding a row is a
 * reviewable edit; silently accepting an unknown spelling is not.
 */
const ARGUMENT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  char: 'bpchar',
  character: 'bpchar',
  bpchar: 'bpchar',
  varchar: 'varchar',
  'character varying': 'varchar',
  int: 'int4',
  integer: 'int4',
  int4: 'int4',
  uuid: 'uuid',
  jsonb: 'jsonb',
  text: 'text',
}

/**
 * Normalizes one argument type to the spelling `pg_catalog` would report.
 *
 * Type modifiers are dropped because PostgreSQL does not resolve overloads on
 * them: `char(64)` and `char(32)` are the same type, `bpchar`, for the purpose
 * of telling two functions apart. Keeping the modifier in the identity would
 * make a widened column length look like a different function.
 */
export function normalizeArgumentType(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new UnsupportedStructuralIdentityError('empty argument type', raw)
  }
  if (/\[\s*\]/.test(trimmed)) {
    throw new UnsupportedStructuralIdentityError('array types are not modelled', raw)
  }

  const withoutTypmod = trimmed.replace(/\(\s*\d+(\s*,\s*\d+)?\s*\)\s*$/, '')
  const key = withoutTypmod.replace(/\s+/g, ' ').trim().toLowerCase()
  const resolved = ARGUMENT_TYPE_ALIASES[key]
  if (resolved === undefined) {
    throw new UnsupportedStructuralIdentityError(`unmodelled argument type \`${key}\``, raw)
  }
  return resolved
}

/* -------------------------------------------------------------------------- */
/* Object identity                                                            */
/* -------------------------------------------------------------------------- */

export type ObjectClass =
  | 'schema'
  | 'table'
  | 'index'
  | 'view'
  | 'sequence'
  | 'function'
  | 'procedure'
  | 'policy'
  | 'trigger'
  | 'role'
  | 'type'
  | 'database'
  | 'column'
  | 'constraint'

export interface ObjectIdentity {
  readonly objectClass: ObjectClass
  /** Folded. `null` for objects that do not live in a schema (roles, schemas). */
  readonly schema: string | null
  /** Folded. */
  readonly name: string
  /** Normalized identity argument types. Routines only; `[]` means no args. */
  readonly argumentTypes?: readonly string[]
  /** For policies and triggers: the `schema.table` they hang off. */
  readonly qualifier?: string
}

export function formatObjectIdentity(object: ObjectIdentity): string {
  const qualified = object.schema === null ? object.name : `${object.schema}.${object.name}`
  const args =
    object.argumentTypes === undefined ? '' : `(${object.argumentTypes.join(',')})`
  const on = object.qualifier === undefined ? '' : `@${object.qualifier}`
  return `${object.objectClass}:${qualified}${args}${on}`
}

/* -------------------------------------------------------------------------- */
/* Statement identity                                                         */
/* -------------------------------------------------------------------------- */

export type StatementClass =
  | 'do-block'
  | 'set-role'
  | 'reset-role'
  | 'set-parameter'
  | 'create-schema'
  | 'create-table'
  | 'create-index'
  | 'create-policy'
  | 'create-trigger'
  | 'create-function'
  | 'create-procedure'
  | 'create-view'
  | 'create-type'
  | 'create-role'
  | 'alter-table'
  | 'alter-function'
  | 'alter-role'
  | 'alter-schema'
  | 'alter-object'
  | 'owner-transfer'
  | 'grant-privilege'
  | 'revoke-privilege'
  | 'grant-membership'
  | 'revoke-membership'
  | 'comment'
  | 'drop-object'
  | 'dml'

export interface StatementIdentity {
  readonly statementClass: StatementClass
  /** `null` for statements that name no object — DO blocks, RESET ROLE. */
  readonly object: ObjectIdentity | null
  /** Grantees, new owners, privilege lists: what makes two operations differ. */
  readonly operands: readonly string[]
  /** SHA-256 of the normalized executable text. Content, not identity. */
  readonly digest: string
}

/** SHA-256 over normalized executable text. The "is the content still the same" half. */
export function normalizedExecutableDigest(statement: string): string {
  return createHash('sha256').update(normalizeExecutable(statement), 'utf8').digest('hex')
}

/**
 * The canonical string two identities are compared on.
 *
 * Classes with a natural operand set are keyed structurally, so a reviewer can
 * read the key and check it against the package by eye. The rest fall back to
 * including the digest — an `ALTER TABLE` naming three different actions on one
 * table needs SOMETHING to tell the three apart, and inventing an occurrence
 * index for them is exactly the shortcut this design rejected.
 */
export function statementIdentityKey(identity: StatementIdentity): string {
  const object = identity.object === null ? '' : formatObjectIdentity(identity.object)
  const operands = identity.operands.length === 0 ? '' : `:${identity.operands.join(':')}`

  switch (identity.statementClass) {
    case 'do-block':
      return `do-block:${identity.digest}`
    case 'reset-role':
      return 'reset-role'
    case 'set-role':
    case 'set-parameter':
      return `${identity.statementClass}${operands}`
    case 'alter-table':
    case 'alter-function':
    case 'alter-role':
    case 'alter-schema':
    case 'alter-object':
    case 'dml':
      return `${identity.statementClass}:${object}:${identity.digest}`
    default:
      return `${identity.statementClass}:${object}${operands}`
  }
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

interface Cursor {
  readonly tokens: readonly Token[]
  at: number
}

function peek(c: Cursor, offset = 0): Token | undefined {
  return c.tokens[c.at + offset]
}

function isWord(token: Token | undefined, word: string): boolean {
  return token !== undefined && token.kind === 'word' && token.value.toUpperCase() === word
}

/** Consumes the given keyword sequence if present. Returns whether it did. */
function eatWords(c: Cursor, ...words: string[]): boolean {
  for (let i = 0; i < words.length; i += 1) {
    if (!isWord(peek(c, i), words[i])) return false
  }
  c.at += words.length
  return true
}

function expectIdentifier(c: Cursor, sample: string): string {
  const token = peek(c)
  if (token === undefined) {
    throw new UnsupportedStructuralIdentityError('statement ended where a name was expected', sample)
  }
  c.at += 1
  return foldIdentifier(token)
}

/** `a`, `a.b` or `"a"."b"`. Returns the folded parts, outermost last. */
function parseQualifiedName(c: Cursor, sample: string): string[] {
  const parts = [expectIdentifier(c, sample)]
  while (peek(c)?.kind === 'punct' && peek(c)?.value === '.') {
    c.at += 1
    parts.push(expectIdentifier(c, sample))
  }
  return parts
}

function splitTopLevel(tokens: readonly Token[]): Token[][] {
  const groups: Token[][] = []
  let current: Token[] = []
  let depth = 0
  for (const token of tokens) {
    if (token.kind === 'punct' && (token.value === '(' || token.value === '[')) depth += 1
    if (token.kind === 'punct' && (token.value === ')' || token.value === ']')) depth -= 1
    if (token.kind === 'punct' && token.value === ',' && depth === 0) {
      groups.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** Renders a token run back to a type-ish string: words joined, typmods kept. */
function renderTypeTokens(tokens: readonly Token[]): string {
  let out = ''
  for (const token of tokens) {
    if (token.kind === 'punct' || token.kind === 'number') {
      out += token.value
    } else {
      out += (out.length > 0 && !out.endsWith('(') ? ' ' : '') + token.value
    }
  }
  return out.trim()
}

/**
 * One argument of a routine signature, reduced to its identity type.
 *
 * Returns `null` for an `OUT` argument: PostgreSQL does not resolve overloads
 * on those, so including one would make `f(uuid)` and `f(uuid, OUT int)` look
 * like two routines when the catalog holds one.
 *
 * The name is detected by ELIMINATION rather than by pattern. An argument is
 * `[mode] [name] type [DEFAULT expr]`, and both the mode and the name are
 * optional, so `p_max integer` and `integer` are the same shape to a scanner.
 * Trying the whole remainder as a type first, and only dropping a leading token
 * if that fails, gets both right without a list of "words that look like names"
 * — a list that would have to include `text`, which is also a type.
 */
function parseArgumentType(tokens: readonly Token[], sample: string): string | null {
  let working = [...tokens]

  if (working.length > 0 && working[0].kind === 'word') {
    const mode = working[0].value.toUpperCase()
    if (mode === 'OUT') return null
    if (mode === 'IN' || mode === 'INOUT' || mode === 'VARIADIC') working = working.slice(1)
  }

  const defaultAt = working.findIndex(
    (t) => (t.kind === 'word' && t.value.toUpperCase() === 'DEFAULT') || (t.kind === 'punct' && t.value === '='),
  )
  if (defaultAt !== -1) working = working.slice(0, defaultAt)

  if (working.length === 0) {
    throw new UnsupportedStructuralIdentityError('argument with no type', sample)
  }

  try {
    return normalizeArgumentType(renderTypeTokens(working))
  } catch (error) {
    if (!(error instanceof UnsupportedStructuralIdentityError)) throw error
    if (working.length < 2) throw error
    return normalizeArgumentType(renderTypeTokens(working.slice(1)))
  }
}

/** Parses `( ... )` after a routine name. Returns `undefined` if absent. */
function parseArgumentList(c: Cursor, sample: string): string[] | undefined {
  const open = peek(c)
  if (open === undefined || open.kind !== 'punct' || open.value !== '(') return undefined

  let depth = 0
  const inner: Token[] = []
  let i = c.at
  for (; i < c.tokens.length; i += 1) {
    const token = c.tokens[i]
    if (token.kind === 'punct' && token.value === '(') {
      depth += 1
      if (depth === 1) continue
    }
    if (token.kind === 'punct' && token.value === ')') {
      depth -= 1
      if (depth === 0) break
    }
    inner.push(token)
  }
  if (depth !== 0) {
    throw new UnsupportedStructuralIdentityError('unbalanced argument list', sample)
  }
  c.at = i + 1

  if (inner.length === 0) return []
  return splitTopLevel(inner)
    .map((group) => parseArgumentType(group, sample))
    .filter((t): t is string => t !== null)
}

function routineIdentity(
  c: Cursor,
  objectClass: 'function' | 'procedure',
  sample: string,
): ObjectIdentity {
  const parts = parseQualifiedName(c, sample)
  const argumentTypes = parseArgumentList(c, sample) ?? []
  return {
    objectClass,
    schema: parts.length > 1 ? parts[parts.length - 2] : null,
    name: parts[parts.length - 1],
    argumentTypes,
  }
}

function relationIdentity(c: Cursor, objectClass: ObjectClass, sample: string): ObjectIdentity {
  const parts = parseQualifiedName(c, sample)
  return {
    objectClass,
    schema: parts.length > 1 ? parts[parts.length - 2] : null,
    name: parts[parts.length - 1],
  }
}

function qualifiedString(object: ObjectIdentity): string {
  return object.schema === null ? object.name : `${object.schema}.${object.name}`
}

const OBJECT_CLASS_KEYWORDS: Readonly<Record<string, ObjectClass>> = {
  TABLE: 'table',
  VIEW: 'view',
  SEQUENCE: 'sequence',
  SCHEMA: 'schema',
  FUNCTION: 'function',
  PROCEDURE: 'procedure',
  INDEX: 'index',
  POLICY: 'policy',
  TRIGGER: 'trigger',
  ROLE: 'role',
  TYPE: 'type',
  DATABASE: 'database',
  COLUMN: 'column',
  CONSTRAINT: 'constraint',
}

/**
 * Object classes that do not stand alone: a policy, a trigger and a constraint
 * are named relative to a table, and two of them with the same name on two
 * tables are two objects.
 *
 * The identity is built from BOTH names, and it is built the same way whether
 * the statement is a CREATE, a DROP or a COMMENT. An earlier version read the
 * `ON table` clause only on CREATE, which gave `DROP POLICY "x" ON t` a
 * different identity from the `CREATE POLICY "x" ON t` it undoes — so the
 * ownership ledger held two entries for one object and every DROP resolved
 * against an unknown one. Found by running the ledger over the real chain.
 */
const TABLE_SUBSIDIARY: ReadonlySet<ObjectClass> = new Set<ObjectClass>([
  'policy',
  'trigger',
  'constraint',
])

/** Reads `name ON table` for a subsidiary object, in any statement that names one. */
function subsidiaryIdentity(c: Cursor, objectClass: ObjectClass, sample: string): ObjectIdentity {
  const name = expectIdentifier(c, sample)
  const onAt = findTopLevelWord(c.tokens, c.at, 'ON')
  if (onAt === -1) {
    throw new UnsupportedStructuralIdentityError(
      `a ${objectClass} named without the table it belongs to has no stable identity`,
      sample,
    )
  }
  c.at = onAt + 1
  const table = relationIdentity(c, 'table', sample)
  return {
    objectClass,
    schema: table.schema,
    name,
    qualifier: qualifiedString(table),
  }
}

/** Reads `[CLASS] ref [args]`, defaulting to TABLE the way GRANT does. */
function parseObjectReference(
  c: Cursor,
  sample: string,
  defaultClass: ObjectClass,
): ObjectIdentity {
  const token = peek(c)
  let objectClass = defaultClass
  if (token !== undefined && token.kind === 'word') {
    const mapped = OBJECT_CLASS_KEYWORDS[token.value.toUpperCase()]
    if (mapped !== undefined) {
      objectClass = mapped
      c.at += 1
    }
  }
  if (objectClass === 'function' || objectClass === 'procedure') {
    return routineIdentity(c, objectClass, sample)
  }
  if (TABLE_SUBSIDIARY.has(objectClass)) {
    return subsidiaryIdentity(c, objectClass, sample)
  }
  if (objectClass === 'column') {
    // `schema.table.column`. Splitting it as a two-part name would name a table
    // that does not exist and lose the column entirely.
    const parts = parseQualifiedName(c, sample)
    if (parts.length < 2) {
      throw new UnsupportedStructuralIdentityError('column reference without a table', sample)
    }
    const column = parts[parts.length - 1]
    const table = parts[parts.length - 2]
    const schema = parts.length > 2 ? parts[parts.length - 3] : null
    return {
      objectClass: 'column',
      schema,
      name: column,
      qualifier: schema === null ? table : `${schema}.${table}`,
    }
  }
  return relationIdentity(c, objectClass, sample)
}

/** Position of a top-level keyword, or -1. Parens are skipped, so args cannot hide one. */
function findTopLevelWord(tokens: readonly Token[], from: number, word: string): number {
  let depth = 0
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.kind === 'punct' && token.value === '(') depth += 1
    else if (token.kind === 'punct' && token.value === ')') depth -= 1
    else if (depth === 0 && token.kind === 'word' && token.value.toUpperCase() === word) return i
  }
  return -1
}

function grantee(c: Cursor, sample: string): string {
  if (eatWords(c, 'GROUP')) {
    /* `GRANT ... TO GROUP x` — the noise word PostgreSQL still accepts. */
  }
  const token = peek(c)
  if (token !== undefined && token.kind === 'word' && token.value.toUpperCase() === 'PUBLIC') {
    c.at += 1
    return 'PUBLIC'
  }
  return expectIdentifier(c, sample)
}

/**
 * Parses one statement into its identity.
 *
 * The statement is tokenized first, which is what makes every "does prose
 * anchor?" question answer itself: a signature inside a comment produced no
 * tokens at all, and a signature inside a RAISE message or an EXECUTE string
 * produced exactly one opaque `string` token. Neither can be reached by any
 * branch below.
 */
export function parseStatementIdentity(statement: string): StatementIdentity {
  const tokens = tokenize(statement)
  const digest = normalizedExecutableDigest(statement)
  const sample = statement.trim()

  if (tokens.length === 0) {
    throw new UnsupportedStructuralIdentityError('statement has no tokens', sample)
  }

  const c: Cursor = { tokens, at: 0 }
  const make = (
    statementClass: StatementClass,
    object: ObjectIdentity | null,
    operands: string[] = [],
  ): StatementIdentity => ({ statementClass, object, operands, digest })

  /* ---- DO ------------------------------------------------------------- */
  if (eatWords(c, 'DO')) return make('do-block', null)

  /* ---- SET / RESET ROLE ----------------------------------------------- */
  if (eatWords(c, 'RESET', 'ROLE')) return make('reset-role', null)
  if (eatWords(c, 'SET', 'ROLE')) {
    if (eatWords(c, 'NONE')) return make('reset-role', null)
    return make('set-role', null, [expectIdentifier(c, sample)])
  }
  if (isWord(peek(c), 'SET') || isWord(peek(c), 'RESET')) {
    return make('set-parameter', null, [digest])
  }

  /* ---- CREATE --------------------------------------------------------- */
  if (eatWords(c, 'CREATE')) {
    eatWords(c, 'OR', 'REPLACE')
    const unique = eatWords(c, 'UNIQUE')
    void unique

    if (eatWords(c, 'SCHEMA')) {
      eatWords(c, 'IF', 'NOT', 'EXISTS')
      const parts = parseQualifiedName(c, sample)
      return make('create-schema', {
        objectClass: 'schema',
        schema: null,
        name: parts[parts.length - 1],
      })
    }
    if (eatWords(c, 'ROLE')) {
      return make('create-role', {
        objectClass: 'role',
        schema: null,
        name: expectIdentifier(c, sample),
      })
    }
    if (eatWords(c, 'TABLE')) {
      eatWords(c, 'IF', 'NOT', 'EXISTS')
      return make('create-table', relationIdentity(c, 'table', sample))
    }
    if (eatWords(c, 'INDEX')) {
      eatWords(c, 'CONCURRENTLY')
      eatWords(c, 'IF', 'NOT', 'EXISTS')
      if (isWord(peek(c), 'ON')) {
        throw new UnsupportedStructuralIdentityError('unnamed index has no stable identity', sample)
      }
      return make('create-index', relationIdentity(c, 'index', sample))
    }
    if (eatWords(c, 'POLICY')) {
      return make('create-policy', subsidiaryIdentity(c, 'policy', sample))
    }
    if (eatWords(c, 'TRIGGER')) {
      return make('create-trigger', subsidiaryIdentity(c, 'trigger', sample))
    }
    if (eatWords(c, 'FUNCTION')) return make('create-function', routineIdentity(c, 'function', sample))
    if (eatWords(c, 'PROCEDURE')) {
      return make('create-procedure', routineIdentity(c, 'procedure', sample))
    }
    if (eatWords(c, 'VIEW') || eatWords(c, 'MATERIALIZED', 'VIEW')) {
      eatWords(c, 'IF', 'NOT', 'EXISTS')
      return make('create-view', relationIdentity(c, 'view', sample))
    }
    if (eatWords(c, 'TYPE')) return make('create-type', relationIdentity(c, 'type', sample))

    throw new UnsupportedStructuralIdentityError('unmodelled CREATE form', sample)
  }

  /* ---- ALTER ---------------------------------------------------------- */
  if (eatWords(c, 'ALTER')) {
    const classToken = peek(c)
    if (classToken === undefined || classToken.kind !== 'word') {
      throw new UnsupportedStructuralIdentityError('ALTER without an object class', sample)
    }
    const objectClass = OBJECT_CLASS_KEYWORDS[classToken.value.toUpperCase()]
    if (objectClass === undefined) {
      throw new UnsupportedStructuralIdentityError(
        `unmodelled ALTER target \`${classToken.value}\``,
        sample,
      )
    }
    c.at += 1
    eatWords(c, 'IF', 'EXISTS')

    const object =
      objectClass === 'function' || objectClass === 'procedure'
        ? routineIdentity(c, objectClass, sample)
        : relationIdentity(c, objectClass, sample)

    const ownerAt = findTopLevelWord(tokens, c.at, 'OWNER')
    if (ownerAt !== -1 && isWord(tokens[ownerAt + 1], 'TO')) {
      const owner: Cursor = { tokens, at: ownerAt + 2 }
      return make('owner-transfer', object, [expectIdentifier(owner, sample)])
    }

    switch (objectClass) {
      case 'table':
        return make('alter-table', object)
      case 'function':
      case 'procedure':
        return make('alter-function', object)
      case 'role':
        return make('alter-role', object)
      case 'schema':
        return make('alter-schema', object)
      default:
        return make('alter-object', object)
    }
  }

  /* ---- GRANT / REVOKE -------------------------------------------------- */
  const isGrant = isWord(peek(c), 'GRANT')
  const isRevoke = isWord(peek(c), 'REVOKE')
  if (isGrant || isRevoke) {
    c.at += 1
    if (isRevoke) {
      eatWords(c, 'GRANT', 'OPTION', 'FOR')
      eatWords(c, 'ADMIN', 'OPTION', 'FOR')
    }

    const boundary = isGrant ? 'TO' : 'FROM'
    const onAt = findTopLevelWord(tokens, c.at, 'ON')
    const boundaryAt = findTopLevelWord(tokens, c.at, boundary)
    if (boundaryAt === -1) {
      throw new UnsupportedStructuralIdentityError(`GRANT/REVOKE without ${boundary}`, sample)
    }

    /* No `ON` before the boundary means this grants ROLE MEMBERSHIP, which is
     * a completely different authority act from granting a privilege, and the
     * plan governs the two under different rules. */
    if (onAt === -1 || onAt > boundaryAt) {
      const roles = splitTopLevel(tokens.slice(c.at, boundaryAt)).map((group) =>
        foldIdentifier(group[0]),
      )
      const memberCursor: Cursor = { tokens, at: boundaryAt + 1 }
      const members: string[] = [grantee(memberCursor, sample)]
      while (peek(memberCursor)?.kind === 'punct' && peek(memberCursor)?.value === ',') {
        memberCursor.at += 1
        members.push(grantee(memberCursor, sample))
      }
      return make(isGrant ? 'grant-membership' : 'revoke-membership', null, [
        roles.join('+'),
        members.join('+'),
      ])
    }

    /* Privileges. Column lists are part of the privilege, not of the object:
     * `GRANT SELECT (a, b)` and `GRANT SELECT (a)` are different grants on the
     * same table, and flattening them would merge two windows' worth of intent. */
    const privileges = splitTopLevel(tokens.slice(c.at, onAt))
      .map((group) => renderTypeTokens(group).replace(/\s+/g, ' ').toUpperCase())
      .filter((p) => p.length > 0)
      .sort()

    const objectCursor: Cursor = { tokens, at: onAt + 1 }
    const object = parseObjectReference(objectCursor, sample, 'table')

    const granteeCursor: Cursor = { tokens, at: boundaryAt + 1 }
    const grantees: string[] = [grantee(granteeCursor, sample)]
    while (peek(granteeCursor)?.kind === 'punct' && peek(granteeCursor)?.value === ',') {
      granteeCursor.at += 1
      grantees.push(grantee(granteeCursor, sample))
    }

    return make(isGrant ? 'grant-privilege' : 'revoke-privilege', object, [
      privileges.join('+'),
      grantees.join('+'),
    ])
  }

  /* ---- COMMENT --------------------------------------------------------- */
  if (eatWords(c, 'COMMENT', 'ON')) {
    return make('comment', parseObjectReference(c, sample, 'table'))
  }

  /* ---- DROP ------------------------------------------------------------ */
  if (eatWords(c, 'DROP')) {
    const classToken = peek(c)
    if (classToken === undefined || classToken.kind !== 'word') {
      throw new UnsupportedStructuralIdentityError('DROP without an object class', sample)
    }
    const objectClass = OBJECT_CLASS_KEYWORDS[classToken.value.toUpperCase()]
    if (objectClass === undefined) {
      throw new UnsupportedStructuralIdentityError(
        `unmodelled DROP target \`${classToken.value}\``,
        sample,
      )
    }
    c.at += 1
    eatWords(c, 'IF', 'EXISTS')
    const object =
      objectClass === 'function' || objectClass === 'procedure'
        ? routineIdentity(c, objectClass, sample)
        : TABLE_SUBSIDIARY.has(objectClass)
          ? subsidiaryIdentity(c, objectClass, sample)
          : relationIdentity(c, objectClass, sample)
    return make('drop-object', object)
  }

  /* ---- DML -------------------------------------------------------------- */
  if (
    isWord(peek(c), 'SELECT') ||
    isWord(peek(c), 'INSERT') ||
    isWord(peek(c), 'UPDATE') ||
    isWord(peek(c), 'DELETE') ||
    isWord(peek(c), 'WITH')
  ) {
    return make('dml', null, [])
  }

  throw new UnsupportedStructuralIdentityError('unmodelled statement form', sample)
}

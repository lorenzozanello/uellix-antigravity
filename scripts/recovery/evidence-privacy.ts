// scripts/recovery/evidence-privacy.ts — the evidence grammar
// (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-9).
//
// WHY A GRAMMAR AND NOT A DENYLIST. The authority's DP-5 says evidence carries
// COUNTS, DIGESTS and PREDICATE VERDICTS, never rows, and it treats any future
// hosted input as CUSTOMER_DATA until classified. A denylist ("no email-shaped
// string") only catches the row shapes somebody thought of. A closed grammar
// inverts the burden: every evidence field has a declared KIND, every string
// kind admits only identifiers, digests, codes, versions or timestamps, every
// object is closed (an unknown key is a violation, a missing key is a
// violation), and a count must be an integer. A row value has nowhere to go —
// not in a free-text field (there is none), not in an extra key, not by
// replacing a count with text.
//
// What the grammar deliberately does NOT try to prevent: an identifier that
// happens to be a customer's name used as a TABLE name. Catalog metadata is
// schema, and the authority permits relation names in evidence.
//
// Tool stderr is the one channel where PostgreSQL itself quotes row values
// ("DETAIL: Failing row contains (...)", "Key (email)=(...) already exists").
// NOTHING derived from its text is retained except a CLOSED diagnostic class
// (classifyToolOutcome). In particular no digest of it: the recert of
// ec573e9b recovered a four-digit row value by brute-forcing an unsalted
// sha256 of stderr in 1/10000 tries — a digest of low-entropy data is a
// confirmation oracle, and no salt, truncation or re-hashing changes that.
// The authority never requires a stderr digest (no occurrence of "stderr" in
// the recovery authority, its amendment, or STAGING_RELEASE_PRODUCTION_AUTHORITY).

export type StringGrammar =
  | 'identifier'
  | 'qualified_identifier'
  | 'sha256'
  | 'git_sha'
  | 'docker_id'
  | 'image_id'
  | 'image_ref'
  | 'code'
  | 'version'
  | 'iso_timestamp'
  | 'resource_name'
  | 'acl_item'
  | 'cli_token'
  | 'fact'

const GRAMMARS: Record<StringGrammar, RegExp> = {
  identifier: /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/,
  qualified_identifier: /^[A-Za-z_][A-Za-z0-9_$]{0,62}\.[A-Za-z_][A-Za-z0-9_$]{0,62}$/,
  sha256: /^[0-9a-f]{64}$/,
  git_sha: /^[0-9a-f]{40}$/,
  docker_id: /^[0-9a-f]{64}$/,
  image_id: /^sha256:[0-9a-f]{64}$/,
  image_ref: /^[a-z0-9][a-z0-9./_-]{0,200}:[A-Za-z0-9._-]{1,64}$/,
  code: /^[A-Z][A-Z0-9_]{1,95}$/,
  version: /^\d{1,4}(\.\d{1,6}){0,3}$/,
  iso_timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/,
  resource_name: /^[a-z0-9][a-z0-9_.-]{0,127}$/,
  /** `grantee:PRIVILEGE:grantor`, grantee may be PUBLIC. */
  acl_item: /^[A-Za-z_][A-Za-z0-9_$]{0,62}:[A-Z ]{3,40}:[A-Za-z_][A-Za-z0-9_$]{0,62}$/,
  /** A command-line token with every secret-bearing element absent by construction. */
  cli_token: /^[A-Za-z0-9_.:=/-]{1,128}$/,
  /**
   * An invariant fact built by a fixed formatter from grammar-checked census
   * fields: identifiers, integers, digests and the separators the formatters
   * use. No whitespace, quotes, parentheses or '@'-local-part-with-domain shapes
   * beyond `ext@version`.
   */
  fact: /^[A-Za-z0-9_$.:=,|*@+-]{1,512}$/,
}

export type Shape =
  | { kind: 'object'; fields: Record<string, Shape> }
  | { kind: 'array'; of: Shape; maxItems?: number }
  | { kind: 'string'; grammar: StringGrammar }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'int' }
  | { kind: 'bool' }
  | { kind: 'nullable'; of: Shape }

export const S = {
  obj: (fields: Record<string, Shape>): Shape => ({ kind: 'object', fields }),
  arr: (of: Shape, maxItems?: number): Shape => ({ kind: 'array', of, maxItems }),
  str: (grammar: StringGrammar): Shape => ({ kind: 'string', grammar }),
  enm: (...values: string[]): Shape => ({ kind: 'enum', values }),
  int: (): Shape => ({ kind: 'int' }),
  bool: (): Shape => ({ kind: 'bool' }),
  opt: (of: Shape): Shape => ({ kind: 'nullable', of }),
}

export interface GrammarViolation {
  path: string
  problem: string
}

/** Validate `value` against `shape`. Closed objects; every violation reported, none silently coerced. */
export function validateEvidence(value: unknown, shape: Shape, path = '$'): GrammarViolation[] {
  const out: GrammarViolation[] = []
  switch (shape.kind) {
    case 'nullable':
      if (value === null) return out
      return validateEvidence(value, shape.of, path)
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        out.push({ path, problem: 'expected a closed object' })
        return out
      }
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(shape.fields, key)) out.push({ path: `${path}.${key}`, problem: 'key not in the evidence grammar' })
      }
      for (const [key, sub] of Object.entries(shape.fields)) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
          out.push({ path: `${path}.${key}`, problem: 'required key absent (an omitted field reads as a passed field)' })
          continue
        }
        out.push(...validateEvidence(record[key], sub, `${path}.${key}`))
      }
      return out
    }
    case 'array': {
      if (!Array.isArray(value)) {
        out.push({ path, problem: 'expected an array' })
        return out
      }
      if (shape.maxItems !== undefined && value.length > shape.maxItems) out.push({ path, problem: `more than ${shape.maxItems} items` })
      value.forEach((item, i) => out.push(...validateEvidence(item, shape.of, `${path}[${i}]`)))
      return out
    }
    case 'string':
      if (typeof value !== 'string' || !GRAMMARS[shape.grammar].test(value)) out.push({ path, problem: `not a ${shape.grammar}` })
      return out
    case 'enum':
      if (typeof value !== 'string' || !shape.values.includes(value)) out.push({ path, problem: `not one of ${shape.values.join('|')}` })
      return out
    case 'int':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) out.push({ path, problem: 'not a non-negative safe integer' })
      return out
    case 'bool':
      if (typeof value !== 'boolean') out.push({ path, problem: 'not a boolean' })
      return out
  }
}

/**
 * Second, independent layer: no forbidden literal (a known secret, a planted
 * canary) appears anywhere in the serialized evidence — including inside keys.
 */
export function findForbiddenSubstrings(serialized: string, forbidden: readonly string[]): string[] {
  return forbidden.filter((f) => f.length > 0 && serialized.includes(f))
}

/**
 * A tool run, as evidence: exit status and a CLOSED diagnostic class. The class
 * depends only on (a) the exit status and (b) a SQLSTATE taken from a line that
 * is ENTIRELY tool-generated (psql with VERBOSITY=sqlstate prints `ERROR:  42501`
 * and nothing else: no message, no DETAIL, no row). Anything else — pg_restore's
 * free-text errors included — is UNKNOWN. Exit 0 is NONE whatever stderr says.
 */
export type ToolDiagnostic =
  | 'NONE'
  | 'INSUFFICIENT_PRIVILEGE'
  | 'INTEGRITY_CONSTRAINT_VIOLATION'
  | 'UNDEFINED_OBJECT'
  | 'DUPLICATE_OBJECT'
  | 'CONNECTION_OR_AUTHENTICATION_FAILURE'
  | 'UNKNOWN'

export const TOOL_DIAGNOSTICS: readonly ToolDiagnostic[] = [
  'NONE',
  'INSUFFICIENT_PRIVILEGE',
  'INTEGRITY_CONSTRAINT_VIOLATION',
  'UNDEFINED_OBJECT',
  'DUPLICATE_OBJECT',
  'CONNECTION_OR_AUTHENTICATION_FAILURE',
  'UNKNOWN',
]

export interface ToolOutcome {
  exit_code: number
  diagnostic: ToolDiagnostic
}

export const TOOL_OUTCOME_SHAPE: Shape = S.obj({ exit_code: S.int(), diagnostic: S.enm(...TOOL_DIAGNOSTICS) })

/** SQLSTATE -> closed class. Unlisted codes are UNKNOWN (fail closed), never passed through. */
export function sqlstateClass(sqlstate: string | null): ToolDiagnostic {
  if (sqlstate === null) return 'UNKNOWN'
  if (sqlstate === '42501') return 'INSUFFICIENT_PRIVILEGE'
  if (sqlstate.startsWith('23')) return 'INTEGRITY_CONSTRAINT_VIOLATION'
  if (['42P01', '42704', '42883', '3F000', '3D000'].includes(sqlstate)) return 'UNDEFINED_OBJECT'
  if (['42P07', '42710', '42P06', '42P04', '42723'].includes(sqlstate)) return 'DUPLICATE_OBJECT'
  if (sqlstate.startsWith('08') || sqlstate.startsWith('28')) return 'CONNECTION_OR_AUTHENTICATION_FAILURE'
  return 'UNKNOWN'
}

export function classifyToolOutcome(exitCode: number | null, stderr: string): ToolOutcome {
  const code = exitCode ?? 1
  if (code === 0) return { exit_code: 0, diagnostic: 'NONE' }
  return { exit_code: code, diagnostic: sqlstateClass(extractSqlstate(stderr)) }
}

/**
 * The SQLSTATE of a line that is WHOLLY tool-generated under psql
 * VERBOSITY=sqlstate: `ERROR:  42501`, optionally prefixed by psql's
 * `psql:<stdin>:3: `. The whole line must match, so text that merely
 * CONTAINS such a fragment (a quoted row, a DETAIL) never yields a code.
 */
export function extractSqlstate(stderr: string): string | null {
  const match = stderr.match(/^(?:psql:[^\s:]*:\d+: )?(?:ERROR|FATAL): {2}([0-9A-Z]{5})\s*$/m)
  return match ? match[1] : null
}

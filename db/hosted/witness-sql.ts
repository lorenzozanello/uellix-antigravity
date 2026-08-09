// db/hosted/witness-sql.ts
//
// GAP C — THE TRANSLATION FROM A TYPED WITNESS TO A pg_catalog QUESTION.
//
// `db/hosted/package-witnesses.ts` declares WHAT identifies each chain package
// and classifies an observation of them. It has no way to obtain that
// observation, so until this module existed the registry could only be fed by
// hand — and a hand-written probe is the thing this programme has now found six
// times: a contract with no consumer, or a consumer that measures something
// adjacent to what the contract describes.
//
// ---------------------------------------------------------------------------
// WHY THE REGISTRY AND THE PROBE MUST BE ONE THING
// ---------------------------------------------------------------------------
// The witnesses were chosen so that ARITY discriminates a package from its
// successor — `settle_reserved_quota` exists with five arguments in stella_0016
// and with ten in stella_0017, and stella_0017 re-creates the five-argument one
// too. A probe that resolved functions BY NAME would report stella_0017
// installed the moment stella_0016 was, and every downstream refusal that
// depends on "an unprobed successor is unknown, not absent" would be answering
// with a fact it had measured wrong.
//
// So there is no name-based lookup anywhere below. Every function witness is
// resolved through `to_regprocedure` with its FULL signature, which is the same
// spelling `oid::regprocedure::text` produces and the same spelling the packages
// themselves use in their own guards.
//
// ---------------------------------------------------------------------------
// WHY `to_regprocedure` AND NOT A JOIN OVER pg_proc
// ---------------------------------------------------------------------------
// A join would have to reconstruct the argument list, and that reconstruction is
// exactly where the S1 probe already went wrong once:
// `pg_get_function_identity_arguments` KEEPS parameter names, so
// `assert_hosted_capabilities` rendered as `(p_package text)` and the contract's
// `(text)` never matched. `to_regprocedure` takes the contract's own spelling and
// hands back an oid or NULL. One form of a signature, resolved by the server.
//
// It also returns NULL — rather than raising — for an object that does not
// exist, including one in a schema that does not exist. That is what lets a
// virgin database be measured by the same query as a fully provisioned one.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE REFUSES
// ---------------------------------------------------------------------------
// Every identifier is validated before it becomes SQL, and the validation is
// deliberately narrower than "escape the quotes". A witness identifier is
// committed code reviewed by a person; if one of them ever stops looking like a
// catalogue name, the honest response is to refuse to build the probe rather
// than to build one whose meaning depends on how a quote was escaped.

import {
  PACKAGE_WITNESSES,
  WITNESSED_PACKAGES,
  witnessKey,
  type PackageWitnesses,
  type Witness,
  type WitnessKind,
} from './package-witnesses'

export type WitnessSqlRefusalCode =
  | 'WITNESS_SQL_IDENTIFIER_EMPTY'
  | 'WITNESS_SQL_IDENTIFIER_MALFORMED'
  | 'WITNESS_SQL_IDENTIFIER_UNSAFE'

export type WitnessSqlResult =
  | { readonly ok: true; readonly sql: string }
  | { readonly ok: false; readonly code: WitnessSqlRefusalCode; readonly detail: string }

/**
 * A bare SQL identifier: a catalogue name, unquoted, no schema.
 *
 * `$` is admitted because PostgreSQL admits it in identifiers; nothing else is.
 * In particular there is no whitespace, no quote of either kind, no semicolon
 * and no hyphen, so an identifier that reached here could not close a literal
 * and open a statement even if the escaping below were removed.
 */
const BARE = /^[A-Za-z_][A-Za-z0-9_$]*$/

/**
 * The inside of a `regprocedure` argument list.
 *
 * Spaces are legal here and ONLY here — `character varying` and `double
 * precision` are two-word type names, and rejecting the space would reject the
 * spelling PostgreSQL itself produces. Everything that could end a literal or
 * start a statement is still refused.
 */
const ARGLIST = /^[A-Za-z0-9_$,[\] ]*$/

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`

const refuse = (code: WitnessSqlRefusalCode, detail: string): WitnessSqlResult => ({ ok: false, code, detail })

/** `schema.name`, both bare. */
function splitQualified(identifier: string, parts: number): string[] | null {
  const segments = identifier.split('.')
  if (segments.length !== parts) return null
  if (!segments.every((s) => BARE.test(s))) return null
  return segments
}

/**
 * ONE witness, ONE boolean-valued SQL expression.
 *
 * The expression is a scalar and self-contained: it can be dropped into a
 * `jsonb_build_object` arm without a surrounding query, which is what lets the
 * generated probe measure each witness INDIVIDUALLY instead of reporting a
 * package-level summary that hides which of four signatures was missing.
 */
export function witnessPredicateSql(witness: Witness): WitnessSqlResult {
  const id = witness.identifier
  if (typeof id !== 'string' || id.trim() === '') {
    return refuse('WITNESS_SQL_IDENTIFIER_EMPTY', `a ${witness.kind} witness carries no identifier.`)
  }
  if (id !== id.trim()) {
    return refuse(
      'WITNESS_SQL_IDENTIFIER_UNSAFE',
      `${JSON.stringify(id)} has leading or trailing whitespace. A catalogue name does not, and trimming it here would make the registry and the probe disagree about what was measured.`,
    )
  }

  // EXHAUSTIVE BY CONSTRUCTION. The switch has no `default`, and the function's
  // return type is not `string`, so adding a WitnessKind without adding its
  // translation is a compile error rather than a witness silently measured as
  // false.
  switch (witness.kind satisfies WitnessKind) {
    case 'role': {
      if (!BARE.test(id)) {
        return refuse(
          'WITNESS_SQL_IDENTIFIER_MALFORMED',
          `role witness ${JSON.stringify(id)} is not a bare role name.`,
        )
      }
      return {
        ok: true,
        sql: `EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = ${lit(id)})`,
      }
    }

    case 'schema': {
      if (!BARE.test(id)) {
        return refuse(
          'WITNESS_SQL_IDENTIFIER_MALFORMED',
          `schema witness ${JSON.stringify(id)} is not a bare schema name.`,
        )
      }
      return {
        ok: true,
        sql: `EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = ${lit(id)})`,
      }
    }

    case 'regclass': {
      const parts = splitQualified(id, 2)
      if (parts === null) {
        return refuse(
          'WITNESS_SQL_IDENTIFIER_MALFORMED',
          `regclass witness ${JSON.stringify(id)} is not schema.relation. An unqualified relation would be resolved through search_path, and the probe pins search_path to '' precisely so that nothing is.`,
        )
      }
      return { ok: true, sql: `(pg_catalog.to_regclass(${lit(id)}) IS NOT NULL)` }
    }

    case 'regprocedure': {
      const open = id.indexOf('(')
      if (open === -1 || !id.endsWith(')')) {
        return refuse(
          'WITNESS_SQL_IDENTIFIER_MALFORMED',
          `regprocedure witness ${JSON.stringify(id)} carries no argument list. ARITY IS THE DISCRIMINATOR: settle_reserved_quota exists with five arguments in stella_0016 and ten in stella_0017, and a witness by name alone would report the successor installed as soon as its predecessor was.`,
        )
      }
      const name = id.slice(0, open)
      const args = id.slice(open + 1, -1)
      if (splitQualified(name, 2) === null) {
        return refuse(
          'WITNESS_SQL_IDENTIFIER_MALFORMED',
          `regprocedure witness ${JSON.stringify(id)} is not schema.function(...).`,
        )
      }
      if (!ARGLIST.test(args)) {
        return refuse(
          'WITNESS_SQL_IDENTIFIER_UNSAFE',
          `the argument list of ${JSON.stringify(id)} holds a character no PostgreSQL type name contains.`,
        )
      }
      return { ok: true, sql: `(pg_catalog.to_regprocedure(${lit(id)}) IS NOT NULL)` }
    }

    case 'column': {
      const parts = splitQualified(id, 3)
      if (parts === null) {
        return refuse(
          'WITNESS_SQL_IDENTIFIER_MALFORMED',
          `column witness ${JSON.stringify(id)} is not schema.table.column.`,
        )
      }
      const [schema, table, column] = parts
      return {
        ok: true,
        sql:
          `EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a ` +
          `JOIN pg_catalog.pg_class c ON c.oid = a.attrelid ` +
          `JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ` +
          `WHERE n.nspname = ${lit(schema)} AND c.relname = ${lit(table)} AND a.attname = ${lit(column)} ` +
          // A DROPPED column keeps its pg_attribute row with a mangled name and a
          // negative attnum is a system column. Neither is the column the package
          // created, and counting either would report a witness present against a
          // table the package never touched.
          `AND a.attnum > 0 AND NOT a.attisdropped)`,
      }
    }

    case 'constraint': {
      const parts = splitQualified(id, 3)
      if (parts === null) {
        return refuse(
          'WITNESS_SQL_IDENTIFIER_MALFORMED',
          `constraint witness ${JSON.stringify(id)} is not schema.table.constraint.`,
        )
      }
      const [schema, table, constraint] = parts
      return {
        ok: true,
        sql:
          `EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k ` +
          `JOIN pg_catalog.pg_class c ON c.oid = k.conrelid ` +
          `JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ` +
          // Bound to the RELATION, not just to the name. Constraint names are
          // unique per table, not per schema, so a same-named constraint on a
          // different table would otherwise witness a package that never ran.
          `WHERE n.nspname = ${lit(schema)} AND c.relname = ${lit(table)} AND k.conname = ${lit(constraint)})`,
      }
    }
  }
}

export interface PackageWitnessSql {
  readonly packageId: string
  /** `kind:identifier` -> the scalar boolean expression that measures it. */
  readonly witnesses: readonly (readonly [key: string, sql: string])[]
}

export type WitnessSqlPlanResult =
  | { readonly ok: true; readonly packages: readonly PackageWitnessSql[] }
  | { readonly ok: false; readonly code: WitnessSqlRefusalCode; readonly detail: string }

/**
 * The whole probe surface, package by package, IN REGISTRY ORDER.
 *
 * Ordered by `WITNESSED_PACKAGES`, which is itself derived from `HOSTED_CHAIN`,
 * so the generated file's package order is the chain's order and a reviewer
 * reading the SQL sees the same sequence the runner would apply.
 *
 * The registry is a parameter with a default rather than a closed-over constant
 * for the reason `verifyStagingTarget` takes its denylist as one: a rule a test
 * cannot vary is a rule nothing proves.
 */
export function planWitnessSql(
  registry: Readonly<Record<string, PackageWitnesses>> = PACKAGE_WITNESSES,
  packageIds: readonly string[] = WITNESSED_PACKAGES,
): WitnessSqlPlanResult {
  const packages: PackageWitnessSql[] = []
  for (const packageId of packageIds) {
    const entry = registry[packageId]
    if (entry === undefined) {
      return {
        ok: false,
        code: 'WITNESS_SQL_IDENTIFIER_EMPTY',
        detail: `${packageId} has no declared witnesses, so the probe would emit a package with nothing to measure — and a package nobody measured is unknown, never absent.`,
      }
    }
    const witnesses: [string, string][] = []
    for (const w of [...entry.requiredPresentWhenInstalled, ...entry.requiredAbsentWhenInstalled]) {
      const built = witnessPredicateSql(w)
      if (!built.ok) return { ok: false, code: built.code, detail: `${packageId}: ${built.detail}` }
      witnesses.push([witnessKey(w), built.sql])
    }
    packages.push({ packageId, witnesses })
  }
  return { ok: true, packages }
}

/* -------------------------------------------------------------------------- */
/* ANCHORING — the registry against the SQL that creates and drops the objects */
/* -------------------------------------------------------------------------- */
//
// The classifier is self-consistent no matter what the registry says. Give
// stella_0017 its predecessor's five-argument settle and every test that asks
// "does T8 classify correctly against these witnesses" still passes — more
// easily, in fact, because the witness is present sooner. The registry's header
// says every signature is "transcribed from the source line that creates or drops
// it", and until this function existed nothing checked that claim.
//
// It matters because the transcription HAD already gone wrong once, in the only
// direction no fixture could see: stella_0014 creates
// `expire_operation_tickets(p_max integer DEFAULT 1000)` and the registry
// recorded `expire_operation_tickets()`. A DEFAULT does not remove the
// parameter — `oid::regprocedure::text` renders the full signature — so that
// witness could never be present, a correctly installed T5 would have measured
// three positives of four, and A1 refuses on partial. The chain would have been
// unplannable forever. Every offline fixture used the registry's own spelling on
// both sides of the comparison, so only the SQL could tell anyone.
//
// ---------------------------------------------------------------------------
// WHAT IS COMPARED, AND WHAT IS HONESTLY NOT
// ---------------------------------------------------------------------------
// Function witnesses are anchored by (qualified name, ARITY). Not by type list:
// the SQL writes `char(64)` and `varchar(50)` where the catalogue reports
// `character` and `character varying`, and reimplementing PostgreSQL's typmod
// erasure here would be a second spelling of a rule the server already owns —
// the exact defect this programme keeps paying for. Arity is what discriminates
// every version pair in this chain, and it is checked exactly.
//
// Non-function witnesses are anchored by CONTAINMENT: the identifier's terminal
// segment must appear in the package's own SQL. Weaker, and stated as weaker. A
// role name, a schema name or a constraint name is created by a statement whose
// shape varies too much to parse for the benefit of confirming a string the file
// plainly contains.

export type WitnessAnchorKind =
  | 'PACKAGE_SOURCE_MISSING'
  | 'WITNESS_NOT_CREATED_BY_ITS_PACKAGE'
  | 'WITNESS_CREATED_BY_AN_EARLIER_PACKAGE'
  | 'WITNESS_DROPPED_BY_A_LATER_PACKAGE'
  | 'REQUIRED_ABSENCE_NOT_DROPPED'
  | 'UNDECLARED_REQUIRED_ABSENCE'
  | 'WITNESS_ABSENT_FROM_SOURCE'

export interface WitnessAnchorProblem {
  readonly kind: WitnessAnchorKind
  readonly packageId: string
  readonly witness: string
  readonly detail: string
}

/** A function declaration as the canonical SQL writes it. */
interface DeclaredFunction {
  readonly qualifiedName: string
  readonly arity: number
}

/**
 * The declaration SURFACE of a package: comments and function BODIES removed.
 *
 * Bodies have to go. `stella_0015` names the two-argument bind inside a plpgsql
 * body that raises U0106, and counting that as a CREATE would make the drop of
 * the same signature look like a contradiction. Comments have to go for the
 * mirror reason: this file's own prose quotes signatures it does not declare.
 */
function declarationSurface(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const opener = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
    if (opener === null) {
      out += sql.slice(i)
      break
    }
    const start = i + opener.index
    out += sql.slice(i, start)
    const tag = opener[0]
    const end = sql.indexOf(tag, start + tag.length)
    if (end === -1) break // unterminated: the remainder is body, and body is dropped
    out += ' $BODY$ '
    i = end + tag.length
  }
  return out.replace(/--[^\n]*/g, ' ')
}

/** Top-level comma count. Nested parens and array brackets do not separate. */
function arityOf(args: string): number {
  const trimmed = args.trim()
  if (trimmed === '') return 0
  let depth = 0
  let n = 1
  for (const ch of trimmed) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) n++
  }
  return n
}

function scanDeclarations(sql: string, verb: RegExp): DeclaredFunction[] {
  const surface = declarationSurface(sql)
  const found: DeclaredFunction[] = []
  const re = new RegExp(verb.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(surface)) !== null) {
    const afterVerb = m.index + m[0].length
    const open = surface.indexOf('(', afterVerb)
    if (open === -1) continue
    const name = surface.slice(afterVerb, open).trim().toLowerCase()
    if (!/^[a-z_][a-z0-9_$]*\.[a-z_][a-z0-9_$]*$/.test(name)) continue
    let depth = 0
    let close = -1
    for (let k = open; k < surface.length; k++) {
      if (surface[k] === '(') depth++
      else if (surface[k] === ')') {
        depth--
        if (depth === 0) {
          close = k
          break
        }
      }
    }
    if (close === -1) continue
    found.push({ qualifiedName: name, arity: arityOf(surface.slice(open + 1, close)) })
  }
  return found
}

const CREATE_FUNCTION = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+/
const DROP_FUNCTION = /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?/

/** `schema.name(args)` -> `schema.name` + arity, or null when it is not one. */
function signatureOf(identifier: string): DeclaredFunction | null {
  const open = identifier.indexOf('(')
  if (open === -1 || !identifier.endsWith(')')) return null
  return {
    qualifiedName: identifier.slice(0, open).trim().toLowerCase(),
    arity: arityOf(identifier.slice(open + 1, -1)),
  }
}

const same = (a: DeclaredFunction, b: DeclaredFunction): boolean =>
  a.qualifiedName === b.qualifiedName && a.arity === b.arity

/**
 * Every way the registry can disagree with the corpus, in one pass.
 *
 * `readSql` takes a PACKAGE NAME rather than a path so the gate cannot be
 * satisfied by pointing it at a directory of convenient files; the caller
 * resolves `db/prepared/<name>.sql` exactly as the runner does.
 */
export function anchorWitnessesToCanonicalSql(
  readSql: (packageId: string) => string | null,
  registry: Readonly<Record<string, PackageWitnesses>> = PACKAGE_WITNESSES,
  packageIds: readonly string[] = WITNESSED_PACKAGES,
): readonly WitnessAnchorProblem[] {
  const problems: WitnessAnchorProblem[] = []
  const creates = new Map<string, DeclaredFunction[]>()
  const drops = new Map<string, DeclaredFunction[]>()
  const sources = new Map<string, string>()

  for (const id of packageIds) {
    const sql = readSql(id)
    if (sql === null) {
      problems.push({
        kind: 'PACKAGE_SOURCE_MISSING',
        packageId: id,
        witness: '(all)',
        detail: `db/prepared/${id}.sql could not be read, so nothing about this package's witnesses can be checked. Unreadable is not agreed.`,
      })
      continue
    }
    sources.set(id, sql)
    creates.set(id, scanDeclarations(sql, CREATE_FUNCTION))
    drops.set(id, scanDeclarations(sql, DROP_FUNCTION))
  }

  const indexOf = (id: string): number => packageIds.indexOf(id)

  for (const id of packageIds) {
    const entry = registry[id]
    const sql = sources.get(id)
    if (entry === undefined || sql === undefined) continue
    const myCreates = creates.get(id) ?? []
    const myDrops = drops.get(id) ?? []
    const mine = indexOf(id)

    for (const w of entry.requiredPresentWhenInstalled) {
      const key = `${w.kind}:${w.identifier}`
      if (w.kind !== 'regprocedure') {
        const terminal = w.identifier.split('.').pop() ?? w.identifier
        if (!sql.includes(terminal)) {
          problems.push({
            kind: 'WITNESS_ABSENT_FROM_SOURCE',
            packageId: id,
            witness: key,
            detail: `${terminal} does not appear anywhere in db/prepared/${id}.sql, so this package does not create the object the witness claims identifies it.`,
          })
        }
        continue
      }

      const sig = signatureOf(w.identifier)
      if (sig === null) {
        problems.push({
          kind: 'WITNESS_ABSENT_FROM_SOURCE',
          packageId: id,
          witness: key,
          detail: `${w.identifier} carries no argument list, so it names a FUNCTION rather than a VERSION of one.`,
        })
        continue
      }

      if (!myCreates.some((c) => same(c, sig))) {
        problems.push({
          kind: 'WITNESS_NOT_CREATED_BY_ITS_PACKAGE',
          packageId: id,
          witness: key,
          detail: `db/prepared/${id}.sql creates no ${sig.qualifiedName} of arity ${sig.arity}. A positive witness the package does not create cannot witness that the package ran. It creates: ${myCreates.map((c) => `${c.qualifiedName}/${c.arity}`).join(', ') || 'no functions'}.`,
        })
      }

      // EARLIER, not "any other". A successor re-creating the same signature is
      // the designed behaviour of stella_0016 and stella_0018; a PREDECESSOR
      // creating it is what makes the witness fire before its package ran.
      for (const other of packageIds) {
        if (other === id) continue
        const oi = indexOf(other)
        if (oi >= 0 && oi < mine && (creates.get(other) ?? []).some((c) => same(c, sig))) {
          problems.push({
            kind: 'WITNESS_CREATED_BY_AN_EARLIER_PACKAGE',
            packageId: id,
            witness: key,
            detail: `${other} already creates ${sig.qualifiedName}/${sig.arity}, so this witness would report ${id} installed as soon as its predecessor was. THIS IS THE settle_reserved_quota TRAP: five arguments in stella_0016, ten in stella_0017, and stella_0017 re-creates the five-argument one too.`,
          })
        }
        if (oi >= 0 && oi > mine && (drops.get(other) ?? []).some((d) => same(d, sig))) {
          problems.push({
            kind: 'WITNESS_DROPPED_BY_A_LATER_PACKAGE',
            packageId: id,
            witness: key,
            detail: `${other} DROPS ${sig.qualifiedName}/${sig.arity}, so a correctly installed ${id} would flip to ABSENT the moment ${other} landed.`,
          })
        }
      }
    }

    for (const w of entry.requiredAbsentWhenInstalled) {
      const key = `${w.kind}:${w.identifier}`
      const sig = w.kind === 'regprocedure' ? signatureOf(w.identifier) : null
      if (sig === null) continue
      if (!myDrops.some((d) => same(d, sig))) {
        problems.push({
          kind: 'REQUIRED_ABSENCE_NOT_DROPPED',
          packageId: id,
          witness: key,
          detail: `db/prepared/${id}.sql drops no ${sig.qualifiedName} of arity ${sig.arity}. A required ABSENCE the package does not itself produce is a condition on somebody else's database.`,
        })
      }
    }

    // COMPLETENESS, the direction a deletion would otherwise pass unnoticed.
    // Every signature this package removes from an EARLIER package, and does not
    // re-create, is an absence the classifier must know about — otherwise
    // "old and new coexisting" reads as INSTALLED instead of INCONSISTENT.
    const declaredAbsences = entry.requiredAbsentWhenInstalled
      .map((w) => signatureOf(w.identifier))
      .filter((s): s is DeclaredFunction => s !== null)

    for (const dropped of myDrops) {
      if (myCreates.some((c) => same(c, dropped))) continue // dropped and re-created
      const createdEarlier = packageIds.some(
        (other) => indexOf(other) < mine && (creates.get(other) ?? []).some((c) => same(c, dropped)),
      )
      if (!createdEarlier) continue
      if (!declaredAbsences.some((a) => same(a, dropped))) {
        problems.push({
          kind: 'UNDECLARED_REQUIRED_ABSENCE',
          packageId: id,
          witness: `regprocedure:${dropped.qualifiedName}/${dropped.arity}`,
          detail: `${id} DROPS ${dropped.qualifiedName}/${dropped.arity}, which an earlier package created, and does not re-create it — yet requiredAbsentWhenInstalled does not mention it. Without that entry a database where the old signature still stands classifies as INSTALLED rather than INCONSISTENT.`,
        })
      }
    }
  }

  return problems
}

// db/hosted/baseline-scanner.ts
// TRAIN 5C0 — Phase 3/4/6. Derives STRUCTURAL FACTS from a baseline SQL unit.
//
// ---------------------------------------------------------------------------
// WHY A SCANNER AND NOT 42 HAND-WRITTEN ROWS IN THE MANIFEST
// ---------------------------------------------------------------------------
// A manifest that only pins SHA-256 answers "did this file change?" and nothing
// else. It cannot answer "did this file start naming service_role?", because the
// moment somebody edits the file AND updates the pin — which is the normal,
// legitimate way to change a migration — the hash stops objecting and every
// semantic claim the manifest made about that file silently becomes a claim
// about a file that no longer exists.
//
// So the split is deliberate:
//
//   the HASH pins the bytes         -> catches an unannounced edit
//   the SCANNER derives the meaning -> catches an ANNOUNCED edit that changes
//                                      a property the provisioning contract
//                                      depends on
//
// The manifest pins the EXPECTED scan result. Updating a hash is easy; updating
// a hash *and* a `usesServiceRole: false` to `true` is a diff a reviewer sees.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT
// ---------------------------------------------------------------------------
// Not a SQL parser. It is a conservative lexical scanner, and every heuristic
// below errs toward REPORTING a dependency rather than missing one: a false
// positive costs a manifest line explaining why it is acceptable, a false
// negative costs an unreviewed superuser dependency reaching a hosted apply.

import { sha256OfSql } from './hosted-package-manifest'

/** Managed-Supabase compatibility, as classified by Phase 6. */
export type BaselineManagedClass =
  /** A — applies unchanged on managed Supabase. */
  | 'A-hosted-compatible'
  /** B — applies unchanged, but only because a Supabase-provided object exists. */
  | 'B-hosted-compatible-given-supabase'
  /** C — needs an adaptation or a wrapper before it can be applied. */
  | 'C-requires-adaptation'
  /** D — must never run against a new staging project. */
  | 'D-must-not-run-on-new-staging'

/** Phase 5 data classification. Drives the "cero datos productivos" gate. */
export type BaselineDmlClass =
  /** No DML at all. */
  | 'none'
  /**
   * DML whose row set is derived by SELECT from tables in the same database.
   * On an EMPTY database it necessarily affects zero rows. This is the only DML
   * class the first hosted provisioning is allowed to carry.
   */
  | 'structural-backfill'
  /** Universal reference data (ODS, IRIS+ …). Not org-scoped, not personal. */
  | 'global-catalog'
  /** A fixture: invented rows that exist to make a test pass. */
  | 'fixture'
  /** A development seed. */
  | 'development-seed'
  /** Rows copied from, or describing, a real tenant. Always refused. */
  | 'production-data'

/** How a unit behaves on a second application. */
export type BaselineReapplyClass =
  /** Safe to run again; converges. */
  | 'idempotent'
  /** Running it again raises. Must be probed and skipped, never retried blindly. */
  | 'refuses-on-reapply'
  /** Running it again would undo something. Never re-run. */
  | 'destructive-on-reapply'

/**
 * The facts a scan derives. Every field is something the provisioning contract
 * or a gate actually consumes — this is not a general-purpose SQL report.
 */
export interface BaselineScanFacts {
  /** Names `service_role` ANYWHERE outside a comment. */
  readonly usesServiceRole: boolean
  /** Names `service_role` as the GRANTEE of a GRANT. The shape that confers. */
  readonly grantsToServiceRole: boolean
  readonly usesAnon: boolean
  readonly usesAuthenticated: boolean
  /** References schema `auth` (auth.uid(), auth.users, …) outside a comment. */
  readonly referencesAuthSchema: boolean
  /** References schema `storage`. Supabase-only. */
  readonly referencesStorageSchema: boolean
  /** Statements that require a role attribute managed Supabase never grants. */
  readonly superuserDependencies: readonly string[]
  /** CREATE/ALTER/DROP ROLE — the baseline is expected to have none. */
  readonly roleStatements: readonly string[]
  /** OWNER TO — the baseline is expected to have none. */
  readonly ownershipStatements: readonly string[]
  /** CREATE EXTENSION — the baseline is expected to have none. */
  readonly extensionStatements: readonly string[]
  /** Tables this unit creates. Unqualified names are reported as `public.x`. */
  readonly tablesCreated: readonly string[]
  /** Tables switched to RLS by this unit. */
  readonly rlsEnabledTables: readonly string[]
  readonly policiesCreated: readonly string[]
  readonly policiesDropped: readonly string[]
  readonly functionsCreated: readonly string[]
  readonly securityDefinerFunctions: readonly string[]
  /** `SET search_path = …` values attached to a function, in order. */
  readonly searchPathSettings: readonly string[]
  readonly triggersCreated: readonly string[]
  /** Top-level DML verbs found (INSERT/UPDATE/DELETE/COPY/TRUNCATE/MERGE). */
  readonly dmlStatements: readonly string[]
  /** A DML statement whose rows come from a VALUES list, i.e. literal data. */
  readonly literalRowSources: readonly string[]
  /** CREATE POLICY with no matching earlier DROP POLICY IF EXISTS. */
  readonly unguardedPolicyCreates: readonly string[]
  /** Any other statement that would raise on a second application. */
  readonly unguardedDdl: readonly string[]
  /**
   * SHA-256 over the ACCESS-CONTROL SUBSTANCE of the unit: every policy's
   * USING / WITH CHECK predicate and every SECURITY DEFINER function's body,
   * normalized and concatenated in order.
   *
   * ---------------------------------------------------------------------
   * WHY COUNTING WAS NOT ENOUGH
   * ---------------------------------------------------------------------
   * Adversarial review B broke the original design with one edit. Change
   *
   *     CREATE POLICY users_update_own ON users USING (id = auth.uid())
   *
   * to `USING (true)`, or change `current_user_is_super_admin()`'s body from
   * `SELECT COALESCE((SELECT is_super_admin …), false)` to `SELECT true` — and
   * every pinned field stays identical. `policiesCreatedCount`, unchanged.
   * `securityDefinerCount`, unchanged. `searchPathSettings`, unchanged.
   * `referencesAuthSchema`, still true, because `auth.uid()` appears dozens of
   * other times in the same 765-line file. Only the file SHA moves, which is
   * mechanical and expected for ANY edit — so the reviewer updating the pin sees
   * nothing to object to, and every authenticated user is now a super admin.
   *
   * The whole premise of the hash/scan split was that an ANNOUNCED edit which
   * changes what a unit DOES produces a second, separate signal. For counts it
   * did. For predicates and bodies — the only part of an RLS corpus that decides
   * who can read what — it did not. This digest is that signal.
   */
  readonly securitySurfaceDigest: string
  /** The inputs to the digest, so a mismatch can be diffed instead of guessed. */
  readonly securitySurface: readonly string[]
}

/** Strips line comments and block comments. Used before every lexical test. */
export function stripSqlComments(sql: string): string {
  // Order matters: block comments first, because a `--` inside a block comment
  // is not a line comment, and removing lines first would leave the block's
  // opener dangling.
  const withoutBlocks = sql.replace(/\/\*[\s\S]*?\*\//g, ' ')
  return withoutBlocks.replace(/--[^\n]*/g, '')
}

/**
 * Strips comments, single-quoted literals AND dollar-quoted bodies.
 *
 * The form every lexical test over this corpus actually needs. A test that only
 * strips comments reads DATA as CODE, and this repository has now been bitten by
 * that twice in the same programme:
 *
 *   - the unit-41 splitter routed a whole helper into the managed half because a
 *     `RAISE WARNING 'outside storage.objects context'` mentioned the table;
 *   - the journal wrapper's transaction-control guard refused three units
 *     because `END;` CLOSES A PL/pgSQL BLOCK and, at top level, `END;` is a
 *     synonym for COMMIT. Same characters, opposite meaning, decided entirely by
 *     whether they sit inside a dollar-quoted body.
 *
 * So the stripping is shared rather than re-derived per caller — the second
 * re-derivation is where the two versions diverge.
 */
export function stripSqlLiteralsAndBodies(sql: string): string {
  return stripSqlComments(sql)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1?\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, ' ')
}

/**
 * Splits into statements, honouring `$$`-quoted bodies.
 *
 * A naive split on `;` tears every plpgsql function in half, and the halves then
 * look like unguarded DDL. Dollar quoting is the only quoting form the baseline
 * uses for bodies, and the tags are all bare `$$`.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = []
  let buffer = ''
  /** The OPEN tag, e.g. `$$` or `$migrate$`. Null when not inside one. */
  let openTag: string | null = null
  let inSingle = false

  // Tags are matched GENERICALLY rather than assumed to be bare `$$`.
  // Adversarial review B: the corpus uses only `$$` today, but "no current
  // source does" is an observation, not an invariant. A `DO $migrate$ … $migrate$`
  // block would be shredded at its internal semicolons by a `$$`-only splitter,
  // and every per-statement detector below would then run on garbled fragments —
  // silently miscounting the unguarded-DDL and unguarded-policy tripwires the
  // manifest leans on for its reapply classification.
  const TAG = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/

  for (let i = 0; i < sql.length; i += 1) {
    if (openTag !== null) {
      // Inside a dollar-quoted body: only the MATCHING tag closes it.
      if (sql.startsWith(openTag, i)) {
        buffer += openTag
        i += openTag.length - 1
        openTag = null
        continue
      }
      buffer += sql[i]
      continue
    }

    if (!inSingle && sql[i] === '$') {
      const match = TAG.exec(sql.slice(i))
      if (match) {
        openTag = match[0]
        buffer += openTag
        i += openTag.length - 1
        continue
      }
    }

    const ch = sql[i]
    if (ch === "'") inSingle = !inSingle
    if (ch === ';' && !inSingle) {
      if (buffer.trim()) out.push(buffer.trim())
      buffer = ''
      continue
    }
    buffer += ch
  }
  if (buffer.trim()) out.push(buffer.trim())
  return out
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Statement shapes that raise on a second application.
 *
 * `ADD CONSTRAINT` has no `IF NOT EXISTS` in PostgreSQL at all, so it is listed
 * unconditionally: a re-apply of a unit that adds one WILL raise 42710, and the
 * manifest has to say so rather than let an operator discover it mid-chain.
 */
const UNGUARDED_DDL_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE TABLE without IF NOT EXISTS'],
  [/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE INDEX without IF NOT EXISTS'],
  [/^CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE SCHEMA without IF NOT EXISTS'],
  [/^CREATE\s+TYPE\s+/i, 'CREATE TYPE (no IF NOT EXISTS in PostgreSQL)'],
  [/^ALTER\s+TABLE\s+[^;]*\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i, 'ADD COLUMN without IF NOT EXISTS'],
  [/^ALTER\s+TABLE\s+[^;]*\bADD\s+CONSTRAINT\s+/i, 'ADD CONSTRAINT (no IF NOT EXISTS in PostgreSQL)'],
]

/**
 * Role attributes managed Supabase will not grant, plus the two session-level
 * escapes that would let a package sidestep RLS or replication triggers.
 *
 * `rolsuper` is included as a READ too: a package that branches on it is a
 * package whose behaviour differs between local and hosted, which is exactly
 * the class of difference Train 5A had to measure the hard way.
 */
const SUPERUSER_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\brolsuper\b/i, 'reads pg_roles.rolsuper'],
  [/\bSUPERUSER\b/i, 'names SUPERUSER'],
  [/\bBYPASSRLS\b/i, 'names BYPASSRLS'],
  [/\bCREATEDB\b/i, 'names CREATEDB'],
  [/\bCREATEROLE\b/i, 'names CREATEROLE'],
  [/\bsession_replication_role\b/i, 'sets session_replication_role'],
  [/\bALTER\s+SYSTEM\b/i, 'ALTER SYSTEM'],
  [/\bpg_catalog\.\w+\s*(?:SET|INSERT|UPDATE|DELETE)/i, 'writes pg_catalog'],
  // Added after adversarial review A constructed four superuser/ownership
  // dependencies this list reported clean. None exists in the corpus today —
  // that was verified — so these are tripwires rather than fixes, and the
  // header's claim that the scanner "errs toward REPORTING a dependency" was
  // simply not true of them before.
  [/\bCREATE\s+EVENT\s+TRIGGER\b/i, 'CREATE EVENT TRIGGER (superuser-only, and matches no ordinary trigger pattern)'],
  [/\bFROM\s+PROGRAM\b/i, 'COPY … FROM PROGRAM (executes a shell command as the server user)'],
  [/\bTO\s+PROGRAM\b/i, 'COPY … TO PROGRAM'],
  [/\bREASSIGN\s+OWNED\b/i, 'REASSIGN OWNED (transfers ownership without the string OWNER TO)'],
  [/\bDROP\s+OWNED\b/i, 'DROP OWNED'],
  [/\bGRANT\b[^;]*\bpg_[a-z_]+\b[^;]*\bTO\b/i, 'GRANT of a pg_* predefined role'],
  [/\bSECURITY\s+LABEL\b/i, 'SECURITY LABEL'],
  [/\bCREATE\s+(?:TRUSTED\s+)?(?:PROCEDURAL\s+)?LANGUAGE\b/i, 'CREATE LANGUAGE'],
  [/\bCREATE\s+(?:FOREIGN\s+DATA\s+WRAPPER|SERVER|USER\s+MAPPING|SUBSCRIPTION|PUBLICATION)\b/i, 'creates a foreign-data / replication object'],
]

export function scanBaselineSql(sql: string): BaselineScanFacts {
  const normalized = sql.replace(/\r\n?/g, '\n')
  const code = stripSqlComments(normalized)
  const statements = splitSqlStatements(code).map(collapse)

  const superuserDependencies: string[] = []
  for (const [pattern, label] of SUPERUSER_PATTERNS) {
    if (pattern.test(code)) superuserDependencies.push(label)
  }

  const roleStatements = statements.filter((s) => /^(CREATE|ALTER|DROP)\s+ROLE\b/i.test(s))
  const ownershipStatements = statements.filter((s) => /\bOWNER\s+TO\b/i.test(s))
  const extensionStatements = statements.filter((s) => /^(CREATE|DROP)\s+EXTENSION\b/i.test(s))

  const tablesCreated: string[] = []
  const rlsEnabledTables: string[] = []
  const policiesCreated: string[] = []
  const policiesDropped: string[] = []
  const functionsCreated: string[] = []
  const securityDefinerFunctions: string[] = []
  const searchPathSettings: string[] = []
  const triggersCreated: string[] = []
  const dmlStatements: string[] = []
  const literalRowSources: string[] = []
  const unguardedPolicyCreates: string[] = []
  const unguardedDdl: string[] = []
  const securitySurface: string[] = []

  // Policy guarding is ORDER-SENSITIVE: a DROP that appears after the CREATE
  // does not protect it. So the set is built as the scan walks forward.
  const droppedSoFar = new Set<string>()

  // Unqualified identifiers are `public` here without exception: the baseline
  // creates nothing outside public, and a scanner that guessed a search_path
  // would be inventing the very fact the postconditions are meant to check.
  const qualify = (name: string): string => (name.includes('.') ? name : `public.${name}`)

  for (const statement of statements) {
    const created = statement.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w.]+)"?/i)
    if (created) tablesCreated.push(qualify(created[1]))

    const rls = statement.match(/^ALTER\s+TABLE\s+"?([\w.]+)"?[^;]*\bENABLE\s+ROW\s+LEVEL\s+SECURITY/i)
    if (rls) rlsEnabledTables.push(qualify(rls[1]))

    const dropPolicy = statement.match(/^DROP\s+POLICY\s+IF\s+EXISTS\s+"?([^"\s]+)"?\s+ON\s+"?([\w.]+)"?/i)
    if (dropPolicy) {
      const key = `${qualify(dropPolicy[2])}.${dropPolicy[1]}`
      droppedSoFar.add(key)
      policiesDropped.push(key)
      continue
    }

    const createPolicy = statement.match(/^CREATE\s+POLICY\s+"?([^"\s]+)"?\s+ON\s+"?([\w.]+)"?/i)
    if (createPolicy) {
      const key = `${qualify(createPolicy[2])}.${createPolicy[1]}`
      policiesCreated.push(key)
      if (!droppedSoFar.has(key)) unguardedPolicyCreates.push(key)
      // The PREDICATE, not just the name. Everything from the first USING or
      // WITH CHECK to the end of the statement — including both when a policy
      // carries both, and including the TO clause, since narrowing `TO
      // authenticated` to `TO public` is the same class of change.
      const predicate = statement.slice(statement.search(/\b(TO|USING|WITH\s+CHECK)\b/i))
      securitySurface.push(`policy ${key} :: ${predicate}`)
      continue
    }

    const fn = statement.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?([\w.]+)"?/i)
    if (fn) {
      if (/\bSECURITY\s+DEFINER\b/i.test(statement)) {
        // The BODY. A SECURITY DEFINER function runs with its owner's rights, so
        // its body is access-control substance in exactly the way a policy
        // predicate is: `SELECT COALESCE((SELECT is_super_admin …), false)` and
        // `SELECT true` are the same function by every count the scanner used to
        // report.
        const body = statement.slice(statement.indexOf('$$'))
        securitySurface.push(`definer ${qualify(fn[1])} :: ${body}`)
      }
      // Qualified, like the tables and policies above. The corpus is
      // inconsistent — 0031 writes `current_user_is_super_admin()` bare while
      // the Supabase units write `public.can_read_evidence_object` — and a
      // postcondition comparing this list against pg_proc, which always reports
      // a schema, would silently miss every bare name.
      functionsCreated.push(qualify(fn[1]))
      if (/\bSECURITY\s+DEFINER\b/i.test(statement)) securityDefinerFunctions.push(fn[1])
      const sp = statement.match(/\bSET\s+search_path\s*(?:=|TO)\s*('[^']*'|[\w$, ]+?)(?=\s+(?:AS|LANGUAGE|SECURITY|STABLE|VOLATILE|IMMUTABLE|RETURNS)\b|\s*\$\$)/i)
      if (sp) searchPathSettings.push(collapse(sp[1]))
      continue
    }

    const trg = statement.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?([\w.]+)"?/i)
    if (trg) {
      triggersCreated.push(trg[1])
      continue
    }

    if (/^(INSERT|UPDATE|DELETE|COPY|TRUNCATE|MERGE)\b/i.test(statement)) {
      dmlStatements.push(statement.slice(0, 160))
      // A VALUES list is literal data. An INSERT ... SELECT derives its rows from
      // the database itself, which on an empty database means zero rows — the
      // distinction Phase 5 turns on.
      if (/\bVALUES\s*\(/i.test(statement)) literalRowSources.push(statement.slice(0, 160))
      continue
    }

    for (const [pattern, label] of UNGUARDED_DDL_PATTERNS) {
      if (pattern.test(statement)) {
        unguardedDdl.push(`${label} :: ${statement.slice(0, 100)}`)
        break
      }
    }
  }

  return {
    usesServiceRole: /\bservice_role\b/.test(code),
    grantsToServiceRole: /\bGRANT\b[^;]*\bTO\b[^;]*\bservice_role\b/i.test(code),
    usesAnon: /\banon\b/.test(code),
    usesAuthenticated: /\bauthenticated\b/.test(code),
    referencesAuthSchema: /\bauth\.\w/.test(code),
    referencesStorageSchema: /\bstorage\.\w/.test(code),
    superuserDependencies,
    roleStatements,
    ownershipStatements,
    extensionStatements,
    tablesCreated,
    rlsEnabledTables,
    policiesCreated,
    policiesDropped,
    functionsCreated,
    securityDefinerFunctions,
    searchPathSettings,
    triggersCreated,
    dmlStatements,
    literalRowSources,
    unguardedPolicyCreates,
    unguardedDdl,
    securitySurface,
    securitySurfaceDigest: sha256OfSql(securitySurface.join('\n')),
  }
}

/**
 * SHA-256 over LF-normalized text.
 *
 * Imported from the hosted manifest rather than reimplemented: two hashing
 * helpers that normalize newlines slightly differently would pin the same file
 * to two different digests, and the disagreement would only surface on a CRLF
 * checkout — which is to say, on Lorenzo's machine and nowhere in CI.
 */
export { sha256OfSql as sha256OfBaselineSql }

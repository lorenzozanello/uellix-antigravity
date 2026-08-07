// db/hosted/storage-policy-artifact.ts
// TRAIN 5C2 — Phase C. Unit 41, split deterministically into the half psql may
// apply and the half a managed channel must.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Measured against Uellix Staging, in the identity that will apply the baseline:
//
//     current_user = postgres, session_user = postgres
//     MEMBER = false   USAGE = false   SET = false     (supabase_storage_admin)
//
// No membership at all, in any grade. `CREATE POLICY` requires ownership of the
// table, `storage.objects` is owned by `supabase_storage_admin`, and the applying
// role cannot become it. The SET ROLE path is not "unproven" — it is refuted by
// the catalogue, which is a stronger statement than a failed attempt would be.
//
// So unit 41 cannot run whole through psql. It splits.
//
// ---------------------------------------------------------------------------
// HOW THE SPLIT IS DECIDED, AND WHY NOT BY LINE NUMBER
// ---------------------------------------------------------------------------
// By STATEMENT, on one semantic predicate: does the statement reference
// `storage.objects`? If yes it belongs to PART B; if no, to PART A.
//
// The obvious alternative — cut at the `-- STORAGE POLICIES` banner — anchors a
// security boundary on a comment. A reformatting that moved the banner would
// silently move the boundary, and the two halves would still look plausible.
// The predicate cannot be moved by reformatting: a statement either names the
// table the platform owns or it does not.
//
// ---------------------------------------------------------------------------
// ONE SOURCE, TWO DERIVATIONS, NO THIRD COPY
// ---------------------------------------------------------------------------
// `supabase/migrations/20260716000001_storage_policies.sql` stays byte-identical
// and remains the only place the SQL is authored. Both artefacts are generated
// from it. The operator never writes SQL — they run a file whose hash was
// checked against the source it came from.

import { sha256OfSql } from './hosted-package-manifest'
import { scanBaselineSql, stripSqlComments } from './baseline-scanner'

/** The canonical source. There is no other. */
export const STORAGE_UNIT_SOURCE = 'supabase/migrations/20260716000001_storage_policies.sql'

/** Where the two derivations are written. Checked in so a reviewer can read them. */
export const STORAGE_ARTEFACT_DIR = 'db/prepared/storage'
export const PSQL_ARTEFACT = `${STORAGE_ARTEFACT_DIR}/20260716000001_part_a_helpers.psql.sql`
export const MANAGED_ARTEFACT = `${STORAGE_ARTEFACT_DIR}/20260716000001_part_b_policies.managed.sql`

/**
 * Splits raw SQL into statements, PRESERVING the original text of each —
 * comments, indentation and all.
 *
 * `splitSqlStatements` in the scanner strips comments first, which is right for
 * analysis and wrong here: the artefacts have to be readable by the human who
 * runs them, and a policy stripped of the comment explaining it is a policy
 * nobody reviews.
 */
export function splitPreservingText(sql: string): string[] {
  const normalized = sql.replace(/\r\n?/g, '\n')
  const out: string[] = []
  let start = 0
  let openTag: string | null = null
  let inSingle = false
  let inLineComment = false
  const TAG = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/

  for (let i = 0; i < normalized.length; i += 1) {
    if (inLineComment) {
      if (normalized[i] === '\n') inLineComment = false
      continue
    }
    if (openTag !== null) {
      if (normalized.startsWith(openTag, i)) {
        i += openTag.length - 1
        openTag = null
      }
      continue
    }
    if (!inSingle && normalized.startsWith('--', i)) {
      inLineComment = true
      i += 1
      continue
    }
    if (!inSingle && normalized[i] === '$') {
      const match = TAG.exec(normalized.slice(i))
      if (match) {
        openTag = match[0]
        i += openTag.length - 1
        continue
      }
    }
    if (normalized[i] === "'") inSingle = !inSingle
    if (normalized[i] === ';' && !inSingle) {
      out.push(normalized.slice(start, i + 1))
      start = i + 1
    }
  }
  const tail = normalized.slice(start)
  if (tail.trim()) out.push(tail)
  return out
}

/**
 * PART B is exactly the statements that name the table the platform owns.
 *
 * ---------------------------------------------------------------------------
 * QUOTE-AWARE, AND STRING-LITERAL-AWARE, BECAUSE BOTH WERE EXPLOITABLE
 * ---------------------------------------------------------------------------
 * Adversarial review broke the first version twice, and both attacks are
 * cosmetic edits that a reviewer would wave through:
 *
 *   1. `ON "storage"."objects"` — semantically identical, and
 *      /\bstorage\.objects\b/ does not match it, because the character after
 *      `storage` is a quote. The four DROP POLICY statements would land in PART
 *      A, psql would try to execute them, and the permission error would roll
 *      back the WHOLE PART A transaction — taking the two helpers 0039 depends
 *      on with it. A cosmetic reformat turning into a full apply failure, in the
 *      one function whose header claims reformatting cannot move the boundary.
 *
 *   2. A STRING LITERAL mentioning the table, e.g.
 *      `RAISE WARNING 'outside storage.objects context'` inside a helper's body,
 *      pulls that whole function into PART B. Comments are stripped; literals
 *      were not. The helper would then exist only in the human-run artefact and
 *      0039 would fail with 42883 — the exact defect this programme already
 *      found once.
 *
 * So: strip comments AND string literals AND dollar-quoted bodies first, then
 * normalise `"storage"."objects"` to `storage.objects` before matching.
 */
export function belongsToManagedPart(statementText: string): boolean {
  const code = stripSqlComments(statementText)
    // Dollar-quoted bodies and single-quoted literals are DATA, not references.
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1?\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, ' ')
    // `"storage" . "objects"` -> `storage.objects`
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
    .replace(/\s*\.\s*/g, '.')
  return /\bstorage\.objects\b/i.test(code)
}

export interface StorageArtefacts {
  /** PART A — the two public helpers and their grants. psql applies this. */
  readonly psqlSql: string
  /** PART B — the four DROP and three CREATE POLICY. A managed channel applies this. */
  readonly managedSql: string
  readonly sourceSha256: string
  readonly psqlSha256: string
  readonly managedSha256: string
  /** Digest over PART B's policy predicates. The security surface, pinned. */
  readonly managedSecuritySurfaceDigest: string
  readonly statementCounts: {
    readonly total: number
    readonly partA: number
    readonly partB: number
  }
}

const BANNER = (title: string, body: readonly string[]): string =>
  ['-- ' + '='.repeat(76), `-- ${title}`, ...body.map((l) => `-- ${l}`), '-- ' + '='.repeat(76), ''].join('\n')

/**
 * Derives both artefacts. Pure: same input, same bytes, every time.
 *
 * Refuses rather than guessing when the source stops looking like what the
 * adaptation was designed against. A source that changed shape needs a human to
 * look at it, not a generator that produces two plausible halves of something
 * else.
 */
export function buildStorageArtefacts(source: string): StorageArtefacts {
  const normalized = source.replace(/\r\n?/g, '\n')
  const statements = splitPreservingText(normalized)

  const partA: string[] = []
  const partB: string[] = []
  for (const statement of statements) {
    ;(belongsToManagedPart(statement) ? partB : partA).push(statement)
  }

  const facts = scanBaselineSql(normalized)
  if (facts.functionsCreated.length !== 2) {
    throw new Error(
      `STORAGE_SPLIT_UNEXPECTED_SHAPE: PART A should define exactly the two public helpers, found ${facts.functionsCreated.length}.`,
    )
  }
  if (facts.policiesCreated.length !== 3) {
    throw new Error(
      `STORAGE_SPLIT_UNEXPECTED_SHAPE: PART B should create exactly three policies, found ${facts.policiesCreated.length}.`,
    )
  }
  if (facts.policiesCreated.some((p) => !p.startsWith('storage.objects.'))) {
    throw new Error(
      `STORAGE_SPLIT_UNEXPECTED_SHAPE: a policy moved off storage.objects (${facts.policiesCreated.join(', ')}), which changes which channel must apply it.`,
    )
  }
  if (/ALTER\s+TABLE\s+storage\.objects/i.test(stripSqlComments(normalized))) {
    throw new Error(
      'STORAGE_SPLIT_REFUSED: the source now issues ALTER TABLE storage.objects. Supabase refuses it and it is unnecessary — RLS is already enabled on that table by the platform.',
    )
  }
  // A PART A that still mentions storage.objects would mean the splitter missed
  // a statement, which is the one failure that would silently ship a blocked
  // statement down the psql channel.
  if (partA.some(belongsToManagedPart)) {
    throw new Error('STORAGE_SPLIT_LEAK: a statement naming storage.objects reached PART A.')
  }

  // VERIFY THE SPLIT PARTS, NOT ONLY THE WHOLE SOURCE.
  //
  // The guards above count against `normalized` — the unsplit file — so they are
  // blind to a statement landing in the WRONG half: the totals are unchanged
  // either way. Adversarial review used exactly that to move a helper function
  // into PART B while `functionsCreated.length === 2` still held. Counting each
  // half separately is what closes it.
  const partAFacts = scanBaselineSql(partA.join(''))
  const partBFactsCheck = scanBaselineSql(partB.join(''))
  if (partAFacts.functionsCreated.length !== 2) {
    throw new Error(
      `STORAGE_SPLIT_MISROUTED: PART A must define both public helpers, it defines ${partAFacts.functionsCreated.length}. ` +
        `0039 grants EXECUTE on both and would fail with 42883.`,
    )
  }
  if (partBFactsCheck.functionsCreated.length !== 0) {
    throw new Error(
      `STORAGE_SPLIT_MISROUTED: PART B must define no functions, it defines ${partBFactsCheck.functionsCreated.length}.`,
    )
  }
  if (partAFacts.policiesCreated.length !== 0 || partAFacts.policiesDropped.length !== 0) {
    throw new Error(
      `STORAGE_SPLIT_MISROUTED: PART A carries policy statements (${partAFacts.policiesCreated.length} created, ` +
        `${partAFacts.policiesDropped.length} dropped). psql cannot execute them and the failure would roll ` +
        `back the helpers with them.`,
    )
  }
  // The DROP side, which the CREATE-side guards never inspected. A quoted
  // `ON "storage"."objects"` used to route these four into PART A silently.
  if (partBFactsCheck.policiesDropped.length !== 4) {
    throw new Error(
      `STORAGE_SPLIT_MISROUTED: PART B must carry all four DROP POLICY statements, it carries ${partBFactsCheck.policiesDropped.length}.`,
    )
  }
  if (partBFactsCheck.policiesDropped.some((p) => !p.startsWith('storage.objects.'))) {
    throw new Error(
      `STORAGE_SPLIT_MISROUTED: a DROP POLICY names a table other than storage.objects (${partBFactsCheck.policiesDropped.join(', ')}).`,
    )
  }

  const psqlSql =
    BANNER('GENERATED — DO NOT EDIT. PART A of unit 41.', [
      `Derived from ${STORAGE_UNIT_SOURCE} by db/hosted/storage-policy-artifact.ts.`,
      'Edit the source and regenerate; a hand edit here fails `pnpm storage:verify`.',
      '',
      'This half is everything that does NOT touch storage.objects: the two',
      'public.can_*_evidence_object helpers and their REVOKE/GRANT. It applies',
      'through the ordinary psql runner because every object in it is ours.',
      '',
      '0039_grant_rls_helper_execution.sql depends on THIS half and on nothing',
      'in PART B, so the baseline order is unchanged.',
    ]) + partA.join('').trimStart()

  const managedSql =
    BANNER('GENERATED — DO NOT EDIT. PART B of unit 41.', [
      `Derived from ${STORAGE_UNIT_SOURCE} by db/hosted/storage-policy-artifact.ts.`,
      '',
      'These statements name storage.objects, which is owned by',
      'supabase_storage_admin. Measured on the applying identity:',
      '  MEMBER = false   USAGE = false   SET = false',
      'so psql cannot apply them and SET ROLE is not available. They run through',
      'a managed channel, executed by a human against a verified hash.',
      '',
      'THE OPERATOR DOES NOT WRITE THIS SQL. Run this file as generated. If it',
      'needs to change, change the canonical source and regenerate.',
      '',
      'Nothing here enables RLS: it is already enabled on storage.objects by the',
      'platform, and Supabase refuses attempts to change that.',
    ]) + partB.join('').trimStart()

  // The security surface of PART B alone — predicates and roles, not names.
  const partBFacts = scanBaselineSql(partB.join(''))

  return {
    psqlSql: psqlSql.endsWith('\n') ? psqlSql : `${psqlSql}\n`,
    managedSql: managedSql.endsWith('\n') ? managedSql : `${managedSql}\n`,
    sourceSha256: sha256OfSql(normalized),
    psqlSha256: sha256OfSql(psqlSql),
    managedSha256: sha256OfSql(managedSql),
    managedSecuritySurfaceDigest: partBFacts.securitySurfaceDigest,
    statementCounts: { total: statements.length, partA: partA.length, partB: partB.length },
  }
}

/* -------------------------------------------------------------------------- */
/* The state machine                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Unit 41 is the only unit of the fifty that can be HALF applied, so it is the
 * only one that needs more than "installed / not installed".
 *
 * The middle state is the whole point. Without it, applying PART A would leave
 * the runner with a boolean that says "unit 41: yes" while three policies that
 * gate every evidence read do not exist.
 */
export type StorageUnitState =
  /** Nothing applied. */
  | 'UNIT_41_NOT_APPLIED'
  /** PART A applied by psql. PART B outstanding. NOT complete. */
  | 'UNIT_41_HELPERS_APPLIED'
  /** PART A applied and PART B pending at the human boundary. */
  | 'UNIT_41_POLICIES_PENDING'
  /** Both halves verified present. Only this counts as unit 41 installed. */
  | 'UNIT_41_COMPLETE'

/** The three policies PART B must leave behind, by name. */
export const EXPECTED_STORAGE_POLICIES: readonly string[] = [
  'select_evidence',
  'insert_evidence',
  'delete_evidence',
]

/**
 * Derives the state from OBSERVED facts, never from an operator's claim.
 *
 * `helpersPresent` comes from pg_proc, `policiesPresent` from pg_policies. Both
 * are things the database says about itself.
 */
export function deriveStorageUnitState(observed: {
  readonly helpersPresent: boolean
  readonly policyNamesPresent: readonly string[]
  /** Has the operator been handed the artefact and not yet run it? */
  readonly boundaryOpen: boolean
}): StorageUnitState {
  const allPolicies = EXPECTED_STORAGE_POLICIES.every((p) => observed.policyNamesPresent.includes(p))
  if (!observed.helpersPresent) return 'UNIT_41_NOT_APPLIED'
  if (allPolicies) return 'UNIT_41_COMPLETE'
  return observed.boundaryOpen ? 'UNIT_41_POLICIES_PENDING' : 'UNIT_41_HELPERS_APPLIED'
}

/** Only one state counts as installed. Consumed by the runner and by B0. */
export const isStorageUnitInstalled = (state: StorageUnitState): boolean =>
  state === 'UNIT_41_COMPLETE'

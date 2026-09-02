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
  // BLOCK COMMENTS, THE THIRD PLACE A SEMICOLON HIDES.
  //
  // Adversarial review executed the first version against a source carrying
  // `/* legacy note; keep for history */` and it produced THREE statements where
  // there were two, cutting inside the comment at its internal `;`. The halves
  // were `"/* legacy note;"` and `" keep for history */ DROP POLICY … "`, and
  // the second one matched `storage.objects` while the FIRST — carrying an
  // unterminated `/*` — landed in PART A, where it would silently swallow
  // whatever followed it.
  //
  // Not exploitable against today's canonical source, which uses only `--`. That
  // is exactly the shape of the two attacks this file already absorbed: a
  // cosmetic edit, no reviewer objection, boundary moved.
  let blockDepth = 0
  const TAG = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/

  for (let i = 0; i < normalized.length; i += 1) {
    if (inLineComment) {
      if (normalized[i] === '\n') inLineComment = false
      continue
    }
    if (blockDepth > 0) {
      // PostgreSQL nests block comments; so does this.
      if (normalized.startsWith('/*', i)) {
        blockDepth += 1
        i += 1
      } else if (normalized.startsWith('*/', i)) {
        blockDepth -= 1
        i += 1
      }
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
    if (!inSingle && normalized.startsWith('/*', i)) {
      blockDepth = 1
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
  /**
   * Digest over PART A's OWN surface — the two SECURITY DEFINER helpers and
   * their grants.
   *
   * Separate from the managed digest on purpose. The journal row for unit 41
   * describes PART A, and recording PART B's digest there would pin a surface
   * that row's transaction did not create: a reader reconciling the ledger would
   * see the policy digest beside an APPLIED row and conclude the policies exist.
   * Each half is pinned by the digest of the half it is.
   */
  readonly psqlSecuritySurfaceDigest: string
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

  // HASH WHAT IS WRITTEN, NOT WHAT IT WAS BEFORE THE LAST EDIT.
  //
  // The first version returned `psqlSql.endsWith('\n') ? … : psqlSql + '\n'` as
  // the artefact and `sha256OfSql(psqlSql)` — the PRE-newline string — as its
  // hash. So the pinned hash never described the bytes on disk. Nothing noticed,
  // because `storage:verify` compares text to text and psql applies a file, not
  // a hash; the discrepancy only surfaced once the journal wrapper started
  // checking its include against the hash it records. One `\n`, and the ledger
  // would have attested a file that did not exist.
  const psqlArtefact = psqlSql.endsWith('\n') ? psqlSql : `${psqlSql}\n`
  const managedArtefact = managedSql.endsWith('\n') ? managedSql : `${managedSql}\n`

  return {
    psqlSql: psqlArtefact,
    managedSql: managedArtefact,
    sourceSha256: sha256OfSql(normalized),
    psqlSha256: sha256OfSql(psqlArtefact),
    managedSha256: sha256OfSql(managedArtefact),
    managedSecuritySurfaceDigest: partBFacts.securitySurfaceDigest,
    psqlSecuritySurfaceDigest: partAFacts.securitySurfaceDigest,
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
  /** Nothing applied. Neither half has run. */
  | 'UNIT_41_NOT_STARTED'
  /** PART A applied by psql. PART B outstanding, boundary not yet opened. */
  | 'UNIT_41_HELPERS_APPLIED'
  /** PART A applied, the boundary is open, and PART B has not landed. */
  | 'UNIT_41_POLICIES_PENDING'
  /**
   * The three policy NAMES are present and the SURFACE has not been verified.
   *
   * This is the state the instruction insisted on and the one a two-state model
   * cannot express: "PARTE B ejecutada ≠ UNIT_41_COMPLETE". A human ran
   * something through a channel we cannot observe, and three rows now exist in
   * pg_policies. What they SAY is a separate question, and until B0-16 answers
   * it the honest word is UNVERIFIED — not COMPLETE, and not FAILED either.
   */
  | 'UNIT_41_POLICIES_APPLIED_UNVERIFIED'
  /** Both halves present AND the surface verified equal to the artefact. */
  | 'UNIT_41_COMPLETE'
  /**
   * The observation contradicts itself or the contract. Never reachable by
   * doing nothing — reaching FAILED requires evidence of something wrong.
   */
  | 'UNIT_41_FAILED'

/** The three policies PART B must leave behind, by name. */
export const EXPECTED_STORAGE_POLICIES: readonly string[] = [
  'select_evidence',
  'insert_evidence',
  'delete_evidence',
]

export interface StorageUnitObservation {
  /** pg_proc: are both public.can_*_evidence_object helpers there? */
  readonly helpersPresent: boolean
  /** pg_policies, names only, on storage.objects. */
  readonly policyNamesPresent: readonly string[]
  /** A MANUAL_BOUNDARY_PENDING row exists for this project. */
  readonly boundaryOpen: boolean
  /**
   * B0-16's verdict over the FULL surface, or `null` when it has not been run.
   *
   * `null` is not "fine". It is the difference between
   * POLICIES_APPLIED_UNVERIFIED and COMPLETE, and it is the reason an operator
   * saying "done" cannot move this machine to its terminal state.
   */
  readonly surfaceVerified: boolean | null
}

/**
 * Derives the state from OBSERVED facts, never from an operator's claim.
 *
 * Every input is something the database says about itself: `pg_proc` for the
 * helpers, `pg_policies` for the names and the surface, the journal table for
 * the boundary. There is deliberately no `operatorSaysDone` parameter — the
 * transition to COMPLETE is a measurement, and adding a claim to the inputs is
 * how a measurement quietly becomes a formality.
 */
export function deriveStorageUnitState(observed: StorageUnitObservation): StorageUnitState {
  const present = EXPECTED_STORAGE_POLICIES.filter((p) => observed.policyNamesPresent.includes(p))
  const all = present.length === EXPECTED_STORAGE_POLICIES.length
  const some = present.length > 0

  // POLICIES WITHOUT HELPERS IS NOT AN EARLIER STATE — IT IS A BROKEN ONE.
  //
  // All three predicates call public.can_*_evidence_object. A policy whose
  // helper does not exist raises 42883 on every row it is evaluated against, so
  // every evidence read fails closed. Reporting that as NOT_STARTED would
  // describe a database in a state the contract says cannot exist.
  if (!observed.helpersPresent) {
    return some ? 'UNIT_41_FAILED' : 'UNIT_41_NOT_STARTED'
  }

  // A verified-FALSE surface is a measured contradiction, whatever else holds.
  // It is the `USING (true)` case, the wrong-bucket case and the extra-policy
  // case, and none of them is "pending".
  if (observed.surfaceVerified === false) return 'UNIT_41_FAILED'

  if (all) {
    return observed.surfaceVerified === true ? 'UNIT_41_COMPLETE' : 'UNIT_41_POLICIES_APPLIED_UNVERIFIED'
  }

  // PARTIAL, AFTER THE BOUNDARY CLOSED. The operator created some policies and
  // stopped — 2 of 3 is the attack this state exists for. While the boundary is
  // still open it is work in progress; once it is closed a partial surface is a
  // failure, because permissive policies OR together and a missing DELETE policy
  // is not a smaller guard, it is a different one.
  if (some) return observed.boundaryOpen ? 'UNIT_41_POLICIES_PENDING' : 'UNIT_41_FAILED'

  return observed.boundaryOpen ? 'UNIT_41_POLICIES_PENDING' : 'UNIT_41_HELPERS_APPLIED'
}

/* -------------------------------------------------------------------------- */
/* The dependency DAG, written down because the intuition is wrong            */
/* -------------------------------------------------------------------------- */

/**
 * What actually depends on what, around unit 41.
 *
 * Every edge here was checked against the SQL rather than assumed, and two of
 * them contradict the shape this programme originally planned:
 *
 *   - 0039 was believed to need "unit 41". It needs PART A. Its five
 *     GRANT EXECUTE statements name the two public helpers and nothing in the
 *     storage schema, so the human boundary does NOT have to fall before 0039
 *     and the fifty-unit order is unchanged.
 *   - the `uellix-evidence` bucket was believed to be an apply-time dependency.
 *     `storage.buckets` appears ZERO times in unit 41 — the policies filter on
 *     the bucket_id COLUMN. It is a RUNTIME prerequisite, and the probe that
 *     sat in `checkPrivileges` was refusing all fifty units over it.
 *
 * Both are the same error in different costumes: treating "mentioned in the same
 * file" as "required by".
 */
export const UNIT_41_DEPENDENCY_DAG: readonly {
  readonly from: string
  readonly to: string
  readonly kind: 'apply-time' | 'runtime' | 'verification'
  readonly why: string
}[] = [
  {
    from: 'unit-41-part-a',
    to: '0039_grant_rls_helper_execution.sql',
    kind: 'apply-time',
    why: '0039 GRANTs EXECUTE on public.can_read_evidence_object / can_write_evidence_object. Absent, 42883.',
  },
  {
    from: 'unit-41-part-a',
    to: 'unit-41-part-b',
    kind: 'apply-time',
    why: 'all three policy predicates call the helpers; a policy created first raises on every evaluation.',
  },
  {
    from: 'unit-41-part-b',
    to: 'checkpoint-b0-16',
    kind: 'verification',
    why: 'B0-16 is the only check covering a step performed through a channel the runner cannot observe.',
  },
  {
    from: 'evidence-bucket',
    to: 'evidence-runtime',
    kind: 'runtime',
    why: 'the policies compare bucket_id as a column value; nothing in the fifty units reads storage.buckets.',
  },
  {
    from: 'evidence-bucket',
    to: 'checkpoint-b0-15',
    kind: 'verification',
    why: 'B0-15 exists so a project provisioned exactly to plan cannot end with policies guarding nothing.',
  },
]

/** Edges the DAG must NOT contain. A test asserts each is absent. */
export const UNIT_41_NON_DEPENDENCIES: readonly { readonly from: string; readonly to: string; readonly why: string }[] = [
  {
    from: 'unit-41-part-b',
    to: '0039_grant_rls_helper_execution.sql',
    why: '0039 names no object in the storage schema, so the human boundary need not precede it.',
  },
  {
    from: 'evidence-bucket',
    to: 'unit-41-part-b',
    why: 'CREATE POLICY does not validate that a bucket_id it compares against exists.',
  },
]

/** Only one state counts as installed. Consumed by the runner and by B0. */
export const isStorageUnitInstalled = (state: StorageUnitState): boolean =>
  state === 'UNIT_41_COMPLETE'

/**
 * The legal transitions, enumerated so a reviewer can see there is no edge into
 * COMPLETE that does not pass through a verified surface.
 *
 * FAILED is reachable from every non-terminal state and leads nowhere: the
 * recovery table, not this machine, decides what happens next.
 */
export const STORAGE_UNIT_TRANSITIONS: Readonly<Record<StorageUnitState, readonly StorageUnitState[]>> = {
  UNIT_41_NOT_STARTED: ['UNIT_41_HELPERS_APPLIED', 'UNIT_41_FAILED'],
  UNIT_41_HELPERS_APPLIED: ['UNIT_41_POLICIES_PENDING', 'UNIT_41_FAILED'],
  UNIT_41_POLICIES_PENDING: ['UNIT_41_POLICIES_APPLIED_UNVERIFIED', 'UNIT_41_FAILED'],
  UNIT_41_POLICIES_APPLIED_UNVERIFIED: ['UNIT_41_COMPLETE', 'UNIT_41_FAILED'],
  UNIT_41_COMPLETE: [],
  UNIT_41_FAILED: [],
}

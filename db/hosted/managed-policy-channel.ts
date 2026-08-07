// db/hosted/managed-policy-channel.ts
// TRAIN 5C2 — the determination the instruction asked for: IS there a supported
// management-plane channel for policies on `storage.objects`, and what is the
// boundary if there is?
//
// ---------------------------------------------------------------------------
// THE QUESTION, AND WHY THE OBVIOUS ANSWER WAS WRONG
// ---------------------------------------------------------------------------
// Train 5C2 opened with "MANAGED_POLICY_CHANNEL = Dashboard or SQL Editor". The
// operator's measurement removed the second half: the SQL Editor runs as
// `postgres`, `supabase_storage_admin` is not in its SETtable set, and MEMBER /
// USAGE / SET are all false. So the SQL Editor is not privileged either, and the
// asymmetry reported in supabase/supabase#41126 does not reproduce here.
//
// That left ONE candidate — Dashboard → Storage → Policies — and the instruction
// was explicit that its existence is not its viability. It had to be determined
// from primary sources.
//
// ---------------------------------------------------------------------------
// WHAT THE SOURCE SAYS
// ---------------------------------------------------------------------------
// Supabase Studio is open source, and the policy editor is two files deep:
//
//   apps/studio/data/database-policies/database-policy-create-mutation.ts
//       const { sql } = pgMeta.policies.create(payload)
//       await executeSql({ projectRef, connectionString, sql, … })
//
//   apps/studio/components/interfaces/Storage/StoragePolicies/StoragePolicies.utils.ts
//       `CREATE POLICY "${name}" ON "${schema}"."${table}"`
//       `AS PERMISSIVE FOR ${command}`
//       `TO ${roles.join(', ')}`
//
// The Storage Policies UI COMPILES A FORM INTO RAW SQL and sends it through
// `executeSql` — the same helper the SQL Editor uses, against the same project
// connection. It is not a management plane. It is the SQL channel wearing a
// form, and it therefore executes in the identity we already measured.
//
// So the branch that Train 5C2 opened as "CANDIDATE" closes as REFUTED, on
// source evidence rather than on a failed attempt.
//
// ---------------------------------------------------------------------------
// WHAT IS LEFT, STATED WITHOUT INVENTING A PATH
// ---------------------------------------------------------------------------
// One residual uncertainty is real and is NOT resolvable from this repository:
// the open-source Studio is not necessarily byte-identical to the platform
// build, and the platform side of `/pg-meta/{ref}/query` is closed. The
// possibility that the hosted policy mutation is routed differently cannot be
// refuted from source — only by an attempt, which is a WRITE.
//
// That is exactly what a human boundary is for, so the boundary is redefined:
// it is not "run these three statements", it is A ONE-POLICY PROBE BY
// EXECUTION, whose outcome decides whether the channel exists at all. And
// because the outcome is unknown, the gate stays refused. `MANAGED_BOUNDARY_
// DESIGNED` is what this file produces; `MANAGED_BOUNDARY_VERIFIED` requires
// hosted evidence that does not exist yet, and no amount of design converts one
// into the other.

import { EXPECTED_STORAGE_POLICY_SURFACE } from './baseline-postconditions'
import {
  EXPECTED_STORAGE_POLICIES,
  buildStorageArtefacts,
  deriveStorageUnitState,
  splitPreservingText,
  belongsToManagedPart,
  type StorageUnitState,
} from './storage-policy-artifact'
import { stripSqlComments } from './baseline-scanner'
import { KNOWN_PRODUCTION_IDENTIFIERS } from './target-identity'

/* -------------------------------------------------------------------------- */
/* 1. The evidence, with its grade                                            */
/* -------------------------------------------------------------------------- */

/**
 * `primary` = the implementation or the platform's own measured behaviour.
 * `official-doc` = Supabase documentation.
 * `hint` = an issue or forum thread. NEVER sufficient on its own — the
 * instruction says so and #41126 is the reason: it reports an asymmetry our own
 * measurement does not reproduce.
 */
export type EvidenceGrade = 'primary' | 'official-doc' | 'hint'

export interface ChannelEvidence {
  readonly id: string
  readonly grade: EvidenceGrade
  readonly source: string
  readonly finding: string
  /** What it settles — and, where it matters, what it does NOT settle. */
  readonly bearing: string
}

export const MANAGEMENT_PLANE_EVIDENCE: readonly ChannelEvidence[] = [
  {
    id: 'studio-policy-create-is-executesql',
    grade: 'primary',
    source: 'supabase/supabase — apps/studio/data/database-policies/database-policy-create-mutation.ts',
    finding:
      'The Dashboard policy creation path is `pgMeta.policies.create(payload)` producing SQL, then ' +
      '`executeSql({ projectRef, connectionString, sql })`.',
    bearing:
      'The Dashboard does not hold a privileged policy API. It generates CREATE POLICY text and submits ' +
      'it through the same SQL execution helper the SQL Editor uses.',
  },
  {
    id: 'studio-storage-policies-emit-raw-sql',
    grade: 'primary',
    source:
      'supabase/supabase — apps/studio/components/interfaces/Storage/StoragePolicies/StoragePolicies.utils.ts',
    finding:
      'The Storage Policies UI builds `CREATE POLICY "<name>" ON "<schema>"."<table>" AS PERMISSIVE FOR ' +
      '<command> TO <roles>` by string concatenation and submits it for execution.',
    bearing:
      'Storage → Policies is a form over the same statement psql would send. Same statement, same ' +
      'executor, therefore same ownership requirement.',
  },
  {
    id: 'measured-sql-editor-identity',
    grade: 'primary',
    source: 'Operator measurement, Uellix Staging, 2026-08-07, SQL Editor',
    finding:
      'current_user=postgres, session_user=postgres, transaction_read_only=on; MEMBER / USAGE / SET ' +
      'against supabase_storage_admin are all false; supabase_storage_admin does not appear among the ' +
      'SETtable roles.',
    bearing:
      'Fixes the identity of the channel the two source findings above route through. The Dashboard ' +
      'policy editor therefore runs as a role that does not own storage.objects and cannot become the ' +
      'role that does.',
  },
  {
    id: 'docs-silent-on-channel',
    grade: 'official-doc',
    source: 'https://supabase.com/docs/guides/storage/security/access-control',
    finding:
      'Presents `create policy … on storage.objects …` as the way to control access and never states ' +
      'WHERE to run it, nor acknowledges that ownership can refuse it.',
    bearing:
      'There is no documented non-SQL channel to prefer. The absence of documentation is not permission ' +
      'and it is not a prohibition — it is why this had to be read from the implementation.',
  },
  {
    id: 'maintainer-answer-is-about-alter-table',
    grade: 'official-doc',
    source: 'supabase/supabase discussion #36611 — maintainer reply, 2025-09-18',
    finding:
      '"Due to recent permission changes on postgres platform, altering tables in storage schema is no ' +
      'longer possible. Since row level security is now enabled by default on storage.objects table, ' +
      'you can safely delete or comment out the offending statement from your migration file."',
    bearing:
      'The only official statement on this class of failure addresses ALTER TABLE. Unit 41 issues no ' +
      'ALTER TABLE — verified, and a generator guard refuses if it ever acquires one. So this answer ' +
      'does NOT cover our case, and reading it as though it did would be the substring mistake again.',
  },
  {
    id: 'issue-41126-asymmetry',
    grade: 'hint',
    source: 'supabase/supabase#41126',
    finding:
      'A user reports CREATE POLICY on storage.objects failing over a direct connection as postgres ' +
      'while the same statement succeeds in the SQL Editor. No maintainer response.',
    bearing:
      'A hint, and one our own measurement CONTRADICTS: on this project the SQL Editor is the same ' +
      'unprivileged postgres. Recorded because it was the origin of the "SQL Editor is privileged" ' +
      'assumption this train had to remove, not because it establishes anything.',
  },
  {
    id: 'no-management-api-policy-endpoint',
    grade: 'official-doc',
    source: 'https://supabase.com/docs/reference/api/introduction (Management API reference)',
    finding: 'The Management API reference lists no endpoint that creates or alters an RLS policy.',
    bearing:
      'There is no official API-shaped alternative to fall back to. postgres-meta exposes policy CRUD, ' +
      'but it compiles to SQL over the project connection — the same channel again.',
  },
]

/* -------------------------------------------------------------------------- */
/* 2. The verdicts                                                            */
/* -------------------------------------------------------------------------- */

export type ChannelVerdict =
  /** Measured or source-refuted. Will not be retried. */
  | 'REJECTED'
  /** Cannot be settled from here; needs hosted evidence. */
  | 'UNRESOLVED_REQUIRES_HOSTED_EVIDENCE'
  /** Demonstrated on the target. */
  | 'VERIFIED'

/** psql, session pooler, `postgres`. MEMBER=false USAGE=false SET=false. */
export const PSQL_SET_ROLE_PATH: ChannelVerdict = 'REJECTED'

/** SQL Editor. Same identity, same absent membership, measured 2026-08-07. */
export const SQL_EDITOR_SET_ROLE_PATH: ChannelVerdict = 'REJECTED'

/**
 * Dashboard → Storage → Policies.
 *
 * Source evidence says it is the SQL channel, which would make it REJECTED. But
 * the platform build is closed and the refutation is an inference over an
 * open-source repository, not a measurement of the deployed service. Calling it
 * REJECTED would claim a measurement we did not take; calling it CANDIDATE would
 * ignore two primary sources. UNRESOLVED is the accurate word, and it blocks
 * exactly as hard as REJECTED does.
 */
export const MANAGEMENT_PLANE_PATH: ChannelVerdict = 'UNRESOLVED_REQUIRES_HOSTED_EVIDENCE'

/**
 * FALSE, AND STRUCTURALLY UNABLE TO BECOME TRUE.
 *
 * The instruction: "SET_ROLE_PATH_VERIFIED = false. No debe poder cambiar a
 * true." A mutable boolean somewhere would satisfy the letter and not the
 * intent, because the next train would find a plausible reason to flip it. It is
 * a `false` literal with no setter, and `storageExecutionReadiness` takes no
 * parameter that could reintroduce it.
 */
export const SET_ROLE_PATH_VERIFIED = false as const

export type StorageReadiness =
  | { readonly ready: true; readonly via: 'MANAGED_BOUNDARY_VERIFIED'; readonly detail: string }
  | { readonly ready: false; readonly reason: string }

/**
 * `SET_ROLE_PATH_VERIFIED || MANAGED_BOUNDARY_VERIFIED`, with the first disjunct
 * pinned false — so in practice the second is the only way Storage closes.
 *
 * `managedBoundaryVerified` is not a boolean an operator passes. It is the
 * output of `reconcileStorageBoundary`, which reads the catalogue.
 */
export function storageExecutionReadiness(input: {
  readonly managedBoundaryVerified: boolean
  readonly detail: string
}): StorageReadiness {
  if (SET_ROLE_PATH_VERIFIED) {
    // Unreachable, and deliberately left in place: a reader checking whether the
    // disjunction is really a disjunction can see both arms.
    return { ready: true, via: 'MANAGED_BOUNDARY_VERIFIED', detail: 'unreachable' }
  }
  if (!input.managedBoundaryVerified) {
    return {
      ready: false,
      reason:
        `SET_ROLE_PATH_VERIFIED is false and cannot become true (MEMBER/USAGE/SET all measured false ` +
        `against supabase_storage_admin, on both the psql identity and the SQL Editor identity), and ` +
        `MANAGED_BOUNDARY_VERIFIED is false: ${input.detail}. A DESIGNED boundary is not a VERIFIED one.`,
    }
  }
  return { ready: true, via: 'MANAGED_BOUNDARY_VERIFIED', detail: input.detail }
}

/* -------------------------------------------------------------------------- */
/* 3. The operator's artefact: fields, not SQL to retype                      */
/* -------------------------------------------------------------------------- */

export interface ManagedPolicyField {
  readonly policyname: string
  readonly schema: string
  readonly table: string
  readonly permissive: 'PERMISSIVE'
  readonly cmd: string
  readonly roles: readonly string[]
  readonly using: string | null
  readonly withCheck: string | null
}

export interface ManagedPolicySpec {
  readonly policies: readonly ManagedPolicyField[]
  /** The four names PART B drops first, in order. */
  readonly dropsFirst: readonly string[]
  readonly sourceSha256: string
  readonly managedSha256: string
  readonly securitySurfaceDigest: string
}

const RE_CREATE =
  /CREATE\s+POLICY\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ON\s+([A-Za-z_"][\w".]*)\s+FOR\s+([A-Z]+)\s+TO\s+([^\n]+?)\s*(?:USING\s*\(([\s\S]*?)\)\s*)?(?:WITH\s+CHECK\s*\(([\s\S]*?)\)\s*)?;/gi

const RE_DROP = /DROP\s+POLICY\s+IF\s+EXISTS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ON\s/gi

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Turns PART B into the fields the Dashboard form asks for.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN "PASTE THE .sql FILE"
 * ---------------------------------------------------------------------------
 * If the channel turns out to be a FORM, an operator holding a .sql file has to
 * translate it — and translation by a human under time pressure is where a
 * predicate loses a conjunct. The instruction forbids exactly that: the operator
 * receives the generated artefact or DETERMINISTIC instructions, never
 * predicates copied out of documentation.
 *
 * So the fields are derived from the same canonical source as the .sql artefact
 * and cross-checked against `EXPECTED_STORAGE_POLICY_SURFACE` — the same
 * constant B0-16 verifies against afterwards. If the spec handed to the operator
 * and the expectation checked afterwards could disagree, the boundary would be
 * unfalsifiable, so they are pinned to each other here and a test proves it.
 */
export function deriveManagedPolicySpec(source: string): ManagedPolicySpec {
  const artefacts = buildStorageArtefacts(source)
  const partB = splitPreservingText(source.replace(/\r\n?/g, '\n')).filter(belongsToManagedPart)
  const code = stripSqlComments(partB.join('\n'))

  const policies: ManagedPolicyField[] = []
  for (const m of code.matchAll(RE_CREATE)) {
    const [, name, table, cmd, roles, using, withCheck] = m
    const qualified = table.replace(/"/g, '').split('.')
    policies.push({
      policyname: name,
      schema: qualified.length > 1 ? qualified[0] : 'public',
      table: qualified[qualified.length - 1],
      permissive: 'PERMISSIVE',
      cmd: cmd.toUpperCase(),
      roles: roles.split(',').map((r) => r.trim().replace(/"/g, '')),
      using: using === undefined ? null : collapse(using),
      withCheck: withCheck === undefined ? null : collapse(withCheck),
    })
  }

  if (policies.length !== EXPECTED_STORAGE_POLICIES.length) {
    throw new Error(
      `MANAGED_SPEC_SHAPE: parsed ${policies.length} CREATE POLICY statements out of PART B, expected ` +
        `${EXPECTED_STORAGE_POLICIES.length}. A spec that lost a policy is a boundary that silently ` +
        `installs a smaller guard.`,
    )
  }

  // PINNED TO THE POSTCONDITION. Anything the operator is told to type must be
  // what B0-16 will later demand; otherwise the check verifies a different
  // contract than the one that was executed.
  for (const expected of EXPECTED_STORAGE_POLICY_SURFACE) {
    const found = policies.find((p) => p.policyname === expected.policyname)
    if (!found) {
      throw new Error(`MANAGED_SPEC_SHAPE: ${expected.policyname} is absent from the derived spec.`)
    }
    if (found.cmd !== expected.cmd) {
      throw new Error(
        `MANAGED_SPEC_DRIFT: ${expected.policyname} is FOR ${found.cmd} in the source and ` +
          `${expected.cmd} in the postcondition. The operator would install one and be checked against ` +
          `the other.`,
      )
    }
    if (`{${found.roles.join(',')}}` !== expected.roles) {
      throw new Error(
        `MANAGED_SPEC_DRIFT: ${expected.policyname} roles are {${found.roles.join(',')}} in the source ` +
          `and ${expected.roles} in the postcondition.`,
      )
    }
    const slot = expected.predicateKind === 'qual' ? found.using : found.withCheck
    const other = expected.predicateKind === 'qual' ? found.withCheck : found.using
    if (!slot) {
      throw new Error(
        `MANAGED_SPEC_DRIFT: ${expected.policyname} carries no ${expected.predicateKind} in the source, ` +
          `but the postcondition reads that slot. An empty predicate is USING (true).`,
      )
    }
    if (other) {
      throw new Error(
        `MANAGED_SPEC_DRIFT: ${expected.policyname} carries predicates in BOTH slots.`,
      )
    }
    if (normalizeForCompare(slot) !== normalizeForCompare(expected.predicate)) {
      throw new Error(
        `MANAGED_SPEC_DRIFT: ${expected.policyname}'s ${expected.predicateKind} does not match the ` +
          `postcondition's canonical predicate.\n  source: ${normalizeForCompare(slot)}\n  expected: ` +
          `${normalizeForCompare(expected.predicate)}`,
      )
    }
  }

  const dropsFirst = [...code.matchAll(RE_DROP)].map((m) => m[1])

  return {
    policies,
    dropsFirst,
    sourceSha256: artefacts.sourceSha256,
    managedSha256: artefacts.managedSha256,
    securitySurfaceDigest: artefacts.managedSecuritySurfaceDigest,
  }
}

/** Same normalisation B0-16 applies, so the two comparisons cannot diverge. */
const normalizeForCompare = (p: string): string =>
  p
    .replace(/::\s*(text|character varying|varchar|uuid|boolean|bool)\b/gi, '')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/"/g, '')
    .trim()
    .toLowerCase()

/* -------------------------------------------------------------------------- */
/* 4. HUMAN_STORAGE_POLICY_BOUNDARY                                           */
/* -------------------------------------------------------------------------- */

export interface BoundaryPreconditions {
  readonly stagingProjectRef: string
  readonly productionDenylistPass: boolean
  readonly artifactSourceShaPass: boolean
  readonly derivedShaPass: boolean
  readonly securitySurfaceDigestPass: boolean
  readonly expectedPolicyCount: number
  readonly rlsAlreadyEnabledOnStorageObjects: boolean | null
  readonly targetTable: string
  /** PART A must already be committed: the predicates call its helpers. */
  readonly partAState: StorageUnitState
}

export interface BoundaryVerdict {
  readonly open: boolean
  readonly problems: readonly string[]
}

/**
 * May the boundary be OPENED — not "did it succeed".
 *
 * Opening it is itself an event with a journal row (`MANUAL_BOUNDARY_PENDING`),
 * because an unrecorded boundary is a manual step nothing can later notice was
 * skipped.
 */
export function evaluateBoundaryPreconditions(p: BoundaryPreconditions): BoundaryVerdict {
  const problems: string[] = []
  if (!/^[a-z]{20}$/.test(p.stagingProjectRef)) {
    problems.push(`stagingProjectRef '${p.stagingProjectRef}' is not a 20-lowercase-letter project ref.`)
  }
  // THE DENYLIST IS CHECKED HERE, NOT ONLY REPORTED BY THE CALLER.
  //
  // The first version of this function trusted `productionDenylistPass`, and its
  // own test broke it in one line: a production project ref with that boolean
  // set true opened the boundary. A production ref is twenty lowercase letters,
  // so the shape check passes it happily. This is the self-asserted boolean the
  // apply gate refuses everywhere else, and it had walked straight back in.
  if (KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.includes(p.stagingProjectRef)) {
    problems.push(
      `stagingProjectRef '${p.stagingProjectRef}' is a KNOWN PRODUCTION project. No combination of ` +
        `other passing preconditions may outvote this one.`,
    )
  }
  if (!p.productionDenylistPass) problems.push('the production denylist did not pass.')
  if (!p.artifactSourceShaPass) problems.push('the canonical source hash does not match the pin.')
  if (!p.derivedShaPass) problems.push('the derived PART B artefact does not regenerate to its pinned hash.')
  if (!p.securitySurfaceDigestPass) problems.push('the security surface digest drifted.')
  if (p.expectedPolicyCount !== EXPECTED_STORAGE_POLICIES.length) {
    problems.push(`expected policy count is ${p.expectedPolicyCount}, the contract says ${EXPECTED_STORAGE_POLICIES.length}.`)
  }
  if (p.rlsAlreadyEnabledOnStorageObjects !== true) {
    problems.push(
      p.rlsAlreadyEnabledOnStorageObjects === null
        ? 'RLS on storage.objects was not measured. Unmeasured is refused: policies on a table without RLS are decoration.'
        : 'RLS is NOT enabled on storage.objects, and we must not enable it — the platform refuses that and owns the decision.',
    )
  }
  if (p.targetTable !== 'storage.objects') {
    problems.push(`target table is ${p.targetTable}, not storage.objects.`)
  }
  if (p.partAState !== 'UNIT_41_HELPERS_APPLIED') {
    problems.push(
      `PART A state is ${p.partAState}. The boundary opens only from UNIT_41_HELPERS_APPLIED: the three ` +
        `predicates call public.can_*_evidence_object, so policies created before the helpers exist raise ` +
        `42883 on every evaluation.`,
    )
  }
  return { open: problems.length === 0, problems }
}

/* -------------------------------------------------------------------------- */
/* 5. Reconciliation — the only path to MANUAL_BOUNDARY_VERIFIED              */
/* -------------------------------------------------------------------------- */

export type BoundaryJournalStatus =
  | 'MANUAL_BOUNDARY_PENDING'
  | 'MANUAL_BOUNDARY_VERIFIED'
  | 'ABSENT'

export interface BoundaryReconciliation {
  readonly state: StorageUnitState
  /** What the journal should be moved to. `null` = leave it alone. */
  readonly journalTransition: 'MANUAL_BOUNDARY_VERIFIED' | null
  readonly managedBoundaryVerified: boolean
  readonly problems: readonly string[]
}

/**
 * Catalogue first, journal second, operator never.
 *
 * The instruction: "La transición final debe depender de estado de catálogo
 * medido, no sólo de 'operador dijo que terminó'." So this function takes no
 * operator claim at all. It takes what pg_proc and pg_policies said, and what
 * B0-16 concluded about the surface, and it will refuse to mark the boundary
 * verified when any of the three is missing.
 */
export function reconcileStorageBoundary(input: {
  readonly helpersPresent: boolean
  readonly policyNamesPresent: readonly string[]
  /** B0-16's verdict over the whole surface, `null` when not run. */
  readonly surfaceVerified: boolean | null
  readonly boundaryJournal: BoundaryJournalStatus
  /** An APPLIED journal row for unit 41 PART A exists. */
  readonly partAJournalled: boolean
}): BoundaryReconciliation {
  const problems: string[] = []
  const state = deriveStorageUnitState({
    helpersPresent: input.helpersPresent,
    policyNamesPresent: input.policyNamesPresent,
    boundaryOpen: input.boundaryJournal === 'MANUAL_BOUNDARY_PENDING',
    surfaceVerified: input.surfaceVerified,
  })

  // THE JOURNAL MUST NOT DISAGREE WITH THE CATALOGUE, IN EITHER DIRECTION.
  if (input.partAJournalled && !input.helpersPresent) {
    problems.push(
      'the journal records unit 41 PART A as APPLIED and pg_proc has neither helper. Under psql -1 the ' +
        'row and the helpers commit together, so this combination cannot arise from a correct apply — ' +
        'either the row was fabricated or something dropped the functions.',
    )
  }
  if (!input.partAJournalled && input.helpersPresent) {
    problems.push(
      'the helpers exist with no APPLIED row for unit 41. The wrapper writes the row inside the same ' +
        'transaction, so the helpers cannot have been created by it. Something applied the unit outside ' +
        'the governed channel.',
    )
  }
  if (input.boundaryJournal === 'MANUAL_BOUNDARY_VERIFIED' && state !== 'UNIT_41_COMPLETE') {
    problems.push(
      `the journal already says MANUAL_BOUNDARY_VERIFIED while the catalogue says ${state}. The ledger ` +
        `is ahead of the database, which is the direction that matters.`,
    )
  }
  if (input.surfaceVerified === null && input.policyNamesPresent.length > 0) {
    problems.push(
      'policies exist on storage.objects and B0-16 has not been run over them. Names are not a surface: ' +
        'a policy called select_evidence with USING (true) satisfies every name check there is.',
    )
  }

  const verified = state === 'UNIT_41_COMPLETE' && problems.length === 0
  return {
    state,
    journalTransition:
      verified && input.boundaryJournal !== 'MANUAL_BOUNDARY_VERIFIED' ? 'MANUAL_BOUNDARY_VERIFIED' : null,
    managedBoundaryVerified: verified,
    problems,
  }
}

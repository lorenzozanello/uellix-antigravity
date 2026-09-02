'use server'
// app/actions/grounding/evidence-corpus-state.ts
// G-01 (product path) — the truthful answer to "what does the grounding corpus
// hold for this project's evidence?", for the evidence screen.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A READ MODEL AND NOT A STATUS COLUMN
// ---------------------------------------------------------------------------
// See `lib/grounding/corpus-state.ts`. In short: `evidence_document_versions`
// already answers the question transactionally, and a second answer stored on
// `evidence_items` would be free to disagree with the corpus it describes.
// NOTHING here writes, and no migration was needed to build it.
//
// ---------------------------------------------------------------------------
// WHAT THE CLIENT CANNOT SEND
// ---------------------------------------------------------------------------
//   organization   <- `requireOrganizationAccess()`, the session
//   project        <- the argument, but only after it is proved to be IN that
//                     organization; an unknown project and another tenant's
//                     project get the SAME answer
//   evidence set   <- a project-scoped query, never a list from the request
//   role           <- the membership, which decides `canRetry`
//
// The request has one field and it is a project id. There is no evidence id
// parameter, because a caller that could name one could ask about a row and
// learn whether it exists from the shape of the answer.
//
// ---------------------------------------------------------------------------
// WHY THE GATE IS `grounded_query`
// ---------------------------------------------------------------------------
// The same reason `ingest-evidence.ts` gives: the corpus has exactly one
// consumer, and a second flag would let the reader, the writer and the status
// screen disagree about whether the capability exists. When it is off there is
// no corpus to describe, and describing one anyway would be the screen
// inventing a product state the deployment does not have.

import { and, eq } from 'drizzle-orm'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { canUploadEvidence } from '@/lib/auth/permissions'
import { withOrganizationDatabaseContext } from '@/lib/auth/database-context'
import { isStellaCapabilityReady } from '@/lib/stella/capability-readiness'
import { db } from '@/db/client'
import { evidenceItems, projects } from '@/db/schema'
import {
  readActiveDocumentVersions,
  readLastIndexingAttempts,
} from '@/db/grounding/grounding-corpus-state-repository'
import {
  deriveEvidenceCorpusState,
  type ActiveVersionFact,
  type EvidenceCorpusState,
  type IndexingAttemptFact,
} from '@/lib/grounding/corpus-state'
import type { GroundingScope } from '@/lib/grounding/contracts'

export type { EvidenceCorpusState } from '@/lib/grounding/corpus-state'

export type ProjectCorpusStateResult =
  /** One state per evidence row of the project, in the project's own order. */
  | { readonly status: 'ready'; readonly states: readonly EvidenceCorpusState[] }
  /** The capability is off. Costs no authentication and no read. */
  | { readonly status: 'disabled' }
  /** Not authenticated, or the project is not in this organization. */
  | { readonly status: 'unauthorized' }
  /**
   * The corpus could not be read.
   *
   * A DISTINCT status, and the reason this action has four instead of three:
   * degrading to `ready` with every row "not indexed" would tell a reviewer the
   * corpus is empty when the truth is that nobody could look. An index that
   * cannot be read must never be reported as an index that holds nothing.
   */
  | { readonly status: 'error'; readonly stage: string }

/**
 * The corpus state of every evidence item in one project.
 *
 * @param projectId re-verified against the session's organization inside.
 */
export async function readProjectCorpusStateForProject(
  projectId: string,
): Promise<ProjectCorpusStateResult> {
  // 1. CAPABILITY — first, before authentication and before any read.
  if (!isStellaCapabilityReady('grounded_query')) {
    return { status: 'disabled' }
  }

  const project = typeof projectId === 'string' ? projectId.trim() : ''
  if (project === '') return { status: 'unauthorized' }

  // 2. AUTHENTICATE.
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { status: 'unauthorized' }
  }

  const scope: GroundingScope = { organizationId: ctx.organization.id, projectId: project }
  const mayManage = canUploadEvidence(ctx.membership.role)

  // 3. THE READS. `readFacts` opens the identity context ITSELF rather than
  //    being wrapped here — see its header for why that placement is load-
  //    bearing rather than stylistic.
  let facts: ProjectFacts | 'unauthorized'
  try {
    facts = await readFacts(scope)
  } catch {
    // The failure kind is deliberately not carried out: it comes from a driver,
    // and a driver error quotes the statement that failed — which here names
    // organization ids, project ids and evidence ids.
    return { status: 'error', stage: 'corpus_read' }
  }

  if (facts === 'unauthorized') return { status: 'unauthorized' }

  // 4. DERIVE. Pure, and per row — the evidence list is the spine, so an
  //    evidence item with no corpus record still gets a state.
  const versions = indexBy(facts.versions, (version) => version.evidenceId)
  const attempts = indexBy(facts.attempts, (attempt) => attempt.evidenceId)

  const states = facts.evidence.map((row) =>
    deriveEvidenceCorpusState(
      row,
      versions.get(row.id) ?? null,
      attempts.get(row.id) ?? null,
      { mayManage },
    ),
  )

  return { status: 'ready', states }
}

/* -------------------------------------------------------------------------- */
/* The reads                                                                  */
/* -------------------------------------------------------------------------- */

interface ProjectFacts {
  readonly evidence: readonly EvidenceRow[]
  readonly versions: readonly ActiveVersionFact[]
  readonly attempts: readonly IndexingAttemptFact[]
}

interface EvidenceRow {
  readonly id: string
  readonly status: string
  readonly type: string
  readonly description: string | null
  readonly filePath: string | null
  readonly fileSize: number | null
  readonly mimeType: string | null
  readonly contentHash: string | null
}

/**
 * Every fact the derivation needs, inside ONE identity context.
 *
 * ---------------------------------------------------------------------------
 * WHY THE QUERIES ARE INLINE IN THE CALLBACK
 * ---------------------------------------------------------------------------
 * `withOrganizationDatabaseContext(() => readTheRows(scope))` runs identically
 * and was this function's first shape. It is also exactly what
 * `tests/database-runtime-entrypoints.test.ts` calls a DECORATIVE WRAPPER: an
 * opener whose callback contains no database work, with the queries one hop
 * away in a helper that nothing stops from being called from somewhere else
 * later. As `uellix_app` a query outside a context returns ZERO ROWS instead of
 * failing, so that mistake ships as a silently empty screen rather than as an
 * error — which is why the scanner refuses the shape and why this reads the
 * rows where the context is opened.
 *
 * ONE context for all of it: nothing slow sits between these statements — no
 * storage round trip, no provider — so there is no reason to open four.
 */
async function readFacts(scope: GroundingScope): Promise<ProjectFacts | 'unauthorized'> {
  return withOrganizationDatabaseContext(async () => {
    // 3a. THE PROJECT, scoped by the session's organization. A project of
    //     another tenant is not absent from this result by policy alone — the
    //     predicate says so too, so the answer does not depend on RLS being the
    //     only thing standing between the tenants.
    const owned = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, scope.projectId!), eq(projects.organizationId, scope.organizationId)),
      )
      .limit(1)

    if (owned.length === 0) return 'unauthorized' as const

    // 3b. THE EVIDENCE SET. This is the project boundary every statement below
    //     inherits, and it comes from here rather than from the request.
    const evidence = (await db
      .select({
        id: evidenceItems.id,
        status: evidenceItems.status,
        type: evidenceItems.type,
        description: evidenceItems.description,
        filePath: evidenceItems.filePath,
        fileSize: evidenceItems.fileSize,
        mimeType: evidenceItems.mimeType,
        contentHash: evidenceItems.contentHash,
      })
      .from(evidenceItems)
      .where(
        and(
          eq(evidenceItems.organizationId, scope.organizationId),
          eq(evidenceItems.projectId, scope.projectId!),
        ),
      )
      .orderBy(evidenceItems.createdAt, evidenceItems.id)) as EvidenceRow[]

    if (evidence.length === 0) return { evidence: [], versions: [], attempts: [] }

    const evidenceIds = evidence.map((row) => row.id)

    // 3c. Both statements are bound to this scope AND to this id set. There is
    //     deliberately NO second filter over what comes back: the derivation
    //     below indexes the results by evidence id and looks each one up BY THE
    //     PROJECT'S OWN ROW ID, so a corpus record for anything else is
    //     unreachable rather than discarded — a `filter` here could never
    //     remove a row, and a guard that cannot fire is decoration that reads
    //     like a boundary. (Confirmed by mutation: deleting such a filter
    //     changed no output.)
    const [versions, attempts] = await Promise.all([
      readActiveDocumentVersions(scope, evidenceIds),
      readLastIndexingAttempts(scope, evidenceIds),
    ])

    return { evidence, versions, attempts }
  })
}

function indexBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) map.set(key(row), row)
  return map
}

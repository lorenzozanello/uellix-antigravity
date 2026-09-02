// db/hosted/authority/governed-generator.ts
// COMMIT 4 — the governed hosted chain, emitted.
//
// ---------------------------------------------------------------------------
// WHAT THIS PRODUCES, AND WHY IT IS A THIRD ARTEFACT AND NOT A SECOND
// ---------------------------------------------------------------------------
// The chain is derived twice, in one direction:
//
//   db/prepared/*.sql              canonical. The only source of truth.
//        |  rewrite-rules.ts       RR-09 and friends: what managed Supabase
//        v                         cannot execute at all
//   db/prepared/hosted/*.hosted.sql
//        |  THIS FILE              who executes each statement, and how the
//        v                         authority to do so is opened and closed
//   db/prepared/hosted/governed/*.governed.sql
//
// The middle artefact is left exactly where it is. `pnpm hosted:verify` still
// regenerates and byte-compares it, and — more importantly — the authority plan
// is resolved AGAINST it. Writing the governed output back over it would make
// the plan an input to its own derivation, and the first drift would be
// unfindable because both halves would have moved together.
//
// ---------------------------------------------------------------------------
// WHAT IS REPLACED, AND WHAT IS NEVER TOUCHED
// ---------------------------------------------------------------------------
// Canonical authority bookkeeping — the 16 `SET ROLE` / `RESET ROLE` statements
// — is REPLACED. It assumes a superuser applying the package, which is the one
// thing managed Supabase does not have. Everything else is emitted verbatim, in
// canonical order. Statements are never moved to reduce the number of role
// transitions: W47 alternates between two capability roles six times because
// the canonical order alternates, and flattening it would run one role's
// statements as the other.

import { AuthorityStateMachine, capabilityWindowPrimitive, ownerTransferPrimitive, ownerWindowPrimitive, type AuthorityPrimitive } from './primitives'
import { segmentRows, type AuthorityPlan, type ExecutionSegment } from './classification-manifest'
import { resolveExecutionDispositions, type StatementDisposition } from './execution-disposition'
import { OWNER_ROLE, type SimulatedStatement } from './ownership-simulation'
import type { HostedRoleIdentifier } from './role-registry'
import { AuthorityRefusal } from './window-contract'
import { CHAIN_PACKAGE_FILES } from './window-plan'
import { sha256OfSql } from '../hosted-package-manifest'

export const GOVERNED_INSTALLER: HostedRoleIdentifier = 'uellix_migrator'

/** Where a governed artefact lives. Never the same directory as its input. */
export function governedArtefactName(sourceFile: string): string {
  return sourceFile.replace(/\.sql$/, '.governed.sql')
}

export interface EmittedStatement {
  /** `canonical` came from the package; `authority` was inserted by the plan. */
  readonly origin: 'canonical' | 'authority'
  readonly sql: string
  /** For canonical statements: the index it had in the input package. */
  readonly sourceIndex: number | null
  /** For authority statements: which segment's lifecycle emitted it. */
  readonly segmentId: string | null
}

export interface GeneratedGovernedPackage {
  readonly packageId: string
  readonly sourceFile: string
  readonly fileName: string
  readonly sql: string
  readonly statements: readonly EmittedStatement[]
  readonly sourceDigest: string
  readonly generatedDigest: string
  readonly counts: {
    readonly canonicalExecutable: number
    readonly canonicalContext: number
    readonly classificationWindows: number
    readonly executionSegments: number
    readonly transferSegments: number
    readonly insertedAuthorityStatements: number
    readonly managedRewrites: number
    readonly generatedExecutable: number
    readonly temporaryMembershipLifecycles: number
    readonly temporarySchemaCreateLifecycles: number
  }
}

/* -------------------------------------------------------------------------- */
/* Segment geometry                                                            */
/* -------------------------------------------------------------------------- */

interface SegmentSpan {
  readonly segment: ExecutionSegment
  readonly firstIndex: number
  readonly lastIndex: number
}

function segmentSpans(plan: AuthorityPlan, packageId: string): SegmentSpan[] {
  const spans: SegmentSpan[] = []
  for (const segment of plan.segments) {
    if (segment.packageId !== packageId) continue
    const rows = segmentRows(plan, segment)
    if (rows.length === 0) {
      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
        `${segment.segmentId}: covers no statements, so nothing can be emitted for it.`,
      )
    }
    spans.push({
      segment,
      firstIndex: rows[0].statement.index,
      lastIndex: rows[rows.length - 1].statement.index,
    })
  }
  return spans.sort((a, b) => a.firstIndex - b.firstIndex)
}

/**
 * The one schema a segment acts in.
 *
 * A temporary CREATE grant names exactly one schema, so a segment that needs
 * one must have exactly one. A segment that does not need one may legitimately
 * touch several (a capability window that REVOKEs across two schemas), and the
 * value is then unused.
 */
function segmentSchema(plan: AuthorityPlan, segment: ExecutionSegment): string {
  if (segment.requiredTemporarySchemaCreate !== null) return segment.requiredTemporarySchemaCreate
  const schemas = new Set(
    segmentRows(plan, segment)
      .map((row) => row.identity.object?.schema)
      .filter((s): s is string => typeof s === 'string'),
  )
  return schemas.size === 1 ? [...schemas][0] : ''
}

function primitiveFor(plan: AuthorityPlan, segment: ExecutionSegment): AuthorityPrimitive {
  const schema = segmentSchema(plan, segment)

  if (segment.authorityClass === 'OWNER_TRANSFER') {
    // The corrected case-G lifecycle. Typed, one target, one schema — there is
    // no `from`/`to` API any more and no compatibility alias to fall back to.
    return ownerTransferPrimitive({
      installer: GOVERNED_INSTALLER,
      fromOwner: 'uellix_owner',
      targetCapability: segment.ownerDestination as HostedRoleIdentifier,
      schema,
      segmentId: segment.segmentId,
    })
  }

  if (segment.authorityClass === 'CAPABILITY') {
    return capabilityWindowPrimitive({
      installer: GOVERNED_INSTALLER,
      capabilityRole: segment.executor as HostedRoleIdentifier,
      schema,
      needsTemporarySchemaCreate: segment.requiredTemporarySchemaCreate !== null,
    })
  }

  return ownerWindowPrimitive(GOVERNED_INSTALLER)
}

/* -------------------------------------------------------------------------- */
/* Emission                                                                    */
/* -------------------------------------------------------------------------- */

const BANNER = (packageId: string, sourceFile: string, sourceDigest: string): string =>
  [
    '-- ============================================================================',
    `-- ${sourceFile.replace(/\.sql$/, '')} — GOVERNED MANAGED SUPABASE VARIANT`,
    '-- GENERATED — DO NOT EDIT. Regenerate with `pnpm authority:generate`.',
    '-- ============================================================================',
    '--',
    `-- Package: ${packageId}`,
    `-- Derived from: db/prepared/hosted/${sourceFile.replace(/\.sql$/, '.hosted.sql')}`,
    `-- Source SHA-256 (LF-normalized): ${sourceDigest}`,
    '--',
    '-- WHAT CHANGED, AND ONLY THIS:',
    '--   The canonical SET ROLE / RESET ROLE bookkeeping was replaced. It assumes',
    '--   a superuser applies the package, which managed Supabase does not have.',
    '--   In its place each execution segment opens exactly the authority it needs,',
    '--   runs the canonical statements it governs, and gives that authority back.',
    '--',
    '-- WHAT DID NOT CHANGE:',
    '--   Every canonical executable statement, verbatim and in canonical order.',
    '--   No statement was moved to reduce the number of role transitions.',
    '-- ============================================================================',
    '',
  ].join('\n')

const sectionComment = (text: string): string => `-- ${text}`

/**
 * Emits one governed package.
 *
 * A pure function of the plan and the parsed input: no clock, no randomness, no
 * filesystem, no environment. That is what makes `authority:verify` able to
 * regenerate and byte-compare, which is the only thing that makes a checked-in
 * generated artefact auditable rather than merely present.
 */
export function generateGovernedPackage(
  plan: AuthorityPlan,
  packageId: string,
  dispositions: readonly StatementDisposition[],
): GeneratedGovernedPackage {
  const entry = CHAIN_PACKAGE_FILES.find((e) => e.packageId === packageId)
  if (entry === undefined) {
    throw new AuthorityRefusal('AUTHORITY_UNKNOWN_ROLE', `unknown package ${packageId}`)
  }

  const rows = plan.rowsByPackage.get(packageId) ?? []
  const spans = segmentSpans(plan, packageId)
  const openAt = new Map(spans.map((s) => [s.firstIndex, s]))
  const closeAt = new Map(spans.map((s) => [s.lastIndex, s]))
  const dispositionByIndex = new Map(
    dispositions.filter((d) => d.packageId === packageId).map((d) => [d.statementIndex, d]),
  )

  const emitted: EmittedStatement[] = []
  const machine = new AuthorityStateMachine()
  let membershipLifecycles = 0
  let schemaCreateLifecycles = 0
  let insertedAuthority = 0

  const pushAuthority = (sql: string, segmentId: string): void => {
    emitted.push({ origin: 'authority', sql, sourceIndex: null, segmentId })
    insertedAuthority += 1
  }

  for (const row of rows) {
    const index = row.statement.index
    const disposition = dispositionByIndex.get(index)
    if (disposition === undefined) {
      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
        `${packageId}[${index}] has no disposition; the generator will not guess one.`,
      )
    }

    // Canonical bookkeeping is REPLACED, not carried through.
    if (disposition.kind === 'BOOKKEEPING_OR_EXCLUDED' && isCanonicalRoleBookkeeping(row)) {
      continue
    }

    const opening = openAt.get(index)
    if (opening !== undefined) {
      const primitive = primitiveFor(plan, opening.segment)
      machine.enter(opening.segment.authorityClass === 'OWNER' ? 'owner' : 'capability')
      pushAuthority(
        sectionComment(
          `authority: open ${opening.segment.segmentId} (${opening.segment.authorityClass}) as ` +
            `${opening.segment.executor}`,
        ),
        opening.segment.segmentId,
      )
      for (const sql of primitive.open) pushAuthority(sql, opening.segment.segmentId)
      membershipLifecycles += 1
      if (opening.segment.requiredTemporarySchemaCreate !== null) schemaCreateLifecycles += 1
    }

    if (disposition.kind === 'CANONICAL_ROLE_CONTEXT') {
      // Outside every classification window, and still not the installer's to
      // run: CREATE TABLE makes the executing role the owner.
      const owner = ownerWindowPrimitive(GOVERNED_INSTALLER)
      machine.enter('owner')
      pushAuthority(
        sectionComment(
          `authority: canonical role context — this statement must be created by ${OWNER_ROLE}`,
        ),
        `${packageId}.ctx${index}`,
      )
      for (const sql of owner.open) pushAuthority(sql, `${packageId}.ctx${index}`)
      membershipLifecycles += 1
      emitted.push({ origin: 'canonical', sql: row.statement.raw, sourceIndex: index, segmentId: null })
      for (const sql of owner.close) pushAuthority(sql, `${packageId}.ctx${index}`)
      machine.leave()
      continue
    }

    emitted.push({ origin: 'canonical', sql: row.statement.raw, sourceIndex: index, segmentId: null })

    // ---------------------------------------------------------------------
    // INSTALLER REACHABILITY (COMMIT 5.1, E-02). Measured, not designed.
    // ---------------------------------------------------------------------
    // `CREATE SCHEMA <x> AUTHORIZATION uellix_owner` gives the schema to the
    // owner and the installer NOTHING — not even the ability to name what is
    // in it. Six packages then open with a precondition that calls
    // `to_regprocedure('uellix_grounding.insert_evidence_chunks(uuid, jsonb)')`,
    // and `to_regprocedure` needs USAGE on the schema to resolve the name at
    // all. PostgreSQL 17.6 answers `permission denied for schema
    // uellix_grounding`, from T3's own precondition, before the package has
    // done anything.
    //
    // It never appears locally because the canonical chain is applied by a
    // SUPERUSER, which bypasses the check.
    //
    // WHY HERE AND NOT IN A REWRITE RULE. The obvious placement — beside the
    // `GRANT USAGE ... TO uellix_app` the same window already emits — puts a
    // statement INSIDE a recovered classification window, which changes its
    // structural count and its digest sequence. Those are provenance: four
    // windows differ from their historical counts today, for reasons a test
    // enumerates one by one, and adding three more would mean editing that
    // evidence to match new code. `create-schema` is installer-class and sits
    // OUTSIDE every window, so emitting here changes no window, no segment and
    // no plan digest — verified: 51/59/11 and 19a0ff5a… unchanged.
    //
    // USAGE confers no access to any object the schema contains. The chain
    // grants the installer nothing else, and this grant is PERMANENT rather
    // than temporary — it is a reachability fact about the installer, not an
    // elevation, so there is nothing for the cleanup contract to give back.
    if (row.identity.statementClass === 'create-schema' && row.identity.object !== null) {
      const schema = row.identity.object.name
      const reachability = `${packageId}.usage${index}`
      pushAuthority(
        sectionComment(
          `authority: installer reachability — ${GOVERNED_INSTALLER} must resolve names in ${schema}`,
        ),
        reachability,
      )
      pushAuthority(`SET ROLE ${OWNER_ROLE};`, reachability)
      pushAuthority(`GRANT USAGE ON SCHEMA ${schema} TO ${GOVERNED_INSTALLER};`, reachability)
      pushAuthority('RESET ROLE;', reachability)
    }

    const closing = closeAt.get(index)
    if (closing !== undefined) {
      const primitive = primitiveFor(plan, closing.segment)
      for (const sql of primitive.close) pushAuthority(sql, closing.segment.segmentId)
      pushAuthority(
        sectionComment(`authority: close ${closing.segment.segmentId}`),
        closing.segment.segmentId,
      )
      machine.leave()
    }
  }

  if (machine.state !== 'installer') {
    throw new AuthorityRefusal(
      'AUTHORITY_STATE_TRANSITION_INVALID',
      `${packageId}: the package would end elevated as ${machine.state}. A generated artefact that ` +
        `ended elevated would leave the applying session holding authority nobody closed.`,
    )
  }

  const sourceDigest = sha256OfSql(rows.map((r) => r.statement.raw).join(''))
  const body = emitted.map((e) => (e.origin === 'authority' ? e.sql : e.sql.trim())).join('\n')
  const sql = `${BANNER(packageId, entry.sourceFile, sourceDigest)}${body}\n`

  const packageWindows = plan.windows.filter((w) => w.packageId === packageId)
  const packageSegments = plan.segments.filter((s) => s.packageId === packageId)
  const packageDispositions = dispositions.filter((d) => d.packageId === packageId)

  return {
    packageId,
    sourceFile: entry.sourceFile,
    fileName: governedArtefactName(entry.sourceFile),
    sql,
    statements: emitted,
    sourceDigest,
    generatedDigest: sha256OfSql(sql),
    counts: {
      canonicalExecutable: rows.length,
      canonicalContext: packageDispositions.filter((d) => d.kind === 'CANONICAL_ROLE_CONTEXT').length,
      classificationWindows: packageWindows.length,
      executionSegments: packageSegments.length,
      transferSegments: packageSegments.filter((s) => s.authorityClass === 'OWNER_TRANSFER').length,
      insertedAuthorityStatements: insertedAuthority,
      managedRewrites: packageDispositions.filter((d) => d.kind === 'MANAGED_REWRITE').length,
      generatedExecutable: emitted.filter((e) => e.origin === 'canonical').length,
      temporaryMembershipLifecycles: membershipLifecycles,
      temporarySchemaCreateLifecycles: schemaCreateLifecycles,
    },
  }
}

/** True for the canonical `SET ROLE` / `RESET ROLE` the governed output replaces. */
function isCanonicalRoleBookkeeping(row: SimulatedStatement): boolean {
  const statementClass = row.identity.statementClass
  return statementClass === 'set-role' || statementClass === 'reset-role'
}

/**
 * Generates all nine packages, or throws.
 *
 * Nothing is written here. The caller publishes only after every package has
 * been generated AND validated, which is what makes a failure at T7 leave T1
 * untouched instead of leaving four new files beside five old ones.
 */
export function generateGovernedChain(plan: AuthorityPlan): GeneratedGovernedPackage[] {
  const dispositions = resolveExecutionDispositions(plan)
  return CHAIN_PACKAGE_FILES.map((entry) =>
    generateGovernedPackage(plan, entry.packageId, dispositions),
  )
}

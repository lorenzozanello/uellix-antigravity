// db/hosted/authority/classification-manifest.ts
// COMMIT 3 — the two layers, kept apart on purpose.
//
//   ClassificationWindow   WHY a run of statements needs elevation.
//                          Recovered provenance. Never re-derived here.
//
//   ExecutionSegment       HOW it is actually run: which single role is
//                          `current_role` for which contiguous statements.
//                          MEASURED from `ownerBefore`, never assumed, and
//                          never forced to match the window count.
//
// Collapsing them was the defect the operator's review caught. Four recovered
// windows involve two capability roles each (W38, W46, W47, W51), and
// PostgreSQL has exactly one effective `current_role` at a time. A window with
// `capabilityRole: HostedRoleIdentifier` would have had to pick one and run the
// other role's statements under it — which is a privilege widening that the
// manifest would then have recorded as correct.

import { readFileSync } from 'node:fs'

import { RECOVERED_WINDOWS, type BoundaryPredicate, type RecoveredWindow } from './recovered-boundaries'
import {
  authorityFromOwnerBefore,
  hostedArtefactPath,
  isCapabilityRoleName,
  OWNER_ROLE,
  simulateChainOwnership,
  type SimulatedStatement,
} from './ownership-simulation'
import { normalizeExecutable, splitSqlStatements } from './sql-statements'
import {
  formatObjectIdentity,
  normalizedExecutableDigest,
  parseStatementIdentity,
  statementIdentityKey,
  type StatementClass,
} from './structural-identity'
import { AuthorityRefusal } from './window-contract'
import { CHAIN_PACKAGE_FILES } from './window-plan'

/* -------------------------------------------------------------------------- */
/* Boundary resolution                                                         */
/* -------------------------------------------------------------------------- */

function matchesPredicate(row: SimulatedStatement, predicate: BoundaryPredicate): boolean {
  if (row.identity.statementClass !== predicate.statementClass) return false

  if (predicate.object !== undefined) {
    if (row.identity.object === null) return false
    if (formatObjectIdentity(row.identity.object) !== predicate.object) return false
  }

  if (predicate.operands !== undefined) {
    const operands = row.identity.operands.join(':')
    for (const wanted of predicate.operands) {
      if (!operands.split(/[:+]/).includes(wanted)) return false
    }
  }

  if (predicate.contains !== undefined) {
    // F-08C. Matched against NORMALIZED EXECUTABLE text, not raw source. A
    // comment must never satisfy a boundary disambiguator: a reviewer adding
    // `-- see pg_get_constraintdef` above the wrong DO block would otherwise
    // make that block answer to another window's anchor, and the refusal that
    // followed would name the wrong statement.
    const executable = normalizeExecutable(row.statement.raw)
    for (const fragment of predicate.contains) {
      if (!executable.includes(fragment)) return false
    }
  }

  return true
}

function describe(predicate: BoundaryPredicate): string {
  const bits: string[] = [predicate.statementClass]
  if (predicate.object !== undefined) bits.push(predicate.object)
  if (predicate.operands !== undefined) bits.push(`operands[${predicate.operands.join(',')}]`)
  if (predicate.contains !== undefined) bits.push(`contains[${predicate.contains.join(',')}]`)
  return bits.join(' ')
}

/**
 * Resolves one boundary to exactly one statement.
 *
 * Zero and many are different diagnoses and get different codes. First-match is
 * never used — a boundary that matches twice means the predicate is not specific
 * enough for THIS package, and silently taking the earlier one would pin a
 * window over statements nobody chose.
 */
function resolveBoundary(
  rows: readonly SimulatedStatement[],
  window: RecoveredWindow,
  predicate: BoundaryPredicate,
  position: 'start' | 'end',
): number {
  const matches: number[] = []
  for (const [index, row] of rows.entries()) {
    if (matchesPredicate(row, predicate)) matches.push(index)
  }

  const where = `${window.packageId}/${window.windowId}`
  if (matches.length === 0) {
    throw new AuthorityRefusal(
      position === 'start'
        ? 'AUTHORITY_WINDOW_START_ANCHOR_MISSING'
        : 'AUTHORITY_WINDOW_END_ANCHOR_MISSING',
      `${where}: no statement matches ${describe(predicate)}. Recovered as: ${window.describedAs}`,
    )
  }
  if (matches.length > 1) {
    throw new AuthorityRefusal(
      position === 'start'
        ? 'AUTHORITY_WINDOW_START_ANCHOR_AMBIGUOUS'
        : 'AUTHORITY_WINDOW_END_ANCHOR_AMBIGUOUS',
      `${where}: ${matches.length} statements match ${describe(predicate)} (indexes ` +
        `${matches.map((m) => rows[m].statement.index).join(', ')}). Recovered as: ${window.describedAs}`,
    )
  }
  return matches[0]
}

/* -------------------------------------------------------------------------- */
/* The resolved plan                                                           */
/* -------------------------------------------------------------------------- */

export type AuthorityClass = 'OWNER' | 'CAPABILITY' | 'OWNER_TRANSFER'

export interface ResolvedClassificationWindow {
  readonly windowId: string
  readonly packageId: string
  readonly authorityClass: AuthorityClass
  readonly authoritySource: 'ORIGINAL_STATEFUL_PARTITION'
  readonly authorityModelVersion: 'A_FINAL_STATEFUL_V1'
  readonly startStatementIdentity: string
  readonly endStatementIdentity: string
  /** What the recovered table said. Kept for review, never silently trusted. */
  readonly historicalStatementCount: number
  /** What this parser measures between the resolved anchors, inclusive. */
  readonly structuralStatementCount: number
  readonly allowedStatementClasses: readonly StatementClass[]
  readonly statementDigestSequence: readonly string[]
  readonly members: readonly SimulatedStatement[]
  readonly describedAs: string
}

export type Executor = 'INSTALLER' | 'OWNER' | (string & {})

export interface ExecutionSegment {
  readonly classificationWindowId: string
  readonly segmentId: string
  readonly packageId: string
  readonly authorityClass: AuthorityClass
  /** Exactly one. `uellix_owner`, or one capability role. Never a list. */
  readonly executor: Executor
  /** For OWNER_TRANSFER: the single incoming owner this segment transfers to. */
  readonly ownerDestination: string | null
  readonly startStatementIdentity: string
  readonly endStatementIdentity: string
  readonly statementCount: number
  readonly statementDigestSequence: readonly string[]
  readonly requiredTemporaryMemberships: readonly string[]
  readonly requiredTemporarySchemaCreate: string | null
  readonly entryState: 'installer'
  readonly exitState: 'installer'
}

export interface AuthorityPlan {
  readonly windows: readonly ResolvedClassificationWindow[]
  readonly segments: readonly ExecutionSegment[]
  readonly rowsByPackage: ReadonlyMap<string, readonly SimulatedStatement[]>
}

/**
 * Statements the partition does not govern.
 *
 * `set-parameter` is `SET search_path` / `SET lock_timeout`: session setup that
 * needs no authority at all. DO blocks are excluded EXCEPT where a recovered
 * window names one — W29 and the T8 constraint blocks are governed because the
 * recovered partition measured them individually. Comments... are NOT excluded:
 * `COMMENT ON` requires ownership, and the recovered window sizes only add up
 * with them counted.
 */
function isExcludedFromPartition(row: SimulatedStatement, governedIndexes: ReadonlySet<number>): boolean {
  const statementClass = row.identity.statementClass
  if (statementClass === 'set-parameter') return true
  if (statementClass === 'do-block') return !governedIndexes.has(row.statement.index)
  return false
}

function isBookkeeping(statementClass: StatementClass): boolean {
  return statementClass === 'set-role' || statementClass === 'reset-role'
}

/** The `ALTER ROLE` a managed installer cannot issue, plus its generated guard. */
function isManagedRewrite(row: SimulatedStatement): boolean {
  return row.identity.statementClass === 'alter-role'
}

/* -------------------------------------------------------------------------- */
/* Segmentation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Splits one classification window into execution segments.
 *
 * A CAPABILITY window segments wherever the exact capability role changes; a
 * TRANSFER window wherever the incoming owner changes. An OWNER window has one
 * executor by construction and is one segment.
 *
 * The counts are MEASURED. They are deliberately not compared against any
 * expected number, because there is no historical figure for them and inventing
 * one would turn a measurement back into a checksum fit.
 */
function segmentWindow(window: ResolvedClassificationWindow): ExecutionSegment[] {
  const segments: ExecutionSegment[] = []
  let current: SimulatedStatement[] = []
  let currentKey: string | null = null

  /**
   * What SPLITS a window into segments — not necessarily who runs them.
   *
   * For a transfer the grouping key is the incoming owner, because each target
   * needs its own privilege lifecycle. The role that actually EXECUTES the
   * `ALTER ... OWNER TO` is uellix_owner in every case: measured, PG 17.6, the
   * outgoing owner is the only identity that can hold both the ownership of the
   * object and (temporarily) membership in the incoming owner. Conflating the
   * two was a real defect, and it was the generated-output validator that
   * caught it — the emitted SQL was right and the field describing it was not.
   */
  const groupKeyOf = (row: SimulatedStatement): string => {
    if (window.authorityClass === 'OWNER') return OWNER_ROLE
    if (window.authorityClass === 'OWNER_TRANSFER') return row.ownerDestination ?? OWNER_ROLE
    // CAPABILITY: the exact role that owns the object right now.
    //
    // F-07. An unknown owner used to fall back to uellix_owner. That is the
    // unsafe direction: it silently promotes an unclassifiable statement into
    // the most privileged executor the plan has. Unknown now refuses.
    if (row.ownerBefore === null) {
      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTOR_OWNER_UNKNOWN',
        `${window.packageId}/${window.windowId}: statement ${row.statement.index} sits in a ` +
          `CAPABILITY window but the ownership simulation could not determine who owns its ` +
          `target. There is no safe default here — falling back to uellix_owner would run it as ` +
          `the most privileged role in the plan.`,
      )
    }
    if (row.ownerBefore.startsWith('MULTIPLE:')) {
      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTION_SEGMENT_MULTIPLE_ROLES',
        `${window.packageId}/${window.windowId}: statement ${row.statement.index} is a DO block ` +
          `whose governed objects resolve to more than one capability role (${row.ownerBefore}). ` +
          `A DO block executes under ONE current_role and cannot be split, so this is refused ` +
          `rather than run partially under each.`,
      )
    }
    return row.ownerBefore
  }

  const flush = (): void => {
    if (current.length === 0) return
    const groupKey = currentKey as string
    // The executor is the role that runs the statements. For a transfer that is
    // always the outgoing owner; the incoming owner is the DESTINATION.
    const executor = window.authorityClass === 'OWNER_TRANSFER' ? OWNER_ROLE : groupKey
    const digests = current.map((r) => normalizedExecutableDigest(r.statement.raw))
    const isTransfer = window.authorityClass === 'OWNER_TRANSFER'
    const isCapability = window.authorityClass === 'CAPABILITY'

    // A capability segment needs CREATE on the schema only if it actually
    // creates something — `CREATE OR REPLACE` against a routine the capability
    // role already owns. Marking the whole window would grant CREATE for
    // statements that merely REVOKE or COMMENT.
    const createsInSchema = current.find(
      (r) => r.identity.statementClass.startsWith('create-') && r.identity.object?.schema != null,
    )
    // A transfer needs it too: PostgreSQL checks CREATE on the containing schema
    // against the NEW owner (S1-DEFECT-001, learned the hard way in staging).
    const transferTarget = isTransfer ? current[0].identity.object?.schema ?? null : null

    segments.push({
      classificationWindowId: window.windowId,
      segmentId: `${window.windowId}.S${segments.length + 1}`,
      packageId: window.packageId,
      authorityClass: window.authorityClass,
      executor,
      ownerDestination: isTransfer ? groupKey : null,
      startStatementIdentity: statementIdentityKey(current[0].identity),
      endStatementIdentity: statementIdentityKey(current[current.length - 1].identity),
      statementCount: current.length,
      statementDigestSequence: digests,
      requiredTemporaryMemberships: isTransfer ? [OWNER_ROLE, groupKey] : [executor],
      requiredTemporarySchemaCreate: isTransfer
        ? transferTarget
        : isCapability && createsInSchema !== undefined
          ? (createsInSchema.identity.object?.schema ?? null)
          : null,
      entryState: 'installer',
      exitState: 'installer',
    })
    current = []
  }

  for (const row of window.members) {
    const key = groupKeyOf(row)
    if (key !== currentKey) {
      flush()
      currentKey = key
    }
    current.push(row)
  }
  flush()

  return segments
}

/* -------------------------------------------------------------------------- */
/* Building the plan                                                           */
/* -------------------------------------------------------------------------- */

export function buildAuthorityPlan(root = process.cwd()): AuthorityPlan {
  const { rows } = simulateChainOwnership(root)
  const rowsByPackage = new Map<string, SimulatedStatement[]>()
  for (const row of rows) {
    const list = rowsByPackage.get(row.packageId) ?? []
    list.push(row)
    rowsByPackage.set(row.packageId, list)
  }

  const windows: ResolvedClassificationWindow[] = []

  for (const recovered of RECOVERED_WINDOWS) {
    const packageRows = rowsByPackage.get(recovered.packageId)
    if (packageRows === undefined) {
      throw new AuthorityRefusal(
        'AUTHORITY_WINDOW_START_ANCHOR_MISSING',
        `${recovered.windowId}: package ${recovered.packageId} is not in the chain`,
      )
    }

    const startIndex = resolveBoundary(packageRows, recovered, recovered.start, 'start')
    const endIndex = resolveBoundary(packageRows, recovered, recovered.end, 'end')
    if (endIndex < startIndex) {
      throw new AuthorityRefusal(
        'AUTHORITY_WINDOW_ANCHOR_ORDER',
        `${recovered.packageId}/${recovered.windowId}: end anchor resolves before start anchor.`,
      )
    }

    const members = packageRows.slice(startIndex, endIndex + 1)
    const classes = new Set<StatementClass>(members.map((m) => m.identity.statementClass))

    windows.push({
      windowId: recovered.windowId,
      packageId: recovered.packageId,
      authorityClass: recovered.authorityClass,
      authoritySource: 'ORIGINAL_STATEFUL_PARTITION',
      authorityModelVersion: 'A_FINAL_STATEFUL_V1',
      startStatementIdentity: statementIdentityKey(members[0].identity),
      endStatementIdentity: statementIdentityKey(members[members.length - 1].identity),
      historicalStatementCount: recovered.historicalCount,
      structuralStatementCount: members.length,
      allowedStatementClasses: [...classes].sort(),
      statementDigestSequence: members.map((m) => normalizedExecutableDigest(m.statement.raw)),
      members,
      describedAs: recovered.describedAs,
    })
  }

  const segments = windows.flatMap(segmentWindow)

  return { windows, segments, rowsByPackage }
}

/* -------------------------------------------------------------------------- */
/* Partition                                                                   */
/* -------------------------------------------------------------------------- */

export interface PartitionCounts {
  readonly installer: number
  readonly owner: number
  readonly capability: number
  readonly ownerTransfer: number
  readonly managedRewrite: number
  readonly bookkeeping: number
  readonly excluded: number
  readonly total: number
}

export interface PartitionResult {
  readonly counts: PartitionCounts
  readonly installerStatements: readonly SimulatedStatement[]
  /** Statements whose simulated ownerBefore disagrees with their window class. */
  readonly disagreements: readonly {
    readonly row: SimulatedStatement
    readonly windowId: string
    readonly windowClass: AuthorityClass
    readonly simulated: string
  }[]
}

/**
 * Derives the hosted statement partition FROM the recovered windows, and
 * crosschecks every governed statement against the simulated `ownerBefore`.
 *
 * The windows are authoritative for classification; the simulation is the
 * independent check. Where they disagree, the disagreement is reported rather
 * than resolved in either direction — that is what makes it a check.
 */
export function partitionHostedStatements(plan: AuthorityPlan): PartitionResult {
  const windowOf = new Map<string, ResolvedClassificationWindow>()
  const governedIndexes = new Map<string, Set<number>>()

  for (const window of plan.windows) {
    const set = governedIndexes.get(window.packageId) ?? new Set<number>()
    for (const member of window.members) {
      set.add(member.statement.index)
      windowOf.set(`${window.packageId}:${member.statement.index}`, window)
    }
    governedIndexes.set(window.packageId, set)
  }

  let installer = 0
  let owner = 0
  let capability = 0
  let ownerTransfer = 0
  let managedRewrite = 0
  let bookkeeping = 0
  let excluded = 0
  let total = 0

  const installerStatements: SimulatedStatement[] = []
  const disagreements: PartitionResult['disagreements'] = []

  for (const entry of CHAIN_PACKAGE_FILES) {
    const rows = plan.rowsByPackage.get(entry.packageId) ?? []
    const governed = governedIndexes.get(entry.packageId) ?? new Set<number>()

    for (const row of rows) {
      total += 1
      const window = windowOf.get(`${entry.packageId}:${row.statement.index}`)

      if (window !== undefined) {
        if (window.authorityClass === 'OWNER') owner += 1
        else if (window.authorityClass === 'CAPABILITY') capability += 1
        else ownerTransfer += 1

        const simulated = authorityFromOwnerBefore(row.ownerBefore)
        const expected =
          window.authorityClass === 'OWNER_TRANSFER' ? 'OWNER' : window.authorityClass

        // An `ALTER ... OWNER TO r` over an object r ALREADY owns is not a
        // disagreement, it is an idempotent re-assert: `CREATE OR REPLACE`
        // preserves the owner, so a package that recreates a capability-owned
        // routine and re-states the transfer changes nothing. Measured, four
        // times, in T7/W39, T8/W46 and T9/W50. Flagging them would train a
        // reviewer to ignore this report, which is worse than not having it.
        const idempotentReassert =
          window.authorityClass === 'OWNER_TRANSFER' && row.ownerBefore === row.ownerDestination

        if (simulated !== 'INDETERMINATE' && simulated !== expected && !idempotentReassert) {
          ;(disagreements as PartitionResult['disagreements'][number][]).push({
            row,
            windowId: window.windowId,
            windowClass: window.authorityClass,
            simulated: `${simulated} (ownerBefore=${row.ownerBefore})`,
          })
        }
        continue
      }

      if (isExcludedFromPartition(row, governed)) {
        excluded += 1
        continue
      }
      if (isBookkeeping(row.identity.statementClass)) {
        bookkeeping += 1
        continue
      }
      if (isManagedRewrite(row)) {
        managedRewrite += 1
        continue
      }
      installer += 1
      installerStatements.push(row)
    }
  }

  return {
    counts: {
      installer,
      owner,
      capability,
      ownerTransfer,
      managedRewrite,
      bookkeeping,
      excluded,
      total,
    },
    installerStatements,
    disagreements,
  }
}

/** Re-reads a package's statements. Used by tests that verify anchors resolve. */
export function hostedStatementsOf(packageId: string, root = process.cwd()) {
  const entry = CHAIN_PACKAGE_FILES.find((e) => e.packageId === packageId)
  if (entry === undefined) throw new Error(`unknown package ${packageId}`)
  return splitSqlStatements(readFileSync(hostedArtefactPath(entry.sourceFile, root), 'utf8')).map(
    (s) => ({ statement: s, identity: parseStatementIdentity(s.raw) }),
  )
}

export { isCapabilityRoleName }

/* -------------------------------------------------------------------------- */
/* Segment-level invariants — the red-team surface                             */
/* -------------------------------------------------------------------------- */

/**
 * Refuses a segmentation that runs statements of two different capability roles
 * under one `current_role`.
 *
 * This is red-team 17: force W38 to a single executor and see what happens. It
 * would "work" — PostgreSQL would let `uellix_cap_stella_quota` run statements
 * about ticket-owned functions if it happened to hold the privilege — and that
 * is exactly why it has to be refused structurally rather than left to fail at
 * apply time. When it does NOT fail, the plan has silently widened a role.
 */
export function assertSingleExecutorPerSegment(
  segments: readonly ExecutionSegment[],
  rowsOf: (segment: ExecutionSegment) => readonly SimulatedStatement[],
): void {
  for (const segment of segments) {
    if (segment.authorityClass !== 'CAPABILITY') continue
    const executors = new Set(
      rowsOf(segment)
        .map((row) => row.ownerBefore)
        .filter((owner): owner is string => owner !== null),
    )
    if (executors.size > 1) {
      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTION_SEGMENT_MULTIPLE_ROLES',
        `${segment.segmentId} would run statements owned by ${[...executors].sort().join(' and ')} ` +
          `under a single current_role (${segment.executor}). PostgreSQL has one effective ` +
          `current_role, so this is a privilege widening, not a packaging choice.`,
      )
    }
  }
}

/**
 * Refuses a transfer segment that opens temporary privilege for more than one
 * capability role at a time.
 *
 * Red-team 18. W46 transfers to two different roles; segmenting it by target
 * means neither lifecycle is open while the other runs. A segment that asked for
 * both memberships would hold elevation it does not need for statements that do
 * not need it.
 */
export function assertNoConcurrentCapabilityLifecycles(
  segments: readonly ExecutionSegment[],
): void {
  for (const segment of segments) {
    const capabilities = segment.requiredTemporaryMemberships.filter(isCapabilityRoleName)
    if (capabilities.length > 1) {
      throw new AuthorityRefusal(
        'AUTHORITY_CONCURRENT_CAPABILITY_LIFECYCLES',
        `${segment.segmentId} opens temporary membership in ${capabilities.join(' and ')} at the ` +
          `same time. Segment by target instead: each capability lifecycle opens, runs its own ` +
          `contiguous statements, and closes before the next one opens.`,
      )
    }
  }
}

/**
 * Refuses a segment whose declared executor is not the one the ownership
 * simulation derives.
 *
 * Red-team 22: leave the classification window correct and mutate only the
 * execution role. Nothing about the window changes — same anchors, same count,
 * same digests — so only a check that re-derives the executor from `ownerBefore`
 * can see it.
 */
export function assertExecutorMatchesOwnership(
  segment: ExecutionSegment,
  rows: readonly SimulatedStatement[],
): void {
  for (const row of rows) {
    if (segment.authorityClass === 'OWNER_TRANSFER') {
      if (segment.executor !== OWNER_ROLE) {
        throw new AuthorityRefusal(
          'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
          `${segment.segmentId} declares executor ${segment.executor}; an ownership transfer runs ` +
            `as ${OWNER_ROLE} and transfers TO its destination.`,
        )
      }
      if (row.ownerDestination !== segment.ownerDestination) {
        throw new AuthorityRefusal(
          'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
          `${segment.segmentId} declares destination ${segment.ownerDestination} but statement ` +
            `${row.statement.index} transfers to ${row.ownerDestination}.`,
        )
      }
      continue
    }

    const derived = row.ownerBefore
    if (segment.authorityClass === 'OWNER') {
      if (row.ownerBefore !== null && row.ownerBefore !== OWNER_ROLE) {
        throw new AuthorityRefusal(
          'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
          `${segment.segmentId} declares uellix_owner but statement ${row.statement.index} has ` +
            `ownerBefore=${row.ownerBefore}.`,
        )
      }
      continue
    }
    if (derived !== null && derived !== segment.executor) {
      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
        `${segment.segmentId} declares executor ${segment.executor} but statement ` +
          `${row.statement.index} resolves to ${derived}. The classification window is unchanged, ` +
          `so only re-deriving the executor from ownerBefore can see this.`,
      )
    }
  }
}

/**
 * Refuses a DO block whose governed objects resolve to two capability roles.
 *
 * Red-team 19. A DO block runs entirely under one `current_role` and cannot be
 * split, so there is no correct way to execute one that needs two. W29 is the
 * only governed DO with a capability executor today and it resolves to exactly
 * one; this is the guard for the next one.
 */
export function assertDoBlockHasOneExecutor(row: SimulatedStatement): void {
  if (row.identity.statementClass !== 'do-block') return
  if (row.ownerBefore === null || !row.ownerBefore.startsWith('MULTIPLE:')) return
  throw new AuthorityRefusal(
    'AUTHORITY_DO_MULTIPLE_EXECUTORS',
    `${row.packageId} statement ${row.statement.index}: the DO block governs objects owned by ` +
      `${row.ownerBefore.slice('MULTIPLE:'.length)}. A DO block executes under one current_role ` +
      `and cannot be segmented, so this is refused rather than run partially under each role.`,
  )
}

/** Members of a segment, recovered from the plan by digest position. */
export function segmentRows(plan: AuthorityPlan, segment: ExecutionSegment): SimulatedStatement[] {
  const window = plan.windows.find((w) => w.windowId === segment.classificationWindowId)
  if (window === undefined) return []
  const siblings = plan.segments.filter((s) => s.classificationWindowId === window.windowId)
  let offset = 0
  for (const sibling of siblings) {
    if (sibling.segmentId === segment.segmentId) break
    offset += sibling.statementCount
  }
  return window.members.slice(offset, offset + segment.statementCount)
}

/** Test seam: exercises the segmentation refusals on a synthesised window. */
export function segmentWindowForTest(window: ResolvedClassificationWindow): ExecutionSegment[] {
  return segmentWindow(window)
}

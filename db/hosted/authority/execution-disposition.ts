// db/hosted/authority/execution-disposition.ts
// COMMIT 3.1 — F-01 crosscheck, and the pre-generation gate.
//
// ---------------------------------------------------------------------------
// NO RESIDUAL BUCKET
// ---------------------------------------------------------------------------
// The version this replaces ended with "everything else is an installer
// statement". That is the shape of a defect, not of a rule: it is satisfied by
// every statement nobody thought about, including three CREATE TABLEs that had
// to run as uellix_owner and would silently have been created by `postgres`.
//
// So every canonical statement must now resolve to one of five dispositions,
// each of which had to be argued for, and anything left over REFUSES.
//
//   EXECUTION_SEGMENT        a classification window governs it
//   CANONICAL_ROLE_CONTEXT   outside every window, but canonically enclosed in
//                            a SET ROLE span, so the role is still mandatory
//   INSTALLER                justified: it acts on an object the installer owns,
//                            or it creates a schema (a database-level act)
//   MANAGED_REWRITE          the ALTER ROLE a managed installer cannot issue
//   BOOKKEEPING_OR_EXCLUDED  with a named reason, never "other"
//
// "Justified" is the load-bearing word for INSTALLER. It is not the fallback
// branch; it has a positive test, and a statement that fails it is refused.

import {
  deriveCanonicalExecutionContexts,
  type CanonicalExecutionContext,
} from './canonical-role-context'
import {
  assertCleanupComplete,
  capabilityWindowPrimitive,
  membershipEdges,
  ownerTransferPrimitive,
  ownerWindowPrimitive,
  type AuthorityPrimitive,
} from './primitives'
import {
  assertReachabilityMatchesExpectation,
  expectedReachabilityFor,
} from './expected-reachability'
import { AUTHORITY_ROLE_REGISTRY, type HostedRoleIdentifier } from './role-registry'
import {
  INSTALLER_OWNER,
  isCapabilityRoleName,
  OWNER_ROLE,
  type SimulatedStatement,
} from './ownership-simulation'
import {
  assertDoBlockHasOneExecutor,
  assertExecutorMatchesOwnership,
  assertNoConcurrentCapabilityLifecycles,
  assertSingleExecutorPerSegment,
  partitionHostedStatements,
  segmentRows,
  type AuthorityPlan,
} from './classification-manifest'
import { statementIdentityKey } from './structural-identity'
import { AuthorityRefusal } from './window-contract'
import {
  assertGovernedIdentitiesUnique,
  assertNoInstallerOnlyInElevatedWindow,
  assertNoWindowOverlap,
  CHAIN_PACKAGE_FILES,
} from './window-plan'

export type DispositionKind =
  | 'EXECUTION_SEGMENT'
  | 'CANONICAL_ROLE_CONTEXT'
  | 'INSTALLER'
  | 'MANAGED_REWRITE'
  | 'BOOKKEEPING_OR_EXCLUDED'

export interface StatementDisposition {
  readonly packageId: string
  readonly statementIndex: number
  readonly statementIdentity: string
  readonly kind: DispositionKind
  /** The role that must run it. `postgres` means the installer, unelevated. */
  readonly requiredExecutor: string
  /** Why this disposition and not another. Never empty. */
  readonly reason: string
}

/**
 * A statement the installer may legitimately run unelevated.
 *
 * Two positive cases, both argued:
 *
 *   the target object is owned by the installer — `public.uellix_auth_uid()`
 *   is created by the bootstrap and deliberately never transferred, because it
 *   is the one function that must reach schema `auth`;
 *
 *   it is a `CREATE SCHEMA`, which is a database-level act. The schema's owner
 *   comes from its own AUTHORIZATION clause, not from who ran the statement, so
 *   running it elevated would change nothing and running it unelevated loses
 *   nothing.
 */
function installerJustification(row: SimulatedStatement): string | null {
  if (row.identity.statementClass === 'create-schema') {
    const authorization = row.identity.operands[0]
    return (
      `CREATE SCHEMA is a database-level act; the schema's owner is fixed by its AUTHORIZATION ` +
      `clause (${authorization ?? 'none'}), not by the role that runs it`
    )
  }
  if (row.ownerBefore === INSTALLER_OWNER) {
    return `target is owned by the installer (${INSTALLER_OWNER}), so no elevation exists to take`
  }
  return null
}

function exclusionReason(row: SimulatedStatement): string | null {
  const statementClass = row.identity.statementClass
  if (statementClass === 'set-role' || statementClass === 'reset-role') {
    return 'authority bookkeeping — the derived output replaces these outright'
  }
  if (statementClass === 'set-parameter') {
    return 'session setup (SET search_path / SET lock_timeout); needs no authority'
  }
  if (statementClass === 'do-block') {
    return 'assertion block outside every window and outside every SET ROLE span'
  }
  return null
}

/**
 * Resolves every statement of every package to exactly one disposition, or
 * refuses.
 *
 * The order of the branches is the order of specificity, and each one is a
 * positive test. There is no `else` that swallows the remainder.
 */
export function resolveExecutionDispositions(plan: AuthorityPlan): StatementDisposition[] {
  const out: StatementDisposition[] = []

  const governedByPackage = new Map<string, Set<number>>()
  const executorByStatement = new Map<string, string>()

  for (const window of plan.windows) {
    const set = governedByPackage.get(window.packageId) ?? new Set<number>()
    for (const member of window.members) set.add(member.statement.index)
    governedByPackage.set(window.packageId, set)
  }
  for (const segment of plan.segments) {
    for (const row of segmentRows(plan, segment)) {
      executorByStatement.set(`${row.packageId}:${row.statement.index}`, segment.executor)
    }
  }

  for (const entry of CHAIN_PACKAGE_FILES) {
    const rows = plan.rowsByPackage.get(entry.packageId) ?? []
    const governed = governedByPackage.get(entry.packageId) ?? new Set<number>()
    const contexts = deriveCanonicalExecutionContexts(entry.packageId, rows, governed)
    const contextByIndex = new Map(contexts.map((c) => [c.statementIndex, c]))

    for (const row of rows) {
      const key = `${entry.packageId}:${row.statement.index}`
      const identity = statementIdentityKey(row.identity)
      const base = {
        packageId: entry.packageId,
        statementIndex: row.statement.index,
        statementIdentity: identity,
      }

      if (governed.has(row.statement.index)) {
        const executor = executorByStatement.get(key)
        if (executor === undefined) {
          throw new AuthorityRefusal(
            'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
            `${key} is inside a classification window but no execution segment covers it. The ` +
              `segmentation does not partition its window.`,
          )
        }
        out.push({
          ...base,
          kind: 'EXECUTION_SEGMENT',
          requiredExecutor: executor,
          reason: 'governed by a classification window and its execution segment',
        })
        continue
      }

      const context = contextByIndex.get(row.statement.index)
      if (context !== undefined) {
        out.push({
          ...base,
          kind: 'CANONICAL_ROLE_CONTEXT',
          requiredExecutor: context.requiredExecutor,
          reason:
            `outside every classification window, but the canonical migration encloses it in a ` +
            `SET ROLE ${context.requiredExecutor} span (${context.spanOpenedBy}); the role that ` +
            `runs it decides what it produces`,
        })
        continue
      }

      if (row.identity.statementClass === 'alter-role') {
        out.push({
          ...base,
          kind: 'MANAGED_REWRITE',
          requiredExecutor: INSTALLER_OWNER,
          reason: 'role attribute normalization a managed installer rewrites rather than issues',
        })
        continue
      }

      const excluded = exclusionReason(row)
      if (excluded !== null) {
        out.push({
          ...base,
          kind: 'BOOKKEEPING_OR_EXCLUDED',
          requiredExecutor: INSTALLER_OWNER,
          reason: excluded,
        })
        continue
      }

      const justified = installerJustification(row)
      if (justified !== null) {
        out.push({
          ...base,
          kind: 'INSTALLER',
          requiredExecutor: INSTALLER_OWNER,
          reason: justified,
        })
        continue
      }

      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
        `${key} resolves to no execution disposition. It is not in a classification window, not ` +
          `inside a canonical SET ROLE span, not bookkeeping, and there is no positive reason the ` +
          `installer may run it: ownerBefore=${row.ownerBefore}, class=` +
          `${row.identity.statementClass}. Refused rather than defaulted to installer — that ` +
          `default is what would have created three tables under the wrong owner.\n    ` +
          `${row.statement.executable.slice(0, 160)}`,
      )
    }
  }

  return out
}

/* -------------------------------------------------------------------------- */
/* F-08B — the one gate Commit 4 must call                                     */
/* -------------------------------------------------------------------------- */

export interface GenerationGateResult {
  readonly dispositions: readonly StatementDisposition[]
  readonly canonicalRoleContexts: readonly CanonicalExecutionContext[]
  readonly checks: readonly string[]
}

/**
 * The single entry point a generator must pass before it emits one byte.
 *
 * Everything below was previously reachable only by a test calling a validator
 * by hand, which means a generator could have been written that never called
 * any of them and still shipped. One function, called once, with no way to run
 * a subset.
 *
 * On failure it throws. There is no partial result and no "warnings" channel:
 * a generator that got a value back is a generator that may emit.
 */
export function validateResolvedAuthorityPlanForGeneration(
  plan: AuthorityPlan,
): GenerationGateResult {
  const checks: string[] = []

  // 1. Every governed statement identity is unique within its package.
  for (const entry of CHAIN_PACKAGE_FILES) {
    const rows = plan.rowsByPackage.get(entry.packageId) ?? []
    assertGovernedIdentitiesUnique(
      entry.packageId,
      rows.map((r) => r.statement),
    )
  }
  checks.push('governed statement identities unique per package')

  // 2. No window overlaps another, per package.
  for (const entry of CHAIN_PACKAGE_FILES) {
    const spans = plan.windows
      .filter((w) => w.packageId === entry.packageId)
      .map((w) => ({
        windowId: w.windowId,
        startIndex: w.members[0].statement.index,
        endIndex: w.members[w.members.length - 1].statement.index,
      }))
    assertNoWindowOverlap(entry.packageId, spans)
  }
  checks.push('no classification window overlaps another')

  // 3. No installer-only class inside an elevated window.
  for (const window of plan.windows) {
    assertNoInstallerOnlyInElevatedWindow(
      `${window.packageId}/${window.windowId}`,
      window.members.map((m) => m.statement),
    )
  }
  checks.push('no installer-only statement inside an elevated window')

  // 4. Digest sequences match what the packages hash to right now.
  for (const window of plan.windows) {
    if (window.statementDigestSequence.length !== window.structuralStatementCount) {
      throw new AuthorityRefusal(
        'AUTHORITY_WINDOW_DIGEST_DRIFT',
        `${window.packageId}/${window.windowId}: ${window.statementDigestSequence.length} digests ` +
          `pinned for ${window.structuralStatementCount} statements.`,
      )
    }
  }
  checks.push('every window pins one digest per governed statement')

  // 5. Segmentation partitions its window, one executor each, order preserved.
  for (const window of plan.windows) {
    const segments = plan.segments.filter((s) => s.classificationWindowId === window.windowId)
    const covered = segments.reduce((n, s) => n + s.statementCount, 0)
    if (covered !== window.structuralStatementCount) {
      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
        `${window.packageId}/${window.windowId}: segments cover ${covered} of ` +
          `${window.structuralStatementCount} statements.`,
      )
    }
    const rebuilt = segments.flatMap((s) => s.statementDigestSequence)
    for (const [i, digest] of window.statementDigestSequence.entries()) {
      if (rebuilt[i] !== digest) {
        throw new AuthorityRefusal(
          'AUTHORITY_CANONICAL_ORDER_VIOLATION',
          `${window.packageId}/${window.windowId}: segmentation reorders statement ${i}.`,
        )
      }
    }
  }
  assertSingleExecutorPerSegment(plan.segments, (segment) => segmentRows(plan, segment))
  assertNoConcurrentCapabilityLifecycles(plan.segments)
  for (const segment of plan.segments) {
    assertExecutorMatchesOwnership(segment, segmentRows(plan, segment))
  }
  checks.push('segments partition their window, one executor each, canonical order preserved')

  // 6. No governed DO block needs two executors.
  for (const window of plan.windows) {
    for (const member of window.members) assertDoBlockHasOneExecutor(member)
  }
  checks.push('no governed DO block requires two capability executors')

  // 7. Execution disposition resolves for EVERY statement — the F-01 crosscheck.
  const dispositions = resolveExecutionDispositions(plan)
  checks.push('every statement resolves to exactly one execution disposition')

  // 8. Every segment's primitive is balanced AND produces exactly the topology
  //    its own class declares — not "no transitive path", which an ownership
  //    transfer cannot satisfy and which the old check could only answer with a
  //    blanket yes or no. Each phase is compared against an expected graph, so
  //    an unknown edge refuses just as loudly as a forbidden one.
  const installer: HostedRoleIdentifier = 'uellix_migrator'
  const runtimePrincipals = AUTHORITY_ROLE_REGISTRY.filter((r) => r.kind === 'runtime').map(
    (r) => r.id as string,
  )

  for (const segment of plan.segments) {
    const primitive: AuthorityPrimitive =
      segment.authorityClass === 'OWNER_TRANSFER'
        ? ownerTransferPrimitive({
            installer,
            fromOwner: 'uellix_owner',
            targetCapability: segment.ownerDestination as HostedRoleIdentifier,
            schema: segment.requiredTemporarySchemaCreate ?? '',
            segmentId: segment.segmentId,
          })
        : segment.authorityClass === 'CAPABILITY'
          ? capabilityWindowPrimitive({
              installer,
              capabilityRole: segment.executor as HostedRoleIdentifier,
              schema: segment.requiredTemporarySchemaCreate ?? '',
              needsTemporarySchemaCreate: segment.requiredTemporarySchemaCreate !== null,
            })
          : ownerWindowPrimitive(installer)

    assertCleanupComplete(segment.segmentId, primitive)

    const phases = expectedReachabilityFor({
      segmentId: segment.segmentId,
      authorityClass: segment.authorityClass,
      executor: segment.executor,
      ownerDestination: segment.ownerDestination,
      installer,
      runtimePrincipals,
    })

    const persistent = membershipEdges([`GRANT uellix_owner TO ${installer} WITH SET TRUE;`])
    const duringEdges = [...persistent, ...membershipEdges([...primitive.open])]

    assertReachabilityMatchesExpectation(persistent, phases[0])
    assertReachabilityMatchesExpectation(duringEdges, phases[1])
    assertReachabilityMatchesExpectation(persistent, phases[2])
  }
  checks.push(
    'every execution segment is balanced and matches its expected reachability graph in all three phases',
  )

  // 9. Every executor named is a role the plan may act as.
  for (const disposition of dispositions) {
    const executor = disposition.requiredExecutor
    if (executor === INSTALLER_OWNER) continue
    if (executor === OWNER_ROLE || isCapabilityRoleName(executor)) continue
    throw new AuthorityRefusal(
      'AUTHORITY_UNKNOWN_ROLE',
      `${disposition.packageId}[${disposition.statementIndex}] would run as \`${executor}\`, ` +
        `which is neither the installer, the owner, nor a capability role.`,
    )
  }
  checks.push('every required executor is the installer, the owner, or a capability role')

  const canonicalRoleContexts: CanonicalExecutionContext[] = []
  for (const entry of CHAIN_PACKAGE_FILES) {
    const rows = plan.rowsByPackage.get(entry.packageId) ?? []
    const governed = new Set(
      plan.windows
        .filter((w) => w.packageId === entry.packageId)
        .flatMap((w) => w.members.map((m) => m.statement.index)),
    )
    canonicalRoleContexts.push(...deriveCanonicalExecutionContexts(entry.packageId, rows, governed))
  }

  // The provenance partition must still be what the recovered table says. It is
  // computed here so the gate fails if a future edit drifts it.
  partitionHostedStatements(plan)
  checks.push('provenance partition recomputed without refusal')

  return { dispositions, canonicalRoleContexts, checks }
}

// db/hosted/authority/generated-output-validator.ts
// COMMIT 4 — the output side. What the generator MEANT is not evidence.
//
// ---------------------------------------------------------------------------
// WHY THIS RE-READS THE SQL INSTEAD OF TRUSTING THE EMISSION
// ---------------------------------------------------------------------------
// The generator already knows which segment each statement belongs to and which
// role it intends to run as. Asking it to confirm its own intentions proves
// nothing: a generator with a bug produces wrong SQL and a matching wrong belief
// about it. So this parses the GENERATED TEXT back into statements and
// re-derives the role in force at each one from the emitted `SET ROLE` /
// `RESET ROLE` alone — the same way PostgreSQL will.
//
// The only thing it is handed is the PLAN, because the plan is the
// specification being checked against. Everything else comes from the bytes.
//
// The first draft of this file got that wrong in an instructive way: it aligned
// the generator's emission list with the parsed statements BY POSITION. A
// comment-only authority line produces no statement at all, so the two lists
// drift, and it reported a role mismatch that did not exist. Alignment is now
// by IDENTITY — at each parsed statement, "is this the next canonical statement
// the plan expects?", and failing that, "is this an authority statement I
// recognise?". A no to both is an unknown executable disposition, and it
// refuses.
//
// ---------------------------------------------------------------------------
// WHAT THE ROLE SIMULATION IS FOR
// ---------------------------------------------------------------------------
// A generated package is applied by one session under `psql -1`. The role in
// force is whatever the last transition left, and there is no stack (lab M6).
// Walking from the top is the only honest way to know who runs a canonical
// statement — and it is what catches the failure this whole train exists to
// prevent: a CREATE TABLE executing as the installer because an elevation
// closed one statement early. Nothing would error; the table would simply
// belong to the wrong role forever.

import { normalizeExecutable, splitSqlStatements } from './sql-statements'
import { parseStatementIdentity, statementIdentityKey, type StatementIdentity } from './structural-identity'
import { parseMembershipStatement } from './membership'
import { assertNoSessionRoleGrantee } from './membership-tripwire'
import { AUTHORITY_ROLE_REGISTRY } from './role-registry'
import { INSTALLER_OWNER, OWNER_ROLE, isCapabilityRoleName } from './ownership-simulation'
import { setReachabilityClosure } from './expected-reachability'
import { INSTALLER_ONLY_CLASSES } from './window-plan'
import { segmentRows, type AuthorityPlan } from './classification-manifest'
import { resolveExecutionDispositions } from './execution-disposition'
import { GOVERNED_INSTALLER, type GeneratedGovernedPackage } from './governed-generator'
import { AuthorityRefusal } from './window-contract'

const INSTALLER_ONLY = new Set<string>(INSTALLER_ONLY_CLASSES)
const RUNTIME_ROLES: readonly string[] = AUTHORITY_ROLE_REGISTRY.filter(
  (r) => r.kind === 'runtime',
).map((r) => r.id)

/** Principals that belong to the provider. The chain never names them. */
const PROVIDER_ROLES = ['supabase_admin', 'supabase_auth_admin', 'postgres', 'authenticator']

export interface GeneratedValidationResult {
  readonly packageId: string
  readonly checks: readonly string[]
}

interface RoleWalkStep {
  readonly index: number
  /** The role in force WHEN THIS STATEMENT RUNS, derived from the bytes. */
  readonly role: string
  readonly identity: StatementIdentity
  readonly raw: string
}

function walkRoles(packageId: string, sql: string): RoleWalkStep[] {
  const steps: RoleWalkStep[] = []
  let role = INSTALLER_OWNER

  for (const statement of splitSqlStatements(sql)) {
    const identity = parseStatementIdentity(statement.raw)

    if (identity.statementClass === 'set-role') {
      if (role !== INSTALLER_OWNER) {
        throw new AuthorityRefusal(
          'AUTHORITY_ROLE_CONTEXT_AMBIGUOUS',
          `${packageId}: generated statement ${statement.index} enters ${identity.operands[0]} ` +
            `while already acting as ${role}. PostgreSQL does not stack SET ROLE (lab M6): the ` +
            `matching RESET would land on the session role and everything after it would run ` +
            `unelevated.`,
        )
      }
      steps.push({ index: statement.index, role, identity, raw: statement.raw })
      role = identity.operands[0]
      continue
    }

    if (identity.statementClass === 'reset-role') {
      if (role === INSTALLER_OWNER) {
        throw new AuthorityRefusal(
          'AUTHORITY_ROLE_CONTEXT_AMBIGUOUS',
          `${packageId}: generated statement ${statement.index} resets a role that is not open.`,
        )
      }
      steps.push({ index: statement.index, role, identity, raw: statement.raw })
      role = INSTALLER_OWNER
      continue
    }

    steps.push({ index: statement.index, role, identity, raw: statement.raw })
  }

  if (role !== INSTALLER_OWNER) {
    throw new AuthorityRefusal(
      'AUTHORITY_STATE_TRANSITION_INVALID',
      `${packageId}: the generated package ends while still acting as ${role}.`,
    )
  }

  return steps
}

/**
 * The closed set of authority statement shapes the generator may emit.
 *
 * Anything else in a generated package is an executable statement with no
 * disposition. There is no "probably fine" branch, because the statements that
 * would land in it are precisely the ones nobody thought about.
 */
function isRecognisedAuthorityStatement(step: RoleWalkStep): boolean {
  const statementClass = step.identity.statementClass
  if (statementClass === 'set-role' || statementClass === 'reset-role') return true
  if (parseMembershipStatement(step.raw) !== null) return true
  if (
    (statementClass === 'grant-privilege' || statementClass === 'revoke-privilege') &&
    step.identity.object?.objectClass === 'schema' &&
    step.identity.operands[0].split('+').some((p) => p === 'CREATE' || p === 'ALL')
  ) {
    return true
  }
  return false
}

function isSegmentBoundary(plan: AuthorityPlan, packageId: string, sourceIndex: number): boolean {
  for (const segment of plan.segments) {
    if (segment.packageId !== packageId) continue
    const rows = segmentRows(plan, segment)
    if (rows[rows.length - 1].statement.index === sourceIndex) return true
  }
  return false
}

/** The pinned case-G order, checked against the emitted text of one segment. */
function assertCaseGShape(
  where: string,
  segmentId: string,
  target: string,
  generated: GeneratedGovernedPackage,
): void {
  const emitted = generated.statements
    .filter((s) => s.segmentId === segmentId && s.origin === 'authority' && !s.sql.startsWith('--'))
    .map((s) => normalizeExecutable(s.sql))

  const expectedOrder = [
    `GRANT ${target} TO ${OWNER_ROLE}`,
    `SET ROLE ${OWNER_ROLE};`,
    'GRANT CREATE ON SCHEMA',
    'REVOKE CREATE ON SCHEMA',
    'RESET ROLE;',
    `REVOKE ${target} FROM ${OWNER_ROLE};`,
  ]

  // The shape of the grant, not only its presence. A `WITH SET FALSE` grant
  // creates no SET path at all (lab: `must be able to SET ROLE`), and an
  // INHERIT grant would make the owner carry the capability on every statement
  // rather than only when it announces itself. Both are well-formed SQL that
  // reads correctly and does the wrong thing.
  const grant = generated.statements.find(
    (st) =>
      st.segmentId === segmentId &&
      st.origin === 'authority' &&
      st.sql.startsWith(`GRANT ${target} TO ${OWNER_ROLE}`),
  )
  if (grant === undefined) {
    throw new AuthorityRefusal(
      'AUTHORITY_CLEANUP_INCOMPLETE',
      `${where}: transfer ${segmentId} never grants ${target} to ${OWNER_ROLE}.`,
    )
  }
  const membership = parseMembershipStatement(grant.sql)
  if (membership === null || !membership.setOption) {
    throw new AuthorityRefusal(
      'AUTHORITY_STATE_TRANSITION_INVALID',
      `${where}: transfer ${segmentId} grants ${target} to ${OWNER_ROLE} without SET. The ALTER ` +
        `would then be refused with \`must be able to SET ROLE\` — measured, PG 17.6.`,
    )
  }
  if (membership.inheritOption === true) {
    throw new AuthorityRefusal(
      'AUTHORITY_STATE_TRANSITION_INVALID',
      `${where}: transfer ${segmentId} grants ${target} to ${OWNER_ROLE} WITH INHERIT. The owner ` +
        `would then carry the capability on every statement, not only when it announces itself.`,
    )
  }

  let cursor = 0
  for (const fragment of expectedOrder) {
    const at = emitted.findIndex((sql, i) => i >= cursor && sql.includes(fragment))
    if (at === -1) {
      throw new AuthorityRefusal(
        'AUTHORITY_CLEANUP_INCOMPLETE',
        `${where}: transfer ${segmentId} is missing \`${fragment}\` in case-G order. The measured ` +
          `sequence is: grant the target to the owner, elevate, open schema CREATE, transfer, ` +
          `close schema CREATE, stand down, revoke the membership.`,
      )
    }
    cursor = at + 1
  }
}

export function validateGeneratedPackage(
  plan: AuthorityPlan,
  generated: GeneratedGovernedPackage,
): GeneratedValidationResult {
  const { packageId } = generated
  const checks: string[] = []
  const where = `generated ${packageId}`

  const steps = walkRoles(packageId, generated.sql)
  checks.push('role state machine: starts and ends as the installer, no nested SET ROLE')

  const inputRows = plan.rowsByPackage.get(packageId) ?? []
  const dispositions = resolveExecutionDispositions(plan).filter((d) => d.packageId === packageId)
  const dispositionByIndex = new Map(dispositions.map((d) => [d.statementIndex, d]))

  /* A / B / executor agreement — matched by identity, not by position ------ */
  const expected = inputRows
    .filter((row) => {
      const c = row.identity.statementClass
      return c !== 'set-role' && c !== 'reset-role'
    })
    .map((row) => {
      const disposition = dispositionByIndex.get(row.statement.index)
      if (disposition === undefined) {
        throw new AuthorityRefusal(
          'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
          `${where}: source statement ${row.statement.index} has no disposition.`,
        )
      }
      return {
        key: statementIdentityKey(row.identity),
        sourceIndex: row.statement.index,
        requiredExecutor: disposition.requiredExecutor,
        kind: disposition.kind,
      }
    })

  const consumed: { sourceIndex: number; role: string; authorityBefore: number }[] = []
  /**
   * The steps the walk did NOT consume as canonical — i.e. the ones the
   * lifecycle inserted. The balance below is about TEMPORARY privileges, and a
   * canonical `REVOKE ALL ON SCHEMA ... FROM PUBLIC` is a permanent end state,
   * not something a segment borrowed and must give back. Counting it would have
   * reported every package as unbalanced, which is how this distinction was
   * found.
   */
  const authoritySteps: RoleWalkStep[] = []
  let cursor = 0
  let authorityBefore = 0

  for (const step of steps) {
    const stepKey = statementIdentityKey(step.identity)

    if (cursor < expected.length && stepKey === expected[cursor].key) {
      const target = expected[cursor]
      if (step.role !== target.requiredExecutor) {
        throw new AuthorityRefusal(
          'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
          `${where}: source statement ${target.sourceIndex} must run as ${target.requiredExecutor} ` +
            `(${target.kind}) but the role in force at that point is ${step.role}. Derived from ` +
            `the emitted transitions alone, the same way PostgreSQL will derive it.`,
        )
      }
      consumed.push({ sourceIndex: target.sourceIndex, role: step.role, authorityBefore })
      authorityBefore = 0
      cursor += 1
      continue
    }

    if (!isRecognisedAuthorityStatement(step)) {
      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
        `${where}: generated statement ${step.index} is neither the next canonical statement the ` +
          `plan expects (\`${expected[cursor]?.key ?? '(end of package)'}\`) nor an authority ` +
          `statement the event model understands.\n    ` +
          `${normalizeExecutable(step.raw).slice(0, 160)}`,
      )
    }
    authoritySteps.push(step)
    authorityBefore += 1
  }

  if (cursor !== expected.length) {
    throw new AuthorityRefusal(
      'AUTHORITY_CANONICAL_ORDER_VIOLATION',
      `${where}: matched ${cursor} of ${expected.length} canonical statements. One was dropped, ` +
        `reordered, or replaced by something with a different identity.`,
    )
  }
  checks.push('canonical statements: same identities, same order, none added or dropped')
  checks.push('every generated statement is an expected canonical one or a modelled authority one')
  checks.push('every canonical statement runs as the role its disposition requires')

  /* M / N — nothing illegally elevated, tripwire clean --------------------- */
  for (const step of steps) {
    if (INSTALLER_ONLY.has(step.identity.statementClass) && step.role !== INSTALLER_OWNER) {
      throw new AuthorityRefusal(
        'AUTHORITY_INSTALLER_ONLY_IN_ELEVATED_WINDOW',
        `${where}: statement ${step.index} is \`${step.identity.statementClass}\` and would run as ` +
          `${step.role}. A membership grant issued while elevated can widen the very authority the ` +
          `segment was reviewed against.`,
      )
    }
    assertNoSessionRoleGrantee(step.raw)
  }
  checks.push('no installer-only statement runs elevated; the session-principal tripwire is clean')

  /* G — classification windows stay pure ----------------------------------- */
  const consumedByIndex = new Map(consumed.map((c) => [c.sourceIndex, c]))
  for (const window of plan.windows.filter((w) => w.packageId === packageId)) {
    const members = window.members.map((m) => m.statement.index)
    for (let k = 1; k < members.length; k += 1) {
      const entry = consumedByIndex.get(members[k])
      if (entry === undefined) continue
      if (entry.authorityBefore > 0 && !isSegmentBoundary(plan, packageId, members[k - 1])) {
        throw new AuthorityRefusal(
          'AUTHORITY_INSTALLER_ONLY_IN_ELEVATED_WINDOW',
          `${where}: ${entry.authorityBefore} authority statement(s) were inserted inside ` +
            `classification window ${window.windowId}, between source statements ${members[k - 1]} ` +
            `and ${members[k]}. Windows are provenance and stay pure; lifecycles wrap segments, ` +
            `they never interleave with what a window governs.`,
        )
      }
    }
  }
  checks.push('no authority bookkeeping interleaves the statements a classification window governs')

  /* P — the canonical owner-context obligations ---------------------------- */
  const contexts = expected.filter((e) => e.kind === 'CANONICAL_ROLE_CONTEXT')
  for (const context of contexts) {
    const entry = consumedByIndex.get(context.sourceIndex)
    if (entry === undefined || entry.role !== OWNER_ROLE) {
      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
        `${where}: source statement ${context.sourceIndex} is a canonical owner-context obligation ` +
          `and must be created by ${OWNER_ROLE}; the output runs it as ${entry?.role ?? 'unknown'}.`,
      )
    }
  }
  checks.push(`${contexts.length} canonical owner-context obligation(s) execute as ${OWNER_ROLE}`)

  /* H / I — temporary privileges balance ----------------------------------- */
  const held = new Map<string, number>()
  for (const step of authoritySteps) {
    const membership = parseMembershipStatement(step.raw)
    if (membership !== null) {
      for (const role of membership.roles) {
        for (const member of membership.members) {
          const token = `membership:${role}:${member}`
          held.set(token, (held.get(token) ?? 0) + (membership.kind === 'grant' ? 1 : -1))
        }
      }
      continue
    }
    const identity = step.identity
    if (identity.object?.objectClass !== 'schema') continue
    if (identity.statementClass !== 'grant-privilege' && identity.statementClass !== 'revoke-privilege') {
      continue
    }
    if (!identity.operands[0].split('+').some((p) => p === 'CREATE' || p === 'ALL')) continue
    for (const grantee of identity.operands[1].split('+')) {
      const token = `schema-create:${identity.object.name}:${grantee}`
      held.set(
        token,
        (held.get(token) ?? 0) + (identity.statementClass === 'grant-privilege' ? 1 : -1),
      )
    }
  }
  const outstanding = [...held.entries()].filter(([, n]) => n !== 0)
  if (outstanding.length > 0) {
    throw new AuthorityRefusal(
      'AUTHORITY_CLEANUP_INCOMPLETE',
      `${where}: temporary authority does not balance: ` +
        `${outstanding.map(([t, n]) => `${t} (${n > 0 ? '+' : ''}${n})`).join(', ')}.`,
    )
  }
  checks.push('every temporary membership and every temporary schema CREATE is given back')

  /* J / K — reachability, re-derived statement by statement ---------------- */
  const edges: { role: string; member: string }[] = []
  for (const step of authoritySteps) {
    const membership = parseMembershipStatement(step.raw)
    if (membership !== null) {
      for (const role of membership.roles) {
        for (const member of membership.members) {
          if (membership.kind === 'grant') {
            if (membership.setOption) edges.push({ role, member })
          } else {
            const at = edges.findIndex((e) => e.role === role && e.member === member)
            if (at !== -1) edges.splice(at, 1)
          }
        }
      }
    }

    const closure = setReachabilityClosure(edges)
    const installerReach = new Set<string>()
    for (const path of closure) {
      const [member, target] = path.split('->')
      if (!isCapabilityRoleName(target)) continue
      if (RUNTIME_ROLES.includes(member)) {
        throw new AuthorityRefusal(
          'AUTHORITY_STATE_TRANSITION_INVALID',
          `${where}: after statement ${step.index}, runtime principal ${member} can reach ${target}.`,
        )
      }
      if (member === GOVERNED_INSTALLER) installerReach.add(target)
    }
    if (installerReach.size > 1) {
      throw new AuthorityRefusal(
        'AUTHORITY_CONCURRENT_CAPABILITY_LIFECYCLES',
        `${where}: after statement ${step.index} the installer can reach ` +
          `${[...installerReach].sort().join(' and ')}. Two capability lifecycles open at once is ` +
          `the W46 mutation: quota and ticket must be transferred one after the other.`,
      )
    }
  }
  if (edges.length > 0) {
    throw new AuthorityRefusal(
      'AUTHORITY_CLEANUP_INCOMPLETE',
      `${where}: ${edges.length} membership edge(s) survive the package.`,
    )
  }
  checks.push('reachability: at most one capability open, runtime reaches none, none survives')

  /* L — the provider's topology is never named ----------------------------- */
  for (const step of authoritySteps) {
    const membership = parseMembershipStatement(step.raw)
    if (membership === null) continue
    for (const principal of [...membership.roles, ...membership.members]) {
      if (PROVIDER_ROLES.includes(principal)) {
        throw new AuthorityRefusal(
          'AUTHORITY_UNKNOWN_ROLE',
          `${where}: statement ${step.index} names \`${principal}\` in a membership statement. ` +
            `The chain's temporary rows are told apart from the provider's by grantor (lab ` +
            `M2/M3a); naming a provider role here would destroy that distinction.`,
        )
      }
    }
  }
  checks.push("the provider's roles are never named in a membership statement")

  /* C / D / E — segments and transfers are represented, and typed ---------- */
  const packageSegments = plan.segments.filter((s) => s.packageId === packageId)
  const emittedSegmentIds = new Set(
    generated.statements.filter((s) => s.segmentId !== null).map((s) => s.segmentId as string),
  )
  for (const segment of packageSegments) {
    if (!emittedSegmentIds.has(segment.segmentId)) {
      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
        `${where}: execution segment ${segment.segmentId} produced no authority statement.`,
      )
    }
  }
  checks.push(`all ${packageSegments.length} execution segments are represented`)

  const transferSegments = packageSegments.filter((s) => s.authorityClass === 'OWNER_TRANSFER')
  for (const segment of transferSegments) {
    for (const row of segmentRows(plan, segment)) {
      if (row.identity.statementClass !== 'owner-transfer') {
        throw new AuthorityRefusal(
          'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
          `${where}: ${segment.segmentId} contains a ${row.identity.statementClass}.`,
        )
      }
      if (row.identity.object?.objectClass !== 'function') {
        throw new AuthorityRefusal(
          'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
          `${where}: ${segment.segmentId} transfers a ${row.identity.object?.objectClass}. The ` +
            `measured inventory is 27 functions and the primitive is built for routines; a ` +
            `different object class needs its own typed variant, not a string substitution.`,
        )
      }
      if (row.ownerDestination !== segment.ownerDestination) {
        throw new AuthorityRefusal(
          'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
          `${where}: ${segment.segmentId} declares ${segment.ownerDestination} but statement ` +
            `${row.statement.index} transfers to ${row.ownerDestination}.`,
        )
      }
    }
    assertCaseGShape(where, segment.segmentId, segment.ownerDestination as string, generated)
  }
  checks.push(`all ${transferSegments.length} transfer segment(s) follow the case-G lifecycle`)

  return { packageId, checks }
}

/** Validates the whole generated chain. Throws on the first refusal. */
export function validateGeneratedChain(
  plan: AuthorityPlan,
  packages: readonly GeneratedGovernedPackage[],
): GeneratedValidationResult[] {
  return packages.map((generated) => validateGeneratedPackage(plan, generated))
}

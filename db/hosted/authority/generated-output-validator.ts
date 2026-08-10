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
import { segmentRows, type AuthorityPlan, type ExecutionSegment } from './classification-manifest'
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
  // COMMIT 5.1. The installer's PERMANENT USAGE on a schema the chain creates,
  // so that its own preconditions can resolve names there. Recognised
  // narrowly — USAGE only, on a schema, to the installer and nobody else —
  // because the point of this function is that an unmodelled authority
  // statement refuses rather than passes.
  if (
    statementClass === 'grant-privilege' &&
    step.identity.object?.objectClass === 'schema' &&
    step.identity.operands[0].split('+').every((p) => p === 'USAGE') &&
    step.identity.operands[1].split('+').every((g) => g === GOVERNED_INSTALLER)
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

/* -------------------------------------------------------------------------- */
/* F-C4-01 — the temporary schema CREATE, bound to a schema and a grantee       */
/* -------------------------------------------------------------------------- */

/**
 * One temporary `GRANT`/`REVOKE ... CREATE ON SCHEMA`, read structurally.
 *
 * Deliberately NOT a substring test. The previous check asked whether the text
 * `GRANT CREATE ON SCHEMA` appeared in case-G position, which is a question
 * about the SHAPE of the lifecycle. `GRANT CREATE ON SCHEMA public TO
 * uellix_app;` answers it yes.
 */
interface SchemaCreateEvent {
  readonly kind: 'grant' | 'revoke'
  readonly schema: string
  readonly grantees: readonly string[]
}

function schemaCreateEvents(statements: readonly string[]): SchemaCreateEvent[] {
  const events: SchemaCreateEvent[] = []
  for (const sql of statements) {
    if (parseMembershipStatement(sql) !== null) continue
    const identity = parseStatementIdentity(sql)
    const isGrant = identity.statementClass === 'grant-privilege'
    const isRevoke = identity.statementClass === 'revoke-privilege'
    if (!isGrant && !isRevoke) continue
    if (identity.object?.objectClass !== 'schema') continue
    const confersCreate = identity.operands[0]
      .split('+')
      .some((p) => p === 'CREATE' || p === 'ALL' || p === 'ALL PRIVILEGES')
    if (!confersCreate) continue
    events.push({
      kind: isGrant ? 'grant' : 'revoke',
      schema: identity.object.name,
      grantees: identity.operands[1].split('+').filter((g) => g.length > 0),
    })
  }
  return events
}

/**
 * The ONE schema a transfer segment's canonical statements act in.
 *
 * `requiredTemporarySchemaCreate` is derived from the segment's FIRST statement
 * alone (classification-manifest, `transferTarget`). That is correct for every
 * transfer in the chain today and silently wrong for the first one that is not:
 * a segment spanning two schemas would open CREATE on one of them and run the
 * ALTERs for the other, and PostgreSQL would refuse the second half at apply
 * time — after the first half had already committed its ownership change inside
 * the same transaction. So the span is MEASURED here, over every row, and a
 * segment that spans more than one schema is refused before a byte is applied.
 */
function transferSegmentSchema(
  where: string,
  plan: AuthorityPlan,
  segment: ExecutionSegment,
): string {
  const schemas = new Set<string>()
  for (const row of segmentRows(plan, segment)) {
    const schema = row.identity.object?.schema
    if (typeof schema !== 'string' || schema.length === 0) {
      throw new AuthorityRefusal(
        'AUTHORITY_TRANSFER_SEGMENT_MULTIPLE_SCHEMAS',
        `${where}: ${segment.segmentId} transfers an object with no resolvable schema at source ` +
          `statement ${row.statement.index}. A temporary CREATE grant names exactly one schema, and ` +
          `there is no schema here to name.`,
      )
    }
    schemas.add(schema)
  }
  if (schemas.size !== 1) {
    throw new AuthorityRefusal(
      'AUTHORITY_TRANSFER_SEGMENT_MULTIPLE_SCHEMAS',
      `${where}: ${segment.segmentId} transfers objects across ${schemas.size} schemas ` +
        `(${[...schemas].sort().join(', ')}). The case-G lifecycle opens CREATE on ONE schema; the ` +
        `statements for every other schema would then run without it, and PostgreSQL checks CREATE ` +
        `on the containing schema against the INCOMING owner (S1-DEFECT-001).`,
    )
  }
  const [schema] = [...schemas]
  if (segment.requiredTemporarySchemaCreate !== schema) {
    throw new AuthorityRefusal(
      'AUTHORITY_TEMPORARY_CREATE_BINDING_MISMATCH',
      `${where}: ${segment.segmentId} acts in schema ${schema} but declares its temporary CREATE ` +
        `against ${segment.requiredTemporarySchemaCreate ?? '(none)'}.`,
    )
  }
  return schema
}

/**
 * Binds the emitted temporary CREATE to the exact schema and the exact grantee.
 *
 * F-C4-01. Both halves are re-derived from the generated bytes: the grant and
 * the revoke must name the schema the segment's OWN statements act in, and the
 * only grantee either may name is the capability the segment transfers to.
 */
function assertTemporaryCreateBinding(
  where: string,
  segment: ExecutionSegment,
  schema: string,
  authoritySql: readonly string[],
): void {
  const target = segment.ownerDestination as string
  const events = schemaCreateEvents(authoritySql)

  if (events.length !== 2 || events[0].kind !== 'grant' || events[1].kind !== 'revoke') {
    throw new AuthorityRefusal(
      'AUTHORITY_TEMPORARY_CREATE_BINDING_MISMATCH',
      `${where}: ${segment.segmentId} emits ${events.length} temporary schema-CREATE statement(s) ` +
        `(${events.map((e) => `${e.kind} ${e.schema}`).join(', ') || 'none'}). The case-G lifecycle ` +
        `emits exactly one grant followed by exactly one revoke.`,
    )
  }

  for (const event of events) {
    if (event.schema !== schema) {
      throw new AuthorityRefusal(
        'AUTHORITY_TEMPORARY_CREATE_BINDING_MISMATCH',
        `${where}: ${segment.segmentId} ${event.kind}s CREATE on schema ${event.schema}, but its ` +
          `canonical statements act in ${schema}. The transfers would then run without CREATE on ` +
          `the schema that actually contains them, and CREATE would be opened — briefly, and ` +
          `unreviewed — somewhere else.`,
      )
    }
    if (event.grantees.length !== 1 || event.grantees[0] !== target) {
      throw new AuthorityRefusal(
        'AUTHORITY_TEMPORARY_CREATE_BINDING_MISMATCH',
        `${where}: ${segment.segmentId} ${event.kind}s CREATE on ${schema} ` +
          `${event.kind === 'grant' ? 'to' : 'from'} ${event.grantees.join(', ') || '(nobody)'}; the ` +
          `only principal this segment may open it for is its transfer target ${target}.`,
      )
    }
  }
}

/**
 * The one elevation window, IN THE BYTES, that a transfer segment runs inside.
 *
 * Attribution has to come from the emitted text rather than from the generator's
 * `segmentId` labels, otherwise a mislabelled statement would be checked against
 * the segment it claims to belong to instead of the one it actually runs in.
 * `SET ROLE` … `RESET ROLE` is the boundary, and it is exact: `walkRoles` has
 * already refused any nesting, so the run between a matched pair is one window
 * governing one segment.
 *
 * W46 is the case that makes this necessary. Its two transfer segments are
 * adjacent — quota closes and ticket opens with nothing canonical between them —
 * so a naive "walk backwards to the previous canonical statement" would sweep
 * quota's close statements into ticket's open run.
 */
function elevationWindowOf(
  where: string,
  segment: ExecutionSegment,
  steps: readonly RoleWalkStep[],
  positionOfSource: ReadonlyMap<number, number>,
  sourceIndexes: readonly number[],
): RoleWalkStep[] {
  const first = positionOfSource.get(sourceIndexes[0])
  const last = positionOfSource.get(sourceIndexes[sourceIndexes.length - 1])
  if (first === undefined || last === undefined) {
    throw new AuthorityRefusal(
      'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
      `${where}: ${segment.segmentId}: its canonical statements were not all matched in the output.`,
    )
  }

  let open = -1
  for (let k = first - 1; k >= 0; k -= 1) {
    if (steps[k].identity.statementClass === 'reset-role') break
    if (steps[k].identity.statementClass === 'set-role') {
      open = k
      break
    }
  }
  let close = -1
  for (let k = last + 1; k < steps.length; k += 1) {
    if (steps[k].identity.statementClass === 'set-role') break
    if (steps[k].identity.statementClass === 'reset-role') {
      close = k
      break
    }
  }
  if (open === -1 || close === -1) {
    throw new AuthorityRefusal(
      'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
      `${where}: ${segment.segmentId} does not run inside a matched SET ROLE / RESET ROLE window in ` +
        `the emitted bytes. Its ALTER ... OWNER TO statements would execute as the installer, which ` +
        `PostgreSQL refuses with \`must be owner of function\` — or, worse, would not.`,
    )
  }
  return steps.slice(open + 1, close)
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

  const consumed: {
    sourceIndex: number
    role: string
    authorityBefore: number
    /** Position in the byte walk, so a segment can be located in the OUTPUT. */
    stepPosition: number
  }[] = []
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

  for (const [stepPosition, step] of steps.entries()) {
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
      consumed.push({ sourceIndex: target.sourceIndex, role: step.role, authorityBefore, stepPosition })
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

  /* J / K — reachability, re-derived statement by statement ----------------
   *
   * F-C4-02. The concurrency check used to count only what the INSTALLER could
   * reach, and the transfer lifecycle does not grant the installer anything: it
   * grants `<target> TO uellix_owner`. So the one topology the check was named
   * after — two capability lifecycles open at once — was invisible to it in the
   * eleven segments where it can actually happen. What is counted now is every
   * OPEN temporary membership edge whose ROLE is a capability, whoever the
   * member is, and the permitted set is derived from the plan's own segments.
   */
  const permittedCapabilityEdges = new Map<string, string>()
  for (const segment of plan.segments.filter((s) => s.packageId === packageId)) {
    if (segment.authorityClass === 'OWNER_TRANSFER') {
      // Measured (pg176-transfer-lab): the EXECUTING role must be able to SET
      // ROLE to the incoming owner, and the executing role is uellix_owner.
      permittedCapabilityEdges.set(
        `${segment.ownerDestination}:${OWNER_ROLE}`,
        `${segment.segmentId} (transfer target)`,
      )
    } else if (segment.authorityClass === 'CAPABILITY') {
      permittedCapabilityEdges.set(
        `${segment.executor}:${GOVERNED_INSTALLER}`,
        `${segment.segmentId} (capability elevation)`,
      )
    }
  }

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
    for (const path of closure) {
      const [member, target] = path.split('->')
      if (!isCapabilityRoleName(target)) continue
      if (RUNTIME_ROLES.includes(member)) {
        throw new AuthorityRefusal(
          'AUTHORITY_STATE_TRANSITION_INVALID',
          `${where}: after statement ${step.index}, runtime principal ${member} can reach ${target}.`,
        )
      }
    }

    // MEMBER-AGNOSTIC, and over the DIRECT edges rather than the closure: this
    // is about how many capability lifecycles are OPEN, and a lifecycle is open
    // exactly while its own membership row stands. Counting closure paths would
    // report one lifecycle twice as soon as any intermediate existed.
    const openCapabilityEdges = edges.filter((e) => isCapabilityRoleName(e.role))
    if (openCapabilityEdges.length > 1) {
      throw new AuthorityRefusal(
        'AUTHORITY_CONCURRENT_CAPABILITY_LIFECYCLES',
        `${where}: after statement ${step.index}, ${openCapabilityEdges.length} temporary capability ` +
          `memberships stand at once: ` +
          `${openCapabilityEdges.map((e) => `${e.role}->${e.member}`).sort().join(', ')}. This is the ` +
          `W46 mutation: quota and ticket are transferred one after the other, and the first ` +
          `lifecycle must be closed before the second opens. No phase of the current plan permits ` +
          `two.`,
      )
    }
    for (const edge of openCapabilityEdges) {
      const permitted = permittedCapabilityEdges.get(`${edge.role}:${edge.member}`)
      if (permitted === undefined) {
        throw new AuthorityRefusal(
          'AUTHORITY_UNDECLARED_CAPABILITY_MEMBERSHIP',
          `${where}: after statement ${step.index}, ${edge.member} holds temporary membership in ` +
            `${edge.role}, and no segment of this package declares that edge. The declared ones are: ` +
            `${[...permittedCapabilityEdges.entries()].map(([k, v]) => `${k} <- ${v}`).sort().join('; ') || 'none'}.`,
        )
      }
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
  const positionOfSource = new Map(consumed.map((c) => [c.sourceIndex, c.stepPosition]))
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

    // F-C4-01. One schema across the whole segment, and the temporary CREATE
    // bound to THAT schema and to the segment's own transfer target — both
    // re-derived from the emitted bytes, inside the elevation window the bytes
    // themselves delimit.
    const schema = transferSegmentSchema(where, plan, segment)
    const lifecycle = elevationWindowOf(
      where,
      segment,
      steps,
      positionOfSource,
      segmentRows(plan, segment).map((r) => r.statement.index),
    )
    assertTemporaryCreateBinding(
      where,
      segment,
      schema,
      lifecycle.map((s) => s.raw),
    )
  }
  checks.push(`all ${transferSegments.length} transfer segment(s) follow the case-G lifecycle`)
  checks.push(
    `all ${transferSegments.length} transfer segment(s) act in one schema, and open temporary ` +
      `CREATE on exactly that schema for exactly their own target`,
  )

  return { packageId, checks }
}

/** Validates the whole generated chain. Throws on the first refusal. */
export function validateGeneratedChain(
  plan: AuthorityPlan,
  packages: readonly GeneratedGovernedPackage[],
): GeneratedValidationResult[] {
  return packages.map((generated) => validateGeneratedPackage(plan, generated))
}

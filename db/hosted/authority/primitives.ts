// db/hosted/authority/primitives.ts
// COMMIT 3 — the authority primitives, and the cleanup contract they satisfy.
//
// Each primitive emits the statements that OPEN a window and the statements
// that CLOSE it. Nothing here applies anything; a primitive is a value, so the
// generator (Commit 4) and the verifier can both read it and neither can drift
// from the other by acting.
//
// ---------------------------------------------------------------------------
// EVERY RULE BELOW WAS MEASURED, NOT ASSUMED
// ---------------------------------------------------------------------------
// db/hosted/authority/lab/pg176-authority-lab.sql, PostgreSQL 17.6 (170006),
// managed-Supabase image, network none, destroyed afterwards:
//
//   M1  Creating a role grants the creator ADMIN OPTION with set_option = FALSE.
//       So membership with SET TRUE has to be granted explicitly, and this is
//       exactly the Train 5A abort reproduced in four statements.
//
//   M2  A provider-granted membership and an installer-granted one COEXIST as
//       two rows, distinguished by grantor.
//
//   M3a An unqualified REVOKE removes ONLY the issuing grantor's row. This is
//       what makes cleanup safe: the installer can stand down without touching
//       a membership the provider owns.
//
//   M3b `REVOKE ... GRANTED BY r` is refused unless the revoker holds r's
//       privileges. An installer cannot reach a provider's row even by naming
//       it — a safety property, not an obstacle.
//
//   M5  The installer CANNOT grant CREATE on a schema owned by uellix_owner:
//       membership with INHERIT FALSE is not enough and PostgreSQL answers
//       `permission denied for schema`. The temporary CREATE grant is therefore
//       NESTED inside an owner window, not issued alongside one. An object
//       created while CREATE was held survives the revoke, and a further
//       creation afterwards is refused with 42501.
//
//   M6  `SET ROLE a; SET ROLE b; RESET ROLE` lands on the SESSION role, not on
//       `a`. There is no stack. The state machine below refuses a nested
//       elevation for that reason and no other.

import { assertNoSessionRoleGrantee } from './membership-tripwire'
import { parseMembershipStatement } from './membership'
import { parseStatementIdentity } from './structural-identity'
import {
  assertElevatable,
  hostedRole,
  isCapabilityRole as isCapabilityRoleIdentifier,
  type HostedRoleIdentifier,
} from './role-registry'
import { AuthorityRefusal } from './window-contract'

/* -------------------------------------------------------------------------- */
/* The state machine                                                           */
/* -------------------------------------------------------------------------- */

export type AuthorityState = 'installer' | 'owner' | 'capability'

/**
 * Tracks which authority is in force, and refuses a nesting PostgreSQL cannot
 * unwind.
 *
 * The refusal of owner → capability is not conservatism. Measured (M6): a second
 * `SET ROLE` replaces the first, and `RESET ROLE` returns to the session role
 * rather than to the previous one. A plan that nested elevations would emit a
 * `RESET ROLE` believing it had returned to the owner window and would in fact
 * be running the rest of that window as the installer — with the owner window's
 * statements failing, or worse, succeeding for the wrong reason.
 */
export class AuthorityStateMachine {
  #state: AuthorityState = 'installer'

  get state(): AuthorityState {
    return this.#state
  }

  enter(next: Exclude<AuthorityState, 'installer'>): void {
    if (this.#state !== 'installer') {
      throw new AuthorityRefusal(
        'AUTHORITY_STATE_TRANSITION_INVALID',
        `cannot enter a ${next} window while a ${this.#state} window is open. PostgreSQL does not ` +
          `stack SET ROLE (lab M6): the inner RESET ROLE would return to the session role, not to ` +
          `the ${this.#state} window, and the rest of that window would run unelevated. Close the ` +
          `open window first.`,
      )
    }
    this.#state = next
  }

  leave(): void {
    if (this.#state === 'installer') {
      throw new AuthorityRefusal(
        'AUTHORITY_STATE_TRANSITION_INVALID',
        `there is no open window to leave; the current authority is already the installer. An ` +
          `unmatched close means the plan emitted a RESET ROLE it did not account for.`,
      )
    }
    this.#state = 'installer'
  }
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

export interface AuthorityPrimitive {
  /** Statements that put the required authority in force, in order. */
  readonly open: readonly string[]
  /**
   * Statements emitted between open and close that are not the governed
   * package statements themselves — generated bookkeeping.
   *
   * Present because Fable's review (F1) found the cleanup checker inspecting
   * only `open`: a primitive that acquired a privilege anywhere else would have
   * been balanced by inspection of a phase that never held it.
   */
  readonly body?: readonly string[]
  /** Statements that take the authority away again, in order. */
  readonly close: readonly string[]
}

/** Every phase, in execution order. The cleanup contract is over all of them. */
export function primitivePhases(primitive: AuthorityPrimitive): string[] {
  return [...primitive.open, ...(primitive.body ?? []), ...primitive.close]
}

/**
 * Refuses any member that is not the installer.
 *
 * F-05. The primitives took a `HostedRoleIdentifier`, which types cannot
 * enforce at run time: a cast, a value read from JSON, or a plain JS caller
 * could pass `uellix_app` and receive a primitive that grants a RUNTIME role
 * temporary SET reachability into uellix_owner. The type said no; nothing said
 * no when it mattered.
 */
/**
 * Which principal a temporary membership may name, per lifecycle kind.
 *
 * `installer-elevation` covers owner and capability windows: the installer is
 * the only principal that may be handed the ability to become another role.
 *
 * `transfer-target` covers ownership transfers, and it is NOT a loosening. It
 * is a measured necessity: PostgreSQL requires the EXECUTING role to be able to
 * SET ROLE to the incoming owner, and to hold the privileges of the outgoing
 * one. The installer holds uellix_owner with INHERIT FALSE, so it can never be
 * the owner; uellix_owner is a member of no capability role, so it can never
 * reach the target. Measured, PG 17.6 (pg176-transfer-lab.sql):
 *
 *   SET ROLE owner; ALTER ... OWNER TO cap  ->  must be able to SET ROLE "cap"
 *   installer (INHERIT FALSE) executes it   ->  must be owner of function
 *
 * So the membership goes to uellix_owner, for the length of one segment. What
 * stays closed either way is the thing F-05 was about: a RUNTIME role may never
 * be the member of a temporary elevation, and neither may a capability role.
 */
type TemporaryMembershipKind = 'installer-elevation' | 'transfer-target'

function assertTemporaryMemberPermitted(
  member: string,
  kind: TemporaryMembershipKind,
  where: string,
): void {
  const role = hostedRole(member)

  if (kind === 'installer-elevation') {
    if (role.kind !== 'installer') {
      throw new AuthorityRefusal(
        'AUTHORITY_TEMP_MEMBER_NOT_INSTALLER',
        `${where}: temporary elevation may only be granted to the installer, never to ` +
          `\`${member}\` (a ${role.kind} role). ${role.purpose}`,
      )
    }
    return
  }

  if (role.kind !== 'owner') {
    throw new AuthorityRefusal(
      'AUTHORITY_TEMP_MEMBER_NOT_INSTALLER',
      `${where}: an ownership transfer grants the incoming owner's membership to the OUTGOING ` +
        `owner and to nothing else. \`${member}\` is a ${role.kind} role. Handing this to a ` +
        `runtime or capability principal would open a SET path the plan never accounts for.`,
    )
  }
}

function grantMembership(
  role: HostedRoleIdentifier,
  member: HostedRoleIdentifier,
  kind: TemporaryMembershipKind = 'installer-elevation',
): string {
  assertTemporaryMemberPermitted(member, kind, `GRANT ${role} TO ${member}`)
  // INHERIT FALSE, SET TRUE is the exact shape the bootstrap already uses for
  // uellix_owner: the installer may BECOME the role but does not silently carry
  // its privileges the rest of the time. SET TRUE is spelled out because M1
  // measured that it is not granted by default to a role's creator.
  return `GRANT ${role} TO ${member} WITH INHERIT FALSE, SET TRUE;`
}

function revokeMembership(role: HostedRoleIdentifier, member: HostedRoleIdentifier): string {
  // Unqualified, and deliberately so. M3a measured that this removes only the
  // issuing grantor's row, which is precisely the scope wanted: the installer's
  // own temporary membership goes, and a provider-granted one (M2) survives.
  // `GRANTED BY` would be narrower on paper and is refused in practice unless
  // the revoker holds the grantor's privileges (M3b).
  return `REVOKE ${role} FROM ${member};`
}

/**
 * Opens and closes an owner window for `installer`.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO TEMPORARY MEMBERSHIP HERE (COMMIT 5.1, MEASURED)
 * ---------------------------------------------------------------------------
 * This primitive used to emit `GRANT uellix_owner TO <installer> WITH INHERIT
 * FALSE, SET TRUE` before the elevation and revoke it after. PostgreSQL 17.6
 * refuses that grant outright:
 *
 *   ERROR: permission denied to grant role "uellix_owner"
 *   DETAIL: Only roles with the ADMIN option on role "uellix_owner" may grant
 *           this role.
 *
 * and the only way to make it execute would be to hand the installer ADMIN
 * OPTION on uellix_owner permanently — which is a strictly LARGER power than
 * the window needed. An installer with ADMIN can grant uellix_owner to anyone,
 * for good, and it would hold that between packages, between chains and after
 * the last one.
 *
 * The grant was also redundant. `stella_hosted_0001` §2b establishes the
 * persistent membership `uellix_owner <- uellix_migrator WITH INHERIT FALSE,
 * SET TRUE` and §6 asserts it; that IS the elevation path, and the window only
 * ever needed to USE it. So the window now does exactly that: announce the
 * role, act, stand down.
 *
 * WHAT REPLACES THE GUARANTEE THE GRANT APPEARED TO GIVE. Nothing here can
 * check a database, so the precondition is checked where a database is
 * available: `validateHostedPrechainAuthorityContract` refuses before T1 if
 * `pg_has_role(installer, uellix_owner, 'SET')` is false — measured, not
 * assumed, and refused early rather than at whichever window happened to run
 * first. INHERIT FALSE remains true of the persistent row, so the installer
 * still carries none of the owner's privileges except while it says so.
 */
export function ownerWindowPrimitive(installer: HostedRoleIdentifier): AuthorityPrimitive {
  hostedRole(installer)
  assertElevatable('uellix_owner')

  return {
    open: ['SET ROLE uellix_owner;'],
    close: ['RESET ROLE;'],
  }
}

export interface CapabilityWindowOptions {
  readonly installer: HostedRoleIdentifier
  readonly capabilityRole: HostedRoleIdentifier
  /** The schema the window creates objects in. */
  readonly schema: string
  readonly needsTemporarySchemaCreate: boolean
}

/**
 * Opens and closes a capability window.
 *
 * When the window creates objects, the capability role needs CREATE on the
 * schema — and M5 measured that the installer cannot grant it, because the
 * schema belongs to uellix_owner and membership with INHERIT FALSE does not
 * carry the privilege. So the grant is made inside a SHORT owner window that
 * opens and closes before the capability elevation begins. The revoke is made
 * the same way, for the same reason.
 */
export function capabilityWindowPrimitive(options: CapabilityWindowOptions): AuthorityPrimitive {
  const { installer, capabilityRole, schema, needsTemporarySchemaCreate } = options
  hostedRole(installer)
  assertElevatable(capabilityRole)

  const open: string[] = []
  const close: string[] = []

  if (needsTemporarySchemaCreate) {
    open.push(
      ...ownerWindowPrimitive(installer).open,
      `GRANT CREATE ON SCHEMA ${schema} TO ${capabilityRole};`,
      ...ownerWindowPrimitive(installer).close,
    )
  }

  open.push(grantMembership(capabilityRole, installer), `SET ROLE ${capabilityRole};`)
  close.push('RESET ROLE;')

  if (needsTemporarySchemaCreate) {
    close.push(
      ...ownerWindowPrimitive(installer).open,
      `REVOKE CREATE ON SCHEMA ${schema} FROM ${capabilityRole};`,
      ...ownerWindowPrimitive(installer).close,
    )
  }

  close.push(revokeMembership(capabilityRole, installer))
  return { open, close }
}

export interface OwnerTransferOptions {
  readonly installer: HostedRoleIdentifier
  /** The outgoing owner. `uellix_owner` for every transfer in the chain. */
  readonly fromOwner: HostedRoleIdentifier
  /** EXACTLY ONE incoming owner. Never a list — see the segmentation model. */
  readonly targetCapability: HostedRoleIdentifier
  /** The schema the transferred objects live in. */
  readonly schema: string
  /** The execution segment this instance belongs to, for diagnostics. */
  readonly segmentId: string
}

/**
 * Opens and closes ONE ownership-transfer execution segment.
 *
 * THE SHAPE IS MEASURED, NOT DESIGNED. The first version of this primitive
 * granted both roles to the INSTALLER and then `SET ROLE`d to the outgoing
 * owner. It could not execute a single one of the chain's 27 transfers, and no
 * test could have said so: the SQL it emitted was well-formed, and it was
 * PostgreSQL that refused it. Two independent checks are involved:
 *
 *   "must be owner of function"       pg_proc_ownercheck -> has_privs_of_role,
 *                                     which requires INHERIT, not membership
 *   "must be able to SET ROLE <new>"  the EXECUTING role must be a member of
 *                                     the incoming owner
 *
 * The installer holds uellix_owner with INHERIT FALSE on purpose, so it fails
 * the first. uellix_owner is a member of no capability role, so it fails the
 * second. The resolution measured in PG 17.6 gives the SECOND condition to the
 * owner, temporarily, and leaves the first where it already was:
 *
 *   installer:  GRANT <target> TO uellix_owner WITH INHERIT FALSE, SET TRUE
 *   installer:  SET ROLE uellix_owner
 *   owner:      GRANT CREATE ON SCHEMA <schema> TO <target>
 *   owner:      ALTER ... OWNER TO <target>          (the canonical statements)
 *   owner:      REVOKE CREATE ON SCHEMA <schema> FROM <target>
 *   installer:  RESET ROLE
 *   installer:  REVOKE <target> FROM uellix_owner
 *
 * The order is a pin, not a preference. The schema CREATE must be granted from
 * inside the owner phase because the installer cannot grant on a schema
 * uellix_owner owns (lab M5), and it must be revoked before RESET ROLE for the
 * same reason. Measured end state: zero temporary membership rows, no schema
 * CREATE, the provider's own membership row untouched, and seven distinct
 * mid-transfer failure points all rolling back to the original owner.
 */
export function ownerTransferPrimitive(options: OwnerTransferOptions): AuthorityPrimitive {
  const { installer, fromOwner, targetCapability, schema } = options
  hostedRole(installer)
  assertElevatable(fromOwner)
  assertElevatable(targetCapability)

  if (!isCapabilityRoleIdentifier(targetCapability)) {
    throw new AuthorityRefusal(
      'AUTHORITY_UNKNOWN_ROLE',
      `${options.segmentId}: the incoming owner of a transfer must be a capability role, not ` +
        `\`${targetCapability}\`.`,
    )
  }

  return {
    open: [
      grantMembership(targetCapability, fromOwner, 'transfer-target'),
      `SET ROLE ${fromOwner};`,
      `GRANT CREATE ON SCHEMA ${schema} TO ${targetCapability};`,
    ],
    close: [
      `REVOKE CREATE ON SCHEMA ${schema} FROM ${targetCapability};`,
      'RESET ROLE;',
      revokeMembership(targetCapability, fromOwner),
    ],
  }
}

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One acquisition or release of a temporary privilege, read structurally.
 *
 * F-03. This used to return `null` for anything it did not recognise, and
 * `assertCleanupComplete` skipped those. That is fail-OPEN in the one place
 * that must not be: `GRANT cap_a, cap_b TO migrator;` and
 * `GRANT ALL ON SCHEMA s TO cap;` both acquired real authority and both were
 * invisible. Multi-pair forms are now MODELLED as their cross product (which is
 * exactly what PostgreSQL does), and a genuinely unmodelled authority-changing
 * form REFUSES.
 *
 * `{ kind: 'none' }` is reserved for statements that provably change no
 * elevation: bookkeeping, DDL, and privilege grants that confer no CREATE.
 */
type PrivilegeEvent = { kind: 'acquire' | 'release'; tokens: string[] } | { kind: 'none' }

function classifyPrivilegeEvent(sql: string, where: string): PrivilegeEvent {
  const membership = parseMembershipStatement(sql)
  if (membership !== null) {
    if (membership.optionOnly) {
      throw new AuthorityRefusal(
        'AUTHORITY_PRIVILEGE_EVENT_UNSUPPORTED',
        `${where}: \`${sql.trim().slice(0, 120)}\` narrows a membership option without removing ` +
          `the membership. Counting it as a release would report the window balanced while the ` +
          `member still held SET on the role; ignoring it would hide an authority change. Neither ` +
          `is acceptable, so it is refused.`,
      )
    }
    const tokens = membership.roles.flatMap((role) =>
      membership.members.map((member) => `membership:${role}:${member}`),
    )
    return { kind: membership.kind === 'grant' ? 'acquire' : 'release', tokens }
  }

  // Not caught: an unmodelled statement form inside an authority primitive is a
  // refusal, not something to step over.
  const identity = parseStatementIdentity(sql)
  const isGrant = identity.statementClass === 'grant-privilege'
  const isRevoke = identity.statementClass === 'revoke-privilege'
  if (!isGrant && !isRevoke) return { kind: 'none' }
  if (identity.object?.objectClass !== 'schema') return { kind: 'none' }

  const privileges = identity.operands[0].split('+')
  // `ALL` and `ALL PRIVILEGES` include CREATE. Reading only the literal word
  // CREATE was the second half of F-03.
  const confersCreate = privileges.some(
    (p) => p === 'CREATE' || p === 'ALL' || p === 'ALL PRIVILEGES',
  )
  if (!confersCreate) return { kind: 'none' }

  const schema = identity.object.name
  const tokens = identity.operands[1]
    .split('+')
    .filter((g) => g.length > 0)
    .map((grantee) => `schema-create:${schema}:${grantee}`)
  return { kind: isGrant ? 'acquire' : 'release', tokens }
}

/**
 * Refuses a primitive that acquires authority it does not give back.
 *
 * TWO THINGS THIS GETS RIGHT THAT THE FIRST VERSION DID NOT:
 *
 *   F1. Every phase is inspected, in execution order, not only `open`. The
 *       first version balanced acquisitions found in `open` against releases
 *       found anywhere — so a primitive that acquired in `close` was reported
 *       clean, because the check never looked for an acquisition there.
 *
 *   F2. Membership is read structurally. `GRANT cap TO owner;` with no `WITH`
 *       clause confers set_option TRUE (measured, 17.6) and the previous regex
 *       could not see it at all.
 *
 * Matching is on the exact (role, member) pair rather than on counts, because
 * M3a makes a mismatched revoke a NO-OP that reports success: `REVOKE x FROM
 * uellix_app` after `GRANT x TO uellix_migrator` removes nothing at all, and a
 * count-based check would call the window balanced.
 */
export function assertCleanupComplete(where: string, primitive: AuthorityPrimitive): void {
  const phases = primitivePhases(primitive)

  for (const statement of phases) {
    assertNoSessionRoleGrantee(statement)
  }

  const outstanding = new Set<string>()
  for (const statement of phases) {
    const event = classifyPrivilegeEvent(statement, where)
    if (event.kind === 'none') continue
    for (const token of event.tokens) {
      if (event.kind === 'acquire') outstanding.add(token)
      else outstanding.delete(token)
    }
  }

  if (outstanding.size > 0) {
    throw new AuthorityRefusal(
      'AUTHORITY_CLEANUP_INCOMPLETE',
      `${where} acquires authority it never gives back: ${[...outstanding].sort().join(', ')}. ` +
        `Measured (M3a): a REVOKE naming a different member removes nothing and reports success, ` +
        `so a close that does not match its open exactly leaves the installer permanently able to ` +
        `become a role the window only needed for a moment.`,
    )
  }
}

/* -------------------------------------------------------------------------- */
/* RT-07 — transitive SET reachability                                         */
/* -------------------------------------------------------------------------- */

export interface MembershipEdge {
  /** The role whose privileges become reachable. */
  readonly role: string
  /** The role that gains the ability to become it. */
  readonly member: string
}

/**
 * Extracts the membership edges a set of statements establishes.
 *
 * Only `WITH ... SET TRUE` grants create an edge, because only they make the
 * role reachable by `SET ROLE`. An `INHERIT TRUE, SET FALSE` grant — the shape
 * the bootstrap uses for `uellix_writer` → `uellix_app` — confers privileges
 * without conferring the ability to BECOME the role, and is not an elevation
 * path.
 */
export function membershipEdges(statements: readonly string[]): MembershipEdge[] {
  const edges: MembershipEdge[] = []
  for (const statement of statements) {
    const membership = parseMembershipStatement(statement)
    if (membership === null || membership.kind !== 'grant') continue
    // MEASURED (17.6, F2 recheck): `set_option` defaults to TRUE, so a bare
    // GRANT is an elevation path. The previous regex demanded `WITH ... SET
    // TRUE` and therefore modelled the safe case and missed the default one.
    if (!membership.setOption) continue
    for (const role of membership.roles) {
      for (const member of membership.members) edges.push({ role, member })
    }
  }
  return edges
}

/**
 * Refuses a membership graph in which a role can reach an elevatable role it
 * was never granted directly.
 *
 * MEASURED (lab M4): SET reachability is TRANSITIVE. With
 * `GRANT cap TO middle WITH SET TRUE` and `GRANT middle TO installer WITH SET
 * TRUE`, `pg_has_role(installer, cap, 'SET')` flips from false to true, and back
 * to false when the intermediate grant is revoked. So a window that grants
 * membership in an innocuous intermediate role hands out every role that
 * intermediate can become — and a review that read only the direct grants would
 * have seen nothing.
 *
 * `expectedDirect` is the set of `role→member` edges the plan intends. Anything
 * reachable but not intended is a refusal.
 */
export function assertNoTransitiveElevation(
  where: string,
  edges: readonly MembershipEdge[],
): void {
  const direct = new Map<string, Set<string>>()
  for (const edge of edges) {
    const set = direct.get(edge.member) ?? new Set<string>()
    set.add(edge.role)
    direct.set(edge.member, set)
  }

  for (const [member, directRoles] of direct) {
    const reachable = new Set<string>()
    const queue = [...directRoles]
    while (queue.length > 0) {
      const role = queue.pop() as string
      if (reachable.has(role)) continue
      reachable.add(role)
      for (const next of direct.get(role) ?? []) queue.push(next)
    }

    for (const role of reachable) {
      if (directRoles.has(role)) continue
      throw new AuthorityRefusal(
        'AUTHORITY_STATE_TRANSITION_INVALID',
        `${where}: ${member} can reach ${role} transitively, through an intermediate it was ` +
          `granted directly, but no statement grants ${role} to ${member}. Measured (lab M4): SET ` +
          `reachability is transitive, so the intermediate grant confers this silently and a ` +
          `review of the direct grants alone would not show it.`,
      )
    }
  }
}

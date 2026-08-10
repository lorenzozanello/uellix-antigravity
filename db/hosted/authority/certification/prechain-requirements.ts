// db/hosted/authority/certification/prechain-requirements.ts
// COMMIT 5.1 — what the governed chain needs to ALREADY be true before T1.
//
// ---------------------------------------------------------------------------
// WHY THIS IS DERIVED AND NOT LISTED
// ---------------------------------------------------------------------------
// E-01 was found one statement at a time: the engine refused T1 line 278, then
// 398, then 682, each naming a different privilege on a different object class.
// A hand-written list of "the objects E-01 touches" would have exactly the
// property that made the defect expensive — it would be right about the three
// statements somebody happened to reach and silent about the rest.
//
// So the set is derived from the same plan the generator uses. For every
// canonical statement whose disposition requires a NON-INSTALLER executor, the
// objects it names are resolved, and any object the chain does not itself
// create is a PRECHAIN DEPENDENCY: something that must already exist, owned by
// or reachable from the executor, before T1 runs.
//
// ---------------------------------------------------------------------------
// WHAT "REACHABLE FROM" MEANS, PER STATEMENT CLASS
// ---------------------------------------------------------------------------
// PostgreSQL does not have one answer, and the differences are exactly where
// the three measured failures came from:
//
//   GRANT/REVOKE on X        the executor must OWN X or hold the privilege
//                            WITH GRANT OPTION. Holding the privilege is not
//                            enough. (T1 line 278.)
//   FOREIGN KEY -> X         the executor must hold REFERENCES on X. Nothing
//                            about the referencing table confers it, and the
//                            statement that fails does not mention X in a
//                            position anyone reads as a privilege. (line 398.)
//   TRIGGER ... EXECUTE F    the executor must hold EXECUTE on F, and own the
//                            table the trigger is on. (line 682.)
//   ALTER / COMMENT on X     ownership. No privilege substitutes.
//
// A derivation that collapsed these into "needs access to X" would produce a
// remediation that grants the wrong thing and fails at the next statement.

import { readFileSync } from 'node:fs'

import { buildAuthorityPlan, type AuthorityPlan } from '../classification-manifest'
import { resolveExecutionDispositions } from '../execution-disposition'
import { hostedArtefactPath, INSTALLER_OWNER, OWNER_ROLE } from '../ownership-simulation'
import { CHAIN_PACKAGE_FILES } from '../window-plan'
import { normalizeExecutable } from '../sql-statements'

/** What the executor must hold on the object, and what will NOT substitute. */
export type PrechainPrivilege =
  | 'OWNERSHIP'
  | 'EXECUTE_WITH_GRANT_OPTION'
  | 'TABLE_PRIVILEGE_WITH_GRANT_OPTION'
  | 'REFERENCES'
  | 'EXECUTE'

export interface PrechainRequirement {
  /** `public.organizations`, `public.current_user_org_ids()` — as written. */
  readonly object: string
  readonly objectType: 'table' | 'function'
  readonly privilege: PrechainPrivilege
  /** The role the disposition says must run the statement. */
  readonly requiredExecutor: string
  readonly packageId: string
  readonly statementIndex: number
  readonly why: string
  /**
   * For a privilege requirement: the exact privileges the chain re-grants.
   *
   * Recorded so the remediation can be EXACTLY what is needed. `GRANT ALL` on
   * six baseline tables would satisfy the contract and would also hand the
   * owner TRUNCATE on the ledger, which is the sort of quiet widening this
   * whole programme exists to avoid.
   */
  readonly privilegeNames: readonly string[]
}

/* -------------------------------------------------------------------------- */
/* What the chain creates for itself                                           */
/* -------------------------------------------------------------------------- */

/**
 * Objects the chain creates. These are NOT prechain dependencies: whoever
 * creates them owns them, and the plan already governs who that is.
 *
 * Matched on the qualified name alone, deliberately. A package that creates
 * `uellix_grounding.f(uuid)` and later grants on `uellix_grounding.f(uuid,text)`
 * is creating a second signature of something it owns the schema of, and the
 * schema owner can always grant on both.
 */
function chainCreatedObjects(root: string): Set<string> {
  const created = new Set<string>()
  for (const entry of CHAIN_PACKAGE_FILES) {
    const sql = readFileSync(hostedArtefactPath(entry.sourceFile, root), 'utf8')
    for (const match of sql.matchAll(
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|FUNCTION|VIEW|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi,
    )) {
      created.add(match[1].toLowerCase())
    }
    for (const match of sql.matchAll(/\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      created.add(`schema:${match[1].toLowerCase()}`)
    }
  }
  return created
}

const qualified = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, '')

/** `public.organizations` -> `public`. */
const schemaOf = (name: string): string => name.split('.')[0]

/* -------------------------------------------------------------------------- */
/* Extraction                                                                  */
/* -------------------------------------------------------------------------- */

/** Referenced tables of every FOREIGN KEY clause in a CREATE TABLE. */
function foreignKeyTargets(sql: string): string[] {
  const out: string[] = []
  for (const match of sql.matchAll(/\bREFERENCES\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi)) {
    out.push(qualified(match[1]))
  }
  return out
}

/** The function a `CREATE TRIGGER ... EXECUTE FUNCTION f()` calls. */
function triggerFunctions(sql: string): string[] {
  const out: string[] = []
  for (const match of sql.matchAll(
    /\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi,
  )) {
    out.push(qualified(match[1]))
  }
  return out
}

/**
 * The object a statement acts on, resolved THROUGH subsidiary objects.
 *
 * A trigger, a policy, a column and a constraint are not objects a privilege
 * can be held on: PostgreSQL checks the OWNER OF THE TABLE they hang off. The
 * first version of this file reported nine of them — `public.trg_evidence_
 * chunks_no_update`, `public.idempotency_key` — as tables needing OWNERSHIP,
 * which is both wrong and expensive: every one belongs to a table the chain
 * itself creates, so all nine were false positives that would have padded the
 * remediation with objects that do not exist.
 *
 * `qualifier` is exactly the parent the identity layer already resolved.
 */
const SUBSIDIARY = new Set(['trigger', 'policy', 'column', 'constraint'])

function privilegeTarget(identity: {
  object: {
    objectClass: string
    schema: string | null
    name: string
    qualifier?: string
  } | null
}): string | null {
  if (identity.object === null) return null
  if (SUBSIDIARY.has(identity.object.objectClass)) {
    return identity.object.qualifier?.toLowerCase() ?? null
  }
  if (identity.object.schema === null) return null
  return `${identity.object.schema}.${identity.object.name}`.toLowerCase()
}

/**
 * Every prechain dependency of the governed chain, in package order.
 *
 * `plan` is a parameter so a test can drive a synthesised one; the default
 * builds the real chain, which is what the gate and the report use.
 */
export function derivePrechainRequirements(
  root: string = process.cwd(),
  plan: AuthorityPlan = buildAuthorityPlan(root),
): PrechainRequirement[] {
  const created = chainCreatedObjects(root)
  const dispositions = resolveExecutionDispositions(plan)
  const requirements: PrechainRequirement[] = []
  const seen = new Set<string>()

  const push = (r: PrechainRequirement): void => {
    // First package to depend on it wins: the report is about what must be
    // true BEFORE T1, so the earliest dependant is the one that matters.
    const key = `${r.object}|${r.privilege}|${r.requiredExecutor}`
    if (seen.has(key)) return
    seen.add(key)
    requirements.push(r)
  }

  for (const entry of CHAIN_PACKAGE_FILES) {
    const rows = plan.rowsByPackage.get(entry.packageId) ?? []
    for (const row of rows) {
      const disposition = dispositions.find(
        (d) => d.packageId === entry.packageId && d.statementIndex === row.statement.index,
      )
      if (disposition === undefined) continue
      const executor = disposition.requiredExecutor
      // The installer's own statements need nothing from this contract: they
      // run as the principal whose capabilities assert_hosted_capabilities
      // already checks.
      if (executor === INSTALLER_OWNER) continue

      const sql = normalizeExecutable(row.statement.raw)
      const statementClass = row.identity.statementClass
      const common = {
        requiredExecutor: executor,
        packageId: entry.packageId,
        statementIndex: row.statement.index,
      }

      if (statementClass === 'grant-privilege' || statementClass === 'revoke-privilege') {
        const target = privilegeTarget(row.identity)
        if (target === null || created.has(target)) continue
        if (created.has(`schema:${schemaOf(target)}`)) continue
        const isFunction = row.identity.object?.objectClass === 'function'
        // operands[0] is the privilege list, '+'-joined by the identity layer.
        const names = (row.identity.operands[0] ?? '').split('+').filter((n) => n.length > 0)
        push({
          ...common,
          privilegeNames: names,
          object: target,
          objectType: isFunction ? 'function' : 'table',
          privilege: isFunction ? 'EXECUTE_WITH_GRANT_OPTION' : 'TABLE_PRIVILEGE_WITH_GRANT_OPTION',
          why:
            `${statementClass} on an object the chain does not create. PostgreSQL requires the ` +
            `executor to OWN it or to hold the privilege WITH GRANT OPTION; merely holding the ` +
            `privilege is not enough.`,
        })
        continue
      }

      if (statementClass.startsWith('create-')) {
        for (const target of foreignKeyTargets(sql)) {
          if (created.has(target)) continue
          push({
            ...common,
            object: target,
            objectType: 'table',
            privilege: 'REFERENCES',
            privilegeNames: ['REFERENCES'],
            why:
              `a FOREIGN KEY needs REFERENCES on its TARGET. The failing statement never names a ` +
              `privilege, and the target is not the object being created.`,
          })
        }
        for (const target of triggerFunctions(sql)) {
          if (created.has(target)) continue
          push({
            ...common,
            object: `${target}()`,
            objectType: 'function',
            privilege: 'EXECUTE',
            privilegeNames: ['EXECUTE'],
            why: `CREATE TRIGGER needs EXECUTE on the function it calls.`,
          })
        }
        continue
      }

      if (
        statementClass.startsWith('alter-') ||
        statementClass === 'comment' ||
        statementClass === 'owner-transfer'
      ) {
        const target = privilegeTarget(row.identity)
        if (target === null || created.has(target)) continue
        if (created.has(`schema:${schemaOf(target)}`)) continue
        push({
          ...common,
          object: target,
          objectType: row.identity.object?.objectClass === 'function' ? 'function' : 'table',
          privilege: 'OWNERSHIP',
          privilegeNames: [],
          why: `${statementClass} requires OWNERSHIP. No privilege substitutes for it.`,
        })
      }
    }
  }

  return requirements
}

/**
 * The requirement set collapsed to one row per object.
 *
 * What a remediation has to satisfy is per OBJECT, not per statement — and the
 * strongest requirement wins, because a grant that satisfies REFERENCES does
 * not satisfy OWNERSHIP.
 */
export interface PrechainObjectContract {
  readonly object: string
  readonly objectType: 'table' | 'function'
  readonly privileges: readonly PrechainPrivilege[]
  readonly privilegeNames: readonly string[]
  readonly executors: readonly string[]
  readonly firstDependant: string
}

export function collapseByObject(
  requirements: readonly PrechainRequirement[],
): PrechainObjectContract[] {
  const byObject = new Map<string, PrechainRequirement[]>()
  for (const requirement of requirements) {
    const list = byObject.get(requirement.object) ?? []
    list.push(requirement)
    byObject.set(requirement.object, list)
  }
  return [...byObject.entries()].map(([object, list]) => ({
    object,
    objectType: list[0].objectType,
    privileges: [...new Set(list.map((r) => r.privilege))].sort(),
    privilegeNames: [...new Set(list.flatMap((r) => r.privilegeNames))].sort(),
    executors: [...new Set(list.map((r) => r.requiredExecutor))].sort(),
    firstDependant: `${list[0].packageId}[${list[0].statementIndex}]`,
  }))
}

/** The owner window is the only executor that can hold a prechain contract. */
export const PRECHAIN_CONTRACT_EXECUTOR = OWNER_ROLE

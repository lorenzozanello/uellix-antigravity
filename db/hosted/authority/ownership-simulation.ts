// db/hosted/authority/ownership-simulation.ts
// COMMIT 3 — `need = ownerBefore`, simulated across the whole chain.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
// ---------------------------------------------------------------------------
// It is NOT used to decide where a classification window begins. Those
// boundaries are recovered provenance (`recovered-boundaries.ts`) and this file
// must never be allowed to move one — an earlier attempt to re-derive them from
// the published counts was abandoned precisely because a count can check a rule
// but cannot identify one.
//
// It IS used for the two things the boundaries cannot do by themselves:
//
//   1. INDEPENDENT VALIDATION. For every governed statement, the simulated
//      `ownerBefore` must agree with the authority class the recovered window
//      assigns it. That is a statement-by-statement crosscheck of the recovered
//      table against the packages, not a re-derivation of it.
//
//   2. EXECUTION SEGMENTATION. A classification window says WHY a statement
//      needs elevation. It does not say which role must be `current_role` while
//      it runs, and four of the recovered windows involve two capability roles.
//      PostgreSQL has exactly one effective `current_role`, so those windows
//      must be executed as several segments, and the segment boundaries come
//      from `ownerBefore` changing.
//
// ---------------------------------------------------------------------------
// THE SEED STATE, AND WHY IT IS WHAT IT IS
// ---------------------------------------------------------------------------
// Pre-chain objects in `public` are owned by `uellix_owner`: that is the state
// `stella_0004_role_separation` establishes, and it is what the recovered
// windows assert — W01, W14 and W20 are OWNER windows and each of them ENDS on
// a `GRANT EXECUTE ON public.current_user_is_super_admin()`, which is only an
// owner-authority statement if that function is owner-owned.
//
// `public.uellix_auth_uid()` is the exception and is NOT seeded: the bootstrap
// creates it, as the installer, and never transfers it. So it stays with
// `postgres`, and the two RR-09 grants that name it fall outside every window —
// which is exactly where the recovered boundaries leave them.

import { readFileSync } from 'node:fs'

import { lexSql, splitSqlStatements, type SqlStatement } from './sql-statements'
import {
  formatObjectIdentity,
  parseStatementIdentity,
  type ObjectIdentity,
  type StatementIdentity,
} from './structural-identity'
import { CHAIN_PACKAGE_FILES } from './window-plan'

export const OWNER_ROLE = 'uellix_owner'
export const INSTALLER_OWNER = 'postgres'

export function isCapabilityRoleName(role: string): boolean {
  return role.startsWith('uellix_cap_')
}

/** Where the hosted artefacts live. The partition is defined over these. */
export function hostedArtefactPath(sourceFile: string, root = process.cwd()): string {
  return `${root}/db/prepared/hosted/${sourceFile.replace(/\.sql$/, '.hosted.sql')}`
}

export const BOOTSTRAP_ARTEFACT = 'stella_hosted_0001_managed_role_bootstrap.sql'

export interface SimulatedStatement {
  readonly packageId: string
  readonly statement: SqlStatement
  readonly identity: StatementIdentity
  /** The owner of the target object immediately BEFORE this statement. */
  readonly ownerBefore: string | null
  /** For an ownership transfer: the incoming owner. */
  readonly ownerDestination: string | null
}

const objectKey = (object: ObjectIdentity): string => formatObjectIdentity(object)

/**
 * The DO block that `capability-role-attributes` generates.
 *
 * It is one half of a MANAGED_REWRITE pair with the `ALTER ROLE` that follows
 * it, and the recovered partition counts the pair once — which is why the
 * hosted total is 320 and not 323.
 */
export function isGeneratedManagedRewriteDo(raw: string): boolean {
  return raw.includes('v_widened') && raw.includes('HOSTED VARIANT')
}

/** Qualified `schema.name` references inside a DO body, code and literals alike. */
export function referencedObjectNames(raw: string): Set<string> {
  const found = new Set<string>()
  const walk = (sql: string): void => {
    for (const segment of lexSql(sql)) {
      if (segment.kind === 'dollar-string') {
        walk(segment.dollarBody ?? '')
        continue
      }
      if (segment.kind !== 'code' && segment.kind !== 'string') continue
      const pattern = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi
      let match: RegExpExecArray | null
      while ((match = pattern.exec(segment.text)) !== null) {
        const schema = match[1].toLowerCase()
        if (schema.startsWith('pg_') || schema === 'information_schema') continue
        found.add(`${schema}.${match[2].toLowerCase()}`)
      }
    }
  }
  walk(raw)
  return found
}

export class OwnershipLedger {
  readonly #owners = new Map<string, string>()

  /** Creates during the bootstrap belong to the installer that applied it. */
  #creatorOwner = INSTALLER_OWNER

  enterChain(): void {
    // Chain packages create their objects inside owner windows, so a newly
    // created object belongs to uellix_owner. The recovered boundaries assert
    // this: every CREATE FUNCTION of a not-yet-existing routine sits inside an
    // OWNER window (W03, W07, W11, W17, W24, W30, W36, W43, W45, W48).
    this.#creatorOwner = OWNER_ROLE
  }

  get(object: ObjectIdentity): string {
    // A policy, trigger, constraint or column has no owner of its own: the
    // table's owner governs it. Resolving them separately would invent an
    // ownership entry PostgreSQL does not have.
    if (object.qualifier !== undefined) {
      return this.#owners.get(`table:${object.qualifier}`) ?? OWNER_ROLE
    }
    return this.#owners.get(objectKey(object)) ?? OWNER_ROLE
  }

  has(object: ObjectIdentity): boolean {
    return this.#owners.has(objectKey(object))
  }

  registerCreation(object: ObjectIdentity): string {
    const key = objectKey(object)
    const existing = this.#owners.get(key)
    if (existing !== undefined) return existing
    this.#owners.set(key, this.#creatorOwner)
    return this.#creatorOwner
  }

  transfer(object: ObjectIdentity, to: string): void {
    this.#owners.set(objectKey(object), to)
  }

  drop(object: ObjectIdentity): void {
    this.#owners.delete(objectKey(object))
  }

  /** Owners of every chain-known object a DO body names. */
  ownersOfReferenced(names: ReadonlySet<string>): Set<string> {
    const owners = new Set<string>()
    for (const [key, owner] of this.#owners) {
      const bare = key
        .replace(/^[a-z-]+:/, '')
        .replace(/\(.*\)$/, '')
        .replace(/@.*$/, '')
      if (names.has(bare)) owners.add(owner)
    }
    return owners
  }
}

/** Applies ownership effects that happen INSIDE a DO body — still real effects. */
function applyNestedEffects(ledger: OwnershipLedger, raw: string): void {
  const walk = (sql: string): void => {
    for (const segment of lexSql(sql)) {
      if (segment.kind !== 'dollar-string') continue
      const body = segment.dollarBody ?? ''
      for (const inner of splitSqlStatements(body)) {
        let identity
        try {
          identity = parseStatementIdentity(inner.raw)
        } catch {
          continue
        }
        if (identity.statementClass === 'owner-transfer' && identity.object !== null) {
          ledger.transfer(identity.object, identity.operands[0])
        }
      }
      walk(body)
    }
  }
  walk(raw)
}

export interface SimulationResult {
  readonly rows: readonly SimulatedStatement[]
  readonly ledger: OwnershipLedger
}

/**
 * Walks the bootstrap and then T1..T9 in chain order, recording `ownerBefore`
 * for every statement of the nine governed packages.
 *
 * The bootstrap's own statements are simulated but not recorded: it is
 * `native-hosted`, it installs the roles every window later acts as, and there
 * is no authority to elevate to before it has run.
 */
export function simulateChainOwnership(root = process.cwd()): SimulationResult {
  const ledger = new OwnershipLedger()
  const rows: SimulatedStatement[] = []

  const walkPackage = (packageId: string, path: string, record: boolean): void => {
    for (const statement of splitSqlStatements(readFileSync(path, 'utf8'))) {
      const identity = parseStatementIdentity(statement.raw)
      const statementClass = identity.statementClass

      if (statementClass === 'do-block') applyNestedEffects(ledger, statement.raw)

      let ownerBefore: string | null = null
      let ownerDestination: string | null = null

      if (statementClass === 'owner-transfer' && identity.object !== null) {
        ownerBefore = ledger.get(identity.object)
        ownerDestination = identity.operands[0]
        ledger.transfer(identity.object, ownerDestination)
      } else if (statementClass === 'do-block') {
        const owners = ledger.ownersOfReferenced(referencedObjectNames(statement.raw))
        const capabilities = [...owners].filter(isCapabilityRoleName)
        if (capabilities.length === 1) ownerBefore = capabilities[0]
        else if (capabilities.length > 1) ownerBefore = `MULTIPLE:${capabilities.sort().join('|')}`
        else if (owners.has(OWNER_ROLE)) ownerBefore = OWNER_ROLE
        else ownerBefore = null
      } else if (identity.object !== null) {
        const isCreate = statementClass.startsWith('create-')
        if (statementClass === 'create-schema') {
          ownerBefore = INSTALLER_OWNER
          ledger.registerCreation(identity.object)
        } else if (isCreate && !ledger.has(identity.object) && identity.object.qualifier === undefined) {
          ownerBefore = ledger.registerCreation(identity.object)
        } else {
          ownerBefore = ledger.get(identity.object)
          if (isCreate && identity.object.qualifier === undefined) {
            ledger.registerCreation(identity.object)
          }
        }
        if (statementClass === 'drop-object') ledger.drop(identity.object)
      }

      if (record) rows.push({ packageId, statement, identity, ownerBefore, ownerDestination })
    }
  }

  walkPackage('T0', hostedArtefactPath(BOOTSTRAP_ARTEFACT, root), false)
  ledger.enterChain()
  for (const entry of CHAIN_PACKAGE_FILES) {
    walkPackage(entry.packageId, hostedArtefactPath(entry.sourceFile, root), true)
  }

  return { rows, ledger }
}

/** The authority class `ownerBefore` implies, per the recovered stateful rule. */
export function authorityFromOwnerBefore(
  ownerBefore: string | null,
): 'OWNER' | 'CAPABILITY' | 'INSTALLER' | 'INDETERMINATE' {
  if (ownerBefore === null) return 'INDETERMINATE'
  if (ownerBefore.startsWith('MULTIPLE:')) return 'CAPABILITY'
  if (ownerBefore === OWNER_ROLE) return 'OWNER'
  if (isCapabilityRoleName(ownerBefore)) return 'CAPABILITY'
  return 'INSTALLER'
}

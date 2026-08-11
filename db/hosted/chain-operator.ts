// db/hosted/chain-operator.ts
// COMMIT 5.4 — the T1 prerequisite, enforced at the operator boundary
// (F-PS-02).
//
// ---------------------------------------------------------------------------
// THE FINDING, STATED PRECISELY
// ---------------------------------------------------------------------------
// `authorizeGovernedT1` is the certified predicate for "may the governed chain
// start": it requires the prechain remediation to be INSTALLED and the prechain
// authority gate to return no refusals, and it refuses if either is missing.
// `pnpm certify:remediation` exercises all four of its rows on a real engine.
//
// The operator, however, plans through `scripts/chain-attempt.ts`, which called
// `authorizeChainWrite` — a function that reasons about witnesses and chain
// order and has no concept of the remediation, because the remediation is not a
// chain package. The first package it can ever authorise is T1, and it would
// authorise it against a project where the reconciliation had never run.
//
// The engine is a real backstop: T1 refuses inside its own transaction, which
// is where E-01 was found three times. But a backstop that fires after psql has
// already reached staging is not the gate that was certified, and the whole
// point of a prechain gate is to answer "what does this chain need" before
// anything runs rather than "what breaks next" afterwards.
//
// ---------------------------------------------------------------------------
// WHY THE GATE IS KEYED ON THE PACKAGE AND NOT ON A MODE
// ---------------------------------------------------------------------------
// Only T1 has this prerequisite. T2..T9 depend on their predecessor being
// INSTALLED, which the chain witnesses already establish, and routing them
// through a remediation gate would mean demanding evidence that says nothing
// about whether T5 may follow T4. So the gate asks one question — is the
// package this observation authorises the FIRST governed package — and is inert
// otherwise. A flag would have been a second way to reach the same branch, and
// a second way to reach a gate is a way around it.
//
// ---------------------------------------------------------------------------
// EVIDENCE, NOT ASSERTIONS
// ---------------------------------------------------------------------------
// Both inputs are documents a read-only probe produced, bound to the attempt
// the chain observation was measured for, and parsed by validators that refuse
// rather than coerce. There is deliberately no `--remediation-installed` flag:
// the state of the database is not something the operator is asked to declare.

import {
  CHAIN_ATTEMPT_KIND,
  CHAIN_WRITE_ORDER,
  authorizeChainWrite,
  type ChainWriteAuthorization,
  type ChainWriteRequest,
} from './fresh-observation'
import {
  authorizeGovernedT1,
  classifyRemediation,
  type RemediationClassification,
} from './prechain-remediation'
import {
  RemediationTransportRefusal,
  parseRemediationWitness,
} from './authority/certification/remediation-probes'
import {
  validateHostedPrechainAuthorityContract,
  type PrechainObservation,
  type PrechainRefusal,
} from './authority/certification/prechain-authority-gate'
import {
  collapseByObject,
  derivePrechainRequirements,
  type PrechainObjectContract,
} from './authority/certification/prechain-requirements'
import { prechainObservationSql } from './authority/certification/engine-probes'
import {
  GovernedArtefactRefusal,
  GovernedInputRefusal,
  resolveGovernedApplyTarget,
} from './governed-artefact'

/** The first governed package. The only one with a prechain prerequisite. */
export const GOVERNED_T1_PACKAGE = CHAIN_WRITE_ORDER[0] as string

/** The envelope's version. A document that does not name it is not this format. */
export const PRECHAIN_OBSERVATION_SCHEMA = 'uellix.hosted.prechain.observation/1'

/* -------------------------------------------------------------------------- */
/* The prechain probe, bound to an attempt                                     */
/* -------------------------------------------------------------------------- */

export class PrechainTransportRefusal extends Error {
  readonly code: string
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.code = code
    this.name = 'PrechainTransportRefusal'
  }
}

const ATTEMPT_SHAPE = /^att_[0-9a-f]{32}$/

/**
 * The anchors the attempt binding is wrapped around.
 *
 * Matched EXACTLY ONCE each or this throws. `prechainObservationSql` is
 * generated from the derived requirement set, so it legitimately changes when a
 * package starts depending on a new baseline object; what must never happen is
 * that it changes in a way which silently drops the echo and leaves a document
 * nobody can attribute to an attempt.
 */
const HEAD_ANCHOR = "SELECT jsonb_build_object(\n  'roles',"
const TAIL_ANCHOR = '\n)::text;'

/**
 * The certified prechain observation, wrapped so the server echoes the attempt.
 *
 * The BODY is `prechainObservationSql`'s output, unmodified: the gate and the
 * probe are two halves of one contract derived from the same plan, and a
 * hand-written second probe would be a second thing to keep in step with it.
 */
export function buildPrechainObservationSql(
  attemptId: string,
  contracts: readonly PrechainObjectContract[] = collapseByObject(derivePrechainRequirements()),
): string {
  if (!ATTEMPT_SHAPE.test(attemptId)) {
    throw new PrechainTransportRefusal(
      'PRECHAIN_PROBE_ATTEMPT_MALFORMED',
      `refusing to build a probe for attempt id ${JSON.stringify(attemptId)}: an attempt id is ` +
        `att_ followed by 32 hex characters. The id is compiled in as a literal, and the shape is ` +
        `the reason no escaping is needed.`,
    )
  }
  const base = prechainObservationSql(
    contracts.map((c) => ({
      object: c.object,
      objectType: c.objectType,
      privileges: c.privilegeNames,
    })),
  )
  for (const [name, anchor] of [
    ['head', HEAD_ANCHOR],
    ['tail', TAIL_ANCHOR],
  ] as const) {
    const occurrences = base.split(anchor).length - 1
    if (occurrences !== 1) {
      throw new PrechainTransportRefusal(
        'PRECHAIN_PROBE_ANCHOR_MOVED',
        `the ${name} injection anchor was found ${occurrences} time(s) in the prechain observation ` +
          `SQL, expected exactly 1.`,
      )
    }
  }
  return base
    .replace(
      HEAD_ANCHOR,
      `SELECT jsonb_build_object(\n  'schema', '${PRECHAIN_OBSERVATION_SCHEMA}',\n` +
        `  'attemptId', '${attemptId}',\n  'observation', jsonb_build_object(\n  'roles',`,
    )
    .replace(TAIL_ANCHOR, '\n))::text;')
}

/* -------------------------------------------------------------------------- */
/* The prechain validator                                                      */
/* -------------------------------------------------------------------------- */

const bad = (detail: string): never => {
  throw new PrechainTransportRefusal('PRECHAIN_OBSERVATION_MALFORMED', detail)
}

const bool = (v: unknown, field: string): boolean =>
  typeof v === 'boolean' ? v : (bad(`${field} is ${JSON.stringify(v)}, not a boolean.`) as never)

const str = (v: unknown, field: string): string =>
  typeof v === 'string' ? v : (bad(`${field} is ${JSON.stringify(v)}, not a string.`) as never)

function boolMap(v: unknown, field: string): Record<string, boolean> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) bad(`${field} is not an object.`)
  const out: Record<string, boolean> = {}
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    out[k] = bool(value, `${field}.${k}`)
  }
  return out
}

function rows(v: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(v)) bad(`${field} is ${JSON.stringify(v)}; the probe emits an array.`)
  return (v as unknown[]).map((row, i) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      bad(`${field}[${i}] is not an object.`)
    }
    return row as Record<string, unknown>
  })
}

/**
 * Parse, bind to the attempt, and TYPE-CHECK every field the gate reads.
 *
 * Refuses rather than coerces, for the reason `parseRemediationWitness` does: a
 * missing boolean is not `false`. `installerCanSetOwner` absent would become
 * "the installer cannot become the owner", which is a refusal — safe here — but
 * `createRole` absent would become "no CREATEROLE", and a gate that refuses for
 * a reason that was never measured sends an operator to repair a database that
 * was already correct.
 */
export function parsePrechainObservationDocument(
  raw: string | null,
  expectedAttemptId: string,
): PrechainObservation {
  if (raw === null || raw.trim() === '') {
    throw new PrechainTransportRefusal(
      'PRECHAIN_OBSERVATION_REQUIRED',
      'no prechain observation was supplied. The absence of a measurement is not a measurement.',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new PrechainTransportRefusal(
      'PRECHAIN_OBSERVATION_MALFORMED',
      `the prechain observation is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PrechainTransportRefusal(
      'PRECHAIN_OBSERVATION_MALFORMED',
      'the prechain observation is not a JSON object.',
    )
  }
  const doc = parsed as Record<string, unknown>
  if (doc.schema !== PRECHAIN_OBSERVATION_SCHEMA) {
    throw new PrechainTransportRefusal(
      'PRECHAIN_OBSERVATION_MALFORMED',
      `schema is ${JSON.stringify(doc.schema)}; this reader consumes ${PRECHAIN_OBSERVATION_SCHEMA}.`,
    )
  }
  if (doc.attemptId !== expectedAttemptId) {
    throw new PrechainTransportRefusal(
      'PRECHAIN_OBSERVATION_ATTEMPT_MISMATCH',
      `the document echoes attempt ${JSON.stringify(doc.attemptId)} and the open attempt is ` +
        `${expectedAttemptId}. Evidence for a T1 decision must be measured for the attempt that is ` +
        `about to authorise it.`,
    )
  }
  if (doc.observation === null || typeof doc.observation !== 'object' || Array.isArray(doc.observation)) {
    throw new PrechainTransportRefusal(
      'PRECHAIN_OBSERVATION_MALFORMED',
      'observation is absent or is not an object.',
    )
  }
  const o = doc.observation as Record<string, unknown>

  const capability: Record<string, readonly string[]> = {}
  if (o.capabilityReachableBy === null || typeof o.capabilityReachableBy !== 'object' || Array.isArray(o.capabilityReachableBy)) {
    bad('observation.capabilityReachableBy is not an object.')
  }
  for (const [role, list] of Object.entries(o.capabilityReachableBy as Record<string, unknown>)) {
    if (!Array.isArray(list)) bad(`observation.capabilityReachableBy.${role} is not an array.`)
    capability[role] = (list as unknown[]).map((n, i) =>
      str(n, `observation.capabilityReachableBy.${role}[${i}]`),
    )
  }

  return {
    roles: rows(o.roles, 'observation.roles').map((r, i) => ({
      name: str(r.name, `observation.roles[${i}].name`),
      canLogin: bool(r.canLogin, `observation.roles[${i}].canLogin`),
      createRole: bool(r.createRole, `observation.roles[${i}].createRole`),
      isSuper: bool(r.isSuper, `observation.roles[${i}].isSuper`),
    })),
    memberships: rows(o.memberships, 'observation.memberships').map((m, i) => ({
      role: str(m.role, `observation.memberships[${i}].role`),
      member: str(m.member, `observation.memberships[${i}].member`),
      grantor: str(m.grantor, `observation.memberships[${i}].grantor`),
      adminOption: bool(m.adminOption, `observation.memberships[${i}].adminOption`),
      inheritOption: bool(m.inheritOption, `observation.memberships[${i}].inheritOption`),
      setOption: bool(m.setOption, `observation.memberships[${i}].setOption`),
    })),
    objects: rows(o.objects, 'observation.objects').map((x, i) => ({
      object: str(x.object, `observation.objects[${i}].object`),
      present: bool(x.present, `observation.objects[${i}].present`),
      owner:
        x.owner === null ? null : str(x.owner, `observation.objects[${i}].owner`),
      held: boolMap(x.held, `observation.objects[${i}].held`),
      heldWithGrantOption: boolMap(
        x.heldWithGrantOption,
        `observation.objects[${i}].heldWithGrantOption`,
      ),
    })),
    schemaCreate: boolMap(o.schemaCreate, 'observation.schemaCreate'),
    installerCanSetOwner: bool(o.installerCanSetOwner, 'observation.installerCanSetOwner'),
    capabilityReachableBy: capability,
  }
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

export interface T1GateRefusal {
  readonly ok: false
  readonly code: string
  readonly detail: string
}

export type T1GateResult =
  | { readonly ok: true; readonly required: false }
  | {
      readonly ok: true
      readonly required: true
      readonly remediation: RemediationClassification
      readonly gateRefusals: readonly PrechainRefusal[]
      readonly contracts: number
    }
  | T1GateRefusal

export interface T1GateInputs {
  /** The package the chain observation authorises. Inert unless it is T1. */
  readonly packageId: string
  /** The attempt both evidence documents must echo. */
  readonly attemptId: string
  readonly witnessRaw?: string | null
  readonly prechainRaw?: string | null
  readonly contracts?: readonly PrechainObjectContract[]
}

const deny = (code: string, detail: string): T1GateRefusal => ({ ok: false, code, detail })

/**
 * Whether governed T1 may be planned — decided by `authorizeGovernedT1`.
 *
 * This function measures nothing and concludes nothing. It establishes that the
 * two inputs the certified predicate needs are real measurements bound to this
 * attempt, and then asks it.
 */
export function gateGovernedT1(inputs: T1GateInputs): T1GateResult {
  if (inputs.packageId !== GOVERNED_T1_PACKAGE) return { ok: true, required: false }

  const missing: string[] = []
  if (inputs.witnessRaw === undefined || inputs.witnessRaw === null) missing.push('remediation witness')
  if (inputs.prechainRaw === undefined || inputs.prechainRaw === null) missing.push('prechain observation')
  if (missing.length > 0) {
    return deny(
      'CHAIN_T1_EVIDENCE_REQUIRED',
      `${GOVERNED_T1_PACKAGE} is the first governed package and its prerequisite is not a chain ` +
        `witness: it needs the prechain remediation INSTALLED and the prechain authority gate ` +
        `passing. Missing ${missing.join(' and ')}. Both are read-only probes emitted by ` +
        `pnpm chain:attempt:open and both must be measured for this attempt — the state of the ` +
        `database is not something an operator declares on the command line.`,
    )
  }

  const contracts = inputs.contracts ?? collapseByObject(derivePrechainRequirements())

  let remediation: RemediationClassification
  try {
    remediation = classifyRemediation(
      parseRemediationWitness(inputs.witnessRaw ?? null, inputs.attemptId).observation,
    )
  } catch (error) {
    if (error instanceof RemediationTransportRefusal) return deny(error.code, error.message)
    throw error
  }

  let gateRefusals: readonly PrechainRefusal[]
  try {
    gateRefusals = validateHostedPrechainAuthorityContract(
      parsePrechainObservationDocument(inputs.prechainRaw ?? null, inputs.attemptId),
      contracts,
    )
  } catch (error) {
    if (error instanceof PrechainTransportRefusal) return deny(error.code, error.message)
    throw error
  }

  const authorization = authorizeGovernedT1(remediation, gateRefusals)
  if (!authorization.ok) return deny(authorization.code, authorization.detail)

  return { ok: true, required: true, remediation, gateRefusals, contracts: contracts.length }
}

/* -------------------------------------------------------------------------- */
/* One operator plan                                                           */
/* -------------------------------------------------------------------------- */

export interface ChainOperatorRecord {
  readonly CHAIN_ATTEMPT_ID: string
  readonly TARGET_PROJECT_REF: string
  readonly PACKAGE_ID: string
  /** ALWAYS the governed artefact. Resolved, fenced and pinned before issue. */
  readonly PACKAGE_PATH: string
  readonly PACKAGE_DIGEST: string
  readonly T1_GATE: 'NOT_APPLICABLE' | 'PASS'
  readonly REMEDIATION_WITNESS: 'NOT_MEASURED' | 'INSTALLED'
  readonly PRECHAIN_AUTHORITY_GATE: 'NOT_APPLICABLE' | 'PASS'
  readonly ATTEMPT_STATUS: 'CONSUMED'
  readonly DECISION: 'AUTHORIZED'
}

export interface ChainOperatorAuthorization {
  readonly ok: true
  readonly authorization: ChainWriteAuthorization
  /** Null for T2..T9 — they have no prechain prerequisite. */
  readonly t1: null | {
    readonly remediation: string
    readonly prechainRefusals: number
    readonly contracts: number
  }
  readonly record: ChainOperatorRecord
  /** Appended by the caller. Present ONLY on an authorization. */
  readonly consumedLedgerLine: string
}

export type ChainOperatorResult = ChainOperatorAuthorization | T1GateRefusal

export interface ChainOperatorInputs extends ChainWriteRequest {
  readonly witnessRaw?: string | null
  readonly prechainRaw?: string | null
  readonly contracts?: readonly PrechainObjectContract[]
  readonly at: string
  /** Repo root, for resolving the governed artefact. */
  readonly root?: string
  /**
   * Injected so the fence and pin refusals can be exercised without writing a
   * corrupted artefact into the repository — the same reason
   * `resolveGovernedInput` takes one.
   */
  readonly readGovernedArtefact?: (absolutePath: string) => string
}

/**
 * The single entry point the chain operator CLI may call.
 *
 * Both gates run BEFORE anything is consumable: a refusal carries no ledger
 * line at all, so there is no path on which a caller can append CONSUMED for a
 * write that was never authorised. That is a stronger statement than ordering
 * the statements correctly, because it cannot be undone by an edit.
 */
export function planChainWriteForOperator(inputs: ChainOperatorInputs): ChainOperatorResult {
  const authorization = authorizeChainWrite(inputs)
  if (!authorization.ok) return deny(authorization.code, authorization.detail)

  // THE ARTEFACT, BEFORE THE PLAN. A package is applied from the GOVERNED file
  // and from nowhere else. Resolving here means a missing, mislocated or
  // moved artefact is refused while the operator still has nothing to run —
  // rather than at line 915 of a transaction already open against staging,
  // which is how this requirement was discovered.
  let target: ReturnType<typeof resolveGovernedApplyTarget>
  try {
    target = resolveGovernedApplyTarget(
      authorization.packageId,
      inputs.root,
      inputs.readGovernedArtefact,
    )
  } catch (error) {
    if (error instanceof GovernedArtefactRefusal || error instanceof GovernedInputRefusal) {
      return deny(error.code, error.message)
    }
    throw error
  }

  const t1 = gateGovernedT1({
    packageId: authorization.packageId,
    attemptId: authorization.attemptId,
    ...(inputs.witnessRaw !== undefined ? { witnessRaw: inputs.witnessRaw } : {}),
    ...(inputs.prechainRaw !== undefined ? { prechainRaw: inputs.prechainRaw } : {}),
    ...(inputs.contracts !== undefined ? { contracts: inputs.contracts } : {}),
  })
  if (!t1.ok) return t1

  return {
    ok: true,
    authorization,
    t1: t1.required
      ? {
          remediation: t1.remediation.state,
          prechainRefusals: t1.gateRefusals.length,
          contracts: t1.contracts,
        }
      : null,
    record: {
      CHAIN_ATTEMPT_ID: authorization.attemptId,
      TARGET_PROJECT_REF: authorization.projectRef,
      PACKAGE_ID: authorization.packageId,
      PACKAGE_PATH: target.relativePath,
      PACKAGE_DIGEST: target.digest,
      T1_GATE: t1.required ? 'PASS' : 'NOT_APPLICABLE',
      REMEDIATION_WITNESS: t1.required ? 'INSTALLED' : 'NOT_MEASURED',
      PRECHAIN_AUTHORITY_GATE: t1.required ? 'PASS' : 'NOT_APPLICABLE',
      ATTEMPT_STATUS: 'CONSUMED',
      DECISION: 'AUTHORIZED',
    },
    consumedLedgerLine: `${JSON.stringify({
      attemptId: authorization.attemptId,
      event: 'CONSUMED',
      targetProjectRef: authorization.projectRef,
      at: inputs.at,
      packageId: authorization.packageId,
      kind: CHAIN_ATTEMPT_KIND,
    })}\n`,
  }
}

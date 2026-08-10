// db/hosted/fresh-observation.ts
// COMMIT 1 — the PRE-WRITE freshness gate for PHASE_STELLA_CHAIN.
//
// ---------------------------------------------------------------------------
// THE HOLE THIS CLOSES (adversarial finding RT-02)
// ---------------------------------------------------------------------------
// `planChainPhase` computed the remaining packages from
// `request.state.stellaPackagesInstalled` — a map the CALLER supplied. Nothing
// asked where it came from or when. So this sequence authorised a re-apply of a
// package that was already committed:
//
//   1. `psql -1 -f grounding_0002…` reaches the server and COMMITS.
//   2. The connection dies before the client sees the acknowledgement.
//   3. No POST_T1 evidence is written, because the runner never returned.
//   4. The operator re-plans with the state they still have on screen —
//      PRECHAIN, T1 ABSENT — and the planner authorises T1 again.
//
// `psql -1` does not help: the transaction the client lost had already
// committed. Neither does the chain evidence registry, whose delta and prefix
// rules are excellent and run AFTER the write, on the evidence path. The gap was
// on the AUTHORISATION path, and it was total.
//
// The one thing that closes it is refusing to authorise a write from anything
// except a measurement of the database taken FOR THIS ATTEMPT.
//
// ---------------------------------------------------------------------------
// WHAT MAKES AN OBSERVATION "FRESH", GIVEN THAT A CLOCK PROVES NOTHING
// ---------------------------------------------------------------------------
// A timestamp is metadata: an operator re-running yesterday's probe file gets
// yesterday's answer with today's `observedAt` the moment anything re-stamps it.
// Freshness here is a BINDING instead:
//
//   * the attempt id is minted BEFORE the probe;
//   * it is compiled INTO the probe SQL as a literal, so the database itself
//     echoes it in the document it produces;
//   * the evaluator refuses any observation whose echoed attempt is not the
//     attempt now open;
//   * an attempt is CONSUMED by the plan it authorises, so one observation
//     authorises exactly one write.
//
// Editing `attemptId` in an old file therefore does not produce a fresh
// observation: it produces a document whose digest no longer covers its
// contents, and whose attempt was opened for a probe that never ran.
//
// The digest is INTEGRITY, not authentication. It makes accidental edits and
// copy-paste between attempts loud. It is not a signature and nothing here
// pretends a determined operator cannot recompute it — the threat model is a
// lost acknowledgement and a tired human, not a forger.
//
// ---------------------------------------------------------------------------
// WHY THIS REUSES THE A1 CONTRACT INSTEAD OF DECLARING A SECOND ONE
// ---------------------------------------------------------------------------
// `parseA1Corroboration` already refuses twenty-odd ways for exactly this
// document: secrets, missing fields, a sentinel that contradicts itself, a
// journal carrying a foreign project, a witness set that is not the registry's.
// A second parser would be a second spelling of that contract, and the two would
// drift the first time a witness moved. So the envelope below carries the
// attempt binding and DELEGATES the body, unchanged, to the parser that already
// governs it.

import { createHash } from 'node:crypto'

import {
  A1_OBSERVATION_SQL,
  buildA1CorroborationSql,
  parseA1Corroboration,
  type A1Corroboration,
  type PackageState,
} from './checkpoint-a1'
import { HOSTED_CHAIN } from './hosted-package-manifest'
import {
  PACKAGE_WITNESSES,
  WITNESSED_PACKAGES,
  classifyAllPackages,
  type PackageWitnesses,
} from './package-witnesses'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  redactForHostedLog,
  verifyStagingTarget,
  type ProductionIdentifiers,
} from './target-identity'

/**
 * The reapply policy this module ENACTS, named so documentation and code cannot
 * drift apart without a test noticing.
 *
 * NOT a switch. Nothing reads it to decide anything — the refusal it describes
 * is `CHAIN_TARGET_ALREADY_INSTALLED` in `authorizeChainWrite`, and that is the
 * only implementation. A second source of truth is what this avoids: the
 * constant exists so the governing runbook can be asserted against the behaviour
 * rather than against someone's memory of it.
 *
 * See docs/ops/staging/STELLA_HOSTED_FORWARD_ONLY_CONTRACT.md.
 */
export const HOSTED_CHAIN_REAPPLY_POLICY = 'forward-only' as const

/** What an INSTALLED package gets, in one word. Enacted, never consulted. */
export const INSTALLED_PACKAGE_ACTION = 'refuse' as const

/** The envelope's version. A document that does not name it is not this format. */
export const PRE_WRITE_OBSERVATION_SCHEMA = 'uellix.hosted.chain.observation/1'

/**
 * `att_` and 32 hex characters.
 *
 * Narrow ON PURPOSE. The id is compiled into SQL as a literal, and a shape that
 * cannot contain a quote is worth more than any escaping routine: there is no
 * input this accepts that could close the literal. `buildPreWriteObservationSql`
 * refuses anything else rather than escaping it.
 */
export const ATTEMPT_ID_SHAPE = /^att_[0-9a-f]{32}$/

/** The only phase this module authorises. POST evidence is the registry's job. */
export type ObservationPhase = 'PRE_WRITE'

export interface FreshChainObservation {
  readonly schema: string
  readonly phase: ObservationPhase
  /** Minted before the probe, echoed BY the database inside `corroboration`. */
  readonly attemptId: string
  /** Identifies this document. Audit metadata; never a freshness control. */
  readonly observationId: string
  /** Assembled around the probe output, governed by `parseA1Corroboration`. */
  readonly corroboration: A1Corroboration
  /** SHA-256 over the canonical form of everything above. Integrity only. */
  readonly digest: string
}

export type FreshObservationRefusalCode =
  | 'CHAIN_OBSERVATION_REQUIRED'
  | 'CHAIN_OBSERVATION_MALFORMED'
  | 'CHAIN_OBSERVATION_PHASE_INVALID'
  | 'CHAIN_OBSERVATION_ATTEMPT_MALFORMED'
  | 'CHAIN_OBSERVATION_ATTEMPT_MISMATCH'
  | 'CHAIN_OBSERVATION_ATTEMPT_NOT_OPEN'
  | 'CHAIN_OBSERVATION_DIGEST_INVALID'
  | 'CHAIN_OBSERVATION_TARGET_MISMATCH'
  | 'CHAIN_OBSERVATION_SENTINEL_INVALID'
  | 'CHAIN_OBSERVATION_PARTIAL_STATE'
  | 'CHAIN_TARGET_ALREADY_INSTALLED'
  | 'CHAIN_PREDECESSOR_STATE_INVALID'
  | 'CHAIN_NEXT_PACKAGE_MISMATCH'
  | 'CHAIN_SEQUENCE_COMPLETE'

export interface FreshObservationRefusal {
  readonly ok: false
  readonly code: FreshObservationRefusalCode
  readonly detail: string
}

const refuse = (
  code: FreshObservationRefusalCode,
  detail: string,
): FreshObservationRefusal => ({ ok: false, code, detail: redactForHostedLog(detail) })

/* -------------------------------------------------------------------------- */
/* Canonical form and digest                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic serialization: object keys sorted, arrays in order, no spacing.
 *
 * `JSON.stringify` preserves INSERTION order, so two documents with identical
 * content but different key order would digest differently and a re-assembled
 * artefact would look tampered with. Sorting removes that false positive without
 * losing any true one — the VALUES are all still covered.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** The bytes the digest covers: everything except the digest itself. */
export function digestedBody(o: {
  readonly schema: string
  readonly phase: string
  readonly attemptId: string
  readonly observationId: string
  readonly corroboration: unknown
}): string {
  return canonicalJson({
    schema: o.schema,
    phase: o.phase,
    attemptId: o.attemptId,
    observationId: o.observationId,
    corroboration: o.corroboration,
  })
}

export function observationDigest(o: Parameters<typeof digestedBody>[0]): string {
  return createHash('sha256').update(digestedBody(o), 'utf8').digest('hex')
}

/* -------------------------------------------------------------------------- */
/* The probe                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The anchor the attempt binding is injected at.
 *
 * Matched EXACTLY ONCE or this throws. `buildA1CorroborationSql` is generated
 * from the witness registry, so it can legitimately change; what must never
 * happen is that it changes in a way that silently drops the attempt echo and
 * leaves a probe whose output no longer proves which attempt measured it.
 */
const PROBE_ANCHOR = "SELECT jsonb_pretty(jsonb_build_object(\n  'targetProjectRef',"

/**
 * The read-only probe FOR ONE ATTEMPT.
 *
 * Built in memory, never written to the repository as a pinned artefact: a probe
 * that lives on disk is a probe an operator can re-run tomorrow, and re-running
 * yesterday's probe is precisely what this gate exists to detect. The attempt id
 * is a SQL literal rather than a `-v` variable for the same reason — a variable
 * is supplied at run time by the person the gate is protecting.
 *
 * The body is `db/prepared/checkpoint-a1/corroboration.sql`'s generator output,
 * unmodified apart from the injected echo. That file stays pinned and untouched.
 */
export function buildPreWriteObservationSql(
  attemptId: string,
  registry: Readonly<Record<string, PackageWitnesses>> = PACKAGE_WITNESSES,
  packageIds: readonly string[] = WITNESSED_PACKAGES,
  expectedProjectRef: string = KNOWN_STAGING_PROJECT_REF,
  production: ProductionIdentifiers = KNOWN_PRODUCTION_IDENTIFIERS,
): string {
  if (!ATTEMPT_ID_SHAPE.test(attemptId)) {
    throw new Error(
      `[chain] refusing to build a probe for attempt id ${JSON.stringify(attemptId)}: ` +
        `an attempt id is att_ followed by 32 hex characters. The id is compiled into SQL as a ` +
        `literal, and the shape is the reason no escaping is needed.`,
    )
  }
  const base = buildA1CorroborationSql(registry, packageIds, expectedProjectRef, production)
  const occurrences = base.split(PROBE_ANCHOR).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `[chain] refusing to build the pre-write probe: the injection anchor was found ${occurrences} ` +
        `time(s) in the A1 corroboration SQL, expected exactly 1. The probe must echo the attempt id ` +
        `it was built for; a probe that silently lost the echo would authorise a write from a ` +
        `measurement nobody can attribute to this attempt.`,
    )
  }
  return base.replace(
    PROBE_ANCHOR,
    `SELECT jsonb_pretty(jsonb_build_object(\n  'attemptId', '${attemptId}',\n  'targetProjectRef',`,
  )
}

/* -------------------------------------------------------------------------- */
/* Attempt ledger                                                             */
/* -------------------------------------------------------------------------- */

/** Append-only. One JSON object per line. Never rewritten, never truncated. */
export const CHAIN_ATTEMPT_LEDGER = 'artifacts/hosted-chain-attempts.jsonl'

export interface ChainAttemptRecord {
  readonly attemptId: string
  readonly event: 'OPENED' | 'CONSUMED'
  readonly targetProjectRef: string
  /** ISO 8601. Audit metadata — read by humans, never by a freshness check. */
  readonly at: string
  /** Present on CONSUMED: the one package the attempt authorised. */
  readonly packageId?: string
}

export type AttemptStatus = 'UNKNOWN' | 'OPEN' | 'CONSUMED'

export function parseAttemptLedger(raw: string | null): readonly ChainAttemptRecord[] {
  if (raw === null) return []
  const out: ChainAttemptRecord[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (t === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(t)
    } catch {
      continue // a corrupt line is not an attempt; it can never make one OPEN
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const r = parsed as Record<string, unknown>
    if (typeof r.attemptId !== 'string' || !ATTEMPT_ID_SHAPE.test(r.attemptId)) continue
    if (r.event !== 'OPENED' && r.event !== 'CONSUMED') continue
    if (typeof r.targetProjectRef !== 'string' || typeof r.at !== 'string') continue
    out.push({
      attemptId: r.attemptId,
      event: r.event,
      targetProjectRef: r.targetProjectRef,
      at: r.at,
      ...(typeof r.packageId === 'string' ? { packageId: r.packageId } : {}),
    })
  }
  return out
}

/**
 * OPEN only while it is BOTH unconsumed AND the most recently opened attempt.
 *
 * The second half is what stops an operator from reaching back past a newer
 * measurement to an older one that still said ABSENT. Opening an attempt is the
 * act that retires every attempt before it.
 */
export function attemptStatus(
  records: readonly ChainAttemptRecord[],
  attemptId: string,
): AttemptStatus {
  const opened = records.filter((r) => r.event === 'OPENED')
  const mine = opened.filter((r) => r.attemptId === attemptId)
  if (mine.length === 0) return 'UNKNOWN'
  if (records.some((r) => r.event === 'CONSUMED' && r.attemptId === attemptId)) return 'CONSUMED'
  const latest = opened[opened.length - 1]
  return latest !== undefined && latest.attemptId === attemptId ? 'OPEN' : 'CONSUMED'
}

/* -------------------------------------------------------------------------- */
/* Parse and evaluate                                                         */
/* -------------------------------------------------------------------------- */

export type FreshObservationParseResult =
  | { readonly ok: true; readonly observation: FreshChainObservation }
  | FreshObservationRefusal

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

export function parseFreshChainObservation(
  raw: string | null,
  targetProjectRef: string = KNOWN_STAGING_PROJECT_REF,
  production: ProductionIdentifiers = KNOWN_PRODUCTION_IDENTIFIERS,
  registry: Readonly<Record<string, PackageWitnesses>> = PACKAGE_WITNESSES,
  packageIds: readonly string[] = WITNESSED_PACKAGES,
): FreshObservationParseResult {
  if (raw === null || raw.trim() === '') {
    return refuse(
      'CHAIN_OBSERVATION_REQUIRED',
      `no pre-write observation was supplied. A chain write is authorised by a measurement of THIS ` +
        `database taken for THIS attempt — never by the state of a previous plan, and never by the ` +
        `absence of evidence, which says nothing about what the database contains.`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return refuse('CHAIN_OBSERVATION_MALFORMED', 'the pre-write observation is not valid JSON.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('CHAIN_OBSERVATION_MALFORMED', 'the pre-write observation is not a JSON object.')
  }
  const o = parsed as Record<string, unknown>

  if (o.schema !== PRE_WRITE_OBSERVATION_SCHEMA) {
    return refuse(
      'CHAIN_OBSERVATION_MALFORMED',
      `schema is ${JSON.stringify(o.schema)}; this gate reads ${PRE_WRITE_OBSERVATION_SCHEMA}.`,
    )
  }
  if (o.phase !== 'PRE_WRITE') {
    return refuse(
      'CHAIN_OBSERVATION_PHASE_INVALID',
      `phase is ${JSON.stringify(o.phase)}. Only a PRE_WRITE observation authorises a write; a POST ` +
        `observation describes a database that has already been written to.`,
    )
  }
  if (!isStr(o.attemptId) || !ATTEMPT_ID_SHAPE.test(o.attemptId)) {
    return refuse(
      'CHAIN_OBSERVATION_ATTEMPT_MALFORMED',
      'attemptId is absent or is not att_ followed by 32 hex characters.',
    )
  }
  if (!isStr(o.observationId)) {
    return refuse('CHAIN_OBSERVATION_MALFORMED', 'observationId is absent or is not a string.')
  }
  if (!isStr(o.digest)) {
    return refuse('CHAIN_OBSERVATION_MALFORMED', 'digest is absent or is not a string.')
  }
  if (o.corroboration === null || typeof o.corroboration !== 'object' || Array.isArray(o.corroboration)) {
    return refuse('CHAIN_OBSERVATION_MALFORMED', 'corroboration is absent or is not an object.')
  }

  // DIGEST BEFORE CONTENT. Everything below reads fields; if the document was
  // edited after it was assembled, the reader should learn that before it starts
  // believing any of them.
  const expected = observationDigest({
    schema: o.schema,
    phase: o.phase,
    attemptId: o.attemptId,
    observationId: o.observationId,
    corroboration: o.corroboration,
  })
  if (o.digest !== expected) {
    return refuse(
      'CHAIN_OBSERVATION_DIGEST_INVALID',
      `the digest does not cover these contents. Something changed between the probe and this gate — ` +
        `a package state, the attempt id, the target, or a witness. Re-open an attempt and re-measure; ` +
        `an observation is not a document to edit.`,
    )
  }

  // THE BODY, delegated to the contract that already governs it.
  const body = parseA1Corroboration(
    JSON.stringify(o.corroboration),
    targetProjectRef,
    production,
    registry,
    packageIds,
  )
  if (!body.ok) {
    return refuse(
      body.code === 'A1_SENTINEL_MALFORMED' ||
        body.code === 'A1_SENTINEL_ROW_COUNT' ||
        body.code === 'A1_SENTINEL_TABLE_ABSENT' ||
        body.code === 'A1_SENTINEL_SELF_CONTRADICTORY'
        ? 'CHAIN_OBSERVATION_SENTINEL_INVALID'
        : body.code === 'A1_OBSERVATION_REF_MISMATCH' ||
            body.code === 'A1_PRODUCTION_REF' ||
            body.code === 'A1_DECLARED_REF_MALFORMED' ||
            body.code === 'A1_JOURNAL_FOREIGN_PROJECT'
          ? 'CHAIN_OBSERVATION_TARGET_MISMATCH'
          : 'CHAIN_OBSERVATION_MALFORMED',
      `${body.code}: ${body.detail}`,
    )
  }

  // The database's own echo must agree with the envelope. They come from two
  // different places — the envelope from the tool, the echo from the server —
  // and a disagreement means the two halves describe different runs.
  const echoed = (o.corroboration as Record<string, unknown>).observation as
    | Record<string, unknown>
    | undefined
  if (echoed?.attemptId !== o.attemptId) {
    return refuse(
      'CHAIN_OBSERVATION_ATTEMPT_MISMATCH',
      `the envelope names attempt ${o.attemptId} and the probe output echoes ` +
        `${JSON.stringify(echoed?.attemptId ?? null)}. The attempt id is compiled into the probe, so a ` +
        `disagreement means the document was assembled around output from a different run.`,
    )
  }

  return {
    ok: true,
    observation: {
      schema: o.schema,
      phase: 'PRE_WRITE',
      attemptId: o.attemptId,
      observationId: o.observationId,
      corroboration: body.corroboration,
      digest: o.digest,
    },
  }
}

export interface FreshObservationEvaluation {
  readonly ok: true
  readonly observation: FreshChainObservation
  readonly projectRef: string
  readonly packageStates: Readonly<Record<string, PackageState>>
  /** Derived HERE from the witnesses. Never read from the document. */
  readonly stellaPackagesInstalled: Readonly<Record<string, boolean>>
  readonly log: readonly string[]
}

export interface FreshObservationInputs {
  readonly raw: string | null
  /** The attempt this tool opened, in memory, before the probe ran. */
  readonly expectedAttemptId: string
  /** The append-only ledger's bytes, or null when nothing has been opened. */
  readonly attemptLedger: string | null
  readonly production?: ProductionIdentifiers
  readonly expectedProjectRef?: string
  readonly registry?: Readonly<Record<string, PackageWitnesses>>
  readonly packageIds?: readonly string[]
}

/**
 * Parse, bind to the attempt, verify the target, and CLASSIFY the packages.
 *
 * The classification is computed here from the raw witnesses rather than read
 * from the document, so a hand-written `"state": "ABSENT"` has nowhere to enter.
 * The document supplies measurements; this supplies meaning.
 */
export function evaluateFreshChainObservation(
  inputs: FreshObservationInputs,
): FreshObservationEvaluation | FreshObservationRefusal {
  const production = inputs.production ?? KNOWN_PRODUCTION_IDENTIFIERS
  const expectedProjectRef = inputs.expectedProjectRef ?? KNOWN_STAGING_PROJECT_REF
  const registry = inputs.registry ?? PACKAGE_WITNESSES
  const packageIds = inputs.packageIds ?? WITNESSED_PACKAGES

  if (!ATTEMPT_ID_SHAPE.test(inputs.expectedAttemptId)) {
    return refuse(
      'CHAIN_OBSERVATION_ATTEMPT_MALFORMED',
      `the caller supplied attempt id ${JSON.stringify(inputs.expectedAttemptId)}, which is not ` +
        `att_ followed by 32 hex characters.`,
    )
  }

  const status = attemptStatus(parseAttemptLedger(inputs.attemptLedger), inputs.expectedAttemptId)
  if (status !== 'OPEN') {
    return refuse(
      'CHAIN_OBSERVATION_ATTEMPT_NOT_OPEN',
      status === 'UNKNOWN'
        ? `attempt ${inputs.expectedAttemptId} was never opened in ${CHAIN_ATTEMPT_LEDGER}. An attempt ` +
            `is opened before the probe runs; one that appears only now was not the attempt anything measured.`
        : `attempt ${inputs.expectedAttemptId} is spent — it was either consumed by a plan already or ` +
            `superseded by a later attempt. One observation authorises one write.`,
    )
  }

  const parsed = parseFreshChainObservation(
    inputs.raw,
    expectedProjectRef,
    production,
    registry,
    packageIds,
  )
  if (!parsed.ok) return parsed

  if (parsed.observation.attemptId !== inputs.expectedAttemptId) {
    return refuse(
      'CHAIN_OBSERVATION_ATTEMPT_MISMATCH',
      `this observation was measured for attempt ${parsed.observation.attemptId} and the open attempt ` +
        `is ${inputs.expectedAttemptId}. An observation belongs to the attempt that minted its probe.`,
    )
  }

  const c = parsed.observation.corroboration
  const identity = verifyStagingTarget(
    {
      declaredEnvironment: c.declaredEnvironment,
      declaredProjectRef: c.declaredProjectRef,
      connectionHost: c.connection.connectionHost,
      poolerUser: c.connection.poolerUser,
      sentinel: {
        environment: c.observation.sentinelObservation.environment ?? '',
        projectRef: c.observation.sentinelObservation.projectRef ?? '',
      },
    },
    production,
    'required',
    expectedProjectRef,
  )
  if (!identity.ok) {
    return refuse(
      identity.code === 'HOSTED_TARGET_SENTINEL_MISSING' ||
        identity.code === 'HOSTED_TARGET_SENTINEL_MISMATCH'
        ? 'CHAIN_OBSERVATION_SENTINEL_INVALID'
        : 'CHAIN_OBSERVATION_TARGET_MISMATCH',
      `${identity.code}: ${identity.message}`,
    )
  }

  const observed: Record<string, boolean> = {}
  for (const p of c.observation.packageObservations) {
    for (const [k, v] of Object.entries(p.witnesses)) observed[k] = v
  }
  const classified = classifyAllPackages(observed, registry, packageIds)
  if (!classified.ok) {
    return refuse(
      'CHAIN_OBSERVATION_MALFORMED',
      `${classified.code}: ${classified.detail}`,
    )
  }

  const partial = classified.classifications.filter((x) => x.state === 'PARTIAL_OR_INCONSISTENT')
  if (partial.length > 0) {
    return refuse(
      'CHAIN_OBSERVATION_PARTIAL_STATE',
      `${partial.map((p) => p.packageId).join(', ')} measured PARTIAL_OR_INCONSISTENT. A half-installed ` +
        `package is not absent and is not installed; applying over it and retrying it are both wrong, ` +
        `so neither is authorised. This needs a human reading the witness list, not another attempt.`,
    )
  }

  const packageStates = Object.fromEntries(
    classified.classifications.map((x) => [x.packageId, x.state]),
  ) as Readonly<Record<string, PackageState>>

  return {
    ok: true,
    observation: parsed.observation,
    projectRef: identity.projectRef,
    packageStates,
    stellaPackagesInstalled: Object.fromEntries(
      classified.classifications.map((x) => [x.packageId, x.state === 'INSTALLED']),
    ),
    log: [
      `pre-write observation ${parsed.observation.observationId} bound to attempt ${parsed.observation.attemptId}`,
      `digest verified over ${Object.keys(observed).length} witness measurement(s)`,
      `package states derived here: ${classified.classifications.filter((x) => x.state === 'INSTALLED').length} INSTALLED, ` +
        `${classified.classifications.filter((x) => x.state === 'ABSENT').length} ABSENT`,
    ],
  }
}

/* -------------------------------------------------------------------------- */
/* Exactly one write                                                          */
/* -------------------------------------------------------------------------- */

/** The chain minus the bootstrap: the packages this gate authorises. */
export const CHAIN_WRITE_ORDER: readonly string[] = HOSTED_CHAIN.filter(
  (n) => n !== 'stella_hosted_0001_managed_role_bootstrap',
)

export type NextPackageResult =
  | { readonly ok: true; readonly packageId: string }
  | FreshObservationRefusal

/**
 * The ONE package an observation authorises: the first ABSENT in chain order,
 * and only if everything before it is INSTALLED.
 *
 * A plan of nine writes from one measurement is the shape RT-02 exploited — by
 * the time step two runs, the measurement that authorised it describes a
 * database that no longer exists. Nine writes need nine measurements.
 */
export function nextChainPackage(
  packageStates: Readonly<Record<string, PackageState>>,
  order: readonly string[] = CHAIN_WRITE_ORDER,
): NextPackageResult {
  const firstAbsent = order.findIndex((p) => packageStates[p] === 'ABSENT')
  if (firstAbsent === -1) {
    return refuse(
      'CHAIN_SEQUENCE_COMPLETE',
      `every chain package measured INSTALLED. There is nothing to apply, and nothing to re-apply: ` +
        `an installed package is never written again.`,
    )
  }
  const laterInstalled = order.slice(firstAbsent + 1).filter((p) => packageStates[p] === 'INSTALLED')
  if (laterInstalled.length > 0) {
    return refuse(
      'CHAIN_PREDECESSOR_STATE_INVALID',
      `${order[firstAbsent]} is ABSENT while ${laterInstalled.join(', ')} further down the chain ` +
        `measured INSTALLED. The chain is not a set; a gap means something applied out of order or ` +
        `something was removed, and neither is a state to continue from.`,
    )
  }
  return { ok: true, packageId: order[firstAbsent] as string }
}

export interface ChainWriteAuthorization {
  readonly ok: true
  readonly attemptId: string
  readonly projectRef: string
  /** EXACTLY ONE. Never a list. */
  readonly packageId: string
  readonly packageStates: Readonly<Record<string, PackageState>>
  readonly stellaPackagesInstalled: Readonly<Record<string, boolean>>
  readonly log: readonly string[]
}

export interface ChainWriteRequest extends FreshObservationInputs {
  /**
   * What the operator asked to apply. Optional: when absent the gate reports the
   * package the observation authorises. When present it must MATCH — a request
   * naming a package the measurement does not authorise is refused rather than
   * silently redirected to the right one.
   */
  readonly requestedPackage?: string
  readonly order?: readonly string[]
}

/** The single entry point a write path may call. */
export function authorizeChainWrite(
  request: ChainWriteRequest,
): ChainWriteAuthorization | FreshObservationRefusal {
  const evaluated = evaluateFreshChainObservation(request)
  if (!evaluated.ok) return evaluated

  const order = request.order ?? CHAIN_WRITE_ORDER
  const next = nextChainPackage(evaluated.packageStates, order)
  if (!next.ok) return next

  if (request.requestedPackage !== undefined) {
    if (evaluated.packageStates[request.requestedPackage] === 'INSTALLED') {
      return refuse(
        'CHAIN_TARGET_ALREADY_INSTALLED',
        `${request.requestedPackage} measured INSTALLED in this observation. A committed package is ` +
          `never re-applied — if the acknowledgement or the evidence was lost, the recovery is to ` +
          `reconstruct the POST evidence from this measurement and continue, not to run it again.`,
      )
    }
    if (request.requestedPackage !== next.packageId) {
      return refuse(
        'CHAIN_NEXT_PACKAGE_MISMATCH',
        `${request.requestedPackage} was requested and this observation authorises ${next.packageId}. ` +
          `The chain applies in order, one package per measurement.`,
      )
    }
  }

  return {
    ok: true,
    attemptId: evaluated.observation.attemptId,
    projectRef: evaluated.projectRef,
    packageId: next.packageId,
    packageStates: evaluated.packageStates,
    stellaPackagesInstalled: evaluated.stellaPackagesInstalled,
    log: [...evaluated.log, `authorised EXACTLY ONE write: ${next.packageId}`],
  }
}

/** Re-exported so a caller can name the probe it must run. */
export { A1_OBSERVATION_SQL }

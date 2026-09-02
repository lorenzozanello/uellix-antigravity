// db/hosted/checkpoint-a1.ts
//
// CHECKPOINT A1 — THE READ-ONLY CORROBORATION THAT AUTHORISES THE CHAIN.
//
// S1 applied the bootstrap, S2 was the human INSERT, S3 proved the row is there.
// A1 is the different question: given that row, given this connection, and given
// what is ACTUALLY installed, may PHASE_STELLA_CHAIN be planned at all?
//
// It is the first gate that has to hold three unrelated things at once, and the
// value of it comes entirely from their being unrelated:
//
//   SIGNAL 1  the CONNECTION       — host and pooler login role, from the operator
//   SIGNAL 2  the DECLARATION      — the project ref the invocation names
//   SIGNAL 3  the DATABASE         — the project ref inside the sentinel ROW
//
// A mispasted connection string satisfies one. A stale runbook satisfies two. All
// three agreeing is the property, and it is a property only while the three come
// from three places. So there is no line anywhere below that reads signal 3 out
// of signal 2, and the negative control for that is executable: an artefact whose
// sentinel names a different project than the declaration REFUSES, and any
// implementation that quietly copied one into the other would make that test pass
// a corroboration it should have refused.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE DOES NOT DECIDE
// ---------------------------------------------------------------------------
// It does not re-implement authorisation. `PACKAGE_WITNESSES` establishes FACTS —
// which packages are installed — and `verifyStagingTarget` plus
// `planProvisioningPhase` decide what may be done with them. This module is the
// wire between the two, and the whole reason it exists is that the wire was
// missing: the witness registry landed at cec6057 with no way to obtain an
// observation, which is the sixth time in this programme a contract has shipped
// without a consumer.
//
// ---------------------------------------------------------------------------
// WHAT IT REFUSES TO CARRY
// ---------------------------------------------------------------------------
// The artefact is COMMITTED. A project ref is public in every URL the project
// serves and a pooler login role is a username; neither is a secret. A password,
// a DSN, a JWT, a Supabase key or a certificate is, and none of them is needed to
// answer any question here — so anything shaped like one is a refusal rather than
// a review comment on a commit that already happened.

import {
  SENTINEL_BOOTSTRAP_VERSION,
} from './bootstrap-postconditions'
import { HOSTED_CHAIN } from './hosted-package-manifest'
import {
  PACKAGE_WITNESSES,
  WITNESSED_PACKAGES,
  allWitnesses,
  classifyAllPackages,
  toStellaPackagesInstalled,
  witnessKey,
  type PackageClassification,
  type PackageState,
  type PackageWitnesses,
} from './package-witnesses'
import { planWitnessSql } from './witness-sql'
import {
  STELLA_FEATURE_FLAGS,
  planProvisioningPhase,
  type ProvisioningPlan,
} from './hosted-provisioning-runner'
import { isStorageUnitInstalled, type StorageUnitState } from './storage-policy-artifact'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  projectRefFromPoolerUser,
  redactForHostedLog,
  verifyStagingTarget,
  type ProductionIdentifiers,
} from './target-identity'

/** Where the operator records the assembled corroboration. Versioned, committed. */
export const A1_CORROBORATION_ARTEFACT = 'artifacts/hosted-a1-corroboration.json'
/** Where the derived verdict is written, so a report can only quote it. */
export const A1_STATUS_ARTEFACT = 'artifacts/hosted-a1-status.json'
/** The read-only SQL that produces the observation. Generated, byte-verified. */
export const A1_OBSERVATION_SQL = 'db/prepared/checkpoint-a1/corroboration.sql'

/** Statuses that mean a baseline unit is on the target. Others are not "installed". */
export const JOURNAL_INSTALLED_STATUSES: readonly string[] = ['APPLIED', 'MANUAL_BOUNDARY_VERIFIED']

/* -------------------------------------------------------------------------- */
/* GAP A — the sentinel, read from the row rather than assumed from the target */
/* -------------------------------------------------------------------------- */

/**
 * The sentinel as the probe reports it.
 *
 * `projectRef` here is SIGNAL 3 and nothing else in this file may supply it. The
 * S1 probe deliberately reported only the row COUNT — "selecting the row would
 * put a project ref in two artefacts and invite them to disagree" — and that was
 * right for S1, where the expectation is that the row is ABSENT. A1 asks the
 * opposite question: the row exists, and what it SAYS is the third signal. A
 * count cannot corroborate an identity.
 */
export interface SentinelObservation {
  readonly tablePresent: boolean
  readonly rowCount: number
  /** The singleton primary key. `true` is the only legal value; the CHECK admits no other. */
  readonly id: boolean | null
  readonly environment: string | null
  readonly projectRef: string | null
  readonly bootstrapVersion: string | null
  readonly provisionedAt: string | null
  readonly ownerSeparation: string | null
  /**
   * Whether `owner_separation` records RR-02, computed BY THE DATABASE.
   *
   * Emitted alongside the text it is derived from precisely so the two can be
   * compared: a hand-edited artefact that flips this to `true` while leaving the
   * text without RR-02 contradicts itself, and the parser refuses the
   * contradiction rather than believing the boolean.
   */
  readonly rr02Present: boolean | null
}

export interface JournalUnitObservation {
  readonly packageId: string
  readonly status: string
}

export interface BaselineJournalObservation {
  readonly tablePresent: boolean
  readonly units: readonly JournalUnitObservation[]
  readonly projectRefs: readonly string[]
  readonly environments: readonly string[]
}

export interface PackageObservation {
  readonly packageId: string
  /** `kind:identifier` -> present. Every key the registry declares, and no other. */
  readonly witnesses: Readonly<Record<string, boolean>>
}

/** Exactly what `db/prepared/checkpoint-a1/corroboration.sql` prints. */
export interface A1Observation {
  /** The `-v` echo. SIGNAL 2 restated by the probe, never SIGNAL 3. */
  readonly targetProjectRef: string
  readonly sentinelObservation: SentinelObservation
  readonly bootstrapSchemaPresent: boolean
  readonly baselineJournal: BaselineJournalObservation
  readonly packageObservations: readonly PackageObservation[]
}

/** The operator's half. Metadata only — see the header on what may never appear. */
export interface A1Connection {
  readonly connectionHost: string
  readonly poolerUser: string
  readonly connectionPort?: number | null
}

/** The committed artefact: operator envelope plus the probe's output, verbatim. */
export interface A1Corroboration {
  readonly declaredEnvironment: string
  readonly declaredProjectRef: string
  readonly connection: A1Connection
  readonly featureFlags: Readonly<Record<string, string | boolean>>
  readonly observation: A1Observation
}

/* -------------------------------------------------------------------------- */
/* Parsing, fail-closed at every step                                          */
/* -------------------------------------------------------------------------- */

export type A1RefusalCode =
  | 'A1_CORROBORATION_ABSENT'
  | 'A1_CORROBORATION_MALFORMED'
  | 'A1_CORROBORATION_CARRIES_SECRET'
  | 'A1_CORROBORATION_INCOMPLETE'
  | 'A1_CONNECTION_HOST_MISSING'
  | 'A1_CONNECTION_HOST_MALFORMED'
  | 'A1_POOLER_USER_MISSING'
  | 'A1_POOLER_USER_MALFORMED'
  | 'A1_CONNECTION_PORT_MALFORMED'
  | 'A1_DECLARED_REF_MALFORMED'
  | 'A1_PRODUCTION_REF'
  | 'A1_OBSERVATION_MISSING'
  | 'A1_OBSERVATION_REF_MISMATCH'
  | 'A1_SENTINEL_TABLE_ABSENT'
  | 'A1_SENTINEL_ROW_COUNT'
  | 'A1_SENTINEL_MALFORMED'
  | 'A1_SENTINEL_SELF_CONTRADICTORY'
  | 'A1_BOOTSTRAP_SCHEMA_ABSENT'
  | 'A1_JOURNAL_MALFORMED'
  | 'A1_JOURNAL_FOREIGN_PROJECT'
  | 'A1_PACKAGE_COUNT'
  | 'A1_PACKAGE_UNKNOWN'
  | 'A1_PACKAGE_DUPLICATED'
  | 'A1_WITNESS_SET_MISMATCH'
  | 'A1_WITNESS_TYPE'
  | 'A1_WITNESS_CONTRADICTION'
  | 'A1_FLAGS_INCOMPLETE'
  | 'A1_FLAGS_MALFORMED'
  | 'A1_STORAGE_UNIT_UNMEASURED'

export interface A1Refusal {
  readonly ok: false
  readonly code: A1RefusalCode
  readonly detail: string
}

export type A1ParseResult = { readonly ok: true; readonly corroboration: A1Corroboration } | A1Refusal

const refuse = (code: A1RefusalCode, detail: string): A1Refusal => ({
  ok: false,
  code,
  detail: redactForHostedLog(detail),
})

const PROJECT_REF_SHAPE = /^[a-z]{20}$/

/**
 * Value shapes that must never reach a committed artefact.
 *
 * Same set the S1 parser refuses, for the same reason: a JWT, a URL carrying
 * userinfo, a Supabase key, or a long base64 blob. A project ref is public and
 * survives on purpose.
 */
const SECRET_SHAPED =
  /(^eyJ[A-Za-z0-9_-]{10,})|(:\/\/[^\s/]*:[^\s@]*@)|(^sb[a-z]*_[A-Za-z0-9]{16,})|([A-Za-z0-9+/]{40,}={0,2}$)/

/**
 * Field NAMES that are refused wherever they appear, at any depth.
 *
 * The shape test above catches a value that looks like a credential. This
 * catches the case it cannot: an operator who pastes the right kind of thing
 * under the right name — `"password": "hunter2"` is not secret-SHAPED and is
 * still a password in a committed file. Refusing by name means the artefact
 * cannot even have a slot for one.
 */
const FORBIDDEN_KEYS = [
  'password',
  'pgpassword',
  'dsn',
  'databaseurl',
  'database_url',
  'connectionstring',
  'connection_string',
  'connstring',
  'apikey',
  'api_key',
  'jwt',
  'token',
  'accesstoken',
  'access_token',
  'servicerolekey',
  'service_role_key',
  'anonkey',
  'anon_key',
  'certificate',
  'cert',
  'privatekey',
  'private_key',
  'secret',
]

function scanForSecrets(value: unknown, path = '$'): string | null {
  if (typeof value === 'string') {
    return SECRET_SHAPED.test(value) ? `${path} holds a value shaped like a credential` : null
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = scanForSecrets(value[i], `${path}[${i}]`)
      if (found !== null) return found
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.includes(key.toLowerCase().replace(/[^a-z_]/g, ''))) {
        return `${path}.${key} is a field this artefact may never have. Corroboration needs a HOST and a USERNAME; it never needs a credential, so there is no slot for one.`
      }
      const found = scanForSecrets(item, `${path}.${key}`)
      if (found !== null) return found
    }
  }
  return null
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isStr = (v: unknown): v is string => typeof v === 'string'

/**
 * Reads the assembled artefact, or refuses.
 *
 * NOTHING IS DEFAULTED. A missing field is not an empty one, an unmeasured
 * witness is not a false one, and an absent sentinel row is not a sentinel that
 * says nothing — each is its own refusal with its own code, because the whole
 * cost of this checkpoint is paid by an operator reading the refusal and knowing
 * which of twenty things to go and fix.
 */
export function parseA1Corroboration(
  raw: string | null,
  targetProjectRef: string = KNOWN_STAGING_PROJECT_REF,
  production: ProductionIdentifiers = KNOWN_PRODUCTION_IDENTIFIERS,
  registry: Readonly<Record<string, PackageWitnesses>> = PACKAGE_WITNESSES,
  packageIds: readonly string[] = WITNESSED_PACKAGES,
): A1ParseResult {
  if (raw === null || raw.trim() === '') {
    return refuse(
      'A1_CORROBORATION_ABSENT',
      `${A1_CORROBORATION_ARTEFACT} is absent. CHECKPOINT A1 has not been measured, which is not the same as it having failed — and not the same as it having passed. Run ${A1_OBSERVATION_SQL} read-only against the target and assemble the artefact around its output.`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return refuse('A1_CORROBORATION_MALFORMED', `${A1_CORROBORATION_ARTEFACT} is not valid JSON.`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('A1_CORROBORATION_MALFORMED', `${A1_CORROBORATION_ARTEFACT} is not a JSON object.`)
  }
  const a = parsed as Record<string, unknown>

  // SECRETS FIRST, over the WHOLE document, before any field is trusted enough
  // to be echoed in another refusal's message.
  const secret = scanForSecrets(a)
  if (secret !== null) return refuse('A1_CORROBORATION_CARRIES_SECRET', secret)

  const missing = (['declaredEnvironment', 'declaredProjectRef', 'connection', 'featureFlags', 'observation'] as const).filter(
    (f) => !(f in a),
  )
  if (missing.length > 0) {
    return refuse(
      'A1_CORROBORATION_INCOMPLETE',
      `missing field(s): ${missing.join(', ')}. A partial corroboration cannot produce a verdict.`,
    )
  }

  if (!isStr(a.declaredEnvironment)) {
    return refuse('A1_CORROBORATION_MALFORMED', 'declaredEnvironment must be a string.')
  }
  if (!isStr(a.declaredProjectRef) || !PROJECT_REF_SHAPE.test(a.declaredProjectRef)) {
    return refuse(
      'A1_DECLARED_REF_MALFORMED',
      'declaredProjectRef is not a Supabase project ref (20 lowercase letters).',
    )
  }

  /* -- SIGNAL 1: the connection. Operator metadata, validated as metadata. --- */
  const conn = a.connection
  if (conn === null || typeof conn !== 'object' || Array.isArray(conn)) {
    return refuse('A1_CORROBORATION_MALFORMED', 'connection must be an object.')
  }
  const c = conn as Record<string, unknown>

  const host = isStr(c.connectionHost) ? c.connectionHost.trim() : ''
  if (host === '') {
    return refuse(
      'A1_CONNECTION_HOST_MISSING',
      'connection.connectionHost is absent. SIGNAL 1 is what the OPERATOR connected to, and nothing server-side can report it — a query cannot tell you which endpoint routed it. Unsupplied is unknown, and unknown is not agreement.',
    )
  }
  // Refused rather than parsed around, exactly as `projectRefFromPoolerUser`
  // does: a pasted DSN is rejected instead of mined for a host.
  if (/[:@/\\\s]/.test(host)) {
    return refuse(
      'A1_CONNECTION_HOST_MALFORMED',
      'connection.connectionHost holds a character no hostname contains. Supply the HOST component only — never a port, a scheme, userinfo or a whole connection string.',
    )
  }

  const poolerUser = isStr(c.poolerUser) ? c.poolerUser.trim() : ''
  if (poolerUser === '') {
    return refuse(
      'A1_POOLER_USER_MISSING',
      'connection.poolerUser is absent. The Session Pooler host is regional and shared — every project in the region presents it — so it names no project; the ref lives in the LOGIN ROLE. Without it SIGNAL 1 corroborates nothing. It is a USERNAME: postgres.<ref>.',
    )
  }
  if (projectRefFromPoolerUser(poolerUser) === null) {
    return refuse(
      'A1_POOLER_USER_MALFORMED',
      'connection.poolerUser does not have the exact shape postgres.<ref> with twenty lowercase letters.',
    )
  }

  let port: number | null = null
  if (c.connectionPort !== undefined && c.connectionPort !== null) {
    if (typeof c.connectionPort !== 'number' || !Number.isInteger(c.connectionPort)) {
      return refuse('A1_CONNECTION_PORT_MALFORMED', 'connection.connectionPort must be an integer or absent.')
    }
    port = c.connectionPort
  }

  /* -- The production veto, BEFORE the target is accepted anywhere. ---------- */
  //
  // `verifyStagingTarget` vetoes production too, and this is deliberately not a
  // reason to skip it here: the artefact is read, echoed and reasoned about
  // before the verifier is ever called, and a production ref must not survive
  // long enough to appear in a message about "the wrong project". It is the
  // wrong DATABASE, and that is a different sentence.
  const sentinelRefEarly = ((a.observation as Record<string, unknown> | undefined)?.sentinelObservation as
    | Record<string, unknown>
    | undefined)?.projectRef
  const named = [
    a.declaredProjectRef,
    projectRefFromPoolerUser(poolerUser),
    isStr(sentinelRefEarly) ? sentinelRefEarly : null,
  ].filter((r): r is string => typeof r === 'string' && r !== '')
  const vetoed = [...new Set(named.filter((r) => production.projectRefs.includes(r)))]
  if (vetoed.length > 0) {
    return refuse(
      'A1_PRODUCTION_REF',
      `refused: ${vetoed.join(', ')} is a KNOWN PRODUCTION project ref. CHECKPOINT A1 authorises the Stella chain; it never runs against production, and no other agreeing field outvotes this.`,
    )
  }

  /* -- SIGNAL 2 vs the pin. ------------------------------------------------- */
  if (production.projectRefs.includes(targetProjectRef)) {
    return refuse(
      'A1_PRODUCTION_REF',
      `refused: the verdict was asked about ${targetProjectRef}, a KNOWN PRODUCTION project ref.`,
    )
  }

  /* -- FLAGS. All nine, explicitly. ----------------------------------------- */
  const flagsRaw = a.featureFlags
  if (flagsRaw === null || typeof flagsRaw !== 'object' || Array.isArray(flagsRaw)) {
    return refuse('A1_FLAGS_MALFORMED', 'featureFlags must be an object mapping each flag name to its value.')
  }
  const flags = flagsRaw as Record<string, unknown>
  const absentFlags = STELLA_FEATURE_FLAGS.filter((f) => !(f in flags))
  if (absentFlags.length > 0) {
    return refuse(
      'A1_FLAGS_INCOMPLETE',
      `${absentFlags.length} of the nine Stella flags are not recorded: ${absentFlags.join(', ')}. The runner treats an absent key as unset, and unset reads as false — which would turn "nobody looked" into "it is off". A1 requires all nine to be stated.`,
    )
  }
  const badFlags = Object.entries(flags).filter(([, v]) => !isStr(v) && !isBool(v))
  if (badFlags.length > 0) {
    return refuse('A1_FLAGS_MALFORMED', `featureFlags values must be strings or booleans: ${badFlags.map(([k]) => k).join(', ')}.`)
  }
  const strayFlags = Object.keys(flags).filter((f) => !STELLA_FEATURE_FLAGS.includes(f))
  if (strayFlags.length > 0) {
    return refuse(
      'A1_FLAGS_MALFORMED',
      `featureFlags names ${strayFlags.join(', ')}, which the nine-flag contract does not contain. A flag the runner never reads, recorded as false, is reassurance about nothing.`,
    )
  }

  /* -- The observation: everything the DATABASE said. ----------------------- */
  const obsRaw = a.observation
  if (obsRaw === null || typeof obsRaw !== 'object' || Array.isArray(obsRaw)) {
    return refuse('A1_OBSERVATION_MISSING', 'observation must be the object the read-only probe printed.')
  }
  const o = obsRaw as Record<string, unknown>

  if (!isStr(o.targetProjectRef) || o.targetProjectRef === '') {
    return refuse('A1_OBSERVATION_MISSING', 'observation.targetProjectRef is absent; the probe output is unattributed.')
  }
  if (o.targetProjectRef !== a.declaredProjectRef) {
    return refuse(
      'A1_OBSERVATION_REF_MISMATCH',
      `the probe was run declaring ${o.targetProjectRef} and the artefact declares ${a.declaredProjectRef}. One of the two was pasted from a different run.`,
    )
  }
  if (o.targetProjectRef !== targetProjectRef) {
    return refuse(
      'A1_OBSERVATION_REF_MISMATCH',
      `the corroboration describes ${o.targetProjectRef}; the verdict was asked about ${targetProjectRef}.`,
    )
  }

  /* -- GAP A: the sentinel row, field by field. ----------------------------- */
  const sRaw = o.sentinelObservation
  if (sRaw === null || typeof sRaw !== 'object' || Array.isArray(sRaw)) {
    return refuse('A1_SENTINEL_MALFORMED', 'observation.sentinelObservation is absent or is not an object.')
  }
  const s = sRaw as Record<string, unknown>

  if (s.tablePresent !== true) {
    return refuse(
      'A1_SENTINEL_TABLE_ABSENT',
      'uellix_bootstrap.staging_sentinel does not exist, so PHASE_STELLA_BOOTSTRAP did not commit. The chain has nowhere to read identity from.',
    )
  }
  if (typeof s.rowCount !== 'number' || !Number.isInteger(s.rowCount)) {
    return refuse('A1_SENTINEL_MALFORMED', 'sentinelObservation.rowCount is not an integer.')
  }
  if (s.rowCount !== 1) {
    return refuse(
      'A1_SENTINEL_ROW_COUNT',
      s.rowCount === 0
        ? 'the sentinel table is EMPTY. S2 is a human act and it has not happened — CHECKPOINT A1 cannot pass before somebody reads the project ref off the dashboard and writes it (§3).'
        : `${s.rowCount} sentinel rows. The singleton CHECK should have made this impossible, so a database that reports it is not in a state any part of this contract describes.`,
    )
  }
  if (s.id !== true) {
    return refuse(
      'A1_SENTINEL_MALFORMED',
      `sentinelObservation.id is ${JSON.stringify(s.id)}; the singleton key admits only true.`,
    )
  }
  if (s.environment !== 'staging') {
    return refuse(
      'A1_SENTINEL_MALFORMED',
      `the database declares itself ${JSON.stringify(s.environment)}. What the database says about itself outranks what the invocation says about it.`,
    )
  }
  if (!isStr(s.projectRef) || !PROJECT_REF_SHAPE.test(s.projectRef)) {
    return refuse(
      'A1_SENTINEL_MALFORMED',
      'sentinelObservation.projectRef is absent or malformed. IT IS SIGNAL 3 AND IT HAS NO FALLBACK: filling it from the declaration would collapse two independent signals into one and leave this checkpoint corroborating a claim with itself.',
    )
  }
  if (s.bootstrapVersion !== SENTINEL_BOOTSTRAP_VERSION) {
    return refuse(
      'A1_SENTINEL_MALFORMED',
      `sentinelObservation.bootstrapVersion is ${JSON.stringify(s.bootstrapVersion)}, expected ${SENTINEL_BOOTSTRAP_VERSION}.`,
    )
  }
  if (!isStr(s.provisionedAt) || s.provisionedAt === '') {
    return refuse('A1_SENTINEL_MALFORMED', 'sentinelObservation.provisionedAt is absent.')
  }
  if (!isStr(s.ownerSeparation) || s.ownerSeparation === '') {
    return refuse('A1_SENTINEL_MALFORMED', 'sentinelObservation.ownerSeparation is absent.')
  }
  if (!isBool(s.rr02Present)) {
    return refuse('A1_SENTINEL_MALFORMED', 'sentinelObservation.rr02Present is absent or is not a boolean.')
  }
  // THE BOOLEAN AND THE TEXT IT CAME FROM MUST AGREE. The probe derives one from
  // the other in the same expression; a document where they differ was edited
  // after it was measured, and which of the two is the lie is not knowable here.
  if (s.rr02Present !== s.ownerSeparation.includes('RR-02')) {
    return refuse(
      'A1_SENTINEL_SELF_CONTRADICTORY',
      `rr02Present is ${String(s.rr02Present)} while owner_separation ${s.ownerSeparation.includes('RR-02') ? 'DOES' : 'does not'} record RR-02. The probe computes one from the other, so they cannot disagree in an unedited artefact.`,
    )
  }
  if (s.rr02Present !== true) {
    return refuse(
      'A1_SENTINEL_MALFORMED',
      'the sentinel does not record RR-02 in owner_separation. The residual risk is a live property of this database and an operator reading the row must see it without finding the package.',
    )
  }

  /* -- The bootstrap schema and the baseline journal. ----------------------- */
  if (o.bootstrapSchemaPresent !== true) {
    return refuse(
      'A1_BOOTSTRAP_SCHEMA_ABSENT',
      'schema uellix_bootstrap does not exist. Every chain package calls uellix_bootstrap.assert_hosted_capabilities() in place of the superuser guard it replaced; without it they abort one by one at their first statement.',
    )
  }

  const jRaw = o.baselineJournal
  if (jRaw === null || typeof jRaw !== 'object' || Array.isArray(jRaw)) {
    return refuse('A1_JOURNAL_MALFORMED', 'observation.baselineJournal is absent or is not an object.')
  }
  const j = jRaw as Record<string, unknown>
  if (j.tablePresent !== true) {
    return refuse(
      'A1_JOURNAL_MALFORMED',
      'uellix_provisioning.applied_units does not exist, so no baseline unit can be shown to have been applied. Unrecorded is not applied.',
    )
  }
  if (!Array.isArray(j.units) || !j.units.every((u) => u !== null && typeof u === 'object' && isStr((u as Record<string, unknown>).packageId) && isStr((u as Record<string, unknown>).status))) {
    return refuse('A1_JOURNAL_MALFORMED', 'baselineJournal.units must be an array of {packageId, status}.')
  }
  if (!Array.isArray(j.projectRefs) || !j.projectRefs.every(isStr)) {
    return refuse('A1_JOURNAL_MALFORMED', 'baselineJournal.projectRefs must be an array of strings.')
  }
  if (!Array.isArray(j.environments) || !j.environments.every(isStr)) {
    return refuse('A1_JOURNAL_MALFORMED', 'baselineJournal.environments must be an array of strings.')
  }
  const foreign = (j.projectRefs as string[]).filter((r) => r !== a.declaredProjectRef)
  if (foreign.length > 0) {
    return refuse(
      'A1_JOURNAL_FOREIGN_PROJECT',
      `the baseline ledger carries rows written against ${foreign.join(', ')} while this database claims to be ${a.declaredProjectRef}. A journal is written at apply time by the session that applied it, so a foreign ref means the rows and the sentinel describe different databases.`,
    )
  }

  /* -- The nine packages, and EXACTLY the nine. ----------------------------- */
  const pRaw = o.packageObservations
  if (!Array.isArray(pRaw)) {
    return refuse('A1_PACKAGE_COUNT', 'observation.packageObservations is absent or is not an array.')
  }
  if (pRaw.length !== packageIds.length) {
    return refuse(
      'A1_PACKAGE_COUNT',
      `${pRaw.length} package observation(s); the chain has exactly ${packageIds.length}. A shorter list is not a shorter chain — it is a chain with unmeasured members, and unmeasured is not absent.`,
    )
  }

  const seen = new Set<string>()
  const packageObservations: PackageObservation[] = []
  const merged: Record<string, boolean> = {}

  for (const entry of pRaw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return refuse('A1_PACKAGE_UNKNOWN', 'every packageObservations entry must be an object.')
    }
    const e = entry as Record<string, unknown>
    if (!isStr(e.packageId)) {
      return refuse('A1_PACKAGE_UNKNOWN', 'a packageObservations entry carries no packageId.')
    }
    if (!packageIds.includes(e.packageId)) {
      return refuse(
        'A1_PACKAGE_UNKNOWN',
        `${e.packageId} is not a chain package. Declared, in order: ${packageIds.join(', ')}.`,
      )
    }
    if (seen.has(e.packageId)) {
      return refuse(
        'A1_PACKAGE_DUPLICATED',
        `${e.packageId} is observed twice. Two answers to one question is the divergence this parser exists to prevent.`,
      )
    }
    seen.add(e.packageId)

    const wRaw = e.witnesses
    if (wRaw === null || typeof wRaw !== 'object' || Array.isArray(wRaw)) {
      return refuse('A1_WITNESS_SET_MISMATCH', `${e.packageId}: witnesses must be an object.`)
    }
    const w = wRaw as Record<string, unknown>

    const declared = registry[e.packageId]
    if (declared === undefined) {
      return refuse('A1_PACKAGE_UNKNOWN', `${e.packageId} has no declared witnesses.`)
    }
    const expectedKeys = [
      ...declared.requiredPresentWhenInstalled,
      ...declared.requiredAbsentWhenInstalled,
    ].map(witnessKey)

    const absent = expectedKeys.filter((k) => !(k in w))
    const extra = Object.keys(w).filter((k) => !expectedKeys.includes(k))
    if (absent.length > 0 || extra.length > 0) {
      return refuse(
        'A1_WITNESS_SET_MISMATCH',
        `${e.packageId}: the observation measures a different set of witnesses than the registry declares. not measured: ${absent.join(', ') || 'none'}; measured but undeclared: ${extra.join(', ') || 'none'}. A witness nobody looked for is unknown, and one nobody declared cannot classify anything.`,
      )
    }

    const wrongType = Object.entries(w).filter(([, v]) => !isBool(v))
    if (wrongType.length > 0) {
      return refuse(
        'A1_WITNESS_TYPE',
        `${e.packageId}: ${wrongType.length} witness value(s) are not booleans (${wrongType.map(([k, v]) => `${k}=${JSON.stringify(v)}`).slice(0, 3).join(', ')}). A witness is present or it is not; a string, a null or a number is a measurement that failed to happen.`,
      )
    }

    for (const [k, v] of Object.entries(w)) {
      // A witness may be declared by more than one package. The probe measures
      // it once per package with the SAME expression, so two different answers
      // can only come from a document edited by hand.
      if (k in merged && merged[k] !== (v as boolean)) {
        return refuse(
          'A1_WITNESS_CONTRADICTION',
          `${k} is reported both present and absent by different packages. One expression cannot return two answers in one transaction.`,
        )
      }
      merged[k] = v as boolean
    }

    packageObservations.push({ packageId: e.packageId, witnesses: w as Record<string, boolean> })
  }

  return {
    ok: true,
    corroboration: {
      declaredEnvironment: a.declaredEnvironment,
      declaredProjectRef: a.declaredProjectRef,
      connection: { connectionHost: host, poolerUser, connectionPort: port },
      featureFlags: flags as Record<string, string | boolean>,
      observation: {
        targetProjectRef: o.targetProjectRef,
        sentinelObservation: s as unknown as SentinelObservation,
        bootstrapSchemaPresent: true,
        baselineJournal: j as unknown as BaselineJournalObservation,
        packageObservations,
      },
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The three signals, kept in three places                                     */
/* -------------------------------------------------------------------------- */

export interface A1Signal {
  readonly id: 'SIGNAL_1_CONNECTION' | 'SIGNAL_2_DECLARATION' | 'SIGNAL_3_DATABASE'
  /** The JSON pointer the value is read from. Pairwise distinct, by test. */
  readonly pointer: string
  readonly origin: 'operator/client' | 'explicit parameter' | 'PostgreSQL, read from the sentinel ROW'
  readonly projectRef: string
}

/**
 * The three, each extracted from its own disjoint subtree of the artefact.
 *
 * ---------------------------------------------------------------------------
 * WHY THE POINTERS ARE DATA
 * ---------------------------------------------------------------------------
 * Writing `signal3 = signal2` is a one-character edit and it would be invisible
 * in review: every assertion downstream would still pass, more easily. Recording
 * WHERE each value came from turns that edit into a violation of a stated
 * property — the three pointers must be pairwise distinct, and one of them must
 * name the sentinel — which a test can check without knowing anything about
 * project refs.
 *
 * That is not the only control and is not meant to be. The executable one is the
 * mismatch case: an artefact whose sentinel names another project REFUSES, and an
 * implementation that had copied the declaration into signal 3 would return a
 * pass there. Belt and braces, because this is the property the whole checkpoint
 * is for.
 */
export function collectSignals(c: A1Corroboration): readonly A1Signal[] {
  return [
    {
      id: 'SIGNAL_1_CONNECTION',
      pointer: '/connection/poolerUser',
      origin: 'operator/client',
      // Never null: the parser refuses a login role that does not parse.
      projectRef: projectRefFromPoolerUser(c.connection.poolerUser) ?? '',
    },
    {
      id: 'SIGNAL_2_DECLARATION',
      pointer: '/declaredProjectRef',
      origin: 'explicit parameter',
      projectRef: c.declaredProjectRef,
    },
    {
      id: 'SIGNAL_3_DATABASE',
      pointer: '/observation/sentinelObservation/projectRef',
      origin: 'PostgreSQL, read from the sentinel ROW',
      projectRef: c.observation.sentinelObservation.projectRef ?? '',
    },
  ]
}

/* -------------------------------------------------------------------------- */
/* The verdict                                                                 */
/* -------------------------------------------------------------------------- */

export interface A1ChainPlanSummary {
  readonly ok: boolean
  readonly code: string | null
  readonly message: string | null
  readonly stepCount: number
  readonly steps: readonly string[]
  readonly writesPermitted: boolean
  readonly sequenceComplete: boolean
  readonly nextAction: string | null
}

export interface A1Verdict {
  readonly corroborationPresent: boolean
  readonly refusal: A1Refusal | null
  readonly signals: readonly A1Signal[]
  readonly targetVerification: {
    readonly ok: boolean
    readonly code: string | null
    readonly message: string | null
    readonly projectRef: string | null
    readonly signals: readonly string[]
    readonly sentinelDeferred: boolean | null
  } | null
  readonly sentinel: SentinelObservation | null
  readonly packageCount: number
  readonly packageStates: Readonly<Record<string, PackageState>>
  readonly partialPackages: readonly string[]
  readonly flags: { readonly evaluated: number; readonly enabled: readonly string[] } | null
  readonly chainPlan: A1ChainPlanSummary | null
  readonly blockers: readonly string[]
  readonly warnings: readonly string[]
  readonly checkpointPassed: boolean
}

export interface A1EvaluationInputs {
  /** The artefact's bytes, or null when it has not been written yet. */
  readonly raw: string | null
  /** Reads a baseline unit's SQL by repo-relative path — the runner's own reader. */
  readonly readBaselineSql: (file: string) => string | null
  /** Canonical Stella package SQL by package name. */
  readonly stellaSources: Readonly<Record<string, string>>
  /**
   * Unit 41's state, from `artifacts/hosted-storage-boundary-status.json`.
   *
   * NOT re-derived here and NOT recorded in the A1 artefact. Its terminal state
   * needs B0-16's verdict over the policy SURFACE, which is not a question
   * `pg_policies` answers and not one an operator may assert. `null` means
   * unmeasured, and unmeasured is refused like every other probe in this
   * programme.
   */
  readonly storageUnitState: StorageUnitState | null
  readonly production?: ProductionIdentifiers
  readonly expectedProjectRef?: string
  readonly registry?: Readonly<Record<string, PackageWitnesses>>
  readonly packageIds?: readonly string[]
}

const EMPTY_VERDICT = {
  signals: [] as readonly A1Signal[],
  targetVerification: null,
  sentinel: null,
  packageCount: 0,
  packageStates: {} as Readonly<Record<string, PackageState>>,
  partialPackages: [] as readonly string[],
  flags: null,
  chainPlan: null,
  warnings: [] as readonly string[],
  checkpointPassed: false,
}

/**
 * CHECKPOINT A1, end to end.
 *
 * The ORDER is the contract. Parse before anything is trusted; production before
 * the target is accepted; identity before packages, because a correct package
 * inventory of the wrong database is worse than none; packages before the plan,
 * because the plan's whole input is the inventory; and the plan LAST, computed by
 * the real runner rather than restated here.
 */
export function evaluateCheckpointA1(inputs: A1EvaluationInputs): A1Verdict {
  const production = inputs.production ?? KNOWN_PRODUCTION_IDENTIFIERS
  const expectedProjectRef = inputs.expectedProjectRef ?? KNOWN_STAGING_PROJECT_REF
  const registry = inputs.registry ?? PACKAGE_WITNESSES
  const packageIds = inputs.packageIds ?? WITNESSED_PACKAGES

  const parsed = parseA1Corroboration(inputs.raw, expectedProjectRef, production, registry, packageIds)
  if (!parsed.ok) {
    return {
      ...EMPTY_VERDICT,
      corroborationPresent: inputs.raw !== null && inputs.raw.trim() !== '',
      refusal: parsed,
      blockers: [`${parsed.code}: ${parsed.detail}`],
    }
  }
  const c = parsed.corroboration
  const signals = collectSignals(c)

  /* (1) IDENTITY — the real verifier, with the sentinel REQUIRED. */
  const identity = verifyStagingTarget(
    {
      declaredEnvironment: c.declaredEnvironment,
      declaredProjectRef: c.declaredProjectRef,
      connectionHost: c.connection.connectionHost,
      poolerUser: c.connection.poolerUser,
      connectionPort: c.connection.connectionPort,
      // SIGNAL 3, and it comes from here and nowhere else.
      sentinel: {
        environment: c.observation.sentinelObservation.environment ?? '',
        projectRef: c.observation.sentinelObservation.projectRef ?? '',
      },
    },
    production,
    'required',
    expectedProjectRef,
  )

  const targetVerification = identity.ok
    ? {
        ok: true,
        code: null,
        message: null,
        projectRef: identity.projectRef,
        signals: identity.signals,
        sentinelDeferred: identity.sentinelDeferred,
      }
    : { ok: false, code: identity.code, message: identity.message, projectRef: null, signals: [], sentinelDeferred: null }

  if (!identity.ok) {
    return {
      ...EMPTY_VERDICT,
      corroborationPresent: true,
      refusal: null,
      signals,
      targetVerification,
      sentinel: c.observation.sentinelObservation,
      blockers: [`${identity.code}: ${identity.message}`],
    }
  }

  /* (2) PACKAGES — facts, from the witnesses, with no partial -> false path. */
  const observed = Object.fromEntries(
    c.observation.packageObservations.flatMap((p) => Object.entries(p.witnesses)),
  )
  const classified = classifyAllPackages(observed, registry, packageIds)
  if (!classified.ok) {
    return {
      ...EMPTY_VERDICT,
      corroborationPresent: true,
      refusal: null,
      signals,
      targetVerification,
      sentinel: c.observation.sentinelObservation,
      blockers: [`${classified.code}: ${classified.detail}`],
    }
  }
  const classifications: readonly PackageClassification[] = classified.classifications
  const packageStates = Object.fromEntries(classifications.map((x) => [x.packageId, x.state]))
  const partialPackages = classifications.filter((x) => x.state === 'PARTIAL_OR_INCONSISTENT').map((x) => x.packageId)

  const installedMap = toStellaPackagesInstalled(classifications)
  if (!installedMap.ok) {
    return {
      ...EMPTY_VERDICT,
      corroborationPresent: true,
      refusal: null,
      signals,
      targetVerification,
      sentinel: c.observation.sentinelObservation,
      packageCount: classifications.length,
      packageStates,
      partialPackages,
      blockers: [
        `${installedMap.code}: a half-installed package is not an absent one, and a plan built on that reading would re-apply a package over its own partial state. ${installedMap.detail}`,
      ],
    }
  }

  /* (3) UNIT 41 — unmeasured is refused, exactly like every other probe. */
  if (inputs.storageUnitState === null) {
    return {
      ...EMPTY_VERDICT,
      corroborationPresent: true,
      refusal: null,
      signals,
      targetVerification,
      sentinel: c.observation.sentinelObservation,
      packageCount: classifications.length,
      packageStates,
      partialPackages,
      blockers: [
        'A1_STORAGE_UNIT_UNMEASURED: unit 41 has two halves applied through two channels, and its state comes from artifacts/hosted-storage-boundary-status.json. Absent means unknown, and the runner treats unknown as not installed rather than as done.',
      ],
    }
  }

  /* (4) THE PLAN — computed by the real runner. Nothing here restates its rules. */
  const installedUnits = c.observation.baselineJournal.units
    .filter((u) => JOURNAL_INSTALLED_STATUSES.includes(u.status))
    .map((u) => u.packageId)

  const plan: ProvisioningPlan = planProvisioningPhase({
    phase: 'PHASE_STELLA_CHAIN',
    // A1 IS READ-ONLY. Dry run, so `writesPermitted` can only come back false —
    // this checkpoint says the chain MAY be planned, never that it may be run.
    mode: 'dry-run',
    target: {
      declaredEnvironment: c.declaredEnvironment,
      declaredProjectRef: c.declaredProjectRef,
      connectionHost: c.connection.connectionHost,
      poolerUser: c.connection.poolerUser,
      connectionPort: c.connection.connectionPort,
      sentinel: {
        environment: c.observation.sentinelObservation.environment ?? '',
        projectRef: c.observation.sentinelObservation.projectRef ?? '',
      },
    },
    state: {
      baselineUnitsInstalled: installedUnits,
      bootstrapSchemaPresent: c.observation.bootstrapSchemaPresent,
      sentinel: {
        environment: c.observation.sentinelObservation.environment ?? '',
        projectRef: c.observation.sentinelObservation.projectRef ?? '',
      },
      // The ONLY route from measurement to the runner's input.
      stellaPackagesInstalled: {
        ...installedMap.stellaPackagesInstalled,
        // The bootstrap is not witnessed by the registry — it is proven by the
        // schema and the sentinel this artefact already required — and the chain
        // planner filters it out of the remaining set regardless.
        stella_hosted_0001_managed_role_bootstrap: true,
      },
      businessRowCounts: null,
      storageUnitState: inputs.storageUnitState,
    },
    featureFlags: c.featureFlags,
    readBaselineSql: inputs.readBaselineSql,
    stellaSources: inputs.stellaSources,
    production,
  })

  const chainPlan: A1ChainPlanSummary = plan.ok
    ? {
        ok: true,
        code: null,
        message: null,
        stepCount: plan.steps.length,
        steps: plan.steps.map((s) => s.id),
        writesPermitted: plan.writesPermitted,
        sequenceComplete: plan.sequenceComplete,
        nextAction: plan.nextAction,
      }
    : {
        ok: false,
        code: String(plan.code),
        message: plan.message,
        stepCount: 0,
        steps: [],
        writesPermitted: false,
        sequenceComplete: false,
        nextAction: null,
      }

  const enabled = enabledFlagNames(c.featureFlags)
  const blockers: string[] = []
  if (!plan.ok) blockers.push(`${String(plan.code)}: ${plan.message}`)

  const warnings: string[] = []
  if (!isStorageUnitInstalled(inputs.storageUnitState)) {
    warnings.push(
      `unit 41 is ${inputs.storageUnitState}; the runner counts it as not installed, which is why the plan below refuses rather than skipping it`,
    )
  }
  const alreadyInstalled = classifications.filter((x) => x.state === 'INSTALLED').map((x) => x.packageId)
  if (alreadyInstalled.length > 0) {
    warnings.push(
      `${alreadyInstalled.length} chain package(s) are ALREADY INSTALLED (${alreadyInstalled.join(', ')}); the plan covers only what is missing, and a successor already present is why an unprobed one may never be assumed absent`,
    )
  }

  // THE OBSERVATION MAY BE OLDER THAN THE CHAIN, and if it is, the verdict has
  // to say so. A checkpoint computed over nine packages is not a statement
  // about a tenth authored afterwards — and `checkpointPassed: true` sitting
  // beside an uncovered package, with nothing naming it, is exactly the shape
  // of the inference this programme keeps having to unwind.
  const uncovered = a1UncoveredPackages(packageIds)
  if (uncovered.length > 0) {
    warnings.push(
      `this corroboration covers ${packageIds.length} of ${WITNESSED_PACKAGES.length} chain packages; ` +
        `${uncovered.join(', ')} did not exist when it was measured and is therefore NOT covered by ` +
        `this verdict — unmeasured, which is not the same as absent. Re-measure the target to extend ` +
        `A1_OBSERVED_CHAIN; nothing here may extend it by inference`,
    )
  }

  return {
    corroborationPresent: true,
    refusal: null,
    signals,
    targetVerification,
    sentinel: c.observation.sentinelObservation,
    packageCount: classifications.length,
    packageStates,
    partialPackages,
    flags: { evaluated: STELLA_FEATURE_FLAGS.length, enabled },
    chainPlan,
    blockers,
    warnings,
    // A1 PASSES WHEN THE CHAIN IS PLANNABLE. Not when it is applied, and not
    // when somebody says the target looks right.
    checkpointPassed: blockers.length === 0 && plan.ok,
  }
}

/* -------------------------------------------------------------------------- */
/* The status artefact — derived, serialized and verified in ONE place          */
/* -------------------------------------------------------------------------- */
//
// These three live here rather than in `scripts/a1-status.ts` for the reason
// `db/hosted/artefacts.ts` exists and the hosted-packages script is only an
// entry point: a shape defined inside a CLI is a shape only a subprocess can
// test, and a `:verify` whose comparison nothing exercises is the advisory gate
// this programme has already found more than once. The script reads files and
// writes one; every decision it makes is below.

export function computeA1Status(inputs: A1EvaluationInputs): Record<string, unknown> {
  const verdict = evaluateCheckpointA1(inputs)
  return {
    generatedBy: 'pnpm a1:status:write — do not hand-edit; this file is derived from the corroboration',
    checkpoint: 'CHECKPOINT A1',
    corroborationArtefact: A1_CORROBORATION_ARTEFACT,
    corroborationPresent: verdict.corroborationPresent,
    signals: verdict.signals,
    targetVerification: verdict.targetVerification,
    sentinelVerification: verdict.sentinel,
    packageCount: verdict.packageCount,
    packageStates: verdict.packageStates,
    partialPackages: verdict.partialPackages,
    flags: verdict.flags,
    chainPlan: verdict.chainPlan,
    blockers: verdict.blockers,
    warnings: verdict.warnings,
    // THE ONE VALUE A REPORT MAY QUOTE. It means "PHASE_STELLA_CHAIN is
    // plannable against this target", never "the chain has been applied".
    checkpointPassed: verdict.checkpointPassed,
  }
}

/**
 * The status of the COMMITTED corroboration, evaluated against the chain that
 * corroboration measured.
 *
 * Split out from `computeA1Status` so the choice of `packageIds` is made ONCE,
 * in a function both the CLI and its test call. It lived in `scripts/a1-status.ts`
 * for one revision and that was already a divergence: `:verify` compares the
 * file on disk against what the contract computes, so a CLI that narrowed the
 * chain and a test that did not were computing two different verdicts and
 * calling the difference a drift.
 *
 * The prefix assertion runs first, for the same reason it runs first in the
 * CLI: a declared observed-chain that is not a prefix would shape the verdict
 * rather than stop it.
 */
export function computeRecordedA1Status(
  inputs: Omit<A1EvaluationInputs, 'packageIds'>,
): Record<string, unknown> {
  assertA1ObservedChainIsPrefix()
  return computeA1Status({ ...inputs, packageIds: A1_OBSERVED_CHAIN })
}

export const serializeA1Status = (status: Record<string, unknown>): string =>
  `${JSON.stringify(status, null, 2)}\n`

export type A1StatusVerification =
  | { readonly ok: true; readonly present: boolean; readonly note: string }
  | { readonly ok: false; readonly present: true; readonly note: string }

/**
 * Compares a recorded status with what the contract computes today.
 *
 * AN ABSENT STATUS IS NOT A FAILURE. Until the operator has measured A1 there is
 * nothing to compare, and a gate demanding the file would block every run of the
 * suite on a step that has not happened yet. The moment the file exists it is
 * held to the recomputation exactly — including line endings, which are
 * normalised on the disk side only, because a checkout is allowed to change them
 * and a verdict is not.
 */
export function verifyA1Status(onDisk: string | null, expected: string): A1StatusVerification {
  if (onDisk === null) {
    return {
      ok: true,
      present: false,
      note: `${A1_STATUS_ARTEFACT} not present yet — nothing to verify`,
    }
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== expected) {
    return {
      ok: false,
      present: true,
      note:
        `${A1_STATUS_ARTEFACT} DIVERGED from what the contract computes today. Either the ` +
        `corroboration changed, or the status was edited. A status a document quotes and nothing ` +
        `recomputes is a number that will eventually be wrong in the direction that flatters the author.`,
    }
  }
  return {
    ok: true,
    present: true,
    note: 'the recorded verdict is what the contract computes over the recorded corroboration',
  }
}

/**
 * The flag names that are NOT recognisably false.
 *
 * Restated here only to REPORT which ones are live; the refusal itself belongs
 * to the runner and comes back as PROVISIONING_FEATURE_FLAG_ENABLED. The same
 * asymmetry applies: anything other than a recognisably-false value counts as
 * enabled, because a typo that reads as "off" is a typo nobody ever finds.
 */
function enabledFlagNames(flags: Readonly<Record<string, string | boolean>>): string[] {
  const OFF = new Set(['false', '0', 'no', 'off', ''])
  return STELLA_FEATURE_FLAGS.filter((name) => {
    const raw = flags[name]
    if (raw === undefined || raw === null) return false
    if (typeof raw === 'boolean') return raw
    return !OFF.has(raw.trim().toLowerCase())
  })
}

/* -------------------------------------------------------------------------- */
/* The read-only SQL, generated so the probe and the registry cannot drift      */
/* -------------------------------------------------------------------------- */

const sqlLit = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * The probe.
 *
 * GENERATED FROM `PACKAGE_WITNESSES`, never hand-written, for the reason the B0
 * probe is generated from the corpus: the query the operator runs and the
 * contract the verdict rests on must be one thing. `a1:observation:verify`
 * regenerates and compares bytes.
 *
 * It does NOT report `connectionHost` or `poolerUser`, and that omission is the
 * point. `current_user` behind the Session Pooler is plain `postgres` — the
 * login role never reaches the backend — so a query claiming to report the
 * connection would be reporting something else under that name, and SIGNAL 1
 * would be corroborating SIGNAL 3 with a value derived from the same place.
 */
export function buildA1CorroborationSql(
  registry: Readonly<Record<string, PackageWitnesses>> = PACKAGE_WITNESSES,
  packageIds: readonly string[] = WITNESSED_PACKAGES,
  expectedProjectRef: string = KNOWN_STAGING_PROJECT_REF,
  production: ProductionIdentifiers = KNOWN_PRODUCTION_IDENTIFIERS,
): string {
  const planned = planWitnessSql(registry, packageIds)
  if (!planned.ok) {
    throw new Error(
      `[a1] refusing to generate the probe: ${planned.code} — ${planned.detail}. A probe built around an unreadable witness would measure something nobody declared.`,
    )
  }

  const productionRefs = production.projectRefs.map((r) => sqlLit(r)).join(', ') || `'__none_declared__'`

  const packageArms = planned.packages
    .map((p) => {
      const witnessArms = p.witnesses
        .map(([key, sql]) => `      ${sqlLit(key)}, ${sql}`)
        .join(',\n')
      return `    jsonb_build_object(\n      'packageId', ${sqlLit(p.packageId)},\n      'witnesses', jsonb_build_object(\n${witnessArms}\n      ))`
    })
    .join(',\n')

  const witnessCount = planned.packages.reduce((n, p) => n + p.witnesses.length, 0)

  return `-- ============================================================================
-- GENERATED — DO NOT EDIT. CHECKPOINT A1 corroboration.
-- Regenerate with \`pnpm a1:observation:generate\`; \`pnpm a1:observation:verify\`
-- compares bytes. The ${witnessCount} witness arms below come from
-- db/hosted/package-witnesses.ts, so this file cannot drift from the registry
-- that classifies its output.
--
-- READ ONLY. No INSERT, no UPDATE, no DELETE, no DDL. Runs inside a READ ONLY
-- transaction and rolls back.
--
--   & $Psql -X -q -A -t -v ON_ERROR_STOP=1 -v uellix_project_ref=<ref> -f ${A1_OBSERVATION_SQL}
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MEASURES, AND THE ONE THING IT DELIBERATELY DOES NOT
-- ---------------------------------------------------------------------------
-- CHECKPOINT A1 needs three INDEPENDENT signals of identity: the connection, the
-- declaration, and the database. This query can answer only the third, and it
-- must not appear to answer the first. \`current_user\` behind the Supabase
-- Session Pooler is plain \`postgres\` — the login role \`postgres.<ref>\` is
-- consumed by the pooler and never reaches the backend — so a "connectionHost"
-- or "poolerUser" reported from in here would be a value derived from the same
-- place as the sentinel, wearing the name of an independent signal. Those two
-- are supplied by the OPERATOR when the artefact is assembled.
--
-- SIGNAL 3 is \`sentinelObservation.projectRef\`, and it is read from the ROW.
-- The S1 probe reported only the row COUNT on purpose; that was right for a
-- phase whose expectation is that the row is ABSENT. A1 asks what the row SAYS,
-- and a count corroborates no identity.
--
-- Every witness is resolved individually and by FULL SIGNATURE. Arity is the
-- discriminator: settle_reserved_quota exists with five arguments in
-- stella_0016 and with ten in stella_0017, and stella_0017 re-creates the
-- five-argument one, so a lookup by name would report the successor installed
-- as soon as its predecessor was.
-- ============================================================================
\\if :{?uellix_project_ref}
\\else
\\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\\echo 'An unattributed observation could describe any database, including production.'
\\quit
\\endif

BEGIN READ ONLY;
SET LOCAL search_path = '';

-- The ref reaches the guard through a transaction-local setting rather than
-- through :'uellix_project_ref' inside the body: psql does NOT substitute
-- variables inside a $$ ... $$ block, so the literal text would reach the server
-- and fail as syntax. Measured in S2, not assumed.
--
-- \\gset, not a bare SELECT. THE OUTPUT OF THIS FILE IS THE ARTEFACT. A plain
-- SELECT prints its result row, so under -A -t the operator would receive the
-- ref on line 1 and the JSON on line 2 onward, and would have to hand-trim the
-- file before recording it. Every hand edit of a measurement is an opportunity
-- to record something other than what was measured, so the probe emits exactly
-- one document and nothing else. \\gset consumes the row into a psql variable
-- and prints nothing.
SELECT pg_catalog.set_config('uellix.a1_project_ref', :'uellix_project_ref', true) AS uellix_a1_bound \\gset

DO $$
DECLARE
  v_ref text := pg_catalog.current_setting('uellix.a1_project_ref');
BEGIN
  -- (1) PRODUCTION DENY, by name, before a single catalogue row is read.
  IF v_ref IN (${productionRefs}) THEN
    RAISE EXCEPTION 'A1 REFUSED: % is a PRODUCTION project ref. CHECKPOINT A1 authorises PHASE_STELLA_CHAIN; it never runs there, not even read-only, because an artefact describing production would be a corroboration nobody should be able to produce.', v_ref;
  END IF;

  -- (2) THE PIN. A consistent identity for the wrong project is still the wrong
  --     project, and this probe exists to authorise exactly one.
  IF v_ref <> ${sqlLit(expectedProjectRef)} THEN
    RAISE EXCEPTION 'A1 REFUSED: this probe corroborates % and you declared %.', ${sqlLit(expectedProjectRef)}, v_ref;
  END IF;

  -- (3) THE TWO RELATIONS THIS QUERY NAMES STATICALLY.
  --
  --     NOT belt-and-braces, and not a nicety. PostgreSQL PARSES a statement
  --     before it evaluates it, so a CASE arm guarding a missing relation does
  --     NOT save the statement: the first draft of this file wrapped the
  --     sentinel read in
  --       CASE WHEN to_regclass(...) IS NULL THEN <nulls> ELSE (SELECT … FROM
  --       uellix_bootstrap.staging_sentinel) END
  --     and it failed with 42P01 against a database where the table was absent,
  --     because the ELSE arm still has to parse. MEASURED against PostgreSQL,
  --     not reasoned about.
  --
  --     So the absence is refused HERE, by name, with the phase that would have
  --     created it — which is also the more useful output. A1 has one
  --     precondition per relation and an operator who is missing one needs to
  --     know which, not a JSON document full of nulls.
  IF pg_catalog.to_regclass('uellix_bootstrap.staging_sentinel') IS NULL THEN
    RAISE EXCEPTION 'A1 REFUSED: uellix_bootstrap.staging_sentinel does not exist, so PHASE_STELLA_BOOTSTRAP (S1) has not committed against this database. CHECKPOINT A1 reads identity out of that row; there is nothing here to corroborate.';
  END IF;

  IF pg_catalog.to_regclass('uellix_provisioning.applied_units') IS NULL THEN
    RAISE EXCEPTION 'A1 REFUSED: uellix_provisioning.applied_units does not exist, so no baseline unit can be shown to have been applied. Unrecorded is not applied, and PHASE_STELLA_CHAIN does not run on a baseline nobody can account for.';
  END IF;
END $$;

SELECT jsonb_pretty(jsonb_build_object(
  'targetProjectRef', :'uellix_project_ref',
  'measuredBy', 'operator, psql session pooler, inside a READ ONLY transaction, from ${A1_OBSERVATION_SQL}',
  'note', 'Project refs are not secret. No credential, connection string or user data is recorded here. connectionHost and poolerUser are DELIBERATELY absent: they are client-side facts and this database cannot see them.',

  -- GAP A. The ROW, not the count.
  --
  -- Two jsonb objects merged with \`||\`: the facts that hold whatever the table
  -- contains, and the row's own fields. The second half is a scalar subquery, so
  -- an empty table yields NULL and the coalesce supplies explicit nulls — the
  -- COUNT still reports the truth, and the parser refuses anything other than
  -- exactly one row rather than reading a null-filled object as "fine".
  'sentinelObservation', (
    jsonb_build_object(
      'tablePresent', (pg_catalog.to_regclass('uellix_bootstrap.staging_sentinel') IS NOT NULL),
      'rowCount',     (SELECT count(*) FROM uellix_bootstrap.staging_sentinel))
    || coalesce(
      (SELECT jsonb_build_object(
         'id',               s.id,
         'environment',      s.environment,
         -- SIGNAL 3. Read from the ROW. Nothing downstream may substitute the
         -- declared ref for it, and a mismatch is a refusal rather than a
         -- preference.
         'projectRef',       s.project_ref,
         'bootstrapVersion', s.bootstrap_version,
         'provisionedAt',    s.provisioned_at,
         'ownerSeparation',  s.owner_separation,
         -- Derived HERE, beside the text it comes from, so an artefact where
         -- the two disagree is provably hand-edited.
         --
         -- \`strpos\`, not \`position(… in …)\`. The latter is SQL keyword syntax
         -- and cannot be schema-qualified — \`pg_catalog.position('x' in y)\` is a
         -- syntax error, measured rather than assumed — and an unqualified call
         -- would resolve through a search_path this transaction has emptied.
         'rr02Present',      pg_catalog.strpos(s.owner_separation, 'RR-02') > 0)
       FROM uellix_bootstrap.staging_sentinel s
       ORDER BY s.id
       LIMIT 1),
      jsonb_build_object('id', NULL, 'environment', NULL, 'projectRef', NULL,
                         'bootstrapVersion', NULL, 'provisionedAt', NULL,
                         'ownerSeparation', NULL, 'rr02Present', NULL))),

  -- The chain's precondition, not an assumption inherited from CHECKPOINT B0.
  'bootstrapSchemaPresent', EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = 'uellix_bootstrap'),

  -- Re-measured rather than carried forward. B0 was taken before the bootstrap;
  -- a ledger read today is what says the baseline is still complete today.
  'baselineJournal', jsonb_build_object(
    'tablePresent', (pg_catalog.to_regclass('uellix_provisioning.applied_units') IS NOT NULL),
    'units', coalesce((SELECT jsonb_agg(jsonb_build_object('packageId', u.package_id, 'status', u.status)
                                        ORDER BY u.package_id, u.status)
                       FROM uellix_provisioning.applied_units u), '[]'::jsonb),
    -- DISTINCT, because the question is "does this ledger describe more than one
    -- project", and one foreign row is the whole answer.
    'projectRefs', coalesce((SELECT jsonb_agg(DISTINCT u.project_ref)
                             FROM uellix_provisioning.applied_units u), '[]'::jsonb),
    'environments', coalesce((SELECT jsonb_agg(DISTINCT u.environment)
                              FROM uellix_provisioning.applied_units u), '[]'::jsonb)),

  -- GAP C. ${planned.packages.length} packages, ${witnessCount} witnesses, each measured on its own.
  'packageObservations', jsonb_build_array(
${packageArms})
));

ROLLBACK;
`
}

/** Every chain package this checkpoint measures. Derived, never a parallel list. */
export const A1_WITNESSED_PACKAGES: readonly string[] = WITNESSED_PACKAGES

/** Sanity anchor for the docs: the chain minus the bootstrap. */
export const A1_EXPECTED_PACKAGE_COUNT = HOSTED_CHAIN.length - 1

/* -------------------------------------------------------------------------- */
/* The chain the COMMITTED corroboration was measured against                  */
/* -------------------------------------------------------------------------- */

/**
 * The packages `artifacts/hosted-a1-corroboration.json` actually observed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS FROZEN AND NOT DERIVED FROM WITNESSED_PACKAGES
 * ---------------------------------------------------------------------------
 * That artefact is a MEASUREMENT of staging, taken by an operator on
 * 2026-08-11, before a byte of the chain was applied. It observed nine packages
 * because nine existed. M-8 later added a tenth.
 *
 * Evaluating it against a ten-package chain gives `A1_PACKAGE_COUNT`: "nine
 * package observation(s); the chain has exactly ten". That refusal is CORRECT
 * as a general rule — an unmeasured member is unknown, not absent — and wrong
 * as a verdict about this file, which measured everything there was.
 *
 * Two ways out were available. Adding a tenth entry to the artefact would have
 * been one line and would have been a FABRICATED MEASUREMENT: a claim that an
 * operator observed grounding_0005 absent in a session that ran before
 * grounding_0005 was written. The other is to record what the observation
 * covered, which is this constant, and to make the verdict SAY that the
 * remainder is uncovered rather than quietly counting it as passed.
 *
 * ---------------------------------------------------------------------------
 * WHAT KEEPS IT HONEST
 * ---------------------------------------------------------------------------
 * `assertA1ObservedChainIsPrefix` requires it to be a PREFIX of the declared
 * chain. A prefix cannot skip a package, cannot reorder one, and cannot name
 * one the chain never had — so the only thing this constant can express is "the
 * chain, as far as it went at the time". Re-measuring staging is what extends
 * it, and extending it without re-measuring makes the count check fail.
 */
export const A1_OBSERVED_CHAIN: readonly string[] = [
  'grounding_0002_document_versions',
  'grounding_0003_evidence_chunks',
  'grounding_0004_runtime_attestation',
  'stella_0013_grounded_query_quota',
  'stella_0014_operation_tickets',
  'stella_0015_project_bound_operation_tickets',
  'stella_0016_reserved_quota_semantics',
  'stella_0017_governed_stella_consumption',
  'stella_0018_category_bound_operation_tickets',
]

export class A1ObservedChainRefusal extends Error {
  constructor(detail: string) {
    super(`A1_OBSERVED_CHAIN: ${detail}`)
    this.name = 'A1ObservedChainRefusal'
  }
}

/**
 * Refuses an observed chain that is not a prefix of the declared one.
 *
 * Called by the CLI before it evaluates anything, so a constant that drifted
 * into naming a package the chain does not have — or into skipping one it does
 * — stops the verdict rather than shaping it.
 */
export function assertA1ObservedChainIsPrefix(
  observed: readonly string[] = A1_OBSERVED_CHAIN,
  declared: readonly string[] = WITNESSED_PACKAGES,
): void {
  if (observed.length === 0) {
    throw new A1ObservedChainRefusal(
      'is empty. A checkpoint that observed no package measured nothing, and "nothing was found" ' +
        'is not the same statement as "nothing is there".',
    )
  }
  if (observed.length > declared.length) {
    throw new A1ObservedChainRefusal(
      `names ${observed.length} packages but the chain declares ${declared.length}. An observation ` +
        `cannot have covered a package that does not exist.`,
    )
  }
  for (const [i, name] of observed.entries()) {
    if (declared[i] !== name) {
      throw new A1ObservedChainRefusal(
        `position ${i} is ${name}, but the chain declares ${declared[i]}. This must be a PREFIX of ` +
          `the chain: a set that skips or reorders a package could record a checkpoint that never ` +
          `looked at the middle of the sequence it claims to have cleared.`,
      )
    }
  }
}

/**
 * The packages the recorded checkpoint did NOT cover, in chain order.
 *
 * Empty when the observation is current. Non-empty means the chain grew after
 * the measurement, and every consumer of the verdict has to be told — a
 * `checkpointPassed: true` computed over nine packages is not a statement about
 * a tenth.
 */
export function a1UncoveredPackages(
  observed: readonly string[] = A1_OBSERVED_CHAIN,
  declared: readonly string[] = WITNESSED_PACKAGES,
): readonly string[] {
  return declared.slice(observed.length)
}

export type { PackageState, StorageUnitState }
export { allWitnesses }

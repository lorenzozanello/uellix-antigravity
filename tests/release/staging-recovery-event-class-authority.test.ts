// @vitest-environment node
//
// tests/release/staging-recovery-event-class-authority.test.ts
// STAGING RECOVERY — event-class posture registry (OD-3 split by DDL event).
//
// Authority:
//   docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_v1.0.0.json
//   docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1.json
//   docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.2.json
//   docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.0.json
//   docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.1.json
//   docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.2.json
//
// WHAT THIS FILE IS. A reference interpreter of the amendment's machine-
// readable registry (SECTION_C4), its S8 facts (SECTION_C9) and its exposure
// contract (SECTION_C7), plus structural checks over the historical artifacts.
// The interpreter READS every rule — class membership, posture, required facts,
// stop codes, evaluation order — from the amendment. It hardcodes none of them,
// so a scenario that STOPS here stops because the authority says so; §7 proves
// that by mutating the authority and watching a STOP turn into a pass.
//
// WHAT THIS FILE IS NOT. It performs no database connection, no provider call
// and no hosted act. POSTURE_APPLICABLE is not an execution authorization.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

const PATHS = {
  authorityV100: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_v1.0.0.json',
  manifestV100: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_v1.0.0.json',
  ownerV100: 'docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.0.json',
  amendmentV101: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1.json',
  manifestAmendmentV101: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.1.json',
  amendmentV102: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.2.json',
  manifestAmendmentV102: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.2.json',
  ownerV101: 'docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.1.json',
} as const

const readBytes = (rel: string): Buffer => readFileSync(path.join(ROOT, rel))
const readJson = <T>(rel: string): T => JSON.parse(readBytes(rel).toString('utf8')) as T

/** git's blob id: sha1 over "blob <len>\0<bytes>". docs/** is pinned to LF, so tree bytes are blob bytes. */
function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex')
}

/** Canonical JSON: keys sorted recursively, no insignificant whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
const canonicalSha256 = (value: unknown): string =>
  createHash('sha256').update(canonical(value), 'utf8').digest('hex')

/* ========================================================================== */
/* Shapes read from the artifacts (only the parts this file consumes)         */
/* ========================================================================== */

interface FactSpec {
  id: string
  fact: string
  required: string
  unknown_values: string[]
  stop_on_unknown: string
  stop_on_mismatch: string
}
interface ClassEntry {
  unit_membership: string
  posture: string
  required_facts: FactSpec[]
  stop_codes: string[]
}
interface Registry {
  classification: { class_by_membership: Record<string, string> }
  postures: Record<string, { applies_to: string[] }>
  not_authorized_posture_labels: string[]
  staging_project_ref: string
  production_project_refs: string[]
  common_pre_class_facts: FactSpec[]
  classes: Record<string, ClassEntry>
  UNKNOWN: { posture: null; stop_code: string }
  global_stop_codes: string[]
}
interface AmendmentV102 {
  SECTION_C1_EFFECTIVE_PREDECESSOR_MAP: {
    effective_recovery_package_at_BASE_SHA: { path: string; blob: string }[]
  }
  SECTION_C4_EVENT_CLASS_REGISTRY: Registry
  SECTION_C7_EVENT_B_BOUNDED_EXPOSURE_CONTRACT: {
    required_fields: { field: string }[]
    machine_required_paths: string[]
  }
  SECTION_C9_S8_AND_D1: { S8_INTERPRETATION: { common_required_facts: FactSpec[] } }
  SECTION_C11_SELF_CHECK_DEFECT_REPAIR: {
    AUTHORIZED_OPERATIONS_DELTA: { added: unknown[]; removed: unknown[]; modified: unknown[] }
  }
  SECTION_C15_OD5_OD6_AND_OTHER_PRESERVATION: {
    pins: Record<string, { blob: string; canonical_sha256: string }>
  }
  SECTION_C19_WRITE_SET: string[]
}
interface Ratification { id: string; [k: string]: unknown }
interface OwnerV100 { ratifications: Ratification[] }
interface OwnerV101 {
  owner_decision_verbatim: string[]
  structured_decision: Record<string, unknown> & {
    CONDITIONS_EVENT_A: string[]
    CONDITIONS_EVENT_B: string[]
  }
  authority_binding: { historical_blobs: Record<string, string> }
  carry_forward_reverification: Record<string, { canonical_sha256?: string }>
}
interface AuthorityV100 {
  TARGET: {
    AUTHORIZED_TARGET: { project_ref: string }
    PRODUCTION_VETO: { project_ref: string }
  }
  AUTHORIZED_OPERATIONS: { operations: { id: string }[] }
  [k: string]: unknown
}

const amendment = readJson<AmendmentV102>(PATHS.amendmentV102)
const ownerV100 = readJson<OwnerV100>(PATHS.ownerV100)
const ownerV101 = readJson<OwnerV101>(PATHS.ownerV101)
const authorityV100 = readJson<AuthorityV100>(PATHS.authorityV100)

/* ========================================================================== */
/* The reference interpreter                                                  */
/* ========================================================================== */

type Facts = Record<string, string | undefined>
interface WindowInput {
  named_project_refs: string[]
  units: { id: string; membership: string }[]
  declared_event_class?: string
  evidence_event_class?: string
  claimed_posture?: string
  facts: Facts
  exposure_record?: Record<string, unknown>
  hc2b_confirmed_at_utc?: string
}
type Verdict =
  | { verdict: 'STOP'; code: string; execution_authorized: false }
  | { verdict: 'POSTURE_APPLICABLE'; event_class: string; posture: string; execution_authorized: false }

const stop = (code: string): Verdict => ({ verdict: 'STOP', code, execution_authorized: false })

function getPath(obj: Record<string, unknown> | undefined, dotted: string): unknown {
  let cur: unknown = obj
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

const isInstant = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v))

/** SECTION_C7: derive, never trust, the two exposure facts. */
function deriveExposureFacts(
  auth: AmendmentV102,
  record: Record<string, unknown> | undefined,
  confirmedAt: string | undefined,
): { exposure_bound: string; exposure_quantified_before_confirmation: string } {
  const unbounded = { exposure_bound: 'UNBOUNDED', exposure_quantified_before_confirmation: 'UNKNOWN' }
  if (!record) return unbounded
  const contract = auth.SECTION_C7_EVENT_B_BOUNDED_EXPOSURE_CONTRACT
  const reg = auth.SECTION_C4_EVENT_CLASS_REGISTRY
  for (const p of contract.machine_required_paths) {
    const v = getPath(record, p)
    if (v === undefined || v === null || v === '' || v === 'UNKNOWN') return unbounded
    if (Array.isArray(v) && v.length === 0) return unbounded
  }
  if (record.event_class !== 'EVENT_B_STAGE_A') return unbounded
  if (getPath(record, 'ddl_operation.event_class') !== 'EVENT_B_STAGE_A') return unbounded
  if (record.target_project_ref !== reg.staging_project_ref) return unbounded
  if (record.target_environment_class !== 'STAGING') return unbounded
  if (record.window_start_anchor !== 'RECOVERY_POINT_CAPTURE_SNAPSHOT_W0') return unbounded
  if (getPath(record, 'maintenance_state_predicate.traffic_posture') !== 'MAINTENANCE_NO_INTENTIONAL_TRAFFIC') return unbounded
  if (getPath(record, 'maintenance_state_predicate.pilot_session_posture') !== 'NONE_INTENTIONALLY_ACTIVE') return unbounded
  const start = record.window_start_utc
  if (!isInstant(start)) return unbounded
  const end = record.window_end_utc
  const dur = record.max_bounded_duration_seconds
  const endOk = end !== undefined && isInstant(end) && Date.parse(end) > Date.parse(start)
  const durOk = dur !== undefined && typeof dur === 'number' && Number.isInteger(dur) && dur > 0 && Number.isFinite(dur)
  if (end !== undefined && !endOk) return unbounded
  if (dur !== undefined && !durOk) return unbounded
  if (!endOk && !durOk) return unbounded
  const cs = getPath(record, 'recovery_point.capture_started_at_utc')
  const cf = getPath(record, 'recovery_point.capture_finished_at_utc')
  if (!isInstant(cs) || !isInstant(cf) || Date.parse(cf) < Date.parse(cs)) return unbounded
  const quantifiedAt = record.quantified_at_utc
  if (!isInstant(quantifiedAt)) return unbounded
  const before =
    confirmedAt === undefined || !isInstant(confirmedAt)
      ? 'UNKNOWN'
      : Date.parse(quantifiedAt) < Date.parse(confirmedAt)
        ? 'YES'
        : 'NO'
  return { exposure_bound: 'BOUNDED_AND_QUANTIFIED', exposure_quantified_before_confirmation: before }
}

function checkFact(spec: FactSpec, facts: Facts): string | null {
  const v = facts[spec.fact]
  if (v === undefined || spec.unknown_values.includes(v)) return spec.stop_on_unknown
  if (v !== spec.required) return spec.stop_on_mismatch
  return null
}

/** EV-1..EV-9 of SECTION_C4.evaluation_order, driven entirely by the artifact. */
function evaluateWindow(auth: AmendmentV102, input: WindowInput): Verdict {
  const reg = auth.SECTION_C4_EVENT_CLASS_REGISTRY

  // EV-1 production veto FIRST, over every ref named anywhere, including the exposure record.
  const refs = [...input.named_project_refs]
  const recordRef = input.exposure_record?.target_project_ref
  if (typeof recordRef === 'string') refs.push(recordRef)
  if (refs.some((r) => reg.production_project_refs.includes(r))) return stop('STOP_PRODUCTION_TARGET')

  // EV-2 staging identity.
  for (const spec of reg.common_pre_class_facts) {
    const code = checkFact(spec, input.facts)
    if (code) return stop(code)
  }

  // EV-3 classification from unit membership only.
  const classes = new Set(input.units.map((u) => reg.classification.class_by_membership[u.membership] ?? 'UNKNOWN'))
  const derived = input.units.length > 0 && classes.size === 1 ? [...classes][0] : 'UNKNOWN'
  if (derived === 'UNKNOWN' || !(derived in reg.classes)) return stop(reg.UNKNOWN.stop_code)
  const entry = reg.classes[derived]

  // EV-4 declared class must agree with the derivation.
  if (input.declared_event_class !== derived) return stop('STOP_EVENT_CLASS_DECLARATION_MISMATCH')
  // EV-5 posture evidence must have been produced for THIS class.
  if (input.evidence_event_class !== derived) return stop('STOP_WRONG_EVENT_CLASS_EVIDENCE')
  // EV-6 the claimed posture.
  if (input.claimed_posture !== undefined && reg.not_authorized_posture_labels.includes(input.claimed_posture)) {
    return stop('STOP_C2_PARTIAL_QUIESCE_NOT_AUTHORIZED')
  }
  if (input.claimed_posture !== entry.posture) return stop('STOP_POSTURE_CLAIM_MISMATCH')

  // EV-7 class facts; the two exposure facts are DERIVED from the record for any class that requires them.
  const facts: Facts = { ...input.facts }
  const needsExposure = entry.required_facts.some((f) => f.fact === 'exposure_bound')
  if (needsExposure) Object.assign(facts, deriveExposureFacts(auth, input.exposure_record, input.hc2b_confirmed_at_utc))
  for (const spec of entry.required_facts) {
    const code = checkFact(spec, facts)
    if (code) return stop(code)
  }
  // EV-8 common S8 facts.
  for (const spec of auth.SECTION_C9_S8_AND_D1.S8_INTERPRETATION.common_required_facts) {
    const code = checkFact(spec, facts)
    if (code) return stop(code)
  }
  // EV-9
  return { verdict: 'POSTURE_APPLICABLE', event_class: derived, posture: entry.posture, execution_authorized: false }
}

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

const STAGING = 'bvyzblhqymxruxdguaee'
const PRODUCTION = 'ctaxtgujyyprgynmnvtq'

const S8_GREEN: Facts = {
  recovery_point_integrity: 'VERIFIED',
  window_artifact_restorability: 'RESTORED_AND_PRI_PASS',
  procedure_identity_vs_d1: 'MATCH',
  recovery_point_sequence: 'INTACT',
}

function validEventA(): WindowInput {
  return {
    named_project_refs: [STAGING],
    units: [{ id: 'corpus-unit-0051', membership: 'S1_EXACT_CORPUS_UNIT' }],
    declared_event_class: 'EVENT_A_INITIAL_CORPUS',
    evidence_event_class: 'EVENT_A_INITIAL_CORPUS',
    claimed_posture: 'C3_EMPTY_WINDOW_BY_CONSTRUCTION',
    facts: {
      staging_target_identity: 'VERIFIED_STAGING_PIN',
      census_governance: 'CERTIFIED_CENSUS_EXECUTION',
      census_classification: 'C3_AVAILABLE',
      active_client_or_writer_evidence: 'NONE_FOUND',
      pr201_execution_state: 'NOT_EXECUTED',
      census_freshness: 'FRESH',
      deciding_observations_retaken_at_w1: 'RETAKEN_NEGATIVE',
      ...S8_GREEN,
    },
  }
}

function validExposureRecord(): Record<string, unknown> {
  return {
    record_id: 'EXPOSURE-TEST-1',
    event_class: 'EVENT_B_STAGE_A',
    target_project_ref: STAGING,
    target_environment_class: 'STAGING',
    window_start_utc: '2026-10-01T10:00:00Z',
    window_start_anchor: 'RECOVERY_POINT_CAPTURE_SNAPSHOT_W0',
    max_bounded_duration_seconds: 5400,
    recovery_point: {
      backup_identifier: 'sha256:test-digest|locator-class:local-disposable',
      capture_started_at_utc: '2026-10-01T09:58:00Z',
      capture_finished_at_utc: '2026-10-01T10:00:00Z',
    },
    ddl_operation: {
      event_class: 'EVENT_B_STAGE_A',
      unit_identities: ['db/prepared/hosted/governed/stella_0017b_governed_risk_parameters.governed.sql'],
      migration_corpus_packet_digest: 'sha256:test-corpus',
      release_sha: '0000000000000000000000000000000000000000',
    },
    maintenance_state_predicate: {
      maintenance_window_declared_at_utc: '2026-09-30T12:00:00Z',
      traffic_posture: 'MAINTENANCE_NO_INTENTIONAL_TRAFFIC',
      pilot_session_posture: 'NONE_INTENTIONALLY_ACTIVE',
      pilot_session_attestation_ref: 'sha256:test-attestation',
    },
    exposure_basis: 'measured capture + integrity + rehearsal durations plus planned DDL and health observation',
    quantified_at_utc: '2026-10-01T10:40:00Z',
  }
}

function validEventB(): WindowInput {
  return {
    named_project_refs: [STAGING],
    units: [{ id: 'stella_0017b_governed_risk_parameters.governed', membership: 'FIBDB053_STAGE_A_UNIT' }],
    declared_event_class: 'EVENT_B_STAGE_A',
    evidence_event_class: 'EVENT_B_STAGE_A',
    claimed_posture: 'ACCEPT_BOUNDED_STAGING_WRITE_LOSS',
    facts: {
      staging_target_identity: 'VERIFIED_STAGING_PIN',
      maintenance_window: 'SCHEDULED_AND_DECLARED',
      pilot_session_posture: 'NONE_INTENTIONALLY_ACTIVE',
      traffic_posture: 'MAINTENANCE_NO_INTENTIONAL_TRAFFIC',
      // Stage-A runs AFTER the runtime is deployed (RC-09): PR #201 executed is the expected world.
      pr201_execution_state: 'EXECUTED',
      ...S8_GREEN,
    },
    exposure_record: validExposureRecord(),
    hc2b_confirmed_at_utc: '2026-10-01T10:45:00Z',
  }
}

const run = (input: WindowInput): Verdict => evaluateWindow(amendment, input)
const codeOf = (v: Verdict): string => (v.verdict === 'STOP' ? v.code : v.verdict)

/* ========================================================================== */
/* §1 Event A — C3_EMPTY_WINDOW_BY_CONSTRUCTION                               */
/* ========================================================================== */

describe('§1 EVENT_A_INITIAL_CORPUS', () => {
  it('E — valid, fresh C3 evidence: the C3 posture applies, and it is not an execution authorization', () => {
    expect(run(validEventA())).toEqual({
      verdict: 'POSTURE_APPLICABLE',
      event_class: 'EVENT_A_INITIAL_CORPUS',
      posture: 'C3_EMPTY_WINDOW_BY_CONSTRUCTION',
      execution_authorized: false,
    })
  })

  it('A — PR #201 executed, in whole or in part, STOPS', () => {
    for (const state of ['EXECUTED', 'PARTIALLY_EXECUTED']) {
      const input = validEventA()
      input.facts.pr201_execution_state = state
      expect(codeOf(run(input))).toBe('STOP_EVENT_A_PR201_EXECUTED')
    }
  })

  it('A — PR #201 execution state UNKNOWN or unrecorded STOPS', () => {
    const unknown = validEventA()
    unknown.facts.pr201_execution_state = 'UNKNOWN'
    expect(codeOf(run(unknown))).toBe('STOP_EVENT_A_PR201_STATE_UNKNOWN')
    const missing = validEventA()
    delete missing.facts.pr201_execution_state
    expect(codeOf(run(missing))).toBe('STOP_EVENT_A_PR201_STATE_UNKNOWN')
  })

  it('B — census UNKNOWN (C3_UNKNOWN, UNKNOWN or absent) STOPS', () => {
    for (const v of ['C3_UNKNOWN', 'UNKNOWN', undefined]) {
      const input = validEventA()
      input.facts.census_classification = v
      expect(codeOf(run(input))).toBe('STOP_EVENT_A_CENSUS_UNKNOWN')
    }
  })

  it('B — an ungoverned census STOPS even when it reads C3_AVAILABLE', () => {
    const input = validEventA()
    input.facts.census_governance = 'INFORMAL_OBSERVATION'
    expect(codeOf(run(input))).toBe('STOP_EVENT_A_CENSUS_NOT_GOVERNED')
  })

  it('C — the census shows a client or writer, or foreclosed C3, STOPS', () => {
    const writer = validEventA()
    writer.facts.active_client_or_writer_evidence = 'WRITER_PRESENT'
    expect(codeOf(run(writer))).toBe('STOP_EVENT_A_CLIENT_OR_WRITER_PRESENT')
    const foreclosed = validEventA()
    foreclosed.facts.census_classification = 'C3_NOT_AVAILABLE'
    expect(codeOf(run(foreclosed))).toBe('STOP_EVENT_A_C3_NOT_ESTABLISHED')
  })

  it('C — an EXPOSED surface with unmeasured occupancy is not absence of writers', () => {
    const input = validEventA()
    input.facts.active_client_or_writer_evidence = 'OCCUPANCY_UNMEASURED'
    expect(run(input).verdict).toBe('STOP')
  })

  it('D — a stale or void census, or a W1 re-observation not re-taken, STOPS', () => {
    for (const v of ['STALE', 'VOID']) {
      const input = validEventA()
      input.facts.census_freshness = v
      expect(codeOf(run(input))).toBe('STOP_EVENT_A_STALE_CENSUS')
    }
    const notRetaken = validEventA()
    notRetaken.facts.deciding_observations_retaken_at_w1 = 'NOT_RETAKEN'
    expect(codeOf(run(notRetaken))).toBe('STOP_EVENT_A_STALE_CENSUS')
  })

  it('C3 proves the empty window only: an unverified recovery point still STOPS Event A', () => {
    const input = validEventA()
    input.facts.recovery_point_integrity = 'UNKNOWN'
    expect(codeOf(run(input))).toBe('STOP_RECOVERY_POINT_INTEGRITY_UNKNOWN')
  })
})

/* ========================================================================== */
/* §2 Event B — ACCEPT_BOUNDED_STAGING_WRITE_LOSS                             */
/* ========================================================================== */

describe('§2 EVENT_B_STAGE_A', () => {
  it('K — bounded staging exposure plus every predicate: the bounded ACCEPT posture applies', () => {
    expect(run(validEventB())).toEqual({
      verdict: 'POSTURE_APPLICABLE',
      event_class: 'EVENT_B_STAGE_A',
      posture: 'ACCEPT_BOUNDED_STAGING_WRITE_LOSS',
      execution_authorized: false,
    })
  })

  it('K — Event A’s PR #201-not-executed predicate is NOT carried into Event B', () => {
    for (const state of ['EXECUTED', 'NOT_EXECUTED', 'UNKNOWN', undefined]) {
      const input = validEventB()
      input.facts.pr201_execution_state = state
      expect(run(input).verdict).toBe('POSTURE_APPLICABLE')
    }
    const bFacts = amendment.SECTION_C4_EVENT_CLASS_REGISTRY.classes.EVENT_B_STAGE_A.required_facts.map((f) => f.fact)
    expect(bFacts).not.toContain('pr201_execution_state')
  })

  it('G — no exposure record, or no bound at all, STOPS as unbounded', () => {
    const none = validEventB()
    delete none.exposure_record
    expect(codeOf(run(none))).toBe('STOP_UNBOUNDED_STAGING_WRITE_LOSS_EXPOSURE')
    const noBound = validEventB()
    delete noBound.exposure_record!.max_bounded_duration_seconds
    expect(codeOf(run(noBound))).toBe('STOP_UNBOUNDED_STAGING_WRITE_LOSS_EXPOSURE')
  })

  it('G — an ill-formed bound (end before start, zero, infinite, fractional duration) STOPS', () => {
    const backwards = validEventB()
    delete backwards.exposure_record!.max_bounded_duration_seconds
    backwards.exposure_record!.window_end_utc = '2026-10-01T09:00:00Z'
    expect(codeOf(run(backwards))).toBe('STOP_UNBOUNDED_STAGING_WRITE_LOSS_EXPOSURE')
    for (const d of [0, -60, Number.POSITIVE_INFINITY, 12.5]) {
      const input = validEventB()
      input.exposure_record!.max_bounded_duration_seconds = d
      expect(codeOf(run(input))).toBe('STOP_UNBOUNDED_STAGING_WRITE_LOSS_EXPOSURE')
    }
  })

  it('G — any required exposure field missing or UNKNOWN STOPS', () => {
    for (const p of amendment.SECTION_C7_EVENT_B_BOUNDED_EXPOSURE_CONTRACT.machine_required_paths) {
      const input = validEventB()
      const parts = p.split('.')
      const parent = parts.length === 1 ? input.exposure_record! : (getPath(input.exposure_record, parts[0]) as Record<string, unknown>)
      parent[parts[parts.length - 1]] = 'UNKNOWN'
      expect(codeOf(run(input)), p).toBe('STOP_UNBOUNDED_STAGING_WRITE_LOSS_EXPOSURE')
    }
  })

  it('G — exposure quantified at or after the human confirmation STOPS', () => {
    const late = validEventB()
    late.hc2b_confirmed_at_utc = '2026-10-01T10:40:00Z' // equal to quantified_at_utc: not strictly before
    expect(codeOf(run(late))).toBe('STOP_EXPOSURE_NOT_QUANTIFIED_BEFORE_CONFIRMATION')
    const unconfirmed = validEventB()
    delete unconfirmed.hc2b_confirmed_at_utc
    expect(codeOf(run(unconfirmed))).toBe('STOP_EXPOSURE_NOT_QUANTIFIED_BEFORE_CONFIRMATION')
  })

  it('G — an asserted exposure fact cannot override the derivation', () => {
    const input = validEventB()
    delete input.exposure_record
    input.facts.exposure_bound = 'BOUNDED_AND_QUANTIFIED'
    input.facts.exposure_quantified_before_confirmation = 'YES'
    expect(codeOf(run(input))).toBe('STOP_UNBOUNDED_STAGING_WRITE_LOSS_EXPOSURE')
  })

  it('H — a production target STOPS first, from any place it is named', () => {
    const named = validEventB()
    named.named_project_refs.push(PRODUCTION)
    expect(codeOf(run(named))).toBe('STOP_PRODUCTION_TARGET')
    const inRecord = validEventB()
    inRecord.exposure_record!.target_project_ref = PRODUCTION
    expect(codeOf(run(inRecord))).toBe('STOP_PRODUCTION_TARGET')
    // The veto runs before classification: even an unclassifiable window reports the veto.
    const broken = validEventB()
    broken.named_project_refs = [PRODUCTION]
    broken.units = []
    expect(codeOf(run(broken))).toBe('STOP_PRODUCTION_TARGET')
  })

  it('H — an UNKNOWN staging identity STOPS', () => {
    const input = validEventB()
    input.facts.staging_target_identity = 'UNKNOWN'
    expect(codeOf(run(input))).toBe('STOP_STAGING_IDENTITY_UNKNOWN')
  })

  it('I — an active commercial pilot or user session STOPS; an UNKNOWN posture STOPS', () => {
    const active = validEventB()
    active.facts.pilot_session_posture = 'ACTIVE'
    expect(codeOf(run(active))).toBe('STOP_ACTIVE_PILOT_OR_USER_SESSION')
    const unknown = validEventB()
    unknown.facts.pilot_session_posture = 'UNKNOWN'
    expect(codeOf(run(unknown))).toBe('STOP_PILOT_SESSION_POSTURE_UNKNOWN')
  })

  it('intentional application traffic, or an undeclared maintenance window, STOPS', () => {
    const traffic = validEventB()
    traffic.facts.traffic_posture = 'NORMAL_OPERATION'
    expect(codeOf(run(traffic))).toBe('STOP_INTENTIONAL_APPLICATION_TRAFFIC')
    const noWindow = validEventB()
    noWindow.facts.maintenance_window = 'AD_HOC'
    expect(codeOf(run(noWindow))).toBe('STOP_MAINTENANCE_WINDOW_NOT_DECLARED')
  })

  it('J — a C2 partial-quiesce assertion, under any alias, STOPS', () => {
    for (const label of amendment.SECTION_C4_EVENT_CLASS_REGISTRY.not_authorized_posture_labels) {
      const input = validEventB()
      input.claimed_posture = label
      expect(codeOf(run(input)), label).toBe('STOP_C2_PARTIAL_QUIESCE_NOT_AUTHORIZED')
    }
    expect(amendment.SECTION_C4_EVENT_CLASS_REGISTRY.not_authorized_posture_labels).toContain('C2_PARTIAL_QUIESCE')
  })

  it('J — relabelling ACCEPT as QUIESCE, or claiming C3 for Event B, STOPS', () => {
    for (const label of ['QUIESCE', 'C3_EMPTY_WINDOW_BY_CONSTRUCTION']) {
      const input = validEventB()
      input.claimed_posture = label
      expect(codeOf(run(input)), label).toBe('STOP_POSTURE_CLAIM_MISMATCH')
    }
  })

  it('ACCEPT is not permission to skip Recovery: every S8 predicate still binds Event B', () => {
    const expectations: Record<string, string> = {
      recovery_point_integrity: 'STOP_RECOVERY_POINT_INTEGRITY_UNKNOWN',
      window_artifact_restorability: 'STOP_S8_PREDICATE_UNKNOWN',
      procedure_identity_vs_d1: 'STOP_S8_PREDICATE_UNKNOWN',
      recovery_point_sequence: 'STOP_S8_PREDICATE_UNKNOWN',
    }
    for (const [fact, code] of Object.entries(expectations)) {
      const input = validEventB()
      input.facts[fact] = 'UNKNOWN'
      expect(codeOf(run(input)), fact).toBe(code)
    }
    const otherArtifact = validEventB()
    otherArtifact.facts.window_artifact_restorability = 'ONLY_D1_PROOF_OF_ANOTHER_ARTIFACT'
    expect(codeOf(run(otherArtifact))).toBe('STOP_S8_WINDOW_ARTIFACT_NOT_VERIFIED_RESTORABLE')
  })
})

/* ========================================================================== */
/* §3 Classification — F and P                                                */
/* ========================================================================== */

describe('§3 classification', () => {
  it('F — Event A evidence reused for an Event B window STOPS as wrong-class evidence', () => {
    const input = validEventB()
    input.evidence_event_class = 'EVENT_A_INITIAL_CORPUS'
    Object.assign(input.facts, validEventA().facts)
    expect(codeOf(run(input))).toBe('STOP_WRONG_EVENT_CLASS_EVIDENCE')
  })

  it('F — Event B evidence reused for an Event A window STOPS as wrong-class evidence', () => {
    const input = validEventA()
    input.evidence_event_class = 'EVENT_B_STAGE_A'
    expect(codeOf(run(input))).toBe('STOP_WRONG_EVENT_CLASS_EVIDENCE')
  })

  it('P — an UNKNOWN event class STOPS: empty, mixed, unknown or foreign membership', () => {
    const cases: WindowInput['units'][] = [
      [],
      [
        { id: 'corpus-unit-0051', membership: 'S1_EXACT_CORPUS_UNIT' },
        { id: 'stella_0017b', membership: 'FIBDB053_STAGE_A_UNIT' },
      ],
      [{ id: 'x', membership: 'UNKNOWN' }],
      [{ id: 'y', membership: 'SOME_OTHER_DDL' }],
    ]
    for (const units of cases) {
      const input = validEventA()
      input.units = units
      expect(codeOf(run(input))).toBe('STOP_UNKNOWN_EVENT_CLASS')
    }
    expect(amendment.SECTION_C4_EVENT_CLASS_REGISTRY.UNKNOWN.posture).toBeNull()
  })

  it('P — a missing or disagreeing class declaration STOPS', () => {
    const missing = validEventA()
    delete missing.declared_event_class
    expect(codeOf(run(missing))).toBe('STOP_EVENT_CLASS_DECLARATION_MISMATCH')
    const wrong = validEventA()
    wrong.declared_event_class = 'EVENT_B_STAGE_A'
    expect(codeOf(run(wrong))).toBe('STOP_EVENT_CLASS_DECLARATION_MISMATCH')
  })

  it('UNKNOWN never becomes a posture: every required fact set to UNKNOWN STOPS, in both classes', () => {
    const reg = amendment.SECTION_C4_EVENT_CLASS_REGISTRY
    const s8 = amendment.SECTION_C9_S8_AND_D1.S8_INTERPRETATION.common_required_facts
    const derivedFacts = new Set(['exposure_bound', 'exposure_quantified_before_confirmation'])
    for (const [cls, make] of [
      ['EVENT_A_INITIAL_CORPUS', validEventA],
      ['EVENT_B_STAGE_A', validEventB],
    ] as const) {
      const specs = [...reg.common_pre_class_facts, ...reg.classes[cls].required_facts, ...s8]
      for (const spec of specs) {
        if (derivedFacts.has(spec.fact)) continue
        const input = make()
        input.facts[spec.fact] = 'UNKNOWN'
        const v = run(input)
        expect(v.verdict, `${cls}:${spec.fact}`).toBe('STOP')
      }
    }
  })
})

/* ========================================================================== */
/* §4 Registry invariants — L, and the owner record's fidelity                */
/* ========================================================================== */

function registryViolations(auth: AmendmentV102, owner101: OwnerV101): string[] {
  const out: string[] = []
  const reg = auth.SECTION_C4_EVENT_CLASS_REGISTRY
  const sd = owner101.structured_decision
  const names = Object.keys(reg.classes).sort()
  if (canonical(names) !== canonical(['EVENT_A_INITIAL_CORPUS', 'EVENT_B_STAGE_A'])) out.push('class set is not exactly {A, B}')
  if (reg.classes.EVENT_A_INITIAL_CORPUS?.posture !== sd.EVENT_A_INITIAL_CORPUS) out.push('Event A posture != owner decision')
  if (reg.classes.EVENT_B_STAGE_A?.posture !== sd.EVENT_B_STAGE_A) out.push('Event B posture != owner decision')
  const postures = Object.values(reg.classes).map((c) => c.posture)
  if (new Set(postures).size !== postures.length) out.push('one posture governs more than one class')
  if (postures.includes('QUIESCE')) out.push('historical global QUIESCE applied to a class')
  if ((reg.postures.QUIESCE?.applies_to ?? ['?']).length !== 0) out.push('QUIESCE applies to a class')
  if ((reg.postures.C2_PARTIAL_QUIESCE?.applies_to ?? ['?']).length !== 0) out.push('C2 applies to a class')
  const aFacts = reg.classes.EVENT_A_INITIAL_CORPUS?.required_facts.map((f) => f.fact) ?? []
  const bFacts = reg.classes.EVENT_B_STAGE_A?.required_facts.map((f) => f.fact) ?? []
  if (!aFacts.includes('pr201_execution_state')) out.push('Event A lost its PR #201 predicate')
  if (bFacts.includes('pr201_execution_state')) out.push('PR #201 predicate leaked into Event B')
  if (sd.C2_PARTIAL_QUIESCE !== 'NOT_AUTHORIZED') out.push('owner C2 != NOT_AUTHORIZED')
  if (sd.KEEP_FULL_SCOPE_QUIESCE_FOR_EVENT_B !== 'NO') out.push('owner KEEP_FULL_SCOPE != NO')
  return out
}

describe('§4 registry invariants', () => {
  it('the real registry and owner record satisfy every invariant', () => {
    expect(registryViolations(amendment, ownerV101)).toEqual([])
  })

  it('L — the historical global OD-3 (QUIESCE) applied unchanged to both events is RED', () => {
    const mutant = structuredClone(amendment)
    for (const c of Object.values(mutant.SECTION_C4_EVENT_CLASS_REGISTRY.classes)) c.posture = 'QUIESCE'
    const v = registryViolations(mutant, ownerV101)
    expect(v).toContain('historical global QUIESCE applied to a class')
    expect(v).toContain('one posture governs more than one class')
  })

  it('L — any single global posture shared by both events is RED', () => {
    const mutant = structuredClone(amendment)
    mutant.SECTION_C4_EVENT_CLASS_REGISTRY.classes.EVENT_A_INITIAL_CORPUS.posture = 'ACCEPT_BOUNDED_STAGING_WRITE_LOSS'
    expect(registryViolations(mutant, ownerV101)).toContain('one posture governs more than one class')
  })

  it('the PR #201 predicate leaking into Event B is RED', () => {
    const mutant = structuredClone(amendment)
    const a = mutant.SECTION_C4_EVENT_CLASS_REGISTRY.classes.EVENT_A_INITIAL_CORPUS.required_facts
    mutant.SECTION_C4_EVENT_CLASS_REGISTRY.classes.EVENT_B_STAGE_A.required_facts.push(
      structuredClone(a.find((f) => f.fact === 'pr201_execution_state')!),
    )
    expect(registryViolations(mutant, ownerV101)).toContain('PR #201 predicate leaked into Event B')
  })

  it('the owner record carries the decision verbatim and its structured form is exact', () => {
    const verbatim = ownerV101.owner_decision_verbatim.join('\n')
    const sd = ownerV101.structured_decision
    for (const [k, v] of Object.entries({
      RECOVERY_EVENT_CLASS_MODEL: 'AUTHORIZED',
      EVENT_A_INITIAL_CORPUS: 'C3_EMPTY_WINDOW_BY_CONSTRUCTION',
      EVENT_B_STAGE_A: 'ACCEPT_BOUNDED_STAGING_WRITE_LOSS',
      KEEP_FULL_SCOPE_QUIESCE_FOR_EVENT_B: 'NO',
      C2_PARTIAL_QUIESCE: 'NOT_AUTHORIZED',
      OD5: 'UNCHANGED',
      OD6: 'UNCHANGED',
      SIGNED: 'YES',
    })) {
      expect(sd[k], k).toBe(v)
    }
    for (const key of ['RECOVERY_EVENT_CLASS_MODEL', 'EVENT_A_INITIAL_CORPUS', 'EVENT_B_STAGE_A', 'KEEP_FULL_SCOPE_QUIESCE_FOR_EVENT_B', 'C2_PARTIAL_QUIESCE']) {
      expect(verbatim).toContain(`${key} =\n${String(sd[key])}`)
    }
    for (const c of [...sd.CONDITIONS_EVENT_A, ...sd.CONDITIONS_EVENT_B]) expect(verbatim).toContain(`- ${c}`)
    expect(verbatim).toContain('OD-5 and OD-6 remain unchanged.')
    expect(verbatim).toContain('SIGNED =\nYES')
  })

  it('every stop code a fact can emit is declared by the registry', () => {
    const reg = amendment.SECTION_C4_EVENT_CLASS_REGISTRY
    const s8 = amendment.SECTION_C9_S8_AND_D1.S8_INTERPRETATION.common_required_facts
    const declared = new Set([
      ...reg.global_stop_codes,
      ...Object.values(reg.classes).flatMap((c) => c.stop_codes),
      ...s8.flatMap((f) => [f.stop_on_unknown, f.stop_on_mismatch]),
    ])
    const all = [...reg.common_pre_class_facts, ...Object.values(reg.classes).flatMap((c) => c.required_facts), ...s8]
    for (const f of all) {
      expect(declared.has(f.stop_on_unknown), f.id).toBe(true)
      expect(declared.has(f.stop_on_mismatch), f.id).toBe(true)
    }
  })

  it('the exposure contract’s machine paths are exactly its non-alternative fields', () => {
    const c = amendment.SECTION_C7_EVENT_B_BOUNDED_EXPOSURE_CONTRACT
    const fields = c.required_fields.map((f) => f.field).filter((f) => !f.includes('|'))
    expect([...c.machine_required_paths].sort()).toEqual([...fields].sort())
  })

  it('the restated staging and production refs equal the frozen v1.0.0 TARGET', () => {
    const reg = amendment.SECTION_C4_EVENT_CLASS_REGISTRY
    expect(reg.staging_project_ref).toBe(authorityV100.TARGET.AUTHORIZED_TARGET.project_ref)
    expect(reg.production_project_refs).toEqual([authorityV100.TARGET.PRODUCTION_VETO.project_ref])
  })
})

/* ========================================================================== */
/* §5 OD-5 / OD-6 preservation — M and N                                      */
/* ========================================================================== */

function ratificationDigest(owner: OwnerV100, id: string): string {
  const r = owner.ratifications.find((x) => x.id === id)
  if (!r) throw new Error(`ratification ${id} absent`)
  return canonicalSha256(r)
}

function odPreservationViolations(owner100: OwnerV100): string[] {
  const out: string[] = []
  const pins = amendment.SECTION_C15_OD5_OD6_AND_OTHER_PRESERVATION.pins
  const carry = ownerV101.carry_forward_reverification
  for (const [id, pinKey] of [
    ['OD-5', 'owner_v1_0_0_OD_5'],
    ['OD-6', 'owner_v1_0_0_OD_6'],
    ['OD-3', 'owner_v1_0_0_OD_3_history'],
  ] as const) {
    const d = ratificationDigest(owner100, id)
    if (d !== pins[pinKey].canonical_sha256) out.push(`${id} altered (amendment pin)`)
    if (d !== carry[id].canonical_sha256) out.push(`${id} altered (owner carry-forward)`)
  }
  return out
}

describe('§5 OD-5 and OD-6 unchanged', () => {
  it('the real v1.0.0 OD-3, OD-5 and OD-6 recompute to the pinned digests in both successors', () => {
    expect(odPreservationViolations(ownerV100)).toEqual([])
  })

  it('M — OD-5 altered (a DP condition dropped) is RED', () => {
    const mutant = structuredClone(ownerV100)
    const od5 = mutant.ratifications.find((r) => r.id === 'OD-5')!
    ;(od5.conditions as unknown[]).shift()
    expect(odPreservationViolations(mutant)).toContain('OD-5 altered (amendment pin)')
  })

  it('M — OD-5 altered (decision widened) is RED', () => {
    const mutant = structuredClone(ownerV100)
    mutant.ratifications.find((r) => r.id === 'OD-5')!.decision = 'ACCEPT'
    expect(odPreservationViolations(mutant)).toContain('OD-5 altered (owner carry-forward)')
  })

  it('N — OD-6 altered (retention element dropped) is RED', () => {
    const mutant = structuredClone(ownerV100)
    const od6 = mutant.ratifications.find((r) => r.id === 'OD-6')! as Ratification & {
      retention_exception_requirements: { required_elements: string[] }
    }
    od6.retention_exception_requirements.required_elements.pop()
    expect(odPreservationViolations(mutant)).toContain('OD-6 altered (amendment pin)')
  })

  it('N — OD-6 altered (destroy-by-default reversed) is RED', () => {
    const mutant = structuredClone(ownerV100)
    mutant.ratifications.find((r) => r.id === 'OD-6')!.decision = 'RETAIN_BY_DEFAULT'
    expect(odPreservationViolations(mutant)).toContain('OD-6 altered (owner carry-forward)')
  })

  it('the v1.0.0 data-protection, retention, cleanup and target blocks are unchanged', () => {
    const pins = amendment.SECTION_C15_OD5_OD6_AND_OTHER_PRESERVATION.pins
    for (const key of ['DATA_PROTECTION_IN_A_REHEARSAL_RESTORE', 'RETENTION_AND_DISPOSAL', 'CLEANUP', 'TARGET']) {
      expect(canonicalSha256(authorityV100[key]), key).toBe(pins[`authority_v1_0_0_${key}`].canonical_sha256)
    }
  })
})

/* ========================================================================== */
/* §6 Historical artifacts byte-identical — O                                 */
/* ========================================================================== */

describe('§6 append-only: historical artifacts byte-identical', () => {
  const pinned = amendment.SECTION_C1_EFFECTIVE_PREDECESSOR_MAP.effective_recovery_package_at_BASE_SHA

  it('the successor pins exactly the five historical artifacts, and the owner record agrees', () => {
    expect(pinned.map((p) => p.path).sort()).toEqual(
      [PATHS.authorityV100, PATHS.manifestV100, PATHS.ownerV100, PATHS.amendmentV101, PATHS.manifestAmendmentV101].sort(),
    )
    for (const p of pinned) expect(ownerV101.authority_binding.historical_blobs[p.path], p.path).toBe(p.blob)
  })

  it('every historical artifact recomputes to its pinned git blob id', () => {
    for (const p of pinned) expect(gitBlobSha(readBytes(p.path)), p.path).toBe(p.blob)
  })

  it('O — a single appended byte in any historical artifact is RED', () => {
    for (const p of pinned) {
      const mutated = Buffer.concat([readBytes(p.path), Buffer.from(' ')])
      expect(gitBlobSha(mutated), p.path).not.toBe(p.blob)
    }
  })

  it('the write set names exactly the four added paths and they exist', () => {
    const paths = amendment.SECTION_C19_WRITE_SET.map((s) => s.split(' (')[0])
    expect(paths.sort()).toEqual(
      [PATHS.amendmentV102, PATHS.manifestAmendmentV102, PATHS.ownerV101, 'tests/release/staging-recovery-event-class-authority.test.ts'].sort(),
    )
    for (const p of paths) expect(readBytes(p).length, p).toBeGreaterThan(0)
  })
})

/* ========================================================================== */
/* §7 The self-check defect, reproduced and repaired structurally             */
/* ========================================================================== */

function operationIdViolations(authority: AuthorityV100): string[] {
  const ids = authority.AUTHORIZED_OPERATIONS.operations.map((o) => o.id)
  const expected = Array.from({ length: 9 }, (_, i) => `AO-${i + 1}`)
  return canonical(ids) === canonical(expected) ? [] : [`operation ids ${ids.join(',')}`]
}

function declaredOperationIds(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => declaredOperationIds(v, acc))
  else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.id === 'string' && /^AO-[0-9]+$/.test(obj.id)) acc.push(obj.id)
    Object.values(obj).forEach((v) => declaredOperationIds(v, acc))
  }
  return acc
}

describe('§7 self-check defect (v1.0.1 A12.checks[7] / NC-23)', () => {
  it('REPRODUCED — the historical string-absence check names the string it asserts absent', () => {
    const token = ['AO', '10'].join('-')
    const a101 = readBytes(PATHS.amendmentV101).toString('utf8')
    const m101 = readBytes(PATHS.manifestAmendmentV101).toString('utf8')
    const check = (JSON.parse(a101) as { SECTION_A12_SELF_CHECK: { checks: string[] } }).SECTION_A12_SELF_CHECK.checks[7]
    expect(check).toContain(token)
    expect(a101.split(token).length - 1).toBe(2)
    expect(m101.split(token).length - 1).toBe(1)
  })

  it('SC-OPS-1 — v1.0.0 AUTHORIZED_OPERATIONS is exactly AO-1..AO-9, parsed', () => {
    expect(operationIdViolations(authorityV100)).toEqual([])
  })

  it('SC-OPS-1 mutation — an added operation is RED structurally, with no string search', () => {
    const mutant = structuredClone(authorityV100)
    mutant.AUTHORIZED_OPERATIONS.operations.push({ id: `AO-${9 + 1}` })
    expect(operationIdViolations(mutant)).not.toEqual([])
  })

  it('SC-OPS-2..4 — the successors declare no operation and carry an empty delta', () => {
    expect(amendment.SECTION_C11_SELF_CHECK_DEFECT_REPAIR.AUTHORIZED_OPERATIONS_DELTA).toEqual({ added: [], removed: [], modified: [] })
    for (const rel of [PATHS.amendmentV101, PATHS.amendmentV102, PATHS.ownerV100, PATHS.ownerV101]) {
      const doc = readJson<Record<string, unknown>>(rel)
      expect(Object.keys(doc), rel).not.toContain('AUTHORIZED_OPERATIONS')
      expect(declaredOperationIds(doc), rel).toEqual([])
    }
  })

  it('the interpreter is driven by the artifact: dropping EA-F4 from the registry turns scenario A green', () => {
    const mutant = structuredClone(amendment)
    const a = mutant.SECTION_C4_EVENT_CLASS_REGISTRY.classes.EVENT_A_INITIAL_CORPUS
    a.required_facts = a.required_facts.filter((f) => f.id !== 'EA-F4')
    const input = validEventA()
    input.facts.pr201_execution_state = 'EXECUTED'
    expect(codeOf(evaluateWindow(amendment, input))).toBe('STOP_EVENT_A_PR201_EXECUTED')
    expect(evaluateWindow(mutant, input).verdict).toBe('POSTURE_APPLICABLE')
  })
})

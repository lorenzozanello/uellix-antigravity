// scripts/recovery/restore-proof.ts — the RESTORE_PROOF, exactly as frozen, and
// the offline rehearsal's own record
// (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-2/S-6).
//
// The RESTORE_PROOF class is frozen by STAGING_RELEASE_PRODUCTION_AUTHORITY
// EVIDENCE_PACKETS.packets[RESTORE_PROOF].contents — FIVE contents — and the
// recovery amendment v1.0.1 SECTION_A7 says every additionally required item
// is "a CONSTRAINED INSTANTIATION of one of these five, never a sixth field",
// with an explicit mapping this module follows verbatim:
//
//   (2) the target restored into      <- container identity (image, digest,
//                                        engine version, creation/destruction
//                                        timestamps) and the engine skew record
//   (4) post-restore verification ... <- PRI-7's storage-bytes declaration and
//                                        the governed-erasure statement
//
// The destruction of the restore container is its destruction TIMESTAMP plus
// the post-destruction absence check CL-1 names — content of (2). Everything
// that is NOT about this restore (the source fixture's destruction, the
// artifact's disposal, the rehearsal's own verdict) is not a RESTORE_PROOF
// content at all and travels in the separate OFFLINE_REHEARSAL_RECORD.

import { assertFrozen, frozenTopLevelProblems, packetArtifactSha256, packetSha256, validateBackupPacket, validateSourceCensusRecord, type BackupPacket, type SourceCensusRecord } from './artifact-packet'
import { CENSUS_SQL_SHA256 } from './catalog-census'
import { findForbiddenSubstrings, S, validateEvidence, type GrammarViolation, type Shape } from './evidence-privacy'
import { INVARIANT_RESULT_SHAPE, STORAGE_BYTES_DECLARATION, type InvariantResult } from './post-restore-invariants'
import { RESTORE_STEP_SHAPE, type RestoreOutcome, type RestoreStep } from './restore-runner'
import { DESTRUCTION_PROOF_SHAPE, type DestructionProof, type Substrate } from './substrate'
import { RECOVERY_TOOL_PIN } from './tool-pin'

export const RESTORED_FROM = 'the backup identifier restored from'
export const RESTORED_INTO = 'the target restored into'
export const RESTORE_TIMESTAMPS = 'timestamps for start and completion, which are what make a recovery time objective measurable'
export const VERIFICATION_RESULTS = 'post-restore verification results'
export const ROLL_FORWARD = 'the roll-forward performed afterwards and to which point'

export const RESTORE_PROOF_CONTENTS = [RESTORED_FROM, RESTORED_INTO, RESTORE_TIMESTAMPS, VERIFICATION_RESULTS, ROLL_FORWARD] as const
assertFrozen('RESTORE_PROOF', RESTORE_PROOF_CONTENTS)

export interface RestoreProof {
  'the backup identifier restored from': { content_digest: string; backup_packet_sha256: string }
  'the target restored into': {
    identity_class: 'LOCAL_DISPOSABLE'
    container_id: string
    image_ref_pinned: string
    image_id_observed: string | null
    network_mode_observed: string | null
    restore_database: string | null
    engine: { substrate_server_version_num: number | null; source_server_version_num: number; source_image_id_observed: string }
    created_at: string
    destruction: DestructionProof
  }
  'timestamps for start and completion, which are what make a recovery time objective measurable': { restore_started_at: string; restore_finished_at: string }
  'post-restore verification results': {
    invariants: InvariantResult[]
    census_sql_sha256: string
    storage_object_bytes: string
    governed_erasure_on_source: 'NOT_APPLICABLE_SYNTHETIC_FIXTURE' | 'UNKNOWN'
  }
  'the roll-forward performed afterwards and to which point': { performed: false; to_point: null; reason: 'D3_OUT_OF_SCOPE' }
}

const PROOF_CONTENT_SHAPES: Shape[] = [
  S.obj({ content_digest: S.str('image_id'), backup_packet_sha256: S.str('sha256') }),
  S.obj({
    identity_class: S.enm('LOCAL_DISPOSABLE'),
    container_id: S.str('docker_id'),
    image_ref_pinned: S.str('image_ref'),
    image_id_observed: S.opt(S.str('image_id')),
    network_mode_observed: S.opt(S.enm('none')),
    restore_database: S.opt(S.str('identifier')),
    engine: S.obj({ substrate_server_version_num: S.opt(S.int()), source_server_version_num: S.int(), source_image_id_observed: S.str('image_id') }),
    created_at: S.str('iso_timestamp'),
    destruction: DESTRUCTION_PROOF_SHAPE,
  }),
  S.obj({ restore_started_at: S.str('iso_timestamp'), restore_finished_at: S.str('iso_timestamp') }),
  S.obj({
    invariants: S.arr(INVARIANT_RESULT_SHAPE),
    census_sql_sha256: S.str('sha256'),
    storage_object_bytes: S.enm(STORAGE_BYTES_DECLARATION),
    governed_erasure_on_source: S.enm('NOT_APPLICABLE_SYNTHETIC_FIXTURE', 'UNKNOWN'),
  }),
  S.obj({ performed: S.bool(), to_point: S.opt(S.str('code')), reason: S.enm('D3_OUT_OF_SCOPE') }),
]

export const RESTORE_PROOF_SHAPE: Shape = S.obj(Object.fromEntries(RESTORE_PROOF_CONTENTS.map((c, i) => [c, PROOF_CONTENT_SHAPES[i]])))

export interface RestoreProofInput {
  packet: BackupPacket
  sourceCensus: SourceCensusRecord
  sourceSubstrate: Substrate
  restoreSubstrate: Substrate
  restore: RestoreOutcome
  invariants: InvariantResult[]
  restoreDestruction: DestructionProof
}

/** Pure. The ONLY place a RESTORE_PROOF is assembled. Key order = authority order. */
export function buildRestoreProof(i: RestoreProofInput): RestoreProof {
  return {
    'the backup identifier restored from': { content_digest: `sha256:${packetArtifactSha256(i.packet)}`, backup_packet_sha256: packetSha256(i.packet) },
    'the target restored into': {
      identity_class: 'LOCAL_DISPOSABLE',
      container_id: i.restoreSubstrate.identity.containerId,
      image_ref_pinned: RECOVERY_TOOL_PIN.imageRef,
      image_id_observed: i.restore.target_observation?.image_id ?? null,
      network_mode_observed: i.restore.target_observation?.network_mode ?? null,
      restore_database: i.restore.restore_database,
      engine: {
        substrate_server_version_num: i.restore.substrate_server_version_num,
        source_server_version_num: i.sourceCensus.census.server_version_num,
        source_image_id_observed: i.sourceSubstrate.observed.imageId,
      },
      created_at: i.restoreSubstrate.createdAt,
      destruction: i.restoreDestruction,
    },
    'timestamps for start and completion, which are what make a recovery time objective measurable': { restore_started_at: i.restore.restore_started_at, restore_finished_at: i.restore.restore_finished_at },
    'post-restore verification results': {
      invariants: i.invariants,
      census_sql_sha256: CENSUS_SQL_SHA256,
      storage_object_bytes: STORAGE_BYTES_DECLARATION,
      governed_erasure_on_source: i.sourceCensus.data_classification === 'SYNTHETIC_FIXTURE' ? 'NOT_APPLICABLE_SYNTHETIC_FIXTURE' : 'UNKNOWN',
    },
    'the roll-forward performed afterwards and to which point': { performed: false, to_point: null, reason: 'D3_OUT_OF_SCOPE' },
  }
}

export function validateRestoreProof(proof: unknown): GrammarViolation[] {
  const top = frozenTopLevelProblems(proof, RESTORE_PROOF_CONTENTS, 'restore_proof')
  if (top.length > 0) return top
  return validateEvidence(proof, RESTORE_PROOF_SHAPE, '$.restore_proof')
}

// ---------------------------------------------------------------------------
// The offline rehearsal's own record — NOT a frozen packet.
// ---------------------------------------------------------------------------

export type RehearsalVerdict = 'OFFLINE_REHEARSAL_PASS' | 'OFFLINE_REHEARSAL_FAIL'

export interface ArtifactDisposal {
  artifact_sha256: string | null
  disposed_at: string
  directory_absent: boolean
  verdict: 'DISPOSED_AND_VERIFIED_ABSENT' | 'DISPOSAL_NOT_PROVEN'
}

export interface RehearsalRecord {
  record_class: 'OFFLINE_REHEARSAL_RECORD'
  run_id: string
  capture_refusal: string | null
  /**
   * Unambiguous status of the restore the RESTORE_PROOF (if any) describes. The
   * frozen five RESTORE_PROOF contents have no status field and are not
   * enlarged; a proof of a REFUSED attempt is marked here, never by omission.
   */
  restore_outcome: 'RESTORED' | 'RESTORE_REFUSED' | 'NOT_ATTEMPTED'
  restore_refusal: string | null
  restore_steps: RestoreStep[]
  accepted_unknowns: string[]
  other_destructions: DestructionProof[]
  artifact_disposal: ArtifactDisposal
  verdict: RehearsalVerdict
  verdict_reasons: string[]
}

export const REHEARSAL_RECORD_SHAPE: Shape = S.obj({
  record_class: S.enm('OFFLINE_REHEARSAL_RECORD'),
  run_id: S.str('resource_name'),
  capture_refusal: S.opt(S.str('code')),
  restore_outcome: S.enm('RESTORED', 'RESTORE_REFUSED', 'NOT_ATTEMPTED'),
  restore_refusal: S.opt(S.str('code')),
  restore_steps: S.arr(RESTORE_STEP_SHAPE),
  accepted_unknowns: S.arr(S.str('fact')),
  other_destructions: S.arr(DESTRUCTION_PROOF_SHAPE),
  artifact_disposal: S.obj({
    artifact_sha256: S.opt(S.str('sha256')),
    disposed_at: S.str('iso_timestamp'),
    directory_absent: S.bool(),
    verdict: S.enm('DISPOSED_AND_VERIFIED_ABSENT', 'DISPOSAL_NOT_PROVEN'),
  }),
  verdict: S.enm('OFFLINE_REHEARSAL_PASS', 'OFFLINE_REHEARSAL_FAIL'),
  verdict_reasons: S.arr(S.str('code')),
})

/** Checks that would FAIL on an empty or non-working restore (EVIDENCE.negative_evidence_requirement). */
export const NEGATIVE_CAPABLE_CHECKS = ['PRI-5', 'PRI-2-CAP'] as const

export interface VerdictInput {
  captureOk: boolean
  restore: Pick<RestoreOutcome, 'ok'> | null
  invariants: ReadonlyArray<Pick<InvariantResult, 'id' | 'verdict'>>
  acceptedUnknowns: readonly string[]
  destruction: ReadonlyArray<Pick<DestructionProof, 'verdict'>>
  expectedDestructions: number
  artifactDisposed: boolean
}

/**
 * The rehearsal verdict. Pure. PASS requires EVERY one of: capture ok, restore
 * ok, a non-empty invariant set, every invariant PASS or an ACCEPTED UNKNOWN, at
 * least one negative-capable check PASS, every created substrate destroyed and
 * proven absent, the artifact disposed and proven absent.
 */
export function decideRehearsalVerdict(input: VerdictInput): { verdict: RehearsalVerdict; reasons: string[] } {
  const reasons: string[] = []
  if (!input.captureOk) reasons.push('CAPTURE_FAILED')
  if (!input.restore || !input.restore.ok) reasons.push('RESTORE_FAILED')
  if (input.invariants.length === 0) reasons.push('NO_INVARIANTS_EVALUATED')
  for (const r of input.invariants) {
    const code = r.id.replace(/-/g, '_')
    if (r.verdict === 'FAIL') reasons.push(`INVARIANT_FAIL_${code}`)
    if (r.verdict === 'UNKNOWN' && !input.acceptedUnknowns.includes(r.id)) reasons.push(`INVARIANT_UNKNOWN_NOT_ACCEPTED_${code}`)
  }
  if (!input.invariants.some((r) => (NEGATIVE_CAPABLE_CHECKS as readonly string[]).includes(r.id) && r.verdict === 'PASS')) reasons.push('NO_NEGATIVE_CAPABLE_CHECK_PASSED')
  if (input.destruction.length < input.expectedDestructions) reasons.push('SUBSTRATE_DESTRUCTION_MISSING')
  if (input.destruction.some((d) => d.verdict !== 'DESTROYED_AND_VERIFIED_ABSENT')) reasons.push('DESTRUCTION_NOT_PROVEN')
  if (!input.artifactDisposed) reasons.push('ARTIFACT_DISPOSAL_NOT_PROVEN')
  return { verdict: reasons.length === 0 ? 'OFFLINE_REHEARSAL_PASS' : 'OFFLINE_REHEARSAL_FAIL', reasons }
}

export interface EvidenceBundle {
  backup_packet: BackupPacket | null
  source_census_record: SourceCensusRecord | null
  restore_proof: RestoreProof | null
  rehearsal_record: RehearsalRecord
}

export interface FinalizeInput {
  runId: string
  packet: BackupPacket | null
  sourceCensus: SourceCensusRecord | null
  restoreProof: RestoreProof | null
  captureRefusal: string | null
  restore: RestoreOutcome | null
  invariants: InvariantResult[]
  acceptedUnknowns: string[]
  /** Every destruction the run performed, the restore target's included. */
  destructions: DestructionProof[]
  otherDestructions: DestructionProof[]
  expectedDestructions: number
  artifactDisposal: ArtifactDisposal
  setupRefusal: string | null
  /** Literal values that must appear NOWHERE in the evidence (substrate passwords). */
  secrets: string[]
}

/**
 * Pure. Decides the verdict, assembles the bundle, and applies the EVIDENCE
 * GATE: every document must pass its closed grammar (the packets their frozen
 * top-level contents too), the census record must be the one the packet is
 * bound to, and no secret may appear anywhere. A gate failure FAILS the run.
 */
export function finalizeRehearsal(f: FinalizeInput): { bundle: EvidenceBundle; evidenceViolations: GrammarViolation[]; forbiddenHits: number } {
  const decided = decideRehearsalVerdict({
    captureOk: f.packet !== null,
    restore: f.restore,
    invariants: f.invariants,
    acceptedUnknowns: f.acceptedUnknowns,
    destruction: f.destructions,
    expectedDestructions: f.expectedDestructions,
    artifactDisposed: f.artifactDisposal.verdict === 'DISPOSED_AND_VERIFIED_ABSENT',
  })
  const reasons = f.setupRefusal ? [f.setupRefusal, ...decided.reasons] : [...decided.reasons]
  const record: RehearsalRecord = {
    record_class: 'OFFLINE_REHEARSAL_RECORD',
    run_id: f.runId,
    capture_refusal: f.captureRefusal,
    restore_outcome: f.restore === null ? 'NOT_ATTEMPTED' : f.restore.ok ? 'RESTORED' : 'RESTORE_REFUSED',
    restore_refusal: f.restore?.refusal ?? null,
    restore_steps: f.restore?.steps ?? [],
    accepted_unknowns: [...f.acceptedUnknowns],
    other_destructions: f.otherDestructions,
    artifact_disposal: f.artifactDisposal,
    verdict: reasons.length === 0 ? 'OFFLINE_REHEARSAL_PASS' : 'OFFLINE_REHEARSAL_FAIL',
    verdict_reasons: reasons,
  }
  const bundle: EvidenceBundle = { backup_packet: f.packet, source_census_record: f.sourceCensus, restore_proof: f.restoreProof, rehearsal_record: record }

  const evidenceViolations: GrammarViolation[] = [
    ...validateEvidence(record, REHEARSAL_RECORD_SHAPE, '$.rehearsal_record'),
    ...(f.packet ? validateBackupPacket(f.packet) : []),
    ...(f.packet && f.sourceCensus ? validateSourceCensusRecord(f.sourceCensus, f.packet) : []),
    ...(f.packet && !f.sourceCensus ? [{ path: '$.source_census_record', problem: 'a packet without its bound census record' }] : []),
    ...(f.restoreProof ? validateRestoreProof(f.restoreProof) : []),
  ]
  const forbiddenHits = findForbiddenSubstrings(JSON.stringify(bundle), f.secrets).length
  if (evidenceViolations.length > 0 || forbiddenHits > 0) {
    record.verdict = 'OFFLINE_REHEARSAL_FAIL'
    if (evidenceViolations.length > 0) record.verdict_reasons.push('EVIDENCE_GRAMMAR_VIOLATION')
    if (forbiddenHits > 0) record.verdict_reasons.push('SECRET_IN_EVIDENCE')
  }
  return { bundle, evidenceViolations, forbiddenHits }
}

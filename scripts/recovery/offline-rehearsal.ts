// scripts/recovery/offline-rehearsal.ts — the disposable end-to-end rehearsal
// of the offline recovery mechanism
// (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-6; test manifest OR-P1).
//
//   pnpm exec tsx scripts/recovery/offline-rehearsal.ts [--json]
//
// SYNTHETIC SOURCE -> capture -> artifact OUTSIDE the repository -> disposable
// --network none substrate -> restore -> invariants -> destroy BOTH containers
// and their volumes -> dispose the artifact -> RESTORE_PROOF.
//
// ZERO HOSTED CONTACT. The source is a container this run starts from the pinned
// image and fills with tests/recovery/fixtures/*.sql (fabricated rows). Nothing
// here reads an environment variable naming a database, a token or a project.
//
// Teardown is in `finally`: every path after the first container exists funnels
// through destruction and artifact disposal, and a destruction that cannot be
// PROVEN makes the rehearsal FAIL — "A rehearsal that proves recovery and leaves
// a copy of staging data on a developer machine has traded one risk for another."
//
// The verdict is decided by `decideRehearsalVerdict`, a pure function: restore
// exit status is necessary and NEVER sufficient.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { packetSha256, validateBackupPacket, type BackupPacket, type DeclaredScope } from './artifact-packet'
import { checkArtifactLocation } from './artifact-integrity'
import { captureLogicalBackup, type CapturePrincipal, type CaptureOutcome } from './capture'
import { CENSUS_SQL_SHA256 } from './catalog-census'
import { findForbiddenSubstrings, S, validateEvidence, type Shape } from './evidence-privacy'
import { INVARIANT_RESULT_SHAPE, runPostRestoreInvariants, type CapabilityProbe, type InvariantResult } from './post-restore-invariants'
import { realDockerCli, type DockerCli } from './process'
import { RESTORE_STEP_SHAPE, restoreIntoSubstrate, type RestoreOutcome, type RestoreStep } from './restore-runner'
import { createSubstrate, destroySubstrate, DESTRUCTION_PROOF_SHAPE, newRunId, SubstrateRefusal, substratePsql, type DestructionProof, type Substrate } from './substrate'
import { RECOVERY_TOOL_PIN } from './tool-pin'

export type RehearsalVerdict = 'OFFLINE_REHEARSAL_PASS' | 'OFFLINE_REHEARSAL_FAIL'

export interface ArtifactDisposal {
  artifact_sha256: string | null
  disposed_at: string
  file_absent: boolean
  directory_absent: boolean
  verdict: 'DISPOSED_AND_VERIFIED_ABSENT' | 'DISPOSAL_NOT_PROVEN'
}

export interface RestoreProof {
  packet_class: 'RESTORE_PROOF'
  packet_version: '1.0.0'
  mechanism: 'STAGING_RECOVERY_OFFLINE_MECHANISM'
  run_id: string
  backup_identifier_restored_from: { artifact_sha256: string | null; backup_packet_sha256: string | null }
  target_restored_into: {
    identity_class: 'LOCAL_DISPOSABLE'
    container_id: string | null
    image_ref: string
    image_id: string
    network_mode: 'none'
    restore_database: string | null
  }
  timestamps: { restore_started_at: string | null; restore_finished_at: string | null }
  capture_refusal: string | null
  restore_refusal: string | null
  restore_steps: RestoreStep[]
  post_restore_verification: InvariantResult[]
  census_sql_sha256: string
  engine_versions: { source_server_version_num: number | null; substrate_server_version_num: number; source_image_build: 'SAME_PINNED_IMAGE_LOCAL_FIXTURE' }
  roll_forward: 'NOT_PERFORMED_D3_OUT_OF_SCOPE'
  storage_object_bytes: 'OUT_OF_SCOPE'
  governed_erasure_on_source: 'NOT_APPLICABLE_SYNTHETIC_FIXTURE'
  accepted_unknowns: string[]
  destruction: DestructionProof[]
  artifact_disposal: ArtifactDisposal
  verdict: RehearsalVerdict
  verdict_reasons: string[]
}

export const RESTORE_PROOF_SHAPE: Shape = S.obj({
  packet_class: S.enm('RESTORE_PROOF'),
  packet_version: S.enm('1.0.0'),
  mechanism: S.enm('STAGING_RECOVERY_OFFLINE_MECHANISM'),
  run_id: S.str('resource_name'),
  backup_identifier_restored_from: S.obj({ artifact_sha256: S.opt(S.str('sha256')), backup_packet_sha256: S.opt(S.str('sha256')) }),
  target_restored_into: S.obj({
    identity_class: S.enm('LOCAL_DISPOSABLE'),
    container_id: S.opt(S.str('docker_id')),
    image_ref: S.str('image_ref'),
    image_id: S.str('image_id'),
    network_mode: S.enm('none'),
    restore_database: S.opt(S.str('identifier')),
  }),
  timestamps: S.obj({ restore_started_at: S.opt(S.str('iso_timestamp')), restore_finished_at: S.opt(S.str('iso_timestamp')) }),
  capture_refusal: S.opt(S.str('code')),
  restore_refusal: S.opt(S.str('code')),
  restore_steps: S.arr(RESTORE_STEP_SHAPE),
  post_restore_verification: S.arr(INVARIANT_RESULT_SHAPE),
  census_sql_sha256: S.str('sha256'),
  engine_versions: S.obj({ source_server_version_num: S.opt(S.int()), substrate_server_version_num: S.int(), source_image_build: S.enm('SAME_PINNED_IMAGE_LOCAL_FIXTURE') }),
  roll_forward: S.enm('NOT_PERFORMED_D3_OUT_OF_SCOPE'),
  storage_object_bytes: S.enm('OUT_OF_SCOPE'),
  governed_erasure_on_source: S.enm('NOT_APPLICABLE_SYNTHETIC_FIXTURE'),
  accepted_unknowns: S.arr(S.str('fact')),
  destruction: S.arr(DESTRUCTION_PROOF_SHAPE),
  artifact_disposal: S.obj({
    artifact_sha256: S.opt(S.str('sha256')),
    disposed_at: S.str('iso_timestamp'),
    file_absent: S.bool(),
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

export interface OfflineRehearsalOptions {
  repoRoot: string
  fixtureRolesPath: string
  fixtureSourcePath: string
  /** db/baseline/stella_g2_post_restore.sql in the governed flow; null to rehearse WITHOUT it. */
  postRestoreCorpusPath: string | null
  scope: DeclaredScope
  principal: CapturePrincipal
  eventClass: string | null
  capabilityProbes: CapabilityProbe[]
  acceptedUnknowns: string[]
  artifactRoot?: string
  runId?: string
}

export interface OfflineRehearsalResult {
  packet: BackupPacket | null
  capture: CaptureOutcome | null
  proof: RestoreProof
  evidenceViolations: string[]
  forbiddenHits: number
}

export const SOURCE_DATABASE = 'fixture_src'

/** Build the synthetic source inside a source-fixture substrate (superuser, local socket). */
export function loadSyntheticSource(docker: DockerCli, source: Substrate, rolesPath: string, sourcePath: string): void {
  const steps: Array<[string, string]> = [
    ['postgres', `CREATE DATABASE ${SOURCE_DATABASE};\n`],
    [SOURCE_DATABASE, readFileSync(rolesPath, 'utf8')],
    [SOURCE_DATABASE, readFileSync(sourcePath, 'utf8')],
  ]
  for (const [db, sql] of steps) {
    const res = substratePsql(docker, source, db, sql)
    if (res.status !== 0) throw new Error(`SYNTHETIC_SOURCE_LOAD_FAILED (exit ${res.status})`)
  }
}

export function disposeArtifact(artifactDir: string | null, artifactSha256: string | null): ArtifactDisposal {
  if (artifactDir) rmSync(artifactDir, { recursive: true, force: true })
  const dirAbsent = artifactDir === null || !existsSync(artifactDir)
  return {
    artifact_sha256: artifactSha256,
    disposed_at: new Date().toISOString(),
    file_absent: dirAbsent,
    directory_absent: dirAbsent,
    verdict: dirAbsent ? 'DISPOSED_AND_VERIFIED_ABSENT' : 'DISPOSAL_NOT_PROVEN',
  }
}

export async function runOfflineRehearsal(docker: DockerCli, opts: OfflineRehearsalOptions): Promise<OfflineRehearsalResult> {
  const runId = opts.runId ?? newRunId()
  const root = opts.artifactRoot ?? tmpdir()
  const rootRefusal = checkArtifactLocation(path.resolve(root), opts.repoRoot)
  if (rootRefusal && !rootRefusal.ok) throw new Error(`REHEARSAL_ARTIFACT_ROOT_REFUSED: ${rootRefusal.code}`)
  const artifactDir = mkdtempSync(path.join(root, 'uellix-recovery-'))

  let source: Substrate | null = null
  let restoreSubstrate: Substrate | null = null
  let capture: CaptureOutcome | null = null
  let restore: RestoreOutcome | null = null
  let invariants: InvariantResult[] = []
  let substrateServerVersion = 0
  let setupRefusal: string | null = null
  const destruction: DestructionProof[] = []
  const secrets: string[] = []
  let disposal: ArtifactDisposal

  try {
    source = createSubstrate(docker, { runId, role: 'source-fixture' })
    secrets.push(source.password)
    loadSyntheticSource(docker, source, opts.fixtureRolesPath, opts.fixtureSourcePath)

    capture = await captureLogicalBackup(docker, {
      source: source.identity,
      database: SOURCE_DATABASE,
      principal: opts.principal,
      scope: opts.scope,
      eventClass: opts.eventClass,
      declaredClassification: 'SYNTHETIC_FIXTURE',
      artifactDir,
      repoRoot: opts.repoRoot,
    })

    if (capture.ok) {
      restoreSubstrate = createSubstrate(docker, { runId, role: 'restore-substrate' })
      secrets.push(restoreSubstrate.password)
      restore = await restoreIntoSubstrate(docker, {
        target: restoreSubstrate.identity,
        substrate: restoreSubstrate,
        packet: capture.packet,
        artifactPath: capture.artifactPath,
        repoRoot: opts.repoRoot,
        rolesCorpusPath: opts.fixtureRolesPath,
        postRestoreCorpusPath: opts.postRestoreCorpusPath,
      })
      const v = substratePsql(docker, restoreSubstrate, 'postgres', 'SHOW server_version_num;\n', ['-tA'])
      substrateServerVersion = /^\d+$/.test(v.stdout.trim()) ? Number(v.stdout.trim()) : 0
      if (restore.ok && restore.restore_database) {
        const run = runPostRestoreInvariants(docker, {
          substrate: restoreSubstrate,
          database: restore.restore_database,
          packet: capture.packet,
          restore,
          capabilityProbes: opts.capabilityProbes,
        })
        invariants = run.ok ? run.results : []
      }
    }
  } catch (error) {
    // A refusal before or during substrate creation still reaches teardown.
    setupRefusal = error instanceof SubstrateRefusal ? error.code : 'REHEARSAL_SETUP_FAILED'
    if (error instanceof SubstrateRefusal && error.partial) {
      if (!source) source = error.partial
      else if (!restoreSubstrate) restoreSubstrate = error.partial
    }
  } finally {
    for (const s of [restoreSubstrate, source]) if (s) destruction.push(destroySubstrate(docker, s))
    disposal = disposeArtifact(artifactDir, capture?.ok ? capture.packet.backup_identifier.artifact_sha256 : null)
  }

  const packet = capture?.ok ? capture.packet : null
  const expectedDestructions = (source ? 1 : 0) + (restoreSubstrate ? 1 : 0)
  const decided = decideRehearsalVerdict({
    captureOk: capture?.ok === true,
    restore,
    invariants,
    acceptedUnknowns: opts.acceptedUnknowns,
    destruction,
    expectedDestructions: Math.max(expectedDestructions, 1),
    artifactDisposed: disposal.verdict === 'DISPOSED_AND_VERIFIED_ABSENT',
  })
  const reasons = setupRefusal ? [setupRefusal, ...decided.reasons] : decided.reasons

  const proof: RestoreProof = {
    packet_class: 'RESTORE_PROOF',
    packet_version: '1.0.0',
    mechanism: 'STAGING_RECOVERY_OFFLINE_MECHANISM',
    run_id: runId,
    backup_identifier_restored_from: {
      artifact_sha256: packet ? packet.backup_identifier.artifact_sha256 : null,
      backup_packet_sha256: packet ? packetSha256(packet) : null,
    },
    target_restored_into: {
      identity_class: 'LOCAL_DISPOSABLE',
      container_id: restoreSubstrate?.identity.containerId || null,
      image_ref: RECOVERY_TOOL_PIN.imageRef,
      image_id: RECOVERY_TOOL_PIN.imageId,
      network_mode: 'none',
      restore_database: restore?.restore_database ?? null,
    },
    timestamps: { restore_started_at: restore?.restore_started_at ?? null, restore_finished_at: restore?.restore_finished_at ?? null },
    capture_refusal: capture && !capture.ok ? capture.code : null,
    restore_refusal: restore?.refusal ?? null,
    restore_steps: restore?.steps ?? [],
    post_restore_verification: invariants,
    census_sql_sha256: CENSUS_SQL_SHA256,
    engine_versions: {
      source_server_version_num: packet ? packet.source_census.server_version_num : null,
      substrate_server_version_num: substrateServerVersion,
      source_image_build: 'SAME_PINNED_IMAGE_LOCAL_FIXTURE',
    },
    roll_forward: 'NOT_PERFORMED_D3_OUT_OF_SCOPE',
    storage_object_bytes: 'OUT_OF_SCOPE',
    governed_erasure_on_source: 'NOT_APPLICABLE_SYNTHETIC_FIXTURE',
    accepted_unknowns: [...opts.acceptedUnknowns],
    destruction,
    artifact_disposal: disposal,
    verdict: reasons.length === 0 ? 'OFFLINE_REHEARSAL_PASS' : 'OFFLINE_REHEARSAL_FAIL',
    verdict_reasons: reasons,
  }

  // Evidence gate: both packets must pass the closed grammar, and no substrate
  // secret may appear anywhere in them. A violation FAILS the rehearsal.
  const violations = [...validateEvidence(proof, RESTORE_PROOF_SHAPE, '$.restore_proof'), ...(packet ? validateBackupPacket(packet) : [])]
  const serialized = JSON.stringify({ packet, proof })
  const forbiddenHits = findForbiddenSubstrings(serialized, secrets).length
  if (violations.length > 0 || forbiddenHits > 0) {
    proof.verdict = 'OFFLINE_REHEARSAL_FAIL'
    if (violations.length > 0) proof.verdict_reasons.push('EVIDENCE_GRAMMAR_VIOLATION')
    if (forbiddenHits > 0) proof.verdict_reasons.push('SECRET_IN_EVIDENCE')
  }
  return { packet, capture, proof, evidenceViolations: violations.map((v) => `${v.path}: ${v.problem}`), forbiddenHits }
}

// ---------------------------------------------------------------------------
// CLI — the synthetic fixture rehearsal, for an independent verifier to re-run.
// ---------------------------------------------------------------------------

export const FIXTURE_REHEARSAL: Omit<OfflineRehearsalOptions, 'repoRoot' | 'fixtureRolesPath' | 'fixtureSourcePath' | 'postRestoreCorpusPath'> = {
  scope: { schemas: ['public', 'uellix_provisioning'], excluded_relations: [], extensions: ['pg_trgm'], storage_object_bytes: 'OUT_OF_SCOPE' },
  principal: { roleName: 'recovery_capture_ro', provenance: 'LOCAL_DISPOSABLE_FIXTURE_ROLE' },
  eventClass: null,
  capabilityProbes: [{ role: 'fixture_capability', fn: 'public.fixture_capability_probe' }],
  // PRI-7: the fixture has no storage schema; the out-of-scope declaration is still emitted.
  acceptedUnknowns: ['PRI-7'],
}

export function fixturePaths(repoRoot: string) {
  return {
    fixtureRolesPath: path.join(repoRoot, 'tests/recovery/fixtures/recovery-fixture-roles.sql'),
    fixtureSourcePath: path.join(repoRoot, 'tests/recovery/fixtures/recovery-fixture-source.sql'),
    postRestoreCorpusPath: path.join(repoRoot, 'db/baseline/stella_g2_post_restore.sql'),
  }
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..')
  const result = await runOfflineRehearsal(realDockerCli, { repoRoot, ...fixturePaths(repoRoot), ...FIXTURE_REHEARSAL })
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ backup_packet: result.packet, restore_proof: result.proof }, null, 2))
  } else {
    console.log(`REHEARSAL_VERDICT=${result.proof.verdict}`)
    console.log(`VERDICT_REASONS=${result.proof.verdict_reasons.join(',') || 'NONE'}`)
    for (const r of result.proof.post_restore_verification) console.log(`INVARIANT ${r.id}=${r.verdict}${r.reason_code ? ` (${r.reason_code})` : ''}`)
    for (const d of result.proof.destruction) console.log(`DESTRUCTION ${d.role}=${d.verdict}`)
    console.log(`ARTIFACT_DISPOSAL=${result.proof.artifact_disposal.verdict}`)
    console.log(`EVIDENCE_GRAMMAR_VIOLATIONS=${result.evidenceViolations.length}`)
  }
  process.exit(result.proof.verdict === 'OFFLINE_REHEARSAL_PASS' ? 0 : 1)
}

const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/recovery/offline-rehearsal.ts')
if (invokedDirectly) void main()

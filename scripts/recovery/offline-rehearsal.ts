// scripts/recovery/offline-rehearsal.ts — the disposable end-to-end rehearsal
// of the offline recovery mechanism
// (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-6; test manifest OR-P1).
//
//   pnpm exec tsx scripts/recovery/offline-rehearsal.ts [--json]
//
// SYNTHETIC SOURCE -> capture -> artifact OUTSIDE the repository -> disposable
// --network none substrate -> restore -> invariants -> destroy BOTH containers
// and their volumes -> dispose the artifact -> evidence bundle:
//
//   backup_packet          BACKUP_PACKET, the six frozen contents exactly
//   source_census_record   the source observation the packet is bound to
//   restore_proof          RESTORE_PROOF, the five frozen contents exactly
//   rehearsal_record       this rehearsal's own verdict, cleanup and steps
//
// ZERO HOSTED CONTACT. The source is a container this run starts from the pinned
// image and fills with tests/recovery/fixtures/*.sql (fabricated rows). Nothing
// here reads an environment variable naming a database, a token or a project.
//
// Teardown is in `finally`: every path after the first container exists funnels
// through destruction and artifact disposal, and a destruction that cannot be
// PROVEN makes the rehearsal FAIL. The verdict and the evidence gate live in
// restore-proof.ts finalizeRehearsal, a pure function: restore exit status is
// necessary and NEVER sufficient.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type BackupPacket, type DeclaredScope, type SourceCensusRecord } from './artifact-packet'
import { checkArtifactLocation } from './artifact-integrity'
import { captureLogicalBackup, type CapturePrincipal, type CaptureOutcome } from './capture'
import type { GrammarViolation } from './evidence-privacy'
import { runPostRestoreInvariants, type CapabilityProbe, type InvariantResult } from './post-restore-invariants'
import { realDockerCli, runLocal, type DockerCli } from './process'
import { buildRestoreProof, finalizeRehearsal, type ArtifactDisposal, type EvidenceBundle, type RestoreProof } from './restore-proof'
import { restoreIntoSubstrate, type RestoreOutcome } from './restore-runner'
import { createSubstrate, destroySubstrate, newRunId, SubstrateRefusal, substratePsql, type DestructionProof, type Substrate } from './substrate'

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
  bundle: EvidenceBundle
  capture: CaptureOutcome | null
  evidenceViolations: GrammarViolation[]
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
    directory_absent: dirAbsent,
    verdict: dirAbsent ? 'DISPOSED_AND_VERIFIED_ABSENT' : 'DISPOSAL_NOT_PROVEN',
  }
}

/** FRESHNESS criterion 4: the SHA of the tooling — only when the tree is clean, else null (never a dirty SHA). */
export function measureToolingSha(repoRoot: string): string | null {
  const head = runLocal('git', ['rev-parse', 'HEAD'], repoRoot)
  const status = runLocal('git', ['status', '--porcelain', '--untracked-files=all'], repoRoot)
  const sha = head.stdout.trim()
  return head.status === 0 && status.status === 0 && status.stdout.trim() === '' && /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

export async function runOfflineRehearsal(docker: DockerCli, opts: OfflineRehearsalOptions): Promise<OfflineRehearsalResult> {
  const runId = opts.runId ?? newRunId()
  const root = opts.artifactRoot ?? tmpdir()
  const rootRefusal = checkArtifactLocation(path.resolve(root), opts.repoRoot)
  if (rootRefusal && !rootRefusal.ok) throw new Error(`REHEARSAL_ARTIFACT_ROOT_REFUSED: ${rootRefusal.code}`)
  const toolingSha = measureToolingSha(opts.repoRoot)
  const artifactDir = mkdtempSync(path.join(root, 'uellix-recovery-'))

  let source: Substrate | null = null
  let restoreSubstrate: Substrate | null = null
  let capture: CaptureOutcome | null = null
  let restore: RestoreOutcome | null = null
  let invariants: InvariantResult[] = []
  let setupRefusal: string | null = null
  let restoreDestruction: DestructionProof | null = null
  const otherDestructions: DestructionProof[] = []
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
      toolingSha,
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
        sourceCensus: capture.sourceCensus,
        artifactPath: capture.artifactPath,
        repoRoot: opts.repoRoot,
        rolesCorpusPath: opts.fixtureRolesPath,
        postRestoreCorpusPath: opts.postRestoreCorpusPath,
      })
      if (restore.ok && restore.restore_database) {
        const run = runPostRestoreInvariants(docker, {
          substrate: restoreSubstrate,
          database: restore.restore_database,
          packet: capture.packet,
          sourceCensus: capture.sourceCensus,
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
    if (restoreSubstrate) restoreDestruction = destroySubstrate(docker, restoreSubstrate)
    if (source) otherDestructions.push(destroySubstrate(docker, source))
    disposal = disposeArtifact(artifactDir, capture?.ok ? capture.packet['backup identifier'].content_digest.replace(/^sha256:/, '') : null)
  }

  const packet: BackupPacket | null = capture?.ok ? capture.packet : null
  const sourceCensus: SourceCensusRecord | null = capture?.ok ? capture.sourceCensus : null
  let restoreProof: RestoreProof | null = null
  if (packet && sourceCensus && source && restoreSubstrate && restore && restoreDestruction && restoreSubstrate.identity.containerId) {
    restoreProof = buildRestoreProof({ packet, sourceCensus, sourceSubstrate: source, restoreSubstrate, restore, invariants, restoreDestruction })
  }
  const destructions = [...(restoreDestruction ? [restoreDestruction] : []), ...otherDestructions]
  const finalized = finalizeRehearsal({
    runId,
    packet,
    sourceCensus,
    restoreProof,
    captureRefusal: capture && !capture.ok ? capture.code : null,
    restore,
    invariants,
    acceptedUnknowns: opts.acceptedUnknowns,
    destructions,
    otherDestructions,
    expectedDestructions: Math.max((source ? 1 : 0) + (restoreSubstrate ? 1 : 0), 1),
    artifactDisposal: disposal,
    setupRefusal,
    secrets,
  })
  return { bundle: finalized.bundle, capture, evidenceViolations: finalized.evidenceViolations, forbiddenHits: finalized.forbiddenHits }
}

// ---------------------------------------------------------------------------
// CLI — the synthetic fixture rehearsal, for an independent verifier to re-run.
// ---------------------------------------------------------------------------

export const FIXTURE_REHEARSAL: Omit<OfflineRehearsalOptions, 'repoRoot' | 'fixtureRolesPath' | 'fixtureSourcePath' | 'postRestoreCorpusPath'> = {
  scope: { schemas: ['public', 'uellix_provisioning'], excluded_relations: [], extensions: ['pg_trgm'] },
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
  const record = result.bundle.rehearsal_record
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result.bundle, null, 2))
  } else {
    console.log(`REHEARSAL_VERDICT=${record.verdict}`)
    console.log(`VERDICT_REASONS=${record.verdict_reasons.join(',') || 'NONE'}`)
    for (const r of result.bundle.restore_proof?.['post-restore verification results'].invariants ?? []) console.log(`INVARIANT ${r.id}=${r.verdict}${r.reason_code ? ` (${r.reason_code})` : ''}`)
    const target = result.bundle.restore_proof?.['the target restored into'].destruction
    if (target) console.log(`DESTRUCTION ${target.role}=${target.verdict}`)
    for (const d of record.other_destructions) console.log(`DESTRUCTION ${d.role}=${d.verdict}`)
    console.log(`ARTIFACT_DISPOSAL=${record.artifact_disposal.verdict}`)
    console.log(`EVIDENCE_GRAMMAR_VIOLATIONS=${result.evidenceViolations.length}`)
  }
  process.exit(record.verdict === 'OFFLINE_REHEARSAL_PASS' ? 0 : 1)
}

const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/recovery/offline-rehearsal.ts')
if (invokedDirectly) void main()

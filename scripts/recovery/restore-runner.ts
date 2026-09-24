// scripts/recovery/restore-runner.ts — the disposable local restore runner
// (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-4; authority RM-4,
// AO-5, AO-6, PRI-2, PRI-3).
//
// Restores ONE artifact into ONE substrate this run created, in this order:
//
//   target      the identity is LOCAL_DISPOSABLE, the container is the
//               restore-substrate this run labelled, pinned image, running,
//               network "none". A HOSTED identity is refused structurally —
//               the authority's AUTHORIZED_OPERATIONS never let a restore
//               touch anything but the disposable container. What inspect
//               REPORTS (image id, network mode) is kept as the observation.
//   binding     the source census record is the one the packet digests.
//   integrity   location + recomputed digest (artifact-integrity.ts).
//   structure   `pg_restore --list` fed the artifact: custom format, non-empty,
//               TABLE entries == bound census relations, header versions on the
//               pin. The digest of that pass covers the WHOLE file read to EOF
//               (pg_restore --list itself stops after the TOC) and must match.
//   tools       pg_restore version and substrate server version on the pin.
//   pristine    the cluster's roles are EXACTLY the pinned image baseline
//               (PRI-3: roles are cluster-scoped; a pre-existing application
//               role masks the first real failure).
//   roles       the roles corpus (digest recorded).
//   database    a fresh database.
//   selection   if the archive carries its own `SCHEMA - public`, a TOC list
//               without that one entry is written into the container and used
//               with `pg_restore -L` — non-destructive; the fresh database
//               keeps its own public (earlier versions DROPPED it; the recert
//               of ec573e9b found that act named nowhere in the authority).
//   restore     pg_restore --exit-on-error, fed the artifact; the sha256 of
//               the file read to EOF during THIS pass — whose prefix is
//               exactly what pg_restore received — must equal the packet
//               digest, so a change between or during passes is caught.
//   post        the post-restore corpus (db/baseline/stella_g2_post_restore.sql
//               for the RR-CAP-7 entries), digest recorded, or SKIPPED —
//               never silently absent.
//
// Exit status is recorded per step as a CLOSED outcome (exit code + diagnostic
// class; no stderr text, no stderr digest) and is NECESSARY, never SUFFICIENT:
// whether the restore WORKED is decided by post-restore-invariants.ts.

import { readFileSync } from 'node:fs'

import { NO_MUTATION_CONFIRMATION, packetArtifactSha256, type BackupPacket, type SourceCensusRecord } from './artifact-packet'
import { checkArchiveStructure, parseArchiveToc, selectTocForExistingPublic, verifyArtifactDigest } from './artifact-integrity'
import { censusSha256 } from './catalog-census'
import { classifyToolOutcome, S, TOOL_DIAGNOSTICS, type Shape, type ToolDiagnostic } from './evidence-privacy'
import { sha256Hex, type DockerCli } from './process'
import type { RecoveryIdentity } from './recovery-target'
import { assertSubstrateOwnership, SubstrateRefusal, SUBSTRATE_SUPERUSER, substratePsql, type Substrate } from './substrate'
import { evaluateToolPin, PINNED_IMAGE_BASELINE_ROLES, type ToolRefusal } from './tool-pin'

/** Where the selected TOC list lives INSIDE the disposable container (destroyed with it). */
export const IN_CONTAINER_TOC_LIST = '/tmp/uellix-recovery.toc'

export interface RestoreRequest {
  /** The identity the caller claims to restore into. Must be `substrate.identity`. */
  target: RecoveryIdentity
  substrate: Substrate
  packet: BackupPacket
  sourceCensus: SourceCensusRecord
  artifactPath: string
  repoRoot: string
  rolesCorpusPath: string
  /** null = deliberately skipped; recorded as SKIPPED in the outcome. */
  postRestoreCorpusPath: string | null
}

export type RestoreStepName = 'TOC' | 'ROLES_CORPUS' | 'CREATE_DATABASE' | 'TOC_SELECTION' | 'PG_RESTORE' | 'POST_RESTORE_CORPUS'

export interface RestoreStep {
  step: RestoreStepName
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED'
  exit_code: number | null
  diagnostic: ToolDiagnostic | null
  input_sha256: string | null
}

export type RestoreRefusalCode =
  | 'RESTORE_TARGET_NOT_DISPOSABLE'
  | 'RESTORE_TARGET_NOT_THE_SUBSTRATE'
  | 'RESTORE_TARGET_OWNERSHIP_REFUSED'
  | 'RESTORE_SOURCE_CENSUS_NOT_BOUND'
  | 'RESTORE_ARTIFACT_INTEGRITY_REFUSED'
  | 'RESTORE_ARTIFACT_STRUCTURE_REFUSED'
  | 'RESTORE_STREAM_DIGEST_MISMATCH'
  | 'RESTORE_TOOL_PIN_REFUSED'
  | 'RESTORE_SUBSTRATE_NOT_ROLE_PRISTINE'
  | 'RESTORE_STEP_FAILED'

export interface RestoreOutcome {
  ok: boolean
  refusal: RestoreRefusalCode | null
  refusal_detail: string | null
  restore_database: string | null
  restore_started_at: string
  restore_finished_at: string
  streamed_sha256: string | null
  steps: RestoreStep[]
  roles_at_start: string[]
  roles_after_restore: string[]
  tool_refusals: ToolRefusal[]
  /** What inspect REPORTED for the target at restore time; null if never reached. */
  target_observation: { image_id: string; network_mode: string } | null
  substrate_server_version_num: number | null
}

export const RESTORE_STEP_SHAPE: Shape = S.obj({
  step: S.enm('TOC', 'ROLES_CORPUS', 'CREATE_DATABASE', 'TOC_SELECTION', 'PG_RESTORE', 'POST_RESTORE_CORPUS'),
  status: S.enm('SUCCESS', 'FAILED', 'SKIPPED'),
  exit_code: S.opt(S.int()),
  diagnostic: S.opt(S.enm(...TOOL_DIAGNOSTICS)),
  input_sha256: S.opt(S.str('sha256')),
})

function rolesOf(docker: DockerCli, substrate: Substrate): string[] | null {
  const res = substratePsql(docker, substrate, 'postgres', 'SELECT rolname FROM pg_roles ORDER BY rolname;\n', ['-tA'])
  return res.status === 0 ? res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort() : null
}

/** Role-pristine = the cluster's roles are EXACTLY the pinned image baseline. Pure. */
export function rolePristineProblem(rolesAtStart: readonly string[], baseline: readonly string[] = PINNED_IMAGE_BASELINE_ROLES): string | null {
  const start = new Set(rolesAtStart)
  const base = new Set(baseline)
  const extra = [...start].filter((r) => !base.has(r))
  const missing = [...base].filter((r) => !start.has(r))
  if (extra.length > 0) return `${extra.length} role(s) beyond the pinned image baseline`
  if (missing.length > 0) return `${missing.length} baseline role(s) absent — not the pinned image`
  return null
}

export async function restoreIntoSubstrate(docker: DockerCli, req: RestoreRequest): Promise<RestoreOutcome> {
  const startedAt = new Date().toISOString()
  const steps: RestoreStep[] = []
  let rolesAtStart: string[] = []
  let rolesAfter: string[] = []
  let restoreDb: string | null = null
  let streamed: string | null = null
  let toolRefusals: ToolRefusal[] = []
  let targetObservation: RestoreOutcome['target_observation'] = null
  let substrateServer: number | null = null
  const digest = packetArtifactSha256(req.packet)

  const done = (refusal: RestoreRefusalCode | null, detail: string | null): RestoreOutcome => ({
    ok: refusal === null,
    refusal,
    refusal_detail: detail,
    restore_database: restoreDb,
    restore_started_at: startedAt,
    restore_finished_at: new Date().toISOString(),
    streamed_sha256: streamed,
    steps,
    roles_at_start: rolesAtStart,
    roles_after_restore: rolesAfter,
    tool_refusals: toolRefusals,
    target_observation: targetObservation,
    substrate_server_version_num: substrateServer,
  })
  const record = (step: RestoreStepName, exitCode: number | null, stderr: string, inputSha: string | null) => {
    const outcome = classifyToolOutcome(exitCode, stderr)
    steps.push({ step, status: outcome.exit_code === 0 ? 'SUCCESS' : 'FAILED', exit_code: outcome.exit_code, diagnostic: outcome.diagnostic, input_sha256: inputSha })
  }
  const skip = (step: RestoreStepName) => steps.push({ step, status: 'SKIPPED', exit_code: null, diagnostic: null, input_sha256: null })

  // Target.
  if (req.target.identityClass !== 'LOCAL_DISPOSABLE') return done('RESTORE_TARGET_NOT_DISPOSABLE', 'only a disposable substrate this run created may be restored into')
  if (req.target.containerId !== req.substrate.identity.containerId || req.target.runId !== req.substrate.identity.runId) {
    return done('RESTORE_TARGET_NOT_THE_SUBSTRATE', 'the claimed target is not the substrate handed to this restore')
  }
  const substrate = req.substrate
  try {
    const inspected = assertSubstrateOwnership(docker, req.target, 'restore-substrate')
    targetObservation = { image_id: inspected.Image, network_mode: inspected.HostConfig.NetworkMode }
  } catch (error) {
    return done('RESTORE_TARGET_OWNERSHIP_REFUSED', error instanceof SubstrateRefusal ? error.code : 'inspect failed')
  }

  // Binding: the census the invariants will judge by is the one the packet names.
  if (censusSha256(req.sourceCensus.census) !== req.packet[NO_MUTATION_CONFIRMATION].capture_census.pre_capture_census_sha256) {
    return done('RESTORE_SOURCE_CENSUS_NOT_BOUND', 'the source census record is not the one the packet digests')
  }

  // Integrity (location, recomputed digest).
  const integrity = await verifyArtifactDigest(req.packet, req.artifactPath, req.repoRoot)
  if (!integrity.ok) return done('RESTORE_ARTIFACT_INTEGRITY_REFUSED', integrity.code)

  // Structure: pg_restore --list over the streamed bytes.
  const cid = substrate.identity.containerId
  const toc = await docker.streamFromFile(['exec', '-i', cid, 'pg_restore', '--list'], req.artifactPath)
  record('TOC', toc.status, toc.stderr, toc.sha256)
  // The digest covers the WHOLE file as read in this pass (process.ts), not the
  // prefix pg_restore --list chose to consume; a pass that could not reach EOF
  // is not a digest of the artifact at all.
  if (toc.readError || toc.sha256 !== digest) return done('RESTORE_STREAM_DIGEST_MISMATCH', 'the artifact read during the TOC pass does not match the packet digest')
  if (toc.status !== 0) return done('RESTORE_ARTIFACT_STRUCTURE_REFUSED', 'ARTIFACT_TOC_UNREADABLE')
  const parsedToc = parseArchiveToc(toc.stdout)
  const structure = checkArchiveStructure(parsedToc, req.sourceCensus.census)
  if (structure && !structure.ok) return done('RESTORE_ARTIFACT_STRUCTURE_REFUSED', structure.code)

  // Tools.
  const restoreVersion = docker.run(['exec', cid, 'pg_restore', '--version'])
  const serverVersion = substratePsql(docker, substrate, 'postgres', 'SHOW server_version_num;\n', ['-tA'])
  substrateServer = serverVersion.status === 0 && /^\d+$/.test(serverVersion.stdout.trim()) ? Number(serverVersion.stdout.trim()) : null
  const pin = evaluateToolPin(
    {
      imageId: targetObservation.image_id,
      pgRestoreVersionLine: restoreVersion.status === 0 ? restoreVersion.stdout.split(/\r?\n/)[0] : null,
      substrateServerVersionNum: substrateServer,
      artifactDumpedBy: parsedToc.dumpedBy,
      artifactDumpedFrom: parsedToc.dumpedFrom,
    },
    ['imageId', 'pgRestoreVersionLine', 'substrateServerVersionNum', 'artifactDumpedBy', 'artifactDumpedFrom'],
  )
  if (!pin.ok) {
    toolRefusals = pin.refusals
    return done('RESTORE_TOOL_PIN_REFUSED', pin.refusals.map((r) => r.code).join(','))
  }

  // Role-pristine.
  const start = rolesOf(docker, substrate)
  if (start === null) return done('RESTORE_SUBSTRATE_NOT_ROLE_PRISTINE', 'role census failed')
  rolesAtStart = start
  const pristine = rolePristineProblem(start)
  if (pristine) return done('RESTORE_SUBSTRATE_NOT_ROLE_PRISTINE', pristine)

  // Roles corpus.
  const rolesSql = readFileSync(req.rolesCorpusPath, 'utf8')
  const roles = substratePsql(docker, substrate, 'postgres', rolesSql)
  record('ROLES_CORPUS', roles.status, roles.stderr, sha256Hex(rolesSql))
  if (roles.status !== 0) return done('RESTORE_STEP_FAILED', 'ROLES_CORPUS')

  // Fresh database.
  restoreDb = `recovery_restore_${substrate.identity.runId}`
  const created = substratePsql(docker, substrate, 'postgres', `CREATE DATABASE ${restoreDb};\n`)
  record('CREATE_DATABASE', created.status, created.stderr, null)
  if (created.status !== 0) return done('RESTORE_STEP_FAILED', 'CREATE_DATABASE')

  // TOC selection (non-destructive replacement for the former DROP SCHEMA public).
  let listArgs: string[] = []
  if (parsedToc.createsPublicSchema) {
    const selected = selectTocForExistingPublic(toc.stdout)
    const wrote = docker.run(['exec', '-i', cid, 'sh', '-c', `cat > ${IN_CONTAINER_TOC_LIST}`], selected.list)
    // Exactly one entry must be removed; anything else is a failed selection.
    record('TOC_SELECTION', selected.removed === 1 ? wrote.status : 1, wrote.stderr, sha256Hex(selected.list))
    if (wrote.status !== 0 || selected.removed !== 1) return done('RESTORE_STEP_FAILED', 'TOC_SELECTION')
    listArgs = ['-L', IN_CONTAINER_TOC_LIST]
  } else {
    skip('TOC_SELECTION')
  }

  // pg_restore.
  const restored = await runPgRestore(docker, substrate, restoreDb, req.artifactPath, listArgs)
  streamed = restored.sha256
  record('PG_RESTORE', restored.status, restored.stderr, restored.sha256)
  if (restored.readError || restored.sha256 !== digest) return done('RESTORE_STREAM_DIGEST_MISMATCH', 'the artifact read during the restore pass does not match the packet digest')
  if (restored.status !== 0) return done('RESTORE_STEP_FAILED', 'PG_RESTORE')

  // Post-restore corpus.
  if (req.postRestoreCorpusPath === null) {
    skip('POST_RESTORE_CORPUS')
  } else {
    const postSql = readFileSync(req.postRestoreCorpusPath, 'utf8')
    const post = substratePsql(docker, substrate, restoreDb, postSql)
    record('POST_RESTORE_CORPUS', post.status, post.stderr, sha256Hex(postSql))
    if (post.status !== 0) return done('RESTORE_STEP_FAILED', 'POST_RESTORE_CORPUS')
  }

  rolesAfter = rolesOf(docker, substrate) ?? []
  return done(null, null)
}

/**
 * One pg_restore invocation into `database` of the substrate, fed the artifact
 * on stdin. Exported so a test can drive a deliberately failing variant through
 * the SAME evidence path (stderr is classified, never retained).
 */
export function runPgRestore(docker: DockerCli, substrate: Substrate, database: string, artifactPath: string, extraArgs: string[]) {
  return docker.streamFromFile(['exec', '-i', substrate.identity.containerId, 'pg_restore', '-U', SUBSTRATE_SUPERUSER, '-d', database, '--exit-on-error', '--no-password', ...extraArgs], artifactPath)
}

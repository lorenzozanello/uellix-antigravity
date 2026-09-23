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
//               touch anything but the disposable container.
//   integrity   location + recomputed digest + size (artifact-integrity.ts).
//   structure   `pg_restore --list` of the streamed bytes: custom format,
//               non-empty, TABLE entries == captured relations, header versions
//               on the pin; the streamed digest must match as well.
//   tools       pg_restore version and substrate server version on the pin.
//   pristine    the cluster's roles are EXACTLY the pinned image baseline
//               (PRI-3: roles are cluster-scoped; a pre-existing application
//               role masks the first real failure).
//   roles       the roles corpus (digest recorded).
//   database    a fresh database; if the artifact carries its own
//               `SCHEMA - public` entry, the fresh database's EMPTY public is
//               dropped so the artifact alone defines it (measured: otherwise
//               pg_restore fails with "schema public already exists").
//   restore     pg_restore --exit-on-error, fed the artifact; the sha256 of
//               the bytes it actually received must equal the packet digest.
//   post        the post-restore corpus (db/baseline/stella_g2_post_restore.sql
//               for the RR-CAP-7 entries pg_dump does not emit), digest recorded,
//               or recorded as SKIPPED — never silently absent.
//
// Exit status is recorded per step and is NECESSARY, never SUFFICIENT: whether
// the restore WORKED is decided by post-restore-invariants.ts.

import { readFileSync } from 'node:fs'

import type { BackupPacket } from './artifact-packet'
import { checkArchiveStructure, parseArchiveToc, verifyArtifactDigest } from './artifact-integrity'
import { S, summarizeStderr, type Shape, type StderrSummary } from './evidence-privacy'
import { sha256Hex, type DockerCli } from './process'
import type { RecoveryIdentity } from './recovery-target'
import { assertSubstrateOwnership, SubstrateRefusal, SUBSTRATE_SUPERUSER, substratePsql, type Substrate } from './substrate'
import { evaluateToolPin, PINNED_IMAGE_BASELINE_ROLES, type ToolRefusal } from './tool-pin'

export interface RestoreRequest {
  /** The identity the caller claims to restore into. Must be `substrate.identity`. */
  target: RecoveryIdentity
  substrate: Substrate
  packet: BackupPacket
  artifactPath: string
  repoRoot: string
  rolesCorpusPath: string
  /** null = deliberately skipped; recorded as SKIPPED in the outcome. */
  postRestoreCorpusPath: string | null
  /** Receives raw tool stderr IN MEMORY for local diagnosis only. Never persisted by this module. */
  onDiagnostic?: (step: RestoreStepName, stderr: string) => void
}

export type RestoreStepName = 'TOC' | 'ROLES_CORPUS' | 'CREATE_DATABASE' | 'DROP_EMPTY_PUBLIC' | 'PG_RESTORE' | 'POST_RESTORE_CORPUS'

export interface RestoreStep extends StderrSummary {
  step: RestoreStepName
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED'
  exit_code: number | null
  input_sha256: string | null
}

export type RestoreRefusalCode =
  | 'RESTORE_TARGET_NOT_DISPOSABLE'
  | 'RESTORE_TARGET_NOT_THE_SUBSTRATE'
  | 'RESTORE_TARGET_OWNERSHIP_REFUSED'
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
}

export const RESTORE_STEP_SHAPE: Shape = S.obj({
  step: S.enm('TOC', 'ROLES_CORPUS', 'CREATE_DATABASE', 'DROP_EMPTY_PUBLIC', 'PG_RESTORE', 'POST_RESTORE_CORPUS'),
  status: S.enm('SUCCESS', 'FAILED', 'SKIPPED'),
  exit_code: S.opt(S.int()),
  input_sha256: S.opt(S.str('sha256')),
  stderr_sha256: S.str('sha256'),
  stderr_lines: S.int(),
  stderr_class: S.enm('EMPTY', 'NOTICE_ONLY', 'WARNING', 'ERROR', 'FATAL'),
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
  })
  const record = (step: RestoreStepName, status: RestoreStep['status'], exitCode: number | null, stderr: string, inputSha: string | null) => {
    if (stderr && req.onDiagnostic) req.onDiagnostic(step, stderr)
    steps.push({ step, status, exit_code: exitCode, input_sha256: inputSha, ...summarizeStderr(stderr) })
  }

  // Target.
  if (req.target.identityClass !== 'LOCAL_DISPOSABLE') return done('RESTORE_TARGET_NOT_DISPOSABLE', 'only a disposable substrate this run created may be restored into')
  if (req.target.containerId !== req.substrate.identity.containerId || req.target.runId !== req.substrate.identity.runId) {
    return done('RESTORE_TARGET_NOT_THE_SUBSTRATE', 'the claimed target is not the substrate handed to this restore')
  }
  const substrate = req.substrate
  try {
    assertSubstrateOwnership(docker, req.target, 'restore-substrate')
  } catch (error) {
    return done('RESTORE_TARGET_OWNERSHIP_REFUSED', error instanceof SubstrateRefusal ? error.code : 'inspect failed')
  }

  // Integrity (location, recomputed digest, size).
  const integrity = await verifyArtifactDigest(req.packet, req.artifactPath, req.repoRoot)
  if (!integrity.ok) return done('RESTORE_ARTIFACT_INTEGRITY_REFUSED', integrity.code)

  // Structure: pg_restore --list over the streamed bytes.
  const cid = substrate.identity.containerId
  const toc = await docker.streamFromFile(['exec', '-i', cid, 'pg_restore', '--list'], req.artifactPath)
  record('TOC', toc.status === 0 ? 'SUCCESS' : 'FAILED', toc.status, toc.stderr, toc.sha256)
  if (toc.sha256 !== req.packet.backup_identifier.artifact_sha256) return done('RESTORE_STREAM_DIGEST_MISMATCH', 'bytes streamed to pg_restore --list do not match the packet digest')
  if (toc.status !== 0) return done('RESTORE_ARTIFACT_STRUCTURE_REFUSED', 'ARTIFACT_TOC_UNREADABLE')
  const parsedToc = parseArchiveToc(toc.stdout)
  const structure = checkArchiveStructure(parsedToc, req.packet)
  if (structure && !structure.ok) return done('RESTORE_ARTIFACT_STRUCTURE_REFUSED', structure.code)

  // Tools.
  const restoreVersion = docker.run(['exec', cid, 'pg_restore', '--version'])
  const serverVersion = substratePsql(docker, substrate, 'postgres', 'SHOW server_version_num;\n', ['-tA'])
  const pin = evaluateToolPin(
    {
      imageId: substrate.identity.imageId,
      pgRestoreVersionLine: restoreVersion.status === 0 ? restoreVersion.stdout.split(/\r?\n/)[0] : null,
      substrateServerVersionNum: serverVersion.status === 0 && /^\d+$/.test(serverVersion.stdout.trim()) ? Number(serverVersion.stdout.trim()) : null,
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
  record('ROLES_CORPUS', roles.status === 0 ? 'SUCCESS' : 'FAILED', roles.status, roles.stderr, sha256Hex(rolesSql))
  if (roles.status !== 0) return done('RESTORE_STEP_FAILED', 'ROLES_CORPUS')

  // Fresh database.
  restoreDb = `recovery_restore_${substrate.identity.runId}`
  const created = substratePsql(docker, substrate, 'postgres', `CREATE DATABASE ${restoreDb};\n`)
  record('CREATE_DATABASE', created.status === 0 ? 'SUCCESS' : 'FAILED', created.status, created.stderr, null)
  if (created.status !== 0) return done('RESTORE_STEP_FAILED', 'CREATE_DATABASE')
  if (parsedToc.createsPublicSchema) {
    const dropped = substratePsql(docker, substrate, restoreDb, 'DROP SCHEMA public RESTRICT;\n')
    record('DROP_EMPTY_PUBLIC', dropped.status === 0 ? 'SUCCESS' : 'FAILED', dropped.status, dropped.stderr, null)
    if (dropped.status !== 0) return done('RESTORE_STEP_FAILED', 'DROP_EMPTY_PUBLIC')
  } else {
    record('DROP_EMPTY_PUBLIC', 'SKIPPED', null, '', null)
  }

  // pg_restore.
  const restored = await runPgRestore(docker, substrate, restoreDb, req.artifactPath, [])
  streamed = restored.sha256
  record('PG_RESTORE', restored.status === 0 ? 'SUCCESS' : 'FAILED', restored.status, restored.stderr, restored.sha256)
  if (restored.sha256 !== req.packet.backup_identifier.artifact_sha256) return done('RESTORE_STREAM_DIGEST_MISMATCH', 'bytes streamed to pg_restore do not match the packet digest')
  if (restored.status !== 0) return done('RESTORE_STEP_FAILED', 'PG_RESTORE')

  // Post-restore corpus.
  if (req.postRestoreCorpusPath === null) {
    record('POST_RESTORE_CORPUS', 'SKIPPED', null, '', null)
  } else {
    const postSql = readFileSync(req.postRestoreCorpusPath, 'utf8')
    const post = substratePsql(docker, substrate, restoreDb, postSql)
    record('POST_RESTORE_CORPUS', post.status === 0 ? 'SUCCESS' : 'FAILED', post.status, post.stderr, sha256Hex(postSql))
    if (post.status !== 0) return done('RESTORE_STEP_FAILED', 'POST_RESTORE_CORPUS')
  }

  rolesAfter = rolesOf(docker, substrate) ?? []
  return done(null, null)
}

/**
 * One pg_restore invocation into `database` of the substrate, fed the artifact
 * on stdin. Exported so a test can drive a deliberately failing variant through
 * the SAME evidence path (stderr is summarized, never retained as text).
 */
export function runPgRestore(docker: DockerCli, substrate: Substrate, database: string, artifactPath: string, extraArgs: string[]) {
  return docker.streamFromFile(['exec', '-i', substrate.identity.containerId, 'pg_restore', '-U', SUBSTRATE_SUPERUSER, '-d', database, '--exit-on-error', '--no-password', ...extraArgs], artifactPath)
}

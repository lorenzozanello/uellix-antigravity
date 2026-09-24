// scripts/recovery/substrate.ts — the disposable local PostgreSQL substrate and
// its destruction proof (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0,
// S-4 and S-6; authority RM-4, DP-1, DP-4, CL-1).
//
// ISOLATION IS ASSERTED, NOT ASSUMED. The container is created with
// `--network none`, and then `docker inspect` must independently report
// NetworkMode "none" and no network other than "none" BEFORE any byte of an
// artifact is streamed in. A creation flag is a statement of intent; the
// inspected state is the fact.
//
// THE VOLUME IS NAMED, LABELLED AND RECORDED. The pinned image declares no
// VOLUME (measured: inspect .Mounts = []), so without a mount the restored data
// would sit in the container's writable layer. It is instead placed on a volume
// this run creates, named and labelled with the run id, so that its destruction
// is PROVABLE by name and by label. Any other volume the container carries
// (an anonymous one from an image that does declare VOLUME) is recorded from
// inspect as well and must also be gone afterwards.
//
// THE PRECEDENT WEAKNESS THIS CORRECTS. scripts/baseline-rehearsal-local.ts
// destroys with `docker rm -f` and no `-v`, so an anonymous volume outlives the
// container. `-v` alone is still not enough here: it removes ANONYMOUS volumes
// only, and a NAMED volume survives `docker rm -f -v` (measured in the e2e
// calibration). Destruction is therefore rm -f -v, then docker volume rm of every
// recorded named volume, then absence checks by id AND by label.
//
// SCOPE OF EVERY DESTRUCTIVE CALL. Only ids and names this run recorded, and only
// objects carrying this run's label. Never prune, never a filter wider than the
// run label. The canonical local Supabase stack is not reachable from here.

import { randomBytes } from 'node:crypto'

import { probeServingPostmaster, type ProcessResult } from '../db-audit-disposable'
import { classifyToolOutcome, S, TOOL_OUTCOME_SHAPE, type Shape, type ToolOutcome } from './evidence-privacy'
import type { DockerCli } from './process'
import type { LocalDisposableIdentity, SubstrateRole } from './recovery-target'
import { RECOVERY_TOOL_PIN, type RecoveryToolPin } from './tool-pin'

export const RUN_LABEL = 'uellix.recovery.run'
export const ROLE_LABEL = 'uellix.recovery.role'
/** Unique per substrate (its container name), so absence is proven for THIS substrate even when a run creates two of one role. */
export const SUBSTRATE_LABEL = 'uellix.recovery.substrate'
export const PGDATA = '/var/lib/postgresql/data'
/** The in-container superuser of the pinned image (local socket, trust). */
export const SUBSTRATE_SUPERUSER = 'supabase_admin'

const RUN_ID = /^[a-z0-9]{8,32}$/

export function newRunId(): string {
  return randomBytes(8).toString('hex')
}

export interface Substrate {
  identity: LocalDisposableIdentity
  /** The volume this run created for PGDATA. */
  namedVolume: string
  /** Every volume inspect reported on the container, named or anonymous. */
  recordedVolumes: Array<{ name: string; kind: 'named' | 'anonymous' }>
  createdAt: string
  /** What `docker inspect` REPORTED after creation — observations, not the pin restated. */
  observed: { imageId: string; networkMode: string }
  /** Throwaway; never persisted, never in argv. Held only so evidence can be scanned for it. */
  password: string
}

export type SubstrateRefusalCode =
  | 'SUBSTRATE_RUN_ID_INVALID'
  | 'SUBSTRATE_IMAGE_NOT_PINNED'
  | 'SUBSTRATE_VOLUME_CREATE_FAILED'
  | 'SUBSTRATE_CREATE_FAILED'
  | 'SUBSTRATE_INSPECT_FAILED'
  | 'SUBSTRATE_NETWORK_NOT_ISOLATED'
  | 'SUBSTRATE_BIND_MOUNT_PRESENT'
  | 'SUBSTRATE_PGDATA_NOT_ON_RUN_VOLUME'
  | 'SUBSTRATE_NOT_OWNED_BY_RUN'
  | 'SUBSTRATE_NOT_RUNNING'
  | 'SUBSTRATE_NEVER_READY'

export class SubstrateRefusal extends Error {
  constructor(
    readonly code: SubstrateRefusalCode,
    detail: string,
    /** Set when a container WAS created, so the caller's finally can still destroy it. */
    readonly partial?: Substrate,
  ) {
    super(`${code}: ${detail}`)
  }
}

interface InspectedContainer {
  Id: string
  Name: string
  Image: string
  State: { Running: boolean }
  Config: { Labels: Record<string, string> | null }
  HostConfig: { NetworkMode: string }
  NetworkSettings: { Networks: Record<string, unknown> | null }
  Mounts: Array<{ Type: string; Name?: string; Destination: string }>
}

export function inspectContainer(docker: DockerCli, ref: string): InspectedContainer | null {
  // `--type container` so a volume or image sharing the name is never matched.
  const res = docker.run(['inspect', '--type', 'container', ref])
  if (res.status !== 0) return null
  try {
    const parsed = JSON.parse(res.stdout) as InspectedContainer[]
    return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null
  } catch {
    return null
  }
}

/**
 * DP-1: the inspected network state is "none" and only "none". Pure over an
 * inspect record so the refusal is testable without a daemon.
 */
export function networkIsolationProblem(c: Pick<InspectedContainer, 'HostConfig' | 'NetworkSettings'>): string | null {
  if (c.HostConfig?.NetworkMode !== 'none') return `NetworkMode is ${JSON.stringify(c.HostConfig?.NetworkMode)}, not "none"`
  const networks = Object.keys(c.NetworkSettings?.Networks ?? {})
  if (networks.length !== 1 || networks[0] !== 'none') return `attached networks are [${networks.join(', ')}], not exactly [none]`
  return null
}

/**
 * The container must be one THIS run created for THIS purpose: same full id,
 * same run label, same role label, pinned image, running, isolated.
 */
export function assertSubstrateOwnership(docker: DockerCli, identity: LocalDisposableIdentity, expectedRole: SubstrateRole, pin: RecoveryToolPin = RECOVERY_TOOL_PIN): InspectedContainer {
  const c = inspectContainer(docker, identity.containerId)
  if (!c) throw new SubstrateRefusal('SUBSTRATE_INSPECT_FAILED', 'the recorded container id does not resolve to a container')
  const labels = c.Config?.Labels ?? {}
  if (c.Id !== identity.containerId || labels[RUN_LABEL] !== identity.runId || labels[ROLE_LABEL] !== expectedRole || identity.role !== expectedRole) {
    throw new SubstrateRefusal('SUBSTRATE_NOT_OWNED_BY_RUN', `container is not the ${expectedRole} this run created`)
  }
  if (c.Image !== pin.imageId || identity.imageId !== pin.imageId) throw new SubstrateRefusal('SUBSTRATE_IMAGE_NOT_PINNED', 'container image id is not the recovery pin')
  if (!c.State?.Running) throw new SubstrateRefusal('SUBSTRATE_NOT_RUNNING', 'container is not running')
  const net = networkIsolationProblem(c)
  if (net) throw new SubstrateRefusal('SUBSTRATE_NETWORK_NOT_ISOLATED', net)
  return c
}

export function localImageId(docker: DockerCli, imageRef: string): string | null {
  const res = docker.run(['image', 'inspect', '-f', '{{.Id}}', imageRef])
  return res.status === 0 ? res.stdout.trim() : null
}

export interface CreateSubstrateOptions {
  runId: string
  role: SubstrateRole
  pin?: RecoveryToolPin
  readyAttempts?: number
  sleepMs?: (ms: number) => void
}

const busySleep = (ms: number) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* readiness polling only */
  }
}

/** Create, isolate, verify and wait for a disposable substrate. Throws SubstrateRefusal. */
export function createSubstrate(docker: DockerCli, options: CreateSubstrateOptions): Substrate {
  const pin = options.pin ?? RECOVERY_TOOL_PIN
  if (!RUN_ID.test(options.runId)) throw new SubstrateRefusal('SUBSTRATE_RUN_ID_INVALID', 'run id must be 8-32 lowercase alphanumerics')
  const imageId = localImageId(docker, pin.imageRef)
  if (imageId !== pin.imageId) throw new SubstrateRefusal('SUBSTRATE_IMAGE_NOT_PINNED', `local image for ${pin.imageRef} is not ${pin.imageId}`)

  const suffix = randomBytes(4).toString('hex')
  const containerName = `uellix-recovery-${options.role}-${options.runId}-${suffix}`
  const namedVolume = `uellix-recovery-vol-${options.runId}-${suffix}`
  const labels = ['--label', `${RUN_LABEL}=${options.runId}`, '--label', `${ROLE_LABEL}=${options.role}`, '--label', `${SUBSTRATE_LABEL}=${containerName}`]

  const vol = docker.run(['volume', 'create', ...labels, namedVolume])
  if (vol.status !== 0) throw new SubstrateRefusal('SUBSTRATE_VOLUME_CREATE_FAILED', summarizeText(vol))

  const password = randomBytes(24).toString('hex')
  const created = docker.runWithEnv(
    [
      'run',
      '-d',
      '--name',
      containerName,
      ...labels,
      '--network',
      'none',
      '--mount',
      `type=volume,src=${namedVolume},dst=${PGDATA}`,
      // Value comes from the docker CLI's environment, never from argv.
      '-e',
      'POSTGRES_PASSWORD',
      pin.imageId,
    ],
    { POSTGRES_PASSWORD: password },
  )
  const createdAt = new Date().toISOString()
  const partialBase: Substrate = {
    identity: { identityClass: 'LOCAL_DISPOSABLE', containerId: '', containerName, runId: options.runId, role: options.role, imageId },
    namedVolume,
    recordedVolumes: [{ name: namedVolume, kind: 'named' }],
    createdAt,
    observed: { imageId: '', networkMode: '' },
    password,
  }
  if (created.status !== 0) {
    throw new SubstrateRefusal('SUBSTRATE_CREATE_FAILED', summarizeText(created, password), partialBase)
  }
  const containerId = created.stdout.trim()
  const substrate: Substrate = { ...partialBase, identity: { ...partialBase.identity, containerId } }

  const c = inspectContainer(docker, containerId)
  if (!c) throw new SubstrateRefusal('SUBSTRATE_INSPECT_FAILED', 'freshly created container did not inspect', substrate)
  substrate.recordedVolumes = recordVolumes(c, namedVolume)
  substrate.observed = { imageId: c.Image, networkMode: c.HostConfig?.NetworkMode ?? '' }
  if (c.Mounts.some((m) => m.Type !== 'volume')) throw new SubstrateRefusal('SUBSTRATE_BIND_MOUNT_PRESENT', 'a non-volume mount is present', substrate)
  if (!c.Mounts.some((m) => m.Type === 'volume' && m.Name === namedVolume && m.Destination === PGDATA)) {
    throw new SubstrateRefusal('SUBSTRATE_PGDATA_NOT_ON_RUN_VOLUME', 'PGDATA is not on the run volume', substrate)
  }
  try {
    assertSubstrateOwnership(docker, substrate.identity, options.role, pin)
  } catch (error) {
    if (error instanceof SubstrateRefusal) throw new SubstrateRefusal(error.code, error.message, substrate)
    throw error
  }

  const attempts = options.readyAttempts ?? 120
  const sleep = options.sleepMs ?? busySleep
  let reason = 'no readiness attempt was made'
  for (let i = 0; i < attempts; i++) {
    const probe = probeServingPostmaster(docker, containerId, (runner, container) =>
      runner.run(['exec', container, 'psql', '-X', '-U', SUBSTRATE_SUPERUSER, '-d', 'postgres', '-tAc', 'SELECT 1']),
    )
    if (probe.ready) return substrate
    reason = probe.reason
    sleep(500)
  }
  throw new SubstrateRefusal('SUBSTRATE_NEVER_READY', reason, substrate)
}

function recordVolumes(c: InspectedContainer, namedVolume: string): Substrate['recordedVolumes'] {
  const out: Substrate['recordedVolumes'] = [{ name: namedVolume, kind: 'named' }]
  for (const m of c.Mounts) {
    if (m.Type === 'volume' && m.Name && m.Name !== namedVolume) out.push({ name: m.Name, kind: 'anonymous' })
  }
  return out
}

function summarizeText(res: ProcessResult, secret?: string): string {
  const text = (res.stderr || res.stdout).trim()
  return secret ? text.split(secret).join('[REDACTED]') : text
}

/** psql inside the substrate as its superuser over the local socket. */
export function substratePsql(docker: DockerCli, substrate: Substrate, database: string, sql: string, extra: string[] = []): ProcessResult {
  return docker.run(['exec', '-i', substrate.identity.containerId, 'psql', '-X', '-U', SUBSTRATE_SUPERUSER, '-d', database, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-q', ...extra], sql)
}

export interface DestructionProof {
  container_id: string | null
  run_id: string
  role: SubstrateRole
  created_at: string
  destroyed_at: string
  container_remove: ToolOutcome
  volumes: Array<{ name: string; kind: 'named' | 'anonymous'; remove_exit_code: number | null; absent: boolean }>
  container_absent_by_id: boolean
  containers_remaining_with_substrate_label: number
  volumes_remaining_with_substrate_label: number
  verdict: 'DESTROYED_AND_VERIFIED_ABSENT' | 'DESTRUCTION_NOT_PROVEN'
}

export const DESTRUCTION_PROOF_SHAPE: Shape = S.obj({
  container_id: S.opt(S.str('docker_id')),
  run_id: S.str('resource_name'),
  role: S.enm('source-fixture', 'restore-substrate'),
  created_at: S.str('iso_timestamp'),
  destroyed_at: S.str('iso_timestamp'),
  container_remove: TOOL_OUTCOME_SHAPE,
  volumes: S.arr(S.obj({ name: S.str('resource_name'), kind: S.enm('named', 'anonymous'), remove_exit_code: S.opt(S.int()), absent: S.bool() })),
  container_absent_by_id: S.bool(),
  containers_remaining_with_substrate_label: S.int(),
  volumes_remaining_with_substrate_label: S.int(),
  verdict: S.enm('DESTROYED_AND_VERIFIED_ABSENT', 'DESTRUCTION_NOT_PROVEN'),
})

/**
 * CL-1 / DP-4. Destroy the container WITH its anonymous volumes, then every
 * recorded named volume, then prove absence three ways. Never throws: a
 * destruction that cannot be proven is a FAILED proof, reported, not swallowed.
 */
export function destroySubstrate(docker: DockerCli, substrate: Substrate): DestructionProof {
  const { containerId, runId, role } = substrate.identity
  const target = containerId || substrate.identity.containerName
  const removed = docker.run(['rm', '-f', '-v', target])

  const volumes = substrate.recordedVolumes.map((v) => {
    let removeExit: number | null = null
    if (v.kind === 'named') removeExit = docker.run(['volume', 'rm', v.name]).status
    const absent = docker.run(['volume', 'inspect', v.name]).status !== 0
    return { name: v.name, kind: v.kind, remove_exit_code: removeExit, absent }
  })

  const byId = docker.run(['ps', '-a', '-q', '--no-trunc', '--filter', `name=^${substrate.identity.containerName}$`])
  const containerAbsent = byId.status === 0 && byId.stdout.trim() === '' && inspectContainer(docker, target) === null
  const byLabel = docker.run(['ps', '-a', '-q', '--filter', `label=${RUN_LABEL}=${runId}`, '--filter', `label=${SUBSTRATE_LABEL}=${substrate.identity.containerName}`])
  const containersRemaining = byLabel.status === 0 ? byLabel.stdout.split(/\s+/).filter(Boolean).length : 1
  const volsByLabel = docker.run(['volume', 'ls', '-q', '--filter', `label=${RUN_LABEL}=${runId}`, '--filter', `label=${SUBSTRATE_LABEL}=${substrate.identity.containerName}`])
  const volumesRemaining = volsByLabel.status === 0 ? volsByLabel.stdout.split(/\s+/).filter(Boolean).length : 1

  const proven = containerAbsent && containersRemaining === 0 && volumesRemaining === 0 && volumes.length > 0 && volumes.every((v) => v.absent)
  return {
    container_id: containerId || null,
    run_id: runId,
    role,
    created_at: substrate.createdAt,
    destroyed_at: new Date().toISOString(),
    container_remove: classifyToolOutcome(removed.status, removed.stderr),
    volumes,
    container_absent_by_id: containerAbsent,
    containers_remaining_with_substrate_label: containersRemaining,
    volumes_remaining_with_substrate_label: volumesRemaining,
    verdict: proven ? 'DESTROYED_AND_VERIFIED_ABSENT' : 'DESTRUCTION_NOT_PROVEN',
  }
}

// tests/recovery/fake-docker.ts — an in-memory docker for the recovery unit tests.
//
// It models ONLY the semantics the destruction proof depends on, and those
// semantics are CALIBRATED against the real daemon by
// tests/postgres/recovery-offline.pg.test.ts ("docker volume semantics"):
//
//   - `rm -f <c>` removes the container and nothing else;
//   - `rm -f -v <c>` also removes the container's ANONYMOUS volumes;
//   - a NAMED volume survives both and needs `volume rm`;
//   - `volume inspect <v>` exits non-zero once the volume is gone.
//
// Knobs let a test make the fake misbehave the way a real failure would
// (a volume that cannot be removed, a network mode that is not "none").

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import type { DockerCli, ProcessResult, StreamHooks, StreamInResult, StreamOutResult } from '../../scripts/recovery/process'

interface FakeVolume {
  name: string
  labels: Record<string, string>
  anonymous: boolean
}

interface FakeContainer {
  id: string
  name: string
  image: string
  labels: Record<string, string>
  networkMode: string
  networks: string[]
  running: boolean
  volumes: string[]
  mountPgdataOn: string | null
}

export interface FakeDockerOptions {
  imageIds?: Record<string, string>
  /** Force every created container's NetworkMode (simulates a flag that did not take). */
  forceNetworkMode?: string
  /** Give every created container one extra anonymous volume (an image that declares VOLUME). */
  anonymousVolumePerContainer?: boolean
  /** `volume rm` of these names fails. */
  undeletableVolumes?: string[]
  /** `rm` ignores `-v` (simulates the precedent `docker rm -f` without -v). */
  rmIgnoresV?: boolean
  exec?: (containerId: string, argv: string[], input?: string) => ProcessResult
  /** Bytes a streamed `docker exec ... pg_dump` writes to the artifact file. */
  dumpBytes?: Buffer
  /** Called BEFORE a streamFromFile reads the file — lets a test change bytes mid-flight. */
  onStream?: (args: string[], filePath: string, callIndex: number) => void
  /** stdout/status of a streamFromFile call (default: status 0, empty stdout). */
  streamResult?: (args: string[]) => { status: number; stdout: string; stderr?: string }
}

const ok = (stdout = ''): ProcessResult => ({ status: 0, stdout, stderr: '' })
const fail = (stderr = 'error'): ProcessResult => ({ status: 1, stdout: '', stderr })

export class FakeDocker implements DockerCli {
  readonly calls: string[][] = []
  readonly envCalls: Array<Record<string, string>> = []
  volumes = new Map<string, FakeVolume>()
  containers = new Map<string, FakeContainer>()
  private seq = 0

  constructor(private readonly opts: FakeDockerOptions = {}) {}

  addContainer(c: Partial<FakeContainer> & { name: string }): FakeContainer {
    const id = (c.id ?? `${(++this.seq).toString(16)}`).padStart(64, 'a')
    const container: FakeContainer = {
      id,
      name: c.name,
      image: c.image ?? 'sha256:' + '0'.repeat(64),
      labels: c.labels ?? {},
      networkMode: c.networkMode ?? 'none',
      networks: c.networks ?? ['none'],
      running: c.running ?? true,
      volumes: c.volumes ?? [],
      mountPgdataOn: c.mountPgdataOn ?? null,
    }
    this.containers.set(id, container)
    return container
  }

  private find(ref: string): FakeContainer | undefined {
    return this.containers.get(ref) ?? [...this.containers.values()].find((c) => c.name === ref)
  }

  runWithEnv(args: string[], env: Record<string, string>): ProcessResult {
    this.envCalls.push(env)
    return this.run(args)
  }

  readonly streamCalls: string[][] = []

  /** Writes the configured dump bytes; the digest is of the bytes written, as in the real CLI. */
  async streamToFile(args: string[], filePath: string): Promise<StreamOutResult> {
    this.calls.push(args)
    if (!this.opts.dumpBytes) throw new Error('FakeDocker.streamToFile: no dumpBytes configured')
    writeFileSync(filePath, this.opts.dumpBytes, { flag: 'wx' })
    return { status: 0, stderr: '', sha256: createHash('sha256').update(this.opts.dumpBytes).digest('hex'), bytes: this.opts.dumpBytes.length, writeError: false }
  }

  /** Reads the file AT STREAM TIME and hashes exactly what it read — a behavioral oracle for streaming integrity. */
  async streamFromFile(args: string[], filePath: string, hooks: StreamHooks = {}): Promise<StreamInResult> {
    this.calls.push(args)
    this.streamCalls.push(args)
    this.opts.onStream?.(args, filePath, this.streamCalls.length - 1)
    const bytes = readFileSync(filePath)
    hooks.afterChunk?.(bytes.length)
    const r = this.opts.streamResult?.(args) ?? { status: 0, stdout: '' }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr ?? '', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, deliveredBytes: bytes.length, consumerClosedEarly: false, readError: false }
  }

  run(args: string[], input?: string): ProcessResult {
    this.calls.push(args)
    const [cmd, ...rest] = args
    if (cmd === 'image' && rest[0] === 'inspect') {
      const id = this.opts.imageIds?.[rest[rest.length - 1]]
      return id ? ok(`${id}\n`) : fail('No such image')
    }
    if (cmd === 'volume') return this.volume(rest)
    if (cmd === 'run') return this.create(rest)
    if (cmd === 'inspect') {
      const c = this.find(rest[rest.length - 1])
      if (!c) return fail('No such container')
      return ok(
        JSON.stringify([
          {
            Id: c.id,
            Name: `/${c.name}`,
            Image: c.image,
            State: { Running: c.running },
            Config: { Labels: c.labels },
            HostConfig: { NetworkMode: c.networkMode },
            NetworkSettings: { Networks: Object.fromEntries(c.networks.map((n) => [n, {}])) },
            Mounts: c.volumes.map((v) => ({ Type: 'volume', Name: v, Destination: v === c.mountPgdataOn ? '/var/lib/postgresql/data' : '/anon' })),
          },
        ]),
      )
    }
    if (cmd === 'rm') {
      const withV = rest.includes('-v') && !this.opts.rmIgnoresV
      const c = this.find(rest[rest.length - 1])
      if (!c) return fail('No such container')
      this.containers.delete(c.id)
      if (withV) for (const v of c.volumes) if (this.volumes.get(v)?.anonymous) this.volumes.delete(v)
      return ok(`${c.id}\n`)
    }
    if (cmd === 'ps') {
      const filters = rest.flatMap((a, i) => (rest[i - 1] === '--filter' ? [a] : []))
      const hits = [...this.containers.values()].filter((c) =>
        filters.every((f) => {
          if (f.startsWith('name=')) return new RegExp(f.slice(5)).test(c.name)
          if (f.startsWith('label=')) {
            const [k, v] = f.slice(6).split('=')
            return c.labels[k] === v
          }
          return true
        }),
      )
      return ok(hits.map((c) => c.id).join('\n'))
    }
    if (cmd === 'exec') {
      const cid = rest.find((a) => !a.startsWith('-')) ?? ''
      const argv = rest.slice(rest.indexOf(cid) + 1)
      return this.opts.exec ? this.opts.exec(cid, argv, input) : fail('exec not modelled')
    }
    return fail(`unmodelled docker ${cmd}`)
  }

  private volume(rest: string[]): ProcessResult {
    const [sub, ...args] = rest
    if (sub === 'create') {
      const labels: Record<string, string> = {}
      args.forEach((a, i) => {
        if (args[i - 1] === '--label') {
          const [k, v] = a.split('=')
          labels[k] = v
        }
      })
      const name = args[args.length - 1]
      this.volumes.set(name, { name, labels, anonymous: false })
      return ok(`${name}\n`)
    }
    if (sub === 'rm') {
      const name = args[args.length - 1]
      if (this.opts.undeletableVolumes?.includes(name)) return fail('volume is in use')
      return this.volumes.delete(name) ? ok(`${name}\n`) : fail('no such volume')
    }
    if (sub === 'inspect') return this.volumes.has(args[args.length - 1]) ? ok('[{}]') : fail('no such volume')
    if (sub === 'ls') {
      const filters = args.flatMap((a, i) => (args[i - 1] === '--filter' ? [a] : []))
      const hits = [...this.volumes.values()].filter((v) =>
        filters.every((f) => {
          const [k, val] = f.slice(6).split('=')
          return v.labels[k] === val
        }),
      )
      return ok(hits.map((v) => v.name).join('\n'))
    }
    return fail('unmodelled volume op')
  }

  private create(rest: string[]): ProcessResult {
    const name = rest[rest.indexOf('--name') + 1]
    const labels: Record<string, string> = {}
    rest.forEach((a, i) => {
      if (rest[i - 1] === '--label') {
        const [k, v] = a.split('=')
        labels[k] = v
      }
    })
    const networkFlag = rest.includes('--network') ? rest[rest.indexOf('--network') + 1] : 'bridge'
    const mount = rest.includes('--mount') ? rest[rest.indexOf('--mount') + 1] : null
    const namedVolume = mount?.match(/src=([^,]+)/)?.[1] ?? null
    const volumes = namedVolume ? [namedVolume] : []
    if (this.opts.anonymousVolumePerContainer) {
      const anon = `${(++this.seq).toString(16)}`.padStart(64, 'f')
      this.volumes.set(anon, { name: anon, labels: {}, anonymous: true })
      volumes.push(anon)
    }
    const networkMode = this.opts.forceNetworkMode ?? networkFlag
    const c = this.addContainer({
      name,
      image: rest[rest.length - 1],
      labels,
      networkMode,
      networks: [networkMode],
      volumes,
      mountPgdataOn: namedVolume,
    })
    return ok(`${c.id}\n`)
  }
}

/** Readiness + psql behaviour of a healthy pinned container: postmaster.pid = 1, SELECT 1 = 1. */
export function healthyExec(containerId: string, argv: string[]): ProcessResult {
  void containerId
  if (argv[0] === 'sh') return ok('1\n')
  if (argv[0] === 'psql') return ok('1\n')
  return fail('unmodelled exec')
}

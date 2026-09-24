// scripts/recovery/process.ts — process execution for the offline recovery
// mechanism (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-11).
//
// Every process is spawned with an ARGUMENT ARRAY and no shell, exactly like
// scripts/db-audit-disposable.ts: no injection surface and no cmd.exe quoting
// hazard on Windows. Secrets never travel in argv — a caller that must hand a
// value to `docker run` passes it through the child ENVIRONMENT (`docker run -e
// NAME` with no `=value` reads NAME from the docker CLI's own environment), so it
// never appears in the process table or in any retained command line.
//
// STREAMING INTEGRITY — what the digest of a stream means.
//
//   streamFileIntoProcess  The sha256 is taken over EVERY byte READ FROM THE
//                          FILE, from its first byte to EOF, in one sequential
//                          pass — NOT over the bytes the consumer chose to read.
//                          A consumer may stop early (`pg_restore --list` on a
//                          non-seekable stdin reads only the header and TOC and
//                          exits — measured by the recert of 2b254ab8 on a 12 MB
//                          dump); the producer then stops WRITING but keeps
//                          READING and HASHING to EOF. The bytes delivered to the
//                          consumer are therefore always a prefix of the bytes
//                          hashed, and the digest always describes the complete
//                          artifact as it was during this pass: an intact
//                          multi-chunk artifact matches, and a byte changed ahead
//                          of the read position does not.
//   streamProcessIntoFile  The sha256 is taken over every byte the producer
//                          emitted, which are the bytes written to the file.
//
// Both settle EXACTLY ONCE, after both halves (file side and process side) are
// done; the digest is finalized exactly once, by the file side, and nothing is
// hashed after it (the earlier version finalized on child `close` while a 'data'
// listener was still attached — ERR_CRYPTO_HASH_FINALIZED, uncaught). All
// listeners are detached on settle, with inert error sinks left behind so a late
// EPIPE can never become an unhandled error. Neither promise ever rejects: every
// failure is a RESULT, so every caller's teardown still runs.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'

import type { DockerRunner, ProcessResult } from '../db-audit-disposable'

export type { ProcessResult }

export interface StreamOutResult {
  status: number
  /** Kept in memory for classification only; never written to evidence as text. */
  stderr: string
  /** sha256 of every byte the producer emitted (= written to the file when writeError is false). */
  sha256: string
  bytes: number
  writeError: boolean
}

export interface StreamInResult {
  status: number
  stdout: string
  stderr: string
  /** sha256 of the COMPLETE file as read during this pass (first byte to EOF). */
  sha256: string
  /** Bytes read from the file and hashed. */
  bytes: number
  /** Bytes handed to the consumer's stdin — a prefix of the hashed bytes. */
  deliveredBytes: number
  /** The consumer stopped accepting input before EOF. Not an error by itself. */
  consumerClosedEarly: boolean
  /** The file could not be read to EOF: the digest is NOT of the complete artifact. */
  readError: boolean
}

export interface StreamHooks {
  /** Called after each chunk has been hashed. Test seam for mid-stream behavior. */
  afterChunk?: (hashedBytes: number) => void
}

/**
 * The docker surface the recovery mechanism uses. A superset of the shared
 * `DockerRunner` so `probeServingPostmaster` (scripts/db-audit-disposable.ts) is
 * reused unchanged, and injectable so orchestration is testable with a fake.
 */
export interface DockerCli extends DockerRunner {
  /** Like `run`, with extra environment variables for the docker CLI process only. */
  runWithEnv(args: string[], env: Record<string, string>): ProcessResult
  /** `docker <args>` with stdout streamed into `filePath`, hashed on the way. */
  streamToFile(args: string[], filePath: string): Promise<StreamOutResult>
  /** `docker <args>` with `filePath` streamed into stdin; the digest covers the WHOLE file. */
  streamFromFile(args: string[], filePath: string, hooks?: StreamHooks): Promise<StreamInResult>
}

const inert = () => undefined

function detach(child: ChildProcess, ...streams: Array<NodeJS.EventEmitter | null | undefined>): void {
  for (const s of streams) {
    if (!s) continue
    s.removeAllListeners()
    s.on('error', inert)
  }
  child.removeAllListeners()
  child.on('error', inert)
}

/** Stream `filePath` into `command args` on stdin. See the header: the digest covers the whole file. */
export function streamFileIntoProcess(command: string, args: string[], filePath: string, hooks: StreamHooks = {}): Promise<StreamInResult> {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    let digest: string | null = null
    let hashed = 0
    let delivered = 0
    let stdout = ''
    let stderr = ''
    let consumerOpen = true
    let consumerClosedEarly = false
    let readError = false
    let fileDone = false
    let childDone = false
    let childStatus: number | null = null
    let settled = false

    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const input = createReadStream(filePath)

    const finalize = () => {
      if (digest === null) digest = hash.digest('hex')
    }
    const settle = () => {
      if (settled || !fileDone || !childDone) return
      settled = true
      detach(child, input, child.stdin, child.stdout, child.stderr)
      input.destroy()
      const status = childStatus ?? 1
      resolve({
        status: readError && status === 0 ? 1 : status,
        stdout,
        stderr,
        sha256: digest ?? '',
        bytes: hashed,
        deliveredBytes: delivered,
        consumerClosedEarly,
        readError,
      })
    }
    /** The consumer is gone: stop writing, keep reading and hashing to EOF. */
    const consumerGone = () => {
      if (consumerOpen && !fileDone) consumerClosedEarly = true
      consumerOpen = false
      if (!fileDone) input.resume()
    }

    input.on('data', (chunk) => {
      if (digest !== null) return
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      hash.update(buf)
      hashed += buf.length
      hooks.afterChunk?.(hashed)
      if (consumerOpen && child.stdin && child.stdin.writable) {
        delivered += buf.length
        if (!child.stdin.write(buf)) input.pause()
      }
    })
    input.on('end', () => {
      finalize()
      fileDone = true
      if (consumerOpen) child.stdin?.end()
      consumerOpen = false
      settle()
    })
    input.on('error', (error) => {
      stderr += `\n[recovery] artifact read failed: ${error.message}`
      readError = true
      finalize()
      fileDone = true
      consumerOpen = false
      child.stdin?.destroy()
      settle()
    })

    child.stdin?.on('drain', () => input.resume())
    // EPIPE / close: the consumer stopped reading (pg_restore --list does this on purpose).
    child.stdin?.on('error', consumerGone)
    child.stdin?.on('close', consumerGone)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      stderr += `\n[recovery] spawn failed: ${error.message}`
      childStatus = childStatus ?? 1
      childDone = true
      consumerGone()
      settle()
    })
    child.on('close', (code) => {
      childStatus = code ?? 1
      childDone = true
      consumerGone()
      settle()
    })
  })
}

/** Stream `command args` stdout into a NEW file (`wx`), hashing every byte emitted. */
export function streamProcessIntoFile(command: string, args: string[], filePath: string): Promise<StreamOutResult> {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    let digest: string | null = null
    let bytes = 0
    let stderr = ''
    let writeError = false
    let fileDone = false
    let childDone = false
    let childStatus: number | null = null
    let settled = false

    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out = createWriteStream(filePath, { flags: 'wx' })

    const settle = () => {
      if (settled || !fileDone || !childDone) return
      settled = true
      if (digest === null) digest = hash.digest('hex')
      detach(child, out, child.stdout, child.stderr)
      const status = childStatus ?? 1
      resolve({ status: writeError && status === 0 ? 1 : status, stderr, sha256: digest, bytes, writeError })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (digest !== null) return
      hash.update(chunk)
      bytes += chunk.length
      if (!writeError && !out.write(chunk)) child.stdout?.pause()
    })
    out.on('drain', () => child.stdout?.resume())
    child.stdout?.on('end', () => {
      if (digest === null) digest = hash.digest('hex')
      if (!writeError) out.end()
    })
    out.on('close', () => {
      fileDone = true
      settle()
    })
    out.on('error', (error) => {
      stderr += `\n[recovery] artifact write failed: ${error.message}`
      writeError = true
      // Keep draining the producer so it can exit; nothing more is written.
      child.stdout?.resume()
      fileDone = true
      settle()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      stderr += `\n[recovery] spawn failed: ${error.message}`
      childStatus = childStatus ?? 1
      childDone = true
      if (!fileDone) out.end()
      settle()
    })
    child.on('close', (code) => {
      childStatus = code ?? 1
      childDone = true
      if (!fileDone && !writeError) out.end()
      settle()
    })
  })
}

function syncRun(args: string[], input: string | undefined, env: NodeJS.ProcessEnv): ProcessResult {
  const res = spawnSync('docker', args, { encoding: 'utf8', input, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

export const realDockerCli: DockerCli = {
  run(args, input) {
    return syncRun(args, input, process.env)
  },
  runWithEnv(args, env) {
    return syncRun(args, undefined, { ...process.env, ...env })
  },
  streamToFile(args, filePath) {
    return streamProcessIntoFile('docker', args, filePath)
  },
  streamFromFile(args, filePath, hooks) {
    return streamFileIntoProcess('docker', args, filePath, hooks)
  },
}

/** Local (non-docker) process, argument array, no shell. Used only for `git`. */
export function runLocal(command: string, args: string[], cwd: string): ProcessResult {
  const res = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

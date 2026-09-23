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
// The two streaming helpers exist because an artifact is BYTES, and the bytes
// that were hashed must be the bytes that were written or restored: the sha256
// is computed on the stream itself, never by re-reading a file afterwards.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'

import type { DockerRunner, ProcessResult } from '../db-audit-disposable'

export type { ProcessResult }

export interface StreamOutResult {
  status: number
  /** Kept in memory for classification only; never written to evidence as text. */
  stderr: string
  sha256: string
  bytes: number
}

export interface StreamInResult {
  status: number
  stdout: string
  stderr: string
  /** sha256 of the bytes actually delivered to the child's stdin. */
  sha256: string
  bytes: number
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
  /** `docker <args>` with `filePath` streamed into stdin, hashed on the way. */
  streamFromFile(args: string[], filePath: string): Promise<StreamInResult>
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
    return new Promise((resolve) => {
      const hash = createHash('sha256')
      let bytes = 0
      let stderr = ''
      const out = createWriteStream(filePath, { flags: 'wx' })
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      child.stdout.on('data', (chunk: Buffer) => {
        hash.update(chunk)
        bytes += chunk.length
      })
      child.stdout.pipe(out)
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      let status: number | null = null
      let outClosed = false
      const settle = () => {
        if (status !== null && outClosed) resolve({ status, stderr, sha256: hash.digest('hex'), bytes })
      }
      out.on('close', () => {
        outClosed = true
        settle()
      })
      out.on('error', (error) => {
        stderr += `\n[recovery] artifact write failed: ${error.message}`
        outClosed = true
        status = status ?? 1
        settle()
      })
      child.on('error', (error) => {
        stderr += `\n[recovery] spawn failed: ${error.message}`
        status = 1
        out.end()
      })
      child.on('close', (code) => {
        status = code ?? 1
        settle()
      })
    })
  },
  streamFromFile(args, filePath) {
    return new Promise((resolve) => {
      const hash = createHash('sha256')
      let bytes = 0
      let stdout = ''
      let stderr = ''
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const input = createReadStream(filePath)
      input.on('data', (chunk) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        hash.update(buf)
        bytes += buf.length
      })
      input.on('error', (error) => {
        stderr += `\n[recovery] artifact read failed: ${error.message}`
        child.stdin.end()
      })
      // A child that exits early (pg_restore --exit-on-error) closes its stdin;
      // the resulting EPIPE is expected and must not crash the parent.
      child.stdin.on('error', () => undefined)
      input.pipe(child.stdin)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        stderr += `\n[recovery] spawn failed: ${error.message}`
      })
      child.on('close', (code) => {
        resolve({ status: code ?? 1, stdout, stderr, sha256: hash.digest('hex'), bytes })
      })
    })
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

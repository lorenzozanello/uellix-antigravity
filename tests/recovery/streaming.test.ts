// @vitest-environment node
// tests/recovery/streaming.test.ts — B-STREAM-1, against REAL child processes.
//
// Measured by the recert of 2b254ab8: the TOC pass compared the digest of the
// bytes `pg_restore --list` consumed (header + TOC only, on a non-seekable
// stdin) with the digest of the whole artifact, so every INTACT artifact larger
// than one read chunk (64 KiB) failed; and a 'data' listener outlived digest()
// (ERR_CRYPTO_HASH_FINALIZED, uncaught). The fixture of the previous run was
// 13.8 KB — one chunk — and could not see either.
//
// Here the artifact is 8 MiB (128 read chunks), deterministic, and the consumers
// are real processes that read everything, stop early, never read, or crash.
// Vitest fails the run on any unhandled error, so a finalized-hash crash is RED
// by construction.

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { streamFileIntoProcess, streamProcessIntoFile } from '../../scripts/recovery/process'

const SIZE = 8 * 1024 * 1024
const NODE = process.execPath
let dir = ''
let artifact = ''
let fullSha = ''

/** A consumer that reads stdin; `stopAfter` bytes then exit(code), or everything. Prints bytes read. */
const consumer = (stopAfter: number | null, code = 0) => [
  '-e',
  `let n=0;const stop=${stopAfter === null ? 'Infinity' : stopAfter};` +
    `process.stdin.on('data',c=>{n+=c.length;if(n>=stop){process.stdout.write(String(n),()=>process.exit(${code}))}});` +
    `process.stdin.on('end',()=>process.stdout.write(String(n)));`,
]

function deterministic(size: number): Buffer {
  const out = Buffer.alloc(size)
  let block = createHash('sha256').update('uellix-recovery-streaming-fixture').digest()
  for (let off = 0; off < size; off += 32) {
    block.copy(out, off)
    block = createHash('sha256').update(block).digest()
  }
  return out
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'uellix-recovery-unit-'))
  artifact = path.join(dir, 'multichunk.dump')
  const bytes = deterministic(SIZE)
  writeFileSync(artifact, bytes)
  fullSha = sha(bytes)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function freshCopy(name: string): string {
  const p = path.join(dir, name)
  writeFileSync(p, readFileSync(artifact))
  return p
}

function patch(file: string, offset: number, bytes: Buffer) {
  const fd = openSync(file, 'r+')
  writeSync(fd, bytes, 0, bytes.length, offset)
  closeSync(fd)
}

describe('streamFileIntoProcess: the digest covers the WHOLE file, whatever the consumer reads', () => {
  it('guard: the artifact is many read chunks, not one', () => {
    expect(SIZE / (64 * 1024)).toBeGreaterThanOrEqual(100)
  })

  it('a consumer that reads everything: full digest, every byte delivered', async () => {
    const r = await streamFileIntoProcess(NODE, consumer(null), artifact)
    expect(r).toMatchObject({ status: 0, sha256: fullSha, bytes: SIZE, deliveredBytes: SIZE, consumerClosedEarly: false, readError: false })
    expect(Number(r.stdout)).toBe(SIZE)
  })

  it('B-STREAM-1: an EARLY-EXITING consumer (the pg_restore --list shape) still yields the FULL digest — repeatedly', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await streamFileIntoProcess(NODE, consumer(200_000), artifact)
      expect(r.status).toBe(0)
      expect(r.sha256).toBe(fullSha)
      expect(r.bytes).toBe(SIZE)
      expect(r.readError).toBe(false)
      expect(Number(r.stdout)).toBeLessThan(SIZE)
    }
  })

  it('a consumer that never reads and exits at once: full digest, no crash', async () => {
    const r = await streamFileIntoProcess(NODE, ['-e', 'process.exit(0)'], artifact)
    expect(r).toMatchObject({ status: 0, sha256: fullSha, bytes: SIZE, readError: false })
  })

  it('a consumer that CRASHES mid-stream: its exit status is reported, the digest is still the full file', async () => {
    const r = await streamFileIntoProcess(NODE, consumer(1024 * 1024, 7), artifact)
    expect(r.status).toBe(7)
    expect(r.sha256).toBe(fullSha)
  })

  it('a consumer that cannot even be spawned: a result, not a rejection', async () => {
    const r = await streamFileIntoProcess(path.join(dir, 'no-such-binary'), [], artifact)
    expect(r.status).not.toBe(0)
    expect(r.sha256).toBe(fullSha)
  })

  it('a READ ERROR is a failure (status forced non-zero) and flagged — never a complete-artifact digest', async () => {
    const aDirectory = path.join(dir, 'not-a-file')
    mkdirSync(aDirectory)
    const r = await streamFileIntoProcess(NODE, consumer(null), aDirectory)
    expect(r.readError).toBe(true)
    expect(r.status).not.toBe(0)
  })

  it('TOCTOU: a byte changed AHEAD of the read position during the stream changes the digest (detected)', async () => {
    const copy = freshCopy('ahead.dump')
    let done = false
    const r = await streamFileIntoProcess(NODE, consumer(null), copy, {
      afterChunk: (hashed) => {
        if (!done && hashed >= 64 * 1024) {
          done = true
          patch(copy, 7 * 1024 * 1024, Buffer.from('TAMPERED'))
        }
      },
    })
    expect(r.sha256).not.toBe(fullSha)
    expect(r.sha256).toBe(sha(readFileSync(copy)))
  })

  it('a byte changed BEHIND the read position does not alter what was delivered, and the digest says so (it matches the delivered stream)', async () => {
    const copy = freshCopy('behind.dump')
    let done = false
    const r = await streamFileIntoProcess(NODE, consumer(null), copy, {
      afterChunk: (hashed) => {
        if (!done && hashed >= 7 * 1024 * 1024) {
          done = true
          patch(copy, 0, Buffer.from('TAMPERED'))
        }
      },
    })
    expect(r.sha256).toBe(fullSha)
  })
})

describe('streamProcessIntoFile: every emitted byte hashed and written, settled once', () => {
  const producer = (src: string, crashAfter: number | null = null) => [
    '-e',
    crashAfter === null
      ? `require('fs').createReadStream(${JSON.stringify(src)}).pipe(process.stdout)`
      : `const b=require('fs').readFileSync(${JSON.stringify(src)});process.stdout.write(b.subarray(0,${crashAfter}),()=>process.exit(3))`,
  ]

  it('a multi-chunk producer: file bytes and digest equal the source', async () => {
    const out = path.join(dir, 'produced.dump')
    const r = await streamProcessIntoFile(NODE, producer(artifact), out)
    expect(r).toMatchObject({ status: 0, sha256: fullSha, bytes: SIZE, writeError: false })
    expect(sha(readFileSync(out))).toBe(fullSha)
  })

  it('a producer that crashes mid-stream: its status is reported, the digest is of what it emitted', async () => {
    const out = path.join(dir, 'crashed.dump')
    const r = await streamProcessIntoFile(NODE, producer(artifact, 3 * 1024 * 1024), out)
    expect(r.status).toBe(3)
    expect(r.bytes).toBe(3 * 1024 * 1024)
    expect(r.sha256).toBe(sha(readFileSync(out)))
  })

  it('a WRITE ERROR (target directory absent) is a failure, flagged, settled once, no crash', async () => {
    const r = await streamProcessIntoFile(NODE, producer(artifact), path.join(dir, 'absent-dir', 'x.dump'))
    expect(r.writeError).toBe(true)
    expect(r.status).not.toBe(0)
  })

  it('an existing target is never overwritten (wx): a write error', async () => {
    const out = path.join(dir, 'exists.dump')
    writeFileSync(out, 'keep')
    const r = await streamProcessIntoFile(NODE, producer(artifact), out)
    expect(r.writeError).toBe(true)
    expect(readFileSync(out, 'utf8')).toBe('keep')
  })
})

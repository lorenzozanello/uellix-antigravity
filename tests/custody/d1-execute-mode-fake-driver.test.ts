// @vitest-environment node
// tests/custody/d1-execute-mode-fake-driver.test.ts
//
// THE EXECUTE-MODE LOADING PATH, WITHOUT A NETWORK.
//
// Dry runs never load a driver. Execute mode does: createRequire from an
// explicit --driver-root, one reserved connection, unsafe(pinned text),
// release, end. Here --driver-root points at a FAKE `postgres` package in a
// temporary directory, so the real loading path runs end to end and no socket
// can exist. The value is set in the consumer's environment directly (not via
// the WCM), because the synthetic custody shape forbids a staging-host-shaped
// value in the vault by design; the external-observer topology of execute mode
// therefore remains nonblocking future evidence (DAG v1.0.6 OEP-3).

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'
import { P1_STATEMENTS } from '@/db/custody/p1-reads'
import { buildProductionEntryPoints } from '@/scripts/custody/build-production-entrypoints'

const PW = 'R'.repeat(43)
const STAGING = ['postgresql:', '//uellix_auditor:', PW, `@db.${KNOWN_STAGING_PROJECT_REF}.supabase.co:5432/postgres`].join('')

const ROWS: Record<string, unknown[]> = {
  [P1_STATEMENTS.IDENTITY.sql]: [{ current_user: 'uellix_auditor', session_user: 'uellix_auditor' }],
  [P1_STATEMENTS.READ_ONLY.sql]: [{ current_setting: 'on' }],
  [P1_STATEMENTS.SENTINEL.sql]: [{ environment: 'staging', project_ref: KNOWN_STAGING_PROJECT_REF }],
}

function fakeDriverRoot(): { root: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'd1-exec-driver-'))
  const dir = join(root, 'node_modules', 'postgres')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fake-driver-root","private":true}')
  writeFileSync(join(dir, 'package.json'), '{"name":"postgres","main":"index.js"}')
  const log = join(root, 'driver-log.jsonl')
  writeFileSync(
    join(dir, 'index.js'),
    `'use strict'
const fs = require('node:fs')
const ROWS = ${JSON.stringify(ROWS)}
const rec = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(o) + '\\n')
module.exports = function postgres(url, opts) {
  rec({ event: 'construct', host: new URL(url).hostname, max: opts.max, prepare: opts.prepare, ssl: opts.ssl })
  return {
    reserve: async () => ({
      unsafe: async (q) => { rec({ event: 'unsafe', q }); return ROWS[q] || [] },
      release: () => rec({ event: 'release' }),
    }),
    end: async () => rec({ event: 'end' }),
  }
}
`
  )
  return { root, log }
}

describe('execute mode through a fake driver root', () => {
  it('the BUILT N13 consumer, under bare node, loads the driver from --driver-root, sends only the pinned statements, prints no value, spawns nothing', () => {
    const out = mkdtempSync(join(tmpdir(), 'd1-exec-build-'))
    const built = buildProductionEntryPoints(process.cwd(), out)
    const { root, log } = fakeDriverRoot()
    const env: Record<string, string> = { UELLIX_AUDITOR_DATABASE_URL: STAGING }
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path']) if (process.env[k] !== undefined) env[k] = process.env[k]!
    let stdout = ''
    let status = 0
    try {
      stdout = execFileSync(process.execPath, [built.consumer, '--mode=execute', `--driver-root=${root}`], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', windowsHide: true })
    } catch (e) {
      status = (e as { status: number }).status
      stdout = String((e as { stdout: string }).stdout)
    }
    const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; q?: string; host?: string; ssl?: string; max?: number; prepare?: boolean })
    expect(status).toBe(0)
    expect(JSON.parse(stdout.trim().split('\n').pop()!)).toMatchObject({ node: 'N13', mode: 'execute', ok: true, connected: true })
    expect(events[0]).toMatchObject({ event: 'construct', host: `db.${KNOWN_STAGING_PROJECT_REF}.supabase.co`, max: 1, prepare: false, ssl: 'require' })
    expect(events.filter((e) => e.event === 'unsafe').map((e) => e.q)).toEqual([
      'BEGIN READ ONLY',
      P1_STATEMENTS.IDENTITY.sql,
      P1_STATEMENTS.READ_ONLY.sql,
      P1_STATEMENTS.SENTINEL.sql,
      'ROLLBACK',
    ])
    expect(events.slice(-2).map((e) => e.event)).toEqual(['release', 'end'])
    expect(stdout).not.toContain(PW)
    expect(readFileSync(log, 'utf8')).not.toContain(PW)
  }, 120_000)

  it('without --driver-root, execute mode refuses before anything is loaded', () => {
    const out = mkdtempSync(join(tmpdir(), 'd1-exec-build-'))
    const built = buildProductionEntryPoints(process.cwd(), out)
    let status = 0
    let stdout = ''
    try {
      stdout = execFileSync(process.execPath, [built.consumer, '--mode=execute'], { env: { ...process.env, UELLIX_AUDITOR_DATABASE_URL: STAGING }, encoding: 'utf8', windowsHide: true })
    } catch (e) {
      status = (e as { status: number }).status
      stdout = String((e as { stdout: string }).stdout)
    }
    expect(status).toBe(2)
    expect(stdout).not.toContain(PW)
  }, 120_000)
})

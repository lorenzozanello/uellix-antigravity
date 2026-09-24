// tests/recovery/scripted-world.ts — a scripted pinned-PostgreSQL world on the
// FakeDocker, able to run captureLogicalBackup and restoreIntoSubstrate end to
// end WITHOUT a daemon. Every docker call is recorded, streams hash the bytes
// they really read, and the psql answers are the shapes the real image gives
// (measured by the e2e). It exists for BEHAVIORAL oracles: streaming TOCTOU,
// TOC use by the runner, and the event_class differential.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CaptureRequest, PrincipalObservation } from '../../scripts/recovery/capture'
import type { Census } from '../../scripts/recovery/catalog-census'
import type { ProcessResult } from '../../scripts/recovery/process'
import type { LocalDisposableIdentity } from '../../scripts/recovery/recovery-target'
import { ROLE_LABEL, RUN_LABEL, SUBSTRATE_LABEL, type Substrate } from '../../scripts/recovery/substrate'
import { PINNED_IMAGE_BASELINE_ROLES, RECOVERY_TOOL_PIN } from '../../scripts/recovery/tool-pin'
import { FakeDocker, type FakeDockerOptions } from './fake-docker'
import { sampleCensus } from './sample-evidence'

export const RUN = 'abcdef0123456789'
export const DUMP = Buffer.from('PGDMP synthetic scripted dump bytes — no rows')

export const TOC_LISTING = [
  ';',
  ';     Format: CUSTOM',
  ';     Dumped from database version: 17.6',
  ';     Dumped by pg_dump version: 17.6',
  ';',
  '5; 2615 2200 SCHEMA - public pg_database_owner',
  '7; 2615 16784 SCHEMA - uellix_provisioning fixture_app_owner',
  '224; 1259 16770 TABLE public fixture_audit fixture_app_owner',
  '222; 1259 16756 TABLE public fixture_member fixture_app_owner',
  '220; 1259 16748 TABLE public fixture_org fixture_app_owner',
  '226; 1259 16786 TABLE uellix_provisioning applied_units fixture_app_owner',
  '',
].join('\n')

export const SAFE_PRINCIPAL: PrincipalObservation = {
  role: 'recovery_capture_ro',
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolbypassrls: true,
  write_all_member: false,
  relation_count: 9,
  write_privileged_relations: 0,
  unselectable_relations: 0,
  schema_create: 0,
  schema_no_usage: 0,
  rls_relations: 1,
  reachable_roles: [{ name: 'pg_read_all_data', rolsuper: false, rolcreaterole: false, rolcreatedb: false, write_privileged_relations: 0, schema_create: 0 }],
}

export interface ScriptedWorld {
  fake: FakeDocker
  source: LocalDisposableIdentity
  restoreSubstrate: Substrate
  dir: string
  psqlInputs: string[]
  captureRequest(overrides?: Partial<CaptureRequest>): CaptureRequest
  cleanup(): void
}

export interface ScriptedWorldOptions {
  census?: Census
  principal?: PrincipalObservation
  tocListing?: string
  onStream?: FakeDockerOptions['onStream']
  repoRoot: string
}

const ok = (stdout = ''): ProcessResult => ({ status: 0, stdout, stderr: '' })

export function scriptedWorld(o: ScriptedWorldOptions): ScriptedWorld {
  const census = o.census ?? sampleCensus()
  const psqlInputs: string[] = []
  let rolesCalls = 0
  const exec = (_cid: string, argv: string[], input?: string): ProcessResult => {
    if (argv[0] === 'pg_dump' && argv[1] === '--version') return ok('pg_dump (PostgreSQL) 17.6\n')
    if (argv[0] === 'pg_restore' && argv[1] === '--version') return ok('pg_restore (PostgreSQL) 17.6\n')
    if (argv[0] === 'sh') return ok('1\n')
    if (argv[0] === 'psql') {
      const sql = input ?? argv.join(' ')
      psqlInputs.push(sql)
      if (sql.includes('SHOW server_version_num')) return ok('170006\n')
      if (sql.includes("'reachable_roles'")) return ok(`${JSON.stringify(o.principal ?? SAFE_PRINCIPAL)}\n`)
      if (sql.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')) return ok(`${JSON.stringify(census)}\n`)
      if (sql.includes('SELECT rolname FROM pg_roles')) {
        rolesCalls++
        const roles = rolesCalls === 1 ? [...PINNED_IMAGE_BASELINE_ROLES] : [...PINNED_IMAGE_BASELINE_ROLES, 'fixture_app_owner', 'fixture_capability']
        return ok(`${roles.join('\n')}\n`)
      }
      return ok('')
    }
    return { status: 1, stdout: '', stderr: 'unmodelled exec' }
  }
  const fake = new FakeDocker({
    dumpBytes: DUMP,
    exec,
    onStream: o.onStream,
    streamResult: (args) => (args.includes('--list') ? { status: 0, stdout: o.tocListing ?? TOC_LISTING } : { status: 0, stdout: '' }),
  })
  const mk = (role: 'source-fixture' | 'restore-substrate') => {
    const name = `uellix-recovery-${role}-${RUN}-scripted`
    return fake.addContainer({ name, image: RECOVERY_TOOL_PIN.imageId, labels: { [RUN_LABEL]: RUN, [ROLE_LABEL]: role, [SUBSTRATE_LABEL]: name } })
  }
  const src = mk('source-fixture')
  const dst = mk('restore-substrate')
  const source: LocalDisposableIdentity = { identityClass: 'LOCAL_DISPOSABLE', containerId: src.id, containerName: src.name, runId: RUN, role: 'source-fixture', imageId: RECOVERY_TOOL_PIN.imageId }
  const restoreSubstrate: Substrate = {
    identity: { identityClass: 'LOCAL_DISPOSABLE', containerId: dst.id, containerName: dst.name, runId: RUN, role: 'restore-substrate', imageId: RECOVERY_TOOL_PIN.imageId },
    namedVolume: 'v',
    recordedVolumes: [{ name: 'v', kind: 'named' }],
    createdAt: '2026-09-23T20:00:37.000Z',
    observed: { imageId: RECOVERY_TOOL_PIN.imageId, networkMode: 'none' },
    password: 'scripted-never-emitted',
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'uellix-recovery-unit-'))
  return {
    fake,
    source,
    restoreSubstrate,
    dir,
    psqlInputs,
    captureRequest: (overrides = {}) => ({
      source,
      database: 'fixture_src',
      principal: { roleName: 'recovery_capture_ro', provenance: 'LOCAL_DISPOSABLE_FIXTURE_ROLE' },
      scope: { schemas: ['public', 'uellix_provisioning'], excluded_relations: [], extensions: ['pg_trgm'] },
      eventClass: null,
      declaredClassification: 'SYNTHETIC_FIXTURE',
      artifactDir: dir,
      repoRoot: o.repoRoot,
      ...overrides,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

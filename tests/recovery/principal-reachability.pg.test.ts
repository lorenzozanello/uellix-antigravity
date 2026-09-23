// @vitest-environment node
// tests/recovery/principal-reachability.pg.test.ts — NB-2 against REAL
// PostgreSQL (the pinned 17.6 image, disposable, --network none).
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently passed —
// otherwise, and allocates NOTHING when skipped (NB-6): every resource is
// created in beforeAll.
//
// For each principal shape the capture must refuse — and, so the refusals are
// not about imaginary threats, the test also DEMONSTRATES the escalation each
// grant enables (the role really writes after SET ROLE). The accepted principal
// is then proven unable to become ANY role in the cluster that can write.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { captureLogicalBackup, type CaptureRequest } from '../../scripts/recovery/capture'
import { FIXTURE_REHEARSAL, fixturePaths, loadSyntheticSource, SOURCE_DATABASE } from '../../scripts/recovery/offline-rehearsal'
import { realDockerCli as docker } from '../../scripts/recovery/process'
import { createSubstrate, destroySubstrate, newRunId, RUN_LABEL, substratePsql, type Substrate } from '../../scripts/recovery/substrate'

const ENABLED = process.env.UELLIX_PG_TESTS === '1'
const REPO = path.resolve(import.meta.dirname, '../..')

const PRINCIPALS_SQL = `
CREATE ROLE p_direct LOGIN BYPASSRLS; GRANT pg_read_all_data TO p_direct; GRANT DELETE ON public.fixture_audit TO p_direct;
CREATE ROLE w_inh NOLOGIN; GRANT DELETE ON public.fixture_audit TO w_inh;
CREATE ROLE p_inh LOGIN BYPASSRLS; GRANT pg_read_all_data TO p_inh; GRANT w_inh TO p_inh;
CREATE ROLE w_set NOLOGIN; GRANT DELETE ON public.fixture_audit TO w_set;
CREATE ROLE p_set LOGIN BYPASSRLS; GRANT pg_read_all_data TO p_set; GRANT w_set TO p_set WITH INHERIT FALSE, SET TRUE;
CREATE ROLE w_nest NOLOGIN; GRANT DELETE ON public.fixture_audit TO w_nest;
CREATE ROLE mid NOLOGIN; GRANT w_nest TO mid WITH INHERIT FALSE, SET TRUE;
CREATE ROLE p_nest LOGIN BYPASSRLS; GRANT pg_read_all_data TO p_nest; GRANT mid TO p_nest WITH INHERIT FALSE, SET TRUE;
CREATE ROLE w_adm NOLOGIN; GRANT DELETE ON public.fixture_audit TO w_adm;
CREATE ROLE p_adm LOGIN BYPASSRLS; GRANT pg_read_all_data TO p_adm; GRANT w_adm TO p_adm WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
CREATE ROLE p_wall LOGIN BYPASSRLS; GRANT pg_read_all_data TO p_wall; GRANT pg_write_all_data TO p_wall WITH INHERIT FALSE, SET TRUE;
`

describe.skipIf(!ENABLED)('NB-2: capture principal closed under SET ROLE reachability — real PostgreSQL', { timeout: 600_000 }, () => {
  let runId = ''
  let dir = ''
  let source: Substrate | null = null

  /** Run SQL AS a login role over the container loopback; exit 0 means the statement ran. */
  const as = (role: string, sql: string) =>
    docker.run(['exec', '-i', source!.identity.containerId, 'psql', '-X', '-h', '127.0.0.1', '-U', role, '-d', SOURCE_DATABASE, '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-tAq'], sql)
  const req = (roleName: string): CaptureRequest => ({
    source: source!.identity,
    database: SOURCE_DATABASE,
    principal: { roleName, provenance: 'LOCAL_DISPOSABLE_FIXTURE_ROLE' },
    scope: FIXTURE_REHEARSAL.scope,
    eventClass: null,
    declaredClassification: 'SYNTHETIC_FIXTURE',
    artifactDir: dir,
    repoRoot: REPO,
  })

  beforeAll(() => {
    runId = newRunId()
    dir = mkdtempSync(path.join(tmpdir(), 'uellix-recovery-principal-'))
    source = createSubstrate(docker, { runId, role: 'source-fixture' })
    const paths = fixturePaths(REPO)
    loadSyntheticSource(docker, source, paths.fixtureRolesPath, paths.fixtureSourcePath)
    expect(substratePsql(docker, source, SOURCE_DATABASE, PRINCIPALS_SQL).status).toBe(0)
  }, 300_000)

  afterAll(() => {
    if (source) expect(destroySubstrate(docker, source).verdict).toBe('DESTROYED_AND_VERIFIED_ABSENT')
    rmSync(dir, { recursive: true, force: true })
    const left = docker.run(['ps', '-a', '-q', '--filter', `label=${RUN_LABEL}=${runId}`]).stdout.trim()
    expect(left).toBe('')
  }, 120_000)

  it('the escalations are REAL: each attacking grant lets its principal delete (rolled back)', () => {
    expect(as('p_direct', 'BEGIN; DELETE FROM public.fixture_audit WHERE false; ROLLBACK;').status).toBe(0)
    expect(as('p_inh', 'BEGIN; DELETE FROM public.fixture_audit WHERE false; ROLLBACK;').status).toBe(0)
    // SET-only: no inherited privilege, but SET ROLE works and then writes.
    expect(as('p_set', 'BEGIN; DELETE FROM public.fixture_audit WHERE false; ROLLBACK;').status).not.toBe(0)
    expect(as('p_set', 'BEGIN; SET ROLE w_set; DELETE FROM public.fixture_audit WHERE false; ROLLBACK;').status).toBe(0)
    expect(as('p_nest', 'BEGIN; SET ROLE mid; SET ROLE w_nest; DELETE FROM public.fixture_audit WHERE false; ROLLBACK;').status).toBe(0)
    // ADMIN only (INHERIT FALSE, SET FALSE): the principal grants itself SET, then writes.
    expect(as('p_adm', 'BEGIN; SET ROLE w_adm; ROLLBACK;').status).not.toBe(0)
    expect(as('p_adm', 'BEGIN; GRANT w_adm TO p_adm WITH SET TRUE; SET ROLE w_adm; DELETE FROM public.fixture_audit WHERE false; ROLLBACK;').status).toBe(0)
    expect(as('p_wall', 'BEGIN; SET ROLE pg_write_all_data; DELETE FROM public.fixture_audit WHERE false; ROLLBACK;').status).toBe(0)
  })

  it.each<[string, string[], 'exact' | 'contains']>([
    ['p_direct', ['PRINCIPAL_WRITE_PRIVILEGE_IN_SCOPE'], 'exact'],
    ['p_inh', ['PRINCIPAL_WRITE_PRIVILEGE_IN_SCOPE', 'PRINCIPAL_REACHES_WRITE_PRIVILEGE'], 'exact'],
    ['p_set', ['PRINCIPAL_REACHES_WRITE_PRIVILEGE'], 'exact'],
    ['p_nest', ['PRINCIPAL_REACHES_WRITE_PRIVILEGE'], 'exact'],
    ['p_adm', ['PRINCIPAL_REACHES_WRITE_PRIVILEGE'], 'exact'],
    ['p_wall', ['PRINCIPAL_WRITE_ALL_DATA_MEMBER', 'PRINCIPAL_REACHES_UNSAFE_PREDEFINED_ROLE'], 'contains'],
  ])('capture as %s is REFUSED with %j and writes no artifact', async (role, codes, mode) => {
    const out = await captureLogicalBackup(docker, req(role))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('CAPTURE_PRINCIPAL_REFUSED')
    if (mode === 'exact') expect(out.principalRefusals).toEqual(codes)
    else expect(out.principalRefusals).toEqual(expect.arrayContaining(codes))
  })

  it('the SET-only principal passes every DIRECT predicate — the refusal is due to reachability alone', async () => {
    const out = await captureLogicalBackup(docker, req('p_set'))
    expect(out.ok ? [] : out.principalRefusals).toEqual(['PRINCIPAL_REACHES_WRITE_PRIVILEGE'])
  })

  it('the safe read-only principal is ACCEPTED, and cannot become ANY write-capable role in the cluster', async () => {
    const out = await captureLogicalBackup(docker, req('recovery_capture_ro'))
    expect(out.ok).toBe(true)
    const roles = substratePsql(docker, source!, SOURCE_DATABASE, 'SELECT rolname FROM pg_roles ORDER BY 1;\n', ['-tA']).stdout.split(/\r?\n/).map((r) => r.trim()).filter(Boolean)
    expect(roles.length).toBeGreaterThan(20)
    const becameWriter: string[] = []
    const couldSet: string[] = []
    for (const r of roles) {
      if (as('recovery_capture_ro', `BEGIN; SET ROLE "${r}"; ROLLBACK;`).status === 0) couldSet.push(r)
      if (as('recovery_capture_ro', `BEGIN; SET ROLE "${r}"; DELETE FROM public.fixture_audit WHERE false; ROLLBACK;`).status === 0) becameWriter.push(r)
    }
    expect(couldSet.sort()).toEqual(['pg_read_all_data', 'recovery_capture_ro'])
    expect(becameWriter).toEqual([])
    expect(as('recovery_capture_ro', 'BEGIN; DELETE FROM public.fixture_audit WHERE false; ROLLBACK;').status).not.toBe(0)
  })
})

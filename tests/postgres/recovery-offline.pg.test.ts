// @vitest-environment node
// tests/postgres/recovery-offline.pg.test.ts — the offline recovery mechanism
// against REAL disposable PostgreSQL containers
// (docs/ops/release/STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_TEST_MANIFEST_v1.0.0.json).
//
// Gated: UELLIX_PG_TESTS=1 (Docker required). Skipped — never silently passed —
// otherwise, and a skipped run allocates NOTHING: every directory, container and
// git read happens inside a hook or a test, never in a describe body (NB-6;
// asserted by tests/recovery/skipped-e2e-residue.test.ts).
//
// ZERO HOSTED CONTACT: every container is started by this file from the pinned
// image with --network none (except the one deliberately bridged container
// OR-N11 creates to prove it is REFUSED), filled with fabricated rows, and
// destroyed with its volumes. Every destructive call is scoped to ids and run
// labels this file created. The capture-principal escalation pressure lives in
// tests/recovery/principal-reachability.pg.test.ts.

import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { frozenPacketContents, NO_MUTATION_CONFIRMATION, validateBackupPacket, type BackupPacket, type SourceCensusRecord } from '../../scripts/recovery/artifact-packet'
import { captureLogicalBackup } from '../../scripts/recovery/capture'
import { classifyToolOutcome, validateEvidence } from '../../scripts/recovery/evidence-privacy'
import { FIXTURE_REHEARSAL, fixturePaths, loadSyntheticSource, runOfflineRehearsal, SOURCE_DATABASE, disposeArtifact } from '../../scripts/recovery/offline-rehearsal'
import { runPostRestoreInvariants } from '../../scripts/recovery/post-restore-invariants'
import { realDockerCli as docker, type DockerCli } from '../../scripts/recovery/process'
import { RESTORED_INTO, VERIFICATION_RESULTS } from '../../scripts/recovery/restore-proof'
import { restoreIntoSubstrate, runPgRestore, RESTORE_STEP_SHAPE, type RestoreOutcome } from '../../scripts/recovery/restore-runner'
import { assertSubstrateOwnership, createSubstrate, destroySubstrate, newRunId, ROLE_LABEL, RUN_LABEL, SubstrateRefusal, substratePsql, type DestructionProof, type Substrate } from '../../scripts/recovery/substrate'
import { RECOVERY_TOOL_PIN } from '../../scripts/recovery/tool-pin'

const ENABLED = process.env.UELLIX_PG_TESTS === '1'
const REPO = path.resolve(import.meta.dirname, '../..')
const PATHS = fixturePaths(REPO)
const CANARIES = [...readFileSync(PATHS.fixtureSourcePath, 'utf8').matchAll(/CANARY-ROW-VALUE-[A-Za-z0-9-]+/g)].map((m) => m[0])
const SKEW_IMAGE = { imageRef: 'public.ecr.aws/supabase/postgres:17.6.1.143', imageId: 'sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453', pgVersion: '17.6', serverVersionNum: 170006 }

const d = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true })
const gitStatus = () => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: REPO, encoding: 'utf8' }).stdout
const labelled = (runId: string) => ({
  containers: d(['ps', '-a', '-q', '--filter', `label=${RUN_LABEL}=${runId}`]).stdout.trim(),
  volumes: d(['volume', 'ls', '-q', '--filter', `label=${RUN_LABEL}=${runId}`]).stdout.trim(),
})
const noCanary = (value: unknown) => {
  const s = JSON.stringify(value)
  return CANARIES.filter((c) => s.includes(c))
}

describe.skipIf(!ENABLED)('offline recovery mechanism — real disposable PostgreSQL', { timeout: 900_000 }, () => {
  let statusBefore = ''
  beforeAll(() => {
    statusBefore = gitStatus()
  })

  it('guard: the fixture plants canaries (a canary scan over nothing proves nothing)', () => {
    expect(CANARIES.length).toBeGreaterThanOrEqual(10)
  })

  it('calibration: docker rm -f -v removes ANONYMOUS volumes only; a NAMED volume needs volume rm (grounds tests/recovery/fake-docker.ts)', () => {
    const run = newRunId()
    const named = `uellix-recovery-calib-${run}`
    const name = `uellix-recovery-calib-c-${run}`
    try {
      expect(d(['volume', 'create', '--label', `${RUN_LABEL}=${run}`, named]).status).toBe(0)
      // postgres:16-alpine declares VOLUME /var/lib/postgresql/data -> one anonymous volume.
      const created = d(['create', '--name', name, '--label', `${RUN_LABEL}=${run}`, '--network', 'none', '--mount', `type=volume,src=${named},dst=/calib`, 'postgres:16-alpine'])
      expect(created.status).toBe(0)
      const mounts = JSON.parse(d(['inspect', '-f', '{{json .Mounts}}', name]).stdout) as Array<{ Type: string; Name: string }>
      const anon = mounts.filter((m) => m.Name !== named).map((m) => m.Name)
      expect(anon).toHaveLength(1)
      expect(d(['rm', '-f', '-v', name]).status).toBe(0)
      expect(d(['volume', 'inspect', anon[0]]).status).not.toBe(0)
      expect(d(['volume', 'inspect', named]).status).toBe(0)
      expect(d(['volume', 'rm', named]).status).toBe(0)
      expect(d(['volume', 'inspect', named]).status).not.toBe(0)
    } finally {
      d(['rm', '-f', '-v', name])
      d(['volume', 'rm', named])
    }
    expect(labelled(run)).toEqual({ containers: '', volumes: '' })
  })

  it('OR-P1 / OR-P5 / OR-P6: synthetic source -> capture -> restore -> invariants -> destroy; packets EXACTLY the frozen contents; zero row content', async () => {
    const result = await runOfflineRehearsal(docker, { repoRoot: REPO, ...PATHS, ...FIXTURE_REHEARSAL })
    const { backup_packet: packet, restore_proof: proof, rehearsal_record: record } = result.bundle
    expect(record.verdict_reasons).toEqual([])
    expect(record.verdict).toBe('OFFLINE_REHEARSAL_PASS')
    expect(result.evidenceViolations).toEqual([])
    expect(result.forbiddenHits).toBe(0)
    expect(packet).not.toBeNull()
    expect(proof).not.toBeNull()
    // B-1, on the REAL emitted evidence.
    expect(Object.keys(packet!)).toEqual(frozenPacketContents('BACKUP_PACKET'))
    expect(Object.keys(proof!)).toEqual(frozenPacketContents('RESTORE_PROOF'))
    expect(validateBackupPacket(packet)).toEqual([])
    // OR-P5: every invariant evaluated, with raw facts, and only the accepted UNKNOWN.
    const invariants = proof![VERIFICATION_RESULTS].invariants
    const byId = Object.fromEntries(invariants.map((r) => [r.id, r]))
    expect(Object.keys(byId).sort()).toEqual(['EXT', 'PRI-1', 'PRI-2', 'PRI-2-CAP', 'PRI-3', 'PRI-4', 'PRI-5', 'PRI-6', 'PRI-7', 'PROBE-ROLLBACK', 'SEQ', 'TRG'])
    for (const r of invariants) expect(r.verdict, r.id).toBe(r.id === 'PRI-7' ? 'UNKNOWN' : 'PASS')
    expect(byId['PRI-5'].observed).toEqual(['public.fixture_audit:rows=2', 'public.fixture_member:rows=5', 'public.fixture_org:rows=3', 'uellix_provisioning.applied_units:rows=4'])
    expect(byId['PROBE-ROLLBACK'].observed).toContain('nontransactional_sequence_advance:public.fixture_audit_id_seq:from=2:to=3')
    expect(record.restore_steps.map((s) => [s.step, s.status])).toEqual([
      ['TOC', 'SUCCESS'],
      ['ROLES_CORPUS', 'SUCCESS'],
      ['CREATE_DATABASE', 'SUCCESS'],
      ['TOC_SELECTION', 'SUCCESS'],
      ['PG_RESTORE', 'SUCCESS'],
      ['POST_RESTORE_CORPUS', 'SUCCESS'],
    ])
    // NB-7: observed, not restated — inspect reported these at restore time.
    const target = proof![RESTORED_INTO]
    expect(target.image_id_observed).toBe(RECOVERY_TOOL_PIN.imageId)
    expect(target.network_mode_observed).toBe('none')
    expect(target.engine).toMatchObject({ substrate_server_version_num: 170006, source_server_version_num: 170006, source_image_id_observed: RECOVERY_TOOL_PIN.imageId })
    // OR-P6: both substrates destroyed and proven absent; artifact disposed.
    expect(target.destruction.verdict).toBe('DESTROYED_AND_VERIFIED_ABSENT')
    expect(record.other_destructions.map((x) => [x.role, x.verdict])).toEqual([['source-fixture', 'DESTROYED_AND_VERIFIED_ABSENT']])
    expect(record.artifact_disposal.verdict).toBe('DISPOSED_AND_VERIFIED_ABSENT')
    expect(labelled(record.run_id)).toEqual({ containers: '', volumes: '' })
    // Privacy (DP-5, SENT-ROW-CANARY), NB-1 (no stderr digest anywhere) and CL-3.
    expect(noCanary(result.bundle)).toEqual([])
    expect(JSON.stringify(result.bundle)).not.toMatch(/stderr/)
    expect(gitStatus()).toBe(statusBefore)
  })

  it('NB-5 premise: WITHOUT the post-restore corpus the TOC-selected restore keeps public\'s initdb ACL — PRI-2 passes, no DROP was ever needed', async () => {
    const result = await runOfflineRehearsal(docker, { repoRoot: REPO, ...PATHS, ...FIXTURE_REHEARSAL, postRestoreCorpusPath: null })
    const { restore_proof: proof, rehearsal_record: record } = result.bundle
    expect(record.restore_steps.find((s) => s.step === 'POST_RESTORE_CORPUS')?.status).toBe('SKIPPED')
    expect(record.restore_steps.find((s) => s.step === 'TOC_SELECTION')?.status).toBe('SUCCESS')
    const inv = Object.fromEntries(proof![VERIFICATION_RESULTS].invariants.map((r) => [r.id, r]))
    expect(inv['PRI-2'].verdict).toBe('PASS')
    expect(inv['PRI-2-CAP'].verdict).toBe('PASS')
    expect(record.verdict).toBe('OFFLINE_REHEARSAL_PASS')
    expect(noCanary(result.bundle)).toEqual([])
  })

  describe('sabotage and refusal battery over ONE real capture', () => {
    let runId = ''
    let artifactDir = ''
    const created: Substrate[] = []
    const proofs: DestructionProof[] = []
    let source: Substrate
    let target: Substrate
    let packet: BackupPacket
    let census: SourceCensusRecord
    let artifactPath: string
    let restore: RestoreOutcome
    let cloneSeq = 0
    const probes = FIXTURE_REHEARSAL.capabilityProbes

    const track = (s: Substrate) => (created.push(s), s)
    const clone = () => {
      const name = `sabotage_${++cloneSeq}`
      expect(substratePsql(docker, target, 'postgres', `CREATE DATABASE ${name} TEMPLATE pristine_copy;\n`).status).toBe(0)
      return name
    }
    const invariantsOn = (db: string) => {
      const run = runPostRestoreInvariants(docker, { substrate: target, database: db, packet, sourceCensus: census, restore, capabilityProbes: probes })
      if (!run.ok) throw new Error(`invariant run refused: ${run.refusal}`)
      return run.results
    }
    const corruptCopy = (label: string, mutate: (b: Buffer) => void, recomputeDigest: boolean) => {
      const bytes = readFileSync(artifactPath)
      mutate(bytes)
      const p = path.join(artifactDir, `${label}.dump`)
      writeFileSync(p, bytes)
      const sha = createHash('sha256').update(bytes).digest('hex')
      const pk: BackupPacket = recomputeDigest ? { ...packet, 'backup identifier': { ...packet['backup identifier'], content_digest: `sha256:${sha}` } } : packet
      return { p, pk }
    }
    const restoreReq = (s: Substrate, pk: BackupPacket, p: string, post: string | null) => ({
      target: s.identity,
      substrate: s,
      packet: pk,
      sourceCensus: census,
      artifactPath: p,
      repoRoot: REPO,
      rolesCorpusPath: PATHS.fixtureRolesPath,
      postRestoreCorpusPath: post,
    })
    const captureReq = () => ({
      source: source.identity,
      database: SOURCE_DATABASE,
      principal: FIXTURE_REHEARSAL.principal,
      scope: FIXTURE_REHEARSAL.scope,
      eventClass: null,
      declaredClassification: 'SYNTHETIC_FIXTURE' as const,
      artifactDir,
      repoRoot: REPO,
    })

    beforeAll(async () => {
      runId = newRunId()
      artifactDir = mkdtempSync(path.join(tmpdir(), 'uellix-recovery-battery-'))
      source = track(createSubstrate(docker, { runId, role: 'source-fixture' }))
      loadSyntheticSource(docker, source, PATHS.fixtureRolesPath, PATHS.fixtureSourcePath)
      const capture = await captureLogicalBackup(docker, captureReq())
      if (!capture.ok) throw new Error(`capture failed: ${capture.code}`)
      packet = capture.packet
      census = capture.sourceCensus
      artifactPath = capture.artifactPath
      target = track(createSubstrate(docker, { runId, role: 'restore-substrate' }))
      restore = await restoreIntoSubstrate(docker, restoreReq(target, packet, artifactPath, PATHS.postRestoreCorpusPath))
      if (!restore.ok) throw new Error(`restore failed: ${restore.refusal}`)
      // A PRISTINE copy, taken before ANY invariant run: the capability probe is
      // mutating and advances a sequence non-transactionally (measured), so a
      // database that has been probed is no longer a faithful copy of the source.
      expect(substratePsql(docker, target, 'postgres', `CREATE DATABASE pristine_copy TEMPLATE ${restore.restore_database};\n`).status).toBe(0)
    }, 600_000)

    afterAll(() => {
      for (const s of created.reverse()) proofs.push(destroySubstrate(docker, s))
      const disposal = disposeArtifact(artifactDir || null, packet ? packet['backup identifier'].content_digest.slice(7) : null)
      expect(proofs.every((p) => p.verdict === 'DESTROYED_AND_VERIFIED_ABSENT')).toBe(true)
      expect(disposal.verdict).toBe('DISPOSED_AND_VERIFIED_ABSENT')
      expect(labelled(runId)).toEqual({ containers: '', volumes: '' })
    }, 300_000)

    it('sanity: the unsabotaged restore passes every invariant but PRI-7', () => {
      expect(invariantsOn(restore.restore_database!).filter((r) => r.verdict !== 'PASS').map((r) => r.id)).toEqual(['PRI-7'])
    })

    it.each<[string, string, string[]]>([
      ['OR-N6 missing PUBLIC USAGE', 'REVOKE USAGE ON SCHEMA public FROM PUBLIC;', ['PRI-2', 'PRI-2-CAP']],
      ['OR-N7 extension missing', 'DROP EXTENSION pg_trgm CASCADE;', ['EXT']],
      ['OR-N8 trigger state wrong', 'ALTER TABLE public.fixture_member DISABLE TRIGGER fixture_member_stamp;', ['TRG']],
      ['OR-N8 disabled trigger re-enabled', 'ALTER TABLE public.fixture_org ENABLE TRIGGER fixture_org_stamp_disabled;', ['TRG']],
      ['OR-N9 FORCE RLS dropped', 'ALTER TABLE public.fixture_member NO FORCE ROW LEVEL SECURITY;', ['PRI-6']],
      ['OR-N15 sequence reset', "SELECT setval('public.fixture_member_id_seq', 1);", ['SEQ']],
      ['PRI-5 a row lost', 'DELETE FROM public.fixture_audit WHERE id = 1;', ['PRI-5']],
      ['PRI-4 journal diverged', "UPDATE uellix_provisioning.applied_units SET status = 'FAILED' WHERE id = 4;", ['PRI-4']],
    ])('%s -> exactly the named invariants FAIL', (_label, sabotage, expected) => {
      const db = clone()
      expect(substratePsql(docker, target, db, `${sabotage}\n`).status).toBe(0)
      const results = invariantsOn(db)
      expect(results.filter((r) => r.verdict === 'FAIL').map((r) => r.id).sort()).toEqual([...expected].sort())
      expect(noCanary(results)).toEqual([])
    })

    it('OR-N5 / RR-CAP-7: every restore step exited 0, the defect is INDUCED, DETECTED, then REPAIRED by the post-restore corpus', () => {
      expect(restore.steps.every((s) => s.status === 'SUCCESS')).toBe(true)
      const db = clone()
      expect(substratePsql(docker, target, db, 'REVOKE USAGE ON SCHEMA public FROM PUBLIC;\n').status).toBe(0)
      const broken = Object.fromEntries(invariantsOn(db).map((r) => [r.id, r]))
      expect(broken['PRI-2']).toMatchObject({ verdict: 'FAIL', reason_code: 'RR_CAP_7_PUBLIC_USAGE_ABSENT' })
      expect(broken['PRI-2-CAP'].observed).toEqual(['fixture_capability:public.fixture_capability_probe:exit=3:sqlstate=42501'])
      // Repair on a fresh clone of the same defect (the first was probed).
      const db2 = clone()
      expect(substratePsql(docker, target, db2, 'REVOKE USAGE ON SCHEMA public FROM PUBLIC;\n').status).toBe(0)
      expect(substratePsql(docker, target, db2, readFileSync(PATHS.postRestoreCorpusPath, 'utf8')).status).toBe(0)
      const repaired = Object.fromEntries(invariantsOn(db2).map((r) => [r.id, r]))
      expect(repaired['PRI-2'].verdict).toBe('PASS')
      expect(repaired['PRI-2-CAP'].verdict).toBe('PASS')
    })

    it('OR-N20: a second restore into the same (now populated) cluster is refused as not role-pristine', async () => {
      const again = await restoreIntoSubstrate(docker, restoreReq(target, packet, artifactPath, null))
      expect(again).toMatchObject({ ok: false, refusal: 'RESTORE_SUBSTRATE_NOT_ROLE_PRISTINE' })
    })

    it('OR-N3: restoring into the SOURCE container of the same run is refused', async () => {
      const out = await restoreIntoSubstrate(docker, { ...restoreReq(source, packet, artifactPath, null), target: source.identity })
      expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_TARGET_OWNERSHIP_REFUSED', refusal_detail: 'SUBSTRATE_NOT_OWNED_BY_RUN' })
    })

    it('OR-N2: artifact bytes that differ from the packet digest are refused before restore', async () => {
      const { p, pk } = corruptCopy('digest-mismatch', (b) => (b[b.length - 10] ^= 0xff), false)
      const out = await restoreIntoSubstrate(docker, restoreReq(target, pk, p, null))
      expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_ARTIFACT_INTEGRITY_REFUSED', refusal_detail: 'ARTIFACT_DIGEST_MISMATCH' })
    })

    it('OR-N1: a header-corrupted artifact is refused structurally even when its digest was recomputed to match', async () => {
      const { p, pk } = corruptCopy('header-corrupt', (b) => b.fill(0x41, 0, 5), true)
      const out = await restoreIntoSubstrate(docker, restoreReq(target, pk, p, null))
      expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_ARTIFACT_STRUCTURE_REFUSED' })
    })

    it('OR-N1: a data-corrupted artifact (digest recomputed) never yields a successful restore', async () => {
      const fresh = track(createSubstrate(docker, { runId, role: 'restore-substrate' }))
      const { p, pk } = corruptCopy('data-corrupt', (b) => b.fill(0x00, b.length - 400, b.length - 40), true)
      const out = await restoreIntoSubstrate(docker, restoreReq(fresh, pk, p, PATHS.postRestoreCorpusPath))
      expect(out.ok).toBe(false)
      expect(['RESTORE_STEP_FAILED', 'RESTORE_ARTIFACT_STRUCTURE_REFUSED']).toContain(out.refusal)
      expect(noCanary(out)).toEqual([])
    })

    it('NB-3 real: bytes swapped AFTER validation and TOC, DURING the pg_restore stream -> STOP (real Docker, real pg_restore)', async () => {
      const fresh = track(createSubstrate(docker, { runId, role: 'restore-substrate' }))
      const copy = path.join(artifactDir, 'toctou.dump')
      copyFileSync(artifactPath, copy)
      const tamper: DockerCli = {
        ...docker,
        run: docker.run,
        runWithEnv: docker.runWithEnv,
        streamToFile: docker.streamToFile,
        streamFromFile: (args, file) => {
          if (args.includes('-d')) {
            const bytes = readFileSync(file)
            bytes[bytes.length - 20] ^= 0xff
            writeFileSync(file, bytes)
          }
          return docker.streamFromFile(args, file)
        },
      }
      const out = await restoreIntoSubstrate(tamper, restoreReq(fresh, packet, copy, PATHS.postRestoreCorpusPath))
      expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_STREAM_DIGEST_MISMATCH' })
      expect(out.steps.map((s) => s.step)).not.toContain('POST_RESTORE_CORPUS')
    })

    it('OR-N21 / NB-1: a restore error that QUOTES a row value leaves only a closed diagnostic in evidence', async () => {
      const db = clone()
      const prep = "TRUNCATE public.fixture_member;\nALTER TABLE public.fixture_member ADD CONSTRAINT no_canary CHECK (display NOT LIKE 'CANARY%') NOT VALID;\n"
      expect(substratePsql(docker, target, db, prep).status).toBe(0)
      const res = await runPgRestore(docker, target, db, artifactPath, ['--data-only', '-n', 'public', '-t', 'fixture_member'])
      expect(res.status).not.toBe(0)
      // The raw stderr really does carry a row value — otherwise this proves nothing.
      expect(CANARIES.some((c) => res.stderr.includes(c))).toBe(true)
      const outcome = classifyToolOutcome(res.status, res.stderr)
      const step = { step: 'PG_RESTORE', status: 'FAILED', exit_code: outcome.exit_code, diagnostic: outcome.diagnostic, input_sha256: res.sha256 }
      expect(validateEvidence(step, RESTORE_STEP_SHAPE)).toEqual([])
      expect(noCanary(step)).toEqual([])
      expect(JSON.stringify(step)).not.toContain(createHash('sha256').update(res.stderr).digest('hex'))
    })

    it('OR-N7 at capture: a scope that omits a depended-upon extension is refused and leaves no artifact', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'uellix-recovery-noext-'))
      try {
        const out = await captureLogicalBackup(docker, { ...captureReq(), scope: { ...FIXTURE_REHEARSAL.scope, extensions: [] }, artifactDir: dir })
        expect(out).toMatchObject({ ok: false, code: 'CAPTURE_SCOPE_EXTENSION_UNDECLARED' })
        expect(readdirSync(dir)).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('OR-P7 real: two captures differing only in event_class agree on everything but the carried value', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'uellix-recovery-evclass-'))
      try {
        const other = await captureLogicalBackup(docker, { ...captureReq(), eventClass: 'S1_CORPUS_NO_NEW_RUNTIME', artifactDir: dir })
        expect(other.ok).toBe(true)
        if (!other.ok) return
        expect(other.packet[NO_MUTATION_CONFIRMATION].the_change_it_precedes.event_class).toEqual({ value: 'S1_CORPUS_NO_NEW_RUNTIME', policy: 'NOT_CHOSEN_BY_THIS_MECHANISM' })
        expect(packet[NO_MUTATION_CONFIRMATION].the_change_it_precedes.event_class.value).toBeNull()
        for (const k of ['target identifier', 'the method used', 'the scope covered'] as const) expect(other.packet[k]).toEqual(packet[k])
        expect(other.packet[NO_MUTATION_CONFIRMATION].capture_census).toEqual(packet[NO_MUTATION_CONFIRMATION].capture_census)
        expect(other.sourceCensus).toEqual(census)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('OR-N19 real: a superuser principal and a principal without BYPASSRLS are refused before any row is read', async () => {
      const su = await captureLogicalBackup(docker, { ...captureReq(), principal: { roleName: 'supabase_admin', provenance: 'LOCAL_DISPOSABLE_FIXTURE_ROLE' } })
      expect(su).toMatchObject({ ok: false, code: 'CAPTURE_PRINCIPAL_REFUSED' })
      expect(su.ok ? [] : su.principalRefusals).toContain('PRINCIPAL_SUPERUSER')
      expect(substratePsql(docker, source, SOURCE_DATABASE, 'CREATE ROLE recovery_capture_nobypass LOGIN; GRANT pg_read_all_data TO recovery_capture_nobypass;\n').status).toBe(0)
      const nb = await captureLogicalBackup(docker, { ...captureReq(), principal: { roleName: 'recovery_capture_nobypass', provenance: 'LOCAL_DISPOSABLE_FIXTURE_ROLE' } })
      expect(nb.ok ? [] : nb.principalRefusals).toEqual(['PRINCIPAL_NO_BYPASSRLS_WITH_RLS_IN_SCOPE'])
    })
  })

  describe('B-STREAM-1 real: a MULTI-CHUNK artifact (MiB-scale), intact and under TOCTOU', () => {
    let runId = ''
    let dir = ''
    const created: Substrate[] = []
    let source: Substrate
    let packet: BackupPacket
    let census: SourceCensusRecord
    let artifactPath = ''
    const BULK_ROWS = 200_000
    const BULK_SQL = `CREATE TABLE public.fixture_bulk (id bigint PRIMARY KEY, payload text NOT NULL);
ALTER TABLE public.fixture_bulk OWNER TO fixture_app_owner;
INSERT INTO public.fixture_bulk SELECT i, md5(i::text) || md5((i * 7919)::text) FROM generate_series(1, ${BULK_ROWS}) i;
`
    const patch = (file: string, offset: number) => {
      const fd = openSync(file, 'r+')
      writeSync(fd, Buffer.from('TAMPERED'), 0, 8, offset)
      closeSync(fd)
    }
    const copy = (name: string) => {
      const p = path.join(dir, name)
      copyFileSync(artifactPath, p)
      return p
    }
    const req = (s: Substrate, p: string) => ({
      target: s.identity,
      substrate: s,
      packet,
      sourceCensus: census,
      artifactPath: p,
      repoRoot: REPO,
      rolesCorpusPath: PATHS.fixtureRolesPath,
      postRestoreCorpusPath: PATHS.postRestoreCorpusPath,
    })
    /** Real docker, with the file tampered just before the TOC pass or the restore pass starts. */
    const tamperOn = (pass: 'TOC' | 'RESTORE', file: string, offset: number): DockerCli => ({
      ...docker,
      streamFromFile: (args, f, hooks) => {
        const isRestore = args.includes('-d')
        if ((pass === 'TOC' && !isRestore) || (pass === 'RESTORE' && isRestore)) patch(file, offset)
        return docker.streamFromFile(args, f, hooks)
      },
    })

    beforeAll(async () => {
      runId = newRunId()
      dir = mkdtempSync(path.join(tmpdir(), 'uellix-recovery-multichunk-'))
      source = createSubstrate(docker, { runId, role: 'source-fixture' })
      created.push(source)
      loadSyntheticSource(docker, source, PATHS.fixtureRolesPath, PATHS.fixtureSourcePath)
      expect(substratePsql(docker, source, SOURCE_DATABASE, BULK_SQL).status).toBe(0)
      const cap = await captureLogicalBackup(docker, {
        source: source.identity,
        database: SOURCE_DATABASE,
        principal: FIXTURE_REHEARSAL.principal,
        scope: FIXTURE_REHEARSAL.scope,
        eventClass: null,
        declaredClassification: 'SYNTHETIC_FIXTURE',
        artifactDir: dir,
        repoRoot: REPO,
      })
      if (!cap.ok) throw new Error(`capture failed: ${cap.code}`)
      packet = cap.packet
      census = cap.sourceCensus
      artifactPath = cap.artifactPath
    }, 600_000)

    afterAll(() => {
      const proofs = created.reverse().map((s) => destroySubstrate(docker, s))
      rmSync(dir, { recursive: true, force: true })
      expect(proofs.every((p) => p.verdict === 'DESTROYED_AND_VERIFIED_ABSENT')).toBe(true)
      expect(labelled(runId)).toEqual({ containers: '', volumes: '' })
    }, 300_000)

    it('guard: the artifact spans MANY 64 KiB read chunks (MiB-scale)', () => {
      expect(statSync(artifactPath).size).toBeGreaterThan(4 * 1024 * 1024)
    })

    it('TOCTOU before TOC: bytes changed after validation, before the TOC pass -> STOP at TOC; then the INTACT multi-chunk artifact restores and verifies on the same (still pristine) substrate', async () => {
      const s = createSubstrate(docker, { runId, role: 'restore-substrate' })
      created.push(s)
      const p = copy('before-toc.dump')
      const out = await restoreIntoSubstrate(tamperOn('TOC', p, 3 * 1024 * 1024), req(s, p))
      expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_STREAM_DIGEST_MISMATCH' })
      expect(out.steps.map((x) => x.step)).toEqual(['TOC'])
      const intact = await restoreIntoSubstrate(docker, req(s, artifactPath))
      expect(intact.refusal).toBeNull()
      expect(intact.steps.every((x) => x.status === 'SUCCESS')).toBe(true)
      expect(intact.steps.find((x) => x.step === 'TOC')!.input_sha256).toBe(packet['backup identifier'].content_digest.slice(7))
      const run = runPostRestoreInvariants(docker, { substrate: s, database: intact.restore_database!, packet, sourceCensus: census, restore: intact, capabilityProbes: FIXTURE_REHEARSAL.capabilityProbes })
      expect(run.ok).toBe(true)
      if (!run.ok) return
      expect(run.results.filter((r) => r.verdict !== 'PASS').map((r) => r.id)).toEqual(['PRI-7'])
      expect(run.results.find((r) => r.id === 'PRI-5')!.observed).toContain(`public.fixture_bulk:rows=${BULK_ROWS}`)
    })

    it('TOCTOU after TOC, before restore: bytes changed between the passes -> STOP at PG_RESTORE, no post-restore step', async () => {
      const s = createSubstrate(docker, { runId, role: 'restore-substrate' })
      created.push(s)
      const p = copy('after-toc.dump')
      const out = await restoreIntoSubstrate(tamperOn('RESTORE', p, statSync(p).size - 4096), req(s, p))
      expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_STREAM_DIGEST_MISMATCH' })
      expect(out.steps.at(-1)?.step).toBe('PG_RESTORE')
    })

    it('TOCTOU during restore: bytes changed AHEAD of the read position mid-pass -> STOP', async () => {
      const s = createSubstrate(docker, { runId, role: 'restore-substrate' })
      created.push(s)
      const p = copy('during.dump')
      const size = statSync(p).size
      let fired = false
      const midStream: DockerCli = {
        ...docker,
        streamFromFile: (args, f, hooks) =>
          docker.streamFromFile(args, f, {
            ...hooks,
            afterChunk: (hashed) => {
              if (args.includes('-d') && !fired && hashed >= 1024 * 1024) {
                fired = true
                patch(p, size - 4096)
              }
            },
          }),
      }
      const out = await restoreIntoSubstrate(midStream, req(s, p))
      expect(fired).toBe(true)
      expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_STREAM_DIGEST_MISMATCH' })
    })
  })

  it("OR-N11 real: a container carrying this run's labels but on the bridge network is refused as a substrate", async () => {
    const runId = newRunId()
    const name = `uellix-recovery-bridged-${runId}`
    try {
      const run = d(['run', '-d', '--name', name, '--label', `${RUN_LABEL}=${runId}`, '--label', `${ROLE_LABEL}=restore-substrate`, '--entrypoint', 'sleep', RECOVERY_TOOL_PIN.imageId, '300'])
      expect(run.status).toBe(0)
      const identity = { identityClass: 'LOCAL_DISPOSABLE' as const, containerId: run.stdout.trim(), containerName: name, runId, role: 'restore-substrate' as const, imageId: RECOVERY_TOOL_PIN.imageId }
      expect(() => assertSubstrateOwnership(docker, identity, 'restore-substrate')).toThrow(/SUBSTRATE_NETWORK_NOT_ISOLATED/)
    } finally {
      d(['rm', '-f', '-v', name])
    }
    expect(labelled(runId)).toEqual({ containers: '', volumes: '' })
  })

  it('OR-N4 real: a source on the clean-room skew build 17.6.1.143 is refused at capture as a tool-pin skew', async () => {
    const runId = newRunId()
    const dir = mkdtempSync(path.join(tmpdir(), 'uellix-recovery-skew-'))
    let skewed: Substrate | null = null
    try {
      try {
        skewed = createSubstrate(docker, { runId, role: 'source-fixture', pin: SKEW_IMAGE })
      } catch (e) {
        if (e instanceof SubstrateRefusal && e.partial) skewed = e.partial
        throw e
      }
      const out = await captureLogicalBackup(docker, {
        source: skewed.identity,
        database: 'postgres',
        principal: FIXTURE_REHEARSAL.principal,
        scope: FIXTURE_REHEARSAL.scope,
        eventClass: null,
        declaredClassification: 'SYNTHETIC_FIXTURE',
        artifactDir: dir,
        repoRoot: REPO,
      })
      expect(out).toMatchObject({ ok: false, code: 'CAPTURE_TOOL_PIN_REFUSED', toolRefusals: [{ code: 'TOOL_IMAGE_ID_MISMATCH', field: 'imageId' }] })
      expect(readdirSync(dir)).toEqual([])
    } finally {
      if (skewed) expect(destroySubstrate(docker, skewed).verdict).toBe('DESTROYED_AND_VERIFIED_ABSENT')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CL-3: the working tree carries no artifact, dump or extract after the whole battery', () => {
    expect(gitStatus()).toBe(statusBefore)
  })
})

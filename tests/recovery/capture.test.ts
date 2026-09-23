// @vitest-environment node
// tests/recovery/capture.test.ts — OR-N18 (hosted capture refused), OR-N19
// (capture principal verification), scope closure. No hosted contact: a hosted
// identity here is a classified structural value and the fake docker proves
// that NOTHING is invoked for it.

import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { captureLogicalBackup, evaluatePrincipal, scopeClosureProblem, type CaptureRequest, type PrincipalObservation } from '../../scripts/recovery/capture'
import type { DeclaredScope } from '../../scripts/recovery/artifact-packet'
import { FakeDocker } from './fake-docker'
import { sampleCensus } from './sample-evidence'

const REPO = path.resolve(import.meta.dirname, '../..')
const scope: DeclaredScope = { schemas: ['public', 'uellix_provisioning'], excluded_relations: [], extensions: ['pg_trgm'], storage_object_bytes: 'OUT_OF_SCOPE' }

const base: CaptureRequest = {
  source: { identityClass: 'HOSTED_STAGING', projectRef: 'bvyzblhqymxruxdguaee', signals: ['declared-environment', 'host-derived-project-ref', 'in-database-sentinel'], sentinelDeferred: false },
  database: 'postgres',
  principal: { roleName: 'recovery_capture_ro', provenance: 'LOCAL_DISPOSABLE_FIXTURE_ROLE' },
  scope,
  eventClass: null,
  declaredClassification: 'SYNTHETIC_FIXTURE',
  artifactDir: tmpdir(),
  repoRoot: REPO,
}

const readOnly: PrincipalObservation = {
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
}

describe('OR-N18: capture from a hosted identity', () => {
  it('is refused by this mechanism, and not one docker call is issued', async () => {
    const fake = new FakeDocker()
    const out = await captureLogicalBackup(fake, base)
    expect(out).toMatchObject({ ok: false, code: 'RECOVERY_HOSTED_CAPTURE_NOT_AUTHORIZED' })
    expect(fake.calls).toEqual([])
  })

  it('an AUTHORITY_SUPPLIED principal is refused today even for a local source', async () => {
    const fake = new FakeDocker()
    const local = { identityClass: 'LOCAL_DISPOSABLE' as const, containerId: 'c'.repeat(64), containerName: 'x', runId: 'abcdef0123456789', role: 'source-fixture' as const, imageId: 'sha256:' + '0'.repeat(64) }
    const out = await captureLogicalBackup(fake, { ...base, source: local, principal: { roleName: 'recovery_capture_ro', provenance: 'AUTHORITY_SUPPLIED' } })
    expect(out).toMatchObject({ ok: false, code: 'CAPTURE_PRINCIPAL_PROVENANCE_REFUSED' })
    expect(fake.calls).toEqual([])
  })

  it('refuses non-identifier scope tokens and non-code event classes before any docker call', async () => {
    const fake = new FakeDocker()
    const local = { identityClass: 'LOCAL_DISPOSABLE' as const, containerId: 'c'.repeat(64), containerName: 'x', runId: 'abcdef0123456789', role: 'source-fixture' as const, imageId: 'sha256:' + '0'.repeat(64) }
    for (const bad of [{ scope: { ...scope, schemas: ['public;drop'] } }, { eventClass: 'quiesce please' }, { database: 'db name' }]) {
      const out = await captureLogicalBackup(fake, { ...base, source: local, ...bad })
      expect(out).toMatchObject({ ok: false, code: 'CAPTURE_REQUEST_GRAMMAR' })
    }
    expect(fake.calls).toEqual([])
  })
})

describe('OR-N19: capture principal verification', () => {
  it('a read-only, BYPASSRLS, non-superuser principal passes', () => {
    expect(evaluatePrincipal('recovery_capture_ro', readOnly)).toEqual([])
  })

  it.each<[keyof PrincipalObservation, unknown, string]>([
    ['rolsuper', true, 'PRINCIPAL_SUPERUSER'],
    ['rolcreaterole', true, 'PRINCIPAL_CAN_CREATE_ROLES_OR_DATABASES'],
    ['rolcreatedb', true, 'PRINCIPAL_CAN_CREATE_ROLES_OR_DATABASES'],
    ['write_all_member', true, 'PRINCIPAL_WRITE_ALL_DATA_MEMBER'],
    ['write_privileged_relations', 1, 'PRINCIPAL_WRITE_PRIVILEGE_IN_SCOPE'],
    ['schema_create', 1, 'PRINCIPAL_CREATE_ON_SCOPE_SCHEMA'],
    ['unselectable_relations', 2, 'PRINCIPAL_CANNOT_READ_SCOPE'],
    ['schema_no_usage', 1, 'PRINCIPAL_CANNOT_READ_SCOPE'],
    ['rolbypassrls', false, 'PRINCIPAL_NO_BYPASSRLS_WITH_RLS_IN_SCOPE'],
    ['relation_count', 0, 'PRINCIPAL_SCOPE_EMPTY'],
    ['role', 'uellix_app', 'PRINCIPAL_IDENTITY_MISMATCH'],
  ])('%s = %j is refused as %s', (field, value, code) => {
    expect(evaluatePrincipal('recovery_capture_ro', { ...readOnly, [field]: value })).toContain(code)
  })

  it('BYPASSRLS is not demanded when no in-scope relation has RLS', () => {
    expect(evaluatePrincipal('recovery_capture_ro', { ...readOnly, rolbypassrls: false, rls_relations: 0 })).toEqual([])
  })

  it('every failing predicate is reported, not only the first', () => {
    expect(evaluatePrincipal('recovery_capture_ro', { ...readOnly, rolsuper: true, write_privileged_relations: 3 })).toEqual(['PRINCIPAL_SUPERUSER', 'PRINCIPAL_WRITE_PRIVILEGE_IN_SCOPE'])
  })
})

describe('scope closure', () => {
  it('passes when every depended-upon extension is declared and every declared schema exists', () => {
    expect(scopeClosureProblem(scope, sampleCensus())).toBeNull()
  })

  it('OR-N7: an in-scope object depending on an undeclared extension is refused at capture time', () => {
    expect(scopeClosureProblem({ ...scope, extensions: [] }, sampleCensus())).toMatchObject({ ok: false, code: 'CAPTURE_SCOPE_EXTENSION_UNDECLARED' })
  })

  it('a declared extension or schema that does not exist is refused', () => {
    expect(scopeClosureProblem({ ...scope, extensions: ['pg_trgm', 'citext'] }, sampleCensus())).toMatchObject({ code: 'CAPTURE_SCOPE_EXTENSION_ABSENT' })
    expect(scopeClosureProblem({ ...scope, schemas: ['public', 'storage'] }, sampleCensus())).toMatchObject({ code: 'CAPTURE_SCOPE_SCHEMA_ABSENT' })
  })
})

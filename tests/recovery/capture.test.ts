// @vitest-environment node
// tests/recovery/capture.test.ts — OR-N18 (hosted capture refused), OR-N19 and
// NB-2 (capture principal verification closed under SET ROLE reachability),
// scope closure. No hosted contact: a hosted identity here is a classified
// structural value and the fake docker proves NOTHING is invoked for it.
// The same predicates against real roles: tests/recovery/principal-reachability.pg.test.ts.

import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  captureLogicalBackup,
  evaluatePrincipal,
  HOSTED_PRINCIPAL_STATUS,
  PRINCIPAL_SQL,
  scopeClosureProblem,
  type CaptureRequest,
  type PrincipalObservation,
  type ReachableRole,
} from '../../scripts/recovery/capture'
import type { DeclaredScope } from '../../scripts/recovery/artifact-packet'
import { FakeDocker } from './fake-docker'
import { sampleCensus } from './sample-evidence'

const REPO = path.resolve(import.meta.dirname, '../..')
const scope: DeclaredScope = { schemas: ['public', 'uellix_provisioning'], excluded_relations: [], extensions: ['pg_trgm'] }

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

const readAllData: ReachableRole = { name: 'pg_read_all_data', rolsuper: false, rolcreaterole: false, rolcreatedb: false, write_privileged_relations: 0, schema_create: 0 }
const writer: ReachableRole = { name: 'w_set', rolsuper: false, rolcreaterole: false, rolcreatedb: false, write_privileged_relations: 1, schema_create: 0 }

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
  reachable_roles: [readAllData],
}

const local = { identityClass: 'LOCAL_DISPOSABLE' as const, containerId: 'c'.repeat(64), containerName: 'x', runId: 'abcdef0123456789', role: 'source-fixture' as const, imageId: 'sha256:' + '0'.repeat(64) }

describe('OR-N18: capture from a hosted identity', () => {
  it('is refused with the hosted principal BLOCKED_PENDING_AUTHORIZED_REACHABILITY_PROOF, and not one docker call is issued', async () => {
    const fake = new FakeDocker()
    const out = await captureLogicalBackup(fake, base)
    expect(out).toMatchObject({ ok: false, code: 'RECOVERY_HOSTED_CAPTURE_NOT_AUTHORIZED', hostedPrincipalStatus: 'BLOCKED_PENDING_AUTHORIZED_REACHABILITY_PROOF' })
    expect(HOSTED_PRINCIPAL_STATUS).toBe('BLOCKED_PENDING_AUTHORIZED_REACHABILITY_PROOF')
    expect(fake.calls).toEqual([])
  })

  it('an AUTHORITY_SUPPLIED principal is refused today even for a local source', async () => {
    const fake = new FakeDocker()
    const out = await captureLogicalBackup(fake, { ...base, source: local, principal: { roleName: 'recovery_capture_ro', provenance: 'AUTHORITY_SUPPLIED' } })
    expect(out).toMatchObject({ ok: false, code: 'CAPTURE_PRINCIPAL_PROVENANCE_REFUSED', hostedPrincipalStatus: HOSTED_PRINCIPAL_STATUS })
    expect(fake.calls).toEqual([])
  })

  it('refuses non-identifier scope tokens and non-code event classes before any docker call', async () => {
    const fake = new FakeDocker()
    for (const bad of [{ scope: { ...scope, schemas: ['public;drop'] } }, { eventClass: 'quiesce please' }, { database: 'db name' }]) {
      const out = await captureLogicalBackup(fake, { ...base, source: local, ...bad })
      expect(out).toMatchObject({ ok: false, code: 'CAPTURE_REQUEST_GRAMMAR' })
    }
    expect(fake.calls).toEqual([])
  })
})

describe('OR-N19: direct capture principal predicates', () => {
  it('a read-only, BYPASSRLS, non-superuser principal reaching only pg_read_all_data passes', () => {
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
})

describe('NB-2: the principal is judged by every role it can BECOME', () => {
  it('a reachable writer role (e.g. granted WITH INHERIT FALSE, SET TRUE) is refused although every direct predicate passes', () => {
    expect(evaluatePrincipal('recovery_capture_ro', { ...readOnly, reachable_roles: [readAllData, writer] })).toEqual(['PRINCIPAL_REACHES_WRITE_PRIVILEGE'])
  })

  it.each<[Partial<ReachableRole>, string]>([
    [{ rolsuper: true }, 'PRINCIPAL_REACHES_SUPERUSER'],
    [{ rolcreaterole: true }, 'PRINCIPAL_REACHES_ROLE_OR_DB_CREATOR'],
    [{ rolcreatedb: true }, 'PRINCIPAL_REACHES_ROLE_OR_DB_CREATOR'],
    [{ schema_create: 1 }, 'PRINCIPAL_REACHES_CREATE_ON_SCOPE_SCHEMA'],
  ])('a reachable role with %j is refused as %s', (props, code) => {
    const role: ReachableRole = { name: 'nested_mid', rolsuper: false, rolcreaterole: false, rolcreatedb: false, write_privileged_relations: 0, schema_create: 0, ...props }
    expect(evaluatePrincipal('recovery_capture_ro', { ...readOnly, reachable_roles: [role] })).toContain(code)
  })

  it.each([['pg_write_all_data'], ['pg_execute_server_program'], ['pg_write_server_files'], ['pg_signal_backend'], ['pg_monitor']])(
    'a reachable predefined role %s outside the closed allowlist is refused unevaluated',
    (name) => {
      expect(evaluatePrincipal('recovery_capture_ro', { ...readOnly, reachable_roles: [{ ...readAllData, name }] })).toEqual(['PRINCIPAL_REACHES_UNSAFE_PREDEFINED_ROLE'])
    },
  )

  it('UNKNOWN reachability is refused: absent, not an array, or a malformed role entry', () => {
    const { reachable_roles: _omit, ...withoutReach } = readOnly
    void _omit
    expect(evaluatePrincipal('recovery_capture_ro', withoutReach as PrincipalObservation)).toContain('PRINCIPAL_REACHABILITY_UNKNOWN')
    expect(evaluatePrincipal('recovery_capture_ro', { ...readOnly, reachable_roles: null as unknown as ReachableRole[] })).toContain('PRINCIPAL_REACHABILITY_UNKNOWN')
    expect(evaluatePrincipal('recovery_capture_ro', { ...readOnly, reachable_roles: [{ name: 'x' } as ReachableRole] })).toContain('PRINCIPAL_REACHABILITY_UNKNOWN')
  })

  it('NOINHERIT is not treated as sufficient: reachability follows ANY membership (MEMBER), not only inherited privileges (USAGE)', () => {
    expect(PRINCIPAL_SQL).toMatch(/pg_has_role\(me\.oid, r\.oid, 'MEMBER'\)/)
    expect(PRINCIPAL_SQL).not.toMatch(/pg_has_role\(me\.oid, r\.oid, '(USAGE|SET)'\)/)
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

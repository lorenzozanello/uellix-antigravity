// tests/hosted/authority/remediation-certification.test.ts
// COMMIT 5.3 — the parts of the remediation certification that must hold
// WITHOUT a container.
//
// `pnpm certify:remediation` needs Docker, a 1.7 GB image and several minutes.
// A machine that does not have those must still be prevented from shipping a
// harness that would read a witness wrongly, inject at a relocated anchor,
// provision a staging shape that is already remediated, or judge the engine's
// answer with an expectation that fell behind the plan.
//
// What only the engine can answer — whether a real transaction rolls back from
// nine points, whether 27 ALTER FUNCTION statements land on the right owners —
// is answered by the harness and recorded in
// artifacts/remediation-certification/latest.json. This file deliberately does
// not restate those as offline assertions: a test that "verifies" an engine
// result by re-reading the JSON the harness just wrote is verifying nothing.
//
// What it DOES test is the JUDGE. Every postcondition verdict is computed by a
// pure function, and those functions are exercised here against measurements
// that are deliberately wrong — because a judge that has only ever seen a
// passing input is a judge nobody has tested.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  REMEDIATION_SOURCE_STATE_SCHEMA,
  REMEDIATION_WITNESS_SCHEMA,
  RemediationTransportRefusal,
  bodyDigest,
  buildRemediationSourceStateSql,
  buildRemediationWitnessSql,
  diffSourceState,
  extractDollarQuotedBody,
  parseRemediationSourceState,
  parseRemediationWitness,
  type RemediationSourceState,
} from '@/db/hosted/authority/certification/remediation-probes'
import {
  REMEDIATION_FAILURE_INJECTIONS,
  REMEDIATION_ROLLBACK_BOUNDARIES,
} from '@/db/hosted/authority/certification/remediation-failure-injection'
import {
  INJECTION_MARKER,
  InjectionAnchorRefusal,
  injectFailure,
} from '@/db/hosted/authority/certification/failure-injection'
import {
  STAGING_SHAPE_BOOTSTRAP_BLOB,
  STAGING_SHAPE_BOOTSTRAP_SHA256,
  STAGING_SHAPE_OPEN_DEFECTS,
  StagingShapeRefusal,
  assertStagingShapeIsUnremediated,
  normalizeForApply,
  resolveStagingShapeBootstrap,
} from '@/db/hosted/authority/certification/staging-shape'
import {
  CHAIN_POSTURE_SCHEMA,
  EXPECTED_CHAIN_MEMBERSHIP_DELTA,
  buildChainPostureSql,
  deriveExpectedCanonicalOwnerContexts,
  deriveExpectedOwnerTransfers,
  deriveTransferSegmentCount,
  evaluateCanonicalOwnerContexts,
  evaluateOwnerTransfers,
  evaluatePersistentRoleTopology,
  evaluateRlsPolicyEngine,
  evaluateSchemaCreateResidual,
  evaluateSecurityDefinerGate,
  parseChainPosture,
  type ChainPosture,
} from '@/db/hosted/authority/certification/chain-postconditions'
import { witnessDocumentSql } from '@/db/hosted/authority/certification/engine-probes'
import { PRECHAIN_REMEDIATION } from '@/db/hosted/prechain-remediation'

const ROOT = process.cwd()
const SQL = readFileSync(path.join(ROOT, PRECHAIN_REMEDIATION.sourceFile), 'utf8')
const ATTEMPT = 'att_000000000000000000000000000000ab'
const OTHER = 'att_000000000000000000000000000000cd'
const BODY_DIGEST = bodyDigest(
  extractDollarQuotedBody(
    SQL,
    'CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_hosted_capabilities(p_package text)',
  ),
)

const witnessDocument = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: REMEDIATION_WITNESS_SCHEMA,
    attemptId: ATTEMPT,
    observation: {
      installerHasCreateRole: false,
      installerCanSetOwner: true,
      installerCanCreateInDatabase: false,
      ownerHoldsE01Grants: false,
      installerHoldsVisibilityGrants: false,
      topologyAssertionPresent: false,
      capabilitiesBodyIsCertified: false,
      bootstrapSchemaAcl: ['uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_auditor'],
      capabilityRolesPresent: [],
      ...overrides,
    },
  })

/* -------------------------------------------------------------------------- */
/* The transport                                                               */
/* -------------------------------------------------------------------------- */

describe('the witness travels as one typed document, never as delimited columns', () => {
  it('projects exactly one column of one row', () => {
    // The property `queryDocument` relies on. A probe that projected two
    // columns would be read by splitting, which is the defect this replaces.
    const sql = buildRemediationWitnessSql(ATTEMPT, BODY_DIGEST)
    expect(sql.trimEnd().endsWith('::text;')).toBe(true)
    expect(sql.match(/^SELECT /gm) ?? []).toHaveLength(1)
    expect(sql).toContain('jsonb_build_object')
  })

  it('contains no field separator, in any of the three spellings that failed', () => {
    for (const source of [
      buildRemediationWitnessSql(ATTEMPT, BODY_DIGEST),
      buildRemediationSourceStateSql(ATTEMPT),
      witnessDocumentSql(),
      readFileSync(path.join(ROOT, 'scripts/remediation-certify.ts'), 'utf8'),
    ]) {
      expect(source).not.toContain('\u001f') // the unit separator, as an escape
      expect(source).not.toContain('\t')
      expect(source).not.toMatch(/'-F'/)
      expect(source).not.toMatch(/psql[^\n]*-F /)
    }
  })

  it('compiles the attempt id in as a literal, and refuses a shape that could close it', () => {
    expect(buildRemediationWitnessSql(ATTEMPT, BODY_DIGEST)).toContain(`'${ATTEMPT}'`)
    expect(() => buildRemediationWitnessSql("att_'; DROP TABLE x; --", BODY_DIGEST)).toThrow(
      RemediationTransportRefusal,
    )
    expect(() => buildRemediationSourceStateSql('nope')).toThrow(/32 hex/)
  })

  it('reads a well-formed document into the typed observation', () => {
    const parsed = parseRemediationWitness(witnessDocument(), ATTEMPT)
    expect(parsed.observation.installerCanSetOwner).toBe(true)
    expect(parsed.observation.bootstrapSchemaAcl).toContain('uellix_migrator')
  })

  it('refuses a document measured for a DIFFERENT attempt', () => {
    // This is what a stale observation looks like from the reader's side: the
    // server echoed the attempt it was built for, and it is not this one.
    expect(() => parseRemediationWitness(witnessDocument(), OTHER)).toThrow(
      /REMEDIATION_WITNESS_ATTEMPT_MISMATCH/,
    )
  })

  it('refuses a MISSING boolean rather than reading it as false', () => {
    // The whole reason for a typed validator. `undefined` is falsy, and a
    // falsy `topologyAssertionPresent` means "not remediated" — so a dropped
    // field would silently authorise an apply against an INSTALLED project.
    const doc = JSON.parse(witnessDocument()) as { observation: Record<string, unknown> }
    delete doc.observation.topologyAssertionPresent
    expect(() => parseRemediationWitness(JSON.stringify(doc), ATTEMPT)).toThrow(
      /topologyAssertionPresent[\s\S]*not a boolean/,
    )
  })

  it('refuses a boolean sent as a string, which is what a tabular reader produces', () => {
    const doc = JSON.parse(witnessDocument()) as { observation: Record<string, unknown> }
    doc.observation.installerHasCreateRole = 't'
    expect(() => parseRemediationWitness(JSON.stringify(doc), ATTEMPT)).toThrow(/not a boolean/)
  })

  it('refuses an array member that is not a string', () => {
    const doc = JSON.parse(witnessDocument()) as { observation: Record<string, unknown> }
    doc.observation.bootstrapSchemaAcl = ['uellix_owner', 7]
    expect(() => parseRemediationWitness(JSON.stringify(doc), ATTEMPT)).toThrow(/not a string/)
  })

  it('refuses an absent document, a non-object, and a foreign schema', () => {
    expect(() => parseRemediationWitness(null, ATTEMPT)).toThrow(/REMEDIATION_WITNESS_REQUIRED/)
    expect(() => parseRemediationWitness('[]', ATTEMPT)).toThrow(/not a JSON object/)
    expect(() => parseRemediationWitness('not json', ATTEMPT)).toThrow(/not valid JSON/)
    expect(() =>
      parseRemediationWitness(JSON.stringify({ schema: 'other/1', attemptId: ATTEMPT, observation: {} }), ATTEMPT),
    ).toThrow(/this reader consumes/)
  })

  it('sorts the arrays it returns, so two equal measurements compare equal', () => {
    const a = parseRemediationWitness(
      witnessDocument({ bootstrapSchemaAcl: ['uellix_app', 'uellix_owner'] }),
      ATTEMPT,
    )
    const b = parseRemediationWitness(
      witnessDocument({ bootstrapSchemaAcl: ['uellix_owner', 'uellix_app'] }),
      ATTEMPT,
    )
    expect(a.observation.bootstrapSchemaAcl).toEqual(b.observation.bootstrapSchemaAcl)
  })
})

/* -------------------------------------------------------------------------- */
/* The certified body                                                          */
/* -------------------------------------------------------------------------- */

describe('the certified body is derived from the package, not transcribed', () => {
  it('extracts exactly the dollar-quoted span PostgreSQL stores in prosrc', () => {
    const body = extractDollarQuotedBody(
      SQL,
      'CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_hosted_capabilities(p_package text)',
    )
    // prosrc starts after `AS $$` and ends before the closing `$$`, so it opens
    // with a newline and closes with `END ` — not with the CREATE statement.
    expect(body.startsWith('\n')).toBe(true)
    expect(body.trimEnd().endsWith('END')).toBe(true)
    expect(body).toContain('CREATEROLE')
    expect(body).not.toContain('CREATE OR REPLACE FUNCTION')
  })

  it('hashes CR-insensitively, so a Windows apply and a Linux apply agree', () => {
    expect(bodyDigest('a\r\nb')).toBe(bodyDigest('a\nb'))
  })

  it('refuses to guess when the header is absent', () => {
    expect(() => extractDollarQuotedBody(SQL, 'CREATE OR REPLACE FUNCTION nope(')).toThrow(
      /REMEDIATION_BODY_HEADER_ABSENT/,
    )
  })

  it('is the digest the probe asks the server to compare against', () => {
    expect(buildRemediationWitnessSql(ATTEMPT, BODY_DIGEST)).toContain(`'${BODY_DIGEST}'`)
  })
})

/* -------------------------------------------------------------------------- */
/* The source-state fingerprint                                                */
/* -------------------------------------------------------------------------- */

describe('the source-state fingerprint is wider than the witness, on purpose', () => {
  const base = (attemptId: string): RemediationSourceState =>
    parseRemediationSourceState(
      JSON.stringify({
        schema: REMEDIATION_SOURCE_STATE_SCHEMA,
        attemptId,
        roleAttributes: { uellix_migrator: { createRole: false, canLogin: true } },
        databaseAcl: ['postgres:CREATE'],
        schemas: { uellix_bootstrap: { owner: 'uellix_owner', acl: ['uellix_migrator:USAGE'] } },
        objects: { 'public.organizations': { present: true, owner: 'postgres', acl: [] } },
        functionBodies: { 'uellix_bootstrap.assert_hosted_capabilities(text)': 'abc' },
        memberships: ['uellix_owner<-postgres by supabase_admin (admin=true inherit=false set=false)'],
        capabilityRolesPresent: [],
      }),
      attemptId,
    )

  it('ignores the attempt id when comparing, because the two are taken for different attempts', () => {
    // Before is measured when the attempt opens and after once it has closed.
    // Reporting that as drift would fail every comparison for the one reason
    // that is not a defect.
    expect(diffSourceState(base(ATTEMPT), base(OTHER))).toEqual([])
  })

  it('names the exact path of a role attribute that survived', () => {
    const after = { ...base(OTHER), roleAttributes: { uellix_migrator: { createRole: true, canLogin: true } } }
    const diff = diffSourceState(base(ATTEMPT), after)
    expect(diff.map((d) => d.path)).toEqual(['roleAttributes.uellix_migrator.createRole'])
  })

  it('notices a leaked schema ACL entry', () => {
    const after = {
      ...base(OTHER),
      schemas: { uellix_bootstrap: { owner: 'uellix_owner', acl: ['uellix_migrator:USAGE', 'postgres:CREATE'] } },
    }
    expect(diffSourceState(base(ATTEMPT), after)).toHaveLength(1)
  })

  it('notices a REPLACED function body, which a presence check cannot', () => {
    // R7 dies after CREATE OR REPLACE. A rollback check that asked only whether
    // a function of that name exists would pass while the project ran the new
    // contract.
    const after = { ...base(OTHER), functionBodies: { 'uellix_bootstrap.assert_hosted_capabilities(text)': 'xyz' } }
    const diff = diffSourceState(base(ATTEMPT), after)
    expect(diff[0].path).toMatch(/functionBodies/)
  })

  it('is order-independent, so the same facts in a different sequence are equal', () => {
    const after = {
      ...base(OTHER),
      memberships: [...base(OTHER).memberships].reverse(),
      databaseAcl: [...base(OTHER).databaseAcl].reverse(),
    }
    expect(diffSourceState(base(ATTEMPT), after)).toEqual([])
  })

  it('refuses a fingerprint measured for a different attempt', () => {
    expect(() =>
      parseRemediationSourceState(JSON.stringify({ ...JSON.parse(JSON.stringify(base(ATTEMPT))) }), OTHER),
    ).toThrow(/ATTEMPT_MISMATCH/)
  })
})

/* -------------------------------------------------------------------------- */
/* R1..R9                                                                      */
/* -------------------------------------------------------------------------- */

describe('the nine rollback boundaries are nine, distinct, and anchored exactly', () => {
  it('declares nine points with unique ids', () => {
    expect(REMEDIATION_FAILURE_INJECTIONS).toHaveLength(9)
    expect(new Set(REMEDIATION_ROLLBACK_BOUNDARIES).size).toBe(9)
    expect(REMEDIATION_ROLLBACK_BOUNDARIES).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'])
  })

  it('places every one of them, at nine distinct lines', () => {
    const lines = REMEDIATION_FAILURE_INJECTIONS.map((injection) => {
      const mutated = injectFailure(SQL, injection).split('\n')
      const at = mutated.findIndex((l) => l.includes(`${INJECTION_MARKER} ${injection.id}`))
      expect(at, `${injection.id} was not injected`).toBeGreaterThan(-1)
      return at
    })
    expect(new Set(lines).size).toBe(9)
    // In file order: R1 before R2 before … R9. A point that jumped the sequence
    // would report a result about a later state under an earlier name.
    expect([...lines].sort((a, b) => a - b)).toEqual(lines)
  })

  it('lands each point where its NAME says it does', () => {
    const at = (id: string): number => {
      const injection = REMEDIATION_FAILURE_INJECTIONS.find((i) => i.id === id)
      if (injection === undefined) throw new Error(`no injection ${id}`)
      return injectFailure(SQL, injection)
        .split('\n')
        .findIndex((l) => l.includes(`${INJECTION_MARKER} ${id}`))
    }
    const stmt = (needle: string, from = 0): number => {
      const lines = injectFailure(SQL, REMEDIATION_FAILURE_INJECTIONS[0]).split('\n')
      const index = lines.findIndex((l, i) => i >= from && l.trim() === needle)
      if (index === -1) throw new Error(`statement not found: ${needle}`)
      return index
    }

    // R1 is BEFORE the ALTER ROLE — the control case, nothing mutated yet.
    expect(at('R1')).toBeLessThan(stmt('ALTER ROLE uellix_migrator WITH CREATEROLE;'))
    // R6 is after the borrow opens and before it is given back.
    expect(at('R6')).toBeGreaterThan(stmt('GRANT USAGE, CREATE ON SCHEMA uellix_bootstrap TO postgres;') - 1)
    expect(at('R6')).toBeLessThan(stmt('REVOKE USAGE, CREATE ON SCHEMA uellix_bootstrap FROM postgres;'))
    // R8 is the last point at which the borrow is still open.
    expect(at('R8')).toBeLessThan(stmt('REVOKE USAGE, CREATE ON SCHEMA uellix_bootstrap FROM postgres;'))
    // R9 is after it has been returned.
    expect(at('R9')).toBeGreaterThan(stmt('REVOKE USAGE, CREATE ON SCHEMA uellix_bootstrap FROM postgres;'))
  })

  it('REFUSES rather than relocating when an anchor moves', () => {
    const relocated = { ...REMEDIATION_FAILURE_INJECTIONS[0], occurrence: 99 }
    expect(() => injectFailure(SQL, relocated)).toThrow(InjectionAnchorRefusal)
  })

  it('raises at execution time, not at parse time', () => {
    // A syntax error can be reported by the PARSER before any statement runs,
    // which would make every point pass by never reaching the state it claims.
    for (const injection of REMEDIATION_FAILURE_INJECTIONS) {
      expect(injectFailure(SQL, injection)).toContain(
        `DO $uellix_cert$ BEGIN RAISE EXCEPTION '${INJECTION_MARKER} ${injection.id}'`,
      )
    }
  })

  it('states what each point would leak if the transaction did not hold', () => {
    // A green run must not be readable as "nothing happens at this point".
    for (const injection of REMEDIATION_FAILURE_INJECTIONS) {
      expect(injection.residueIfNotTransactional.length, injection.id).toBeGreaterThan(40)
      expect(injection.authorityStateAtInjection.length, injection.id).toBeGreaterThan(20)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The staging shape                                                           */
/* -------------------------------------------------------------------------- */

describe('the exact staging shape is pinned and is genuinely unremediated', () => {
  it('resolves the historical bootstrap by content, and it matches its digest', () => {
    const historical = resolveStagingShapeBootstrap(ROOT)
    expect(historical.blob).toBe(STAGING_SHAPE_BOOTSTRAP_BLOB)
    expect(historical.sha256).toBe(STAGING_SHAPE_BOOTSTRAP_SHA256)
    expect(historical.sql).toContain('uellix_bootstrap')
  })

  it('is NOT the bootstrap in the working tree', () => {
    // The point of the whole module. Today's bootstrap already carries §5d and
    // §5e; provisioning from it would make §0 (S6) refuse the remediation and
    // make ABSENT unmeasurable.
    const current = normalizeForApply(
      readFileSync(path.join(ROOT, 'db/prepared/hosted/stella_hosted_0001_managed_role_bootstrap.hosted.sql'), 'utf8'),
    )
    expect(resolveStagingShapeBootstrap(ROOT).sql).not.toBe(current)
    expect(current).toContain('assert_capability_membership_topology')
  })

  it('carries none of the facts the remediation delivers', () => {
    expect(() => assertStagingShapeIsUnremediated(resolveStagingShapeBootstrap(ROOT).sql)).not.toThrow()
  })

  it('refuses a shape that is already remediated', () => {
    expect(() =>
      assertStagingShapeIsUnremediated('ALTER ROLE uellix_migrator WITH CREATEROLE;'),
    ).toThrow(StagingShapeRefusal)
    expect(() =>
      assertStagingShapeIsUnremediated('CREATE FUNCTION assert_capability_membership_topology()'),
    ).toThrow(/STAGING_SHAPE_ALREADY_REMEDIATED/)
  })

  it('names the four defects the shape is open on', () => {
    expect(STAGING_SHAPE_OPEN_DEFECTS.map((d) => d.id).sort()).toEqual(['E-01', 'E-02', 'E-03', 'E-04'])
  })

  it('normalizes line endings before anything reaches a server', () => {
    // PostgreSQL stores a function body exactly as it receives it, and the
    // witness identifies the certified body BY the hash of that body.
    expect(normalizeForApply('a\r\nb\rc')).toBe('a\nb\nc')
  })
})

/* -------------------------------------------------------------------------- */
/* The judge                                                                   */
/* -------------------------------------------------------------------------- */

describe('the engine expectations are derived from the plan, not written down', () => {
  it('derives twenty-seven owner transfers over twenty-three distinct objects', () => {
    const transfers = deriveExpectedOwnerTransfers(ROOT)
    expect(transfers).toHaveLength(27)
    expect(new Set(transfers.map((t) => t.object)).size).toBe(23)
  })

  it('expects ABSENT for the four objects a later package drops', () => {
    // T6 drops the four two-argument ticket functions T5 created and
    // transferred. An expectation that ignored drops would demand an owner for
    // an object that correctly no longer exists.
    const dropped = deriveExpectedOwnerTransfers(ROOT).filter((t) => t.expectedFinalOwner === null)
    expect(new Set(dropped.map((t) => t.object)).size).toBe(4)
    for (const t of dropped) expect(t.object).toMatch(/uellix_stella_ops\./)
  })

  it('derives the three canonical owner contexts, all CREATE TABLE for uellix_owner', () => {
    const contexts = deriveExpectedCanonicalOwnerContexts(ROOT)
    expect(contexts).toHaveLength(3)
    expect(contexts.map((c) => c.object).sort()).toEqual([
      'public.evidence_chunks',
      'public.evidence_document_versions',
      'uellix_stella_ops.operation_tickets',
    ])
    for (const c of contexts) expect(c.expectedOwner).toBe('uellix_owner')
  })

  it('derives eleven transfer segments', () => {
    expect(deriveTransferSegmentCount()).toBe(11)
  })

  it('asks the server only about the objects the expectations cover', () => {
    const transfers = deriveExpectedOwnerTransfers(ROOT)
    const contexts = deriveExpectedCanonicalOwnerContexts(ROOT)
    const sql = buildChainPostureSql(transfers, contexts)
    expect(sql.trimEnd().endsWith('::text;')).toBe(true)
    for (const c of contexts) expect(sql).toContain(`'${c.object}'`)
    for (const t of transfers) expect(sql).toContain(`'${t.object}'`)
  })
})

describe('the postcondition judges reject a wrong measurement', () => {
  const posture = (overrides: Partial<ChainPosture> = {}): ChainPosture =>
    ({
      schema: CHAIN_POSTURE_SCHEMA,
      transferredOwners: {},
      canonicalContextOwners: {},
      functions: [],
      relations: [],
      policies: [],
      triggers: [],
      memberships: [],
      schemaCreateGrants: [],
      roleAttributes: [],
      capabilityReachableBy: {},
      ...overrides,
    }) as ChainPosture

  it('refuses to pass an owner-transfer check with nothing measured', () => {
    // The vacuous-pass trap: an empty measurement satisfies "no wrong answers".
    const transfers = deriveExpectedOwnerTransfers(ROOT)
    const verdict = evaluateOwnerTransfers(transfers, posture())
    expect(verdict.pass).toBe(false)
    expect(verdict.wrong.length).toBeGreaterThan(0)
  })

  it('reports the object, the expectation and the measurement when one is wrong', () => {
    const transfers = deriveExpectedOwnerTransfers(ROOT).slice(0, 1)
    const verdict = evaluateOwnerTransfers(
      transfers,
      posture({ transferredOwners: { [transfers[0].object]: 'uellix_owner' } }),
    )
    expect(verdict.pass).toBe(false)
    expect(verdict.wrong[0]).toContain(transfers[0].object)
    expect(verdict.wrong[0]).toContain('measured uellix_owner')
  })

  it('accepts an object the plan says is dropped only when it is ABSENT', () => {
    const dropped = deriveExpectedOwnerTransfers(ROOT).filter((t) => t.expectedFinalOwner === null).slice(0, 1)
    expect(evaluateOwnerTransfers(dropped, posture()).pass).toBe(true)
    expect(
      evaluateOwnerTransfers(dropped, posture({ transferredOwners: { [dropped[0].object]: 'uellix_owner' } })).pass,
    ).toBe(false)
  })

  it('refuses a canonical owner context left with the installer', () => {
    const contexts = deriveExpectedCanonicalOwnerContexts(ROOT)
    const wrong = Object.fromEntries(contexts.map((c) => [c.object, 'postgres']))
    expect(evaluateCanonicalOwnerContexts(contexts, posture({ canonicalContextOwners: wrong })).pass).toBe(false)
  })

  it('accepts exactly the three capability rows as the chain\'s membership delta', () => {
    const prechain = posture({
      memberships: [
        { role: 'uellix_owner', member: 'uellix_migrator', grantor: 'postgres', adminOption: false, inheritOption: false, setOption: true },
      ],
    })
    const rows = EXPECTED_CHAIN_MEMBERSHIP_DELTA.map((row) => {
      const [role, rest] = row.split('<-')
      return {
        role,
        member: rest.split(' ')[0],
        grantor: 'supabase_admin',
        adminOption: true,
        inheritOption: false,
        setOption: false,
      }
    })
    const after = posture({ memberships: [...prechain.memberships, ...rows] })
    expect(evaluatePersistentRoleTopology(after, prechain).pass).toBe(true)
  })

  it('refuses a membership the chain added and did not close', () => {
    const prechain = posture()
    const after = posture({
      memberships: [
        { role: 'uellix_cap_grounding', member: 'uellix_owner', grantor: 'uellix_migrator', adminOption: false, inheritOption: false, setOption: true },
      ],
    })
    const verdict = evaluatePersistentRoleTopology(after, prechain)
    expect(verdict.pass).toBe(false)
    expect(verdict.unexpected).toHaveLength(1)
  })

  it('refuses when a prechain membership DISAPPEARED', () => {
    // The other direction. The chain removing §2b\'s owner window would leave a
    // project the next package cannot elevate in.
    const prechain = posture({
      memberships: [
        { role: 'uellix_owner', member: 'uellix_migrator', grantor: 'postgres', adminOption: false, inheritOption: false, setOption: true },
      ],
    })
    const verdict = evaluatePersistentRoleTopology(posture(), prechain)
    expect(verdict.pass).toBe(false)
    expect(verdict.removed).toHaveLength(1)
  })

  it('refuses when ANY non-superuser can SET into a capability role', () => {
    // The absolute property no delta can express.
    const prechain = posture()
    const after = posture({ capabilityReachableBy: { uellix_cap_grounding: ['uellix_app'] } })
    const verdict = evaluatePersistentRoleTopology(after, prechain)
    expect(verdict.pass).toBe(false)
    expect(verdict.capabilityReachableBy).toEqual(['uellix_app -> uellix_cap_grounding'])
  })

  it('reads an empty search_path the way PostgreSQL SPELLS it', () => {
    // MEASURED: `SET search_path = ''` is stored as `search_path=""`. A check
    // written against `search_path=` matched nothing and failed twenty-seven
    // functions that were all correct.
    const definer = {
      signature: 'uellix_stella.f()',
      schema: 'uellix_stella',
      owner: 'uellix_cap_stella_quota',
      securityDefiner: true,
      proconfig: ['search_path=""'],
      executeGrantees: ['uellix_migrator'],
    }
    expect(evaluateSecurityDefinerGate(posture({ functions: [definer] })).pass).toBe(true)
  })

  it('refuses a chain definer whose search_path is pinned to public', () => {
    const definer = {
      signature: 'uellix_stella.f()',
      schema: 'uellix_stella',
      owner: 'uellix_cap_stella_quota',
      securityDefiner: true,
      proconfig: ['search_path=public'],
      executeGrantees: [],
    }
    expect(evaluateSecurityDefinerGate(posture({ functions: [definer] })).pass).toBe(false)
  })

  it('RECORDS a baseline definer outside the chain\'s schemas instead of refusing it', () => {
    // public.current_user_org_ids carries search_path=public and is created by
    // db/migrations. Refusing here would fail the certification for a property
    // of the baseline; dropping it from the count would be worse.
    const verdict = evaluateSecurityDefinerGate(
      posture({
        functions: [
          { signature: 'public.current_user_org_ids()', schema: 'public', owner: 'postgres', securityDefiner: true, proconfig: ['search_path=public'], executeGrantees: [] },
          { signature: 'uellix_stella.f()', schema: 'uellix_stella', owner: 'uellix_cap_stella_quota', securityDefiner: true, proconfig: ['search_path=""'], executeGrantees: [] },
        ],
      }),
    )
    expect(verdict.pass).toBe(true)
    expect(verdict.securityDefiner).toBe(2)
    expect(verdict.inChainScope).toBe(1)
    expect(verdict.outsideChainScope[0]).toMatch(/NOT an empty search_path/)
  })

  it('refuses PUBLIC EXECUTE on a definer WHEREVER it lives', () => {
    const verdict = evaluateSecurityDefinerGate(
      posture({
        functions: [
          { signature: 'public.x()', schema: 'public', owner: 'postgres', securityDefiner: true, proconfig: ['search_path=""'], executeGrantees: ['PUBLIC'] },
          { signature: 'uellix_stella.f()', schema: 'uellix_stella', owner: 'uellix_cap_stella_quota', securityDefiner: true, proconfig: ['search_path=""'], executeGrantees: [] },
        ],
      }),
    )
    expect(verdict.pass).toBe(false)
    expect(verdict.withPublicExecute).toEqual(['public.x()'])
  })

  it('refuses a policy sitting on a relation with RLS disabled', () => {
    // Inert, and pg_policies lists it exactly like an enforcing one.
    const verdict = evaluateRlsPolicyEngine(
      posture({
        policies: [{ relation: 'public.t', name: 'p', command: 'SELECT', roles: ['authenticated'] }],
        relations: [{ relation: 'public.t', kind: 'r', owner: 'uellix_owner', rlsEnabled: false, rlsForced: false }],
      }),
    )
    expect(verdict.pass).toBe(false)
    expect(verdict.policiesOnUnprotectedRelations).toEqual(['public.t'])
  })

  it('refuses a duplicated policy and an empty policy set', () => {
    const relations = [{ relation: 'public.t', kind: 'r', owner: 'uellix_owner', rlsEnabled: true, rlsForced: false }]
    const dup = evaluateRlsPolicyEngine(
      posture({
        relations,
        policies: [
          { relation: 'public.t', name: 'p', command: 'SELECT', roles: [] },
          { relation: 'public.t', name: 'p', command: 'SELECT', roles: [] },
        ],
      }),
    )
    expect(dup.pass).toBe(false)
    expect(evaluateRlsPolicyEngine(posture()).pass).toBe(false)
  })

  it('counts a schema CREATE grant as residual only when the chain added it', () => {
    const baseline = posture({ schemaCreateGrants: [{ schema: 'public', owner: 'postgres', grantee: 'uellix_owner' }] })
    expect(evaluateSchemaCreateResidual(baseline, baseline).pass).toBe(true)
    const leaked = posture({
      schemaCreateGrants: [
        ...baseline.schemaCreateGrants,
        { schema: 'uellix_grounding', owner: 'uellix_owner', grantee: 'uellix_cap_grounding' },
      ],
    })
    const verdict = evaluateSchemaCreateResidual(leaked, baseline)
    expect(verdict.pass).toBe(false)
    expect(verdict.residual).toEqual(['uellix_grounding -> uellix_cap_grounding'])
  })

  it('never counts a schema owner\'s inherent CREATE as a residual', () => {
    // acldefault('n', owner) contains CREATE and no statement granted it.
    const p = posture({ schemaCreateGrants: [{ schema: 'uellix_stella', owner: 'uellix_owner', grantee: 'uellix_owner' }] })
    expect(evaluateSchemaCreateResidual(p, posture()).pass).toBe(true)
  })

  it('refuses a posture document that is not one', () => {
    expect(() => parseChainPosture(null)).toThrow(/POSTURE_REQUIRED/)
    expect(() => parseChainPosture('{"schema":"other"}')).toThrow(/POSTURE_MALFORMED/)
  })
})

/* -------------------------------------------------------------------------- */
/* The harness uses the production gates                                       */
/* -------------------------------------------------------------------------- */

describe('the harness decides nothing for itself', () => {
  const HARNESS = readFileSync(path.join(ROOT, 'scripts/remediation-certify.ts'), 'utf8')

  it('calls the REAL prechain authority gate and the REAL T1 authorization', () => {
    // A harness that reproduced a gate could pass while the gate was broken.
    expect(HARNESS).toContain('validateHostedPrechainAuthorityContract')
    expect(HARNESS).toContain('authorizeGovernedT1')
    expect(HARNESS).toContain('planRemediationAttempt')
    expect(HARNESS).toContain('classifyRemediation')
  })

  it('never classifies a witness itself', () => {
    // The one thing that would let a green run mean nothing: the harness
    // deciding INSTALLED from the facts rather than asking the classifier.
    expect(HARNESS).not.toMatch(/state\s*=\s*['"]INSTALLED['"]/)
    // A comparison against a state is legitimate; CONSTRUCTING one is not.
    //
    // Scanned over EXECUTABLE lines only, for the same reason the "transfers no
    // ownership" rule in prechain-remediation.test.ts is: the harness's own
    // comments explain why a matrix must not be assembled from `{ state: '…' }`,
    // and a tripwire that read prose would refuse the file for describing the
    // mistake it avoids.
    const executable = HARNESS.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(executable).not.toMatch(/\bstate\s*:\s*['"]/)
  })

  it('verifies the package pin before it opens a container', () => {
    expect(HARNESS).toContain('verifyRemediationPin')
    expect(HARNESS.indexOf('verifyRemediationPin')).toBeLessThan(HARNESS.indexOf('function main('))
  })

  it('runs with no network and applies the remediation in one transaction', () => {
    expect(HARNESS).toContain("'--network', 'none'")
    expect(HARNESS).toMatch(/'-v', 'ON_ERROR_STOP=1', '-q', '-1'/)
  })
})

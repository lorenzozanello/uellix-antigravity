// tests/hosted/authority/engine-certification.test.ts
// COMMIT 5 — the parts of the PG 17.6 engine certification that must hold
// WITHOUT a container.
//
// ---------------------------------------------------------------------------
// WHAT IS TESTED HERE AND WHAT IS ONLY TESTED BY THE ENGINE
// ---------------------------------------------------------------------------
// `pnpm certify:pg176` needs Docker, a 2 GB image and several minutes. A CI
// that does not have those must still be prevented from shipping a harness that
// would certify the wrong file, so the properties that are decidable offline
// live here:
//
//   * the certification's INPUT SET — nine packages, nine governed paths, nine
//     pinned digests, no glob and no basename fallback;
//   * every refusal that must happen BEFORE SQL reaches a server;
//   * the failure-injection anchors, which are exact lines of the generated
//     artefacts and therefore drift with them;
//   * the forward-only contract over a witnessed state.
//
// What only the engine can answer — whether 27 ALTER FUNCTION statements land
// on the right owners, whether a package that dies mid-lifecycle leaves a
// membership behind — is answered by the harness and recorded in
// artifacts/pg176-certification/latest.json. This file deliberately does not
// restate those as offline assertions: a test that "verifies" an engine result
// by re-reading the JSON the harness just wrote is verifying nothing.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  assertGovernedPath,
  firstUndeclaredPackageId,
  GOVERNED_CERTIFICATION_INPUTS,
  GOVERNED_DIRECTORY,
  GovernedInputRefusal,
  resolveGovernedChainInputs,
  resolveGovernedInput,
  sha256OfFileContent,
  UNKNOWN_PACKAGE_ID,
} from '@/db/hosted/authority/certification/governed-input'
import {
  REQUIRED_REFUSAL_IDS,
  refusalExercises,
} from '@/db/hosted/authority/certification/refusal-exercises'
import {
  certificationPredicates,
  certificationVerdict,
  type CertificationEvidence,
} from '@/db/hosted/authority/certification/certification-verdict'
import {
  assertRunNamespaceAbsent,
  certificationRunNamespace,
  namespacedPrefix,
  ownsResource,
} from '@/db/hosted/authority/certification/run-namespace'
import {
  FAILURE_INJECTIONS,
  INJECTION_MARKER,
  injectFailure,
  InjectionAnchorRefusal,
} from '@/db/hosted/authority/certification/failure-injection'
import {
  CANDIDATE_INSTALLERS,
  CERTIFICATION_IMAGE,
  EXPECTED_CREATEROLE_SELF_GRANT,
  EXPECTED_SERVER_VERSION,
  EXPECTED_SERVER_VERSION_NUM,
  LAB_SHIMS,
} from '@/db/hosted/authority/certification/lab-environment'
import {
  MEMBERSHIP_PROBE_SQL,
  FUNCTION_OWNER_PROBE_SQL,
  SCHEMA_CREATE_RESIDUAL_PROBE_SQL,
  witnessProbeSql,
} from '@/db/hosted/authority/certification/engine-probes'
import { GOVERNED_PINS } from '@/db/hosted/authority/governed-manifest'
import { CHAIN_PACKAGE_FILES } from '@/db/hosted/authority/window-plan'
import { nextChainPackage, CHAIN_WRITE_ORDER } from '@/db/hosted/fresh-observation'
import type { PackageState } from '@/db/hosted/package-witnesses'

const ROOT = process.cwd()

/**
 * A package id the chain provably does not declare, DERIVED rather than picked.
 *
 * The refusal this feeds is "an unknown package id resolves to nothing — no
 * basename fallback, no glob". It was written as the literal `'T10'`, which was
 * unknown at the time and became a real chain package when M-8 landed: the
 * assertion then failed, loudly, which is the good outcome. The bad outcome was
 * available too — had grounding_0005 been numbered anything else, this test
 * would have gone on passing while testing a package that existed.
 *
 * F-1: this file derived it and `scripts/pg176-certify.ts` did not, so the two
 * paths drifted and the EXECUTED probe went on naming a package that had become
 * real. It is now IMPORTED from the one place that derives it, so there is no
 * second derivation left to drift from.
 */

/* -------------------------------------------------------------------------- */
/* The input set                                                               */
/* -------------------------------------------------------------------------- */

describe('the certification input set is governed, explicit and pinned', () => {
  it('is exactly the eleven chain packages, in chain order', () => {
    expect(GOVERNED_CERTIFICATION_INPUTS.map((i) => i.packageId)).toEqual(
      CHAIN_PACKAGE_FILES.map((e) => e.packageId),
    )
    expect(GOVERNED_CERTIFICATION_INPUTS).toHaveLength(11)
  })

  it('resolves every input under db/prepared/hosted/governed/, never beside it', () => {
    for (const input of GOVERNED_CERTIFICATION_INPUTS) {
      expect(input.relativePath.startsWith(`${GOVERNED_DIRECTORY}/`), input.packageId).toBe(true)
      expect(input.relativePath.endsWith('.governed.sql'), input.packageId).toBe(true)
    }
  })

  it('binds each input to its pin, and the bytes on disk match', () => {
    const resolved = resolveGovernedChainInputs(ROOT)
    for (const input of resolved) {
      const pin = GOVERNED_PINS.find((p) => p.packageId === input.packageId)
      expect(pin, input.packageId).toBeDefined()
      expect(input.actualDigest).toBe(pin!.generatedDigest)
      expect(input.actualDigest).toBe(input.expectedDigest)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Refusals that must precede any SQL execution                                */
/* -------------------------------------------------------------------------- */

describe('what the harness refuses before a byte reaches a server', () => {
  it('refuses a governed artefact whose bytes moved (section 21)', () => {
    expect(() =>
      resolveGovernedInput('T1', ROOT, (p) => `${readFileSync(p, 'utf8')}\n-- tampered\n`),
    ).toThrow(/CERT_DIGEST_MISMATCH/)
  })

  it('refuses the UNGOVERNED bytes the operational runners still use (section 22)', () => {
    // Same package, same pinned path, the OTHER artefact's contents. This is
    // the case the independent review named: the runners in db/hosted/** still
    // resolve `.hosted.sql`, and the two files apply against the same database
    // without error while carrying different authority models.
    const ungoverned = (p: string): string =>
      readFileSync(p.replace(/[\\/]governed[\\/]/, '/').replace('.governed.sql', '.hosted.sql'), 'utf8')

    expect(() => resolveGovernedInput('T1', ROOT, ungoverned)).toThrow(/CERT_DIGEST_MISMATCH/)
  })

  it('refuses an ungoverned PATH outright, without reading it (section 22)', () => {
    expect(() =>
      assertGovernedPath(path.join(ROOT, 'db/prepared/hosted/grounding_0002_document_versions.hosted.sql')),
    ).toThrow(/CERT_PATH_NOT_GOVERNED/)
  })

  it('applies the fence to a Windows-spelled path too', () => {
    // A separator is not a security boundary. Normalising first is what makes
    // the fence hold on the platform this repository is actually developed on.
    expect(() => assertGovernedPath('C:\\repo\\db\\prepared\\hosted\\x.hosted.sql')).toThrow(
      GovernedInputRefusal,
    )
    expect(() => assertGovernedPath('C:\\repo\\db\\prepared\\hosted\\governed\\x.governed.sql')).not.toThrow()
  })

  it('has no basename fallback and no glob: an unknown package refuses', () => {
    // 'T10' USED TO BE THE UNKNOWN ONE. M-8 made it a real package, which is
    // exactly the trap a hard-coded "one past the end" sentinel sets: the test
    // keeps its name and stops testing anything the day the chain grows. T99 is
    // no better as a permanent choice, so the sentinel is derived — the first
    // Tn beyond the declared chain, whatever the chain currently is.
    expect(() => resolveGovernedInput(UNKNOWN_PACKAGE_ID, ROOT)).toThrow(/CERT_UNKNOWN_PACKAGE/)
    expect(() => resolveGovernedInput('grounding_0002_document_versions', ROOT)).toThrow(
      /CERT_UNKNOWN_PACKAGE/,
    )
  })

  it('refuses an unreadable artefact rather than substituting anything', () => {
    expect(() =>
      resolveGovernedInput('T1', ROOT, () => {
        throw new Error('ENOENT')
      }),
    ).toThrow(/CERT_ARTEFACT_UNREADABLE/)
  })

  it('normalizes line endings before hashing, so a CRLF checkout still matches', () => {
    // This repository has core.autocrlf=true. A digest computed over raw bytes
    // would refuse every artefact on a Windows working tree, and the obvious
    // "fix" would be to stop comparing digests.
    const lf = 'SELECT 1;\nSELECT 2;\n'
    expect(sha256OfFileContent(lf.replace(/\n/g, '\r\n'))).toBe(sha256OfFileContent(lf))
  })
})

/* -------------------------------------------------------------------------- */
/* Failure injection                                                           */
/* -------------------------------------------------------------------------- */

describe('the failure injections are anchored to the generated bytes', () => {
  const sqlOf = (packageId: string): string => resolveGovernedInput(packageId, ROOT).sql

  it('covers fifteen distinct authority points across three packages', () => {
    expect(FAILURE_INJECTIONS.map((f) => f.id)).toEqual([
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10',
      // M-8. Five points inside T10, which opens two capability windows and
      // gives back four privileges between them.
      'F11', 'F12', 'F13', 'F14', 'F15',
    ])
    expect(new Set(FAILURE_INJECTIONS.map((f) => f.packageId))).toEqual(new Set(['T1', 'T8', 'T10']))
  })

  it('injects at a point where the package REPLACES rather than creates', () => {
    // The gap the first ten leave, and the reason M-8 needed its own set.
    //
    // Every earlier injection sits in a package that CREATES something, so a
    // rollback that worked was observable as an object disappearing. T10
    // creates nothing: claim_active_document_version exists identically before
    // and after, with the same owner, ACL, signature and return type. What must
    // roll back is a function BODY — and an implementation that left the new
    // body behind would satisfy every "the package is absent" witness this
    // harness has, because those measure objects.
    const f13 = FAILURE_INJECTIONS.find((f) => f.id === 'F13')!
    expect(f13.packageId).toBe('T10')
    expect(f13.fromSnapshot).toBe('T9')

    // And the anchor lands AFTER the replacement, not before it: the injected
    // raise must follow the statement whose effect is under test.
    const mutated = injectFailure(sqlOf('T10'), f13)
    const lines = mutated.split('\n')
    const at = lines.findIndex((l) => l.includes(INJECTION_MARKER))
    const bodyStart = lines.findIndex((l) => l.startsWith('CREATE OR REPLACE FUNCTION'))
    expect(bodyStart).toBeGreaterThan(0)
    expect(at).toBeGreaterThan(bodyStart)
    expect(lines.slice(bodyStart, at).join('\n')).toContain('pg_advisory_xact_lock')
  })

  it('opens the two T10 windows asymmetrically — CREATE for one statement only', () => {
    // The design decision, checked against the emitted bytes rather than
    // against the plan that produced them. The second window needs ownership to
    // write a COMMENT and needs no CREATE at all, so the schema grant appears
    // exactly once while the membership appears twice.
    const sql = sqlOf('T10')
    const count = (line: string): number =>
      sql.split('\n').filter((l) => l.trim() === line).length

    expect(count('GRANT CREATE ON SCHEMA uellix_grounding TO uellix_cap_grounding;')).toBe(1)
    expect(count('REVOKE CREATE ON SCHEMA uellix_grounding FROM uellix_cap_grounding;')).toBe(1)
    expect(count('GRANT uellix_cap_grounding TO uellix_migrator WITH INHERIT FALSE, SET TRUE;')).toBe(2)
    expect(count('REVOKE uellix_cap_grounding FROM uellix_migrator;')).toBe(2)

    // And nothing persistent: no ownership transfer, and no grant to the app.
    expect(sql).not.toMatch(/ALTER FUNCTION uellix_grounding\.claim_active_document_version.*OWNER TO/)
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION uellix_grounding\.claim_active_document_version/)
  })

  it('resolves every anchor in the artefact it names', () => {
    // The point of the whole registry. When the generator changes, this fails
    // loudly instead of relocating an injection to a different statement and
    // reporting the result under the old one's name.
    for (const injection of FAILURE_INJECTIONS) {
      expect(() => injectFailure(sqlOf(injection.packageId), injection), injection.id).not.toThrow()
    }
  })

  it('places the raise immediately after the anchor, and nowhere else', () => {
    for (const injection of FAILURE_INJECTIONS) {
      const original = sqlOf(injection.packageId)
      const mutated = injectFailure(original, injection)
      const lines = mutated.split('\n')
      const at = lines.findIndex((l) => l.includes(INJECTION_MARKER))

      expect(at, injection.id).toBeGreaterThan(0)
      expect(lines[at - 1].trim(), injection.id).toBe(injection.anchor)
      expect(lines.filter((l) => l.includes(INJECTION_MARKER)), injection.id).toHaveLength(1)
      expect(mutated.split('\n').length, injection.id).toBe(original.split('\n').length + 1)
    }
  })

  it('refuses an anchor that no longer occurs the expected number of times', () => {
    const drifted = { ...FAILURE_INJECTIONS[0], occurrence: 99 }
    expect(() => injectFailure(sqlOf(drifted.packageId), drifted)).toThrow(InjectionAnchorRefusal)
  })

  it('injects a runtime RAISE, never a syntax error', () => {
    // A syntax error is caught by the parser before any statement executes, so
    // every rollback test would pass by never reaching the state it claims to
    // test. The marker has to be inside a DO block for the same reason.
    const mutated = injectFailure(sqlOf('T1'), FAILURE_INJECTIONS[0])
    expect(mutated).toMatch(/DO \$uellix_cert\$ BEGIN RAISE EXCEPTION/)
  })
})

/* -------------------------------------------------------------------------- */
/* The probes                                                                  */
/* -------------------------------------------------------------------------- */

describe('the engine probes ask the catalog, and ask it precisely', () => {
  it('measures every witness the registry declares, individually', () => {
    const sql = witnessProbeSql()
    // Arity is the discriminator between stella_0016 and stella_0017; a probe
    // that resolved functions by name would report the successor installed as
    // soon as its predecessor was.
    expect(sql).toContain('to_regprocedure')
    expect(sql).toContain('settle_reserved_quota(uuid,uuid,character varying,character,character)')
    expect(sql).toMatch(/^SET search_path = '';/)
  })

  it('projects the GRANTOR on every membership row', () => {
    // Lab M2: a provider-granted membership and an installer-granted one
    // coexist as two rows told apart by grantor alone. Without it, "no
    // temporary membership survives" is unanswerable.
    expect(MEMBERSHIP_PROBE_SQL).toContain('g.rolname   AS grantor')
  })

  it('reads function owners by full signature, with SECURITY DEFINER and ACL', () => {
    expect(FUNCTION_OWNER_PROBE_SQL).toContain('p.oid::regprocedure::text')
    expect(FUNCTION_OWNER_PROBE_SQL).toContain('p.prosecdef')
    expect(FUNCTION_OWNER_PROBE_SQL).toContain('proconfig')
    expect(FUNCTION_OWNER_PROBE_SQL).toContain("a.privilege_type = 'EXECUTE'")
  })

  it('reads residual schema CREATE from the ACL, not from a statement count', () => {
    expect(SCHEMA_CREATE_RESIDUAL_PROBE_SQL).toContain('aclexplode')
    expect(SCHEMA_CREATE_RESIDUAL_PROBE_SQL).toContain("a.privilege_type = 'CREATE'")
  })

  it('pins search_path to empty in every probe, so nothing resolves by accident', () => {
    for (const sql of [MEMBERSHIP_PROBE_SQL, FUNCTION_OWNER_PROBE_SQL, SCHEMA_CREATE_RESIDUAL_PROBE_SQL]) {
      expect(sql).toContain("SET search_path = ''")
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Forward-only                                                                */
/* -------------------------------------------------------------------------- */

describe('forward-only, over a witnessed state (section 20)', () => {
  const allInstalled = Object.fromEntries(
    CHAIN_WRITE_ORDER.map((p) => [p, 'INSTALLED' as PackageState]),
  )

  it('refuses to name any package once every one measures INSTALLED', () => {
    // NOT "the database rejected the DDL". The database may well tolerate a
    // repeated CREATE OR REPLACE; that is not the contract. The contract is
    // that the workflow will not PLAN a write against an installed package.
    const result = nextChainPackage(allInstalled)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('CHAIN_SEQUENCE_COMPLETE')
  })

  it('authorises exactly one package from a PRECHAIN observation', () => {
    const prechain = Object.fromEntries(
      CHAIN_WRITE_ORDER.map((p) => [p, 'ABSENT' as PackageState]),
    )
    const result = nextChainPackage(prechain)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.packageId).toBe(CHAIN_WRITE_ORDER[0])
  })

  it('refuses a gap rather than filling it', () => {
    const gapped = { ...allInstalled, [CHAIN_WRITE_ORDER[3]]: 'ABSENT' as PackageState }
    const result = nextChainPackage(gapped)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('CHAIN_PREDECESSOR_STATE_INVALID')
  })

  it('never converts a PARTIAL observation into a decision', () => {
    const partial = {
      ...Object.fromEntries(CHAIN_WRITE_ORDER.map((p) => [p, 'ABSENT' as PackageState])),
      [CHAIN_WRITE_ORDER[0]]: 'PARTIAL_OR_INCONSISTENT' as PackageState,
    }
    // The first ABSENT is now the SECOND package, and the first is neither
    // installed nor absent. Continuing would apply T2 over a half-applied T1.
    const result = nextChainPackage(partial)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.packageId).toBe(CHAIN_WRITE_ORDER[1])
      // Documented, not asserted as safe: `nextChainPackage` alone does not
      // stop this — `toStellaPackagesInstalled` refuses a PARTIAL observation
      // before it ever reaches here, which is why the runner calls that first.
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The environment declaration                                                 */
/* -------------------------------------------------------------------------- */

describe('the lab environment declares itself before it reports anything', () => {
  it('pins the image and the engine identity the harness will insist on', () => {
    expect(CERTIFICATION_IMAGE).toBe('public.ecr.aws/supabase/postgres:17.6.1.143')
    expect(EXPECTED_SERVER_VERSION).toBe('17.6')
    expect(EXPECTED_SERVER_VERSION_NUM).toBe('170006')
    expect(EXPECTED_CREATEROLE_SELF_GRANT).toBe('')
  })

  it('names every shim, each with what is wrong with it', () => {
    expect(LAB_SHIMS.length).toBeGreaterThan(0)
    for (const shim of LAB_SHIMS) {
      expect(shim.object.length, shim.object).toBeGreaterThan(0)
      expect(shim.whyItIsAShim.length, shim.object).toBeGreaterThan(80)
    }
  })

  it('records that BOTH candidate installers are measured, not one chosen', () => {
    // E-02. Picking one would have produced a green report about whichever
    // failure the chosen identity does not hit.
    expect([...CANDIDATE_INSTALLERS].sort()).toEqual(['postgres', 'uellix_migrator'])
  })
})

/* -------------------------------------------------------------------------- */
/* F-1 — the unknown-package sentinel, and the verdict that must depend on it  */
/* -------------------------------------------------------------------------- */

describe('the unknown-package sentinel is derived once, for every path', () => {
  it('is the first Tn the chain does not declare', () => {
    expect(UNKNOWN_PACKAGE_ID).toBe(`T${CHAIN_PACKAGE_FILES.length + 1}`)
    expect(GOVERNED_CERTIFICATION_INPUTS.map((i) => i.packageId)).not.toContain(UNKNOWN_PACKAGE_ID)
    expect(() => resolveGovernedInput(UNKNOWN_PACKAGE_ID, ROOT)).toThrow(/CERT_UNKNOWN_PACKAGE/)
  })

  it('steps past an id the chain already declares rather than returning it', () => {
    // `length + 1` is only unknown while the ids are contiguous from T1. A
    // chain that ever declares a gap — T1..T9 plus T11, say — would make the
    // arithmetic hand back a REAL package, which is the same defect as the
    // literal, arrived at by a different route. So the rule searches.
    const declared = GOVERNED_CERTIFICATION_INPUTS
    const shadowed = [
      ...declared,
      { ...declared[0], packageId: `T${declared.length + 1}` },
    ]
    expect(firstUndeclaredPackageId(shadowed)).toBe(`T${declared.length + 2}`)
  })

  it('never returns an id that is in the set it was given', () => {
    for (const inputs of [GOVERNED_CERTIFICATION_INPUTS, GOVERNED_CERTIFICATION_INPUTS.slice(0, 3)]) {
      expect(inputs.map((i) => i.packageId)).not.toContain(firstUndeclaredPackageId(inputs))
    }
  })
})

describe('the refusal set the certification EXECUTES', () => {
  // Not a parallel fixture. `scripts/pg176-certify.ts` calls this exact
  // function, which is the whole point of F-1: the offline fixture already
  // derived the sentinel correctly while the executable script did not, and a
  // test over a second implementation could not have caught that.
  const exercises = refusalExercises(ROOT)

  it('runs exactly the required exercises, in order', () => {
    expect(exercises.map((e) => e.id)).toEqual([...REQUIRED_REFUSAL_IDS])
  })

  it('refuses every one of them before a byte reaches a server', () => {
    for (const exercise of exercises) {
      expect(exercise.refused, exercise.id).toBe(true)
      expect(exercise.reachedServer, exercise.id).toBe(false)
    }
  })

  it('probes the DERIVED unknown package, and says which one it probed', () => {
    const unknown = exercises.find((e) => e.id === 'UNKNOWN_PACKAGE')
    expect(unknown).toBeDefined()
    expect(unknown!.code).toBe('CERT_UNKNOWN_PACKAGE')
    // The recorded evidence names the id that was actually attempted. A report
    // that says "a package the chain does not declare" without naming it
    // cannot be audited for this defect at all — which is how T10 survived.
    expect(unknown!.attempted).toContain(UNKNOWN_PACKAGE_ID)
  })
})

describe('COMPLETE is a conjunction, and the refusals are in it', () => {
  const passing: CertificationEvidence = {
    provisioningComplete: true,
    prechainClean: true,
    prechainAuthorityGatePassed: true,
    chainComplete: true,
    storageFunctionalProbe: { ran: true, passed: true, detail: '10/10 cases matched' },
    refusals: REQUIRED_REFUSAL_IDS.map((id) => ({ id, refused: true })),
    injections: [{ id: 'F1', failed: true, rolledBack: true }],
  }

  it('reaches COMPLETE when every predicate holds', () => {
    expect(certificationVerdict(passing)).toBe('COMPLETE')
    expect(certificationPredicates(passing).every((p) => p.holds)).toBe(true)
  })

  // M-2. The certification blind spot, as three cases that must each break
  // COMPLETE. The defect was not that the probe answered wrongly — there was no
  // probe, and eleven structural witnesses said INSTALLED over a Storage
  // surface that refused all nine role-matrix cases.
  it('CANNOT reach COMPLETE when the Storage functional probe FAILS (M-2)', () => {
    const denied: CertificationEvidence = {
      ...passing,
      storageFunctionalProbe: {
        ran: true,
        passed: false,
        detail: '9 mismatch(es): analyst.write expected ALLOW, observed DENY',
      },
    }
    expect(certificationVerdict(denied)).not.toBe('COMPLETE')
    expect(certificationVerdict(denied)).toBe('STORAGE_HELPER_FUNCTIONAL_PROBE_FAILED')
  })

  it('CANNOT reach COMPLETE when the Storage functional probe DID NOT RUN', () => {
    // Skipping the probe must not be a way to pass it — the same rule the
    // missing-refusal case above encodes, for the newest predicate.
    const skipped: CertificationEvidence = {
      ...passing,
      storageFunctionalProbe: { ran: false, passed: false, detail: 'NOT RUN' },
    }
    expect(certificationVerdict(skipped)).not.toBe('COMPLETE')
    expect(certificationVerdict(skipped)).toBe('STORAGE_HELPER_FUNCTIONAL_PROBE_FAILED')
  })

  it('CANNOT reach COMPLETE on a probe that claims to pass without having run', () => {
    // The incoherent shape a future refactor could produce. `ran && passed` is
    // written as a conjunction precisely so this cannot default into a pass.
    const incoherent: CertificationEvidence = {
      ...passing,
      storageFunctionalProbe: { ran: false, passed: true, detail: 'claims a pass it never measured' },
    }
    expect(certificationVerdict(incoherent)).not.toBe('COMPLETE')
  })

  it('separates INSTALLATION from FUNCTION, which is the whole finding', () => {
    // A chain that installed perfectly and a surface that denies everyone is
    // exactly the state Fable measured. The two predicates must be independent,
    // and the verdict must name the functional one rather than blaming the
    // installation — otherwise the next reader is sent to the wrong place.
    const installedButDead: CertificationEvidence = {
      ...passing,
      chainComplete: true,
      storageFunctionalProbe: { ran: true, passed: false, detail: 'all nine cases denied' },
    }
    const predicates = certificationPredicates(installedButDead)
    expect(predicates.find((p) => p.id === 'CHAIN_COMPLETE')!.holds).toBe(true)
    expect(predicates.find((p) => p.id === 'STORAGE_HELPER_FUNCTIONAL_PROBE')!.holds).toBe(false)
    expect(certificationVerdict(installedButDead)).toBe('STORAGE_HELPER_FUNCTIONAL_PROBE_FAILED')
  })

  it('CANNOT reach COMPLETE when the unknown package resolves (F-1)', () => {
    // The regression this whole commit exists for. Before the fix the script
    // recorded `UNKNOWN_PACKAGE refused=false` and `verdict=COMPLETE` in the
    // same artefact, and the artefact is versioned evidence.
    const resolved: CertificationEvidence = {
      ...passing,
      refusals: passing.refusals.map((r) =>
        r.id === 'UNKNOWN_PACKAGE' ? { ...r, refused: false } : r,
      ),
    }
    expect(certificationVerdict(resolved)).not.toBe('COMPLETE')
    expect(certificationVerdict(resolved)).toBe('REQUIRED_REFUSAL_NOT_REFUSED')
  })

  it('CANNOT reach COMPLETE when a required refusal is missing entirely', () => {
    // Deleting the exercise must not be a way to pass it.
    const dropped: CertificationEvidence = {
      ...passing,
      refusals: passing.refusals.filter((r) => r.id !== 'UNKNOWN_PACKAGE'),
    }
    expect(certificationVerdict(dropped)).not.toBe('COMPLETE')
  })

  it('CANNOT reach COMPLETE when an injection is not contained', () => {
    for (const broken of [
      { id: 'F1', failed: false, rolledBack: true },
      { id: 'F1', failed: true, rolledBack: false },
    ]) {
      expect(certificationVerdict({ ...passing, injections: [broken] })).toBe(
        'FAILURE_INJECTION_NOT_CONTAINED',
      )
    }
  })

  it('keeps every predicate that already gated, with the verdict strings it used', () => {
    // Not weakened, and not renamed: `CHAIN_INCOMPLETE_INJECTIONS_RUN` and the
    // three early-return codes are what the existing artefacts and runbooks
    // read.
    expect(certificationVerdict({ ...passing, chainComplete: false })).toBe(
      'CHAIN_INCOMPLETE_INJECTIONS_RUN',
    )
    expect(certificationVerdict({ ...passing, provisioningComplete: false })).toBe(
      'PROVISIONING_FAILED',
    )
    expect(certificationVerdict({ ...passing, prechainClean: false })).toBe('PRECHAIN_INVALID')
    expect(certificationVerdict({ ...passing, prechainAuthorityGatePassed: false })).toBe(
      'PRECHAIN_AUTHORITY_GATE_FAILED',
    )
  })

  it('names every required refusal id in the predicate set, so the list is auditable', () => {
    const refusalPredicate = certificationPredicates(passing).find(
      (p) => p.id === 'ALL_REQUIRED_REFUSALS_REFUSED',
    )
    expect(refusalPredicate).toBeDefined()
    for (const id of REQUIRED_REFUSAL_IDS) expect(refusalPredicate!.detail).toContain(id)
  })
})

/* -------------------------------------------------------------------------- */
/* Concurrent certifications                                                   */
/* -------------------------------------------------------------------------- */

describe('two certifications can run at once without deleting each other', () => {
  const a = certificationRunNamespace(1234, 1_700_000_000_000)
  const b = certificationRunNamespace(5678, 1_700_000_000_000)

  it('gives each run its own namespace', () => {
    expect(a).not.toBe(b)
    expect(certificationRunNamespace(1234, 1_700_000_000_001)).not.toBe(a)
  })

  it('spells the namespace in the charset docker accepts for names AND repositories', () => {
    // A container name may carry uppercase; an image repository may not. One
    // token is used for both, so it is held to the stricter rule.
    for (const ns of [a, b, certificationRunNamespace(process.pid, Date.now())]) {
      expect(ns).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    }
  })

  it('produces disjoint container and snapshot names for the two runs', () => {
    const prefixA = namespacedPrefix('uellix-pg176-cert', a)
    const prefixB = namespacedPrefix('uellix-pg176-cert', b)
    expect(prefixA).not.toBe(prefixB)
    expect(`${prefixA}-primary`).not.toBe(`${prefixB}-primary`)
  })

  it('claims only its own resources, so cleanup cannot reach the other run', () => {
    const prefixA = namespacedPrefix('uellix-pg176-cert', a)
    const prefixB = namespacedPrefix('uellix-pg176-cert', b)

    expect(ownsResource(prefixA, `${prefixA}-primary`)).toBe(true)
    expect(ownsResource(prefixA, `${prefixB}-primary`)).toBe(false)
    // And the un-namespaced name a pre-F-4 run would have used is not ours
    // either: an old container left behind is not this run's to remove.
    expect(ownsResource(prefixA, 'uellix-pg176-cert-primary')).toBe(false)
  })

  it('keeps the run token out of the versioned evidence', () => {
    // artifacts/pg176-certification/latest.json is TRACKED. A pid or timestamp
    // in it would make the certification content differ run to run for a
    // reason that has nothing to do with the database being certified.
    expect(() => assertRunNamespaceAbsent({ verdict: 'COMPLETE' }, a)).not.toThrow()
    expect(() => assertRunNamespaceAbsent({ verdict: 'COMPLETE', container: `x-${a}` }, a)).toThrow(
      /CERT_RUN_NAMESPACE_LEAKED/,
    )
    expect(() =>
      assertRunNamespaceAbsent({ nested: [{ note: `started ${a}-primary` }] }, a),
    ).toThrow(/CERT_RUN_NAMESPACE_LEAKED/)
  })
})

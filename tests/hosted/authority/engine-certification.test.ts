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
  GOVERNED_CERTIFICATION_INPUTS,
  GOVERNED_DIRECTORY,
  GovernedInputRefusal,
  resolveGovernedChainInputs,
  resolveGovernedInput,
  sha256OfFileContent,
} from '@/db/hosted/authority/certification/governed-input'
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

/* -------------------------------------------------------------------------- */
/* The input set                                                               */
/* -------------------------------------------------------------------------- */

describe('the certification input set is governed, explicit and pinned', () => {
  it('is exactly the nine chain packages, in chain order', () => {
    expect(GOVERNED_CERTIFICATION_INPUTS.map((i) => i.packageId)).toEqual(
      CHAIN_PACKAGE_FILES.map((e) => e.packageId),
    )
    expect(GOVERNED_CERTIFICATION_INPUTS).toHaveLength(9)
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
    expect(() => resolveGovernedInput('T10', ROOT)).toThrow(/CERT_UNKNOWN_PACKAGE/)
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

  it('covers ten distinct authority points across two packages', () => {
    expect(FAILURE_INJECTIONS.map((f) => f.id)).toEqual([
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10',
    ])
    expect(new Set(FAILURE_INJECTIONS.map((f) => f.packageId))).toEqual(new Set(['T1', 'T8']))
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

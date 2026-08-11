// tests/cross-workstream/train4-attested-runtime.test.ts
// INTEGRATION (Stella parallel train 4) — the seams the four branches only
// meet at.
//
// Each branch's own suite is green in isolation and none of them can see the
// join: CAPABILITIES ships SQL it never calls, GROUNDING ships a port with no
// adapter, PRODUCT ships a mount whose runner is a prop, RELEASE ships a
// harness that runs a database none of the others touch. Everything below is a
// property that becomes checkable only once all four are on one tree.
//
// WHAT IS HERE AND WHAT IS IN THE E2E
//
// These are offline, structural checks — they read source and types, open no
// connection and start no container. A structural check is the right tool for
// "does the runtime NAME the attested reader": the wrong function name is a
// static fact, and catching it here costs milliseconds instead of a container.
//
// It is the WRONG tool for "does the attested reader return rows the scope
// comparison can reject", which is a claim about a running database. That one
// lives in scripts/stella-release-e2e-dry-run.sh + e2e/run-local-journey.ts,
// which apply the four packages for real, ingest two real documents and
// compare every returned row's own scope columns against the request.
//
// Neither replaces the other, and this file does not pretend to be evidence of
// execution.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  assertScopeAttestation,
  enforceRepositoryScope,
  buildChunkQuery,
  isAttestedScope,
  RepositoryContractViolationError,
  type ChunkQuery,
  type ChunkScopeProvenance,
  type GroundingChunkRepository,
} from '@/lib/grounding/retrieve/repository'
import {
  EXTRACTIVE_GENERATOR_ID,
  EXTRACTIVE_GENERATOR_NAME,
  EXTRACTIVE_GENERATOR_VERSION,
} from '@/lib/grounding/retrieve'
import {
  GroundingScopeViolationError,
  textSpan,
  type ContentHash,
  type GroundingChunk,
} from '@/lib/grounding/contracts'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
// Strip comments so prose naming a symbol cannot satisfy — or trip — a scan.
//
// LINE comments first, then block comments, and the order is not cosmetic: a
// line comment in this codebase can legitimately contain a glob like
// "db slash star star", whose trailing pair reads as a BLOCK OPENER. Stripping
// blocks first would swallow every line from there to the next real closing
// delimiter — silently deleting real code from the text an assertion then
// reads as absent, which is a false PASS on a `not.toMatch`. Doing lines first
// removes the false opener along with its line.
//
// (This explanation is a line comment for the same reason: written as a block,
// spelling those delimiters would terminate its own comment.)
//
// Where a check can be written against a CALL FORM instead — a schema-qualified
// name with an open paren — that is preferred over stripping: it distinguishes
// a mention from an invocation, which is the distinction the check actually
// cares about, and it needs no comment parser at all.
const code = (src: string) =>
  src.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '')

const READ_ADAPTER = 'db/grounding/grounding-chunk-repository.ts'
const WRITE_ADAPTER = 'db/grounding/grounding-ingestion-repository.ts'
const SERVER_ACTION = 'app/actions/stella/grounded-query.ts'

/* ========================================================================== */
/* CAPABILITIES -> GROUNDING : the attested reader is the one that is called  */
/* ========================================================================== */

describe('CAPABILITIES -> GROUNDING — the runtime reads the ATTESTED function', () => {
  it('the read adapter calls chunks_in_scope_attested and never the predecessor', () => {
    const src = code(read(READ_ADAPTER))
    expect(src).toMatch(/uellix_grounding\.chunks_in_scope_attested\(/)
    // The negative is the load-bearing half. `chunks_in_scope` is a SUBSTRING
    // of `chunks_in_scope_attested`, so a naive `not.toContain` would be
    // unsatisfiable — this matches the call form specifically.
    expect(src).not.toMatch(/uellix_grounding\.chunks_in_scope\(/)
  })

  it('it selects the four attestation columns, not just the original thirteen', () => {
    const src = code(read(READ_ADAPTER))
    for (const column of ['organization_id', 'project_id', 'evidence_id', 'document_version_id']) {
      expect(src, `the SELECT omits ${column}`).toMatch(new RegExp(`\\b${column}\\b`))
    }
  })

  it('grounding_0004 is the package that publishes it, and it is prepared — never a migration', () => {
    // db/prepared/** is not applied by drizzle-kit; that is the whole reason
    // the directory exists. A package that migrated into db/migrations/ would
    // be applied by CI against a real database, which no gate authorizes.
    const pkg = read('db/prepared/grounding_0004_runtime_attestation.sql')
    expect(pkg).toMatch(/CREATE OR REPLACE FUNCTION uellix_grounding\.chunks_in_scope_attested/)
    expect(() => read('db/migrations/grounding_0004_runtime_attestation.sql')).toThrow()
  })

  it('the attested reader returns the four scope columns FROM THE ROW, not from its arguments', () => {
    // The defect INT-GR-004 describes, moved one layer down, would be a
    // function whose signature declares the columns and whose body echoes
    // `p_organization_id`. The body must select `ch.` qualified columns.
    const pkg = read('db/prepared/grounding_0004_runtime_attestation.sql')
    const body = pkg.slice(pkg.indexOf('chunks_in_scope_attested'))
    expect(body).toMatch(/ch\.organization_id,\s*ch\.project_id,\s*ch\.evidence_id,\s*ch\.document_version_id/)
    expect(body).not.toMatch(/SELECT[\s\S]{0,400}p_organization_id\s+AS\s+organization_id/)
  })

  it('the RLS repair names the capability role on BOTH grounding tables', () => {
    // The Train 4 finding: uellix_cap_grounding held SELECT on both tables and
    // was named by neither permissive SELECT policy, so every governed read
    // returned the empty set — silently. Asserted per table, because a repair
    // that lands on one is not a repair.
    const pkg = read('db/prepared/grounding_0004_runtime_attestation.sql')
    for (const table of ['evidence_document_versions', 'evidence_chunks']) {
      const policy = pkg.slice(pkg.indexOf(`CREATE POLICY "${table}_select"`))
      expect(policy.slice(0, 400), `${table} policy omits the capability role`).toMatch(
        /uellix_cap_grounding/,
      )
    }
  })
})

/* ========================================================================== */
/* INT-CAP-004 (1) — the repaired rollback                                    */
/* ========================================================================== */

describe('CAPABILITIES — grounding_0003 rollback converges whether or not the table is there', () => {
  const rollback = read('db/prepared/grounding_0003_rollback.sql')

  it('drops all four functions OUTSIDE the table-existence branch', () => {
    // The defect: four DROP FUNCTIONs nested in `ELSE` of "if the table
    // exists". A function does not depend on a table, so a database whose
    // evidence_chunks went by another route kept three callable SECURITY
    // DEFINER functions AND a capability role that could then never be
    // retired — permanently bricking grounding_0002's own rollback.
    //
    // Measured by POSITION rather than by presence: all four must appear after
    // the `END IF;` that closes the table branch.
    const endOfBranch = rollback.indexOf("EXECUTE 'DROP TABLE public.evidence_chunks';")
    expect(endOfBranch).toBeGreaterThan(0)
    const afterBranch = rollback.indexOf('END IF;', endOfBranch)
    expect(afterBranch).toBeGreaterThan(endOfBranch)

    for (const fn of [
      'uellix_grounding.insert_evidence_chunks',
      'uellix_grounding.finalize_document_ingestion',
      'uellix_grounding.chunks_in_scope',
      'public.uellix_check_canonical_chunk',
    ]) {
      const at = rollback.indexOf(`DROP FUNCTION IF EXISTS ${fn}`)
      expect(at, `${fn} is not dropped at all`).toBeGreaterThan(0)
      expect(at, `${fn} is still nested inside the table-existence branch`).toBeGreaterThan(afterBranch)
    }
  })

  it('asserts afterwards that none of the four survived', () => {
    expect(rollback).toMatch(/rollback FAILED: a function this package created is still installed/)
  })

  it('still drops exactly the five objects its forward script created — no more', () => {
    // The repair moved statements; it must not have added or duplicated one.
    // A duplicated DROP would make the rollback's own inventory disagree with
    // tests/grounding-persistence-contract.test.ts.
    const dropped = [
      ...code(rollback).matchAll(/DROP (?:TABLE|SCHEMA|ROLE|FUNCTION)(?: IF EXISTS)? ([\w.]+)/g),
    ].map((m) => m[1])
    expect(dropped.sort()).toEqual([
      'public.evidence_chunks',
      'public.uellix_check_canonical_chunk',
      'uellix_grounding.chunks_in_scope',
      'uellix_grounding.finalize_document_ingestion',
      'uellix_grounding.insert_evidence_chunks',
    ])
  })
})

/* ========================================================================== */
/* GROUNDING -> RUNTIME : the guard stopped being tautological                */
/* ========================================================================== */

const SCOPE = { organizationId: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222' }
const OTHER_PROJECT = '33333333-3333-4333-8333-333333333333'
const HASH = 'a'.repeat(64) as ContentHash

function chunk(overrides: Partial<GroundingChunk> = {}): GroundingChunk {
  const base: GroundingChunk = {
    chunkId: HASH,
    scope: SCOPE,
    evidenceId: '44444444-4444-4444-8444-444444444444',
    versionId: ('b'.repeat(64)) as ContentHash,
    chunkIndex: 0,
    text: 'passage',
    contentHash: ('c'.repeat(64)) as ContentHash,
    location: {
      span: textSpan(0, 7),
      coordinateSpace: ('d'.repeat(64)) as ContentHash,
      page: null,
      sectionIndex: null,
      sectionLabel: null,
      lineStart: 0,
      lineEnd: 0,
    },
    provenance: {
      evidenceId: '44444444-4444-4444-8444-444444444444',
      scope: SCOPE,
      versionId: ('b'.repeat(64)) as ContentHash,
      rawContentHash: ('e'.repeat(64)) as ContentHash,
      normalizedContentHash: ('d'.repeat(64)) as ContentHash,
      normalizationVersion: 'n1',
      chunkerVersion: 'c1',
      injectionScannerVersion: 's1',
      sourceLabel: 'doc',
      mimeType: 'text/plain',
    },
    signals: [],
  }
  return { ...base, ...overrides }
}

describe('GROUNDING -> RUNTIME — a row whose scope disagrees is rejected', () => {
  const query: ChunkQuery = buildChunkQuery(SCOPE, 'question', { evidenceIds: ['44444444-4444-4444-8444-444444444444'] })

  it('accepts an attestation that agrees with both the chunk and the query', () => {
    const c = chunk()
    expect(() =>
      assertScopeAttestation(
        c,
        { source: 'governed_row', scope: SCOPE, evidenceId: c.evidenceId, versionId: c.versionId, chunkId: c.chunkId },
        query,
        'r',
        true,
      ),
    ).not.toThrow()
  })

  // Each of the five attested fields, one at a time. A single "it rejects a
  // bad attestation" test would pass with four of the five comparisons
  // deleted.
  it.each([
    ['organizationId', { scope: { organizationId: OTHER_PROJECT, projectId: SCOPE.projectId } }, GroundingScopeViolationError],
    ['projectId', { scope: { organizationId: SCOPE.organizationId, projectId: OTHER_PROJECT } }, GroundingScopeViolationError],
    ['evidenceId', { evidenceId: '99999999-9999-4999-8999-999999999999' }, RepositoryContractViolationError],
    ['versionId', { versionId: 'f'.repeat(64) as ContentHash }, RepositoryContractViolationError],
    ['chunkId', { chunkId: '0'.repeat(64) as ContentHash }, RepositoryContractViolationError],
  ])('rejects a row whose attested %s differs', (_field, override, errorType) => {
    const c = chunk()
    const attestation = {
      source: 'governed_row' as const,
      scope: SCOPE,
      evidenceId: c.evidenceId,
      versionId: c.versionId,
      chunkId: c.chunkId,
      ...override,
    }
    expect(() => assertScopeAttestation(c, attestation, query, 'r', true)).toThrow(errorType)
  })

  it('an UNATTESTED repository is accepted by default and REFUSED under requireScopeAttestation', () => {
    // The two halves of the type's purpose. Accepting by default is what let
    // train 3's repository keep working; refusing under the option is what
    // makes turning it on meaningful rather than decorative.
    const unattested: ChunkScopeProvenance = { source: 'restated_from_query', reason: 'no columns' }
    expect(isAttestedScope(unattested)).toBe(false)
    expect(() => assertScopeAttestation(chunk(), unattested, query, 'r', false)).not.toThrow()
    expect(() => assertScopeAttestation(chunk(), unattested, query, 'r', true)).toThrow(
      RepositoryContractViolationError,
    )
  })

  it('a repository that omits attestScope entirely fails under the option — silence is not assent', async () => {
    const silent: GroundingChunkRepository = {
      id: 'silent',
      async fetchCandidates() {
        return [chunk()]
      },
    }
    await expect(
      enforceRepositoryScope(silent, { requireScopeAttestation: true }).fetchCandidates(query),
    ).rejects.toThrow(RepositoryContractViolationError)
  })
})

/* ========================================================================== */
/* RUNTIME -> PRODUCT : what the server action wires                          */
/* ========================================================================== */

describe('RUNTIME -> PRODUCT — the server action selects, never falls back', () => {
  const action = code(read(SERVER_ACTION))

  it('demands scope attestation', () => {
    expect(action).toMatch(/requireScopeAttestation:\s*true/)
  })

  it('names the extractive generator explicitly rather than relying on a default', () => {
    // `runGroundedQuery` defaults to the extractive provider. Relying on that
    // default would make "which generator answered?" a question about another
    // module's constant, and would make swapping that default a silent change
    // of product behaviour.
    expect(action).toMatch(/generator:\s*createExtractiveAnswerProvider\(\)/)
  })

  it('has no branch that selects a generator because something failed', () => {
    // The prohibition that matters most: an extractive answer produced because
    // a database was down would present a system fault as an evidence finding.
    expect(action).not.toMatch(/catch[\s\S]{0,200}createExtractiveAnswerProvider/)
    expect(action).not.toMatch(/\?\?\s*createExtractiveAnswerProvider/)
  })

  it('charges through the GOVERNED ticket path, and never calls consume_stella_quota directly', () => {
    // INT-INT-001, now CLOSED (Train 4.1). This test used to assert the
    // absence of any charge, with the reason named so that whoever wired it
    // would be forced to state the idempotency source. That source now exists,
    // so the assertion inverts — but only halfway, and the surviving half is
    // the one that was always the real property:
    //
    //   the action must NOT call `uellix_stella.consume_stella_quota` itself.
    //
    // A direct call would need an idempotency key chosen HERE, which is
    // exactly the thing with no trustworthy source. The key is derived inside
    // `complete_operation_ticket` from a nonce no function returns, so the
    // only correct way to charge is to not be the one charging.
    const raw = read(SERVER_ACTION)
    expect(raw).not.toMatch(/uellix_stella\.consume_stella_quota\s*\(/)
    expect(raw).not.toMatch(/SELECT[\s\S]{0,80}consume_stella_quota/)
    // The contract is still named, so the trail from code to decision survives.
    expect(raw).toMatch(/INT-INT-001/)
    // And the charge now happens, through the ticket.
    expect(raw).toMatch(/completeOperationTicket\s*\(/)
    expect(raw).toMatch(/bindOperationTicket\s*\(/)
    expect(raw).toMatch(/abortOperationTicket|releaseTicket/)
    // The old marker is gone: a constant saying "not charged" while the action
    // charges would be the most misleading line in the file.
    expect(raw).not.toMatch(/QUOTA_LEDGER_NOT_CHARGED/)
  })

  it('checks the feature flag before authenticating, and before any database work', () => {
    // Measured inside the FUNCTION BODY, not over the whole file: the import
    // block names `withOrganizationDatabaseContext` dozens of lines above any
    // of these, so a file-wide indexOf would compare an import against a call
    // and report the order backwards.
    const body = action.slice(action.indexOf('async function runStellaGroundedQuery('))
    // G-03: the gate asks the CAPABILITY, and the capability is named. Anchoring
    // on `isStellaCapabilityReady(` alone would still pass if someone asked for
    // a different capability here; the argument is part of the assertion for
    // the same reason the flag name used to be.
    const flagAt = body.indexOf("isStellaCapabilityReady('grounded_query')")
    const authAt = body.indexOf('requireOrganizationAccess()')
    const dbAt = body.indexOf('withOrganizationDatabaseContext(')
    expect(flagAt).toBeGreaterThan(0)
    expect(authAt).toBeGreaterThan(0)
    expect(dbAt).toBeGreaterThan(0)
    expect(flagAt).toBeLessThan(authAt)
    expect(flagAt).toBeLessThan(dbAt)
    // ...and the role check still precedes the first statement that reads.
    expect(body.indexOf('canUseStella(')).toBeLessThan(dbAt)
  })

  it('derives scope and never reads one from the request', () => {
    expect(action).not.toMatch(/request\.(organizationId|projectId|scope)/)
    expect(action).toMatch(/organizationId\s*=\s*ctx\.organization\.id/)
  })

  it('R9 — the disclosure classification is derived from the run, not from a literal in Product', () => {
    const raw = read(SERVER_ACTION)
    expect(raw).toMatch(/answerStrategy:\s*\{/)
    expect(raw).toMatch(/generatorId: run\.provenance\.generatorId/)
    // Prefix match on the NAME so a version bump cannot silently drop the
    // disclosure.
    expect(raw).toMatch(/startsWith\(`\$\{EXTRACTIVE_GENERATOR_NAME\}\//)

    // ...and the panel must not carry the generator's identity at all.
    const panel = code(read('components/stella/StellaGroundedQueryPanel.tsx'))
    expect(panel).not.toMatch(/grounding-local-extractive/)
    expect(panel).toMatch(/strategy\.kind === 'extractive'/)
  })

  it('the generator id the disclosure keys on is the one the generator actually reports', () => {
    // Ties the runtime constant to the contract: a rename in
    // extractive-generator.ts that missed the action would make the prefix
    // check above pass against a name nothing produces.
    expect(EXTRACTIVE_GENERATOR_ID).toBe(`${EXTRACTIVE_GENERATOR_NAME}/${EXTRACTIVE_GENERATOR_VERSION}`)
    expect(EXTRACTIVE_GENERATOR_ID.startsWith(`${EXTRACTIVE_GENERATOR_NAME}/`)).toBe(true)
  })
})

/* ========================================================================== */
/* Governed surface only — no service_role, no broad SELECT                   */
/* ========================================================================== */

describe('both adapters stay on the governed surface', () => {
  it.each([READ_ADAPTER, WRITE_ADAPTER])('%s uses no service_role and no owner credential', (rel) => {
    const src = code(read(rel))
    expect(src).not.toMatch(/service_role/)
    expect(src).not.toMatch(/SET ROLE/i)
    expect(src).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('the write adapter reaches the four governed functions and nothing else', () => {
    const src = code(read(WRITE_ADAPTER))
    for (const fn of [
      'claim_active_document_version',
      'register_document_version',
      'insert_evidence_chunks',
      'finalize_document_ingestion',
    ]) {
      expect(src, `${fn} is not called`).toMatch(new RegExp(`uellix_grounding\\.${fn}\\(`))
    }
    // No direct write to the governed tables — the whole point of the port.
    expect(src).not.toMatch(/INSERT\s+INTO\s+public\.evidence_/i)
    expect(src).not.toMatch(/UPDATE\s+public\.evidence_/i)
    expect(src).not.toMatch(/DELETE\s+FROM\s+public\.evidence_/i)
  })

  it('the write adapter re-imposes the PROJECT boundary that INT-GR-001 leaves open', () => {
    // claim_active_document_version checks the organization and does NOT
    // filter project_id — its final predicate is `v.evidence_id =
    // p_evidence_id` alone. The adapter cannot fix the function (changing its
    // return type needs a new package) but it can refuse to be the caller that
    // makes it exploitable.
    const src = code(read(WRITE_ADAPTER))
    expect(src).toMatch(/assertEvidenceInScope/)
    expect(src).toMatch(/project_id\s*=\s*\$\{scope\.projectId\}/)
  })

  it('the read adapter still reports the line range as NOT PERSISTED (INT-GR-003)', () => {
    // The decision GROUNDING made and this train preserves: persist the two
    // columns when the SQL contract exists, do not make them nullable, do not
    // invent them today. The sentinel is outside the documented 1-based domain
    // so "not recoverable" is distinguishable from a plausible wrong number.
    const src = read(READ_ADAPTER)
    expect(src).toMatch(/LINE_RANGE_NOT_PERSISTED\s*=\s*0/)
    expect(src).toMatch(/lineStart: LINE_RANGE_NOT_PERSISTED/)
    expect(src).toMatch(/lineEnd: LINE_RANGE_NOT_PERSISTED/)
  })
})

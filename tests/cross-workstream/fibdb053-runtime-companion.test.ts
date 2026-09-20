// @vitest-environment node
//
// tests/cross-workstream/fibdb053-runtime-companion.test.ts
// FIBDB-053 RUNTIME COMPANION — orchestration, cardinality and the closed
// boundaries of the compatibility slice.
//
// Authority:
//   docs/ops/wave3/FIBDB053_RUNTIME_COMPANION_EXECUTION_AUTHORITY_v1.0.0.json
//   docs/ops/wave3/FIBDB053_RUNTIME_COMPANION_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1.json
//   docs/ops/wave3/FIBDB053_RUNTIME_COMPANION_TEST_MANIFEST_v1.0.0.json
//   docs/ops/wave3/FIBDB053_RUNTIME_COMPANION_TEST_MANIFEST_AMENDMENT_v1.0.1.json
//
// ---------------------------------------------------------------------------
// WHAT IS REAL HERE, AND WHAT IS SUBSTITUTED
// ---------------------------------------------------------------------------
// REAL: `db/stella/operation-tickets.ts` (the bridge itself), the SQL it
// builds, `lib/stella/operation-ticket/governed-operation.ts`, the category
// registry, and the repository's own diff at this base.
//
// SUBSTITUTED: the CONNECTION and the identity context. The fake below models
// PostgreSQL's arity dispatch — a call whose arity the catalog does not hold
// raises 42883, and a statement issued in an already-failed transaction raises
// 25P02 — and both of those behaviours were MEASURED against a real catalog in
// tests/postgres/fibdb053-runtime-companion-catalog.pg.test.ts before being
// modelled here. The catalog proof lives there; what lives here is how many
// times the bridge asks, and in which transaction it asks.
//
// The manifest is explicit that a mock may test ORCHESTRATION and may not
// substitute for Real-PG catalog proof. That division is the one this file and
// its sibling draw.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

import { readSourceText } from '@/tests/helpers/source-text'
import {
  STELLA_CATEGORY_RISK_DISPOSITIONS,
  STELLA_INTERACTION_CATEGORIES,
  type StellaInteractionCategory,
} from '@/lib/stella/operation-ticket/categories'

const ROOT = process.cwd()
const BRIDGE_PATH = path.join(ROOT, 'db', 'stella', 'operation-tickets.ts')

/**
 * The bridge's ORIGINAL bytes, captured once at module load.
 *
 * The mutation battery in §3 rewrites this file on disk and must put it back.
 * It restores from THIS buffer and never from git: a `git checkout --` during a
 * mutation battery discards every uncommitted change in the working tree, not
 * just the last mutation, and that has cost real work in this repository
 * before.
 */
const BRIDGE_ORIGINAL = readFileSync(BRIDGE_PATH, 'utf8')

const dialect = new PgDialect()

/* ========================================================================== */
/* §1  T1 — type and exhaustiveness                                           */
/* ========================================================================== */

describe('§1 T1 — every category states a risk position, and the fields are required', () => {
  it('all six interaction categories have a disposition, and only those six', () => {
    expect(Object.keys(STELLA_CATEGORY_RISK_DISPOSITIONS).sort()).toEqual(
      [...STELLA_INTERACTION_CATEGORIES].sort(),
    )
    // `grounded_query` settles through the three-argument verb and files no
    // `stella_interactions` row. Its ABSENCE is the correct position, and
    // asserting it keeps a future lane from "completing" the registry.
    expect(Object.keys(STELLA_CATEGORY_RISK_DISPOSITIONS)).not.toContain('grounded_query')
  })

  it('the four derived categories are exactly validator and the THREE reviewer categories', () => {
    const derived = Object.entries(STELLA_CATEGORY_RISK_DISPOSITIONS)
      .filter(([, d]) => d === 'DERIVED')
      .map(([c]) => c)
      .sort()
    // NOT "validator and reviewer". `reviewer` is an ACTION, not a category,
    // and hardening the FIB's phrase literally would harden two names — one of
    // which does not exist — and leave three real categories unhardened.
    expect(derived).toEqual(['audit_assistant', 'evidence_reviewer', 'proxy_reviewer', 'validator'])

    const explicitNull = Object.entries(STELLA_CATEGORY_RISK_DISPOSITIONS)
      .filter(([, d]) => d === 'EXPLICIT_NULL')
      .map(([c]) => c)
      .sort()
    expect(explicitNull).toEqual(['advisor', 'composer'])
  })

  it('a seventh category without a disposition does NOT typecheck', () => {
    // The mechanism, asserted rather than described: the registry is a
    // `Record` over the category union, so the compiler — not a test — is what
    // refuses an incomplete one. MUT-RC-11 typechecks under an OPTIONAL field,
    // which is why the compiler alone is not enough and §1 also pins the
    // declarations below.
    const registrySource = readSourceText('lib/stella/operation-ticket/categories.ts')
    expect(registrySource).toContain('export const STELLA_CATEGORY_RISK_DISPOSITIONS: Record<')
    expect(registrySource).toContain('StellaInteractionCategory,')

    // A compile-time witness that costs nothing at runtime: if a name were
    // added to the union without a disposition, this indexed access would be
    // an error at `tsc --noEmit`, which is an exit gate of this node.
    const exhaustive: Record<StellaInteractionCategory, true> = {
      advisor: true, validator: true, composer: true,
      proxy_reviewer: true, evidence_reviewer: true, audit_assistant: true,
    }
    expect(Object.keys(exhaustive)).toHaveLength(STELLA_INTERACTION_CATEGORIES.length)
  })

  it('MUT-RC-11 — riskLevel and riskFlags are REQUIRED-and-nullable on both carriers, never optional', () => {
    const payload = readSourceText('db/stella/operation-tickets.ts')
    const execution = readSourceText('lib/stella/operation-ticket/governed-operation.ts')

    // The mutant makes them optional. `readonly riskLevel?:` typechecks
    // everywhere, so the compiler cannot see it — this assertion can.
    for (const source of [payload, execution]) {
      expect(source).toMatch(/readonly riskLevel: StellaInteractionRiskLevel \| null/)
      expect(source).toMatch(/readonly riskFlags: readonly string\[\] \| null/)
      expect(source).not.toMatch(/riskLevel\?:/)
      expect(source).not.toMatch(/riskFlags\?:/)
    }
  })

  it('every governed execute() return supplies BOTH fields explicitly', () => {
    // FIVE `execute` returns across four files: validator, reviewer, composer
    // and TWO in advisor. A position declared at only one advisor call site
    // would not be a position.
    //
    // Counted inside the EXECUTE RETURN BLOCK and not over the whole file, and
    // the distinction is the same one T8 makes: validator and reviewer also
    // write `riskLevel` into the `audit_logs` payload, and a naive file-wide
    // count would treat the TRAIL as though it were the governed carrier. The
    // trail is not the carrier, and a control that cannot tell them apart
    // would stay green if the payload assignment were deleted and only the
    // audit one survived — which is precisely the status quo this node closes.
    const sites: ReadonlyArray<readonly [string, number]> = [
      ['app/actions/stella/validator.ts', 1],
      ['app/actions/stella/reviewer.ts', 1],
      ['app/actions/stella/advisor.ts', 2],
      ['app/actions/stella/composer.ts', 1],
    ]
    for (const [file, expected] of sites) {
      const blocks = executeReturnBlocks(readSourceText(file))
      expect(blocks, `${file}: execute() returns`).toHaveLength(expected)
      for (const block of blocks) {
        expect(block, `${file}: an execute() return omits riskLevel`).toMatch(/\briskLevel: /)
        expect(block, `${file}: an execute() return omits riskFlags`).toMatch(/\briskFlags: /)
      }
    }
  })
})

/* ========================================================================== */
/* §2  T3 — per-field propagation through the governed driver                 */
/* ========================================================================== */

describe('§2 T3 — risk travels through the governed execution result into the payload', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('@/db/stella/operation-tickets')
  })

  /** Drive the REAL driver with the ticket adapter captured. */
  async function runDriver(execution: Record<string, unknown>) {
    vi.resetModules()
    const payloads: Record<string, unknown>[] = []
    vi.doMock('@/db/stella/operation-tickets', () => ({
      completeStellaInteractionTicket: async (
        _t: string, _p: string, _h: string, payload: Record<string, unknown>,
      ) => { payloads.push(payload); return { kind: 'completed', used: 1, quota: 10 } },
      bindOperationTicket: async () => ({ kind: 'bound', used: 0, quota: 10 }),
      inspectOperationTicket: async () => ({
        status: 'bound', category: 'validator', expiresAt: '', hasQueryHash: true,
      }),
      abortOperationTicket: async () => ({ kind: 'aborted' }),
    }))
    const { runGovernedStellaOperation } = await import('@/lib/stella/operation-ticket/governed-operation')
    const outcome = await runGovernedStellaOperation({
      category: 'validator',
      organizationId: '11111111-1111-4111-8111-1111111111a1',
      projectId: '22222222-2222-4222-8222-2222222222a1',
      ticket: 'c'.repeat(64),
      requestParts: ['Calculation'],
      execute: async () => execution as never,
    })
    return { outcome, payloads }
  }

  it('both fields reach the completion payload, asserted PER FIELD', async () => {
    const { outcome, payloads } = await runDriver({
      ok: true, data: { verdict: 'ok' }, pipelineStep: 'Calculation',
      modelUsed: 'gemini-test', tokensUsed: 11,
      riskLevel: 'high', riskFlags: ['proxy_risk', 'claim_risk'],
    })
    expect(outcome).toEqual({ kind: 'completed', data: { verdict: 'ok' } })
    expect(payloads).toHaveLength(1)
    // PER FIELD and not as one object. MUT-RC-05 drops riskFlags and keeps
    // riskLevel; a `toEqual` on the whole payload would catch it, but a
    // `toMatchObject({ riskLevel })` — the shape a well-meaning edit reaches
    // for — would not.
    expect(payloads[0].riskLevel).toBe('high')
    expect(payloads[0].riskFlags).toEqual(['proxy_risk', 'claim_risk'])
    // The four fields that already travelled are untouched by the addition.
    expect(payloads[0].pipelineStep).toBe('Calculation')
    expect(payloads[0].modelUsed).toBe('gemini-test')
    expect(payloads[0].tokensUsed).toBe(11)
    expect(payloads[0].responseJson).toEqual({ verdict: 'ok' })
    // 30s, not the 5s default: this is the first test in the file to pull in
    // the governed driver and its transitive graph, and a cold transform of
    // that graph exceeds five seconds on a loaded host. A timeout here is an
    // environment fact, not a defect in the propagation being asserted.
  }, 30_000)

  it('explicit nulls arrive as nulls and the key is PRESENT', async () => {
    const { payloads } = await runDriver({
      ok: true, data: { draft: 'x' }, pipelineStep: 'Report',
      modelUsed: 'gemini-test', tokensUsed: 3, riskLevel: null, riskFlags: null,
    })
    expect(payloads[0].riskLevel).toBeNull()
    expect(payloads[0].riskFlags).toBeNull()
    // `in`, not a truthiness check. An OMITTED key and a key set to `null` are
    // the same under `payload.riskLevel === null`, and the difference between
    // them is the whole explicit-null rule.
    expect('riskLevel' in payloads[0]).toBe(true)
    expect('riskFlags' in payloads[0]).toBe(true)
  }, 30_000)
})

/* ========================================================================== */
/* §3  The bridge harness — arity dispatch, cardinality, transactions         */
/* ========================================================================== */

interface Harness {
  /**
   * What the PROBE reports.
   *
   * Separate from `heldArity` ON PURPOSE. In a healthy catalog the two agree,
   * and tying them to one flag would make the disagreement — the probe says
   * NEW_DB and the nine-argument call still raises 42883 — unrepresentable.
   * That disagreement is precisely the terminal case of the bounded-once rule,
   * and a harness that cannot express it cannot test it.
   */
  probeSays: 'OLD_DB' | 'NEW_DB'
  /** Which arity the modelled catalog will actually accept. `null` = neither. */
  heldArity: 7 | 9 | null
  /** Every completion statement the bridge issued, by argument count. */
  readonly issued: number[]
  /** One entry per transaction opened, in order, holding the statements it ran. */
  readonly transactions: string[][]
  /** Transactions poisoned by a failed statement, as PostgreSQL poisons them. */
  readonly aborted: Set<number>
  /** Probe statements, counted independently of the bridge's own counter. */
  readonly probes: number[]
}

function sqlStateError(code: string, message: string): Error {
  // The shape the driver stack actually produces: drizzle wraps the failure and
  // the PostgresError with the SQLSTATE sits on `cause`. Reading a top-level
  // `.code` finds `undefined` for every real refusal, which is a defect this
  // repository has already paid for once.
  const inner = Object.assign(new Error(message), { code })
  return Object.assign(new Error('Failed query'), { cause: inner })
}

/** A CONSISTENT catalog: the probe reports what the dispatch will accept. */
function makeHarness(state: 'OLD_DB' | 'NEW_DB'): Harness {
  return {
    probeSays: state,
    heldArity: state === 'NEW_DB' ? 9 : 7,
    issued: [], transactions: [], aborted: new Set(), probes: [],
  }
}

/**
 * Load the REAL bridge over a modelled connection.
 *
 * The fake `execute` reproduces two MEASURED PostgreSQL behaviours and nothing
 * else: an arity the catalog does not hold raises 42883, and any statement in
 * an already-failed transaction raises 25P02 regardless of what it says.
 */
/**
 * The bridge's module specifier.
 *
 * `vi.resetModules()` clears the EXECUTED-module registry; it does not
 * invalidate the transform vite already produced for a module id. A battery
 * that rewrites the file on disk and re-imports the same id therefore re-runs
 * the ORIGINAL code — measured here: with a plain re-import, all three
 * MUT-RC-13 mutants "passed", which is the vacuity the non-vacuity rule
 * exists to forbid. A distinct id per mutant is a distinct transform, and a
 * distinct transform is a fresh read of the file.
 */
const BRIDGE_MODULE = '../../db/stella/operation-tickets'

async function loadBridgeWith(harness: Harness, specifier: string = BRIDGE_MODULE) {
  vi.resetModules()

  let current = -1
  vi.doMock('@/lib/auth/database-context', () => ({
    withOrganizationDatabaseContext: async <T,>(cb: (ctx: unknown) => Promise<T>) => {
      harness.transactions.push([])
      const mine = harness.transactions.length - 1
      const previous = current
      current = mine
      try {
        return await cb({})
      } finally {
        current = previous
      }
    },
  }))

  vi.doMock('@/db/client', () => ({
    db: {
      execute: async (statement: SQL) => {
        const { sql: text, params } = dialect.sqlToQuery(statement)
        harness.transactions[current]?.push(text)

        if (harness.aborted.has(current)) {
          throw sqlStateError('25P02', 'current transaction is aborted, commands ignored until end of transaction block')
        }

        if (text.includes('to_regprocedure')) {
          harness.probes.push(current)
          // The probe asks about the NINE-argument literal, and the literal is
          // the parameter — so the fake answers the same question the catalog
          // would, rather than answering a question of its own invention.
          expect(params[0]).toContain('character varying,text[]')
          return [{ installed: harness.probeSays === 'NEW_DB' }]
        }

        const arity = params.length
        harness.issued.push(arity)
        if (arity !== harness.heldArity) {
          harness.aborted.add(current)
          throw sqlStateError('42883', `function uellix_stella_ops.complete_operation_ticket(...) does not exist`)
        }
        return [{ outcome: 'completed', used: 1, quota: 10 }]
      },
    },
  }))

  return (await import(/* @vite-ignore */ specifier)) as typeof import('@/db/stella/operation-tickets')
}

const TICKET = 'a'.repeat(64)
const HASH = 'b'.repeat(64)
const PROJECT = '22222222-2222-4222-8222-2222222222a1'
const PAYLOAD = {
  pipelineStep: 'Calculation', modelUsed: 'gemini-test', tokensUsed: 1,
  responseJson: { ok: true }, riskLevel: 'high' as const, riskFlags: ['finding'],
}

/* -------------------------------------------------------------------------- */
/* N-RC-11's PREDICATE — shared, so the mutation battery cannot re-express it */
/* -------------------------------------------------------------------------- */

/**
 * The bounded-once rule, as ONE predicate.
 *
 * Called by N-RC-11 (which expects it to hold) and by every MUT-RC-13 mutant
 * (which expects it to throw). That sharing is the anti-vacuity property: a
 * battery that restated the cardinality inside itself would prove only that the
 * copy goes red, which is the defect the manifest names explicitly.
 *
 * It drives a real 42883 through the real bridge and asserts, on that one
 * driven failure:
 *   SETUP   — the 42883 actually reached the bridge (a setup that fails earlier
 *             produces ZERO probes and would satisfy a naive "<= 1" assertion
 *             vacuously);
 *   ONE re-probe after the 42883, as a PER-CALL invocation delta;
 *   AT MOST ONE retry, and that retry in a NEW transaction;
 *   no delay ladder between probes.
 */
async function assertBoundedOnceReprobe(specifier: string = BRIDGE_MODULE): Promise<void> {
  const harness = makeHarness('NEW_DB')
  const bridge = await loadBridgeWith(harness, specifier)

  // A FRESH module instance. If the import were served from cache, the probe
  // counter would carry a previous test's invocations and every delta below
  // would be measured against the wrong baseline.
  expect(bridge.completionSignatureProbeCount()).toBe(0)

  // Warm the cache to NEW_DB with a completion that succeeds.
  const warm = await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)
  expect(warm).toEqual({ kind: 'completed', used: 1, quota: 10 })

  // The catalog changes under the process — Stage-A is rolled back.
  harness.probeSays = 'OLD_DB'
  harness.heldArity = 7
  const probesBefore = bridge.completionSignatureProbeCount()
  const issuedBefore = harness.issued.length
  const transactionsBefore = harness.transactions.length
  const startedAt = Date.now()

  const result = await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)

  // SETUP=SUCCESS. The nine-argument call was issued and it is the one that
  // raised 42883. Without this the cardinality assertions below would be
  // satisfied by a bridge that never called at all.
  expect(harness.issued.slice(issuedBefore)[0]).toBe(9)

  // EXACTLY ONE re-probe — a per-call delta on the real probe path, not a
  // boolean, and not a spy standing in for the module under test.
  expect(bridge.completionSignatureProbeCount() - probesBefore).toBe(1)

  // AT MOST ONE retry: two completion statements in total, the failed nine and
  // the retried seven.
  expect(harness.issued.slice(issuedBefore)).toEqual([9, 7])

  // THE RETRY IS IN A NEW TRANSACTION. Asserted as a transaction the failed
  // statement did not run in — which is what keeps it from being 25P02.
  const opened = harness.transactions.slice(transactionsBefore)
  const failedTransaction = transactionsBefore
  expect(opened.length).toBeGreaterThanOrEqual(3) // failed call, re-probe, retry
  expect(harness.aborted.has(failedTransaction)).toBe(true)
  expect(harness.transactions[harness.transactions.length - 1]).toHaveLength(1)

  // NO BACKOFF LADDER. A delay ladder between re-probes is a MUT-RC-13 mutant,
  // and the only observable it leaves is elapsed time.
  expect(Date.now() - startedAt).toBeLessThan(200)

  expect(result).toEqual({ kind: 'completed', used: 1, quota: 10 })
}

describe('§3 the bridge — arity dispatch and bounded-once recovery', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('N-RC-01 — the SEVEN-argument branch exists: an un-applied database completes', async () => {
    const harness = makeHarness('OLD_DB')
    const bridge = await loadBridgeWith(harness)
    const result = await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)
    // A bridge that can only call nine arguments fails here. The mutant
    // MUT-RC-02 removes this branch.
    expect(result).toEqual({ kind: 'completed', used: 1, quota: 10 })
    expect(harness.issued).toEqual([7])
  })

  it('N-RC-02 — the NINE-argument branch exists: an applied database is fed both parameters', async () => {
    const harness = makeHarness('NEW_DB')
    const bridge = await loadBridgeWith(harness)
    const result = await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)
    // MUT-RC-03 removes this branch, which silently restores the original
    // defect while appearing to succeed — the ledger would look right and the
    // risk columns would stay NULL forever.
    expect(result).toEqual({ kind: 'completed', used: 1, quota: 10 })
    expect(harness.issued).toEqual([9])
  })

  it('the arity is decided BEFORE the call — the probe precedes every completion', async () => {
    const harness = makeHarness('NEW_DB')
    const bridge = await loadBridgeWith(harness)
    await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)
    // P-4: never probe by calling the function speculatively and reading the
    // error. On the governed path a speculative call to a COMPLETION verb risks
    // a charge, so "probe first" is a billing property and not a style.
    const first = harness.transactions.flat()[0]
    expect(first).toContain('to_regprocedure')
    expect(bridge.completionSignatureProbeCount()).toBe(1)
  })

  it('the verdict is CACHED per process — a second completion adds no catalog round trip', async () => {
    const harness = makeHarness('NEW_DB')
    const bridge = await loadBridgeWith(harness)
    await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)
    await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)
    expect(bridge.completionSignatureProbeCount()).toBe(1)
    expect(harness.issued).toEqual([9, 9])
  })

  it('P-5 — a probe that ERRORS is UNKNOWN, never OLD_DB', async () => {
    const harness = makeHarness('NEW_DB')
    await loadBridgeWith(harness)
    vi.resetModules()

    // Re-load with a connection that refuses the probe itself.
    vi.doMock('@/lib/auth/database-context', () => ({
      withOrganizationDatabaseContext: <T,>(cb: (ctx: unknown) => Promise<T>) => cb({}),
    }))
    vi.doMock('@/db/client', () => ({
      db: {
        execute: async (statement: SQL) => {
          const { sql: text } = dialect.sqlToQuery(statement)
          if (text.includes('to_regprocedure')) throw sqlStateError('42501', 'permission denied')
          throw new Error('the completion must never be reached')
        },
      },
    }))
    const refusing = await import('@/db/stella/operation-tickets')
    const result = await refusing.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)

    // FAIL CLOSED, and named. Treating the error as OLD_DB is the tempting
    // reading — OLD_DB "works", it just silently stops filing risk — and it is
    // exactly what P-5 forbids.
    expect(result).toEqual({ kind: 'rejected', reason: 'signature_mismatch' })
    expect(harness.issued).toEqual([])
  })

  it('N-RC-11 — the re-probe is bounded to ONE, and the retry to ONE, in a new transaction', async () => {
    await assertBoundedOnceReprobe()
  })

  it('FAIL CLOSED when the re-probe reports the SAME state — and no second probe', async () => {
    const harness = makeHarness('NEW_DB')
    const bridge = await loadBridgeWith(harness)
    await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)

    // The probe keeps answering NEW_DB while the catalog accepts NEITHER arity
    // — a database that is not the shape it reports itself to be. This is the
    // terminal case of the bounded-once rule and it is why `probeSays` and
    // `heldArity` are separate knobs: with one flag it is unrepresentable.
    harness.heldArity = null
    const probesBefore = bridge.completionSignatureProbeCount()
    const issuedBefore = harness.issued.length

    const result = await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)

    // Refused, and named. Fail closed means the caller does NOT receive the
    // answer — it does not mean "fall back to the other arity".
    expect(result).toEqual({ kind: 'rejected', reason: 'signature_mismatch' })
    // ONE re-probe and NO second invalidation.
    expect(bridge.completionSignatureProbeCount() - probesBefore).toBe(1)
    // ONE completion attempt, not two: the re-probe said the same state, so no
    // retry was permitted. A bridge that retried anyway would show [9, 9].
    expect(harness.issued.slice(issuedBefore)).toEqual([9])
  })

  it('a NON-42883 failure is classified normally and triggers NO probe at all', async () => {
    const harness = makeHarness('NEW_DB')
    const bridge = await loadBridgeWith(harness)
    await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)
    const probesBefore = bridge.completionSignatureProbeCount()

    vi.resetModules()
    vi.doMock('@/lib/auth/database-context', () => ({
      withOrganizationDatabaseContext: <T,>(cb: (ctx: unknown) => Promise<T>) => cb({}),
    }))
    vi.doMock('@/db/client', () => ({
      db: {
        execute: async (statement: SQL) => {
          const { sql: text } = dialect.sqlToQuery(statement)
          if (text.includes('to_regprocedure')) return [{ installed: true }]
          // U0102 — the ledger's own scope refusal, not a signature question.
          throw sqlStateError('U0102', 'out of scope')
        },
      },
    }))
    const fresh = await import('@/db/stella/operation-tickets')
    const result = await fresh.completeStellaInteractionTicket(TICKET, PROJECT, HASH, PAYLOAD)

    // A retry is not a licence to relabel an ordinary refusal as a signature
    // problem, and an ordinary refusal must not spend a catalog round trip.
    expect(result).toEqual({ kind: 'rejected', reason: 'out_of_scope' })
    expect(fresh.completionSignatureProbeCount()).toBe(1)
    expect(probesBefore).toBe(1)
  })
})

/* ========================================================================== */
/* §4  MUT-RC-13 — the three unbounded-re-probe mutants                       */
/* ========================================================================== */

/**
 * Apply one mutation to the bridge on disk, run the SHARED predicate, and put
 * the file back.
 *
 * The anchor is asserted to be present before the substitution: a mutation that
 * silently matched nothing would leave the original file in place, the
 * predicate would pass, and the battery would report that a mutant it never
 * applied was caught.
 */
let mutantSerial = 0

async function withMutant(
  anchor: string,
  replacement: string,
  witness: string,
  run: (specifier: string) => Promise<void>,
): Promise<void> {
  expect(BRIDGE_ORIGINAL).toContain(anchor)
  expect(replacement).not.toBe(anchor)
  // The witness is a token that exists ONLY in the mutant. It is asserted
  // absent from the original first, so a mutation that quietly matched nothing
  // cannot be mistaken for one that was applied and caught.
  expect(BRIDGE_ORIGINAL).not.toContain(witness)

  mutantSerial += 1
  const specifier = `${BRIDGE_MODULE}.ts?mutant=${mutantSerial}`
  try {
    const mutated = BRIDGE_ORIGINAL.replace(anchor, replacement)
    expect(mutated).not.toBe(BRIDGE_ORIGINAL)
    writeFileSync(BRIDGE_PATH, mutated, 'utf8')
    // Read BACK from disk. Asserting the string we just built would prove only
    // that `String.replace` works.
    expect(readFileSync(BRIDGE_PATH, 'utf8')).toContain(witness)
    await run(specifier)
  } finally {
    writeFileSync(BRIDGE_PATH, BRIDGE_ORIGINAL, 'utf8')
  }
}

const REPROBE_ANCHOR = `  invalidateCompletionSignatureState()
  const reprobed = await probeCompletionSignature()
  if (reprobed !== null) cachedCompletionSignatureState = reprobed`

const RETRY_ANCHOR = `  try {
    return { ok: true, rows: await issueCompletion(reprobed, ticketId, expectedProjectId, operationHash, payload) }
  } catch (error) {`

describe('§4 MUT-RC-13 — each mutant drives N-RC-11 RED, individually', () => {
  afterEach(() => {
    vi.resetModules()
    writeFileSync(BRIDGE_PATH, BRIDGE_ORIGINAL, 'utf8')
  })

  afterAll(() => {
    // Belt and braces. A battery that leaves a mutant on disk turns every later
    // suite in the run into a test of the mutant.
    writeFileSync(BRIDGE_PATH, BRIDGE_ORIGINAL, 'utf8')
  })

  it('the battery actually mutates — the anchors exist in the real source', () => {
    // NON-VACUITY. Without this, a rename in the bridge would make all three
    // mutants no-ops and the three tests below would go green on the ORIGINAL
    // file, reporting that mutants were caught when none were applied.
    expect(BRIDGE_ORIGINAL).toContain(REPROBE_ANCHOR)
    expect(BRIDGE_ORIGINAL).toContain(RETRY_ANCHOR)
    expect(readFileSync(BRIDGE_PATH, 'utf8')).toBe(BRIDGE_ORIGINAL)
  })

  it('(a) SECOND RE-PROBE — invalidating and probing once more is CAUGHT', async () => {
    await withMutant(
      REPROBE_ANCHOR,
      `${REPROBE_ANCHOR}
  invalidateCompletionSignatureState()
  const mutRc13aSecondReprobe = await probeCompletionSignature()
  if (mutRc13aSecondReprobe !== null) cachedCompletionSignatureState = mutRc13aSecondReprobe`,
      'mutRc13aSecondReprobe',
      async (specifier) => {
        await expect(assertBoundedOnceReprobe(specifier)).rejects.toThrow()
      },
    )
  })

  it('(b) RETRY LOOP — replacing the one retry with a loop is CAUGHT', async () => {
    await withMutant(
      RETRY_ANCHOR,
      `  for (let mutRc13bAttempt = 0; mutRc13bAttempt < 3; mutRc13bAttempt += 1) {
    invalidateCompletionSignatureState()
    const looped = await probeCompletionSignature()
    if (looped !== null) cachedCompletionSignatureState = looped
    try {
      return { ok: true, rows: await issueCompletion(looped ?? reprobed, ticketId, expectedProjectId, operationHash, payload) }
    } catch {
      // swallow and go round again — the shape the rule forbids
    }
  }
  try {
    return { ok: true, rows: await issueCompletion(reprobed, ticketId, expectedProjectId, operationHash, payload) }
  } catch (error) {`,
      'mutRc13bAttempt',
      async (specifier) => {
        await expect(assertBoundedOnceReprobe(specifier)).rejects.toThrow()
      },
    )
  })

  it('(c) BACKOFF LADDER — delaying and re-probing between attempts is CAUGHT', async () => {
    await withMutant(
      RETRY_ANCHOR,
      `  for (const mutRc13cDelayMs of [60, 120, 240]) {
    await new Promise((resolve) => setTimeout(resolve, mutRc13cDelayMs))
    invalidateCompletionSignatureState()
    const laddered = await probeCompletionSignature()
    if (laddered !== null) cachedCompletionSignatureState = laddered
  }
  try {
    return { ok: true, rows: await issueCompletion(reprobed, ticketId, expectedProjectId, operationHash, payload) }
  } catch (error) {`,
      'mutRc13cDelayMs',
      async (specifier) => {
        await expect(assertBoundedOnceReprobe(specifier)).rejects.toThrow()
      },
    )
  })
})

/* ========================================================================== */
/* §5  The closed boundaries of the slice                                     */
/* ========================================================================== */

describe('§5 the slice stays inside its own surface', () => {
  const SLICE_FILES = [
    'db/stella/operation-tickets.ts',
    'lib/stella/operation-ticket/governed-operation.ts',
    'lib/stella/operation-ticket/categories.ts',
    'app/actions/stella/validator.ts',
    'app/actions/stella/reviewer.ts',
    'app/actions/stella/advisor.ts',
    'app/actions/stella/composer.ts',
  ] as const

  it('N-RC-04 — no environment variable, configuration value or build flag selects the arity', () => {
    for (const file of SLICE_FILES) {
      const code = stripComments(readSourceText(file))
      // Asserted as an ABSENCE over the slice's surface. A mutant that
      // introduces a flag is CAUGHT even when its default preserves correct
      // behaviour: the defect is the EXISTENCE of a second source of truth for
      // the arity, not a wrong value.
      expect(code, `${file} reads process.env`).not.toMatch(/process\.env/)
    }
    const bridge = stripComments(readSourceText('db/stella/operation-tickets.ts'))
    // P-3: the repository's own package order describes what the REPOSITORY
    // holds, never what the CONNECTED DATABASE has installed, and the two
    // diverge during exactly the window the bridge covers.
    expect(bridge).not.toMatch(/prepared-package-order/)
    expect(bridge).not.toMatch(/PREPARED_PACKAGE/)
    // The state is settable from nowhere: invalidation is exported, assignment
    // is not.
    const source = readSourceText('db/stella/operation-tickets.ts')
    expect(source).toContain('export function invalidateCompletionSignatureState()')
    expect(source).not.toMatch(/export function setCompletionSignatureState/)
    expect(source).not.toMatch(/export const setCompletionSignature/)
  })

  it('N-RC-07 — the advisor readiness edge is untouched', () => {
    const advisor = readSourceText('app/actions/stella/advisor.ts')
    // The ONE read edge between the slice and FIBIU-19. The import and its call
    // site survive byte-for-byte; the slice's edit to this file is confined to
    // the explicit-null risk fields. A sequencing exception granted on
    // disjointness must not be spent on an incidental refactor.
    expect(advisor).toContain("import { getSroiCalculationReadiness } from '@/lib/pipeline/sroi-calculation'")
    expect([...advisor.matchAll(/getSroiCalculationReadiness\(/g)]).toHaveLength(1)
    expect(advisor).toContain('getSroiCalculationReadiness(projectId)')
  })

  it('T8 — audit_logs is never a source of truth for a risk value', () => {
    for (const file of SLICE_FILES) {
      const code = stripComments(readSourceText(file))
      // The forbidden shortcut: reading a risk level back out of the trail. It
      // is tempting precisely because the values are already there and reading
      // them would appear to close the gap without waiting for Stage-A.
      expect(code).not.toMatch(/auditLogs[\s\S]{0,80}riskLevel/)
      expect(code).not.toMatch(/riskLevel[\s\S]{0,40}from[\s\S]{0,40}audit/i)
    }
    // And the existing best-effort trail write is STILL THERE. T8 proves the
    // trail is not the SOURCE, not that it was deleted — a trail is not made
    // wrong by the arrival of a durable row.
    for (const file of ['app/actions/stella/validator.ts', 'app/actions/stella/reviewer.ts']) {
      const source = readSourceText(file)
      expect(source).toContain('logStellaAudit')
      expect(source).toMatch(/riskLevel: outcome\.data\.risk_level/)
    }
  })

  it('T9 — a signature mismatch is distinguishable from ordinary unavailability', () => {
    const source = readSourceText('db/stella/operation-tickets.ts')
    // In the WRAPPER'S OWN refusal reason, which is where an operator reads it.
    expect(source).toMatch(/\|\s*'signature_mismatch'/)
    expect(source).toMatch(/\|\s*'unavailable'/)
    // Distinct, not collapsed. Without the distinction the single most likely
    // deployment-order mistake presents as generic noise.
    const driver = readSourceText('lib/stella/operation-ticket/governed-operation.ts')
    // On the PRODUCT side it joins `unavailable` — it is a statement about the
    // DATABASE, never about the caller, so it must not reach a reviewer as
    // UNAUTHORIZED.
    expect(driver).toContain("reason === 'unavailable' || reason === 'signature_mismatch'")
  })

  it('no internal SQL or secret leaks into a refusal', () => {
    const driver = readSourceText('lib/stella/operation-ticket/governed-operation.ts')
    const presentation = driver.slice(driver.indexOf('export function governedRejectionPresentation'))
    expect(presentation).not.toMatch(/to_regprocedure/)
    expect(presentation).not.toMatch(/uellix_stella_ops/)
    expect(presentation).not.toMatch(/SELECT /)
  })

  it('N-RC-09 — the probed signature reconciles with the INTEGRATED Stage-A authority', async () => {
    const { NINE_ARGUMENT_COMPLETION_SIGNATURE } = await import('@/db/stella/operation-tickets')
    const stageA = JSON.parse(
      readSourceText('docs/ops/wave3/FIBDB053_STAGE_A_EXECUTION_AUTHORITY_v1.0.0.json'),
    ) as {
      FUNCTION_SUCCESSION_CONTRACT: {
        current_state_measured: { complete_7_arg: string }
        target_semantics_frozen: { complete: string; parameter_types: string }
      }
    }
    const contract = stageA.FUNCTION_SUCCESSION_CONTRACT

    // The predecessor, as the Stage-A authority measured it.
    expect(contract.current_state_measured.complete_7_arg).toContain(
      'uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)',
    )
    // The succession: SEVEN to NINE, two parameters appended, with these types.
    expect(contract.target_semantics_frozen.complete).toContain('7 args -> 9 args')
    expect(contract.target_semantics_frozen.parameter_types).toContain('p_risk_level varchar(50)')
    expect(contract.target_semantics_frozen.parameter_types).toContain('p_risk_flags text[]')

    // RECONCILED, argument for argument: the probe literal is the measured
    // seven-argument form with `character varying` and `text[]` appended, with
    // the whitespace `to_regprocedure`'s input form omits. A divergence here
    // STOPS the lane rather than being silently absorbed.
    const sevenArgs = 'character,uuid,character,character varying,character varying,integer,jsonb'
    expect(NINE_ARGUMENT_COMPLETION_SIGNATURE).toBe(
      `uellix_stella_ops.complete_operation_ticket(${sevenArgs},character varying,text[])`,
    )
  })
})

/* ========================================================================== */
/* §6  N-RC-05 / N-RC-06 / N-RC-08 — the diff itself                          */
/* ========================================================================== */

describe('§6 the diff at THIS base', () => {
  const changed = changedPaths()

  it('N-RC-05 — no FIBIU-19 path is touched, re-derived at this base', () => {
    // RE-DERIVED, never inherited: FIBIU-19's surface can grow, and the owner's
    // sequencing exception is conditional on an intersection that is EMPTY at
    // the implementing lane's own base — not at the base some earlier authority
    // measured.
    const fibiu19 = [
      'lib/pipeline/sroi-calculation.ts',
      'lib/pipeline/sroi-results.ts',
      'db/migrations/',
      'app/app/projects/[projectId]/pipeline/calculation/',
    ]
    for (const surface of fibiu19) {
      const hits = changed.filter((p) => p === surface || p.startsWith(surface))
      // `lib/pipeline/sroi-results.ts` is the sharpest case: it is chokepoint
      // SW-6, the domain authority's own stated reason for serialising
      // FIBIU-19 before FIBIU-20.
      expect(hits, `slice touches FIBIU-19 surface ${surface}`).toEqual([])
    }
    // And the FIBIU-20 work that is NOT the slice stays serial behind FIBIU-19.
    expect(changed).not.toContain('lib/pipeline/methodology-review.ts')
  })

  it('N-RC-08 — no protected path, and no non-canonically-cased variant of one', () => {
    const protectedPrefixes = [
      'db/prepared/', 'db/migrations/', 'db/baseline/',
      'docs/ops/fib/', 'docs/ops/pc01b/', 'docs/ops/im01b/',
    ]
    for (const p of changed) {
      const lower = p.toLowerCase()
      for (const prefix of protectedPrefixes) {
        // Lower-cased on BOTH sides: a non-canonically-cased variant is still a
        // protected path, and on a case-insensitive filesystem it is the same
        // file.
        expect(lower.startsWith(prefix), `protected path in diff: ${p}`).toBe(false)
      }
      expect(p).not.toBe('docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json')
      expect(lower.startsWith('docs/ops/ods/')).toBe(false)
    }
  })

  it('N-RC-06 — nothing in the slice applies, schedules or authorises a Stage-A apply', () => {
    // db/prepared/** is the likeliest violation, because the Stage-A SQL lives
    // there and merging the two nodes would look like convenience. The runtime
    // companion is the RUNTIME node; authoring or applying SQL here would merge
    // two nodes that the authority keeps apart.
    expect(changed.filter((p) => p.startsWith('db/prepared/'))).toEqual([])
    for (const file of [
      'db/stella/operation-tickets.ts',
      'lib/stella/operation-ticket/governed-operation.ts',
      'docs/ops/contracts/CONTRACT_LEDGER.md',
    ]) {
      const source = readSourceText(file)
      expect(source).not.toMatch(/G2[\s_-]?(gate|puerta)[\s\S]{0,40}(resolved|resuelta)/i)
      expect(source).not.toMatch(/stella_0017b\s+(is\s+)?applied/i)
    }
  })

  it('the write set is exactly the authorised surface', () => {
    const authorised = [
      ...SLICE_WRITE_SURFACE,
      'docs/ops/contracts/CONTRACT_LEDGER.md',
      // New controls.
      'tests/cross-workstream/fibdb053-runtime-companion.test.ts',
      'tests/postgres/fibdb053-runtime-companion-catalog.pg.test.ts',
      // PRE-EXISTING controls the payload contract invalidates, listed
      // separately so the distinction survives review. Each of the three froze
      // the completion payload's exact key set at FOUR, and the slice makes it
      // six. They are not relaxed: the key list grows and an explicit negative
      // is added naming the six values SQL reads off the ticket row, so the
      // security property the assertion existed for is stated by NAME instead
      // of resting on a count.
      'app/actions/stella/__tests__/validator.test.ts',
      'app/actions/stella/__tests__/advisor.test.ts',
      'app/actions/stella/__tests__/composer.test.ts',
    ]
    // The enumeration is CLOSED. A path not listed here has exceeded the slice,
    // and the authority's instruction for that is STOP_FOR_AUTHORITY_DELTA —
    // never a silent widening.
    expect(changed.filter((p) => !authorised.includes(p))).toEqual([])
  })
})

const SLICE_WRITE_SURFACE = [
  'db/stella/operation-tickets.ts',
  'lib/stella/operation-ticket/governed-operation.ts',
  'lib/stella/operation-ticket/categories.ts',
  'app/actions/stella/validator.ts',
  'app/actions/stella/reviewer.ts',
  'app/actions/stella/advisor.ts',
  'app/actions/stella/composer.ts',
]

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Source with comments stripped.
 *
 * Assertions of the form "this must NOT appear" otherwise punish documentation
 * that names what it deliberately avoids — and this slice's comments name
 * `process.env`, `prepared-package-order` and `audit_logs` precisely to say
 * that it does not read them.
 */
/**
 * Every `return { ok: true, ... }` block an action hands to the governed driver.
 *
 * Anchored on `ok: true` and closed at the first line whose indentation returns
 * to the `return`'s own — so the block ends where the object does, and the
 * `audit_logs` payload further down the same function is NOT swept in.
 */
function executeReturnBlocks(source: string): string[] {
  const lines = source.split('\n')
  const blocks: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*return \{\s*$/.test(lines[i]) || !/^\s*ok: true,\s*$/.test(lines[i + 1] ?? '')) continue
    const indent = (lines[i].match(/^\s*/) ?? [''])[0].length
    const collected: string[] = [lines[i]]
    for (let j = i + 1; j < lines.length; j += 1) {
      collected.push(lines[j])
      if (new RegExp(`^\\s{${indent}}\\}`).test(lines[j])) break
    }
    blocks.push(collected.join('\n'))
  }
  return blocks
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

/** Every path the working tree changes against the lane's BASE. */
function changedPaths(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  const base = '89022a9bf22a06276996a5a9214b344916be84aa'
  const tracked = execFileSync('git', ['diff', '--name-only', base], { encoding: 'utf8', cwd: ROOT })
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8', cwd: ROOT,
  })
  return [...tracked.split('\n'), ...untracked.split('\n')]
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
}

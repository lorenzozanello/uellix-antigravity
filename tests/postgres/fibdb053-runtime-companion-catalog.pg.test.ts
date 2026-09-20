// @vitest-environment node
//
// tests/postgres/fibdb053-runtime-companion-catalog.pg.test.ts
// FIBDB-053 RUNTIME COMPANION — the controls no mock can answer.
//
// Authority:
//   docs/ops/wave3/FIBDB053_RUNTIME_COMPANION_EXECUTION_AUTHORITY_v1.0.0.json
//   docs/ops/wave3/FIBDB053_RUNTIME_COMPANION_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1.json
//   docs/ops/wave3/FIBDB053_RUNTIME_COMPANION_TEST_MANIFEST_v1.0.0.json
//   docs/ops/wave3/FIBDB053_RUNTIME_COMPANION_TEST_MANIFEST_AMENDMENT_v1.0.1.json
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS AT ALL
// ---------------------------------------------------------------------------
// Every question here is a question about what a REAL PostgreSQL catalog
// returns, or about what a REAL driver puts on the wire. A mock that answers
// either one is answering itself.
//
// Two of them were already worth the container before a line of the bridge was
// written, and both were MEASURED here rather than inherited:
//
//   * the parent authority asserted that the three textual spellings of the
//     nine-argument signature "are not interchangeable" and that a probe in the
//     wrong one is "silently and permanently FALSE". Measured: all three
//     resolve to ONE pg_proc OID. The amendment withdrew the claim; N-RC-10-C
//     pins the measurement so a future lane cannot reinstate the withdrawn
//     mutation as though it were load-bearing.
//
//   * drizzle's `sql` template EXPANDS an interpolated JS array into a
//     parameter LIST, so `${flags}::text[]` reaches the server as
//     `($9, $10, $11)::text[]` and fails with "cannot cast type record to
//     text[]". Neither a source-text assertion nor a mocked `db.execute` can
//     see that. §5 drives the real bridge through the real driver.
//
// ---------------------------------------------------------------------------
// SAFETY PROPERTY — structural, and the same one tests/postgres/disposable-db.ts
// holds
// ---------------------------------------------------------------------------
// This file reaches PostgreSQL only through `docker exec` into a LOCAL
// supabase_db container on this machine, plus a loopback driver connection to
// that same container's published port. It creates databases with a fixed
// prefix and drops only databases with that prefix. Stage-A SQL is NEVER
// applied: the fixtures below are catalog SHAPES written by this file, not the
// stella_0017b package, which does not exist at this base and whose
// application anywhere is outside this lane entirely.
//
// GATING: opt-in via UELLIX_PG_TESTS=1, and skipped when no single supabase_db
// container can be resolved. With two containers running, name one in
// UELLIX_REHEARSAL_CONTAINER.

import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

import { PG_TESTS_ENABLED, resolveContainer } from '@/tests/postgres/disposable-db'

/* -------------------------------------------------------------------------- */
/* FROZEN COMPARANDS — typed out, never re-derived from the implementation    */
/* -------------------------------------------------------------------------- */

/**
 * SECTION_A3.CANONICAL_PROBE_LITERAL.value of the authority amendment, byte for
 * byte.
 *
 * ANTI-VACUITY. This string is transcribed from the frozen authority, not
 * imported from `db/stella/operation-tickets.ts` and not built from the mutant
 * by reversing the substitution. A control that re-expresses its subject's own
 * transformation proves only that the copy behaves like the copy.
 */
const CANONICAL_PROBE_LITERAL =
  'uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,integer,jsonb,character varying,text[])'

/**
 * MUT-RC-12 as the amendment re-scoped it: the SIXTH argument type changed from
 * `integer` to `bigint`, and nothing else.
 *
 * Also a frozen string. Deriving it here with `.replace('integer', 'bigint')`
 * would make this battery re-express the very predicate N-RC-10-B exists to
 * test independently.
 */
const MUT_RC_12_MUTANT_LITERAL =
  'uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,bigint,jsonb,character varying,text[])'

/** The pg_catalog spelling — the grapheme the withdrawn mutation used. */
const PG_CATALOG_GRAPHEME =
  'uellix_stella_ops.complete_operation_ticket(bpchar,uuid,bpchar,varchar,varchar,int4,jsonb,varchar,_text)'

/** The SQL declaration spelling, with type modifiers. */
const SQL_DECLARATION_GRAPHEME =
  'uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64), varchar(100), varchar(100), integer, jsonb, varchar(50), text[])'

/** The predecessor Stage-A DROPs. Measured at db/prepared/checkpoint-a1/corroboration.sql. */
const SEVEN_ARGUMENT_LITERAL =
  'uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,integer,jsonb)'

/* -------------------------------------------------------------------------- */
/* Catalog fixtures — SHAPES, not the Stage-A package                         */
/* -------------------------------------------------------------------------- */

/**
 * The seven-argument completion verb as stella_0017 declares it, reduced to its
 * SIGNATURE and an outcome row.
 *
 * Deliberately NOT a copy of stella_0017's body. What is under test is which
 * arity the bridge selects and what the catalog says about it; reproducing the
 * advisory lock, the ledger INSERT and the quota conversion would add a great
 * deal of surface that no assertion here reads, and would put a second,
 * unreviewed copy of a SECURITY DEFINER body in the repository.
 */
const OLD_DB_FIXTURE = `
CREATE SCHEMA IF NOT EXISTS uellix_stella_ops;
DROP TABLE IF EXISTS public.fibdb053_received;
CREATE TABLE public.fibdb053_received (
  arity integer NOT NULL,
  pipeline_step varchar(100),
  model_used varchar(100),
  tokens_used integer,
  response_json jsonb,
  risk_level varchar(50),
  risk_flags text[]
);
-- Both DROPs, so the fixture is IDEMPOTENT and a battery can reinstall a state
-- without first knowing which one it is in. A fixture that can only be applied
-- to a virgin catalog makes test ORDER load-bearing, which is how a green run
-- starts depending on something no assertion states.
DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,integer,jsonb,character varying,text[]);
DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,integer,jsonb);
CREATE FUNCTION uellix_stella_ops.complete_operation_ticket(
  p_ticket_id char(64), p_expected_project_id uuid, p_query_hash char(64),
  p_pipeline_step varchar(100), p_model_used varchar(100), p_tokens_used integer,
  p_response_json jsonb
) RETURNS TABLE(outcome text, used integer, quota integer) LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO public.fibdb053_received
    VALUES (7, p_pipeline_step, p_model_used, p_tokens_used, p_response_json, NULL, NULL);
  RETURN QUERY SELECT 'completed'::text, 1, 10;
END $fn$;
`

/**
 * Stage-A's TARGET shape: the seven-argument form DROPPED and a nine-argument
 * one CREATEd, adding `p_risk_level varchar(50)` and `p_risk_flags text[]`.
 *
 * DROP-then-CREATE and no DEFAULT, because that is the succession Stage-A
 * freezes — an overload would make `to_regprocedure` answer TRUE for BOTH
 * literals and quietly hollow out every assertion below.
 */
const NEW_DB_FIXTURE = `
DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,integer,jsonb);
DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,integer,jsonb,character varying,text[]);
CREATE FUNCTION uellix_stella_ops.complete_operation_ticket(
  p_ticket_id char(64), p_expected_project_id uuid, p_query_hash char(64),
  p_pipeline_step varchar(100), p_model_used varchar(100), p_tokens_used integer,
  p_response_json jsonb, p_risk_level varchar(50), p_risk_flags text[]
) RETURNS TABLE(outcome text, used integer, quota integer) LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO public.fibdb053_received
    VALUES (9, p_pipeline_step, p_model_used, p_tokens_used, p_response_json, p_risk_level, p_risk_flags);
  RETURN QUERY SELECT 'completed'::text, 1, 10;
END $fn$;
`

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const DB_NAME = 'uellix_rehearsal_pgtest_fibdb053_companion'
const DROP_GUARD = 'uellix_rehearsal_pgtest_'

const container = PG_TESTS_ENABLED ? resolveContainer() : null
const RUN = container !== null

function docker(args: readonly string[], stdin?: string): string {
  return execFileSync('docker', args, {
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** Run SQL that must succeed, in ONE transaction. */
function exec(sqlText: string): void {
  docker(
    ['exec', '-i', container as string, 'psql', '-U', 'postgres', '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-q', '-1', '-f', '-'],
    sqlText,
  )
}

/** Rows as arrays of columns. Empty string is distinguishable from NULL only by the caller's query. */
function query(sqlText: string): string[][] {
  const out = docker([
    'exec', '-i', container as string, 'psql', '-U', 'postgres', '-d', DB_NAME,
    '-v', 'ON_ERROR_STOP=1', '-tAq', '-F', '|', '-c', sqlText,
  ])
  return out.split('\n').map((s) => s.trimEnd()).filter((s) => s.length > 0).map((l) => l.split('|'))
}

function scalar(sqlText: string): string | null {
  const v = query(sqlText)[0]?.[0]
  return v === undefined || v === '' ? null : v
}

/**
 * Run a SCRIPT with ON_ERROR_STOP OFF and verbose errors, and return stderr.
 *
 * The only way to observe what happens to the SECOND statement after the first
 * one has poisoned the transaction. `\set VERBOSITY verbose` is what puts the
 * SQLSTATE in the message — N-RC-03 is explicit that observing "the fallback
 * did not succeed" is vacuous, because the fallback cannot succeed for reasons
 * unrelated to the guarantee under test. The SQLSTATE is the guarantee.
 */
function runScriptCapturingErrors(script: string): string {
  const args = [
    'exec', '-i', container as string, 'psql', '-U', 'postgres', '-d', DB_NAME,
    '-v', 'ON_ERROR_STOP=0', '-tAq', '-f', '-',
  ]
  try {
    const out = execFileSync('docker', args, {
      input: `\\set VERBOSITY verbose\n${script}`,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return out
  } catch (error) {
    const e = error as { stderr?: string | Buffer; stdout?: string | Buffer }
    return `${e.stdout ? String(e.stdout) : ''}\n${e.stderr ? String(e.stderr) : ''}`
  }
}

function installOldDb(): void {
  exec(OLD_DB_FIXTURE)
}

function installNewDb(): void {
  exec(NEW_DB_FIXTURE)
}

function resolveOid(literal: string): string | null {
  // `to_regprocedure` is TOTAL: an absent or wrong signature yields NULL rather
  // than raising, which is exactly why a wrong literal is indistinguishable
  // from an absent function at the query layer — and why N-RC-10 needs three
  // arms rather than one.
  return scalar(`SELECT pg_catalog.to_regprocedure('${literal.replace(/'/g, "''")}')::oid`)
}

/** Loopback connection string for the container's published 5432. */
function driverUrl(): string {
  const mapping = docker(['port', container as string, '5432/tcp'])
  const port = mapping.split('\n').map((s) => s.trim()).filter(Boolean)[0]?.split(':').pop()
  if (port === undefined || !/^\d+$/.test(port)) {
    throw new Error(`could not resolve a published port for ${container}: ${mapping}`)
  }
  return `postgres://postgres:postgres@127.0.0.1:${port}/${DB_NAME}`
}

const describeIf = RUN ? describe : describe.skip

describeIf('FIBDB-053 runtime companion — real PostgreSQL catalog', () => {
  beforeAll(() => {
    docker(['exec', container as string, 'psql', '-U', 'postgres', '-q', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`])
    docker(['exec', container as string, 'psql', '-U', 'postgres', '-q', '-c', `CREATE DATABASE ${DB_NAME}`])
  }, 120_000)

  afterAll(() => {
    if (!DB_NAME.startsWith(DROP_GUARD)) throw new Error(`refusing to drop ${DB_NAME}`)
    docker(['exec', container as string, 'psql', '-U', 'postgres', '-q', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`])
  }, 120_000)

  /* ====================================================================== */
  /* §0  SETUP IS ASSERTED, NEVER INFERRED FROM PROBE COLOUR                */
  /* ====================================================================== */

  describe('§0 setup', () => {
    it('SETUP=SUCCESS — the OLD_DB fixture installs and the catalog says so', () => {
      installOldDb()
      // Asserted POSITIVELY. A setup that silently failed would leave the
      // catalog empty, every probe would answer NULL, and a battery that reads
      // only "the canonical literal is absent" would go green on nothing.
      expect(resolveOid(SEVEN_ARGUMENT_LITERAL)).toMatch(/^\d+$/)
      expect(
        scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'uellix_stella_ops' AND p.proname = 'complete_operation_ticket'`),
      ).toBe('1')
    }, 120_000)

    it('SETUP=SUCCESS — the NEW_DB fixture DROPs the predecessor and leaves exactly one overload', () => {
      installOldDb()
      installNewDb()
      expect(resolveOid(CANONICAL_PROBE_LITERAL)).toMatch(/^\d+$/)
      // The count is the load-bearing half. Stage-A's succession is DROP-then-
      // CREATE with no DEFAULT; if the fixture left an OVERLOAD standing, both
      // literals would resolve and every negative arm below would be vacuous.
      expect(
        scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'uellix_stella_ops' AND p.proname = 'complete_operation_ticket'`),
      ).toBe('1')
      expect(
        scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'uellix_stella_ops' AND p.proname = 'complete_operation_ticket'
                  AND p.pronargdefaults > 0`),
      ).toBe('0')
    }, 120_000)
  })

  /* ====================================================================== */
  /* §1  N-RC-10 — probe signature identity, three arms, ONE catalog state  */
  /* ====================================================================== */

  describe('§1 N-RC-10 — probe signature identity (NEW_DB)', () => {
    beforeAll(() => {
      installOldDb()
      installNewDb()
    }, 120_000)

    it('N-RC-10-A — the canonical literal RESOLVES', () => {
      // Without this arm, arm B could pass on a catalog where nothing resolves
      // at all — which is the shape a silently failed setup produces.
      expect(resolveOid(CANONICAL_PROBE_LITERAL)).toMatch(/^\d+$/)
    }, 120_000)

    it('N-RC-10-B — the frozen MUT-RC-12 mutant does NOT resolve', () => {
      // THE LOAD-BEARING ARM. A and B are asserted in the SAME catalog state
      // and the two literals differ in exactly one token, so a divergence in
      // the verdict can only be attributed to that token.
      expect(resolveOid(MUT_RC_12_MUTANT_LITERAL)).toBeNull()

      // And the mutant is not merely wrong, it is SILENTLY wrong: the query
      // succeeds. That is why a control leaning on an error to catch it would
      // be vacuous — `to_regprocedure` is total over arbitrary input.
      expect(scalar(`SELECT 'query-completed'`)).toBe('query-completed')

      // One token apart, asserted against the frozen strings themselves rather
      // than by re-running the substitution the implementation uses.
      expect(MUT_RC_12_MUTANT_LITERAL).not.toBe(CANONICAL_PROBE_LITERAL)
      expect(MUT_RC_12_MUTANT_LITERAL.replace('bigint', 'integer')).toBe(CANONICAL_PROBE_LITERAL)
    }, 120_000)

    it('N-RC-10-C — VACUITY GUARD: the pg_catalog grapheme resolves to the SAME OID', () => {
      // The measurement that withdrew the parent authority's grapheme hazard.
      // It pins the fact so a future lane cannot reintroduce the spelling
      // mutation as though it were load-bearing. It goes RED only if a future
      // PostgreSQL stops normalising type aliases — which would be a finding,
      // not a test failure.
      const canonical = resolveOid(CANONICAL_PROBE_LITERAL)
      expect(canonical).toMatch(/^\d+$/)
      expect(resolveOid(PG_CATALOG_GRAPHEME)).toBe(canonical)
      // The third recorded spelling, for the same reason: type MODIFIERS are
      // discarded before the lookup, so varchar(100) and varchar are one type.
      expect(resolveOid(SQL_DECLARATION_GRAPHEME)).toBe(canonical)
    }, 120_000)
  })

  /* ====================================================================== */
  /* §2  T10 — canonical probe literal identity and resolution              */
  /* ====================================================================== */

  describe('§2 T10 — canonical probe literal', () => {
    it('T10(a) IDENTITY — the production literal is byte-identical to the frozen one', async () => {
      const { NINE_ARGUMENT_COMPLETION_SIGNATURE } = await import('@/db/stella/operation-tickets')
      // Asserted against the FROZEN string transcribed at the top of this file,
      // never by re-deriving the literal from the implementation. This is what
      // makes the FIXED LITERAL rule auditable rather than merely stated.
      expect(NINE_ARGUMENT_COMPLETION_SIGNATURE).toBe(CANONICAL_PROBE_LITERAL)
    })

    it('T10(b) RESOLUTION — the same literal resolves in NEW_DB and is NULL in OLD_DB', () => {
      installOldDb()
      installNewDb()
      const installed = scalar(
        `SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'uellix_stella_ops' AND p.proname = 'complete_operation_ticket'`,
      )
      // Not merely "not null" — the OID of the function that is actually
      // installed. A literal resolving to some OTHER function would satisfy a
      // bare IS NOT NULL assertion.
      expect(resolveOid(CANONICAL_PROBE_LITERAL)).toBe(installed)

      installOldDb()
      expect(resolveOid(CANONICAL_PROBE_LITERAL)).toBeNull()
    }, 120_000)
  })

  /* ====================================================================== */
  /* §3  T2 / T6 — the two mismatches, both directions                      */
  /* ====================================================================== */

  describe('§3 T2 and T6 — signature mismatch in both directions', () => {
    it('T2 — a NINE-argument call against an OLD_DB catalog raises 42883', () => {
      installOldDb()
      const stderr = runScriptCapturingErrors(
        `SELECT * FROM uellix_stella_ops.complete_operation_ticket(${nineArgumentCallArguments()});`,
      )
      expect(stderr).toContain('42883')
      expect(stderr).toContain('does not exist')
    }, 120_000)

    it('T6 / D-3 — a SEVEN-argument call against a NEW_DB catalog raises 42883', () => {
      // The prohibited deployment cell: an OLD RUNTIME, which can only issue
      // seven arguments, against a database Stage-A has already changed. Proved
      // DETECTABLE here rather than only documented — the runtime half, that
      // the refusal is attributed to a signature mismatch and not to
      // unavailability, is asserted in the orchestration battery.
      installOldDb()
      installNewDb()
      const stderr = runScriptCapturingErrors(
        `SELECT * FROM uellix_stella_ops.complete_operation_ticket(${sevenArgumentCallArguments()});`,
      )
      expect(stderr).toContain('42883')
    }, 120_000)
  })

  /* ====================================================================== */
  /* §4  N-RC-03 / MUT-RC-04 — the prohibited fallback, exhibiting 25P02    */
  /* ====================================================================== */

  describe('§4 N-RC-03 — the same-transaction fallback is 25P02, not 42883', () => {
    it('the nine-then-seven fallback inside ONE transaction exhibits 25P02', () => {
      installOldDb()
      const stderr = runScriptCapturingErrors(
        [
          'BEGIN;',
          `SELECT * FROM uellix_stella_ops.complete_operation_ticket(${nineArgumentCallArguments()});`,
          `SELECT * FROM uellix_stella_ops.complete_operation_ticket(${sevenArgumentCallArguments()});`,
          'ROLLBACK;',
        ].join('\n'),
      )
      // The FIRST statement is the honest 42883.
      expect(stderr).toContain('42883')
      // The SECOND is 25P02 — NOT another 42883, and not a success. This is
      // prohibited shape P-1 measured rather than argued: the fallback is not
      // inelegant, it is non-functional, and its failure mode MASKS the real
      // cause. A control asserting only "the fallback did not succeed" would be
      // satisfied by any failure at all.
      expect(stderr).toContain('25P02')
      expect(stderr).toContain('current transaction is aborted')
    }, 120_000)

    it('and the seven-argument call ALONE succeeds — so 25P02 is the transaction, not the arity', () => {
      // The non-vacuity partner. Without it, "the second statement failed"
      // would be explained equally well by the seven-argument form being wrong
      // on this catalog, which is the OPPOSITE of what §4 claims.
      installOldDb()
      const stderr = runScriptCapturingErrors(
        `SELECT * FROM uellix_stella_ops.complete_operation_ticket(${sevenArgumentCallArguments()});`,
      )
      expect(stderr).not.toContain('ERROR')
      expect(scalar('SELECT count(*) FROM public.fibdb053_received WHERE arity = 7')).toBe('1')
    }, 120_000)
  })

  /* ====================================================================== */
  /* §5  THE REAL DRIVER — what no source assertion and no mock can see      */
  /* ====================================================================== */

  describe('§5 the bridge against a real catalog, through the real driver', () => {
    /**
     * ONE connection for the whole section, not one per test.
     *
     * Measured on this host: a pool per test is what turns a battery into a
     * memory problem, and a `docker exec` that cannot allocate is
     * indistinguishable in the output from a fixture that failed. What each
     * test genuinely needs is a FRESH MODULE — so that the bridge's per-process
     * probe cache and probe counter start clean — and that is what
     * `vi.resetModules()` gives, independently of the connection.
     */
    let client: postgres.Sql
    let database: ReturnType<typeof drizzle>

    beforeAll(() => {
      client = postgres(driverUrl(), { max: 1 })
      database = drizzle(client)
    }, 120_000)

    afterAll(async () => {
      await client?.end()
    })

    /**
     * Load the REAL bridge with `@/db/client` and the auth context substituted.
     *
     * WHAT IS SUBSTITUTED, and only this: WHERE the connection comes from, and
     * WHERE the identity comes from. The module under test —
     * `db/stella/operation-tickets.ts` — is the real one, the SQL it builds is
     * the real SQL, the driver is the real driver and the catalog is a real
     * catalog. Same substitution boundary tests/e2e/stella-ticket-journey
     * draws, for the same reason.
     */
    async function loadBridge() {
      vi.resetModules()
      vi.doMock('@/db/client', () => ({ db: database }))
      vi.doMock('@/lib/auth/database-context', () => ({
        withOrganizationDatabaseContext: <T,>(cb: (ctx: unknown) => Promise<T>) => cb({}),
      }))
      return import('@/db/stella/operation-tickets')
    }

    const TICKET = 'a'.repeat(64)
    const HASH = 'b'.repeat(64)
    const PROJECT = '22222222-2222-4222-8222-2222222222a1'

    it('NEW_DB — nine arguments are issued and BOTH risk values land, as text[] and not as a record', async () => {
      installOldDb()
      installNewDb()
      const bridge = await loadBridge()

      const result = await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, {
        pipelineStep: 'Calculation',
        modelUsed: 'gemini-test',
        tokensUsed: 7,
        responseJson: { ok: true },
        riskLevel: 'high',
        // Deliberately awkward values. A comma, a double quote and a brace are
        // exactly what a naive array-literal encoding gets wrong, and an empty
        // string is what a `filter(Boolean)` silently drops.
        riskFlags: ['finding', 'proxy_risk', 'a,b "q"', '{}', ''],
      })

      expect(result).toEqual({ kind: 'completed', used: 1, quota: 10 })
      // THE ARITY the database actually saw — read off the row the fixture
      // filed, not inferred from the wrapper's return value.
      expect(scalar('SELECT arity FROM public.fibdb053_received')).toBe('9')
      // PER-FIELD, never as one object: dropping riskFlags while keeping
      // riskLevel is MUT-RC-05 and a single identity assertion cannot see it.
      expect(scalar('SELECT risk_level FROM public.fibdb053_received')).toBe('high')
      expect(scalar('SELECT array_length(risk_flags, 1) FROM public.fibdb053_received')).toBe('5')
      expect(scalar('SELECT risk_flags[3] FROM public.fibdb053_received')).toBe('a,b "q"')
      expect(scalar('SELECT risk_flags[4] FROM public.fibdb053_received')).toBe('{}')
    }, 120_000)

    it('NEW_DB — explicit nulls travel as nulls, not as an empty array and not as the string "null"', async () => {
      installOldDb()
      installNewDb()
      const bridge = await loadBridge()

      await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, {
        pipelineStep: 'Report',
        modelUsed: 'gemini-test',
        tokensUsed: 1,
        responseJson: { ok: true },
        riskLevel: null,
        riskFlags: null,
      })

      expect(scalar('SELECT risk_level IS NULL FROM public.fibdb053_received')).toBe('t')
      expect(scalar('SELECT risk_flags IS NULL FROM public.fibdb053_received')).toBe('t')
    }, 120_000)

    it('OLD_DB — seven arguments are issued, and the risk values are accepted and NOT transmitted', async () => {
      installOldDb()
      const bridge = await loadBridge()

      const result = await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, {
        pipelineStep: 'Calculation',
        modelUsed: 'gemini-test',
        tokensUsed: 7,
        responseJson: { ok: true },
        // ACCEPTED by the payload type. There is no parameter to carry them.
        riskLevel: 'high',
        riskFlags: ['finding'],
      })

      expect(result).toEqual({ kind: 'completed', used: 1, quota: 10 })
      expect(scalar('SELECT arity FROM public.fibdb053_received')).toBe('7')
      // Not a regression the bridge introduces — the measured status quo, and
      // the reason OLD_DB cannot be a production state for validator/reviewer.
      expect(scalar('SELECT risk_level IS NULL FROM public.fibdb053_received')).toBe('t')
      // The payload the OLD path DOES carry is unchanged, so the seven-argument
      // branch is proven to still be the stella_0017 call and not a stub.
      expect(scalar('SELECT pipeline_step FROM public.fibdb053_received')).toBe('Calculation')
      expect(scalar('SELECT tokens_used FROM public.fibdb053_received')).toBe('7')
    }, 120_000)

    it('T7 — the catalog, not a cached constant, drives the return: the probe inverts after rollback', async () => {
      installOldDb()
      installNewDb()
      const bridge = await loadBridge()

      const payload = {
        pipelineStep: 'Calculation',
        modelUsed: 'gemini-test',
        tokensUsed: 1,
        responseJson: { ok: true },
        riskLevel: 'medium' as const,
        riskFlags: ['finding'],
      }

      await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, payload)
      expect(scalar('SELECT arity FROM public.fibdb053_received')).toBe('9')

      // ROLL THE SQL BACK — the nine-argument form dropped, the seven-argument
      // one restored. Exactly R-1's return path.
      exec('DELETE FROM public.fibdb053_received')
      exec(`DROP FUNCTION uellix_stella_ops.complete_operation_ticket(${CANONICAL_PROBE_LITERAL.slice(CANONICAL_PROBE_LITERAL.indexOf('(') + 1, -1)});`)
      installOldDb()

      // WITHOUT INVALIDATION the process still holds NEW_DB, and the completion
      // is the one the bridge is designed to recover from rather than survive.
      // The recovery is bounded-once and lands on seven arguments.
      const afterRollback = await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, payload)
      expect(afterRollback).toEqual({ kind: 'completed', used: 1, quota: 10 })
      expect(scalar('SELECT arity FROM public.fibdb053_received')).toBe('7')
      // NO REDEPLOY AND NO CONFIGURATION CHANGE happened between the two calls.
      // The only thing that changed is the catalog.
    }, 120_000)

    it('the 42883 recovery reaches a NEW transaction — the retry is not 25P02', async () => {
      // The positive counterpart of §4. §4 proves that a fallback inside the
      // FAILED transaction returns 25P02; this proves the bridge's permitted
      // retry does not, because it opens a transaction of its own. If it did
      // not, the assertion below would fail with a rejection rather than a
      // completion, and the 25P02 would be visible rather than concealed.
      installOldDb()
      installNewDb()
      const bridge = await loadBridge()

      await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, {
        pipelineStep: 'Calculation', modelUsed: 'm', tokensUsed: 1,
        responseJson: {}, riskLevel: null, riskFlags: null,
      })
      expect(scalar('SELECT arity FROM public.fibdb053_received')).toBe('9')

      exec('DELETE FROM public.fibdb053_received')
      exec(`DROP FUNCTION uellix_stella_ops.complete_operation_ticket(${CANONICAL_PROBE_LITERAL.slice(CANONICAL_PROBE_LITERAL.indexOf('(') + 1, -1)});`)
      installOldDb()

      const before = bridge.completionSignatureProbeCount()
      const recovered = await bridge.completeStellaInteractionTicket(TICKET, PROJECT, HASH, {
        pipelineStep: 'Calculation', modelUsed: 'm', tokensUsed: 1,
        responseJson: {}, riskLevel: null, riskFlags: null,
      })
      // EXACTLY ONE re-probe, measured on the real probe path against a real
      // catalog rather than on a spy.
      expect(bridge.completionSignatureProbeCount() - before).toBe(1)
      expect(recovered).toEqual({ kind: 'completed', used: 1, quota: 10 })
      expect(scalar('SELECT arity FROM public.fibdb053_received')).toBe('7')
    }, 120_000)
  })
})

/* -------------------------------------------------------------------------- */
/* Call-argument helpers — the two arities, spelled once                      */
/* -------------------------------------------------------------------------- */

function sevenArgumentCallArguments(): string {
  return [
    `'${'a'.repeat(64)}'::char(64)`,
    `'00000000-0000-4000-8000-000000000000'::uuid`,
    `'${'b'.repeat(64)}'::char(64)`,
    `'Calculation'::varchar(100)`,
    `'gemini-test'::varchar(100)`,
    `7::integer`,
    `'{}'::jsonb`,
  ].join(', ')
}

function nineArgumentCallArguments(): string {
  return [sevenArgumentCallArguments(), `'high'::varchar(50)`, `ARRAY['finding']::text[]`].join(', ')
}

// tests/grounding-persistence-error-classification.test.ts
//
// THE ADAPTER'S SQLSTATE MAPPING, DRIVEN THROUGH THE WRAPPER THAT ACTUALLY
// REACHES IT.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS AND WHY IT DID NOT BEFORE
// ---------------------------------------------------------------------------
// `lib/grounding/ingest/persistence.ts` documents a mapping table — five
// governed SQLSTATEs to five failure kinds — and `grounding-ingestion-
// repository.ts` implements it. Both halves were reviewed, both halves agreed,
// and the mapping still could not fire: drizzle 0.45.x does not throw the
// driver's error, it throws `DrizzleQueryError` with the driver error on
// `.cause`, and the adapter read `error.code` off the wrapper — where it is
// `undefined`. Every governed refusal therefore arrived as the unmapped
// default, `unavailable`, which `isRetryablePersistenceFailure` calls
// RETRYABLE.
//
// The reason nothing caught it is the reason M-8 survived a post-install gate:
// no application path reached these functions, so no wrapped error was ever
// classified in anger. A test that constructed a bare `{ code: 'U0102' }`
// would have passed against the broken adapter — which is why every case below
// throws the REAL `DrizzleQueryError`, imported from drizzle, rather than a
// hand-rolled object whose shape this repository chose.
//
// The sibling adapter `db/stella/operation-tickets.ts` already walks the cause
// chain; it learned from an E2E that presented a bound ticket and got the wrong
// product code back. This file is that lesson made cheap for the adapter that
// had no E2E to teach it.
//
// Fully offline. No database, no network: `db/client.ts` builds its client
// lazily and every case here supplies its own executor.

import { describe, expect, it } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm/errors'

import { createPersistedGroundingIngestionRepository } from '@/db/grounding/grounding-ingestion-repository'
import {
  GroundingPersistenceError,
  isRetryablePersistenceFailure,
  type GroundingPersistenceFailureKind,
} from '@/lib/grounding/ingest'
import type { GroundingScope } from '@/lib/grounding/contracts'

const SCOPE: GroundingScope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
}
const EVIDENCE_ID = '33333333-3333-4333-8333-333333333333'

/**
 * A driver error as `postgres` raises one: an Error carrying `code`.
 *
 * `severity`/`routine` are included because a real one has them and because
 * their ABSENCE from what crosses the boundary is asserted below — a sanitized
 * failure must not smuggle driver metadata out with it.
 */
function driverError(sqlstate: string, message = 'permission denied for table evidence_items'): Error {
  return Object.assign(new Error(message), {
    code: sqlstate,
    severity: 'ERROR',
    routine: 'aclcheck_error',
    table: 'evidence_items',
  })
}

/** The wrapper drizzle 0.45.x actually throws. Its own `code` is undefined. */
function wrapped(sqlstate: string): DrizzleQueryError {
  return new DrizzleQueryError(
    'SELECT * FROM uellix_grounding.claim_active_document_version($1::uuid)',
    [EVIDENCE_ID],
    driverError(sqlstate),
  )
}

/**
 * An executor whose FIRST call succeeds and whose second throws.
 *
 * The shape matters: `claimActiveDocumentVersion` runs `assertEvidenceInScope`
 * — an ordinary scoped SELECT — before it names the governed function, so an
 * executor that threw immediately would be testing the scope check's catch
 * block and reporting the result as if it were the governed call's.
 */
function executorFailingOnGovernedCall(error: unknown) {
  let calls = 0
  return {
    execute: async () => {
      calls += 1
      if (calls === 1) return [{ id: EVIDENCE_ID }]
      throw error
    },
  }
}

async function classify(error: unknown): Promise<GroundingPersistenceError> {
  const repository = createPersistedGroundingIngestionRepository(
    SCOPE,
    executorFailingOnGovernedCall(error),
  )
  try {
    await repository.claimActiveDocumentVersion(EVIDENCE_ID)
  } catch (thrown) {
    return thrown as GroundingPersistenceError
  }
  throw new Error('the adapter returned instead of failing; there is nothing to classify')
}

/* -------------------------------------------------------------------------- */
/* The five governed codes, wrapped                                            */
/* -------------------------------------------------------------------------- */

const GOVERNED: readonly (readonly [string, GroundingPersistenceFailureKind])[] = [
  ['U0100', 'invalid_request'],
  ['U0101', 'pipeline_version_conflict'],
  ['U0102', 'evidence_not_found'],
  ['U0103', 'incomplete_ingestion'],
  ['U0104', 'chunk_identity_rejected'],
]

describe('a governed SQLSTATE keeps its classification through DrizzleQueryError', () => {
  for (const [sqlstate, kind] of GOVERNED) {
    it(`${sqlstate} -> ${kind}, and is NOT retryable`, async () => {
      const failure = await classify(wrapped(sqlstate))

      expect(failure).toBeInstanceOf(GroundingPersistenceError)
      expect(failure.kind).toBe(kind)
      expect(failure.operation).toBe('claim_active_document_version')

      // The half that made the defect expensive rather than merely wrong. A
      // request problem misread as `unavailable` is a request problem the
      // caller is told to RETRY, which turns one refusal into a loop of them.
      expect(isRetryablePersistenceFailure(failure)).toBe(false)
    })
  }

  it('classifies an UNWRAPPED driver error identically — the fix adds a case, it does not move one', async () => {
    const failure = await classify(driverError('U0101'))
    expect(failure.kind).toBe('pipeline_version_conflict')
  })

  it('reads a code nested TWO wrappers deep', async () => {
    // Not a shape drizzle produces today. It is the shape a retry helper or an
    // instrumentation layer produces the moment one is added, and a bound of
    // one link would fail silently there — as the original bound of zero did.
    const outer = new Error('ingestion failed', { cause: wrapped('U0103') })
    const failure = await classify(outer)
    expect(failure.kind).toBe('incomplete_ingestion')
  })
})

/* -------------------------------------------------------------------------- */
/* What must NOT change                                                        */
/* -------------------------------------------------------------------------- */

describe('the classification is not widened by the cause walk', () => {
  it('42501 stays `unavailable` — the mapping table has five entries, not six', async () => {
    // M-8 surfaced 42501 (`permission denied for table evidence_items`), and it
    // is deliberately NOT added to the table. It is not a statement about the
    // request: it says the deployed package and the privilege it needs disagree,
    // which is an operational condition, and treating an operational condition
    // as retryable is the documented default. Repairing M-8 must not smuggle a
    // sixth mapping in beside it.
    const failure = await classify(wrapped('42501'))
    expect(failure.kind).toBe('unavailable')
    expect(isRetryablePersistenceFailure(failure)).toBe(true)
  })

  it('an error with no SQLSTATE anywhere in its chain is `unavailable`', async () => {
    const failure = await classify(new Error('connection terminated unexpectedly'))
    expect(failure.kind).toBe('unavailable')
  })

  it('terminates on a CYCLIC cause chain instead of hanging', async () => {
    // A bound, not a recursion. This is the one property a depth-limited walk
    // has that a recursive one does not, and it is unobservable except here:
    // a cycle inside a SECURITY DEFINER call would hang the request, not fail it.
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    Object.defineProperty(a, 'cause', { value: b, configurable: true })

    const failure = await classify(b)
    expect(failure.kind).toBe('unavailable')
  })

  it('leaks no driver text, no SQLSTATE and no table name across the boundary', async () => {
    const failure = await classify(wrapped('U0102'))

    const crossed = `${failure.message} ${failure.name} ${JSON.stringify(failure.kind)} ${failure.operation}`
    expect(crossed).not.toMatch(/U0102/)
    expect(crossed).not.toMatch(/permission denied/)
    expect(crossed).not.toMatch(/evidence_items/)
    expect(crossed).not.toMatch(/aclcheck_error/)
    // And the statement the wrapper quotes — which carries the evidence id.
    expect(crossed).not.toMatch(new RegExp(EVIDENCE_ID))
  })
})

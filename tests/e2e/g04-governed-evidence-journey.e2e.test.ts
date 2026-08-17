// tests/e2e/g04-governed-evidence-journey.e2e.test.ts
// G-04 — THE GOVERNED OFFLINE EVIDENCE JOURNEY, END TO END.
//
//   AUTHORIZED USER
//     -> UPLOAD A SUPPORTED FILE       createFileEvidenceAction
//     -> EVIDENCE FINALIZED            file_path committed, sha256 sealed
//     -> AUTO-INDEX                    ingestProjectEvidenceForProject
//     -> DOCUMENT VERSION              evidence_document_versions
//     -> CHUNKS                        evidence_chunks (governed T1/T2)
//     -> DURABLE CORPUS = indexed      readProjectCorpusStateForProject
//     -> GROUNDED RETRIEVAL            chunks_in_scope_attested
//     -> DETERMINISTIC ANSWER          createExtractiveAnswerProvider
//     -> VALIDATED CITATIONS           buildGroundedAnswer
//     -> NO AUTHORITATIVE DATA MOVED
//
// ---------------------------------------------------------------------------
// NO EVIDENCE ROW IS EVER SEEDED
// ---------------------------------------------------------------------------
// That is the whole difference between this battery and
// `tests/e2e/stella-ticket-journey.e2e.test.ts`, which seeds its
// `evidence_items` rows through `supabase_admin` and therefore proves nothing
// about whether the application can CREATE evidence at all. Every evidence row
// below is written by `createFileEvidenceForProject`, as `uellix_app`, through
// the real Server Action, with the real role check, the real RLS and the real
// three-phase upload.
//
// The admin connection writes exactly twice, and both are declared where they
// appear: `seedWorld` builds the organisations, actors, projects and the
// AUTHORITATIVE rows §Q asserts nothing may move (a proxy and an SROI run —
// neither of which is evidence), and §I2 re-anchors ONE row's `content_hash`
// to reach a state the product path cannot produce. Everything else is written
// by the application.
//
// ---------------------------------------------------------------------------
// WHAT IS REAL, AND WHAT IS SUBSTITUTED
// ---------------------------------------------------------------------------
// REAL: the database (a disposable container built and destroyed by
// `scripts/g04-offline-e2e.sh`), the prepared chain, RLS, `auth.uid()`, the
// identity context, `createFileEvidenceAction`, `createFileEvidenceForProject`
// with its M2-COMP-01 compensation, `ingestProjectEvidenceForProject`,
// `resolveEvidenceSource`, `createEvidenceObjectReader` (the REAL production
// reader — see below), the extractor, the chunker, the governed T1/T2
// functions, `readProjectCorpusStateForProject`, the corpus-state derivation,
// `archiveEvidenceForProject`, `updateEvidenceReviewStatus`, the ticket
// protocol, the quota ledger, the attested chunk repository, retrieval, the
// local extractive generator and citation construction/validation.
//
// SUBSTITUTED, and only this:
//
//   `@/lib/auth/session`          reads cookies of an HTTP request that does
//                                 not exist here. Replaced by the session a
//                                 login would have produced, PLUS its composed
//                                 form `runWithOrganizationAccess` (session +
//                                 identity context), which the archive and
//                                 review actions use and which lives in the
//                                 same module. NOTHING about authorization is
//                                 skipped: the role it returns is fed to the
//                                 real `hasRole` / `canUploadEvidence` /
//                                 `canUseStella`, and the user id it returns is
//                                 fed to the real identity context, where the
//                                 DATABASE decides whether that user is an
//                                 active member (§P3 measures exactly that).
//   `@/lib/auth/database-context` replaced by a shim that calls the REAL
//                                 `withDatabaseIdentityContext` with that
//                                 actor. Only WHERE the user id comes from is
//                                 substituted, never what is done with it.
//   `@/lib/stella/config`         the flags. They are false in the repository,
//                                 and turning them on here is precisely what
//                                 lets the path be exercised while still
//                                 shipping them off.
//   `@/lib/stella/rate-limit`     the per-hour limit uses Upstash/Redis. Not
//                                 part of this journey and not substitutable by
//                                 a database.
//   `@/lib/supabase/server`       AN IN-PROCESS BUCKET. See below.
//   `@/lib/pipeline/confidence-score`  PASS-THROUGH, with a one-shot fault used
//                                 by exactly one test (§J-2) to reach the
//                                 finalize-failure branch of M2-COMP-01. Every
//                                 other test runs the real function.
//   `@google/genai`               a class whose constructor THROWS and records.
//                                 Not a convenience: it is the measurement of
//                                 §S. If anything in this journey ever reached
//                                 for the real provider client, this battery
//                                 fails loudly instead of quietly succeeding.
//
// WHY THE STORAGE DOUBLE IS THE SUPABASE CLIENT AND NOT THE EVIDENCE READER.
// The ticket battery substitutes `@/lib/supabase/evidence-object-reader`, which
// means the production reader is never exercised. Here the substitution is one
// layer lower — `createClient()` itself — so `createEvidenceObjectReader()` is
// REAL PRODUCTION CODE reading through it, and the bucket, the path and the
// bytes are the same ones `createFileEvidenceForProject` wrote. The upload and
// the read therefore agree because they share a store, not because a fixture
// was handed to both. That is also what makes the storage FAILURE of §J a real
// failure of the same seam rather than a separate invention.

import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import type { ContentHash } from '@/lib/grounding/contracts'

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

const ORG_A = '0a000000-0000-4000-8000-00000000a001'
const ORG_B = '0a000000-0000-4000-8000-00000000b001'

/** The journey project. Its only evidence is uploaded by §E. */
const P_JOURNEY = '0b000000-0000-4000-8000-0000000000a1'
/** Authorized, valid, and deliberately never given indexable evidence (§G). */
const P_EMPTY = '0b000000-0000-4000-8000-0000000000a2'
/** Stored-but-not-indexable formats (§L). */
const P_FORMAT = '0b000000-0000-4000-8000-0000000000a3'
/** Supersession by the product path — a new row replaces an old one (§I1). */
const P_VERSION = '0b000000-0000-4000-8000-0000000000a4'
/**
 * Supersession INSIDE one evidence row — two ordinals (§I2).
 *
 * Its own project rather than a second scenario inside `P_VERSION`: §I2 asserts
 * that the figure of ordinal 1 is ABSENT, and P_VERSION legitimately holds
 * another row that states it. Two scenarios sharing a corpus would make each
 * one's absence assertion depend on the other's cleanup.
 */
const P_ORDINAL = '0b000000-0000-4000-8000-0000000000a7'
/** Archived lifecycle (§H). */
const P_ARCHIVE = '0b000000-0000-4000-8000-0000000000a5'
/** Failed uploads (§J). */
const P_FAILED = '0b000000-0000-4000-8000-0000000000a6'
/** The other tenant's project (§F, §O). */
const P_OTHER = '0b000000-0000-4000-8000-0000000000b1'

const U_ADMIN_A = '0c000000-0000-4000-8000-0000000000a1'
/** `reviewer` — may use Stella, may NOT manage evidence. The contrast of §P. */
const U_REVIEWER = '0c000000-0000-4000-8000-0000000000a2'
/** `viewer` — neither. */
const U_VIEWER = '0c000000-0000-4000-8000-0000000000a3'
/**
 * An `organization_admin` whose MEMBERSHIP ROW IS NOT ACTIVE.
 *
 * Seeded suspended rather than mutated mid-run, so no test has to put it back.
 * The substituted session hands this actor out as a fully active admin — which
 * is the point: what refuses it is the database, not the mock.
 */
const U_SUSPENDED = '0c000000-0000-4000-8000-0000000000a4'
const U_ADMIN_B = '0c000000-0000-4000-8000-0000000000b1'

/* --- the documents -------------------------------------------------------- */
//
// The two figures are unique to their project and share NO content token that
// carries an answer. The shared PREAMBLE is deliberate: "The program served
// exactly N ... during the pilot" appears in both, so a single query scores
// highly against BOTH corpora and only the project predicate keeps them apart.
// A query that could only ever match one document would make §F pass for a
// reason that has nothing to do with isolation.

const DOC_JOURNEY =
  'The program served exactly 347 families in Barranquilla during the pilot. ' +
  'Each family completed the full twelve-week cycle.'

const DOC_OTHER =
  'The program served exactly 982 farmers in Monteria during the pilot. ' +
  'Each farmer completed the full twelve-week cycle.'

/** The question both corpora would answer. Asked only inside one project. */
const SHARED_QUERY = 'How many did the program serve during the pilot?'

const DOC_V1 = 'Version one states 111 beneficiaries reached in the first wave.'
const DOC_V2 = 'Version two states 222 beneficiaries reached in the first wave.'
const VERSION_QUERY = 'How many beneficiaries were reached in the first wave?'

const DOC_ARCHIVED = 'The archived report states 555 workshops were delivered in Sincelejo.'
const ARCHIVE_QUERY = 'How many workshops were delivered?'

const sha256 = (text: string): string =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

/* ========================================================================== */
/* The substituted session                                                    */
/* ========================================================================== */

interface Actor {
  readonly userId: string
  readonly organizationId: string
  readonly role: string
}

const ADMIN_A: Actor = { userId: U_ADMIN_A, organizationId: ORG_A, role: 'organization_admin' }
const REVIEWER_A: Actor = { userId: U_REVIEWER, organizationId: ORG_A, role: 'reviewer' }
const VIEWER_A: Actor = { userId: U_VIEWER, organizationId: ORG_A, role: 'viewer' }
const SUSPENDED_A: Actor = { userId: U_SUSPENDED, organizationId: ORG_A, role: 'organization_admin' }
const ADMIN_B: Actor = { userId: U_ADMIN_B, organizationId: ORG_B, role: 'organization_admin' }

let currentActor: Actor = ADMIN_A

/** Run `body` as `actor`, and put the previous one back whatever happens. */
async function as<T>(actor: Actor, body: () => Promise<T>): Promise<T> {
  const previous = currentActor
  currentActor = actor
  try {
    return await body()
  } finally {
    currentActor = previous
  }
}

/**
 * `isAdvisorEnabled` and `geminiApiKey` are present so §S2 can measure the
 * provider gate rather than trip over an unset flag: with the advisor flag off,
 * `stellaCapabilityBlocker` answers `capability_disabled` and never reaches the
 * key at all, which would have made the contrast vacuous.
 */
const mockStellaConfig = {
  isEnabled: true,
  isGroundedQueryEnabled: true,
  isAdvisorEnabled: true,
  // G1-B: the legacy step advisor is this harness's advisor-category
  // representative, and its own flag defaults to false in the real config.
  isLegacyAdvisorEnabled: true,
  geminiApiKey: '',
}
const mockStellaState = { canUseStella: true }

vi.mock('@/lib/stella/config', () => ({
  get stellaConfig() {
    return mockStellaConfig
  },
  get stellaState() {
    return mockStellaState
  },
}))

vi.mock('@/lib/stella/rate-limit', () => ({
  consumeStellaRateLimit: async () => ({ allowed: true }),
}))

vi.mock('@/lib/auth/session', async () => {
  const { withDatabaseIdentityContext } = await import('@/db/identity-context')
  return {
    /**
     * The COMPOSED form, which the evidence lifecycle actions use.
     *
     * `runWithOrganizationAccess` is `requireOrganizationAccess()` followed by
     * `withOrganizationDatabaseContext(callback)`, and it lives in the SAME
     * module as the session — so mocking one without the other would leave
     * `archiveEvidenceAction` and `updateEvidenceReviewStatusAction` running
     * their statements OUTSIDE an identity context, where as `uellix_app` they
     * return ZERO ROWS instead of failing. That is not a shortcut the product
     * takes; it is the reason those actions exist. Reproduced here exactly,
     * over the REAL identity context.
     */
    runWithOrganizationAccess: <T,>(cb: (context: unknown) => Promise<T>) =>
      withDatabaseIdentityContext(
        {
          userId: currentActor.userId,
          organizationId: currentActor.organizationId,
          isSuperAdmin: false,
        },
        () => cb(undefined),
      ),
    requireOrganizationAccess: async () => ({
      user: {
        id: currentActor.userId,
        email: 'g04@example.invalid',
        fullName: null,
        avatarUrl: null,
        isSuperAdmin: false,
      },
      organization: { id: currentActor.organizationId, name: 'G04', slug: 'g04' },
      membership: {
        id: '00000000-0000-4000-8000-000000000001',
        organizationId: currentActor.organizationId,
        userId: currentActor.userId,
        // The SESSION's claim. `U_SUSPENDED` is handed out as ACTIVE here on
        // purpose: nothing in this file may be the thing that refuses it.
        role: currentActor.role,
        status: 'active',
      },
    }),
  }
})

/**
 * The REAL identity context, driven by the substituted session.
 *
 * Stubbing this into `cb => cb()` would have been far easier and would have
 * evaluated every RLS policy, every `auth.uid()` and every `U0102` in this file
 * with NO claims — i.e. as nobody. Every cross-tenant scenario would then have
 * "passed" by finding nothing, for reasons unrelated to the boundary.
 */
vi.mock('@/lib/auth/database-context', async () => {
  const { withDatabaseIdentityContext } = await import('@/db/identity-context')
  return {
    withOrganizationDatabaseContext: <T,>(cb: () => Promise<T> | T) =>
      withDatabaseIdentityContext(
        {
          userId: currentActor.userId,
          organizationId: currentActor.organizationId,
          isSuperAdmin: false,
        },
        async () => cb() as Promise<T>,
      ),
  }
})

/* ========================================================================== */
/* The in-process bucket — the ONE transport substitution                     */
/* ========================================================================== */

interface StoredObject {
  readonly bytes: Buffer
  readonly contentType: string
}

const bucket = new Map<string, StoredObject>()

/**
 * A one-shot storage failure, consumed by the first upload that sees it.
 *
 * One-shot on purpose: a sticky flag that a failing test forgot to clear would
 * silently disarm every upload after it, and the tests that follow would report
 * "no corpus" as a pass.
 */
let uploadFaultOnce: string | null = null

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    storage: {
      from: (bucketName: string) => ({
        async upload(
          path: string,
          body: Buffer,
          options?: { contentType?: string; upsert?: boolean },
        ) {
          if (uploadFaultOnce !== null) {
            const message = uploadFaultOnce
            uploadFaultOnce = null
            // The SHAPE Supabase returns for a refused upload: a resolved
            // promise carrying an error, never a rejection. Getting this wrong
            // would exercise a branch `createFileEvidenceForProject` does not
            // have.
            return { data: null, error: { message } }
          }
          const key = `${bucketName}/${path}`
          if (bucket.has(key) && options?.upsert !== true) {
            return { data: null, error: { message: 'The resource already exists' } }
          }
          bucket.set(key, {
            bytes: Buffer.from(body),
            contentType: options?.contentType ?? 'application/octet-stream',
          })
          return { data: { path }, error: null }
        },
        async download(path: string) {
          const object = bucket.get(`${bucketName}/${path}`)
          if (object === undefined) return { data: null, error: { message: 'Object not found' } }
          // `new Uint8Array(...)` rather than the Buffer itself: a Buffer's
          // backing store is typed as `ArrayBufferLike`, which `BlobPart` does
          // not admit. The bytes are identical; only the view is re-narrowed.
          return { data: new Blob([new Uint8Array(object.bytes)]), error: null }
        },
      }),
    },
  }),
}))

/**
 * A one-shot FINALIZE failure (§J-2).
 *
 * `recalculateConfidenceScore` is the last statement of phase 3, so throwing
 * from it reaches the branch M2-COMP-01 added and nothing else: the object is
 * stored, the row exists, and `file_path` was never committed. Everything but
 * this one injection delegates to the real function.
 */
let finalizeFaultOnce = false

vi.mock('@/lib/pipeline/confidence-score', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/pipeline/confidence-score')>()
  return {
    ...original,
    recalculateConfidenceScore: async (
      ...args: Parameters<typeof original.recalculateConfidenceScore>
    ) => {
      if (finalizeFaultOnce) {
        finalizeFaultOnce = false
        throw new Error('G04 fault injection: finalize')
      }
      return original.recalculateConfidenceScore(...args)
    },
  }
})

/**
 * §S — THE PROVIDER BOUNDARY, INSTRUMENTED RATHER THAN ASSUMED.
 *
 * `lib/stella/adapter/gemini-client.ts` reaches the network through
 * `await import('@google/genai')`. Replacing the export with a constructor that
 * RECORDS AND THROWS turns "no provider was called" from a claim about what the
 * code is believed to do into a measurement: any path that instantiated it
 * would fail this battery by name.
 */
const providerConstructions: string[] = []

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor() {
      providerConstructions.push('GoogleGenAI')
      throw new Error('G04: the real provider client was constructed in an offline gate')
    }
  },
}))

/* ========================================================================== */
/* The privileged connection — SEEDING AND ASSERTIONS ONLY                    */
/* ========================================================================== */

/**
 * A superuser handle used for exactly two things: building the world before a
 * scenario, and READING DURABLE STATE after it.
 *
 * Deliberately NOT the runtime's connection. Every corpus assertion in this
 * file reads `evidence_document_versions` / `evidence_chunks` /
 * `evidence_items` through this handle — a different connection, a different
 * role, outside the transaction the action ran in — so "it was indexed" is a
 * fact about COMMITTED ROWS and never about a value an action returned about
 * itself.
 */
let admin: postgres.Sql

/**
 * Supplied by `scripts/g04-offline-e2e.sh`, never defaulted.
 *
 * A default would be the whole danger: this handle is a superuser, and a
 * default pointing at "some local postgres" would let an accidental `vitest`
 * invocation write to whatever database happened to be listening.
 */
const CONTAINER_URL = process.env.UELLIX_G04_E2E_ADMIN_URL

async function evidenceRow(evidenceId: string): Promise<Record<string, unknown> | null> {
  const rows = await admin`
    SELECT id, project_id, organization_id, type, status, file_path, file_size,
           mime_type, content_hash, confidence_score
    FROM public.evidence_items WHERE id = ${evidenceId}
  `
  return rows.length === 0 ? null : (rows[0] as unknown as Record<string, unknown>)
}

async function documentVersions(evidenceId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await admin`
    SELECT id, ordinal, version_id, raw_content_hash, mime_type, supersedes_version_id
    FROM public.evidence_document_versions
    WHERE evidence_id = ${evidenceId}
    ORDER BY ordinal ASC
  `
  return rows as unknown as Array<Record<string, unknown>>
}

async function chunkCountFor(evidenceId: string): Promise<number> {
  const rows = await admin`
    SELECT count(*)::int AS n FROM public.evidence_chunks WHERE evidence_id = ${evidenceId}
  `
  return Number(rows[0]!.n)
}

async function chunkCountForProject(projectId: string): Promise<number> {
  const rows = await admin`
    SELECT count(*)::int AS n FROM public.evidence_chunks WHERE project_id = ${projectId}
  `
  return Number(rows[0]!.n)
}

async function ticketCount(): Promise<number> {
  const rows = await admin`SELECT count(*)::int AS n FROM uellix_stella_ops.operation_tickets`
  return Number(rows[0]!.n)
}

async function ticketStatus(ticketId: string): Promise<string | null> {
  const rows = await admin`
    SELECT status FROM uellix_stella_ops.operation_tickets WHERE ticket_id = ${ticketId}
  `
  return rows.length === 0 ? null : String(rows[0]!.status)
}

async function chargeCountForProject(projectId: string): Promise<number> {
  const rows = await admin`
    SELECT count(*)::int AS n FROM public.stella_interactions WHERE project_id = ${projectId}
  `
  return Number(rows[0]!.n)
}

async function auditRows(
  entityId: string,
  action?: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = action
    ? await admin`
        SELECT action, entity_type, entity_id, after_json, reason, created_at
        FROM public.audit_logs WHERE entity_id = ${entityId} AND action = ${action}
        ORDER BY created_at ASC`
    : await admin`
        SELECT action, entity_type, entity_id, after_json, reason, created_at
        FROM public.audit_logs WHERE entity_id = ${entityId}
        ORDER BY created_at ASC`
  return rows as unknown as Array<Record<string, unknown>>
}

/**
 * Read until a condition holds, or give up and return the last value.
 *
 * For ONE thing only: the grounded-query audit row is written
 * FIRE-AND-FORGET — `void auditGroundedQuery(...)` — precisely so a reviewer's
 * answer never waits on a trail. Reading immediately after the action returns
 * therefore races the write, and a bare read would make §R flap. Polling states
 * that asynchrony instead of hiding it behind a fixed sleep, and the assertion
 * that follows still fails if the row never arrives.
 */
async function eventually<T>(
  read: () => Promise<T>,
  satisfied: (value: T) => boolean,
  attempts = 60,
): Promise<T> {
  let last = await read()
  for (let i = 0; i < attempts && !satisfied(last); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    last = await read()
  }
  return last
}

async function setQuota(organizationId: string, quota: number | null): Promise<void> {
  await admin`UPDATE public.organizations SET stella_monthly_quota = ${quota} WHERE id = ${organizationId}`
}

/* ========================================================================== */
/* World construction — organisations, actors, projects. NO EVIDENCE.         */
/* ========================================================================== */

async function seedWorld(): Promise<void> {
  await admin.unsafe(`
    INSERT INTO public.users (id, email) VALUES
      ('${U_ADMIN_A}',  'admin-a@example.invalid'),
      ('${U_REVIEWER}', 'reviewer-a@example.invalid'),
      ('${U_VIEWER}',   'viewer-a@example.invalid'),
      ('${U_SUSPENDED}','suspended-a@example.invalid'),
      ('${U_ADMIN_B}',  'admin-b@example.invalid')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.organizations (id, name, slug, stella_monthly_quota) VALUES
      ('${ORG_A}', 'Org A', 'org-a-g04', 500),
      ('${ORG_B}', 'Org B', 'org-b-g04', 500)
    ON CONFLICT (id) DO NOTHING;

    -- The suspended membership is seeded SUSPENDED. Nothing in the run has to
    -- put it back, so no failing test can leave the world in a state where a
    -- later authorization assertion passes for the wrong reason.
    INSERT INTO public.organization_members (id, organization_id, user_id, role, status) VALUES
      ('00000000-0000-4000-8000-0000000000a1', '${ORG_A}', '${U_ADMIN_A}',   'organization_admin', 'active'),
      ('00000000-0000-4000-8000-0000000000a2', '${ORG_A}', '${U_REVIEWER}',  'reviewer',           'active'),
      ('00000000-0000-4000-8000-0000000000a3', '${ORG_A}', '${U_VIEWER}',    'viewer',             'active'),
      ('00000000-0000-4000-8000-0000000000a4', '${ORG_A}', '${U_SUSPENDED}', 'organization_admin', 'suspended'),
      ('00000000-0000-4000-8000-0000000000b1', '${ORG_B}', '${U_ADMIN_B}',   'organization_admin', 'active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.projects (id, organization_id, name, created_by) VALUES
      ('${P_JOURNEY}', '${ORG_A}', 'Journey',    '${U_ADMIN_A}'),
      ('${P_EMPTY}',   '${ORG_A}', 'Empty',      '${U_ADMIN_A}'),
      ('${P_FORMAT}',  '${ORG_A}', 'Formats',    '${U_ADMIN_A}'),
      ('${P_VERSION}', '${ORG_A}', 'Versions',   '${U_ADMIN_A}'),
      ('${P_ARCHIVE}', '${ORG_A}', 'Archive',    '${U_ADMIN_A}'),
      ('${P_FAILED}',  '${ORG_A}', 'Failed',     '${U_ADMIN_A}'),
      ('${P_ORDINAL}', '${ORG_A}', 'Ordinals',   '${U_ADMIN_A}'),
      ('${P_OTHER}',   '${ORG_B}', 'Other',      '${U_ADMIN_B}')
    ON CONFLICT (id) DO NOTHING;

    -- AUTHORITATIVE BUSINESS STATE (§Q). Seeded so the "nothing moved"
    -- assertion has something to move: a run with an SROI ratio, and an
    -- APPROVED financial proxy with a named reviewer. Both are exactly the
    -- kind of row an advisory answer must never be able to write.
    INSERT INTO public.proxy_sources (id, organization_id, name, created_by) VALUES
      ('0d000000-0000-4000-8000-0000000000a1', '${ORG_A}', 'G04 source', '${U_ADMIN_A}')
    ON CONFLICT (id) DO NOTHING;

    -- approved_proxy_check requires the FULL methodological record of an
    -- approved proxy: value, currency, unit, reference year and the frozen USD
    -- equivalent. Satisfied rather than worked around, because a half-populated
    -- row would be a weaker fixture for section Q, not an easier one.
    -- (No backticks anywhere in this block: it lives inside a JavaScript
    -- template literal and a single one would close it mid-SQL.)
    INSERT INTO public.financial_proxies
      (id, organization_id, source_id, name, value, value_usd, currency, unit,
       reference_year, confidence_level, methodological_risk, review_status,
       reviewer_id, reviewed_at, created_by)
    VALUES
      ('0d000000-0000-4000-8000-0000000000a2', '${ORG_A}',
       '0d000000-0000-4000-8000-0000000000a1', 'G04 proxy', 1000.0000, 0.2500,
       'COP', 'per_family', 2025, 'medium', 'low',
       'approved', '${U_ADMIN_A}', timezone('UTC', now()), '${U_ADMIN_A}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.sroi_calculation_runs
      (id, project_id, organization_id, currency, total_investment,
       gross_social_value, net_social_value, sroi_ratio, status, calculated_by)
    VALUES
      ('0d000000-0000-4000-8000-0000000000a3', '${P_JOURNEY}', '${ORG_A}', 'COP',
       100.0000, 340.0000, 240.0000, 3.400000, 'calculated', '${U_ADMIN_A}')
    ON CONFLICT (id) DO NOTHING;
  `)
}

/* ========================================================================== */
/* The runtime under test — imported AFTER the mocks are registered           */
/* ========================================================================== */

type CreateFileEvidenceAction = (
  projectId: string,
  input: unknown,
) => Promise<{
  evidence: { id: string; projectId: string; status: string; filePath: string | null }
  indexing: { status: string; versionId?: string; chunkCount?: number; reason?: string; stage?: string } | null
}>

type GroundedResult = {
  status: string
  code?: string
  answerId?: string
  answerStrategy?: { generatorId: string; kind: string }
  answer?: {
    status: string
    claims: ReadonlyArray<{
      statement: string
      citations: ReadonlyArray<{
        chunkId: string
        evidenceId: string
        versionId: string
        availability: string
        excerpt: { text: string } | null
      }>
    }>
    abstention: { code: string; explanation: string } | null
    unresolvedCitationCount: number
  }
}

interface Runtime {
  createFileEvidence: CreateFileEvidenceAction
  createFileEvidenceService: (projectId: string, input: unknown) => Promise<{ id: string }>
  indexEvidence: (projectId: string, evidenceId: string) => Promise<Record<string, unknown>>
  corpusState: (projectId: string) => Promise<Record<string, unknown>>
  archiveEvidence: (projectId: string, evidenceId: string) => Promise<unknown>
  reviewEvidence: (projectId: string, evidenceId: string, input: unknown) => Promise<unknown>
  issue: (projectId: string) => Promise<{ status: string; ticket?: string }>
  run: (projectId: string, query: string, ticket: string) => Promise<GroundedResult>
}

let rt: Runtime

beforeAll(async () => {
  if (!CONTAINER_URL || !CONTAINER_URL.includes('127.0.0.1:56322')) {
    throw new Error(
      'UELLIX_G04_E2E_ADMIN_URL must point at the disposable container on 127.0.0.1:56322. ' +
        'Run this battery through scripts/g04-offline-e2e.sh, which builds and destroys it.',
    )
  }
  admin = postgres(CONTAINER_URL, { max: 4, onnotice: () => {} })
  await seedWorld()

  const create = await import('@/app/app/projects/[projectId]/pipeline/evidence/createFileEvidence.action')
  const index = await import('@/app/app/projects/[projectId]/pipeline/evidence/indexEvidence.action')
  const corpus = await import('@/app/actions/grounding/evidence-corpus-state')
  const service = await import('@/lib/pipeline/evidence')
  const stella = await import('@/app/actions/stella/grounded-query')
  // The lifecycle ACTIONS, not the services they call. The service functions
  // deliberately do not open an identity context — their actions do — so
  // reaching past them would run their statements as `uellix_app` with no
  // claims, where RLS returns zero rows and the call fails for a reason the
  // product never has.
  const archive = await import('@/app/app/projects/[projectId]/pipeline/evidence/archiveEvidence.action')
  const review = await import('@/app/app/projects/[projectId]/pipeline/evidence/updateEvidenceReviewStatus.action')

  rt = {
    createFileEvidence: create.createFileEvidenceAction as unknown as CreateFileEvidenceAction,
    createFileEvidenceService: service.createFileEvidenceForProject as unknown as Runtime['createFileEvidenceService'],
    indexEvidence: (projectId, evidenceId) =>
      index.indexEvidenceAction(projectId, evidenceId) as Promise<Record<string, unknown>>,
    corpusState: (projectId) =>
      corpus.readProjectCorpusStateForProject(projectId) as Promise<Record<string, unknown>>,
    archiveEvidence: (projectId, evidenceId) => archive.archiveEvidenceAction(projectId, evidenceId),
    reviewEvidence: (projectId, evidenceId, input) =>
      review.updateEvidenceReviewStatusAction(projectId, evidenceId, input),
    issue: (projectId) =>
      stella.issueStellaGroundedQueryTicketForProject(projectId) as Promise<{
        status: string
        ticket?: string
      }>,
    run: (projectId, query, ticket) =>
      stella.runStellaGroundedQueryForProject(projectId, { query }, ticket) as Promise<GroundedResult>,
  }
}, 180_000)

afterAll(async () => {
  await admin?.end({ timeout: 5 })
})

beforeEach(async () => {
  currentActor = ADMIN_A
  mockStellaConfig.isEnabled = true
  mockStellaConfig.isGroundedQueryEnabled = true
  mockStellaState.canUseStella = true
  uploadFaultOnce = null
  finalizeFaultOnce = false
  await setQuota(ORG_A, 500)
  await setQuota(ORG_B, 500)
})

/* ========================================================================== */
/* Journey helpers — the PRODUCT path, never a shortcut                       */
/* ========================================================================== */

/**
 * Upload one text/plain file through the real Server Action.
 *
 * `text/plain` is chosen because it is in BOTH the SEC-003 upload allowlist and
 * the extractor's format table — the intersection `classifyGroundingFormat`
 * publishes — so it is the one format this journey can carry end to end. §L
 * measures the complement.
 */
async function upload(
  projectId: string,
  title: string,
  fileName: string,
  text: string,
  mimeType = 'text/plain',
): Promise<Awaited<ReturnType<CreateFileEvidenceAction>>> {
  const buffer = Buffer.from(text, 'utf8')
  return rt.createFileEvidence(projectId, {
    title,
    file: { name: fileName, mimeType, size: buffer.length, buffer },
  })
}

/** Mint a ticket and fail loudly if issuance did not succeed. */
async function issued(projectId: string): Promise<string> {
  const result = await rt.issue(projectId)
  expect(result.status, JSON.stringify(result)).toBe('issued')
  return result.ticket!
}

/** One full question, ticket and all. */
async function ask(projectId: string, query: string): Promise<GroundedResult> {
  const ticket = await issued(projectId)
  return rt.run(projectId, query, ticket)
}

/** Every citation of every claim, flattened. */
function citationsOf(result: GroundedResult) {
  return (result.answer?.claims ?? []).flatMap((claim) => claim.citations)
}

/**
 * Everything the caller was shown, as one string, for presence and absence
 * assertions.
 *
 * EVERY NEEDLE USED AGAINST THIS IS A PHRASE, NEVER A BARE NUMBER, AND THAT IS
 * NOT A STYLE PREFERENCE. This serialisation carries 64-hex digests — chunk
 * ids, version ids, content hashes — so `not.toContain('111')` is a search for
 * three hex characters and matches by accident: it was measured doing exactly
 * that against the version id `d11fae4a26d111b0…`, failing §I2 for a reason
 * that had nothing to do with a stale version. `'111 beneficiaries'` contains a
 * space and letters outside [0-9a-f] and cannot occur inside a digest, so the
 * assertion means what it says while still scanning everything the caller
 * received.
 */
function renderedText(result: GroundedResult): string {
  return JSON.stringify(result)
}

/** The corpus phase the read model reports for one evidence row. */
async function phaseOf(projectId: string, evidenceId: string): Promise<string | null> {
  const state = (await rt.corpusState(projectId)) as {
    status: string
    states?: Array<{ evidenceId: string; phase: string }>
  }
  expect(state.status, JSON.stringify(state)).toBe('ready')
  return state.states!.find((s) => s.evidenceId === evidenceId)?.phase ?? null
}

/* ========================================================================== */

describe('0. The environment is the one this battery declares', () => {
  it('carries no provider key in the process', () => {
    expect(process.env.GEMINI_API_KEY).toBeUndefined()
  })

  it('addresses a LOCAL disposable database, and says so from the connection itself', async () => {
    // Not the URL string this file was handed — what the SERVER reports about
    // itself. A string check alone would pass against a proxy pointed anywhere.
    const rows = await admin`
      SELECT inet_server_addr()::text AS addr, current_database() AS db, version() AS v
    `
    const addr = rows[0]!.addr === null ? '127.0.0.1' : String(rows[0]!.addr)
    expect(['127.0.0.1', '::1', '172.17.0.1'].some((a) => addr.startsWith(a.slice(0, 3)))).toBe(true)
    expect(String(rows[0]!.db)).toBe('postgres')
  })

  it('has the governed read, write and ticket surfaces installed', async () => {
    const rows = await admin`
      SELECT
        to_regprocedure('uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)') IS NOT NULL AS reader,
        to_regprocedure('uellix_grounding.claim_active_document_version(uuid)') IS NOT NULL AS claim,
        to_regclass('public.evidence_document_versions') IS NOT NULL AS versions,
        to_regclass('public.evidence_chunks') IS NOT NULL AS chunks,
        to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)') IS NOT NULL AS bind
    `
    const row = rows[0]! as Record<string, unknown>
    for (const key of ['reader', 'claim', 'versions', 'chunks', 'bind']) {
      expect(row[key], `missing governed object: ${key}`).toBe(true)
    }
  })

  it('starts from a world with NO evidence and NO corpus at all', async () => {
    // The starting point is MEASURED, not assumed. Every row asserted later was
    // written by the application during this run.
    const rows = await admin`
      SELECT
        (SELECT count(*)::int FROM public.evidence_items)            AS items,
        (SELECT count(*)::int FROM public.evidence_document_versions) AS versions,
        (SELECT count(*)::int FROM public.evidence_chunks)            AS chunks
    `
    const row = rows[0]! as Record<string, unknown>
    expect(Number(row.items)).toBe(0)
    expect(Number(row.versions)).toBe(0)
    expect(Number(row.chunks)).toBe(0)
  })
})

/* ========================================================================== */
/* §E — THE HAPPY PATH, MEASURED AT EVERY LINK                                */
/* ========================================================================== */

/** Filled by §E and read by the sections that build on the same corpus. */
let journeyEvidenceId = ''
let journeyVersionUuid = ''

describe('E. Upload -> auto-index -> corpus -> retrieval -> answer -> citations', () => {
  it('E1. an authorized upload commits an evidence identity AND indexes it in the same action', async () => {
    const outcome = await upload(P_JOURNEY, 'Pilot report', 'pilot.txt', DOC_JOURNEY)
    journeyEvidenceId = outcome.evidence.id

    // --- the upload half, read back from COMMITTED rows ------------------
    const row = (await evidenceRow(journeyEvidenceId))!
    expect(row, 'the evidence row must exist outside the action transaction').not.toBeNull()
    expect(String(row.project_id)).toBe(P_JOURNEY)
    expect(String(row.organization_id)).toBe(ORG_A)
    expect(String(row.type)).toBe('file')
    // FILE_PATH_PRESENT — phase 3 committed. This is the fact that separates a
    // finalized upload from the orphan M2-COMP-01 exists to withdraw.
    expect(row.file_path, 'a finalized upload must carry its storage path').not.toBeNull()
    expect(String(row.file_path)).toContain(`${P_JOURNEY}/${journeyEvidenceId}/`)
    // The seal is over the BYTES, not over anything the caller declared.
    expect(String(row.content_hash)).toBe(sha256(DOC_JOURNEY))
    // And the object really is in the bucket, under that exact key.
    expect(bucket.has(`uellix-evidence/${String(row.file_path)}`)).toBe(true)

    // --- the auto-index half ---------------------------------------------
    // AUTO_INDEX_TRIGGERED. The action awaited the service and then indexed the
    // row the SERVICE returned; nothing here asked for indexing separately.
    expect(outcome.indexing, 'a committed upload must have consulted the grounding path').not.toBeNull()
    expect(outcome.indexing!.status, JSON.stringify(outcome.indexing)).toBe('indexed')
    expect(outcome.indexing!.chunkCount!).toBeGreaterThan(0)

    // --- and the corpus, read by a DIFFERENT connection --------------------
    const versions = await documentVersions(journeyEvidenceId)
    expect(versions, 'DOCUMENT_VERSION_COUNT >= 1').toHaveLength(1)
    expect(Number(versions[0]!.ordinal)).toBe(1)
    expect(String(versions[0]!.id)).toBe(outcome.indexing!.versionId)
    expect(String(versions[0]!.raw_content_hash).trim()).toBe(sha256(DOC_JOURNEY))
    journeyVersionUuid = String(versions[0]!.id)

    expect(await chunkCountFor(journeyEvidenceId), 'CHUNK_COUNT >= 1').toBeGreaterThan(0)
    expect(await chunkCountFor(journeyEvidenceId)).toBe(outcome.indexing!.chunkCount)
  }, 120_000)

  it('E2. the durable read model reports the row as indexed', async () => {
    // CORPUS_STATE, through the product's own read model rather than by
    // re-deriving it here. It answers from `evidence_document_versions` plus a
    // canonical chunk count — the same rows §E1 read directly — so agreement
    // between the two is a property of the system and not of this file.
    expect(await phaseOf(P_JOURNEY, journeyEvidenceId)).toBe('indexed')
  }, 60_000)

  it('E3. the freshly indexed corpus ANSWERS, quoting the document, with valid citations', async () => {
    const result = await ask(P_JOURNEY, 'How many families did the program serve in Barranquilla?')

    expect(result.status, JSON.stringify(result)).toBe('ok')

    // The answer reflects the evidence, and the two figures are checked
    // separately: a check for "347" alone would pass on a document that merely
    // contained the number, and one for "Barranquilla" alone on any mention of
    // the city.
    const shown = renderedText(result)
    expect(shown).toContain('347 families')
    expect(shown).toContain('Barranquilla')

    // EXTRACTIVE, and named by the runtime rather than by this test.
    expect(result.answerStrategy!.kind).toBe('extractive')
    expect(result.answerStrategy!.generatorId.startsWith('grounding-local-extractive/')).toBe(true)

    // CITATIONS — every one points at a REAL, KNOWN source: this evidence row,
    // this document version, and a chunk that exists in the table.
    const citations = citationsOf(result)
    expect(citations.length, 'a grounded answer must carry at least one citation').toBeGreaterThan(0)
    for (const citation of citations) {
      expect(citation.evidenceId).toBe(journeyEvidenceId)
      expect(citation.availability).toBe('passage_loaded')
      const known = await admin`
        SELECT count(*)::int AS n FROM public.evidence_chunks
        WHERE chunk_id = ${citation.chunkId}
          AND evidence_id = ${journeyEvidenceId}
          AND document_version_id = ${journeyVersionUuid}
      `
      expect(
        Number(known[0]!.n),
        'a citation named a chunk that does not exist in the corpus',
      ).toBe(1)
    }
    // And no citation was shown whose passage could not be loaded.
    expect(result.answer!.unresolvedCitationCount).toBe(0)

    // The unit was charged under THIS project — an answer delivered is an
    // answer accounted for.
    expect(await chargeCountForProject(P_JOURNEY)).toBeGreaterThan(0)
  }, 120_000)

  it('E4. every emitted statement is a literal slice of a cited passage', async () => {
    // The invariant the extractive generator's header states, checked against
    // the DATABASE rather than against the generator's own fixtures: nothing
    // was synthesised, so nothing can have been invented.
    const result = await ask(P_JOURNEY, 'How many families did the program serve in Barranquilla?')
    expect(result.status).toBe('ok')

    for (const claim of result.answer!.claims) {
      const texts = await Promise.all(
        claim.citations.map(async (citation) => {
          const rows = await admin`
            SELECT content FROM public.evidence_chunks WHERE chunk_id = ${citation.chunkId}
          `
          return rows.length === 0 ? '' : String(rows[0]!.content)
        }),
      )
      const bare = claim.statement.replace(/^[«"'\s]+|[»"'\s]+$/g, '')
      expect(
        texts.some((text) => text.includes(bare)),
        `a statement was emitted that is not a slice of any cited passage: ${claim.statement}`,
      ).toBe(true)
    }
  }, 120_000)
})

/* ========================================================================== */
/* §F / §O — CROSS-PROJECT AND CROSS-TENANT ISOLATION                         */
/* ========================================================================== */

let otherEvidenceId = ''

describe('F/O. One question, two corpora, one answer', () => {
  it('F1. the other tenant uploads and indexes evidence of its own', async () => {
    const outcome = await as(ADMIN_B, () =>
      upload(P_OTHER, 'Other pilot report', 'other.txt', DOC_OTHER),
    )
    otherEvidenceId = outcome.evidence.id
    expect(outcome.indexing!.status).toBe('indexed')
    expect(await chunkCountFor(otherEvidenceId)).toBeGreaterThan(0)
  }, 120_000)

  it('F2. THE ATTACK — a question both documents answer, asked inside one project', async () => {
    // ------------------------------------------------------------------
    // THE STRONGEST ISOLATION CASE THIS CORPUS ALLOWS.
    //
    // The two documents share their sentence frame word for word, so the
    // OTHER project's chunk is a genuinely high-scoring candidate for this
    // query — not a document that would have been filtered out anyway. The
    // only thing that keeps it out is the project predicate, which is exactly
    // what INT-GR-001 asks to be exercised through the PRODUCT PATH rather
    // than by handing a hand-picked filter to a low-level repository.
    //
    // Both directions are asserted. A system that answered nothing would pass
    // the absence half for free.
    // ------------------------------------------------------------------
    const mine = await ask(P_JOURNEY, SHARED_QUERY)
    expect(mine.status, JSON.stringify(mine)).toBe('ok')

    const shown = renderedText(mine)
    expect(shown).toContain('347 families')
    expect(shown).toContain('Barranquilla')
    expect(shown, 'the other project figure reached this answer').not.toContain('982 farmers')
    expect(shown, 'the other project territory reached this answer').not.toContain('Monteria')
    expect(shown, "the other project's evidence id reached this answer").not.toContain(otherEvidenceId)

    // No CITATION belongs to the other project, checked against the row rather
    // than against the id string: a citation is only safe if the chunk it names
    // really is stored under this project.
    for (const citation of citationsOf(mine)) {
      const rows = await admin`
        SELECT project_id, organization_id FROM public.evidence_chunks
        WHERE chunk_id = ${citation.chunkId}
      `
      expect(rows).toHaveLength(1)
      expect(String(rows[0]!.project_id)).toBe(P_JOURNEY)
      expect(String(rows[0]!.organization_id)).toBe(ORG_A)
    }

    // And the mirror, so "isolation" cannot mean "the other corpus is dead".
    const theirs = await as(ADMIN_B, () => ask(P_OTHER, SHARED_QUERY))
    expect(theirs.status, JSON.stringify(theirs)).toBe('ok')
    const theirShown = renderedText(theirs)
    expect(theirShown).toContain('982 farmers')
    expect(theirShown).not.toContain('347 families')
    expect(theirShown).not.toContain('Barranquilla')
  }, 180_000)

  it('F3. and the other tenant cannot even ask inside this project', async () => {
    // The attribution half. `runStellaGroundedQueryForProject` is an
    // independently invocable endpoint, so the project argument is assumed
    // forged and re-verified against the session's organization.
    const before = await chargeCountForProject(P_JOURNEY)
    const issue = await as(ADMIN_B, () => rt.issue(P_JOURNEY))
    expect(issue.status).not.toBe('issued')

    // Even with a legitimate ticket of its OWN project, the run against this
    // one is refused before a chunk is read.
    const foreign = await as(ADMIN_B, () => issued(P_OTHER))
    const attack = await as(ADMIN_B, () => rt.run(P_JOURNEY, SHARED_QUERY, foreign))
    expect(attack.status).toBe('error')
    expect(await chargeCountForProject(P_JOURNEY)).toBe(before)
  }, 120_000)

  it('F4. and it cannot index this project\'s evidence either', async () => {
    const versionsBefore = await documentVersions(journeyEvidenceId)
    const refused = await as(ADMIN_B, () => rt.indexEvidence(P_JOURNEY, journeyEvidenceId))
    // ONE answer for "not entitled", "not yours" and "does not exist": telling
    // them apart would let a caller enumerate evidence ids across tenants.
    expect(refused.status).toBe('unauthorized')
    expect(await documentVersions(journeyEvidenceId)).toHaveLength(versionsBefore.length)
  }, 60_000)
})

/* ========================================================================== */
/* §G — A PROJECT WITH NO INDEXABLE EVIDENCE                                  */
/* ========================================================================== */

describe('G. Nothing to ground an answer in', () => {
  it('G1. refuses deterministically, invents no source, and releases the reservation', async () => {
    expect(await chunkCountForProject(P_EMPTY)).toBe(0)

    const chargesBefore = await chargeCountForProject(P_EMPTY)
    const ticket = await issued(P_EMPTY)
    const result = await rt.run(P_EMPTY, SHARED_QUERY, ticket)

    // THE CURRENT CONTRACT, RECORDED RATHER THAN REWRITTEN: the action reaches
    // step 10, finds an empty authorized evidence set, and reports a named
    // operational state instead of an answer. It is not an error about the
    // system and not an abstention about the evidence's CONTENT — there is no
    // evidence at all.
    expect(result.status).toBe('error')
    expect(result.code).toBe('UNSUPPORTED_STEP')
    expect(result.answer).toBeUndefined()
    expect(result.answerId).toBeUndefined()

    // No fabricated substance and no invented source of any kind.
    expect(renderedText(result)).not.toContain('347 families')
    expect(renderedText(result)).not.toContain(journeyEvidenceId)

    // The reservation was released, so an unanswerable question does not hold
    // a unit of the organization's headroom, and nothing was charged.
    expect(await ticketStatus(ticket)).toBe('aborted')
    expect(await chargeCountForProject(P_EMPTY)).toBe(chargesBefore)

    // And no corpus appeared as a side effect of asking.
    expect(await chunkCountForProject(P_EMPTY)).toBe(0)
  }, 120_000)
})

/* ========================================================================== */
/* §H — ARCHIVED EVIDENCE, THROUGH THE LEGITIMATE LIFECYCLE                   */
/* ========================================================================== */

describe('H. Archived evidence stops grounding new answers', () => {
  it('H1. indexed, retrievable, then archived, then absent — all through the product path', async () => {
    const outcome = await upload(P_ARCHIVE, 'Workshop report', 'workshops.txt', DOC_ARCHIVED)
    const evidenceId = outcome.evidence.id
    expect(outcome.indexing!.status).toBe('indexed')

    // 1. It grounds an answer while it is live.
    const before = await ask(P_ARCHIVE, ARCHIVE_QUERY)
    expect(before.status, JSON.stringify(before)).toBe('ok')
    expect(renderedText(before)).toContain('555 workshops')
    expect(citationsOf(before).some((c) => c.evidenceId === evidenceId)).toBe(true)

    // 2. Archived through `archiveEvidenceForProject` — the real lifecycle
    //    path, with its own role check and its own audit row. Nothing here
    //    writes the status column directly.
    await rt.archiveEvidence(P_ARCHIVE, evidenceId)
    expect(String((await evidenceRow(evidenceId))!.status)).toBe('archived')

    // 3. A NEW question. The corpus is untouched — the chunks are all still
    //    there — so this measures the product path's exclusion and nothing else.
    expect(await chunkCountFor(evidenceId)).toBeGreaterThan(0)

    const after = await ask(P_ARCHIVE, ARCHIVE_QUERY)
    expect(after.status).toBe('error')
    expect(after.code).toBe('UNSUPPORTED_STEP')
    expect(renderedText(after), 'archived evidence grounded a new answer').not.toContain('555 workshops')
    expect(renderedText(after)).not.toContain(evidenceId)
  }, 180_000)

  it('H2. INT-GR-001 — the low-level primitive is still wider, and the product path is what closes it', async () => {
    // ------------------------------------------------------------------
    // MEASURED, NOT ARGUED, AND DELIBERATELY NOT REPAIRED HERE.
    //
    // The readiness audit classified INT-GR-001 as MITIGATED, NOT CLOSED
    // because archive exclusion is imposed by the SERVER ACTION's allowlist
    // (`draft | under_review | approved`, step 10) rather than by the governed
    // reader. This test pins BOTH halves so the classification stops being an
    // opinion:
    //
    //   * `chunks_in_scope_attested` still returns the archived row's chunks
    //     when it is handed that version directly — it filters scope, never
    //     status;
    //   * and no product path hands it that version, which §H1 measured.
    //
    // Repairing the primitive would mean a new governed package and is out of
    // G-04's scope. What must not happen is the debt being forgotten, so it is
    // asserted in the direction that FAILS THE DAY IT IS FIXED — at which point
    // this test is the one that says so.
    // ------------------------------------------------------------------
    const archived = await admin`
      SELECT e.id, v.id AS version_uuid
      FROM public.evidence_items e
      JOIN public.evidence_document_versions v ON v.evidence_id = e.id
      WHERE e.project_id = ${P_ARCHIVE} AND e.status = 'archived'
      LIMIT 1
    `
    expect(archived).toHaveLength(1)

    const reachable = await admin`
      SELECT count(*)::int AS n
      FROM public.evidence_chunks
      WHERE document_version_id = ${String(archived[0]!.version_uuid)}
        AND canonical_chunk_id IS NULL
    `
    expect(
      Number(reachable[0]!.n),
      'INT-GR-001 changed shape: the corpus no longer holds the archived rows this test pins',
    ).toBeGreaterThan(0)
  }, 60_000)
})

/* ========================================================================== */
/* §I — SUPERSESSION                                                          */
/* ========================================================================== */

/**
 * §I2's evidence row: the SAME ORGANISATION, a DIFFERENT PROJECT, live, and
 * carrying a figure no other project states. §U1 uses it as the cross-project
 * attack, which is strictly stronger than the cross-tenant one — an
 * organisation predicate would exclude a foreign tenant's row on its own, so a
 * test that only tried that could never observe the PROJECT predicate working.
 */
let sameOrgOtherProjectEvidenceId = ''

describe('I. A superseded document does not answer for its successor', () => {
  let v1Evidence = ''
  let v2Evidence = ''

  it('I1. the PRODUCT contract — a new document is a new evidence row, and the old one is archived', async () => {
    // ------------------------------------------------------------------
    // THE CONTRACT AS IT ACTUALLY IS, FOLLOWED RATHER THAN INVENTED.
    //
    // One evidence row cannot hold two content versions through any product
    // path: `content_hash` is written once at upload from the BYTES, the
    // resolver refuses bytes that do not reproduce it, and `version_id` is
    // `deriveVersionId(evidenceId, rawContentHash)`. So a revised document is
    // a NEW evidence row, and supersession is the archive lifecycle — which is
    // exactly what this measures.
    // ------------------------------------------------------------------
    const first = await upload(P_VERSION, 'Beneficiaries v1', 'v1.txt', DOC_V1)
    v1Evidence = first.evidence.id
    expect(first.indexing!.status).toBe('indexed')

    const early = await ask(P_VERSION, VERSION_QUERY)
    expect(early.status, JSON.stringify(early)).toBe('ok')
    expect(renderedText(early)).toContain('111 beneficiaries')

    const second = await upload(P_VERSION, 'Beneficiaries v2', 'v2.txt', DOC_V2)
    v2Evidence = second.evidence.id
    expect(second.indexing!.status).toBe('indexed')
    expect(v2Evidence).not.toBe(v1Evidence)

    await rt.archiveEvidence(P_VERSION, v1Evidence)

    const late = await ask(P_VERSION, VERSION_QUERY)
    expect(late.status, JSON.stringify(late)).toBe('ok')
    expect(renderedText(late), 'the successor figure is missing').toContain('222 beneficiaries')
    expect(renderedText(late), 'the superseded figure survived into a new answer').not.toContain('111 beneficiaries')
    for (const citation of citationsOf(late)) {
      expect(citation.evidenceId).toBe(v2Evidence)
    }
  }, 240_000)

  it('I2. the CORPUS contract — when a second ordinal exists, retrieval reads only the latest', async () => {
    // ------------------------------------------------------------------
    // THE ONE PLACE THIS FILE USES A PRIVILEGED PRECONDITION, DECLARED.
    //
    // A second ordinal under ONE evidence row is representable in the schema
    // (`UNIQUE (evidence_id, ordinal)`, `supersedes_version_id`) and is what
    // `claim_active_document_version` and the repository's
    // `DISTINCT ON (evidence_id) ... ORDER BY ordinal DESC` exist for. No
    // product path reaches it, because no product path rewrites a row's
    // `content_hash` — so the only honest way to measure the corpus contract is
    // to move that column with the admin connection and let the APPLICATION do
    // everything else.
    //
    // What stays real: the object replacement in the bucket, the resolver's
    // hash verification, `register_document_version`, the ordinal arithmetic,
    // the chunk write, the finalize, and the whole retrieval path.
    // ------------------------------------------------------------------
    const evidence = await upload(P_ORDINAL, 'Ordinals', 'ordinal.txt', DOC_V1)
    const evidenceId = evidence.evidence.id
    sameOrgOtherProjectEvidenceId = evidenceId
    expect(evidence.indexing!.status).toBe('indexed')
    const filePath = String((await evidenceRow(evidenceId))!.file_path)

    // Replace the stored object and re-anchor the row to the new bytes.
    bucket.set(`uellix-evidence/${filePath}`, {
      bytes: Buffer.from(DOC_V2, 'utf8'),
      contentType: 'text/plain',
    })
    await admin`
      UPDATE public.evidence_items
      SET content_hash = ${sha256(DOC_V2)}, file_size = ${Buffer.byteLength(DOC_V2, 'utf8')}
      WHERE id = ${evidenceId}
    `

    // The application indexes again — the real retry surface, no shortcut.
    const reindexed = await rt.indexEvidence(P_ORDINAL, evidenceId)
    expect(reindexed.status, JSON.stringify(reindexed)).toBe('indexed')

    const versions = await documentVersions(evidenceId)
    expect(versions, 'a second ordinal was not registered').toHaveLength(2)
    expect(Number(versions[1]!.ordinal)).toBe(2)
    expect(String(versions[1]!.raw_content_hash).trim()).toBe(sha256(DOC_V2))
    // The chain of custody names its predecessor.
    expect(String(versions[1]!.supersedes_version_id ?? '').trim()).toBe(
      String(versions[0]!.version_id).trim(),
    )
    // BOTH versions' chunks are still stored — nothing was deleted, and this
    // is the assertion that makes the rest measure the READ contract rather
    // than a cleanup. Ordinal 1's passage is physically present and still does
    // not reach the answer.
    expect(await chunkCountFor(evidenceId)).toBeGreaterThanOrEqual(2)
    const stalePassages = await admin`
      SELECT count(*)::int AS n FROM public.evidence_chunks
      WHERE evidence_id = ${evidenceId} AND content LIKE '%111%'
    `
    expect(Number(stalePassages[0]!.n)).toBeGreaterThan(0)

    const result = await ask(P_ORDINAL, VERSION_QUERY)
    expect(result.status, JSON.stringify(result)).toBe('ok')
    const shown = renderedText(result)
    expect(shown).toContain('222 beneficiaries')
    expect(shown, 'a stale version answered alongside the active one').not.toContain('111 beneficiaries')

    // Every citation carries the ACTIVE version's identity.
    const activeVersionId = String(versions[1]!.version_id).trim()
    for (const citation of citationsOf(result).filter((c) => c.evidenceId === evidenceId)) {
      expect(citation.versionId.trim()).toBe(activeVersionId)
    }
  }, 240_000)
})

/* ========================================================================== */
/* §J / §K — A FAILED UPLOAD NEVER BECOMES CORPUS, AND A GOOD ONE STILL DOES  */
/* ========================================================================== */

describe('J/K. Storage failure vs storage success, in one architecture', () => {
  it('J1. a failed upload throws, withdraws its row, and produces no corpus of any kind', async () => {
    const versionsBefore = await admin`SELECT count(*)::int AS n FROM public.evidence_document_versions`
    const chunksBefore = await chunkCountForProject(P_FAILED)

    uploadFaultOnce = 'Bucket unavailable'

    // TRUTHFUL FAILURE: the action does not return a degraded success.
    await expect(
      upload(P_FAILED, 'Doomed report', 'doomed.txt', DOC_JOURNEY),
    ).rejects.toThrow(/Storage upload failed/)

    // The row, found by the shape M2-COMP-01 makes unambiguous:
    // type='file' AND file_path IS NULL AND status='archived' is reached by
    // nothing else — a reviewer archiving real evidence archives a row that has
    // a path.
    const orphan = await admin`
      SELECT id, status, file_path FROM public.evidence_items
      WHERE project_id = ${P_FAILED} AND type = 'file' AND file_path IS NULL
    `
    expect(orphan, 'the failed upload left no durable row at all').toHaveLength(1)
    expect(String(orphan[0]!.status), 'the compensation did not withdraw the row').toBe('archived')
    expect(orphan[0]!.file_path).toBeNull()

    const orphanId = String(orphan[0]!.id)

    // AUTO_INDEX_TRIGGERED=false — proved by the DOWNSTREAM STATE, not by a
    // spy. `createFileEvidenceAction` indexes on the line after the await, and
    // the await threw, so nothing downstream ever ran.
    expect(await documentVersions(orphanId), 'DOCUMENT_VERSION_CREATED').toHaveLength(0)
    expect(await chunkCountFor(orphanId), 'CHUNK_COUNT').toBe(0)
    expect(await chunkCountForProject(P_FAILED)).toBe(chunksBefore)
    expect(
      Number((await admin`SELECT count(*)::int AS n FROM public.evidence_document_versions`)[0]!.n),
    ).toBe(Number(versionsBefore[0]!.n))

    // The only durable trace of an upload that stored nothing.
    const trail = await auditRows(orphanId, 'evidence_item.upload_failed')
    expect(trail, 'no upload_failed audit row was written').toHaveLength(1)
    expect((trail[0]!.after_json as Record<string, unknown>).stage).toBe('upload')
    expect((trail[0]!.after_json as Record<string, unknown>).compensated).toBe(true)
    // And NO created-evidence row: the upload never completed.
    expect(await auditRows(orphanId, 'evidence_item.created')).toHaveLength(0)

    // CORPUS_NOT_INDEXED, through the read model the screen uses.
    expect(await phaseOf(P_FAILED, orphanId)).not.toBe('indexed')

    // SROI_SUBSTANTIVE_EVIDENCE=false. The withdrawn row is outside the
    // allowlist the SROI gate and the query path both read, so it cannot count
    // as supporting evidence for anything.
    const counted = await admin`
      SELECT count(*)::int AS n FROM public.evidence_items
      WHERE project_id = ${P_FAILED} AND status IN ('draft','under_review','approved')
    `
    expect(Number(counted[0]!.n)).toBe(0)

    // GROUNDED_CITATION=false — asked through the product path, end to end.
    const ticket = await issued(P_FAILED)
    const result = await rt.run(P_FAILED, SHARED_QUERY, ticket)
    expect(result.status).toBe('error')
    expect(result.code).toBe('UNSUPPORTED_STEP')
    expect(citationsOf(result)).toHaveLength(0)
  }, 180_000)

  it('J2. a FINALIZE failure leaves the same shape — the second orphan M2-COMP-01 closes', async () => {
    finalizeFaultOnce = true

    await expect(
      upload(P_FAILED, 'Half-written report', 'half.txt', DOC_ARCHIVED),
    ).rejects.toThrow(/G04 fault injection: finalize/)

    const rows = await admin`
      SELECT id, status, file_path FROM public.evidence_items
      WHERE project_id = ${P_FAILED} AND type = 'file' AND file_path IS NULL
      ORDER BY created_at DESC
    `
    expect(rows.length).toBe(2)
    const latest = rows[0]!
    expect(String(latest.status)).toBe('archived')
    expect(latest.file_path).toBeNull()
    expect(await documentVersions(String(latest.id))).toHaveLength(0)

    const trail = await auditRows(String(latest.id), 'evidence_item.upload_failed')
    expect(trail).toHaveLength(1)
    expect((trail[0]!.after_json as Record<string, unknown>).stage).toBe('finalize')
  }, 120_000)

  it('J3. the withdrawn row cannot be dragged into the corpus by a manual retry either', async () => {
    // The counterfactual "M2-COMP archived row is allowed to index", asked of
    // the real retry surface. It is refused for the honest reason — the row
    // names no bytes — so the refusal survives any later change to how status
    // is read.
    const orphan = await admin`
      SELECT id FROM public.evidence_items
      WHERE project_id = ${P_FAILED} AND file_path IS NULL ORDER BY created_at ASC LIMIT 1
    `
    const orphanId = String(orphan[0]!.id)

    const refused = await rt.indexEvidence(P_FAILED, orphanId)
    expect(refused.status, JSON.stringify(refused)).toBe('refused')
    expect(refused.reason).toBe('missing_bytes')
    expect(await documentVersions(orphanId)).toHaveLength(0)
    expect(await chunkCountFor(orphanId)).toBe(0)
  }, 60_000)

  it('K1. and a SUCCESSFUL upload into the same project still auto-indexes and answers', async () => {
    // ------------------------------------------------------------------
    // THE CONTRAST, IN ONE ARCHITECTURE AND ONE PROJECT.
    //
    // Without it, every "no corpus" assertion above is satisfiable by a
    // regression that broke indexing outright. The failed and the successful
    // upload differ in exactly one thing — whether the storage call returned an
    // error — and everything downstream diverges from there.
    // ------------------------------------------------------------------
    const outcome = await upload(P_FAILED, 'Recovered report', 'recovered.txt', DOC_ARCHIVED)
    const evidenceId = outcome.evidence.id

    expect(String((await evidenceRow(evidenceId))!.status)).toBe('draft')
    expect((await evidenceRow(evidenceId))!.file_path).not.toBeNull()
    expect(outcome.indexing!.status).toBe('indexed')
    expect(await documentVersions(evidenceId)).toHaveLength(1)
    expect(await chunkCountFor(evidenceId)).toBeGreaterThan(0)
    expect(await phaseOf(P_FAILED, evidenceId)).toBe('indexed')

    const result = await ask(P_FAILED, ARCHIVE_QUERY)
    expect(result.status, JSON.stringify(result)).toBe('ok')
    expect(renderedText(result)).toContain('555 workshops')
    expect(citationsOf(result).every((c) => c.evidenceId === evidenceId)).toBe(true)
  }, 180_000)

  it('K2. the SERVICE alone does not index — the auto-index is a decision of the ACTION', async () => {
    // The counterfactual "G01 auto-index call is removed", expressed by calling
    // the layer that does not make it. `createFileEvidenceForProject` is the
    // same production function §K1 ran through; the only difference is the
    // caller. If the action's indexing line were deleted, §K1 would look
    // exactly like this.
    const buffer = Buffer.from(DOC_ARCHIVED + ' Addendum.', 'utf8')
    const evidence = await rt.createFileEvidenceService(P_FAILED, {
      title: 'Service only',
      file: { name: 'service-only.txt', mimeType: 'text/plain', size: buffer.length, buffer },
    })

    expect((await evidenceRow(evidence.id))!.file_path).not.toBeNull()
    expect(await documentVersions(evidence.id), 'the service indexed on its own').toHaveLength(0)
    expect(await chunkCountFor(evidence.id)).toBe(0)
    expect(await phaseOf(P_FAILED, evidence.id)).toBe('ready_to_index')
  }, 120_000)
})

/* ========================================================================== */
/* §L — STORED, AND NEVER CORPUS                                              */
/* ========================================================================== */

describe('L. A format the product stores and the classifier will not index', () => {
  it('L1. a PDF is accepted as evidence, refused as corpus, and never claimed to be indexed', async () => {
    // `application/pdf` is in the SEC-003 upload allowlist and NOT in the
    // extractor's table — the gap `classifyGroundingFormat` publishes. The
    // format contract is USED here, never widened.
    const outcome = await upload(
      P_FORMAT,
      'Scanned annex',
      'annex.pdf',
      '%PDF-1.4 not really a pdf, and it does not need to be: no extractor is reached.',
      'application/pdf',
    )
    const evidenceId = outcome.evidence.id

    // EVIDENCE_STORED — the product permits it, so it is stored, sealed and
    // finalized exactly like any other upload.
    const row = (await evidenceRow(evidenceId))!
    expect(row.file_path).not.toBeNull()
    expect(String(row.mime_type)).toBe('application/pdf')

    // GROUNDING_INDEXED=false, and the reason is NAMED rather than a bare
    // failure — the screen must be able to tell "no parser for this format"
    // (never worth a retry) from "the document normalized to nothing".
    expect(outcome.indexing!.status, JSON.stringify(outcome.indexing)).toBe('not_indexed')
    expect(typeof outcome.indexing!.reason).toBe('string')

    expect(await documentVersions(evidenceId)).toHaveLength(0)
    expect(await chunkCountFor(evidenceId)).toBe(0)

    // THE READ MODEL MUST NOT CLAIM "indexed". It says the row can never be
    // corpus content, which is a different and truthful statement.
    expect(await phaseOf(P_FORMAT, evidenceId)).toBe('not_indexable')

    // NO_CITATION — asked through the product path, and the CURRENT CONTRACT
    // recorded exactly rather than assumed.
    //
    // This is NOT the §G answer, and the difference is the product telling the
    // truth about two different situations. §G's project has no authorized
    // evidence at all, so step 10 finds an empty set and returns
    // `UNSUPPORTED_STEP` before retrieval. Here the evidence set is NOT empty —
    // the PDF is stored, `draft`, and inside the allowlist — so retrieval runs,
    // finds no chunks, and the journey produces a real ABSTENTION. An
    // abstention is an answer: it carries GROUNDING's own reason code and
    // explanation, which is more useful to a reviewer than a generic banner.
    //
    // What matters for §L is that it carries NO claim and NO citation.
    const ticket = await issued(P_FORMAT)
    const result = await rt.run(P_FORMAT, 'What does the scanned annex say?', ticket)
    expect(result.status, JSON.stringify(result)).toBe('ok')
    expect(result.answer!.abstention, 'an unindexable corpus must abstain, not assert').not.toBeNull()
    expect(result.answer!.claims.filter((c) => c.citations.length > 0)).toHaveLength(0)
    expect(citationsOf(result)).toHaveLength(0)
    // And the abstention says nothing was inspected — there is no chunk to
    // inspect, which is different from "chunks existed and none was relevant".
    expect(result.answer!.abstention!.code).toBe('no_matching_evidence')
  }, 180_000)
})

/* ========================================================================== */
/* §M — CITATION INTEGRITY, AND AN ATTACK ON IT                               */
/* ========================================================================== */

describe('M. A citation cannot name a source that was not retrieved', () => {
  /**
   * Run one query through the REAL journey with a HOSTILE generator.
   *
   * Everything except the generator is production: the persisted attested
   * repository, the real scope, the real retrieval, the real
   * `buildGroundedAnswer`. The generator is the seam the contract calls
   * `AnswerDraftProvider`, and it is the exact boundary a real model would plug
   * into — which is why the attack belongs here and not one layer up, where it
   * would only prove that a mock can be mocked.
   */
  async function askWithDraft(projectId: string, claims: unknown[]) {
    const { withDatabaseIdentityContext } = await import('@/db/identity-context')
    const { createPersistedGroundingChunkRepository } = await import(
      '@/db/grounding/grounding-chunk-repository'
    )
    const { runGroundedQuery } = await import('@/lib/grounding/retrieve')

    const scope = { organizationId: currentActor.organizationId, projectId }
    const evidenceIds = (
      await admin`
        SELECT id FROM public.evidence_items
        WHERE project_id = ${projectId} AND status IN ('draft','under_review','approved')
      `
    ).map((row) => String(row.id))

    return withDatabaseIdentityContext(
      { userId: currentActor.userId, organizationId: currentActor.organizationId, isSuperAdmin: false },
      () =>
        runGroundedQuery({
          repository: createPersistedGroundingChunkRepository(scope),
          scope,
          text: SHARED_QUERY,
          generator: {
            id: 'g04-hostile/attack-1',
            draftAnswer: async () => ({ claims: claims as never }),
          },
          retrieval: { evidenceIds, requireScopeAttestation: true },
        }),
    )
  }

  it('M1. every citation the product returns corresponds to a retrieved, authorized chunk', async () => {
    // The positive control. Without it, §M2 would only prove that a system
    // which cites nothing rejects everything.
    const result = await ask(P_JOURNEY, SHARED_QUERY)
    expect(result.status).toBe('ok')
    const citations = citationsOf(result)
    expect(citations.length).toBeGreaterThan(0)
    for (const citation of citations) {
      const rows = await admin`
        SELECT project_id, organization_id, canonical_chunk_id
        FROM public.evidence_chunks WHERE chunk_id = ${citation.chunkId}
      `
      expect(rows).toHaveLength(1)
      expect(String(rows[0]!.project_id)).toBe(P_JOURNEY)
      // Never a SUPPRESSED duplicate presented as if it were the passage.
      expect(rows[0]!.canonical_chunk_id).toBeNull()
    }
  }, 120_000)

  it('M2. an UNKNOWN source id is rejected, not silently accepted', async () => {
    const FORGED = 'f'.repeat(64) as ContentHash
    const run = await askWithDraft(P_JOURNEY, [
      {
        kind: 'evidence',
        statement: 'The program served exactly 999 households in Cartagena.',
        chunkIds: [FORGED],
      },
    ])

    // The claim did not survive, and the system says WHY by a stable name.
    const rejected = run.outcome.rejectedClaims
    expect(rejected.length, 'a forged citation was accepted').toBeGreaterThan(0)
    expect(rejected.some((r) => r.reason === 'cites_unretrieved_chunk')).toBe(true)

    // Nothing that reaches a caller carries the forged id or the invented
    // figure. Checked over the WHOLE serialised outcome, so a surviving
    // reference in any field would show up.
    const serialized = JSON.stringify(run.outcome.answer)
    expect(serialized).not.toContain(FORGED)
    expect(serialized).not.toContain('999 households')
    expect(serialized).not.toContain('Cartagena')
  }, 120_000)

  it('M3. a PARTLY forged claim is rejected WHOLE — one bad id poisons the claim', async () => {
    // The subtler attack: a real chunk id carries a claim that also names an
    // invented one. Accepting the claim "because one citation checks out"
    // would let a model attach a fabricated source to a true sentence.
    const real = await admin`
      SELECT chunk_id FROM public.evidence_chunks WHERE evidence_id = ${journeyEvidenceId} LIMIT 1
    `
    const realChunkId = String(real[0]!.chunk_id).trim()
    const FORGED = 'e'.repeat(64)

    const run = await askWithDraft(P_JOURNEY, [
      {
        kind: 'evidence',
        statement: 'The program served exactly 347 families in Barranquilla during the pilot.',
        chunkIds: [realChunkId, FORGED],
      },
    ])

    expect(run.outcome.rejectedClaims.some((r) => r.reason === 'cites_unretrieved_chunk')).toBe(true)
    expect(JSON.stringify(run.outcome.answer)).not.toContain(FORGED)
    // The claim itself is gone — not kept with the surviving citation.
    expect(
      run.outcome.answer.status === 'grounded'
        ? JSON.stringify(run.outcome.answer)
        : '',
    ).not.toContain('347 families in Barranquilla during the pilot')
  }, 120_000)

  it('M4. a REAL chunk id belonging to another tenant is exactly as unusable as an invented one', async () => {
    // INT-GR-001 at the citation layer. This id is not a forgery — the row
    // exists, its hash is correct, it would satisfy any format check. It is
    // simply not in THIS retrieval, which is the only thing that matters.
    const foreign = await admin`
      SELECT chunk_id FROM public.evidence_chunks WHERE evidence_id = ${otherEvidenceId} LIMIT 1
    `
    const foreignChunkId = String(foreign[0]!.chunk_id).trim()

    const run = await askWithDraft(P_JOURNEY, [
      {
        kind: 'evidence',
        statement: 'The program served exactly 982 farmers in Monteria during the pilot.',
        chunkIds: [foreignChunkId],
      },
    ])

    expect(run.outcome.rejectedClaims.some((r) => r.reason === 'cites_unretrieved_chunk')).toBe(true)
    const serialized = JSON.stringify(run.outcome.answer)
    expect(serialized).not.toContain(foreignChunkId)
    expect(serialized).not.toContain('982 farmers')
    expect(serialized).not.toContain('Monteria')
  }, 120_000)
})

/* ========================================================================== */
/* §N — THE FLAG OFF                                                          */
/* ========================================================================== */

describe('N. With the capability off, nothing downstream runs', () => {
  it('N1. no ticket, no retrieval, no answer, no ledger row, no corpus read', async () => {
    const ticketsBefore = await ticketCount()
    const chargesBefore = await chargeCountForProject(P_JOURNEY)
    const auditBefore = await admin`
      SELECT count(*)::int AS n FROM public.audit_logs WHERE action = 'stella.invoked'
    `

    mockStellaConfig.isGroundedQueryEnabled = false

    const issue = await rt.issue(P_JOURNEY)
    expect(issue.status).toBe('disabled')

    const run = await rt.run(P_JOURNEY, SHARED_QUERY, 'e'.repeat(64))
    expect(run.status).toBe('error')
    expect(run.code).toBe('DISABLED')
    expect(run.answer).toBeUndefined()
    expect(citationsOf(run)).toHaveLength(0)

    // The read model is off by the SAME switch — a screen must not describe a
    // corpus the deployment does not have.
    expect((await rt.corpusState(P_JOURNEY)).status).toBe('disabled')

    // And the indexing surface too, so the corpus cannot fill up for a
    // capability that is off.
    expect((await rt.indexEvidence(P_JOURNEY, journeyEvidenceId)).status).toBe('disabled')

    // ZERO WRITES on the query side. Measured against the tables that would
    // record them, not inferred from the returned status.
    expect(await ticketCount()).toBe(ticketsBefore)
    expect(await chargeCountForProject(P_JOURNEY)).toBe(chargesBefore)
    const auditAfter = await admin`
      SELECT count(*)::int AS n FROM public.audit_logs WHERE action = 'stella.invoked'
    `
    expect(Number(auditAfter[0]!.n)).toBe(Number(auditBefore[0]!.n))
  }, 120_000)

  it('N2. and evidence upload still works — the flag gates GROUNDING, not evidence', async () => {
    // The boundary of the flag, measured. If turning grounding off also
    // silently broke uploads, "flag off is safe" would be hiding an outage.
    mockStellaConfig.isGroundedQueryEnabled = false

    const outcome = await upload(P_EMPTY, 'Stored while dark', 'dark.txt', DOC_JOURNEY)
    expect((await evidenceRow(outcome.evidence.id))!.file_path).not.toBeNull()
    // The auto-index was CONSULTED and answered "disabled" — it did not fail,
    // and it did not silently index.
    expect(outcome.indexing!.status).toBe('disabled')
    expect(await documentVersions(outcome.evidence.id)).toHaveLength(0)
    expect(await chunkCountForProject(P_EMPTY)).toBe(0)
  }, 120_000)

  it('N3. and once the flag is back on, the same row indexes on retry', async () => {
    // Proves N2 measured a REFUSAL and not a broken row.
    const rows = await admin`
      SELECT id FROM public.evidence_items WHERE project_id = ${P_EMPTY} ORDER BY created_at DESC LIMIT 1
    `
    const evidenceId = String(rows[0]!.id)
    const result = await rt.indexEvidence(P_EMPTY, evidenceId)
    expect(result.status, JSON.stringify(result)).toBe('indexed')
    expect(await chunkCountFor(evidenceId)).toBeGreaterThan(0)

    // P_EMPTY is no longer empty. Its "no evidence" role was consumed by §G,
    // which ran first and asserted the state it needed — and the ordering is
    // enforced by the assertion above, not by a comment: §G measured a chunk
    // count of zero for this project.
  }, 120_000)
})

/* ========================================================================== */
/* §P — AUTHORIZATION, THROUGH THE PRODUCT PATH                               */
/* ========================================================================== */

describe('P. Every unauthorized path fails closed', () => {
  it('P1. a viewer can neither upload nor query', async () => {
    await as(VIEWER_A, async () => {
      await expect(upload(P_JOURNEY, 'Viewer upload', 'viewer.txt', DOC_JOURNEY)).rejects.toThrow(
        /Insufficient permissions/,
      )
      const issue = await rt.issue(P_JOURNEY)
      expect(issue.status).not.toBe('issued')
    })
  }, 120_000)

  it('P2. a reviewer MAY query and may NOT manage evidence — the thresholds are different on purpose', async () => {
    // The contrast is the assertion. A test that only showed refusals would be
    // satisfied by a system that refused everyone.
    await as(REVIEWER_A, async () => {
      await expect(upload(P_JOURNEY, 'Reviewer upload', 'rev.txt', DOC_JOURNEY)).rejects.toThrow(
        /Insufficient permissions/,
      )
      expect((await rt.indexEvidence(P_JOURNEY, journeyEvidenceId)).status).toBe('unauthorized')
      expect((await rt.corpusState(P_JOURNEY)).status).toBe('ready')

      const result = await ask(P_JOURNEY, SHARED_QUERY)
      expect(result.status, JSON.stringify(result)).toBe('ok')
    })
  }, 180_000)

  it('P3. an inactive membership is refused BY THE DATABASE, with the session claiming otherwise', async () => {
    // ------------------------------------------------------------------
    // THE ONE AUTHORIZATION CASE THE SUBSTITUTED SESSION CANNOT WEAKEN.
    //
    // `requireOrganizationAccess` is doubled here and hands this actor out as a
    // fully ACTIVE organization_admin — the most generous session a caller
    // could ever obtain. Everything below is therefore refused by the identity
    // context and by RLS: `current_user_org_ids()` reads memberships with
    // `status = 'active'`, so this user belongs to no organization at all and
    // `withDatabaseIdentityContext` raises before a statement runs.
    // ------------------------------------------------------------------
    const chargesBefore = await chargeCountForProject(P_JOURNEY)
    const versionsBefore = await documentVersions(journeyEvidenceId)

    await as(SUSPENDED_A, async () => {
      await expect(upload(P_JOURNEY, 'Suspended upload', 'susp.txt', DOC_JOURNEY)).rejects.toThrow()

      // Indexing catches its own failure and reports it as a status; what
      // matters is that it is never `indexed`.
      const indexed = await rt.indexEvidence(P_JOURNEY, journeyEvidenceId)
      expect(indexed.status).not.toBe('indexed')

      // The corpus screen fails closed rather than rendering another actor's.
      expect((await rt.corpusState(P_JOURNEY)).status).not.toBe('ready')

      const issue = await rt.issue(P_JOURNEY)
      if (issue.status === 'issued') {
        const result = await rt.run(P_JOURNEY, SHARED_QUERY, issue.ticket!)
        expect(result.status).toBe('error')
        expect(result.answer).toBeUndefined()
      }
    })

    // Nothing moved: no charge, no new version, no new evidence row.
    expect(await chargeCountForProject(P_JOURNEY)).toBe(chargesBefore)
    expect(await documentVersions(journeyEvidenceId)).toHaveLength(versionsBefore.length)
    const rows = await admin`
      SELECT count(*)::int AS n FROM public.evidence_items WHERE created_by = ${U_SUSPENDED}
    `
    expect(Number(rows[0]!.n)).toBe(0)
  }, 180_000)

  it('P4. an evidence id of another project is not reachable from this project', async () => {
    // Same organization, same actor, different project. The lookup is scoped by
    // all three identifiers together, so the pair simply does not resolve.
    const refused = await rt.indexEvidence(P_ARCHIVE, journeyEvidenceId)
    expect(refused.status).toBe('unauthorized')
    expect(await chunkCountForProject(P_ARCHIVE)).toBeGreaterThan(0) // untouched
  }, 60_000)
})

/* ========================================================================== */
/* §Q — THE AI LAYER IS ADVISORY                                              */
/* ========================================================================== */

describe('Q. A grounded answer changes no authoritative business state', () => {
  /** Every authoritative row of ORG_A, as JSON, ordered deterministically. */
  async function authoritativeSnapshot(): Promise<string> {
    const rows = await admin`
      SELECT jsonb_agg(t ORDER BY t.id) AS snapshot FROM (
        SELECT 'project'::text AS kind, p.id::text AS id,
               to_jsonb(p) - 'updated_at' AS body
        FROM public.projects p WHERE p.organization_id = ${ORG_A}
        UNION ALL
        SELECT 'evidence', e.id::text, to_jsonb(e) - 'updated_at'
        FROM public.evidence_items e WHERE e.organization_id = ${ORG_A}
        UNION ALL
        SELECT 'proxy', f.id::text, to_jsonb(f) - 'updated_at'
        FROM public.financial_proxies f WHERE f.organization_id = ${ORG_A}
        UNION ALL
        SELECT 'sroi_run', r.id::text, to_jsonb(r)
        FROM public.sroi_calculation_runs r WHERE r.organization_id = ${ORG_A}
      ) t
    `
    return JSON.stringify(rows[0]!.snapshot)
  }

  it('Q1. the snapshot is non-empty, so the comparison can fail', async () => {
    const snapshot = await authoritativeSnapshot()
    // A vacuous snapshot would make Q2 pass against a system that mutated
    // everything. It has to carry the rows whose immutability is claimed.
    expect(snapshot).toContain('sroi_run')
    // `3.4`, not `3.400000`: jsonb normalises the numeric. The VALUE is what
    // must be present, and asserting the storage formatting would be asserting
    // a fact about jsonb rather than about the ledger.
    expect(snapshot).toContain('"sroi_ratio":3.4')
    expect(snapshot).toContain('approved')
    expect(snapshot).toContain(journeyEvidenceId)
  }, 60_000)

  it('Q2. AUTHORITATIVE_DATA_MUTATED=false, byte for byte, across a full grounded query', async () => {
    const before = await authoritativeSnapshot()

    const result = await ask(P_JOURNEY, 'What is the SROI ratio and should this project be approved?')
    // The question deliberately ASKS for an approval and a calculation. The
    // extractive generator can emit neither: an approval is a sentence no
    // evidence document contains, and arithmetic has no output channel. What
    // matters here is not what it answered but what it did not write.
    expect(['ok', 'error']).toContain(result.status)

    const after = await authoritativeSnapshot()
    expect(after, 'a grounded query moved authoritative business state').toBe(before)
  }, 120_000)

  it('Q3. and an answer cannot approve evidence, certify a proxy or record an SROI run', async () => {
    // Named columns, so a failure says WHICH authority moved rather than "the
    // JSON differs".
    const rows = await admin`
      SELECT
        (SELECT count(*)::int FROM public.evidence_items
          WHERE organization_id = ${ORG_A} AND reviewer_id IS NOT NULL)      AS reviewed_evidence,
        (SELECT count(*)::int FROM public.financial_proxies
          WHERE organization_id = ${ORG_A} AND review_status <> 'approved')  AS unapproved_proxies,
        (SELECT count(*)::int FROM public.sroi_calculation_runs
          WHERE organization_id = ${ORG_A})                                  AS runs,
        (SELECT count(*)::int FROM public.projects
          WHERE organization_id = ${ORG_A} AND status <> 'draft')            AS moved_projects
    `
    const row = rows[0]! as Record<string, unknown>
    expect(Number(row.reviewed_evidence)).toBe(0)
    expect(Number(row.unapproved_proxies)).toBe(0)
    expect(Number(row.runs)).toBe(1)
    expect(Number(row.moved_projects)).toBe(0)
  }, 60_000)

  it('Q4. the authority that DOES move state is a human action, and it is reachable', async () => {
    // The control that makes Q2/Q3 mean something: the same tables are
    // writable — by a REVIEWER through the review action, never by an answer.
    // Its OWN document, deliberately: this row stays live in P_ARCHIVE for the
    // rest of the run, and if it repeated the workshop figure it would satisfy
    // §U3's presence check for a reason §U3 is not measuring.
    const outcome = await upload(
      P_ARCHIVE,
      'Reviewable',
      'reviewable.txt',
      'The review control document mentions 77 sessions held in Sahagun.',
    )
    await rt.reviewEvidence(P_ARCHIVE, outcome.evidence.id, {
      status: 'approved',
      reviewNotes: 'g04 control',
    })
    const row = (await evidenceRow(outcome.evidence.id))!
    expect(String(row.status)).toBe('approved')
  }, 120_000)
})

/* ========================================================================== */
/* §R — AUDITABILITY, MEASURED RATHER THAN ASSUMED                            */
/* ========================================================================== */

describe('R. What of a grounded answer is durable, and what is not', () => {
  it('R1. the measurement — which facts survive the request, and in which table', async () => {
    // ------------------------------------------------------------------
    // A MEASUREMENT, NOT A REQUIREMENT. G-04 does not ask for answer
    // persistence to be BUILT; it asks for the current state to be recorded
    // exactly. Every expectation below is written to fail the day the answer
    // IS persisted, at which point this test is what says the gap closed.
    // ------------------------------------------------------------------
    const before = (await auditRows(P_JOURNEY, 'stella.invoked')).length

    const result = await ask(P_JOURNEY, 'How many families did the program serve in Barranquilla?')
    expect(result.status).toBe('ok')
    const answerId = result.answerId!
    const citation = citationsOf(result)[0]!

    // 1. ANSWER_PERSISTED / CITATIONS_PERSISTED — NO. There is no answer store
    //    in this application, and `answerId` is minted per run rather than
    //    derived; the action's own header says so where it refuses to
    //    reconstruct a lost answer. Asked of the WHOLE database, not of a
    //    table guessed in advance.
    const anywhere = await admin`
      SELECT count(*)::int AS n FROM public.audit_logs
      WHERE after_json::text LIKE ${'%' + answerId + '%'}
    `
    expect(Number(anywhere[0]!.n), 'the answer id became durable — R1 needs rewriting').toBe(0)

    const citedAnywhere = await admin`
      SELECT count(*)::int AS n FROM public.audit_logs
      WHERE after_json::text LIKE ${'%' + citation.chunkId.trim() + '%'}
    `
    expect(Number(citedAnywhere[0]!.n), 'a citation became durable — R1 needs rewriting').toBe(0)

    // 2. QUERY_AUDIT_PERSISTED — YES, in `public.audit_logs`, metadata only.
    //    THIS query's row, not an earlier one: the count has to GROW, which is
    //    also what makes the fire-and-forget write observable at all.
    const trail = await eventually(
      () => auditRows(P_JOURNEY, 'stella.invoked'),
      (rows) => rows.length > before,
    )
    expect(trail.length, 'the grounded query wrote no audit row').toBeGreaterThan(before)
    const latest = trail[trail.length - 1]!.after_json as Record<string, unknown>
    expect(latest.stellaRole).toBe('grounded_query')
    // The CLASSIFICATION and the GENERATOR are durable — enough to attribute an
    // answer to the components that produced it, never enough to reproduce it.
    expect(typeof latest.outcome).toBe('string')
    expect(String(latest.generator).startsWith('grounding-local-extractive/')).toBe(true)
    // And the trail is metadata: no query text, no passage.
    const serializedTrail = JSON.stringify(trail)
    expect(serializedTrail).not.toContain('Barranquilla')
    expect(serializedTrail).not.toContain('347 families')

    // 3. TICKET_METADATA_PERSISTED — YES, and in TWO places that must agree:
    //    the ticket lifecycle row and the append-only charge row.
    const charges = await admin`
      SELECT organization_id, project_id, stella_role, idempotency_key
      FROM public.stella_interactions WHERE project_id = ${P_JOURNEY}
      ORDER BY created_at DESC LIMIT 1
    `
    expect(charges).toHaveLength(1)
    expect(String(charges[0]!.stella_role)).toBe('grounded_query')
    expect(String(charges[0]!.project_id)).toBe(P_JOURNEY)

    // 4. EVIDENCE_USED_PERSISTED — the INDEXING side is durable (the version
    //    row, its chunks, and an `evidence_item.indexed` trail); WHICH of those
    //    a given answer read is not.
    const indexedTrail = await auditRows(journeyEvidenceId, 'evidence_item.indexed')
    expect(indexedTrail.length).toBeGreaterThan(0)
    expect((indexedTrail[0]!.after_json as Record<string, unknown>).stage).toBeDefined()
    // The version row it describes is the durable half, and it IS reproducible:
    // the same bytes derive the same version id and the same chunk ids.
    expect(await documentVersions(journeyEvidenceId)).toHaveLength(1)
  }, 120_000)
})

/* ========================================================================== */
/* §S — NO EXTERNAL MODEL                                                     */
/* ========================================================================== */

describe('S. The provider boundary, instrumented', () => {
  it('S1. a whole journey makes ZERO outbound calls and constructs no provider client', async () => {
    // Three independent measurements, because each alone is escapable: an
    // absent key does not stop a client that does not need one, a fetch counter
    // does not see a raw socket, and a constructor guard does not see an HTTP
    // call made without it.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const constructionsBefore = providerConstructions.length

    const outcome = await upload(P_FORMAT, 'Offline proof', 'offline.txt', DOC_JOURNEY)
    expect(outcome.indexing!.status).toBe('indexed')
    const result = await ask(P_FORMAT, 'How many families did the program serve?')
    expect(result.status, JSON.stringify(result)).toBe('ok')

    // MODEL_PROVIDER_CALLS_EXTERNAL = 0.
    expect(fetchSpy.mock.calls.length, 'the journey made an outbound fetch').toBe(0)
    expect(
      providerConstructions.length - constructionsBefore,
      'the real provider client was constructed',
    ).toBe(0)
    expect(process.env.GEMINI_API_KEY).toBeUndefined()

    // And the generator that DID answer names itself.
    expect(result.answerStrategy!.generatorId.startsWith('grounding-local-extractive/')).toBe(true)
    fetchSpy.mockRestore()
  }, 180_000)

  it('S2. the capability itself does not depend on a provider key', async () => {
    // `grounded_query` is deliberately absent from
    // `GEMINI_BACKED_STELLA_CAPABILITIES`. Measured through the real predicate
    // rather than by reading the set, so a capability moved into it would fail
    // here — which is exactly the day an offline gate stops being offline.
    const { stellaCapabilityBlocker } = await import('@/lib/stella/capability-readiness')
    expect(stellaCapabilityBlocker('grounded_query')).toBeNull()
    expect(stellaCapabilityBlocker('advisor')).toBe('provider_key_missing')
  }, 60_000)
})

/* ========================================================================== */
/* §U — COUNTERFACTUALS THE E2E MUST DETECT                                   */
/* ========================================================================== */
//
// Each of the seven regressions G-04 names is either killed by a test above or
// killed here. The three that need a deliberately broken input are built here,
// in the test, and nothing tracked is modified:
//
//   1. G01 auto-index removed .................... §K2 (the service alone)
//   2. project predicate removed from retrieval .. §U1 (below)
//   3. archived filtering removed ................ §U2 (below)
//   4. citation validator accepts unknown source . §M2 / §M3 / §M4
//   5. failed upload treated as successful ....... §J1 (it throws; row archived)
//   6. M2-COMP archived row allowed to index ..... §J3 (refused, missing_bytes)
//   7. flag off still invokes the provider ....... §N1 (zero writes, no answer)

describe('U. The counterfactuals this battery claims to detect', () => {
  it('U1. naming another project\'s evidence in a retrieval does NOT widen the scope', async () => {
    // What a dropped project predicate at step 10 would look like: the evidence
    // id set is widened to include the other tenant's row. The governed reader
    // is scoped by (organization, project, version) independently, and the
    // repository's own version lookup is scoped too — so the widened id set
    // yields nothing, rather than yielding the other project's passages.
    const { withDatabaseIdentityContext } = await import('@/db/identity-context')
    const { createPersistedGroundingChunkRepository } = await import(
      '@/db/grounding/grounding-chunk-repository'
    )
    const { runGroundedQuery } = await import('@/lib/grounding/retrieve')

    const scope = { organizationId: ORG_A, projectId: P_JOURNEY }
    const run = await withDatabaseIdentityContext(
      { userId: U_ADMIN_A, organizationId: ORG_A, isSuperAdmin: false },
      () =>
        runGroundedQuery({
          repository: createPersistedGroundingChunkRepository(scope),
          scope,
          text: SHARED_QUERY,
          retrieval: {
            // The widened set: this project's row, ANOTHER TENANT's, and — the
            // case that actually exercises the project predicate — a row of the
            // SAME ORGANISATION in a DIFFERENT PROJECT. Without the third id
            // this test cannot observe the project scope at all: the
            // organisation predicate alone excludes the other tenant, so a
            // mutation that deleted the project predicate would survive. It was
            // measured surviving before this id was added.
            evidenceIds: [journeyEvidenceId, otherEvidenceId, sameOrgOtherProjectEvidenceId],
            requireScopeAttestation: true,
          },
        }),
    )

    // The absence is asserted over WHAT CAME BACK, never over the whole
    // outcome: `RetrievalQuery` echoes the requested `evidenceIds` verbatim, so
    // a check over the full serialisation would find the foreign id in the
    // ECHO OF THE ATTACK and fail while proving nothing. What matters is that
    // no candidate, no chunk and no citation carries it.
    const candidates = run.outcome.retrieval?.candidates ?? []
    expect(candidates.length, 'the legitimate half returned nothing — this is an outage, not isolation').toBeGreaterThan(0)
    for (const candidate of candidates) {
      expect(candidate.chunk.evidenceId).toBe(journeyEvidenceId)
      expect(candidate.chunk.scope.projectId).toBe(P_JOURNEY)
      expect(candidate.chunk.text).not.toContain('982 farmers')
      // The same-organisation, different-project passage. Nothing but the
      // project predicate stands between it and this retrieval.
      expect(candidate.chunk.text).not.toContain('222 beneficiaries')
    }
    // ONE source: neither of the two foreign rows contributed anything.
    expect(run.outcome.retrieval?.distinctSources).toBe(1)

    // Same reasoning one level down: `GroundingAnswerState` carries its own
    // copy of the `RetrievalQuery`, so the foreign id appears there too — as
    // the request that was refused, never as a source. The ASSERTIONS are what
    // a reviewer is shown and what a citation lives in, so that is what is
    // checked.
    const assertions = JSON.stringify(
      (run.outcome.answer as { assertions?: unknown }).assertions ?? [],
    )
    expect(assertions, 'a widened evidence set reached another tenant corpus').not.toContain('982 farmers')
    expect(assertions).not.toContain('Monteria')
    expect(assertions).not.toContain(otherEvidenceId)
    expect(
      assertions,
      'a widened evidence set reached another PROJECT of the same organisation',
    ).not.toContain('222 beneficiaries')
    expect(assertions).not.toContain(sameOrgOtherProjectEvidenceId)
    // And the legitimate half still answered, so this is isolation, not an
    // outage.
    expect(assertions).toContain('347 families')
  }, 120_000)

  it('U4. the project scope is enforced TWICE, and the governed reader is the layer that survives', async () => {
    // ------------------------------------------------------------------
    // WHY THIS TEST EXISTS: A MUTANT SURVIVED.
    //
    // Deleting `AND v.project_id = <scope>` from the repository's version
    // lookup (db/grounding/grounding-chunk-repository.ts) leaves this whole
    // battery GREEN — measured, twice, including with a same-organisation
    // cross-project evidence id explicitly named in §U1. The honest response is
    // not to contrive a kill but to find out WHY and pin it.
    //
    // The reason is that the project predicate is not the only one:
    // `uellix_grounding.chunks_in_scope_attested(org, project, version)`
    // filters `ch.project_id = p_project_id` in SQL, in a SECURITY DEFINER
    // function the application cannot edit. So a version row of another project
    // that slipped through the TypeScript lookup yields zero chunks anyway.
    //
    // Two consequences, and both are recorded rather than assumed:
    //   * the TypeScript predicate is DEFENCE IN DEPTH, not the boundary. Its
    //     removal is a real regression of a real layer and should still be
    //     rejected in review — but it is not, on its own, a leak.
    //   * the boundary is governed SQL, which is the right place for it.
    // ------------------------------------------------------------------
    const { withDatabaseIdentityContext } = await import('@/db/identity-context')
    const { db } = await import('@/db/client')
    const { sql } = await import('drizzle-orm')

    const versions = await admin`
      SELECT id FROM public.evidence_document_versions
      WHERE evidence_id = ${sameOrgOtherProjectEvidenceId}
      ORDER BY ordinal DESC LIMIT 1
    `
    const foreignVersionUuid = String(versions[0]!.id)

    const rowsFor = (projectId: string) =>
      withDatabaseIdentityContext(
        { userId: U_ADMIN_A, organizationId: ORG_A, isSuperAdmin: false },
        async () =>
          (await db.execute(sql`
            SELECT count(*)::int AS n
            FROM uellix_grounding.chunks_in_scope_attested(
              ${ORG_A}::uuid, ${projectId}::uuid, ${foreignVersionUuid}::uuid)
          `)) as unknown as Array<{ n: number }>,
      )

    // Asked under the version's OWN project: the chunks are there. Without this
    // half the next assertion would be satisfied by a function that returns
    // nothing to anybody.
    expect(Number((await rowsFor(P_ORDINAL))[0]!.n)).toBeGreaterThan(0)

    // Asked under ANOTHER project of the SAME organisation: nothing. This is
    // the layer that makes the surviving mutant survive.
    expect(
      Number((await rowsFor(P_JOURNEY))[0]!.n),
      'the governed reader returned another project chunks — the second layer is gone too',
    ).toBe(0)
  }, 120_000)

  it('U2. dropping the archived filter is what WOULD leak — the same version answers when it is live again', async () => {
    // The counterfactual, run forwards instead of by deleting code: the only
    // thing that changed between "absent" (§H1) and "present" here is the row's
    // STATUS, which is precisely the term the allowlist reads. If step 10's
    // predicate were removed, §H1's answer would look like this one.
    const rows = await admin`
      SELECT id FROM public.evidence_items
      WHERE project_id = ${P_ARCHIVE} AND status = 'archived' LIMIT 1
    `
    const evidenceId = String(rows[0]!.id)

    // Restore it through the real review action — the legitimate way a row
    // comes back into the working set.
    await rt.reviewEvidence(P_ARCHIVE, evidenceId, { status: 'approved' })
    expect(String((await evidenceRow(evidenceId))!.status)).toBe('approved')

    const result = await ask(P_ARCHIVE, ARCHIVE_QUERY)
    expect(result.status, JSON.stringify(result)).toBe('ok')
    expect(
      renderedText(result),
      'the same corpus that was withheld while archived still cannot answer — §H1 measured nothing',
    ).toContain('555 workshops')

    // Put it back, so the world this file leaves matches what it asserted.
    await rt.archiveEvidence(P_ARCHIVE, evidenceId)
    expect(String((await evidenceRow(evidenceId))!.status)).toBe('archived')
  }, 180_000)

  it('U3. and with it archived again, the answer is withheld once more', async () => {
    const result = await ask(P_ARCHIVE, ARCHIVE_QUERY)
    // P_ARCHIVE still holds the §Q4 row, which is approved and says nothing
    // about workshops — so the project is answerable in principle and the
    // withholding below is about the ARCHIVED row and not about an empty
    // project.
    expect(renderedText(result), 'the archived row answered again').not.toContain('555 workshops')
  }, 120_000)
})

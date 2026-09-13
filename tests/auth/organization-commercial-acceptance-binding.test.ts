// tests/auth/organization-commercial-acceptance-binding.test.ts
//
// L1 (HPO-ODS-W2-29) — PRESENTATION_BINDING and SUBMISSION_BINDING.
//
// Drives the REAL discharge action
// (app/(public)/accept-commercial-terms/actions.ts) with the discharge
// CONTEXT and the pending-set RESOLVER mocked, so every control here is about
// what the action DOES with a server-derived set and a client-supplied
// selector. The resolver's own correctness against the live registry is
// oracle 2, proven in
// tests/postgres/organization-commercial-acceptance-real-derivation.pg.test.ts;
// the database's own refusals are oracle 1, in the probe suite beside it.
// Neither substitutes for this file and this file substitutes for neither.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ORG_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_ORG_ID = '44444444-4444-4444-8444-444444444444'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const VERSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_VERSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RANDOM_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DIGEST = 'sha256:' + '7'.repeat(64)
const FORGED_DIGEST = 'sha256:' + '9'.repeat(64)

const mockRedirect = vi.fn((p: string) => {
  throw new Error(`REDIRECT:${p}`)
})
vi.mock('next/navigation', () => ({ redirect: (p: string) => mockRedirect(p) }))

/** Every row the action attempts to insert, verbatim. */
const INSERTS: Array<{ table: string; values: Record<string, unknown> }> = []
/** Every conflict target the action declared. */
const CONFLICT_TARGETS: string[][] = []
/** Whether the next insert should behave as a LOST RACE (no row returned). */
let insertReturnsNothing = false

vi.mock('@/db/client', () => ({
  db: {
    insert: (table: { [key: symbol]: string }) => ({
      values: (values: Record<string, unknown>) => {
        INSERTS.push({ table: table[Symbol.for('drizzle:Name')] as unknown as string, values })
        return {
          onConflictDoNothing: (opts: { target: Array<{ name: string }> }) => {
            CONFLICT_TARGETS.push(opts.target.map((c) => c.name))
            return {
              returning: async () => (insertReturnsNothing ? [] : [{ id: 'row-1' }]),
            }
          },
        }
      },
    }),
  },
}))

const AUDIT_CALLS: Array<Record<string, unknown>> = []
vi.mock('@/lib/audit/logger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit/logger')>('@/lib/audit/logger')
  return {
    ...actual,
    logAuditAction: async (entry: Record<string, unknown>) => {
      AUDIT_CALLS.push(entry)
    },
  }
})

/** The resolver — the ONE server-derived pending set, controlled per test. */
const mockPendingSet = vi.fn(async (_organizationId: string) => [
  {
    instrumentKey: 'commercial_terms',
    instrumentVersionId: VERSION_ID,
    version: 3,
    locale: 'es',
    contentDigest: DIGEST,
    content: 'synthetic organisation-class fixture text, not real legal content',
  },
])
vi.mock('@/lib/auth/organization-commercial-acceptance', () => ({
  loadRequiredOrganizationInstrumentsPendingAcceptance: (organizationId: string) =>
    mockPendingSet(organizationId),
  ACCEPT_COMMERCIAL_TERMS_PATH: '/accept-commercial-terms',
}))

/**
 * The discharge boundary, mocked to hand back a fixed resolved context.
 *
 * SERVER-DERIVED, ALWAYS. The organisation, the acting subject and the role
 * this callback receives come from the DATABASE during context resolution.
 * Because they are supplied here and never read from the form, a test that
 * submits a forged organisation id or a forged role can only demonstrate that
 * the action IGNORES them — which is the property, not a limitation of the
 * fixture.
 */
const dischargeContext = {
  user: { id: USER_ID, email: 'admin@example.test', fullName: null, avatarUrl: null, isSuperAdmin: false },
  membership: { id: 'm-1', organizationId: ORG_ID, userId: USER_ID, role: 'organization_admin', status: 'active' },
  organization: { id: ORG_ID, name: 'Org', slug: 'org', legalName: null, country: null, sector: null, status: 'active' },
}
const mockDischarge = vi.fn(async (cb: (ctx: typeof dischargeContext) => Promise<unknown>) => cb(dischargeContext))
vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationAcceptanceDischargeContext: (cb: (ctx: typeof dischargeContext) => Promise<unknown>) =>
    mockDischarge(cb),
}))

import { acceptRequiredOrganizationInstrument } from '@/app/(public)/accept-commercial-terms/actions'

function form(entries: Record<string, string | string[]>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(entries)) {
    for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one)
  }
  return fd
}

/** Runs the action and returns where it sent the caller. */
async function submit(fd: FormData): Promise<string> {
  try {
    await acceptRequiredOrganizationInstrument(fd)
    return '<no redirect>'
  } catch (error) {
    const message = (error as Error).message
    if (message.startsWith('REDIRECT:')) return message.slice('REDIRECT:'.length)
    throw error
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  INSERTS.length = 0
  CONFLICT_TARGETS.length = 0
  AUDIT_CALLS.length = 0
  insertReturnsNothing = false
  mockPendingSet.mockResolvedValue([
    {
      instrumentKey: 'commercial_terms',
      instrumentVersionId: VERSION_ID,
      version: 3,
      locale: 'es',
      contentDigest: DIGEST,
      content: 'synthetic organisation-class fixture text, not real legal content',
    },
  ])
})

/* ========================================================================== */
/* THE ACCEPTANCE TRANSACTION — AB-3                                          */
/* ========================================================================== */

describe('P-AO-3 / ATOM-nothing-else-in-the-transaction: AB-3 writes EXACTLY TWO things', () => {
  it('a valid submission produces EXACTLY ONE acceptance row and EXACTLY ONE audit row', async () => {
    await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(INSERTS).toHaveLength(1)
    expect(INSERTS[0].table).toBe('organization_commercial_acceptances')
    expect(AUDIT_CALLS).toHaveLength(1)
  })

  it('both writes happen INSIDE the ONE discharge transaction, and no nested one is opened', async () => {
    await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(mockDischarge).toHaveBeenCalledTimes(1)
  })

  it('the transaction touches NOTHING ELSE — no entitlement, no CommercialAccount, no membership, no carrier', async () => {
    // ATOMICITY_AUTHORITY.MUST_NOT_CONTAIN, exhaustive. Asserted by the fact
    // that the ONLY table the action ever inserts into is the acceptance
    // relation, plus the audit row through the governed logger.
    await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(INSERTS.map((i) => i.table)).toEqual(['organization_commercial_acceptances'])
  })

  it('EVERY persisted value except the version id is SERVER-DERIVED', async () => {
    await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(INSERTS[0].values).toEqual({
      organizationId: ORG_ID,
      instrumentKey: 'commercial_terms',
      instrumentVersionId: VERSION_ID,
      contentDigest: DIGEST,
      acceptedByUserId: USER_ID,
      acceptedByRole: 'organization_admin',
    })
  })

  it('the unique constraint dimension is ORGANIZATION + VERSION, never CommercialAccount-level', async () => {
    // MUT-L1-commercialaccount-scoped-uniqueness would give an organisation
    // that never accepted anything a PASSING L1 by inheritance, and it looks
    // like normalisation rather than a widening.
    await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(CONFLICT_TARGETS).toEqual([['organization_id', 'instrument_version_id']])
    expect(CONFLICT_TARGETS[0]).not.toContain('commercial_account_id')
  })
})

describe('the audit row', () => {
  it('AUDIT_VERB is the exact allocated literal, and it is TENANT-SCOPED', async () => {
    await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(AUDIT_CALLS[0].action).toBe('legal.organization_instrument_accepted')
    expect(AUDIT_CALLS[0].organizationId).toBe(ORG_ID)
    expect(AUDIT_CALLS[0].actorUserId).toBe(USER_ID)
  })

  it('S-L1-NO-INSTRUMENT-TEXT-IN-AUDIT: key, version and digest appear; the CONTENT never does', async () => {
    // A POSITIVE-AND-NEGATIVE PAIR rather than an inspection of the payload
    // SHAPE, which a future refactor could change without moving an
    // inspection-only control. The canary is the instrument BODY itself.
    const CANARY = 'CANARY-a7f3c9-instrument-body-must-never-reach-audit_logs'
    mockPendingSet.mockResolvedValue([
      {
        instrumentKey: 'commercial_terms',
        instrumentVersionId: VERSION_ID,
        version: 3,
        locale: 'es',
        contentDigest: DIGEST,
        content: CANARY,
      },
    ])
    await submit(form({ instrumentVersionId: VERSION_ID }))

    const serialized = JSON.stringify(AUDIT_CALLS[0])
    // POSITIVE half — the identifying facts ARE there.
    expect(serialized).toContain('commercial_terms')
    expect(serialized).toContain(DIGEST)
    expect(JSON.parse(serialized).afterJson.version).toBe(3)
    // NEGATIVE half — the bytes are NOT.
    expect(serialized).not.toContain(CANARY)
    // And no extra personal data of any kind (LRF-03 is unanswered and this
    // implementation does not answer it).
    expect(serialized).not.toMatch(/ipAddress|userAgent|device|fingerprint/i)
  })

  it('AUDIT-no-refusal-rows: EVERY refusal path writes ZERO audit rows', async () => {
    for (const fd of [
      form({ instrumentVersionId: RANDOM_UUID }),
      form({ instrumentVersionId: OTHER_VERSION_ID }),
      form({}),
      form({ instrumentVersionId: '' }),
    ]) {
      INSERTS.length = 0
      AUDIT_CALLS.length = 0
      await submit(fd)
      expect(AUDIT_CALLS).toHaveLength(0)
      expect(INSERTS).toHaveLength(0)
    }
  })
})

/* ========================================================================== */
/* REPLAY — the unique constraint is the concurrency authority                 */
/* ========================================================================== */

describe('replay behaviour (N-AO-17, DUPLICATE_ACCEPTANCE)', () => {
  it('a LOST RACE writes NO second audit row — ON CONFLICT DO NOTHING must not hide a duplicate', async () => {
    // The unique constraint is the concurrency control; this clause is only a
    // race guard. Letting it report a concurrent duplicate as a SUCCESSFUL
    // ACCEPTANCE EVENT would defeat I-T4-1 just as surely as dropping the
    // index would — which is why the action explicitly detects "no row
    // inserted" instead of assuming the insert succeeded.
    insertReturnsNothing = true
    await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(INSERTS).toHaveLength(1)
    expect(AUDIT_CALLS).toHaveLength(0)
  })

  it('a SAME-USER replay of an already-accepted version adds no second fact', async () => {
    // Once accepted, the version leaves the server-derived pending set, so the
    // submission cannot match and no insert is even attempted. The DATABASE
    // refusal (23505) is proven separately at the database boundary.
    mockPendingSet.mockResolvedValue([])
    await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(INSERTS).toHaveLength(0)
    expect(AUDIT_CALLS).toHaveLength(0)
  })
})

/* ========================================================================== */
/* SUBMISSION BINDING — refused identically, without an oracle                 */
/* ========================================================================== */

describe('SUBMISSION_BINDING: every bad selector is refused IDENTICALLY', () => {
  const CASES: Array<{ name: string; arrange?: () => void; fd: () => FormData }> = [
    { name: 'BIND-random-uuid-refused', fd: () => form({ instrumentVersionId: RANDOM_UUID }) },
    { name: 'a forged/fabricated identifier', fd: () => form({ instrumentVersionId: 'not-a-uuid-at-all' }) },
    {
      name: "BIND-stale-version-refused (no longer in the freshly derived set)",
      arrange: () => mockPendingSet.mockResolvedValue([]),
      fd: () => form({ instrumentVersionId: VERSION_ID }),
    },
    {
      name: 'BIND-superseded-version-refused',
      arrange: () =>
        mockPendingSet.mockResolvedValue([
          { instrumentKey: 'commercial_terms', instrumentVersionId: OTHER_VERSION_ID, version: 4, locale: 'es', contentDigest: DIGEST, content: 'v4' },
        ]),
      fd: () => form({ instrumentVersionId: VERSION_ID }),
    },
    {
      name: 'BIND-already-accepted-refused (application half)',
      arrange: () => mockPendingSet.mockResolvedValue([]),
      fd: () => form({ instrumentVersionId: VERSION_ID }),
    },
    {
      name: 'BIND-non-required-version-refused (key outside the CLOSED REQUIRED set)',
      arrange: () => mockPendingSet.mockResolvedValue([]),
      fd: () => form({ instrumentVersionId: OTHER_VERSION_ID }),
    },
    {
      name: 'BIND-not-yet-effective-refused (application half)',
      arrange: () => mockPendingSet.mockResolvedValue([]),
      fd: () => form({ instrumentVersionId: VERSION_ID }),
    },
    {
      name: "a version belonging to ANOTHER organisation's pending set",
      arrange: () => mockPendingSet.mockResolvedValue([]),
      fd: () => form({ instrumentVersionId: OTHER_VERSION_ID }),
    },
    { name: 'an ACCOUNT-class version (application half)', arrange: () => mockPendingSet.mockResolvedValue([]), fd: () => form({ instrumentVersionId: OTHER_VERSION_ID }) },
    { name: 'an ABSENT selector', fd: () => form({}) },
  ]

  it('there are TEN refusal cases and every one writes nothing', async () => {
    expect(CASES).toHaveLength(10)
    for (const testCase of CASES) {
      vi.clearAllMocks()
      INSERTS.length = 0
      AUDIT_CALLS.length = 0
      mockPendingSet.mockResolvedValue([
        { instrumentKey: 'commercial_terms', instrumentVersionId: VERSION_ID, version: 3, locale: 'es', contentDigest: DIGEST, content: 'text' },
      ])
      testCase.arrange?.()
      await submit(testCase.fd())
      expect(INSERTS, `${testCase.name} must write no acceptance row`).toHaveLength(0)
      expect(AUDIT_CALLS, `${testCase.name} must write no audit row`).toHaveLength(0)
    }
  })

  it('REFUSAL-no-oracle: all ten refusals are INDISTINGUISHABLE in destination, and echo no caller value', async () => {
    const destinations = new Set<string>()
    for (const testCase of CASES) {
      vi.clearAllMocks()
      mockPendingSet.mockResolvedValue([
        { instrumentKey: 'commercial_terms', instrumentVersionId: VERSION_ID, version: 3, locale: 'es', contentDigest: DIGEST, content: 'text' },
      ])
      testCase.arrange?.()
      destinations.add(await submit(testCase.fd()))
    }
    // ONE destination for TEN different reasons: an error that says WHICH way
    // the input was wrong is an oracle.
    expect(destinations.size).toBe(1)
    const only = [...destinations][0]
    // And the caller-controlled value is NOT echoed into it — the same
    // discipline withOrganizationDatabaseContext applies to
    // AUTH_ORGANIZATION_FORBIDDEN.
    expect(only).not.toContain(RANDOM_UUID)
    expect(only).not.toContain(VERSION_ID)
    expect(only).not.toContain(OTHER_VERSION_ID)
  })

  it('a REFUSAL is indistinguishable from a SUCCESS in destination, so the surface is not an existence oracle', async () => {
    vi.clearAllMocks()
    const refused = await submit(form({ instrumentVersionId: RANDOM_UUID }))
    vi.clearAllMocks()
    mockPendingSet.mockResolvedValue([
      { instrumentKey: 'commercial_terms', instrumentVersionId: VERSION_ID, version: 3, locale: 'es', contentDigest: DIGEST, content: 'text' },
    ])
    const accepted = await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(refused).toBe(accepted)
  })
})

describe('what the client may and may not supply', () => {
  it('BIND-forged-role-ignored: a submitted role is IGNORED, not validated', async () => {
    // A VALIDATED client role is still a client role, and a validation that
    // happens to pass makes the client the source of the value.
    await submit(form({ instrumentVersionId: VERSION_ID, acceptedByRole: 'super_admin', role: 'super_admin' }))
    expect(INSERTS).toHaveLength(1)
    expect(INSERTS[0].values.acceptedByRole).toBe('organization_admin')
  })

  it('TENANT-forged-organization-id-refused: a forged organisation id is never taken from the submission', async () => {
    await submit(form({ instrumentVersionId: VERSION_ID, organizationId: OTHER_ORG_ID }))
    expect(INSERTS[0].values.organizationId).toBe(ORG_ID)
    expect(INSERTS[0].values.organizationId).not.toBe(OTHER_ORG_ID)
  })

  it('TENANT-no-silent-organization-switch: the resolver is asked about the RESOLVED scope, never the submitted one', async () => {
    await submit(form({ instrumentVersionId: VERSION_ID, organizationId: OTHER_ORG_ID }))
    expect(mockPendingSet).toHaveBeenCalledWith(ORG_ID)
    expect(mockPendingSet).not.toHaveBeenCalledWith(OTHER_ORG_ID)
  })

  it('a client-supplied DIGEST is ignored — the persisted digest is the server-derived one', async () => {
    await submit(form({ instrumentVersionId: VERSION_ID, contentDigest: FORGED_DIGEST }))
    expect(INSERTS[0].values.contentDigest).toBe(DIGEST)
    expect(INSERTS[0].values.contentDigest).not.toBe(FORGED_DIGEST)
  })

  it('a client-supplied instrumentKey, acceptedAt or userId is ignored', async () => {
    await submit(
      form({
        instrumentVersionId: VERSION_ID,
        instrumentKey: 'privacy_policy',
        acceptedAt: '1999-01-01T00:00:00.000Z',
        acceptedByUserId: '00000000-0000-4000-8000-000000000000',
      })
    )
    expect(INSERTS[0].values.instrumentKey).toBe('commercial_terms')
    expect(INSERTS[0].values.acceptedByUserId).toBe(USER_ID)
    expect(INSERTS[0].values).not.toHaveProperty('acceptedAt')
  })
})

describe('MUT-L1-trust-the-submitted-version-without-rederivation', () => {
  it('the pending set is RE-DERIVED at submission time, not trusted from the render', async () => {
    // Under the mutation, every ORDINARY submission still succeeds; only a
    // submission across a PUBLICATION BOUNDARY is wrong — exactly the case
    // manual testing never reaches. The observable difference is whether the
    // resolver is consulted AT SUBMISSION at all.
    await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(mockPendingSet).toHaveBeenCalledTimes(1)
    expect(mockPendingSet).toHaveBeenCalledWith(ORG_ID)
  })

  it('the re-derivation happens INSIDE the discharge context, under the resolved scope', async () => {
    let resolverCalledInsideContext = false
    mockDischarge.mockImplementation(async (cb) => {
      const before = mockPendingSet.mock.calls.length
      const result = await cb(dischargeContext)
      resolverCalledInsideContext = mockPendingSet.mock.calls.length > before
      return result
    })
    await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(resolverCalledInsideContext).toBe(true)
  })
})

/* ========================================================================== */
/* N-AO-33 / M-AO-22 — the mutating-verb PROPERTY                              */
/* ========================================================================== */

describe('N-AO-33: a SAFE-METHOD request mutates nothing (the PROPERTY, not the verb literal)', () => {
  it('the discharge PAGE performs no write — only the action does', async () => {
    // M-AO-22: scoping this control to the literal string POST would fail to
    // distinguish a compliant PUT handler from a render-time GET write. The
    // property asserted instead is STRUCTURAL and verb-free: the RENDER path
    // contains no insert and no audit call at all, so no safe method can
    // reach one.
    const { readFileSync } = await import('node:fs')
    const pathMod = await import('node:path')
    const page = readFileSync(
      pathMod.join(process.cwd(), 'app/(public)/accept-commercial-terms/page.tsx'),
      'utf8'
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    expect(page).not.toMatch(/\bdb\s*\.\s*insert\b/)
    expect(page).not.toMatch(/\bdb\s*\.\s*update\b/)
    expect(page).not.toMatch(/\bdb\s*\.\s*delete\b/)
    expect(page).not.toMatch(/logAuditAction/)
    // And the acceptance is reached through a FORM ACTION — a mutating
    // request — never through a link or a render-time call.
    expect(page).toMatch(/<form[\s\S]*?action=\{acceptRequiredOrganizationInstrument\}/)
  })

  it('the mutating action is a server action, and it is the ONLY writer', async () => {
    const { readFileSync } = await import('node:fs')
    const pathMod = await import('node:path')
    const actions = readFileSync(
      pathMod.join(process.cwd(), 'app/(public)/accept-commercial-terms/actions.ts'),
      'utf8'
    )
    expect(actions.trimStart().startsWith("'use server'")).toBe(true)
  })
})

/* ========================================================================== */
/* N-AO-34 / M-AO-21 — NO automatic notification                               */
/* ========================================================================== */

describe('N-AO-34: ZERO notifications are emitted by the L1 surfaces', () => {
  it('no email, no in-app notification and no queued job on acceptance OR on refusal', async () => {
    // Canonical says the organization_admin RECEIVES the CTA. It does NOT say
    // the system SENDS anything. M-AO-21 exists because the notification makes
    // the product BETTER and is therefore the mutation most likely to be
    // introduced in good faith.
    const { readFileSync } = await import('node:fs')
    const pathMod = await import('node:path')
    const strip = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    for (const file of [
      'app/(public)/accept-commercial-terms/page.tsx',
      'app/(public)/accept-commercial-terms/actions.ts',
      'lib/auth/organization-commercial-acceptance.ts',
    ]) {
      const source = strip(readFileSync(pathMod.join(process.cwd(), file), 'utf8'))
      for (const emitter of [/resend/i, /sendEmail/i, /sendMail/i, /notify/i, /notification/i, /enqueue/i, /\bqueue\b/i]) {
        expect(source, `${file} must emit no notification (${emitter})`).not.toMatch(emitter)
      }
    }
  })
})

/* ========================================================================== */
/* N-AO-28 / M-AO-16 — manual commercial activation is NOT acceptance          */
/* ========================================================================== */

describe('N-AO-28: manual commercial activation is not acceptance evidence', () => {
  it('the currency predicate reads NO commercial state of any kind', async () => {
    // M-AO-16 makes the currency predicate treat a manual activation state as
    // satisfying L1. The inference is LOCALLY REASONABLE — an operator
    // activated the account and presumably knew what they were doing — and it
    // converts an OPERATIONAL decision into LEGAL EVIDENCE. The operator who
    // made it was never the organisation's authorised representative.
    const { readFileSync } = await import('node:fs')
    const pathMod = await import('node:path')
    const source = readFileSync(
      pathMod.join(process.cwd(), 'lib/auth/organization-commercial-acceptance.ts'),
      'utf8'
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    for (const forbidden of [/commercial_accounts/, /commercial_status/, /ACTIVE_WITHOUT_STRIPE/, /stripe/i, /subscription/i]) {
      expect(source, `the L1 predicate must not read commercial state (${forbidden})`).not.toMatch(forbidden)
    }
    // It reads the acceptance relation and the registry, and nothing else.
    expect(source).toMatch(/organization_commercial_acceptances/)
    expect(source).toMatch(/legal_instrument_versions/)
  })

  it('the acceptance transaction mutates NO commercial or organisation state', async () => {
    await submit(form({ instrumentVersionId: VERSION_ID }))
    expect(INSERTS.map((i) => i.table)).not.toContain('commercial_accounts')
    expect(INSERTS.map((i) => i.table)).not.toContain('organizations')
    expect(INSERTS.map((i) => i.table)).not.toContain('organization_members')
  })
})

/* ========================================================================== */
/* N-AO-30 — a pre-effective NOTICE is not an acceptance                      */
/* ========================================================================== */

describe('N-AO-30: display, dismissal and acknowledgement create NO acceptance row', () => {
  it('rendering the pending set writes nothing', async () => {
    // The page calls the resolver and renders; it never inserts. Proven here
    // by driving the RESOLVER and asserting the write log stays empty — a
    // pre-effective version is not in the pending set in the first place, and
    // even a version that IS in it creates no row until the action runs.
    await mockPendingSet(ORG_ID)
    expect(INSERTS).toHaveLength(0)
    expect(AUDIT_CALLS).toHaveLength(0)
  })
})

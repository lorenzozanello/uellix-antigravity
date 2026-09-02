// app/actions/stella/__tests__/decisions.test.ts
// WS3b U4: recordStellaDecision — dormant-by-default persistence of human
// decisions over Stella suggestions. No real DB/auth; db.execute is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import type { OrganizationContext } from '@/lib/auth/session'

// ---------------------------------------------------------------------------
// Mocks — top level so vitest hoists them before imports
// ---------------------------------------------------------------------------

const mockStellaConfig = {
  isDecisionsPersistenceEnabled: true,
}
vi.mock('@/lib/stella/config', () => ({
  get stellaConfig() { return mockStellaConfig },
  get stellaState() { return { canUseStella: true, missingApiKey: false } },
}))

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
  runWithOrganizationAccess: async (cb: (ctx: unknown) => unknown) =>
    cb(await mockRequireOrganizationAccess()),
}))

// The identity-context wrappers are pass-throughs HERE, and only here: this
// suite is about the action's own feature-flag, role, quota and audit guards.
// The wrappers themselves — nesting, organisation validation, rollback, pool
// isolation — are proved against a live database in
// tests/authenticated-database-context.test.ts.
vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationDatabaseContext: async (cb: (ctx: unknown) => unknown) =>
    cb(await mockRequireOrganizationAccess()),
}))

const mockDbExecute = vi.fn()
vi.mock('@/db/client', () => ({
  db: {
    execute: (...args: unknown[]) => mockDbExecute(...args),
  },
}))

const mockLogAuditAction = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/audit/logger')>()
  return {
    ...original,
    logAuditAction: (...args: unknown[]) => mockLogAuditAction(...args),
  }
})

// canUseStella runs for REAL (pure function) so the role set stays pinned.

import { recordStellaDecision } from '../decisions'
import { StellaDecisionInputSchema } from '../decisions-schema'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const PROJECT_ID = '33333333-3333-4333-8333-333333333333'
const INTERACTION_ID = '44444444-4444-4444-8444-444444444444'
const DECISION_ID = '55555555-5555-4555-8555-555555555555'

const MOCK_ORG_CONTEXT: OrganizationContext = {
  user: { id: USER_ID, email: 'test@org.com', fullName: 'Test User', avatarUrl: null, isSuperAdmin: false },
  membership: { id: 'mem-1', organizationId: ORG_ID, userId: USER_ID, role: 'impact_manager', status: 'active' },
  organization: { id: ORG_ID, name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
}

const VALID_INPUT = {
  projectId: PROJECT_ID,
  suggestionKey: 'advisor.suggested_next_actions[2]',
  decision: 'accepted_edited' as const,
  interactionId: INTERACTION_ID,
  editedText: 'Texto final aplicado por el usuario.',
  previousValue: 'Texto anterior CONFIDENCIAL que la sugerencia reemplazó.',
}

/** Serialize a drizzle sql`` template call (chunks + params) for inspection. */
function serializeExecuteCalls(): string {
  return JSON.stringify(
    mockDbExecute.mock.calls.map((call) => {
      const q = call[0] as { queryChunks?: unknown }
      return q?.queryChunks ?? q
    }),
  )
}

function setupHappyPath() {
  mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
  // 1st execute: project-ownership SELECT → one row
  // 2nd execute: interaction-ownership SELECT → one row (VALID_INPUT carries interactionId)
  // 3rd execute: INSERT ... RETURNING id
  mockDbExecute
    .mockResolvedValueOnce([{ '?column?': 1 }])
    .mockResolvedValueOnce([{ '?column?': 1 }])
    .mockResolvedValueOnce([{ id: DECISION_ID }])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recordStellaDecision server action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStellaConfig.isDecisionsPersistenceEnabled = true
    mockLogAuditAction.mockResolvedValue(undefined)
    mockDbExecute.mockReset()
  })

  describe('Dormant flag gate (pre-G2)', () => {
    it('returns DISABLED without touching the database when the flag is off (the default)', async () => {
      mockStellaConfig.isDecisionsPersistenceEnabled = false

      const result = await recordStellaDecision(VALID_INPUT)

      expect(result).toEqual({ ok: false, error: 'DISABLED', message: 'Stella decision persistence is not enabled.' })
      expect(mockDbExecute).not.toHaveBeenCalled()
      expect(mockRequireOrganizationAccess).not.toHaveBeenCalled()
      expect(mockLogAuditAction).not.toHaveBeenCalled()
    })
  })

  describe('Input validation', () => {
    it('rejects malformed input with INVALID_INPUT before auth or DB', async () => {
      const result = await recordStellaDecision({
        ...VALID_INPUT,
        decision: 'certified' as never, // not in the 4-value enum
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('INVALID_INPUT')
      expect(mockRequireOrganizationAccess).not.toHaveBeenCalled()
      expect(mockDbExecute).not.toHaveBeenCalled()
    })

    it('rejects unknown extra keys (strict schema)', async () => {
      const result = await recordStellaDecision({
        ...VALID_INPUT,
        organizationId: 'attacker-org', // never client-suppliable
      } as never)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('INVALID_INPUT')
    })

    it('exports the schema for UI-side wiring and it accepts the valid fixture', () => {
      expect(StellaDecisionInputSchema.safeParse(VALID_INPUT).success).toBe(true)
    })
  })

  describe('Auth + role gate', () => {
    it('returns UNAUTHORIZED when requireOrganizationAccess throws', async () => {
      mockRequireOrganizationAccess.mockRejectedValue(new Error('no session'))

      const result = await recordStellaDecision(VALID_INPUT)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
      expect(mockDbExecute).not.toHaveBeenCalled()
    })

    it('denies viewers without touching the database', async () => {
      mockRequireOrganizationAccess.mockResolvedValue({
        ...MOCK_ORG_CONTEXT,
        membership: { ...MOCK_ORG_CONTEXT.membership, role: 'viewer' },
      })

      const result = await recordStellaDecision(VALID_INPUT)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
      expect(mockDbExecute).not.toHaveBeenCalled()
    })

    it('returns UNAUTHORIZED when the project does not belong to the session org', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockDbExecute.mockResolvedValueOnce([]) // ownership SELECT finds nothing

      const result = await recordStellaDecision(VALID_INPUT)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
      expect(mockDbExecute).toHaveBeenCalledTimes(1) // no INSERT happened
    })

    it('rejects a cross-org interactionId IDENTICALLY to a nonexistent one (no existence oracle)', async () => {
      // Case A: interactionId exists but belongs to another org/project — the
      // scoped ownership SELECT finds nothing.
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockDbExecute
        .mockResolvedValueOnce([{ '?column?': 1 }]) // project ownership ok
        .mockResolvedValueOnce([]) // interaction not visible to this org
      const crossOrg = await recordStellaDecision(VALID_INPUT)

      expect(crossOrg.ok).toBe(false)
      if (!crossOrg.ok) expect(crossOrg.error).toBe('INVALID_INPUT')
      expect(mockDbExecute).toHaveBeenCalledTimes(2) // no INSERT happened

      // Case B: interactionId does not exist at all — same DB result shape.
      mockDbExecute.mockReset()
      mockDbExecute
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockResolvedValueOnce([])
      const nonexistent = await recordStellaDecision(VALID_INPUT)

      // Indistinguishable: same code AND same message as schema validation.
      expect(nonexistent).toEqual(crossOrg)
      const malformed = await recordStellaDecision({ ...VALID_INPUT, decision: 'certified' as never })
      expect(malformed).toEqual(crossOrg)
    })

    it('verifies interactionId scoped to the session org AND the given project', async () => {
      setupHappyPath()

      await recordStellaDecision(VALID_INPUT)

      const ownershipQuery = mockDbExecute.mock.calls[1][0] as { queryChunks: unknown[] }
      const serialized = JSON.stringify(ownershipQuery.queryChunks)
      expect(serialized).toContain('stella_interactions')
      expect(serialized).toContain(INTERACTION_ID)
      expect(serialized).toContain(ORG_ID)
      expect(serialized).toContain(PROJECT_ID)
    })

    it('skips the interaction-ownership query when no interactionId is provided', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockDbExecute
        .mockResolvedValueOnce([{ '?column?': 1 }]) // project ownership
        .mockResolvedValueOnce([{ id: DECISION_ID }]) // insert

      const result = await recordStellaDecision({
        projectId: PROJECT_ID,
        suggestionKey: 'advisor.suggested_next_actions[0]',
        decision: 'accepted',
      })

      expect(result.ok).toBe(true)
      expect(mockDbExecute).toHaveBeenCalledTimes(2)
    })
  })

  describe('Happy path (flag on, post-G2)', () => {
    it('inserts and returns the new decision id', async () => {
      setupHappyPath()

      const result = await recordStellaDecision(VALID_INPUT)

      expect(result).toEqual({ ok: true, data: { id: DECISION_ID } })
      expect(mockDbExecute).toHaveBeenCalledTimes(3) // project check, interaction check, insert
    })

    it('binds organization_id and decided_by from the SESSION, never from input', async () => {
      setupHappyPath()

      await recordStellaDecision(VALID_INPUT)

      const insertQuery = mockDbExecute.mock.calls[2][0] as { queryChunks: unknown[] }
      const serialized = JSON.stringify(insertQuery.queryChunks)
      expect(serialized).toContain(ORG_ID)
      expect(serialized).toContain(USER_ID)
      // and the query targets the prepared table with the full column list
      expect(serialized).toContain('stella_suggestion_decisions')
      expect(serialized).toContain('previous_value_hash')
      expect(serialized).toContain('decided_by')
    })

    it('logs STELLA_DECISION_RECORDED with metadata only', async () => {
      setupHappyPath()

      await recordStellaDecision(VALID_INPUT)

      expect(mockLogAuditAction).toHaveBeenCalledTimes(1)
      const entry = mockLogAuditAction.mock.calls[0][0]
      expect(entry.action).toBe('stella.decision_recorded')
      expect(entry.organizationId).toBe(ORG_ID)
      expect(entry.actorUserId).toBe(USER_ID)
      expect(entry.afterJson.decision).toBe('accepted_edited')
      expect(entry.afterJson.hasPreviousValueHash).toBe(true)
      // no raw text in the audit payload
      const serialized = JSON.stringify(mockLogAuditAction.mock.calls)
      expect(serialized).not.toContain('CONFIDENCIAL')
      expect(serialized).not.toContain(VALID_INPUT.editedText)
    })

    it('result is unchanged when the audit write throws (fire-and-forget)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      setupHappyPath()
      mockLogAuditAction.mockRejectedValue(new Error('audit db down'))

      const result = await recordStellaDecision(VALID_INPUT)

      expect(result.ok).toBe(true)
      expect(errorSpy).toHaveBeenCalledWith('[stella-audit] audit write failed:', 'Error')
      errorSpy.mockRestore()
    })
  })

  describe('Hash-not-content invariant', () => {
    it('persists the sha256 hex of previousValue — never the raw text', async () => {
      setupHappyPath()

      await recordStellaDecision(VALID_INPUT)

      const expectedHash = createHash('sha256').update(VALID_INPUT.previousValue, 'utf8').digest('hex')
      const serialized = serializeExecuteCalls()
      expect(serialized).toContain(expectedHash)
      expect(serialized).not.toContain('CONFIDENCIAL')
      expect(serialized).not.toContain(VALID_INPUT.previousValue)
    })

    it('applied_text (editedText) IS persisted as provided', async () => {
      setupHappyPath()

      await recordStellaDecision(VALID_INPUT)

      expect(serializeExecuteCalls()).toContain(VALID_INPUT.editedText)
    })

    it('stores a null hash when no previousValue is given', async () => {
      setupHappyPath()

      const result = await recordStellaDecision({
        projectId: PROJECT_ID,
        suggestionKey: 'advisor.suggested_next_actions[0]',
        decision: 'rejected',
        rejectionReason: 'No aplica al contexto.',
      })

      expect(result.ok).toBe(true)
      const entry = mockLogAuditAction.mock.calls[0][0]
      expect(entry.afterJson.hasPreviousValueHash).toBe(false)
    })
  })

  describe('DB failure', () => {
    it('returns DB_ERROR without leaking the error message', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockDbExecute
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockRejectedValueOnce(new Error('relation "stella_suggestion_decisions" does not exist'))

      const result = await recordStellaDecision(VALID_INPUT)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('DB_ERROR')
        expect(result.message).not.toContain('stella_suggestion_decisions')
      }
      errorSpy.mockRestore()
    })
  })
})

// app/actions/stella/__tests__/legacy-advisor-disposition.test.ts
//
// G1-B PRECONDITIONS — P0: TWO ADVISOR SURFACES, ONE FLAG.
//
// ---------------------------------------------------------------------------
// THE FINDING
// ---------------------------------------------------------------------------
// `getStellaContextualAdvisor` and `getStellaAdvisor` are two advisor surfaces
// with materially different governance, and until this change BOTH were opened
// by the SAME environment variable, `STELLA_ADVISOR_ENABLED`:
//
//                          contextual                legacy (step)
//   provider JSON schema    responseJsonSchema        none
//   Zod contract            .strict(), literal        open object, free strings
//   human review            requiresHumanReview:true  absent
//   citations               sourceFields, validated   absent
//   per-step slicing        yes (R3 catalog)          no
//
// So switching Stella's advisor on in Preview switched on a surface whose
// output carries no citation contract and no human-review flag. That is not a
// hypothetical: `StellaAdvisorPanel` was mounted on all seven pipeline pages,
// directly above the contextual panel, under the comment "DP-03 (pending
// product decision)".
//
// ---------------------------------------------------------------------------
// THE DISPOSITION
// ---------------------------------------------------------------------------
// RETIRE THE SURFACE, QUARANTINE THE CODE.
//
//   * The legacy panel is unmounted from every pipeline page and its component
//     is deleted. Redundancy was proved before removal: every one of the seven
//     pages already mounted the contextual advisor for the same step, and the
//     contextual advisor covers all seven steps (`advisorPipelineSteps`).
//   * `getStellaAdvisor` gains its OWN flag, `STELLA_LEGACY_ADVISOR_ENABLED`,
//     default false. It is not deleted outright because it is the advisor
//     category's representative in the governed multi-category quota harness
//     (tests/e2e/stella-multicategory-quota.e2e.test.ts), and rewriting a
//     certification harness during a precondition change is how preconditions
//     stop being preconditions. Full deletion is POST_G1_B_BACKLOG.
//
// This suite pins the acceptance criterion literally: with the PRODUCTION flag
// on and nothing else, the weak surface is unreachable.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { OrganizationContext } from '@/lib/auth/session'

const ROOT = process.cwd()

const mockStellaConfig = {
  isEnabled: true,
  isAdvisorEnabled: true,
  isLegacyAdvisorEnabled: false,
  geminiApiKey: 'test-key',
  geminiModel: 'gemini-3.6-flash',
  requestTimeoutMs: 15000,
  rateLimitPerHour: 100,
}
const mockStellaState = { canUseStella: true, missingApiKey: false }

vi.mock('@/lib/stella/config', () => ({
  get stellaConfig() { return mockStellaConfig },
  get stellaState() { return mockStellaState },
}))

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
  runWithOrganizationAccess: async (cb: (ctx: unknown) => unknown) =>
    cb(await mockRequireOrganizationAccess()),
}))
vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationDatabaseContext: async (cb: (ctx: unknown) => unknown) =>
    cb(await mockRequireOrganizationAccess()),
}))

const mockBuildAdvisorContext = vi.fn()
vi.mock('@/lib/stella/context/build-advisor-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/stella/context/build-advisor-context')>()
  return { ...original, buildAdvisorContext: (...a: unknown[]) => mockBuildAdvisorContext(...a) }
})

const mockAdapterGenerate = vi.fn()
vi.mock('@/lib/stella/adapter/gemini-client', () => ({
  getGeminiAdapter: () => ({
    generate: (...a: unknown[]) => mockAdapterGenerate(...a),
    parseResponse: vi.fn(),
    isReady: () => true,
  }),
}))

vi.mock('@/lib/stella/rate-limit', () => ({
  consumeStellaRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, reason: 'allowed' }),
}))
vi.mock('@/lib/stella/quota', () => ({
  nextQuotaResetIso: () => '2026-09-01T00:00:00.000Z',
  formatQuotaResetDate: () => '1 de septiembre de 2026',
}))
vi.mock('@/db/client', () => ({ db: { insert: vi.fn(), select: vi.fn() } }))
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...original, logAuditAction: vi.fn().mockResolvedValue(undefined) }
})
vi.mock('@/lib/stella/observability', () => ({ reportStellaFailure: vi.fn() }))

const mockBindOperationTicket = vi.fn()
const mockIssueOperationTicket = vi.fn()
const mockInspectOperationTicket = vi.fn()
vi.mock('@/db/stella/operation-tickets', () => ({
  bindOperationTicket: (...a: unknown[]) => mockBindOperationTicket(...a),
  completeStellaInteractionTicket: vi.fn(),
  abortOperationTicket: vi.fn().mockResolvedValue({ kind: 'aborted' }),
  inspectOperationTicket: (...a: unknown[]) => mockInspectOperationTicket(...a),
  issueOperationTicket: (...a: unknown[]) => mockIssueOperationTicket(...a),
}))

import { getStellaAdvisor, getStellaContextualAdvisor, issueStellaAdvisorTicket } from '../advisor'

const TICKET = 'a'.repeat(64)

const CTX = {
  user: { id: 'user-1' },
  organization: { id: 'org-1' },
  membership: { role: 'analyst' },
} as unknown as OrganizationContext

describe('the contextual flag can never open the legacy surface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStellaConfig.isEnabled = true
    mockStellaConfig.isAdvisorEnabled = true
    mockStellaConfig.isLegacyAdvisorEnabled = false
    mockStellaState.canUseStella = true
    mockRequireOrganizationAccess.mockResolvedValue(CTX)
    mockBindOperationTicket.mockResolvedValue({ kind: 'bound', used: 0, quota: 50 })
    mockInspectOperationTicket.mockResolvedValue({
      status: 'bound', category: 'advisor', expiresAt: '2026-08-17T00:15:00.000Z', hasQueryHash: true,
    })
    mockIssueOperationTicket.mockResolvedValue({ kind: 'issued', ticketId: TICKET })
  })

  it('refuses the legacy step advisor while STELLA_ADVISOR_ENABLED alone is on', async () => {
    const result = await getStellaAdvisor('proj-1', 'narrative', TICKET)
    expect(result).toEqual({ ok: false, error: 'DISABLED', message: expect.any(String) })
  })

  it('never authenticates, never binds and never calls the provider on that refusal', async () => {
    await getStellaAdvisor('proj-1', 'narrative', TICKET)
    expect(mockRequireOrganizationAccess).not.toHaveBeenCalled()
    expect(mockBindOperationTicket).not.toHaveBeenCalled()
    expect(mockAdapterGenerate).not.toHaveBeenCalled()
  })

  it('leaves the contextual advisor reachable under the same flags', async () => {
    // Proved by how far it gets: it authenticates and binds, which the legacy
    // path above never does. (The run itself is covered end to end in
    // contextual-advisor.test.ts; this assertion is only about the gate.)
    mockBuildAdvisorContext.mockRejectedValue(new Error('stop after bind'))
    const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)
    expect(result).not.toMatchObject({ error: 'DISABLED' })
    expect(mockRequireOrganizationAccess).toHaveBeenCalled()
    expect(mockBindOperationTicket).toHaveBeenCalled()
  })

  it('still mints advisor tickets for the contextual panel', async () => {
    await expect(issueStellaAdvisorTicket('proj-1')).resolves.toEqual({
      status: 'issued',
      ticket: TICKET,
    })
  })

  it('opens the legacy path only when its own flag is explicitly on', async () => {
    mockStellaConfig.isLegacyAdvisorEnabled = true
    mockBuildAdvisorContext.mockRejectedValue(new Error('stop after bind'))
    const result = await getStellaAdvisor('proj-1', 'narrative', TICKET)
    expect(result).not.toMatchObject({ error: 'DISABLED' })
    expect(mockBindOperationTicket).toHaveBeenCalled()
  })
})

describe('the legacy advisor is no longer a product surface', () => {
  const PIPELINE_DIR = path.join(ROOT, 'app/app/projects/[projectId]/pipeline')

  function pipelineSources(): Array<[string, string]> {
    const out: Array<[string, string]> = []
    for (const entry of readdirSync(PIPELINE_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const page = path.join(PIPELINE_DIR, entry.name, 'page.tsx')
      if (existsSync(page)) out.push([entry.name, readFileSync(page, 'utf8')])
    }
    return out
  }

  it('finds the seven pipeline pages (the scan is not vacuous)', () => {
    expect(pipelineSources().length).toBeGreaterThanOrEqual(7)
  })

  it('mounts StellaAdvisorPanel on no pipeline page', () => {
    const offenders = pipelineSources()
      .filter(([, source]) => source.includes('StellaAdvisorPanel'))
      .map(([name]) => name)
    expect(offenders).toEqual([])
  })

  it('still mounts a contextual advisor on every pipeline page', () => {
    const missing = pipelineSources()
      .filter(([, source]) =>
        !source.includes('StellaContextualAdvisorPanel') && !source.includes('StellaContextualAdvisorField'))
      .map(([name]) => name)
    expect(missing).toEqual([])
  })

  it('exports no StellaAdvisorPanel from the stella component barrel', () => {
    const barrel = readFileSync(path.join(ROOT, 'components/stella/index.ts'), 'utf8')
    expect(barrel).not.toMatch(/export\s*\{[^}]*\bStellaAdvisorPanel\b/)
  })

  it('has deleted the legacy panel component', () => {
    expect(existsSync(path.join(ROOT, 'components/stella/StellaAdvisorPanel.tsx'))).toBe(false)
  })
})

describe('the legacy flag defaults to off in the real config', () => {
  it('reads STELLA_LEGACY_ADVISOR_ENABLED and nothing else', async () => {
    const source = readFileSync(path.join(ROOT, 'lib/stella/config.ts'), 'utf8')
    expect(source).toMatch(
      /isLegacyAdvisorEnabled:\s*process\.env\.STELLA_LEGACY_ADVISOR_ENABLED\s*===\s*'true'/
    )
  })
})

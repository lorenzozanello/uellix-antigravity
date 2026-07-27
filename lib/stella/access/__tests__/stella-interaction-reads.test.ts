// lib/stella/access/__tests__/stella-interaction-reads.test.ts
// Etapa A2.2 (STL-A22-006) — no real DB, no real auth. La cobertura de la
// forma EXACTA de la condición SQL (alcance por rol, aislamiento cross-org)
// se prueba contra Supabase local en
// tests/integration/stella-interactions-access-rls.test.ts; estas pruebas
// verifican el comportamiento observable del servicio (qué decide, qué
// campos expone, que el actor nunca viene del cliente).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrganizationContext } from '@/lib/auth/session'

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

function makeSelectChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}

const mockSelect = vi.fn()
vi.mock('@/db/client', () => ({
  db: { select: (...args: unknown[]) => mockSelect(...args) },
}))

import { listAuthorizedStellaInteractions, getAuthorizedStellaInteraction } from '../stella-interaction-reads'

function makeCtx(role: string, organizationId = 'org-1', userId = 'user-1'): OrganizationContext {
  return {
    user: { id: userId, email: 't@example.com', fullName: 'T', avatarUrl: null, isSuperAdmin: role === 'super_admin' },
    membership: { id: 'mem-1', organizationId, userId, role: role as never, status: 'active' },
    organization: { id: organizationId, name: 'Org', slug: 'org', legalName: null, country: null, sector: null, status: 'active' } as never,
  }
}

const FULL_ROW = {
  id: 'int-1',
  organizationId: 'org-1',
  projectId: 'proj-1',
  createdBy: 'user-creator',
  stellaRole: 'advisor',
  pipelineStep: 'narrative',
  contextHash: 'a'.repeat(64),
  responseJson: { summary: 'secret model output' },
  modelUsed: 'gemini-2.5-flash',
  tokensUsed: 42,
  riskLevel: 'low',
  riskFlags: ['evidence_gap'],
  promptTemplateId: 'stella.advisor.system',
  promptVersion: 1,
  promptContentHash: 'b'.repeat(64),
  contextSchemaVersion: 1,
  contextManifest: { role: 'advisor' },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  responsePurgedAt: null,
}

describe('listAuthorizedStellaInteractions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("resuelve el actor desde la sesión, nunca acepta organizationId/rol como parámetro (la firma de la función no los admite)", async () => {
    expect(listAuthorizedStellaInteractions.length).toBe(0)
  })

  it('devuelve solo campos de la vista resumida (nunca response_json/context_manifest/risk_flags)', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    const summaryRow = {
      id: 'int-1',
      stellaRole: 'advisor',
      pipelineStep: 'narrative',
      projectId: 'proj-1',
      createdBy: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      riskLevel: 'low',
      modelUsed: 'gemini-2.5-flash',
    }
    mockSelect.mockReturnValueOnce(makeSelectChain([summaryRow]))

    const { items } = await listAuthorizedStellaInteractions()

    expect(items).toEqual([summaryRow])
    expect(items[0]).not.toHaveProperty('responseJson')
    expect(items[0]).not.toHaveProperty('contextManifest')
    expect(items[0]).not.toHaveProperty('riskFlags')
  })

  it('limita el resultado a un máximo de 100', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    const chain = makeSelectChain([])
    mockSelect.mockReturnValueOnce(chain)

    await listAuthorizedStellaInteractions({ limit: 500 })

    expect(chain.limit).toHaveBeenCalledWith(100)
  })
})

describe('getAuthorizedStellaInteraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('devuelve NOT_FOUND cuando la fila no existe', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockSelect.mockReturnValueOnce(makeSelectChain([]))

    const result = await getAuthorizedStellaInteraction('does-not-exist')
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('devuelve NOT_FOUND (nunca un error distinto) cuando la fila existe pero el actor no está autorizado', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('viewer', 'org-1', 'user-not-creator'))
    mockSelect.mockReturnValueOnce(makeSelectChain([FULL_ROW]))

    const result = await getAuthorizedStellaInteraction('int-1')
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('devuelve NOT_FOUND para un admin de otra organización (sin revelar que la fila existe)', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin', 'org-2', 'user-admin-org-2'))
    mockSelect.mockReturnValueOnce(makeSelectChain([FULL_ROW]))

    const result = await getAuthorizedStellaInteraction('int-1')
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('devuelve la vista detallada completa cuando el actor es organization_admin de la organización correcta', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin', 'org-1', 'user-admin'))
    mockSelect.mockReturnValueOnce(makeSelectChain([FULL_ROW]))

    const result = await getAuthorizedStellaInteraction('int-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.responseJson).toEqual({ summary: 'secret model output' })
      expect(result.data.contextManifest).toEqual({ role: 'advisor' })
      expect(result.data.riskFlags).toEqual(['evidence_gap'])
    }
  })

  it('devuelve la vista detallada cuando el actor es el creador, aunque su rol sea viewer', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('viewer', 'org-1', 'user-creator'))
    mockSelect.mockReturnValueOnce(makeSelectChain([FULL_ROW]))

    const result = await getAuthorizedStellaInteraction('int-1')
    expect(result.ok).toBe(true)
  })

  describe('Etapa A2.4 (DR-004) — purge-state distinction', () => {
    it('responseStatus is "available" when responseJson is present', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin', 'org-1', 'user-admin'))
      mockSelect.mockReturnValueOnce(makeSelectChain([FULL_ROW]))

      const result = await getAuthorizedStellaInteraction('int-1')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.responseStatus).toBe('available')
        expect(result.data.responsePurgedAt).toBeNull()
      }
    })

    it('responseStatus is "purged" when responseJson is null and responsePurgedAt is set — never crashes reading a purged row', async () => {
      const purgedAt = new Date('2026-06-01T00:00:00Z')
      const purgedRow = { ...FULL_ROW, responseJson: null, responsePurgedAt: purgedAt }
      mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin', 'org-1', 'user-admin'))
      mockSelect.mockReturnValueOnce(makeSelectChain([purgedRow]))

      const result = await getAuthorizedStellaInteraction('int-1')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.responseJson).toBeNull()
        expect(result.data.responseStatus).toBe('purged')
        expect(result.data.responsePurgedAt).toEqual(purgedAt)
      }
    })
  })
})

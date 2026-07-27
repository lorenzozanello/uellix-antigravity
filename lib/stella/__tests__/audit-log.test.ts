// lib/stella/__tests__/audit-log.test.ts
// Etapa A1 (STL-A1-006) — this is the test that "fails if an interaction
// doesn't register a version": recordStellaInteraction is the ONLY insertion
// path, so asserting its output here covers all 4 server actions that call it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertValuesMock = vi.fn().mockResolvedValue(undefined)
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest param needed so the spread call below type-checks
const insertMock = vi.fn((...tableArgs: unknown[]) => ({ values: insertValuesMock }))

vi.mock('@/db/client', () => ({
  db: { insert: (...args: unknown[]) => insertMock(...args) },
}))

import { recordStellaInteraction } from '../audit-log'
import { PROMPT_TEMPLATES } from '../prompts/registry'
import { CONTEXT_SCHEMA_VERSION } from '../context/schema-version'
import type { StellaRole } from '../adapter/types'
import type { StellaProjectContext } from '../context/types'

const ALL_ROLES: StellaRole[] = [
  'advisor',
  'validator',
  'composer',
  'proxy_reviewer',
  'evidence_reviewer',
  'audit_assistant',
]

function minimalContext(): StellaProjectContext {
  return {
    projectId: 'proj-1',
    organizationId: 'org-1',
    narrativeSummary: 'Narrative.',
    outcomesSnapshot: [],
    indicatorsSnapshot: [],
    stakeholderCount: 0,
    evidenceMetadata: [],
    evidenceTotal: 0,
    proxySummary: [],
    filterSetsSummary: [],
    calculationSnapshot: null,
    reportSections: [],
    projectCreatedAt: '2026-01-01T00:00:00Z',
    lastUpdatedAt: '2026-01-01T00:00:00Z',
  }
}

describe('recordStellaInteraction', () => {
  beforeEach(() => {
    insertValuesMock.mockClear()
    insertMock.mockClear()
  })

  it.each(ALL_ROLES)(
    'always attaches prompt version, context schema version and a manifest for role "%s"',
    async (role) => {
      await recordStellaInteraction({
        organizationId: 'org-1',
        projectId: 'proj-1',
        createdBy: 'user-1',
        role,
        pipelineStep: 'Test step',
        context: minimalContext(),
        contextHash: 'hash-value',
        responseJson: { ok: true },
        modelUsed: 'gemini-2.5-flash',
      })

      expect(insertValuesMock).toHaveBeenCalledTimes(1)
      const values = insertValuesMock.mock.calls[0][0] as Record<string, unknown>

      expect(values.promptTemplateId).toBe(PROMPT_TEMPLATES[role].templateId)
      expect(values.promptVersion).toBe(PROMPT_TEMPLATES[role].version)
      // Etapa A1.5 (STL-A15-008): each row carries its own content hash.
      expect(values.promptContentHash).toBe(PROMPT_TEMPLATES[role].expectedContentHash)
      expect(values.contextSchemaVersion).toBe(CONTEXT_SCHEMA_VERSION)
      expect(values.contextManifest).toBeTruthy()
      expect(values.stellaRole).toBe(role)
    },
  )

  it('passes through optional risk fields when provided', async () => {
    await recordStellaInteraction({
      organizationId: 'org-1',
      projectId: 'proj-1',
      createdBy: 'user-1',
      role: 'validator',
      pipelineStep: 'Calculation',
      context: minimalContext(),
      contextHash: 'hash-value',
      responseJson: { ok: true },
      modelUsed: 'gemini-2.5-flash',
      riskLevel: 'high',
      riskFlags: ['evidence_gap'],
    })

    const values = insertValuesMock.mock.calls[0][0] as Record<string, unknown>
    expect(values.riskLevel).toBe('high')
    expect(values.riskFlags).toEqual(['evidence_gap'])
  })

  it('defaults riskFlags to an empty array when omitted', async () => {
    await recordStellaInteraction({
      organizationId: 'org-1',
      projectId: 'proj-1',
      createdBy: 'user-1',
      role: 'advisor',
      pipelineStep: 'Narrative',
      context: minimalContext(),
      contextHash: 'hash-value',
      responseJson: { ok: true },
      modelUsed: 'gemini-2.5-flash',
    })

    const values = insertValuesMock.mock.calls[0][0] as Record<string, unknown>
    expect(values.riskFlags).toEqual([])
  })
})

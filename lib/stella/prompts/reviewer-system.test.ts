// lib/stella/prompts/reviewer-system.test.ts
// WS6 (Fable Moonshot): reviewer prompt ↔ context contract tests (RK-17 fix).
// The core invariant: every data concept a role's mandate mentions maps to a
// field the user-message payload actually serializes for that role
// (prompt-mentioned fields ⊆ context-provided fields).

import { describe, it, expect } from 'vitest'
import {
  buildReviewerSystemPrompt,
  buildReviewerUserMessage,
  REVIEWER_PROMPT_FIELD_CONTRACT,
  REVIEWER_ROLE_CONFIG,
  type ReviewerRole,
} from './reviewer-system'
import { UNTRUSTED_DATA_MARKER } from '../context/sanitize'
import type { ReviewerContext } from '../context/build-reviewer-context'
import type { StellaProjectContext } from '../context/types'

const ROLES: readonly ReviewerRole[] = ['proxy_reviewer', 'evidence_reviewer', 'audit_assistant']

const baseContext: StellaProjectContext = {
  projectId: 'proj-1',
  organizationId: 'org-1',
  narrativeSummary: 'Acceso a agua segura en Isla Esperanza.',
  outcomesSnapshot: [
    { id: 'out-1', name: 'Reducción del tiempo de acceso a agua', description: 'social', stakeholderGroups: [] },
  ],
  indicatorsSnapshot: [
    { id: 'ind-1', outcomeId: 'out-1', name: 'Horas semanales dedicadas a buscar agua', unit: 'horas' },
  ],
  stakeholderCount: 2,
  evidenceMetadata: [
    {
      id: 'ev-1',
      title: 'Línea base hogares 2025',
      type: 'file',
      status: 'approved',
      createdAt: '2026-03-01T00:00:00.000Z',
      outcomeId: 'out-1',
      indicatorId: 'ind-1',
    },
  ],
  evidenceTotal: 1,
  proxySummary: [
    { id: 'proxy-1', name: 'Valor hora de trabajo', source: 'DANE', value: '', currency: '', confidenceLevel: 'high' },
  ],
  filterSetsSummary: [
    { assignmentId: 'asgn-1', deadweightPct: 20, attributionPct: 70, displacementPct: 5, dropoffPct: 10, durationYears: 3 },
  ],
  calculationSnapshot: {
    totalInvestment: 10000,
    grossSocialValue: 25000,
    netSocialValue: 15000,
    sroiRatio: 1.5,
    currency: 'USD',
    lineItemCount: 1,
    version: 2,
  },
  reportSections: [],
  readinessScore: 72,
  projectCreatedAt: '2026-01-01T00:00:00.000Z',
  lastUpdatedAt: '2026-06-01T00:00:00.000Z',
}

/** Fully enriched reviewer context — the superset every role can be built from. */
const enrichedContext: ReviewerContext = {
  ...baseContext,
  reviewerRole: null,
  proxyDetails: [
    {
      id: 'proxy-1',
      name: 'Valor hora de trabajo',
      value: '350.0000',
      currency: 'USD',
      sourceName: 'DANE — Encuesta de hogares',
      sourceUrlDomain: 'datos.dane.gov.co',
      referenceYear: 2024,
      approvalStatus: 'approved',
      confidenceLevel: 'high',
      methodologicalRisk: 'low',
      outcomeId: 'out-1',
      outcomeTitle: 'Reducción del tiempo de acceso a agua',
    },
  ],
  evidenceDetails: [
    {
      id: 'ev-1',
      title: 'Línea base hogares 2025',
      type: 'file',
      status: 'approved',
      integrityVerified: true,
      integrityVerifiedAt: '2026-03-02T10:00:00.000Z',
      confidenceScore: 85,
      outcomeId: 'out-1',
      indicatorId: 'ind-1',
      relatedOutcomeTitle: 'Reducción del tiempo de acceso a agua',
      createdAt: '2026-03-01T00:00:00.000Z',
    },
  ],
  // FIBIU-17 (FIBC-021, W2-B5, HPO-ODS-W2-17): latestReadinessScore is
  // REMOVED from ReviewerRunReviewSummary (NEG-17-4/5 — the reviewer
  // enumeration gap the B5 authority closed).
  runReviewSummary: {
    reviewCount: 2,
    latestStatus: 'flagged',
    latestReviewedAt: '2026-06-10T12:00:00.000Z',
  },
}

function extractPayload(userMessage: string): Record<string, unknown> {
  const [, json] = userMessage.split(`${UNTRUSTED_DATA_MARKER}\n`)
  expect(json, 'payload must follow the untrusted-data marker').toBeTruthy()
  return JSON.parse(json)
}

/**
 * Resolve a contract payload path like 'proxies[].referenceYear' or
 * 'runReviews.latestStatus' against the parsed payload. For array segments
 * ('x[]') the FIRST element is inspected; the property must exist as a key
 * (null values count as provided — absence is the contract violation).
 */
function payloadHasPath(payload: unknown, path: string): boolean {
  const segments = path.split('.')
  let current: unknown = payload
  for (const segment of segments) {
    const isArray = segment.endsWith('[]')
    const key = isArray ? segment.slice(0, -2) : segment
    if (typeof current !== 'object' || current === null || !(key in (current as Record<string, unknown>))) {
      return false
    }
    current = (current as Record<string, unknown>)[key]
    if (isArray) {
      if (!Array.isArray(current) || current.length === 0) return false
      current = current[0]
    }
  }
  return true
}

describe('reviewer prompt ↔ context contract (RK-17)', () => {
  for (const role of ROLES) {
    describe(role, () => {
      const systemPrompt = buildReviewerSystemPrompt(role)
      const userMessage = buildReviewerUserMessage(role, enrichedContext)
      const payload = extractPayload(userMessage)

      it('every prompt-mentioned data concept is provided by the payload', () => {
        for (const { promptMention, payloadPath } of REVIEWER_PROMPT_FIELD_CONTRACT[role]) {
          expect(systemPrompt, `mandate must mention "${promptMention}"`).toContain(promptMention)
          expect(
            payloadHasPath(payload, payloadPath),
            `payload must provide ${payloadPath} (promised as "${promptMention}")`
          ).toBe(true)
        }
      })

      it('wraps the payload in the untrusted-data envelope', () => {
        expect(userMessage).toContain(UNTRUSTED_DATA_MARKER)
        expect(payload.reviewerRole).toBe(role)
      })

      it('system prompt hardcodes requires_human_review: true', () => {
        expect(systemPrompt).toContain('"requires_human_review": true')
        expect(systemPrompt).toContain('requires_human_review MUST always be true')
      })
    })
  }

  it('proxy_reviewer payload carries the enriched proxy fields', () => {
    const payload = extractPayload(buildReviewerUserMessage('proxy_reviewer', enrichedContext))
    const proxies = payload.proxies as Array<Record<string, unknown>>
    expect(proxies[0]).toMatchObject({
      value: '350.0000',
      currency: 'USD',
      sourceUrlDomain: 'datos.dane.gov.co',
      referenceYear: 2024,
      approvalStatus: 'approved',
      outcomeId: 'out-1',
      outcomeTitle: 'Reducción del tiempo de acceso a agua',
    })
  })

  it('evidence_reviewer payload carries integrity and confidence fields', () => {
    const payload = extractPayload(buildReviewerUserMessage('evidence_reviewer', enrichedContext))
    const evidence = payload.evidence as Array<Record<string, unknown>>
    expect(evidence[0]).toMatchObject({
      integrityVerified: true,
      integrityVerifiedAt: '2026-03-02T10:00:00.000Z',
      confidenceScore: 85,
      outcomeId: 'out-1',
      relatedOutcomeTitle: 'Reducción del tiempo de acceso a agua',
    })
  })

  it('audit_assistant payload carries the run-review roll-up', () => {
    const payload = extractPayload(buildReviewerUserMessage('audit_assistant', enrichedContext))
    expect(payload.runReviews).toEqual({
      reviewCount: 2,
      latestStatus: 'flagged',
      latestReviewedAt: '2026-06-10T12:00:00.000Z',
    })
  })

  // NEG-17-5 (FIBIU-17, FIBC-021, W2-B5) — the reviewer prompt carries no
  // readiness value sourced from sroi_run_reviews, even though the input
  // context here carries context.readinessScore = 72 (baseContext, below):
  // both the runReviews.latestReadinessScore route (closed above) and the
  // projectAnalysisState.readinessScore route are closed.
  it('audit_assistant payload exposes no readiness value from sroi_run_reviews (NEG-17-5)', () => {
    const payload = extractPayload(buildReviewerUserMessage('audit_assistant', enrichedContext))
    expect(payload.runReviews).not.toHaveProperty('latestReadinessScore')
    const projectAnalysisState = payload.projectAnalysisState as Record<string, unknown>
    expect(projectAnalysisState).not.toHaveProperty('readinessScore')
  })

  it('audit_assistant payload carries the narrative summary (FIX 1c) — grounds the consistency mandate', () => {
    const payload = extractPayload(buildReviewerUserMessage('audit_assistant', enrichedContext))
    expect(payload.narrativeSummary).toBe('Acceso a agua segura en Isla Esperanza.')
  })

  describe('legacy fallback (plain StellaProjectContext without enrichments)', () => {
    it('proxy_reviewer degrades to nulls instead of throwing', () => {
      const payload = extractPayload(buildReviewerUserMessage('proxy_reviewer', baseContext))
      const proxies = payload.proxies as Array<Record<string, unknown>>
      expect(proxies[0].sourceUrlDomain).toBeNull()
      expect(proxies[0].referenceYear).toBeNull()
      expect(proxies[0].approvalStatus).toBe('unknown')
      expect(proxies[0].outcomeId).toBeNull()
      expect(proxies[0].outcomeTitle).toBeNull()
    })

    it('evidence_reviewer degrades to nulls instead of throwing', () => {
      const payload = extractPayload(buildReviewerUserMessage('evidence_reviewer', baseContext))
      const evidence = payload.evidence as Array<Record<string, unknown>>
      expect(evidence[0].integrityVerified).toBeNull()
      expect(evidence[0].confidenceScore).toBeNull()
      expect(evidence[0].linkedToOutcome).toBe(true)
      expect(evidence[0].outcomeId).toBe('out-1')
      expect(evidence[0].relatedOutcomeTitle).toBeNull()
    })

    it('audit_assistant reports an empty review trail instead of throwing', () => {
      const payload = extractPayload(buildReviewerUserMessage('audit_assistant', baseContext))
      expect(payload.runReviews).toEqual({
        reviewCount: 0,
        latestStatus: null,
        latestReviewedAt: null,
      })
    })
  })

  it('pipeline steps stay stable for the audit rows', () => {
    expect(REVIEWER_ROLE_CONFIG.proxy_reviewer.pipelineStep).toBe('Proxies')
    expect(REVIEWER_ROLE_CONFIG.evidence_reviewer.pipelineStep).toBe('Evidence')
    expect(REVIEWER_ROLE_CONFIG.audit_assistant.pipelineStep).toBe('Calculation')
  })
})

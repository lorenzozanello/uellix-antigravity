// lib/stella/prompts/sensitive-populations-notice.test.ts
// WS3c U1 (RK-08): the SENSITIVE_POPULATIONS_NOTICE is appended by every
// user-message builder ONLY when the context flag is detected, and it always
// sits in the TRUSTED tier — strictly BEFORE the UNTRUSTED_PROJECT_DATA
// marker, never inside the envelope payload.

import { describe, it, expect } from 'vitest'
import { SENSITIVE_POPULATIONS_NOTICE } from './shared-guardrails'
import { buildAdvisorUserMessage } from './advisor-system'
import { buildValidatorUserMessage } from './validator-system'
import { buildComposerUserMessage } from './composer-system'
import { buildReviewerUserMessage } from './reviewer-system'
import { buildAdvisorContextualUserMessage } from './advisor-contextual-system'
import { UNTRUSTED_DATA_MARKER } from '../context/sanitize'
import type { StellaProjectContext, ContextualAdvisorContext } from '../context/types'
import type { ReviewerContext } from '../context/build-reviewer-context'

const NOTICE_HEADING = 'HEIGHTENED CARE — SENSITIVE POPULATIONS DETECTED'

const baseContext: StellaProjectContext = {
  projectId: 'proj-1',
  organizationId: 'org-1',
  narrativeSummary: 'Resumen del proyecto.',
  outcomesSnapshot: [],
  indicatorsSnapshot: [],
  stakeholderCount: 0,
  evidenceMetadata: [],
  evidenceTotal: 0,
  proxySummary: [],
  filterSetsSummary: [],
  calculationSnapshot: null,
  reportSections: [],
  projectCreatedAt: '2026-01-01T00:00:00.000Z',
  lastUpdatedAt: '2026-06-01T00:00:00.000Z',
}

const sensitiveFlag = { detected: true, categories: ['minors'] }

const contextualBase: ContextualAdvisorContext = {
  projectId: 'proj-1',
  organizationId: 'org-1',
  narrativeSummary: '',
  outcomesSnapshot: [],
  indicatorsSnapshot: [],
  stakeholderCount: 0,
  stakeholdersSnapshot: [],
  activitiesSummary: [],
  evidenceMetadata: [],
  evidenceTotal: 0,
  proxySummary: [],
  filterSetsSummary: [],
  calculationSnapshot: null,
  reportSections: [],
  projectCreatedAt: '',
  lastUpdatedAt: '',
}

const reviewerContext = (flag?: { detected: boolean; categories: string[] }): ReviewerContext => ({
  ...baseContext,
  ...(flag ? { sensitivePopulations: flag } : {}),
  reviewerRole: 'audit_assistant',
  // FIBIU-17 (W2-B5): latestReadinessScore removed from ReviewerRunReviewSummary
  // — mechanically forced fixture update, unrelated to this file's own
  // sensitive-populations-notice controls.
  runReviewSummary: {
    reviewCount: 0,
    latestStatus: null,
    latestReviewedAt: null,
  },
})

/** The notice must be fully emitted BEFORE the envelope marker. */
function expectNoticeInTrustedTier(message: string) {
  const noticeIndex = message.indexOf(NOTICE_HEADING)
  const markerIndex = message.indexOf(UNTRUSTED_DATA_MARKER)
  expect(noticeIndex).toBeGreaterThanOrEqual(0)
  expect(markerIndex).toBeGreaterThan(noticeIndex)
  // The envelope payload (everything after the marker) must not contain the
  // notice heading — the block never travels inside untrusted data.
  const envelope = message.slice(markerIndex)
  expect(envelope).not.toContain(NOTICE_HEADING)
}

describe('SENSITIVE_POPULATIONS_NOTICE (RK-08)', () => {
  it('exports the heightened-care requirements (aggregate-only, no identification, elevated review)', () => {
    expect(SENSITIVE_POPULATIONS_NOTICE).toContain(NOTICE_HEADING)
    expect(SENSITIVE_POPULATIONS_NOTICE).toContain('identifying details')
    expect(SENSITIVE_POPULATIONS_NOTICE).toContain('aggregate-only language')
    expect(SENSITIVE_POPULATIONS_NOTICE).toContain('individual-level recommendations')
    expect(SENSITIVE_POPULATIONS_NOTICE).toContain('requires_human_review / requiresHumanReview must be true')
    expect(SENSITIVE_POPULATIONS_NOTICE).toContain('ELEVATED human review')
  })

  describe('legacy advisor user message', () => {
    it('omits the notice when not detected', () => {
      expect(buildAdvisorUserMessage('narrative', baseContext)).not.toContain(NOTICE_HEADING)
    })
    it('includes the notice OUTSIDE the untrusted envelope when detected', () => {
      const message = buildAdvisorUserMessage('narrative', {
        ...baseContext,
        sensitivePopulations: sensitiveFlag,
      })
      expectNoticeInTrustedTier(message)
    })
  })

  describe('validator user message', () => {
    it('omits the notice when not detected', () => {
      expect(buildValidatorUserMessage(baseContext)).not.toContain(NOTICE_HEADING)
    })
    it('includes the notice OUTSIDE the untrusted envelope when detected', () => {
      const message = buildValidatorUserMessage({
        ...baseContext,
        sensitivePopulations: sensitiveFlag,
      })
      expectNoticeInTrustedTier(message)
    })
  })

  describe('composer user message', () => {
    it('omits the notice when not detected', () => {
      expect(buildComposerUserMessage('executive_summary', baseContext)).not.toContain(NOTICE_HEADING)
    })
    it('includes the notice OUTSIDE the untrusted envelope when detected', () => {
      const message = buildComposerUserMessage('executive_summary', {
        ...baseContext,
        sensitivePopulations: sensitiveFlag,
      })
      expectNoticeInTrustedTier(message)
    })
  })

  describe('reviewer user message', () => {
    it('omits the notice when not detected', () => {
      expect(buildReviewerUserMessage('audit_assistant', reviewerContext())).not.toContain(NOTICE_HEADING)
    })
    it('includes the notice OUTSIDE the untrusted envelope when detected (all roles)', () => {
      for (const role of ['proxy_reviewer', 'evidence_reviewer', 'audit_assistant'] as const) {
        const message = buildReviewerUserMessage(role, reviewerContext(sensitiveFlag))
        expectNoticeInTrustedTier(message)
      }
    })
  })

  describe('contextual advisor user message', () => {
    it('omits the notice when not detected', () => {
      const message = buildAdvisorContextualUserMessage('narrative', contextualBase)
      expect(message).not.toContain(NOTICE_HEADING)
      expect(message.startsWith(UNTRUSTED_DATA_MARKER)).toBe(true)
    })

    it('emits the notice in the TRUSTED preamble, before the envelope marker', () => {
      const message = buildAdvisorContextualUserMessage('narrative', {
        ...contextualBase,
        sensitivePopulations: sensitiveFlag,
      })
      expectNoticeInTrustedTier(message)
    })

    it('never serializes the sensitivePopulations flag into the untrusted payload', () => {
      const message = buildAdvisorContextualUserMessage('narrative', {
        ...contextualBase,
        sensitivePopulations: sensitiveFlag,
      })
      const markerIndex = message.indexOf(UNTRUSTED_DATA_MARKER)
      const payload = message.slice(markerIndex + UNTRUSTED_DATA_MARKER.length)
      expect(payload).not.toContain('sensitivePopulations')
    })
  })
})

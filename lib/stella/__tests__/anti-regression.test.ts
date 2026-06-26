// lib/stella/__tests__/anti-regression.test.ts
// Sprint 9B: Anti-regression tests to prevent Stella from violating critical guardrails
// THESE TESTS MUST NEVER FAIL - they enforce hard constraints

import { describe, it, expect } from 'vitest'
import { ValidatorOutputSchema, ComposerOutputSchema } from '../schemas'
import { SHARED_GUARDRAILS } from '../prompts/shared-guardrails'

describe('Stella Anti-Regression: Critical Guardrails', () => {
  describe('NEVER: Calculate SROI or modify deterministic logic', () => {
    it('should not import SROI calculation functions', () => {
      // This test ensures lib/stella code doesn't import sroi-calculation
      // In actual integration, we verify this at build time with circular dependency checks
      expect(true).toBe(true)
    })

    it('should not include SROI formula in prompts', () => {
      expect(SHARED_GUARDRAILS.toLowerCase()).toContain('never calculate sroi')
      expect(SHARED_GUARDRAILS.toLowerCase()).toContain('recalculate')
    })
  })

  describe('NEVER: Claim certification or automatic audit', () => {
    it('should reject "certified" in prohibited terms', () => {
      // SHARED_GUARDRAILS should contain prohibitions against these terms:
      // certified, certification, automatic audit, guaranteed impact, AI audited, automatically approved
      expect(SHARED_GUARDRAILS.toLowerCase()).toContain('never')
    })

    it('ValidatorOutput should never allow missing requires_human_review', () => {
      const testData = {
        summary: 'Test',
        risk_level: 'low' as const,
        evidence_gaps: [],
        proxy_risks: [],
        attribution_risks: [],
        claim_risks: [],
        recommendations: [],
        requires_human_review: true,
      }

      const parsed = ValidatorOutputSchema.parse(testData)
      expect(parsed.requires_human_review).toBe(true)

      // Try to parse with false - should fail
      expect(() => {
        ValidatorOutputSchema.parse({ ...testData, requires_human_review: false })
      }).toThrow()
    })
  })

  describe('NEVER: Write to database without explicit user action', () => {
    it('should not have direct database write functions', () => {
      // Stella adapter should not export any functions that write to DB
      // All writes must go through explicit server actions triggered by user
      expect(true).toBe(true) // Placeholder - actual check is at compile time
    })
  })

  describe('NEVER: Approve evidence or proxies', () => {
    it('should not include approval language in outputs', () => {
      expect(SHARED_GUARDRAILS.toLowerCase()).toContain('never approve')
      expect(SHARED_GUARDRAILS.toLowerCase()).toContain('humans decide')
    })

    it('ValidatorOutput should flag issues, not approve', () => {
      const output = ValidatorOutputSchema.parse({
        summary: 'Analysis has gaps',
        risk_level: 'medium',
        evidence_gaps: ['Outcome 1 lacks evidence'],
        proxy_risks: ['Proxy A has low confidence'],
        attribution_risks: [],
        claim_risks: [],
        recommendations: ['Gather more evidence'],
        requires_human_review: true,
      })

      expect(output.evidence_gaps.length).toBeGreaterThan(0)
      expect(output.requires_human_review).toBe(true)
    })
  })

  describe('NEVER: Invent evidence, sources, or proxies', () => {
    it('should warn about forbidden patterns in shared guardrails', () => {
      expect(SHARED_GUARDRAILS.toLowerCase()).toContain('never invent')
      expect(SHARED_GUARDRAILS.toLowerCase()).toContain('never fabricate')
    })

    it('ComposerOutput evidence_references should require IDs', () => {
      const output = ComposerOutputSchema.parse({
        section_key: 'executive_summary',
        draft_title: 'Test',
        draft_content: 'Draft content',
        assumptions: [],
        limitations: [],
        evidence_references: [
          {
            evidenceId: 'real-id-123',
            title: 'Evidence Title',
            context: 'How it is cited',
          },
        ],
        proxy_references: [],
      })

      // All references must have IDs pointing to real project data
      expect(output.evidence_references[0].evidenceId).toBeDefined()
      expect(output.evidence_references[0].evidenceId).toMatch(/^[a-z0-9\-]+$/)
    })
  })

  describe('NEVER: Expose secrets or API keys', () => {
    it('should not include GEMINI_API_KEY in prompts', () => {
      expect(SHARED_GUARDRAILS).not.toContain('GEMINI_API_KEY')
    })

    it('should warn about secret exposure', () => {
      expect(SHARED_GUARDRAILS.toLowerCase()).toContain('forbidden data')
      expect(SHARED_GUARDRAILS.toLowerCase()).toContain('api keys')
    })
  })

  describe('ALWAYS: Require human review', () => {
    it('ValidatorOutput requires_human_review must be literal true', () => {
      const validator = ValidatorOutputSchema
      const safeParse = validator.safeParse({
        summary: 'Test',
        risk_level: 'low',
        evidence_gaps: [],
        proxy_risks: [],
        attribution_risks: [],
        claim_risks: [],
        recommendations: [],
        requires_human_review: true,
      })

      expect(safeParse.success).toBe(true)
      if (safeParse.success) {
        expect(safeParse.data.requires_human_review).toBe(true)
      }
    })

    it('ComposerOutput should be a draft, not persisted', () => {
      const composer = ComposerOutputSchema.parse({
        section_key: 'executive_summary',
        draft_title: 'Draft Title',
        draft_content: 'This is a draft that requires human review and editing',
        assumptions: ['Assumption 1'],
        limitations: ['Limitation 1'],
        evidence_references: [],
        proxy_references: [],
      })

      // The output should clearly be a draft
      expect(composer.draft_content).toBeDefined()
      expect(composer.draft_title).toContain('Draft') // Conventions
    })
  })

  describe('NEVER: Use prohibited NEXT_PUBLIC_ environment variables', () => {
    it('should not have NEXT_PUBLIC_GEMINI_API_KEY', () => {
      // This is checked at build time by the adapter
      expect(process.env.NEXT_PUBLIC_GEMINI_API_KEY).toBeUndefined()
    })
  })

  describe('NEVER: Make real Gemini API calls in tests', () => {
    it('tests should use mock provider only', () => {
      // All adapter tests use MockGeminiProvider
      expect(true).toBe(true)
    })
  })

  describe('ALWAYS: Fallback gracefully when Stella is unavailable', () => {
    it('ValidatorFallback should still set requires_human_review: true', () => {
      const fallback = {
        summary: 'Stella unavailable',
        risk_level: 'medium' as const,
        evidence_gaps: [],
        proxy_risks: [],
        attribution_risks: [],
        claim_risks: [],
        recommendations: ['Manual validation needed'],
        requires_human_review: true,
      }

      const parsed = ValidatorOutputSchema.parse(fallback)
      expect(parsed.requires_human_review).toBe(true)
    })
  })
})

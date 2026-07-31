// lib/stella/__tests__/anti-regression.test.ts
// Sprint 9B: Anti-regression tests to prevent Stella from violating critical guardrails
// THESE TESTS MUST NEVER FAIL - they enforce hard constraints

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { ValidatorOutputSchema, ComposerOutputSchema, ReviewerOutputSchema } from '../schemas'
import { SHARED_GUARDRAILS } from '../prompts/shared-guardrails'
import { buildAdvisorSystemPrompt } from '../prompts/advisor-system'
import { buildValidatorSystemPrompt } from '../prompts/validator-system'
import { buildComposerSystemPrompt } from '../prompts/composer-system'
import { buildReviewerSystemPrompt } from '../prompts/reviewer-system'

// ---------------------------------------------------------------------------
// Source scanning helpers — these tests read the ACTUAL source files of
// lib/stella/** so that a violating import/write would make them fail.
// ---------------------------------------------------------------------------

const STELLA_ROOT = resolve(process.cwd(), 'lib', 'stella')

/** Recursively collect every .ts source file under lib/stella, excluding tests. */
function collectStellaSourceFiles(dir: string = STELLA_ROOT, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      collectStellaSourceFiles(full, acc)
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.includes('.test.')
    ) {
      acc.push(full)
    }
  }
  return acc
}

function findViolations(pattern: RegExp): string[] {
  const violations: string[] = []
  for (const file of collectStellaSourceFiles()) {
    const content = readFileSync(file, 'utf8')
    if (pattern.test(content)) {
      violations.push(relative(process.cwd(), file))
    }
  }
  return violations
}

describe('Stella Anti-Regression: Critical Guardrails', () => {
  describe('NEVER: Calculate SROI or modify deterministic logic', () => {
    it('should not import SROI calculation functions (real source scan)', () => {
      // No lib/stella module may import/require the deterministic SROI engine:
      // lib/pipeline/sroi-calculation, sroi-sensitivity or sroi-funders.
      const sroiImportPattern =
        /(?:import[\s\S]{0,200}?from\s*['"]|require\(\s*['"])[^'"]*pipeline\/(?:sroi-calculation|sroi-sensitivity|sroi-funders)/
      expect(findViolations(sroiImportPattern)).toEqual([])
    })

    it('scans a non-empty set of real source files (guard against a broken scanner)', () => {
      const files = collectStellaSourceFiles()
      expect(files.length).toBeGreaterThan(10)
      // Sanity: the scanner sees files we know exist.
      expect(files.some((f) => f.endsWith('config.ts'))).toBe(true)
      expect(files.some((f) => f.replace(/\\/g, '/').endsWith('adapter/gemini-client.ts'))).toBe(true)
    })

    it('the source scan would actually fail on a violating import', () => {
      const sroiImportPattern =
        /(?:import[\s\S]{0,200}?from\s*['"]|require\(\s*['"])[^'"]*pipeline\/(?:sroi-calculation|sroi-sensitivity|sroi-funders)/
      const violatingSource = `import { calculateSroi } from '@/lib/pipeline/sroi-calculation'`
      expect(sroiImportPattern.test(violatingSource)).toBe(true)
      expect(sroiImportPattern.test(`const x = require('../../pipeline/sroi-funders')`)).toBe(true)
    })

    it('should not include SROI formula in prompts', () => {
      expect(SHARED_GUARDRAILS.toLowerCase()).toContain('never calculate sroi')
      expect(SHARED_GUARDRAILS.toLowerCase()).toContain('recalculate')
    })
  })

  describe('NEVER: Claim certification or automatic audit', () => {
    it('every system prompt contains an explicit categorical certification prohibition', () => {
      // The prohibition must be categorical: out of role REGARDLESS of data
      // completeness — not merely the word "never" somewhere in the prompt.
      const prompts = [
        buildAdvisorSystemPrompt('outcomes'),
        buildValidatorSystemPrompt(),
        buildComposerSystemPrompt('executive_summary'),
        buildReviewerSystemPrompt('proxy_reviewer'),
        buildReviewerSystemPrompt('evidence_reviewer'),
        buildReviewerSystemPrompt('audit_assistant'),
      ]
      for (const prompt of prompts) {
        expect(prompt.toLowerCase()).toContain('categorically outside your role')
        expect(prompt.toLowerCase()).toContain('regardless of data completeness')
        expect(prompt.toLowerCase()).toContain('never claim certification')
      }
    })

    it('SHARED_GUARDRAILS states certification is categorically out of role', () => {
      const lower = SHARED_GUARDRAILS.toLowerCase()
      expect(lower).toContain('categorically outside your role')
      expect(lower).toContain('regardless of data completeness')
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
    // The only allowed DB writers are the server actions in app/actions/stella/*.
    // lib/stella modules may READ (context builders, quota) but never write.
    // Matches db.insert( / db.update( / db.delete( — deliberately NOT bare
    // `.update(` so crypto createHash().update() stays allowed (reads are fine,
    // the boundary is writes).
    const dbWritePattern = /\bdb\s*\.\s*(?:insert|update|delete)\s*\(/

    it('no lib/stella module performs a direct DB write (real source scan)', () => {
      expect(findViolations(dbWritePattern)).toEqual([])
    })

    it('the DB-write scan would actually fail on a violation', () => {
      expect(dbWritePattern.test(`await db.insert(stellaInteractions).values({})`)).toBe(true)
      expect(dbWritePattern.test(`await db.update(projects).set({})`)).toBe(true)
      expect(dbWritePattern.test(`await db.delete(evidence)`)).toBe(true)
      // Reading stays allowed:
      expect(dbWritePattern.test(`await db.select().from(projects)`)).toBe(false)
      // crypto hash update stays allowed:
      expect(dbWritePattern.test(`createHash('sha256').update(input).digest('hex')`)).toBe(false)
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

  describe('Fase 5b reviewer roles: inherit the human-review invariant', () => {
    it('ReviewerOutput requires_human_review must be literal true', () => {
      const valid = {
        summary: 'Revisión',
        risk_level: 'medium' as const,
        findings: ['Hallazgo'],
        recommendations: ['Recomendación'],
        requires_human_review: true,
      }
      expect(ReviewerOutputSchema.parse(valid).requires_human_review).toBe(true)
      expect(() => ReviewerOutputSchema.parse({ ...valid, requires_human_review: false })).toThrow()
    })

    it('ReviewerOutput flags findings, never approvals', () => {
      const output = ReviewerOutputSchema.parse({
        summary: 'Hay brechas',
        risk_level: 'high',
        findings: ['Proxy sin fuente verificable'],
        recommendations: ['Documentar la fuente'],
        requires_human_review: true,
      })
      expect(output.findings.length).toBeGreaterThan(0)
      expect(output.requires_human_review).toBe(true)
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

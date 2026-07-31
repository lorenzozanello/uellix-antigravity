// lib/stella/schemas/schema-versions.test.ts
// WS6 (Fable Moonshot) U2: schema-version pinning. Each versioned output
// schema's key list is snapshotted here; changing a schema's shape without a
// conscious SCHEMA_VERSION bump (and a matching update of this pin AND
// docs/20_STELLA_ROLE_CONTRACTS.md) fails the suite.
//
// The advisor schemas carry no version const (owned invariants frozen by the
// b1c closure); their key lists are pinned here all the same so any drift is
// caught and routed through the contract doc.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ValidatorOutputSchema, VALIDATOR_OUTPUT_SCHEMA_VERSION } from './validator-output'
import { ComposerOutputSchema, COMPOSER_OUTPUT_SCHEMA_VERSION } from './composer-output'
import { ReviewerOutputSchema, REVIEWER_OUTPUT_SCHEMA_VERSION } from './reviewer-output'
import { AdvisorOutputSchema } from './advisor-output'
import { AdvisorContextualOutputSchema } from './advisor-contextual-output'

const SEMVER_RE = /^\d+\.\d+\.\d+$/

function keysOf(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape).sort()
}

describe('schema contract versions (docs/20_STELLA_ROLE_CONTRACTS.md)', () => {
  it('versions are semver strings pinned at 1.0.0', () => {
    for (const version of [
      VALIDATOR_OUTPUT_SCHEMA_VERSION,
      COMPOSER_OUTPUT_SCHEMA_VERSION,
      REVIEWER_OUTPUT_SCHEMA_VERSION,
    ]) {
      expect(version).toMatch(SEMVER_RE)
      expect(version).toBe('1.0.0')
    }
  })

  it('ValidatorOutputSchema@1.0.0 key list is pinned', () => {
    expect(keysOf(ValidatorOutputSchema)).toEqual([
      'attribution_risks',
      'claim_risks',
      'evidence_gaps',
      'proxy_risks',
      'recommendations',
      'requires_human_review',
      'risk_level',
      'summary',
    ])
  })

  it('ReviewerOutputSchema@1.0.0 key list is pinned', () => {
    expect(keysOf(ReviewerOutputSchema)).toEqual([
      'findings',
      'recommendations',
      'requires_human_review',
      'risk_level',
      'summary',
    ])
  })

  it('ComposerOutputSchema@1.0.0 key list is pinned (incl. nested reference shapes)', () => {
    expect(keysOf(ComposerOutputSchema)).toEqual([
      'assumptions',
      'draft_content',
      'draft_title',
      'evidence_references',
      'limitations',
      'proxy_references',
      'section_key',
    ])
    const evidenceRef = ComposerOutputSchema.shape.evidence_references.element
    const proxyRef = ComposerOutputSchema.shape.proxy_references.element
    expect(keysOf(evidenceRef)).toEqual(['context', 'evidenceId', 'title'])
    expect(keysOf(proxyRef)).toEqual(['context', 'name', 'proxyId'])
  })

  it('AdvisorOutputSchema key list is pinned', () => {
    expect(keysOf(AdvisorOutputSchema)).toEqual([
      'common_mistakes',
      'how_to_do_it',
      'step',
      'suggested_next_actions',
      'what_to_do',
      'why_it_matters',
    ])
  })

  it('AdvisorContextualOutputSchema key list is pinned (b1c frozen contract)', () => {
    expect(keysOf(AdvisorContextualOutputSchema)).toEqual([
      'clarifyingQuestions',
      'findings',
      'limitations',
      'requiresHumanReview',
      'responseType',
      'step',
      'suggestions',
      'summary',
    ])
  })

  it('requires_human_review stays a literal true on validator and reviewer schemas', () => {
    expect(() => ValidatorOutputSchema.shape.requires_human_review.parse(false)).toThrow()
    expect(() => ReviewerOutputSchema.shape.requires_human_review.parse(false)).toThrow()
    expect(ValidatorOutputSchema.shape.requires_human_review.parse(true)).toBe(true)
    expect(ReviewerOutputSchema.shape.requires_human_review.parse(true)).toBe(true)
  })
})

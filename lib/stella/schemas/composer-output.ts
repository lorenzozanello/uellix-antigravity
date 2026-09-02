// lib/stella/schemas/composer-output.ts
// Sprint 9B: Stella Composer output schema

import { z } from 'zod'

/**
 * WS6 contract version (docs/20_STELLA_ROLE_CONTRACTS.md). Semver: bump PATCH
 * for doc-only description changes, MINOR for optional additions, MAJOR for
 * any key removal/rename/type change. schema-versions.test.ts pins the key
 * list so a shape change without a conscious bump fails the suite.
 */
export const COMPOSER_OUTPUT_SCHEMA_VERSION = '1.0.0'

export const ComposerOutputSchema = z.object({
  section_key: z
    .string()
    .describe(
      'Report section type: executive_summary, theory_of_change, methodology, limitations, etc.'
    ),
  draft_title: z.string().describe('Proposed title for the section'),
  draft_content: z
    .string()
    .describe('Draft content in markdown/plain text - NOT persisted, user edits and saves'),
  assumptions: z.array(z.string()).describe('Explicit assumptions made in this section'),
  limitations: z
    .array(z.string())
    .describe('Methodological limitations and caveats of the analysis'),
  evidence_references: z
    .array(
      z.object({
        evidenceId: z.string().describe('ID of evidence from project'),
        title: z.string().describe('Evidence title'),
        context: z.string().describe('How this evidence is cited in the section'),
      })
    )
    .describe('Evidence items cited in this draft'),
  proxy_references: z
    .array(
      z.object({
        proxyId: z.string().describe('ID of proxy from bank'),
        name: z.string().describe('Proxy name'),
        context: z.string().describe('How this proxy is cited in the section'),
      })
    )
    .describe('Proxies cited in this draft'),
})

export type ComposerOutput = z.infer<typeof ComposerOutputSchema>

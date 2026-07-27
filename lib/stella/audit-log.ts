// lib/stella/audit-log.ts
// Etapa A1 (STL-A1-006) — the single place that inserts a stella_interactions
// row. Before this file, advisor.ts/composer.ts/validator.ts/reviewer.ts each
// built their own `db.insert(stellaInteractions).values({...})` call by hand.
// That made it possible for a future edit to one action to silently omit the
// new traceability fields (prompt version, context schema version, context
// manifest — Etapa A1.2-A1.4) while the other three kept them. Centralizing
// the insert makes that impossible: every caller goes through the same
// function, and the manifest/version fields are computed here, not passed in.

import { db } from '@/db/client'
import { stellaInteractions } from '@/db/schema'
import type { StellaRole } from './adapter/types'
import { getPromptTemplate } from './prompts/registry'
import { CONTEXT_SCHEMA_VERSION } from './context/schema-version'
import { buildContextManifest } from './context/build-context-manifest'
import type { StellaProjectContext } from './context/types'

export interface RecordStellaInteractionInput {
  organizationId: string
  projectId: string
  createdBy: string
  role: StellaRole
  pipelineStep: string
  /** The context object built for this call — used to derive the manifest, never persisted raw. */
  context: StellaProjectContext
  contextHash: string
  responseJson: unknown
  modelUsed: string
  tokensUsed?: number
  riskLevel?: 'low' | 'medium' | 'high'
  riskFlags?: string[]
}

/**
 * Records one Stella interaction with full traceability: prompt template +
 * version, context schema version, and a structural context manifest — all
 * derived here, so a caller cannot forget them.
 */
export async function recordStellaInteraction(input: RecordStellaInteractionInput): Promise<void> {
  const template = getPromptTemplate(input.role)
  const manifest = buildContextManifest(input.context, input.role)
  // Etapa A1.5 (STL-A15-008), corrected Etapa A1.6 (STL-A16-004): store the
  // registry's OWN recorded snapshot for this role, not a fresh runtime
  // recomputation. Recomputing here previously called the real
  // buildXSystemPrompt/buildXUserMessage functions on every interaction,
  // which (a) was pure overhead — this hash never varies per call, only per
  // prompt-template version — and (b) broke under the 4 action test files'
  // mocks of those builders (a mocked buildXUserMessage returning a plain
  // placeholder string is not parseable as TASK/UNTRUSTED_PROJECT_DATA/
  // RESPONSE_REQUIREMENTS, so prompt-content-hash.ts's extraction threw).
  // Using the registry's own value is simpler, mock-safe, and semantically
  // identical in real operation — see prompt-content-hash.test.ts, which
  // independently verifies this value against a live recomputation.
  const promptContentHash = template.expectedContentHash

  await db.insert(stellaInteractions).values({
    organizationId: input.organizationId,
    projectId: input.projectId,
    createdBy: input.createdBy,
    stellaRole: input.role,
    pipelineStep: input.pipelineStep,
    contextHash: input.contextHash,
    responseJson: input.responseJson,
    modelUsed: input.modelUsed,
    tokensUsed: input.tokensUsed,
    riskLevel: input.riskLevel,
    riskFlags: input.riskFlags ?? [],
    promptTemplateId: template.templateId,
    promptVersion: template.version,
    promptContentHash,
    contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
    contextManifest: manifest,
  })
}

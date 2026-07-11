// lib/stella/context/build-reviewer-context.ts
// Fase 5b — context for the reviewer roles. The full StellaProjectContext
// (outcomes, indicators, evidence metadata, proxies, filters, calculation
// snapshot, readiness) is exactly what every reviewer role needs, so this
// reuses the validator context builder rather than duplicating ~250 lines of
// metadata-only, org-scoped, PII-safe queries. The 'calculation' step just
// satisfies the validator builder's step gate; the resulting context is the
// whole project regardless of role.

import { buildValidatorContext, StellaBuildValidatorContextError } from './build-validator-context'
import type { StellaProjectContext } from './types'

export { StellaBuildValidatorContextError as StellaBuildReviewerContextError }

export async function buildReviewerContext(
  projectId: string,
  organizationId: string
): Promise<StellaProjectContext> {
  return buildValidatorContext(projectId, organizationId, 'calculation')
}

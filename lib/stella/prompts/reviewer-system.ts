// lib/stella/prompts/reviewer-system.ts
// Fase 5b — parameterized system/user prompt builder for the reviewer roles.
// All three share the reviewer output schema and SHARED_GUARDRAILS; only the
// focus and the emphasized context differ.

import { SHARED_GUARDRAILS } from './shared-guardrails'
import { buildStellaUserMessage } from './build-runtime-message'
import type { StellaProjectContext } from '../context/types'

export type ReviewerRole = 'proxy_reviewer' | 'evidence_reviewer' | 'audit_assistant'

type ReviewerRoleConfig = {
  /** Human-facing role name (Spanish, product UI language). */
  title: string
  /** Pipeline step recorded on the audit row. */
  pipelineStep: string
  /** Role-specific mandate injected into the system prompt. */
  mandate: string
}

export const REVIEWER_ROLE_CONFIG: Record<ReviewerRole, ReviewerRoleConfig> = {
  proxy_reviewer: {
    title: 'Revisor de Proxies',
    pipelineStep: 'Proxies',
    mandate: `You review the project's financial proxies for methodological soundness. Focus on:
- Source verifiability: is each proxy traceable to an official, documented source?
- Reference year: is the proxy's reference year documented and reasonable?
- Confidence & methodological risk: are low-confidence or high-risk proxies flagged?
- Appropriateness: does the proxy plausibly value the outcome it is assigned to?
- Over-claiming: any proxy that likely overstates the outcome's value?`,
  },
  evidence_reviewer: {
    title: 'Revisor de Evidencia',
    pipelineStep: 'Evidence',
    mandate: `You review the project's evidence for traceability and sufficiency. Focus on:
- Integrity: for file evidence, was integrity verification performed?
- Confidence justification: is the declared/derived confidence defensible?
- Linkage: is evidence linked to the outcomes/indicators it supports?
- Coverage gaps: which outcomes or indicators lack sufficient supporting evidence?
- Status: is anything still in draft/under review that a claim depends on?`,
  },
  audit_assistant: {
    title: 'Asistente de Auditoría',
    pipelineStep: 'Calculation',
    mandate: `You assess the overall audit-readiness of the SROI analysis. Focus on:
- Trail completeness: are outcomes, evidence, proxies, filters and the calculation run all present and coherent?
- Consistency: does the narrative match the outcomes and the calculated result?
- Readiness: what concrete gaps block external, audit-ready use?
- Prioritization: order the most important issues to resolve first.`,
  },
}

export function buildReviewerSystemPrompt(role: ReviewerRole): string {
  const cfg = REVIEWER_ROLE_CONFIG[role]
  return `You are Stella ${cfg.title}, a methodology review assistant for Uellix.

## Your Role

${cfg.mandate}

You analyze and flag issues for a human reviewer. You never approve, never decide, and never change any status — humans decide and act through Uellix's own review flows.

## Risk Levels

- **LOW:** Minor gaps, non-blocking.
- **MEDIUM:** Significant gaps. Recommend addressing before external use.
- **HIGH:** Critical gaps or risks. Should not be used externally without resolution.

${SHARED_GUARDRAILS}

## Output Format

You MUST respond with a JSON object matching this schema:
{
  "summary": "string (executive summary of the review)",
  "risk_level": "string (low|medium|high)",
  "findings": ["string (specific issues/gaps/observations — never approvals)"],
  "recommendations": ["string (concrete next steps for a human reviewer)"],
  "requires_human_review": true
}

IMPORTANT:
- requires_human_review MUST always be true (it is hardcoded).
- Return ONLY the JSON object. No markdown, no explanation outside JSON.
`
}

export function buildReviewerUserMessage(role: ReviewerRole, context: StellaProjectContext): string {
  // Etapa A1.5 (STL-A15-003): same shared summary fields and same
  // role-specific detail fields as before, now sent through the structural
  // TASK/UNTRUSTED_PROJECT_DATA/RESPONSE_REQUIREMENTS envelope instead of
  // concatenated markdown prose. No field added or removed.
  // Counts use distinct key names from the role-specific detail lists below
  // (e.g. proxiesCount vs. proxies) — a prior draft of this function reused
  // "proxies" for both, and the object spread below silently dropped the
  // count in favor of the list. Verified with a dedicated test.
  const shared = {
    outcomesCount: context.outcomesSnapshot.length,
    indicatorsCount: context.indicatorsSnapshot.length,
    evidenceItemsTotal: context.evidenceMetadata.length,
    evidenceItemsApproved: context.evidenceMetadata.filter((e) => e.status === 'approved').length,
    proxiesCount: context.proxySummary.length,
    sroiCalculation: context.calculationSnapshot
      ? `Yes (Ratio: ${context.calculationSnapshot.sroiRatio.toFixed(2)})`
      : 'Not yet calculated',
    readinessScore: context.readinessScore !== undefined ? `${context.readinessScore}/100` : 'N/A',
  }

  let detail: Record<string, unknown>
  if (role === 'proxy_reviewer') {
    detail = {
      proxies: context.proxySummary.map((p) => ({
        name: p.name,
        source: p.source,
        confidenceLevel: p.confidenceLevel ?? 'unknown',
        methodologicalRisk: p.methodologicalRisk ?? 'unknown',
      })),
      adjustmentFilters: context.filterSetsSummary.map((f) => ({
        deadweightPct: f.deadweightPct ?? null,
        attributionPct: f.attributionPct ?? null,
        displacementPct: f.displacementPct ?? null,
        dropoffPct: f.dropoffPct ?? null,
      })),
    }
  } else if (role === 'evidence_reviewer') {
    detail = {
      evidence: context.evidenceMetadata.map((e) => ({
        title: e.title,
        type: e.type,
        status: e.status,
        linkedToOutcome: Boolean(e.outcomeId),
        linkedToIndicator: Boolean(e.indicatorId),
      })),
      outcomeNames: context.outcomesSnapshot.map((o) => o.name),
    }
  } else {
    detail = {
      outcomeNames: context.outcomesSnapshot.map((o) => o.name),
      evidenceStatus: context.evidenceMetadata.map((e) => ({ title: e.title, status: e.status })),
      proxies: context.proxySummary.map((p) => ({ name: p.name, confidenceLevel: p.confidenceLevel ?? 'unknown' })),
    }
  }

  return buildStellaUserMessage({
    task: 'Please review this project and identify issues, gaps, and risks.',
    untrustedData: { ...shared, ...detail },
    responseRequirements: 'Be specific and concrete.',
  })
}

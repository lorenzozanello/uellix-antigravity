// lib/stella/prompts/reviewer-system.ts
// Fase 5b — parameterized system/user prompt builder for the reviewer roles.
// All three share the reviewer output schema and SHARED_GUARDRAILS; only the
// focus and the emphasized context differ.

import { SHARED_GUARDRAILS } from './shared-guardrails'
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
  const shared = `**Project Analysis State:**
- Outcomes: ${context.outcomesSnapshot.length}
- Indicators: ${context.indicatorsSnapshot.length}
- Evidence items: ${context.evidenceMetadata.length} (${context.evidenceMetadata.filter((e) => e.status === 'approved').length} approved)
- Proxies: ${context.proxySummary.length}
- SROI Calculation: ${context.calculationSnapshot ? `Yes (Ratio: ${context.calculationSnapshot.sroiRatio.toFixed(2)})` : 'Not yet calculated'}
- Readiness Score: ${context.readinessScore ?? 'N/A'}/100`

  let detail = ''
  if (role === 'proxy_reviewer') {
    detail = `\n**Proxies:**\n${
      context.proxySummary
        .map((p) => `- ${p.name} — source: ${p.source}; confidence: ${p.confidenceLevel ?? 'unknown'}; methodological risk: ${p.methodologicalRisk ?? 'unknown'}`)
        .join('\n') || 'No proxies assigned'
    }\n\n**Adjustment filters (per assignment):**\n${
      context.filterSetsSummary
        .map((f) => `- deadweight ${f.deadweightPct ?? '?'}%, attribution ${f.attributionPct ?? '?'}%, displacement ${f.displacementPct ?? '?'}%, drop-off ${f.dropoffPct ?? '?'}%`)
        .join('\n') || 'No filter sets'
    }`
  } else if (role === 'evidence_reviewer') {
    detail = `\n**Evidence:**\n${
      context.evidenceMetadata
        .map((e) => `- ${e.title} (${e.type}, ${e.status})${e.outcomeId ? ' [linked to an outcome]' : ''}${e.indicatorId ? ' [linked to an indicator]' : ''}`)
        .join('\n') || 'No evidence uploaded'
    }\n\n**Outcomes:** ${context.outcomesSnapshot.map((o) => o.name).join(', ') || 'None yet'}`
  } else {
    detail = `\n**Outcomes:** ${context.outcomesSnapshot.map((o) => o.name).join(', ') || 'None yet'}\n\n**Evidence status:**\n${
      context.evidenceMetadata.map((e) => `- ${e.title} (${e.status})`).join('\n') || 'No evidence'
    }\n\n**Proxies:**\n${
      context.proxySummary.map((p) => `- ${p.name} (${p.confidenceLevel ?? 'unknown'} confidence)`).join('\n') || 'No proxies'
    }`
  }

  return `Please review this project and identify issues, gaps, and risks. Be specific and concrete.\n\n${shared}\n${detail}`
}

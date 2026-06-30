// lib/stella/prompts/validator-system.ts
// Sprint 9B: Stella Validator system prompt builder

import { SHARED_GUARDRAILS } from './shared-guardrails'
import type { StellaProjectContext } from '../context/types'

export function buildValidatorSystemPrompt(): string {
  return `You are Stella Validator, the SROI methodology validation expert for Uellix.

## Your Role

Review the SROI analysis for methodological completeness, rigor, and audit readiness. Detect gaps, risks, and areas needing improvement.

## What You Check

1. **Evidence Coverage:** Are outcomes and indicators backed by sufficient evidence?
2. **Proxy Quality:** Are proxies from official sources with clear justification?
3. **Attribution & Deadweight:** Are adjustments well-justified?
4. **Data Consistency:** Does the narrative match the outcomes? Are there logical inconsistencies?
5. **Claims Risk:** Is the language audit-ready without overclaiming?
6. **Completeness:** What's missing before this analysis can be externally used?

## Risk Levels

- **LOW:** Minor gaps, non-blocking. User can proceed with awareness.
- **MEDIUM:** Significant gaps. Recommend addressing before external use.
- **HIGH:** Critical gaps or risks. Analysis should not be used externally without resolution.

${SHARED_GUARDRAILS}

## Output Format

You MUST respond with a JSON object matching this schema:
{
  "summary": "string (executive summary of validation)",
  "risk_level": "string (low|medium|high)",
  "evidence_gaps": ["string"],
  "proxy_risks": ["string"],
  "attribution_risks": ["string"],
  "claim_risks": ["string"],
  "recommendations": ["string"],
  "requires_human_review": true
}

IMPORTANT:
- requires_human_review MUST always be true (it is hardcoded)
- Return ONLY the JSON object. No markdown, no explanation outside JSON.
`
}

export function buildValidatorUserMessage(context: StellaProjectContext): string {
  const contextSummary = `
**Project Analysis State:**
- Outcomes defined: ${context.outcomesSnapshot.length}
- Indicators assigned: ${context.indicatorsSnapshot.length}
- Evidence items: ${context.evidenceMetadata.length} (${context.evidenceMetadata.filter(e => e.status === 'approved').length} approved)
- Proxies used: ${context.proxySummary.length}
- SROI Calculation: ${context.calculationSnapshot ? `Yes (Ratio: ${context.calculationSnapshot.sroiRatio.toFixed(2)})` : 'Not yet calculated'}
- Readiness Score: ${context.readinessScore ?? 'N/A'}/100

**Outcomes:** ${context.outcomesSnapshot.map(o => o.name).join(', ') || 'None yet'}

**Evidence Status:**
${context.evidenceMetadata.map(e => `- ${e.title} (${e.status})`).join('\n') || 'No evidence uploaded'}

**Proxies:**
${context.proxySummary.map(p => `- ${p.name} (${p.confidenceLevel || 'unknown'} confidence)`).join('\n') || 'No proxies assigned'}
`

  return `Please validate the following SROI analysis for methodological completeness and audit readiness.

${contextSummary}

Identify gaps, risks, and areas needing improvement. Be specific about what's missing or weak.`
}

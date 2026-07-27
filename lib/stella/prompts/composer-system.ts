// lib/stella/prompts/composer-system.ts
// Sprint 9B: Stella Composer system prompt builder

import { SHARED_GUARDRAILS } from './shared-guardrails'
import { buildStellaUserMessage } from './build-runtime-message'
import type { StellaProjectContext } from '../context/types'

export function buildComposerSystemPrompt(sectionType: string): string {
  return `You are Stella Composer, the expert report writer for Uellix SROI analyses.

## Your Role

Write clear, audit-ready content for SROI reports. Generate drafts that the user will review and edit before publication.

## Section Type: ${sectionType}

Write the "${sectionType}" section of the SROI impact report. Use language that is:
- Clear and accessible
- Methodologically rigorous
- Audit-ready (transparent about assumptions and limitations)
- NOT claiming automatic certification or guaranteed impact

## Guidelines

- Cite evidence explicitly (by ID when available)
- Reference proxies with sources
- Acknowledge assumptions
- State limitations clearly
- Use conditional language ("may," "suggests," "if data is complete")
- Mark what requires human review

${SHARED_GUARDRAILS}

## Output Format

You MUST respond with a JSON object matching this schema:
{
  "section_key": "string (section type)",
  "draft_title": "string",
  "draft_content": "string (markdown or plain text)",
  "assumptions": ["string"],
  "limitations": ["string"],
  "evidence_references": [
    { "evidenceId": "string", "title": "string", "context": "string" }
  ],
  "proxy_references": [
    { "proxyId": "string", "name": "string", "context": "string" }
  ]
}

IMPORTANT:
- draft_content is NOT persisted automatically - user must review and save
- Include a note that this draft requires human review and editing
- Return ONLY the JSON object. No markdown outside JSON.
`
}

export function buildComposerUserMessage(
  sectionType: string,
  context: StellaProjectContext
): string {
  // Etapa A1.5 (STL-A15-004): same fields as before (outcome names, impact
  // period, estimated social value, SROI ratio, approved-evidence count,
  // proxies-assigned count, and — for funder_breakdown — the same per-funder
  // formatted lines and unattributed-impact note), now sent through the
  // structural TASK/UNTRUSTED_PROJECT_DATA/RESPONSE_REQUIREMENTS envelope.
  // The per-funder line keeps its original "- Name (type): CUR X.XX invested
  // → SROI Y.YY:1" formatting deliberately, so composer-system.test.ts's
  // content assertions (funder names, ratios, the word "invested") continue
  // to hold without modification; only the 2 assertions that checked literal
  // markdown section headers ("Outcomes:", "**Funder Breakdown:**") — which
  // cannot survive a move to delimited JSON — were updated, with a comment
  // there explaining why.
  const untrustedData: Record<string, unknown> = {
    outcomes: context.outcomesSnapshot.map((o) => o.name),
    impactPeriod:
      context.filterSetsSummary.length > 0 ? `${context.filterSetsSummary[0].durationYears} years` : 'Not specified',
    estimatedSocialValue: context.calculationSnapshot
      ? `${context.calculationSnapshot.currency} ${context.calculationSnapshot.netSocialValue.toFixed(2)}`
      : 'TBD',
    sroiRatio: context.calculationSnapshot ? context.calculationSnapshot.sroiRatio.toFixed(2) : 'TBD',
    evidenceApprovedCount: context.evidenceMetadata.filter((e) => e.status === 'approved').length,
    proxiesAssignedCount: context.proxySummary.length,
  }

  let responseRequirements =
    'Generate a draft that is clear, audit-ready, and cites evidence/proxies explicitly. Remember that this is a DRAFT - the user will review and edit before publication.\n\n' +
    'Include explicit disclaimers about assumptions, limitations, and the need for human review.'

  if (sectionType === 'funder_breakdown' && context.calculationSnapshot?.fundersBreakdown) {
    const fb = context.calculationSnapshot.fundersBreakdown
    const currency = context.calculationSnapshot.currency

    untrustedData.fundersBreakdown = fb.map(
      (f) => `- ${f.funderName} (${f.funderType}): ${currency} ${f.investmentUsd.toFixed(2)} invested → SROI ${f.sroiRatio.toFixed(2)}:1`
    )

    if (context.calculationSnapshot.unattributedNsvUsd && context.calculationSnapshot.unattributedNsvUsd > 0) {
      untrustedData.unattributedImpact = `Unattributed impact (not yet allocated to funders): ${currency} ${context.calculationSnapshot.unattributedNsvUsd.toFixed(2)}`
    }

    responseRequirements =
      'For this section, provide:\n' +
      "1. Clear summary of each funder's financial contribution and attributed impact (SROI ratio)\n" +
      '2. Comparison of returns across funder types (if relevant)\n' +
      '3. Explanation of any unattributed impact\n' +
      '4. Methodology note that ratios are based on outcome allocations\n\n' +
      responseRequirements
  }

  return buildStellaUserMessage({
    task: `Please write the "${sectionType}" section of our SROI impact report.`,
    untrustedData,
    responseRequirements,
  })
}

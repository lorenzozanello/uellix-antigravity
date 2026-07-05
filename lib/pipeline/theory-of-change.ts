// lib/pipeline/theory-of-change.ts
// Fase 2a — structured theory of change (activity/output/outcome graph with
// typed causal links). Coexists with the free-text theoryOfChangeSummary field
// on impact_narratives; does not replace it. Outcome-type nodes reference real
// `outcomes` rows so the graph stays connected to the pipeline that actually
// feeds the SROI calculation, instead of becoming a parallel narrative.
// Design: docs/superpowers/specs/2026-07-05-theory-of-change-structured-design.md

export type ToCNodeType = 'activity' | 'output' | 'outcome'

/**
 * A causal link is only valid activity->output or output->outcome — modeling
 * the standard theory-of-change chain. A direct activity->outcome jump (or any
 * same-type / reversed-order link) must instead be documented as an assumption
 * on the intermediate output->outcome link, not modeled as its own edge.
 */
export function isValidLinkTransition(fromType: ToCNodeType, toType: ToCNodeType): boolean {
  return (fromType === 'activity' && toType === 'output') || (fromType === 'output' && toType === 'outcome')
}

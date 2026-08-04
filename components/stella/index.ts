// components/stella/index.ts
// Sprint 9C-2: Stella UI component exports

export { StellaAdvisorPanel } from './StellaAdvisorPanel'
export { StellaValidatorPanel } from './StellaValidatorPanel'
export { StellaComposerPanel } from './StellaComposerPanel'
export { StellaComposerSectionEditor } from './StellaComposerSectionEditor'
export { StellaReviewerPanel } from './StellaReviewerPanel'
export { StellaContextualAdvisorPanel } from './StellaContextualAdvisorPanel'
export { StellaContextualAdvisorField } from './StellaContextualAdvisorField'
export { sourceFieldLabel } from './source-field-label'
export type { SuggestionDecisionRecord, SuggestionDecisionAction } from './decision-types'
export {
  classifyFindingSupport,
  classifySuggestionSupport,
  buildEvidenceReferences,
  classifyAvailability,
  decisionStatusFromAction,
} from './grounding-model'
export type {
  EvidenceSupportLevel,
  EvidenceReference,
  StellaAvailabilityState,
  StellaDecisionStatus,
} from './grounding-model'

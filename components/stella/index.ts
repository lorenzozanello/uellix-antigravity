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
export { StellaGroundingBadge } from './StellaGroundingBadge'
export { StellaEvidencePanel } from './StellaEvidencePanel'
export { StellaAvailabilityNotice } from './StellaAvailabilityNotice'
export { StellaGroundedAnswerPanel } from './StellaGroundedAnswerPanel'
// TRAIN 2 — the GROUNDING → presentation adapter (INTEGRATION-001). The barrel
// is the surface other lines consume; nobody reaches into the module directly.
export {
  CITATION_EXCERPT_MAX_LENGTH,
  RELEVANCE_HIGH_MIN_SCORE,
  RELEVANCE_MEDIUM_MIN_SCORE,
  RELEVANCE_THRESHOLDS_VERSION,
  GroundedCitationError,
  adaptCitation,
  adaptContradiction,
  adaptGroundedAnswer,
  formatChunkLocation,
  presentationInputFromRetrieval,
  relevanceBucket,
} from './grounding-adapter'
export type {
  CitationAvailability,
  CitationExcerpt,
  CitationLocationView,
  CitationRelevanceBucket,
  GroundedAbstentionView,
  GroundedAnswerView,
  GroundedCitationErrorCode,
  GroundedCitationView,
  GroundedClaimView,
  GroundedContradictionView,
  GroundedPresentationInput,
  RelevanceAssessment,
} from './grounding-adapter'
// B-M3 (train 1): the RELEASE harness imports `error-messages` directly
// because the barrel did not publish it. Published here so the import path
// can move to the barrel without changing what the check pins.
export { stellaErrorPresentation } from './error-messages'
export type { StellaPanelErrorCode } from './error-messages'

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
// TRAIN 3 — the real request/response loop (grounded-query.ts, PRODUCT-002).
export { StellaGroundedQueryPanel } from './StellaGroundedQueryPanel'
export { isStellaGroundedQuerySuccess } from './grounded-query'
export type {
  StellaGroundedQueryRequest,
  StellaGroundedQueryResult,
  StellaGroundedQueryRunner,
  StellaGroundedQuerySuccess,
  StellaGroundedQueryFailure,
} from './grounded-query'
// TRAIN 2 — the GROUNDING → presentation adapter (INTEGRATION-001). The barrel
// is the surface other lines consume; nobody reaches into the module directly.
// `RELEVANCE_THRESHOLDS` / `RELEVANCE_THRESHOLDS_VERSION` are GROUNDING's, and
// pass through this barrel unchanged. PRODUCT's own `RELEVANCE_HIGH_MIN_SCORE`
// / `RELEVANCE_MEDIUM_MIN_SCORE` (0.6 / 0.3, `product-relevance-v1`) were
// RETIRED by integration in train 2: they were a second, silently divergent
// classification of the same evidence. See INTEGRATION-001 §6.
export {
  CITATION_EXCERPT_MAX_LENGTH,
  RELEVANCE_THRESHOLDS,
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
  GroundedContradictionClaimView,
  GroundedContradictionView,
  GroundedPresentationInput,
  RelevanceAssessment,
} from './grounding-adapter'
// B-M3 (train 1): the RELEASE harness imports `error-messages` directly
// because the barrel did not publish it. Published here so the import path
// can move to the barrel without changing what the check pins.
export { stellaErrorPresentation } from './error-messages'
export type { StellaPanelErrorCode } from './error-messages'

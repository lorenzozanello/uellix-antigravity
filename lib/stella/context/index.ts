// lib/stella/context/index.ts
export type {
  StellaProjectContext,
  OutcomeRef,
  IndicatorRef,
  EvidenceMeta,
  ProxyRef,
  FilterRef,
  CalculationSnapshot,
  SectionRef,
} from './types'
export { sanitizeString, sanitizeNarrative, sanitizeOutcome, markAsData, hasForbiddenPattern } from './sanitize'

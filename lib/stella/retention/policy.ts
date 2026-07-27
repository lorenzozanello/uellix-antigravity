// lib/stella/retention/policy.ts
// Etapa A2.4 (DR-004 aprobado). Single source of truth for the retention
// taxonomy and its versioned defaults — never resolvable from client input.
//
// Scope discipline: only `interaction_response_content` has an ACTIVE,
// executable purge path in this stage (batch/dry-run/apply/hold, see
// ./purge-service.ts). The other 5 categories are documented here with their
// approved retention intent, but this stage does NOT implement a purge
// mechanism for them, because no reliable "contractual closure" event exists
// anywhere in the schema today (`organizations` has no `closed_at`/
// `contract_end_date`/`terminated_at` column — confirmed by inventory before
// writing this file). Building a purge engine for an event that doesn't
// exist would mean inventing metadata, which this codebase's established
// convention (see STELLA_A2_DR002_DR003_IMPLEMENTATION_REPORT.md) explicitly
// treats as a documented gap, not something to fabricate. See
// STELLA_A2_DR004_RETENTION_IMPLEMENTATION_REPORT.md §5 for the full gap
// analysis and the follow-up task to connect this once a real closure event
// exists (organization lifecycle work, out of scope here).

/**
 * Bumped whenever the periods/bounds in this file change materially. A purge
 * run always records the version it applied — never inferred after the
 * fact. No automatic date-based versioning — a new version is a deliberate,
 * reviewed code change.
 */
export const STELLA_RETENTION_POLICY_VERSION = 'v1'

export const DEFAULT_RESPONSE_RETENTION_MONTHS = 24
export const MIN_RESPONSE_RETENTION_MONTHS = 1
export const MAX_RESPONSE_RETENTION_MONTHS = 60

/** Post-closure retention for audit/governance metadata — see the header note: not enforced by an executable purge in this stage (no closure event exists yet). Documented for when that event is connected. */
export const POST_CLOSURE_AUDIT_RETENTION_YEARS = 5

export type StellaRetentionCategory =
  | 'interaction_metadata'
  | 'interaction_response_content'
  | 'context_manifest'
  | 'consent_events'
  | 'aggregation_declarations'
  | 'audit_logs'

export type RetentionDeleteType = 'none' | 'redaction' | 'logical' | 'physical'

export interface RetentionCategoryRule {
  category: StellaRetentionCategory
  table: string
  /** Only the fields this category actually governs — never "the whole row" unless the category IS the whole row. */
  fields: readonly string[]
  sensitivity: 'low' | 'medium' | 'high'
  /** Human-readable description of the default period — the executable value (if any) lives in the constants above. */
  defaultPeriodDescription: string
  /** What starts the clock, e.g. 'interaction.createdAt'. `null` = no clock runs today (see gap note). */
  triggerEvent: string | null
  actionOnExpiry: 'none' | 'redact_field' | 'purge_row'
  organizationConfigurable: boolean
  holdApplicable: boolean
  preservesMetadata: boolean
  deleteType: RetentionDeleteType
}

/**
 * The 6 categories this session inventoried — no category is listed here
 * that doesn't already exist as a real table/field in db/schema.ts. Only
 * `interaction_response_content` has `actionOnExpiry !== 'none'`, matching
 * the single executable purge path this stage builds.
 */
export const STELLA_RETENTION_CATEGORIES: Readonly<Record<StellaRetentionCategory, RetentionCategoryRule>> = {
  interaction_metadata: {
    category: 'interaction_metadata',
    table: 'stella_interactions',
    fields: ['id', 'organizationId', 'projectId', 'createdBy', 'stellaRole', 'pipelineStep', 'contextHash', 'modelUsed', 'tokensUsed', 'riskLevel', 'riskFlags', 'promptTemplateId', 'promptVersion', 'promptContentHash', 'contextSchemaVersion', 'createdAt'],
    sensitivity: 'low',
    defaultPeriodDescription: 'Mientras la organización mantenga su cuenta activa, y 5 años tras el cierre contractual (evento no disponible hoy — ver gap documentado).',
    triggerEvent: null,
    actionOnExpiry: 'none',
    organizationConfigurable: false,
    holdApplicable: false,
    preservesMetadata: true,
    deleteType: 'none',
  },
  interaction_response_content: {
    category: 'interaction_response_content',
    table: 'stella_interactions',
    fields: ['responseJson'],
    sensitivity: 'high',
    defaultPeriodDescription: `${DEFAULT_RESPONSE_RETENTION_MONTHS} meses por defecto, configurable por organización entre ${MIN_RESPONSE_RETENTION_MONTHS} y ${MAX_RESPONSE_RETENTION_MONTHS} meses.`,
    triggerEvent: 'stella_interactions.created_at', // snake_case column reference, not the Drizzle table export — this file has no DB import
    actionOnExpiry: 'redact_field',
    organizationConfigurable: true,
    holdApplicable: true,
    preservesMetadata: true,
    deleteType: 'redaction',
  },
  context_manifest: {
    category: 'context_manifest',
    table: 'stella_interactions',
    fields: ['contextManifest'],
    sensitivity: 'low',
    defaultPeriodDescription: 'Mismo periodo que los metadatos de auditoría (no contiene payload textual bruto). No se purga en esta etapa.',
    triggerEvent: null,
    actionOnExpiry: 'none',
    organizationConfigurable: false,
    holdApplicable: false,
    preservesMetadata: true,
    deleteType: 'none',
  },
  consent_events: {
    category: 'consent_events',
    table: 'stella_ai_consent_events',
    fields: ['id', 'organizationId', 'eventType', 'aiTermsVersion', 'dataPolicyVersion', 'capabilityScope', 'actorUserId', 'occurredAt', 'reason', 'supersedesEventId', 'metadata'],
    sensitivity: 'low',
    defaultPeriodDescription: 'Mientras la organización exista, y el periodo posterior que defina A3/contrato. Registro de gobernanza append-only — nunca purgado bajo la política de respuestas.',
    triggerEvent: null,
    actionOnExpiry: 'none',
    organizationConfigurable: false,
    holdApplicable: false,
    preservesMetadata: true,
    deleteType: 'none',
  },
  aggregation_declarations: {
    category: 'aggregation_declarations',
    table: 'stella_sensitive_aggregation_declarations',
    fields: ['id', 'organizationId', 'projectId', 'entityType', 'entityId', 'sensitiveCategory', 'groupSize', 'groupSizeBucket', 'dimensions', 'countSourceType', 'countSourceId', 'countSourceNote', 'verificationStatus', 'declaredBy', 'verifiedBy', 'verifiedAt', 'policyVersion', 'minimumGroupSizeApplied', 'revokedBy', 'revokedAt', 'revocationReason', 'supersedesDeclarationId', 'supersededByDeclarationId'],
    sensitivity: 'medium',
    defaultPeriodDescription: 'Mientras la organización exista, y el periodo posterior que defina A3/contrato. Parte del linaje metodológico — nunca purgada bajo la política de respuestas.',
    triggerEvent: null,
    actionOnExpiry: 'none',
    organizationConfigurable: false,
    holdApplicable: false,
    preservesMetadata: true,
    deleteType: 'none',
  },
  audit_logs: {
    category: 'audit_logs',
    table: 'audit_logs',
    fields: ['id', 'organizationId', 'projectId', 'actorUserId', 'entityType', 'entityId', 'action', 'beforeJson', 'afterJson', 'reason', 'ipAddress', 'userAgent', 'createdAt'],
    sensitivity: 'low',
    defaultPeriodDescription: 'Mientras la organización exista, y el periodo posterior que defina A3/contrato. Append-only, valor probatorio — nunca purgado en esta etapa.',
    triggerEvent: null,
    actionOnExpiry: 'none',
    organizationConfigurable: false,
    holdApplicable: false,
    preservesMetadata: true,
    deleteType: 'none',
  },
}

export interface StellaRetentionPolicy {
  policyVersion: string
  defaultResponseRetentionMonths: number
  minResponseRetentionMonths: number
  maxResponseRetentionMonths: number
}

/** Injectable for tests (mirrors lib/stella/aggregation/policy.ts's SensitiveAggregationPolicy pattern) — never mutate this constant to make a test pass. */
export const CURRENT_STELLA_RETENTION_POLICY: StellaRetentionPolicy = {
  policyVersion: STELLA_RETENTION_POLICY_VERSION,
  defaultResponseRetentionMonths: DEFAULT_RESPONSE_RETENTION_MONTHS,
  minResponseRetentionMonths: MIN_RESPONSE_RETENTION_MONTHS,
  maxResponseRetentionMonths: MAX_RESPONSE_RETENTION_MONTHS,
}

export function isValidResponseRetentionMonths(value: unknown, policy: StellaRetentionPolicy = CURRENT_STELLA_RETENTION_POLICY): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= policy.minResponseRetentionMonths && value <= policy.maxResponseRetentionMonths
}

// ---------------------------------------------------------------------------
// Preservation hold vocabularies — kept here (not in hold-service.ts) because
// this module has zero DB imports and is therefore safe to import from a
// 'use client' component (e.g. components/retention/StellaRetentionPanel.tsx),
// unlike hold-service.ts which pulls in Drizzle/postgres.
// ---------------------------------------------------------------------------

export const ALLOWED_HOLD_TYPES = ['legal_hold', 'audit_investigation', 'dispute', 'contractual_obligation', 'authorized_preservation'] as const
export type HoldType = (typeof ALLOWED_HOLD_TYPES)[number]

/** Fixed vocabulary — never a free-text description of the underlying matter. */
export const ALLOWED_HOLD_REASON_CODES = ['pending_legal_review', 'regulatory_request', 'active_dispute', 'incident_investigation', 'contractual_requirement'] as const
export type HoldReasonCode = (typeof ALLOWED_HOLD_REASON_CODES)[number]

export function isAllowedHoldType(value: unknown): value is HoldType {
  return typeof value === 'string' && (ALLOWED_HOLD_TYPES as readonly string[]).includes(value)
}
export function isAllowedHoldReasonCode(value: unknown): value is HoldReasonCode {
  return typeof value === 'string' && (ALLOWED_HOLD_REASON_CODES as readonly string[]).includes(value)
}

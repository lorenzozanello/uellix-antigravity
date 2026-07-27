// lib/stella/aggregation/types.ts
// Etapa A2.3.1 (STL-A231-002/003). Shared types for the sensitive-aggregation
// declaration system. See policy.ts for the fixed vocabularies these types
// draw from, and declaration-service.ts's header for the minimization
// invariants (never store names, diagnoses, testimonies, addresses, full
// source text, or anything sent to Stella).

import type { SensitivePopulationCategory } from '../context/sensitive-population'
import type { SensitiveEntityType, CountSourceType, GroupSizeBucket } from './policy'

/** Only 'aggregate' is accepted in this stage — no 'individual' level exists for a declaration. */
export type DeclarationAggregationLevel = 'aggregate'

export type DeclarationVerificationStatus = 'pending' | 'verified' | 'revoked' | 'superseded'

/** A declaration's sensitiveCategory reuses the SAME fixed set the text classifier uses — 'none' is never valid here (a declaration only exists to cover a sensitive category). */
export type DeclarationSensitiveCategory = Exclude<SensitivePopulationCategory, 'none'>

export interface CreateDeclarationInput {
  organizationId: string
  projectId: string
  entityType: SensitiveEntityType
  entityId: string
  sensitiveCategory: DeclarationSensitiveCategory
  groupSize: number
  dimensions: string[]
  countSourceType: CountSourceType
  /** Structural reference only (e.g. an indicator id) — never the source's content. */
  countSourceId?: string | null
  /** Short structural note (e.g. "manual verification, board minutes ref #12") — never sensitive content. */
  countSourceNote?: string | null
  declaredByUserId: string
  /** Set only when this declaration supersedes a prior one (a material change) — see supersedeSensitiveAggregationDeclaration. */
  supersedesDeclarationId?: string
}

export interface VerifyDeclarationInput {
  declarationId: string
  organizationId: string
  verifiedByUserId: string
}

export interface RevokeDeclarationInput {
  declarationId: string
  organizationId: string
  revokedByUserId: string
  reason?: string
}

/**
 * The only shape ANY caller (including a `viewer`) can receive from the
 * query layer — deliberately excludes declaredBy/verifiedBy/revokedBy and
 * any reason/note text. This is the "summary" view the RLS policy header
 * documents as an application-layer, not row-level, restriction.
 */
export interface SensitiveAggregationDeclarationStatus {
  status:
    | 'valid'
    | 'missing'
    | 'pending'
    | 'revoked'
    | 'superseded'
    | 'outdated_policy'
    | 'below_threshold'
    | 'invalid_dimensions'
  declarationId?: string
  category?: DeclarationSensitiveCategory
  groupSizeBucket?: GroupSizeBucket
  minimumGroupSizeApplied?: number
  policyVersion?: string
  verifiedAt?: Date
}

export interface DeclarationRecord {
  id: string
  organizationId: string
  projectId: string
  entityType: SensitiveEntityType
  entityId: string
  sensitiveCategory: DeclarationSensitiveCategory
  aggregationLevel: DeclarationAggregationLevel
  groupSize: number
  groupSizeBucket: GroupSizeBucket
  dimensions: string[]
  countSourceType: CountSourceType
  countSourceId: string | null
  countSourceNote: string | null
  verificationStatus: DeclarationVerificationStatus
  declaredBy: string
  verifiedBy: string | null
  verifiedAt: Date | null
  policyVersion: string
  minimumGroupSizeApplied: number | null
  revokedBy: string | null
  revokedAt: Date | null
  revocationReason: string | null
  supersedesDeclarationId: string | null
  supersededByDeclarationId: string | null
  createdAt: Date
  updatedAt: Date
}

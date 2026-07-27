// lib/stella/aggregation/mappers.ts
// Etapa A2.3.2 (STL-A232-010) — shared row → DeclarationRecord mapping, used
// by both declaration-service.ts (verify's return value) and
// declaration-query.ts (the history list for the UI). A pure function, no DB
// access, no side effects.

import type { stellaSensitiveAggregationDeclarations } from '@/db/schema'
import type { DeclarationRecord } from './types'

export function toDeclarationRecord(row: typeof stellaSensitiveAggregationDeclarations.$inferSelect): DeclarationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    entityType: row.entityType as DeclarationRecord['entityType'],
    entityId: row.entityId,
    sensitiveCategory: row.sensitiveCategory as DeclarationRecord['sensitiveCategory'],
    aggregationLevel: row.aggregationLevel as DeclarationRecord['aggregationLevel'],
    groupSize: row.groupSize,
    groupSizeBucket: row.groupSizeBucket as DeclarationRecord['groupSizeBucket'],
    dimensions: row.dimensions ?? [],
    countSourceType: row.countSourceType as DeclarationRecord['countSourceType'],
    countSourceId: row.countSourceId,
    countSourceNote: row.countSourceNote,
    verificationStatus: row.verificationStatus as DeclarationRecord['verificationStatus'],
    declaredBy: row.declaredBy,
    verifiedBy: row.verifiedBy,
    verifiedAt: row.verifiedAt,
    policyVersion: row.policyVersion,
    minimumGroupSizeApplied: row.minimumGroupSizeApplied,
    revokedBy: row.revokedBy,
    revokedAt: row.revokedAt,
    revocationReason: row.revocationReason,
    supersedesDeclarationId: row.supersedesDeclarationId,
    supersededByDeclarationId: row.supersededByDeclarationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

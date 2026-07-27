// lib/stella/aggregation/entity-validation.ts
// Etapa A2.3.1 (STL-A231-002). A polymorphic (entityType, entityId) reference
// has no FK Postgres can enforce across 6 different tables, so this module
// IS the integrity check: for every ALLOWED_SENSITIVE_ENTITY_TYPES value, it
// verifies the row exists AND belongs to the given organization/project
// before a declaration can be created for it. Called by
// declaration-service.ts on every create — never skipped, never cached
// across calls.

import { db } from '@/db/client'
import { eq, and } from 'drizzle-orm'
import {
  projects,
  outcomes,
  indicators,
  stakeholderGroups,
  evidenceItems,
  sroiReportSections,
} from '@/db/schema'
import type { SensitiveEntityType } from './policy'

export interface EntityScopeCheckInput {
  entityType: SensitiveEntityType
  entityId: string
  organizationId: string
  projectId: string
}

export type EntityScopeCheckResult =
  | { valid: true }
  | { valid: false; reason: 'not_found' | 'organization_mismatch' | 'project_mismatch' }

/**
 * One query per entity type, each shaped exactly like the ownership checks
 * already used in build-advisor-context.ts / build-composer-context.ts /
 * build-validator-context.ts — same fail-closed pattern (a missing row or a
 * mismatched organization/project is `valid: false`, never assumed valid).
 */
export async function validateEntityScope(input: EntityScopeCheckInput): Promise<EntityScopeCheckResult> {
  switch (input.entityType) {
    case 'project': {
      // For entityType 'project', entityId MUST equal projectId — a
      // declaration about "the project" cannot reference a different
      // project's row.
      if (input.entityId !== input.projectId) {
        return { valid: false, reason: 'project_mismatch' }
      }
      const row = await db
        .select({ id: projects.id, organizationId: projects.organizationId })
        .from(projects)
        .where(eq(projects.id, input.entityId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      if (!row) return { valid: false, reason: 'not_found' }
      if (row.organizationId !== input.organizationId) return { valid: false, reason: 'organization_mismatch' }
      return { valid: true }
    }

    case 'outcome': {
      const row = await db
        .select({ id: outcomes.id, projectId: outcomes.projectId })
        .from(outcomes)
        .where(eq(outcomes.id, input.entityId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      if (!row) return { valid: false, reason: 'not_found' }
      if (row.projectId !== input.projectId) return { valid: false, reason: 'project_mismatch' }
      return await confirmProjectOrganization(input.projectId, input.organizationId)
    }

    case 'indicator': {
      const row = await db
        .select({ id: indicators.id, projectId: indicators.projectId })
        .from(indicators)
        .where(eq(indicators.id, input.entityId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      if (!row) return { valid: false, reason: 'not_found' }
      if (row.projectId !== input.projectId) return { valid: false, reason: 'project_mismatch' }
      return await confirmProjectOrganization(input.projectId, input.organizationId)
    }

    case 'stakeholder_group': {
      const row = await db
        .select({ id: stakeholderGroups.id, projectId: stakeholderGroups.projectId })
        .from(stakeholderGroups)
        .where(eq(stakeholderGroups.id, input.entityId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      if (!row) return { valid: false, reason: 'not_found' }
      if (row.projectId !== input.projectId) return { valid: false, reason: 'project_mismatch' }
      return await confirmProjectOrganization(input.projectId, input.organizationId)
    }

    case 'evidence': {
      const row = await db
        .select({ id: evidenceItems.id, projectId: evidenceItems.projectId, organizationId: evidenceItems.organizationId })
        .from(evidenceItems)
        .where(eq(evidenceItems.id, input.entityId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      if (!row) return { valid: false, reason: 'not_found' }
      if (row.organizationId !== input.organizationId) return { valid: false, reason: 'organization_mismatch' }
      if (row.projectId !== input.projectId) return { valid: false, reason: 'project_mismatch' }
      return { valid: true }
    }

    case 'report_section': {
      const row = await db
        .select({ id: sroiReportSections.id, projectId: sroiReportSections.projectId, organizationId: sroiReportSections.organizationId })
        .from(sroiReportSections)
        .where(eq(sroiReportSections.id, input.entityId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      if (!row) return { valid: false, reason: 'not_found' }
      if (row.organizationId !== input.organizationId) return { valid: false, reason: 'organization_mismatch' }
      if (row.projectId !== input.projectId) return { valid: false, reason: 'project_mismatch' }
      return { valid: true }
    }
  }
}

async function confirmProjectOrganization(projectId: string, organizationId: string): Promise<EntityScopeCheckResult> {
  const project = await db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .where(and(eq(projects.id, projectId)))
    .limit(1)
    .then((rows) => rows[0] ?? null)
  if (!project) return { valid: false, reason: 'not_found' }
  if (project.organizationId !== organizationId) return { valid: false, reason: 'organization_mismatch' }
  return { valid: true }
}

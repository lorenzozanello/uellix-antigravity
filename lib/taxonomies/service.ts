// lib/taxonomies/service.ts
// Fase 3 — interoperability crosswalks between an org's outcomes and external
// standard codes (ODS, IRIS+, ...). Catalogs/codes are global reference data;
// mappings are org-scoped, authorized (outcome-edit roles) and audited.
// A mapping is a comparability reference, never a certification of equivalence.

import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import {
  projects,
  outcomes,
  taxonomyCatalogs,
  taxonomyCodes,
  outcomeTaxonomyMappings,
} from '@/db/schema'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

export type OutcomeMappingView = {
  id: string
  outcomeId: string
  catalogCode: string
  catalogName: string
  code: string
  label: string
  mappingConfidence: 'low' | 'medium' | 'high'
  rationale: string | null
}

export type CatalogWithCodes = {
  id: string
  code: string
  name: string
  version: string
  sourceUrl: string | null
  codes: { id: string; code: string; label: string }[]
}

// Outcome edits (and thus their crosswalks) are open to the same roles as the
// rest of the outcomes pipeline.
const MAPPING_ROLES = ['super_admin', 'organization_admin', 'impact_manager', 'analyst']

/** Group a flat list of mappings by catalog for display, preserving order. */
export function groupMappingsByCatalog(
  mappings: OutcomeMappingView[]
): { catalogCode: string; catalogName: string; items: OutcomeMappingView[] }[] {
  const groups: { catalogCode: string; catalogName: string; items: OutcomeMappingView[] }[] = []
  const byCode = new Map<string, (typeof groups)[number]>()
  for (const m of mappings) {
    let group = byCode.get(m.catalogCode)
    if (!group) {
      group = { catalogCode: m.catalogCode, catalogName: m.catalogName, items: [] }
      byCode.set(m.catalogCode, group)
      groups.push(group)
    }
    group.items.push(m)
  }
  return groups
}

async function authorizeProject(projectId: string) {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('Unauthenticated')
  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))
  if (proj.length === 0) throw new Error('Project not found or not owned')
  return ctx
}

/** Global reference catalogs with their codes — for the mapping picker. */
export async function listCatalogsWithCodes(): Promise<CatalogWithCodes[]> {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('Unauthenticated')

  const catalogs = await db.select().from(taxonomyCatalogs)
  if (catalogs.length === 0) return []

  const codes = await db
    .select()
    .from(taxonomyCodes)
    .where(inArray(taxonomyCodes.catalogId, catalogs.map((c) => c.id)))
    .orderBy(taxonomyCodes.sortOrder, taxonomyCodes.code)

  return catalogs.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    version: c.version,
    sourceUrl: c.sourceUrl,
    codes: codes
      .filter((code) => code.catalogId === c.id)
      .map((code) => ({ id: code.id, code: code.code, label: code.label })),
  }))
}

/** All crosswalk mappings for a project's outcomes (org-scoped, joined view). */
export async function listOutcomeMappingsForProject(projectId: string): Promise<OutcomeMappingView[]> {
  const ctx = await authorizeProject(projectId)
  const rows = await db
    .select({
      id: outcomeTaxonomyMappings.id,
      outcomeId: outcomeTaxonomyMappings.outcomeId,
      catalogCode: taxonomyCatalogs.code,
      catalogName: taxonomyCatalogs.name,
      code: taxonomyCodes.code,
      label: taxonomyCodes.label,
      mappingConfidence: outcomeTaxonomyMappings.mappingConfidence,
      rationale: outcomeTaxonomyMappings.rationale,
    })
    .from(outcomeTaxonomyMappings)
    .innerJoin(taxonomyCodes, eq(outcomeTaxonomyMappings.taxonomyCodeId, taxonomyCodes.id))
    .innerJoin(taxonomyCatalogs, eq(taxonomyCodes.catalogId, taxonomyCatalogs.id))
    .where(
      and(
        eq(outcomeTaxonomyMappings.projectId, projectId),
        eq(outcomeTaxonomyMappings.organizationId, ctx.organization.id)
      )
    )
  return rows as OutcomeMappingView[]
}

const MappingInputSchema = z.object({
  outcomeId: z.string().uuid(),
  taxonomyCodeId: z.string().uuid(),
  mappingConfidence: z.enum(['low', 'medium', 'high']).default('medium'),
  rationale: z.string().max(2000).optional(),
})

export type OutcomeMappingInput = z.input<typeof MappingInputSchema>

/** Map an outcome to a standard code. Authorized + audited. Idempotent-safe:
 *  rejects a duplicate (outcome, code) pair with a clear message. */
export async function createOutcomeMapping(projectId: string, input: OutcomeMappingInput) {
  const ctx = await authorizeProject(projectId)
  if (!MAPPING_ROLES.includes(ctx.membership.role)) {
    throw new Error('Permission denied: outcome-edit role required to map outcomes')
  }
  const validated = MappingInputSchema.parse(input)

  // The outcome must belong to this project/org.
  const outcome = await db
    .select({ id: outcomes.id })
    .from(outcomes)
    .where(and(eq(outcomes.id, validated.outcomeId), eq(outcomes.projectId, projectId)))
    .then((r) => r[0] ?? null)
  if (!outcome) throw new Error('Outcome not found in this project')

  // The taxonomy code must exist (global reference data).
  const code = await db
    .select({ id: taxonomyCodes.id })
    .from(taxonomyCodes)
    .where(eq(taxonomyCodes.id, validated.taxonomyCodeId))
    .then((r) => r[0] ?? null)
  if (!code) throw new Error('Taxonomy code not found')

  const existing = await db
    .select({ id: outcomeTaxonomyMappings.id })
    .from(outcomeTaxonomyMappings)
    .where(
      and(
        eq(outcomeTaxonomyMappings.outcomeId, validated.outcomeId),
        eq(outcomeTaxonomyMappings.taxonomyCodeId, validated.taxonomyCodeId)
      )
    )
  if (existing.length > 0) throw new Error('This outcome is already mapped to that code')

  const created = await db
    .insert(outcomeTaxonomyMappings)
    .values({
      organizationId: ctx.organization.id,
      projectId,
      outcomeId: validated.outcomeId,
      taxonomyCodeId: validated.taxonomyCodeId,
      mappingConfidence: validated.mappingConfidence,
      rationale: validated.rationale,
      createdBy: ctx.user.id,
    })
    .returning()
    .then((r) => r[0])

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'outcome_taxonomy_mapping',
    entityId: created.id,
    action: AUDIT_ACTIONS.TAXONOMY_MAPPING_CREATED,
    afterJson: created as unknown as Record<string, unknown>,
  })
  return created
}

/** Remove a crosswalk mapping. Authorized + audited. */
export async function deleteOutcomeMapping(projectId: string, mappingId: string) {
  const ctx = await authorizeProject(projectId)
  if (!MAPPING_ROLES.includes(ctx.membership.role)) {
    throw new Error('Permission denied: outcome-edit role required to unmap outcomes')
  }

  const existing = await db
    .select()
    .from(outcomeTaxonomyMappings)
    .where(
      and(
        eq(outcomeTaxonomyMappings.id, mappingId),
        eq(outcomeTaxonomyMappings.projectId, projectId),
        eq(outcomeTaxonomyMappings.organizationId, ctx.organization.id)
      )
    )
    .then((r) => r[0] ?? null)
  if (!existing) throw new Error('Mapping not found')

  await db.delete(outcomeTaxonomyMappings).where(eq(outcomeTaxonomyMappings.id, mappingId))

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'outcome_taxonomy_mapping',
    entityId: mappingId,
    action: AUDIT_ACTIONS.TAXONOMY_MAPPING_DELETED,
    beforeJson: existing as unknown as Record<string, unknown>,
  })
  return { id: mappingId }
}

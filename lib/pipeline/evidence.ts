// lib/pipeline/evidence.ts

import { db } from '@/db/client'
import { evidenceItems, projects, outcomes, indicators } from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import { createClient } from '@/lib/supabase/server'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { hasRole } from '@/lib/auth/permissions'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { z } from 'zod'
import crypto from 'crypto'

// Types
export type EvidenceStatus = 'draft' | 'under_review' | 'approved' | 'rejected' | 'archived'
export type EvidenceType = 'file' | 'url' | 'text'

// Validation schemas
const CreateFileEvidenceSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeId: z.string().uuid().optional(),
  indicatorId: z.string().uuid().optional(),
  file: z.object({
    name: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().int().positive(),
    buffer: z.instanceof(Buffer),
  }),
})

const CreateUrlEvidenceSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeId: z.string().uuid().optional(),
  indicatorId: z.string().uuid().optional(),
  url: z.string().url(),
})

const CreateTextEvidenceSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeId: z.string().uuid().optional(),
  indicatorId: z.string().uuid().optional(),
  text: z.string().min(1),
})

const UpdateReviewStatusSchema = z.object({
  status: z.enum(['under_review', 'approved', 'rejected'] as const),
  reviewNotes: z.string().optional(),
})

// Helpers
async function verifyProjectOwnership(projectId: string, orgId: string) {
  const proj = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!proj.length || proj[0].organizationId !== orgId) {
    throw new Error('Project does not belong to your organization')
  }
  return proj[0]
}

async function verifyOutcomeIndicator(projectId: string, outcomeId?: string, indicatorId?: string) {
  if (outcomeId) {
    const out = await db.select().from(outcomes).where(eq(outcomes.id, outcomeId)).limit(1)
    if (!out.length || out[0].projectId !== projectId) {
      throw new Error('Outcome does not belong to the project')
    }
  }
  if (indicatorId) {
    const ind = await db.select().from(indicators).where(eq(indicators.id, indicatorId)).limit(1)
    if (!ind.length || ind[0].projectId !== projectId) {
      throw new Error('Indicator does not belong to the project')
    }
  }
}

// Service functions
export async function listEvidenceForProject(projectId: string) {
  const { organization } = await requireOrganizationAccess()
  await verifyProjectOwnership(projectId, organization.id)
  return db.select().from(evidenceItems).where(eq(evidenceItems.projectId, projectId))
}

export async function getEvidenceByIdForProject(projectId: string, evidenceId: string) {
  const { organization } = await requireOrganizationAccess()
  await verifyProjectOwnership(projectId, organization.id)
  const rows = await db
    .select()
    .from(evidenceItems)
    .where(and(eq(evidenceItems.projectId, projectId), eq(evidenceItems.id, evidenceId)))
  if (!rows.length) throw new Error('Evidence not found')
  return rows[0]
}

export async function createFileEvidenceForProject(projectId: string, input: unknown) {
  const { membership, organization, user } = await requireOrganizationAccess()
  if (!hasRole(membership.role, 'analyst')) {
    throw new Error('Insufficient permissions to upload evidence')
  }
  const parsed = CreateFileEvidenceSchema.parse(input)
  await verifyProjectOwnership(projectId, organization.id)
  await verifyOutcomeIndicator(projectId, parsed.outcomeId, parsed.indicatorId)

  const sha256 = crypto.createHash('sha256').update(parsed.file.buffer).digest('hex')

  const [evidence] = await db
    .insert(evidenceItems)
    .values({
      projectId,
      organizationId: organization.id,
      type: 'file',
      title: parsed.title,
      description: parsed.description,
      outcomeId: parsed.outcomeId,
      indicatorId: parsed.indicatorId,
      fileSize: parsed.file.size,
      mimeType: parsed.file.mimeType,
      contentHash: sha256,
      status: 'draft',
      createdBy: user.id,
    })
    .returning()

  const supabase = await createClient()
  const bucket = 'uellix-evidence'
  const filePath = `${projectId}/${evidence.id}/${parsed.file.name}`
  const { error } = await supabase.storage.from(bucket).upload(filePath, parsed.file.buffer, {
    contentType: parsed.file.mimeType,
    upsert: false,
  })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)

  await db.update(evidenceItems).set({ filePath }).where(eq(evidenceItems.id, evidence.id))

  await logAuditAction({
    organizationId: organization.id,
    projectId,
    actorUserId: user.id,
    entityType: 'evidence_item',
    entityId: evidence.id,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    afterJson: { type: 'file', title: parsed.title, sha256 },
  })

  return evidence
}

export async function createUrlEvidenceForProject(projectId: string, input: unknown) {
  const { membership, organization, user } = await requireOrganizationAccess()
  if (!hasRole(membership.role, 'analyst')) {
    throw new Error('Insufficient permissions to create URL evidence')
  }
  const parsed = CreateUrlEvidenceSchema.parse(input)
  await verifyProjectOwnership(projectId, organization.id)
  await verifyOutcomeIndicator(projectId, parsed.outcomeId, parsed.indicatorId)

  const normalizedUrl = parsed.url.trim().toLowerCase()
  const sha256 = crypto.createHash('sha256').update(normalizedUrl).digest('hex')

  const [evidence] = await db
    .insert(evidenceItems)
    .values({
      projectId,
      organizationId: organization.id,
      type: 'url',
      title: parsed.title,
      description: parsed.description,
      outcomeId: parsed.outcomeId,
      indicatorId: parsed.indicatorId,
      url: normalizedUrl,
      contentHash: sha256,
      status: 'draft',
      createdBy: user.id,
    })
    .returning()

  await logAuditAction({
    organizationId: organization.id,
    projectId,
    actorUserId: user.id,
    entityType: 'evidence_item',
    entityId: evidence.id,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    afterJson: { type: 'url', title: parsed.title, sha256 },
  })

  return evidence
}

export async function createTextEvidenceForProject(projectId: string, input: unknown) {
  const { membership, organization, user } = await requireOrganizationAccess()
  if (!hasRole(membership.role, 'analyst')) {
    throw new Error('Insufficient permissions to create text evidence')
  }
  const parsed = CreateTextEvidenceSchema.parse(input)
  await verifyProjectOwnership(projectId, organization.id)
  await verifyOutcomeIndicator(projectId, parsed.outcomeId, parsed.indicatorId)

  const normalizedText = parsed.text.trim()
  const sha256 = crypto.createHash('sha256').update(normalizedText).digest('hex')

  const [evidence] = await db
    .insert(evidenceItems)
    .values({
      projectId,
      organizationId: organization.id,
      type: 'text',
      title: parsed.title,
      description: parsed.description,
      outcomeId: parsed.outcomeId,
      indicatorId: parsed.indicatorId,
      contentHash: sha256,
      status: 'draft',
      createdBy: user.id,
    })
    .returning()

  await logAuditAction({
    organizationId: organization.id,
    projectId,
    actorUserId: user.id,
    entityType: 'evidence_item',
    entityId: evidence.id,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    afterJson: { type: 'text', title: parsed.title, sha256 },
  })

  return evidence
}

export async function updateEvidenceReviewStatus(projectId: string, evidenceId: string, input: unknown) {
  const { membership, organization, user } = await requireOrganizationAccess()
  if (!hasRole(membership.role, 'impact_manager')) {
    throw new Error('Insufficient permissions to change review status')
  }
  const parsed = UpdateReviewStatusSchema.parse(input)
  await verifyProjectOwnership(projectId, organization.id)

  const before = await getEvidenceByIdForProject(projectId, evidenceId)

  await db
    .update(evidenceItems)
    .set({ status: parsed.status, reviewNotes: parsed.reviewNotes })
    .where(and(eq(evidenceItems.projectId, projectId), eq(evidenceItems.id, evidenceId)))

  const after = await getEvidenceByIdForProject(projectId, evidenceId)

  await logAuditAction({
    organizationId: organization.id,
    projectId,
    actorUserId: user.id,
    entityType: 'evidence_item',
    entityId: evidenceId,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    beforeJson: before,
    afterJson: after,
  })

  return after
}

export async function archiveEvidenceForProject(projectId: string, evidenceId: string) {
  const { membership, organization, user } = await requireOrganizationAccess()
  if (!hasRole(membership.role, 'analyst')) {
    throw new Error('Insufficient permissions to archive evidence')
  }
  await verifyProjectOwnership(projectId, organization.id)

  const before = await getEvidenceByIdForProject(projectId, evidenceId)

  await db
    .update(evidenceItems)
    .set({ status: 'archived' })
    .where(and(eq(evidenceItems.projectId, projectId), eq(evidenceItems.id, evidenceId)))

  const after = await getEvidenceByIdForProject(projectId, evidenceId)

  await logAuditAction({
    organizationId: organization.id,
    projectId,
    actorUserId: user.id,
    entityType: 'evidence_item',
    entityId: evidenceId,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    beforeJson: before,
    afterJson: after,
  })

  return after
}

export async function listEvidenceForOrganizationWithProject() {
  const { organization } = await requireOrganizationAccess()
  return db
    .select({
      id: evidenceItems.id,
      title: evidenceItems.title,
      type: evidenceItems.type,
      status: evidenceItems.status,
      contentHash: evidenceItems.contentHash,
      createdAt: evidenceItems.createdAt,
      projectName: projects.name,
      projectId: projects.id,
    })
    .from(evidenceItems)
    .innerJoin(projects, eq(evidenceItems.projectId, projects.id))
    .where(eq(evidenceItems.organizationId, organization.id))
}


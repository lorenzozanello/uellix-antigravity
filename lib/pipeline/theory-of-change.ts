// lib/pipeline/theory-of-change.ts
// Fase 2a — structured theory of change (activity/output/outcome graph with
// typed causal links). Coexists with the free-text theoryOfChangeSummary field
// on impact_narratives; does not replace it. Outcome-type nodes reference real
// `outcomes` rows so the graph stays connected to the pipeline that actually
// feeds the SROI calculation, instead of becoming a parallel narrative.
// Design: docs/superpowers/specs/2026-07-05-theory-of-change-structured-design.md

import { db } from '@/db/client'
import { theoryOfChangeNodes, theoryOfChangeLinks, outcomes, projects } from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/permissions'
import { type Role } from '@/lib/auth/roles'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

export type ToCNodeType = 'activity' | 'output' | 'outcome'

/**
 * A causal link is only valid activity->output or output->outcome — modeling
 * the standard theory-of-change chain. A direct activity->outcome jump (or any
 * same-type / reversed-order link) must instead be documented as an assumption
 * on the intermediate output->outcome link, not modeled as its own edge.
 */
export function isValidLinkTransition(fromType: ToCNodeType, toType: ToCNodeType): boolean {
  return (fromType === 'activity' && toType === 'output') || (fromType === 'output' && toType === 'outcome')
}

const CreateNodeSchema = z.object({
  nodeType: z.enum(['activity', 'output', 'outcome']),
  outcomeId: z.string().uuid().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
})
export type CreateNodeInput = z.infer<typeof CreateNodeSchema>

async function verifyProjectAccess(projectId: string) {
  const ctx = await requireOrganizationAccess()
  const project = await db.select().from(projects).where(eq(projects.id, projectId)).then((r) => r[0])
  if (!project) throw new Error('Project not found')
  if (project.organizationId !== ctx.organization.id) throw new Error('Project does not belong to your organization')
  return ctx
}

async function authorizeWrite(projectId: string) {
  const ctx = await verifyProjectAccess(projectId)
  if (!hasRole(ctx.membership.role as Role, 'analyst')) throw new Error('Insufficient role')
  return ctx
}

export async function listNodesForProject(projectId: string) {
  const ctx = await verifyProjectAccess(projectId)
  return db
    .select()
    .from(theoryOfChangeNodes)
    .where(and(
      eq(theoryOfChangeNodes.projectId, projectId),
      eq(theoryOfChangeNodes.organizationId, ctx.organization.id),
      eq(theoryOfChangeNodes.status, 'active'),
    ))
}

export async function createNode(projectId: string, input: CreateNodeInput) {
  const ctx = await authorizeWrite(projectId)
  const validated = CreateNodeSchema.parse(input)

  if (validated.nodeType === 'outcome') {
    if (!validated.outcomeId) throw new Error('outcomeId is required for an outcome node')

    const outcome = await db.select().from(outcomes).where(eq(outcomes.id, validated.outcomeId)).then((r) => r[0])
    if (!outcome || outcome.projectId !== projectId) throw new Error('Outcome not found for project')

    const siblingNodes = await db.select().from(theoryOfChangeNodes).where(eq(theoryOfChangeNodes.projectId, projectId))
    const alreadyModeled = siblingNodes.some((n) => n.outcomeId === validated.outcomeId && n.status === 'active')
    if (alreadyModeled) throw new Error('This outcome is already modeled in the graph')
  } else if (validated.outcomeId) {
    throw new Error('outcomeId must not be set for activity/output nodes')
  }

  const inserted = await db.insert(theoryOfChangeNodes).values({
    projectId,
    organizationId: ctx.organization.id,
    nodeType: validated.nodeType,
    outcomeId: validated.nodeType === 'outcome' ? validated.outcomeId : null,
    title: validated.title,
    description: validated.description,
    createdBy: ctx.user.id,
  }).returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'theory_of_change_node',
    entityId: inserted[0].id,
    action: AUDIT_ACTIONS.THEORY_OF_CHANGE_NODE_CREATED,
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  })
  return inserted[0]
}

export async function archiveNode(projectId: string, nodeId: string) {
  const ctx = await authorizeWrite(projectId)
  const existing = await db.select().from(theoryOfChangeNodes).where(eq(theoryOfChangeNodes.id, nodeId)).then((r) => r[0])
  if (!existing || existing.organizationId !== ctx.organization.id) throw new Error('Node not found')

  await db.update(theoryOfChangeNodes).set({ status: 'archived', updatedAt: new Date() }).where(eq(theoryOfChangeNodes.id, nodeId))

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'theory_of_change_node',
    entityId: nodeId,
    action: AUDIT_ACTIONS.THEORY_OF_CHANGE_NODE_ARCHIVED,
    beforeJson: existing as unknown as Record<string, unknown>,
  })
  return { id: nodeId, status: 'archived' as const }
}

const CreateLinkSchema = z.object({
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  assumption: z.string().optional(),
})
export type CreateLinkInput = z.infer<typeof CreateLinkSchema>

export async function listLinksForProject(projectId: string) {
  const ctx = await verifyProjectAccess(projectId)
  const links = await db.select().from(theoryOfChangeLinks).where(and(
    eq(theoryOfChangeLinks.projectId, projectId),
    eq(theoryOfChangeLinks.organizationId, ctx.organization.id),
    eq(theoryOfChangeLinks.status, 'active'),
  ))
  if (links.length === 0) return []

  const nodeIds = [...new Set(links.flatMap((l) => [l.fromNodeId, l.toNodeId]))]
  const relatedNodes = await db.select().from(theoryOfChangeNodes).where(inArray(theoryOfChangeNodes.id, nodeIds))
  const activeNodeIds = new Set(relatedNodes.filter((n) => n.status === 'active').map((n) => n.id))

  return links.filter((l) => activeNodeIds.has(l.fromNodeId) && activeNodeIds.has(l.toNodeId))
}

export async function createLink(projectId: string, input: CreateLinkInput) {
  const ctx = await authorizeWrite(projectId)
  const validated = CreateLinkSchema.parse(input)

  if (validated.fromNodeId === validated.toNodeId) throw new Error('A node cannot link to itself')

  const [fromNode, toNode] = await Promise.all([
    db.select().from(theoryOfChangeNodes).where(eq(theoryOfChangeNodes.id, validated.fromNodeId)).then((r) => r[0]),
    db.select().from(theoryOfChangeNodes).where(eq(theoryOfChangeNodes.id, validated.toNodeId)).then((r) => r[0]),
  ])
  if (!fromNode || fromNode.projectId !== projectId) throw new Error('From-node not found for project')
  if (!toNode || toNode.projectId !== projectId) throw new Error('To-node not found for project')

  if (!isValidLinkTransition(fromNode.nodeType as ToCNodeType, toNode.nodeType as ToCNodeType)) {
    throw new Error(`Invalid link: ${fromNode.nodeType} -> ${toNode.nodeType} is not allowed (only activity->output or output->outcome)`)
  }

  const inserted = await db.insert(theoryOfChangeLinks).values({
    projectId,
    organizationId: ctx.organization.id,
    fromNodeId: validated.fromNodeId,
    toNodeId: validated.toNodeId,
    assumption: validated.assumption,
    createdBy: ctx.user.id,
  }).returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'theory_of_change_link',
    entityId: inserted[0].id,
    action: AUDIT_ACTIONS.THEORY_OF_CHANGE_LINK_CREATED,
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  })
  return inserted[0]
}

export async function archiveLink(projectId: string, linkId: string) {
  const ctx = await authorizeWrite(projectId)
  const existing = await db.select().from(theoryOfChangeLinks).where(eq(theoryOfChangeLinks.id, linkId)).then((r) => r[0])
  if (!existing || existing.organizationId !== ctx.organization.id) throw new Error('Link not found')

  await db.update(theoryOfChangeLinks).set({ status: 'archived', updatedAt: new Date() }).where(eq(theoryOfChangeLinks.id, linkId))

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'theory_of_change_link',
    entityId: linkId,
    action: AUDIT_ACTIONS.THEORY_OF_CHANGE_LINK_ARCHIVED,
    beforeJson: existing as unknown as Record<string, unknown>,
  })
  return { id: linkId, status: 'archived' as const }
}

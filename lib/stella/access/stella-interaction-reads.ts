// lib/stella/access/stella-interaction-reads.ts
// Etapa A2.2 (STL-A22-006, DR-007 aprobado 2026-07-26). Único punto de
// lectura autorizada de `stella_interactions` para servicios/UI. Usa Drizzle
// sobre DATABASE_URL (rol `postgres`, superusuario, BYPASEA RLS por
// completo) — por eso NUNCA confía en RLS para proteger estas dos
// funciones: cada una resuelve el actor desde la sesión (nunca desde el
// cliente) y aplica en SQL la misma matriz de acceso que
// db/policies/010_stella_interactions_access_control_rls.sql impone a nivel
// de PostgREST (ver ORG_WIDE_STELLA_ACCESS_ROLES en
// stella-interaction-access.ts — fuente única de verdad compartida por
// ambas rutas).
//
// Deliberadamente NO existe una función genérica
// `getAllStellaInteractions(organizationId)` que reciba una organización o
// un rol como parámetro del llamador — ambas funciones aquí resuelven el
// actor y su membresía ELLAS MISMAS.

import { and, desc, eq, lt } from 'drizzle-orm'
import { db } from '@/db/client'
import { stellaInteractions } from '@/db/schema'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { canReadStellaInteraction, ORG_WIDE_STELLA_ACCESS_ROLES } from './stella-interaction-access'

/** Vista resumida — para listados. Nunca incluye response_json, context_manifest, campos de prompt, ni risk_flags. */
export interface StellaInteractionSummary {
  id: string
  stellaRole: string
  pipelineStep: string
  projectId: string
  createdBy: string
  createdAt: Date
  riskLevel: string | null
  modelUsed: string
}

/** Vista detallada — solo cuando el actor ya fue autorizado por canReadStellaInteraction. */
export interface StellaInteractionDetail extends StellaInteractionSummary {
  responseJson: unknown
  /**
   * Etapa A2.4 (DR-004). `responseJson` becomes NULL after a retention
   * purge redacts it — this field makes that state explicit instead of
   * forcing every consumer to infer meaning from a bare `null`. Today
   * 'never_generated' cannot occur in practice (the 4 Stella actions always
   * insert a real response), but the enum names it anyway so a future
   * consumer never has to guess whether `null` here means "purged" or
   * "nothing was ever generated" — see lib/stella/retention/purge-service.ts.
   */
  responseStatus: 'available' | 'purged' | 'never_generated'
  responsePurgedAt: Date | null
  contextManifest: unknown
  riskFlags: string[] | null
  tokensUsed: number | null
  promptTemplateId: string | null
  promptVersion: number | null
  promptContentHash: string | null
  contextSchemaVersion: number | null
  contextHash: string
}

function resolveResponseStatus(responseJson: unknown, responsePurgedAt: Date | null): StellaInteractionDetail['responseStatus'] {
  if (responseJson !== null && responseJson !== undefined) return 'available'
  if (responsePurgedAt !== null) return 'purged'
  return 'never_generated'
}

export interface ListStellaInteractionsOptions {
  projectId?: string
  /** ISO string: solo interacciones anteriores a este createdAt (paginación estable). */
  cursor?: string
  /** Máximo 100, por defecto 50. */
  limit?: number
}

/**
 * Lista interacciones autorizadas para el actor de la sesión ACTUAL —
 * nunca para un `organizationId`/rol enviado por el cliente.
 *
 * El alcance se aplica en SQL (no se cargan filas cross-org para filtrarlas
 * después en memoria): roles en ORG_WIDE_STELLA_ACCESS_ROLES ven toda su
 * organización; el resto (reviewer, viewer) solo ven las interacciones que
 * ellos mismos crearon.
 *
 * Nota: `requireOrganizationAccess()` solo resuelve membresías ACTIVAS
 * (`getCurrentMembership` filtra `status = 'active'`) — un usuario con
 * membresía inactiva nunca llega a este punto; ese caso solo es relevante
 * para la política RLS (una sesión ya autenticada cuya membresía se
 * desactivó a mitad de sesión) y está cubierto ahí y en las pruebas de
 * `canReadStellaInteraction`.
 */
export async function listAuthorizedStellaInteractions(
  options: ListStellaInteractionsOptions = {},
): Promise<{ items: StellaInteractionSummary[] }> {
  const ctx = await requireOrganizationAccess()

  const scopeCondition = ORG_WIDE_STELLA_ACCESS_ROLES.has(ctx.membership.role)
    ? eq(stellaInteractions.organizationId, ctx.organization.id)
    : and(eq(stellaInteractions.organizationId, ctx.organization.id), eq(stellaInteractions.createdBy, ctx.user.id))

  const conditions = [scopeCondition]
  if (options.projectId) conditions.push(eq(stellaInteractions.projectId, options.projectId))
  if (options.cursor) conditions.push(lt(stellaInteractions.createdAt, new Date(options.cursor)))

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100)

  const rows = await db
    .select({
      id: stellaInteractions.id,
      stellaRole: stellaInteractions.stellaRole,
      pipelineStep: stellaInteractions.pipelineStep,
      projectId: stellaInteractions.projectId,
      createdBy: stellaInteractions.createdBy,
      createdAt: stellaInteractions.createdAt,
      riskLevel: stellaInteractions.riskLevel,
      modelUsed: stellaInteractions.modelUsed,
    })
    .from(stellaInteractions)
    .where(and(...conditions))
    .orderBy(desc(stellaInteractions.createdAt), desc(stellaInteractions.id))
    .limit(limit)

  return { items: rows }
}

export type GetStellaInteractionResult =
  | { ok: true; data: StellaInteractionDetail }
  | { ok: false; error: 'NOT_FOUND' }

/**
 * Obtiene la vista DETALLADA de una interacción, si el actor de la sesión
 * actual está autorizado. Devuelve `NOT_FOUND` tanto si la fila no existe
 * como si existe pero el actor no está autorizado — nunca revela cuál de
 * las dos ocurrió (evita enumeración de IDs cross-org).
 */
export async function getAuthorizedStellaInteraction(id: string): Promise<GetStellaInteractionResult> {
  const ctx = await requireOrganizationAccess()

  const [row] = await db.select().from(stellaInteractions).where(eq(stellaInteractions.id, id)).limit(1)
  if (!row) return { ok: false, error: 'NOT_FOUND' }

  const decision = canReadStellaInteraction({
    userId: ctx.user.id,
    organizationId: row.organizationId,
    interactionCreatedBy: row.createdBy,
    projectId: row.projectId,
    isGlobalSuperAdmin: ctx.user.isSuperAdmin,
    membership: {
      organizationId: ctx.membership.organizationId,
      role: ctx.membership.role,
      status: ctx.membership.status as 'active' | 'inactive',
    },
  })

  if (!decision.allowed) return { ok: false, error: 'NOT_FOUND' }

  return {
    ok: true,
    data: {
      id: row.id,
      stellaRole: row.stellaRole,
      pipelineStep: row.pipelineStep,
      projectId: row.projectId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      riskLevel: row.riskLevel,
      modelUsed: row.modelUsed,
      responseJson: row.responseJson,
      responseStatus: resolveResponseStatus(row.responseJson, row.responsePurgedAt),
      responsePurgedAt: row.responsePurgedAt,
      contextManifest: row.contextManifest,
      riskFlags: row.riskFlags,
      tokensUsed: row.tokensUsed,
      promptTemplateId: row.promptTemplateId,
      promptVersion: row.promptVersion,
      promptContentHash: row.promptContentHash,
      contextSchemaVersion: row.contextSchemaVersion,
      contextHash: row.contextHash,
    },
  }
}

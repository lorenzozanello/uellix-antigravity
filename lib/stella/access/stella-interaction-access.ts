// lib/stella/access/stella-interaction-access.ts
// Etapa A2.2 (STL-A22-003, DR-007 aprobado 2026-07-26). Fuente única de
// verdad para decidir si un usuario puede leer una interacción de Stella —
// reutilizada tanto por la política RLS equivalente
// (db/policies/010_stella_interactions_access_control_rls.sql) como por el
// servicio de lectura que usa Drizzle (lib/stella/access/stella-interaction-reads.ts,
// que conecta como el rol `postgres`, superusuario que BYPASEA RLS por
// completo — por eso esta función existe: RLS por sí sola NUNCA protege esa
// ruta).
//
// Matriz de acceso aprobada por el propietario (ver
// STELLA_A2_DR007_IMPLEMENTATION_REPORT.md para la matriz completa y las
// decisiones interpretativas documentadas):
//   - Creador: lee su propia interacción mientras conserve membresía ACTIVA
//     en la organización de esa interacción.
//   - organization_admin (y super_admin con una membresía explícita de ese
//     nivel en esa organización — nunca por el flag global): toda la
//     organización.
//   - analyst / impact_manager: toda la organización — NO porque tengan una
//     ACL por proyecto (no existe ninguna en Uellix hoy: `projects`,
//     `portfolios` e `impact_narratives` ya son org-wide para cualquier rol
//     con permiso de escritura, verificado en db/migrations/0031_rls_core.sql),
//     sino porque "acceso al proyecto" y "acceso a la organización" son el
//     mismo conjunto hoy. Esto es el ALCANCE REAL existente, no una ACL
//     nueva — documentado explícitamente, no asumido.
//   - reviewer, viewer: SIN acceso general al historial. `reviewer` no está
//     mencionado en la decisión aprobada por el propietario; se trata igual
//     que `viewer` por interpretación jerárquica (su nivel en
//     ROLE_HIERARCHY, 20, está por debajo de `analyst`, 40, y por encima de
//     `viewer`, 10 — ver el informe de implementación para la justificación
//     completa de esta extrapolación).
//   - super_admin global SIN membresía explícita en la organización: SIN
//     bypass. No existe hoy ningún mecanismo de acceso excepcional auditado
//     (soporte/impersonación/"break glass") en el repositorio — se aplica el
//     principio de menor privilegio (denegar) en vez de construir ese
//     mecanismo dentro de este bloque. Ver "Riesgos residuales" en el
//     informe de implementación.

/** Roles cuyo nivel de acceso a stella_interactions es "toda la organización". */
export const ORG_WIDE_STELLA_ACCESS_ROLES: ReadonlySet<string> = new Set([
  'organization_admin',
  'super_admin',
  'impact_manager',
  'analyst',
])

export interface StellaInteractionAccessContext {
  userId: string
  /** La organización a la que pertenece la interacción evaluada. */
  organizationId: string
  interactionCreatedBy: string
  /**
   * Aceptado para evolución futura (si Uellix introduce ACL por proyecto).
   * NO se usa hoy en la decisión — ver la nota sobre alcance real arriba.
   */
  projectId?: string | null
  /** Flag global `users.is_super_admin` — distinto de tener una membresía en esta organización. */
  isGlobalSuperAdmin: boolean
  /** null = el usuario no tiene ninguna fila de membresía para ESTA organización (nunca fue miembro, o su única membresía es de otra organización). */
  membership: { organizationId: string; role: string; status: 'active' | 'inactive' } | null
}

export type StellaInteractionAccessDecision =
  | { allowed: true; reason: 'creator' | 'analyst_project_access' | 'organization_admin' }
  | {
      allowed: false
      reason: 'viewer_denied' | 'inactive_membership' | 'cross_org' | 'no_project_access' | 'support_reason_required'
    }

/**
 * Decide si `context.userId` puede leer una interacción de Stella dada su
 * organización, creador y la membresía (activa o no) del usuario en esa
 * organización. Fail-closed: cualquier estado ambiguo o no contemplado
 * explícitamente cae en `allowed: false`. No consulta la base de datos ni
 * depende del modelo — es una función pura.
 */
export function canReadStellaInteraction(
  context: StellaInteractionAccessContext,
): StellaInteractionAccessDecision {
  // Un super_admin global sin membresía en ESTA organización no obtiene un
  // bypass. `support_reason_required` señala explícitamente que la única
  // ruta legítima futura sería un mecanismo de acceso excepcional auditado
  // (no implementado en este bloque) — no un acceso ordinario silencioso.
  if (context.isGlobalSuperAdmin && (!context.membership || context.membership.organizationId !== context.organizationId)) {
    return { allowed: false, reason: 'support_reason_required' }
  }

  if (!context.membership || context.membership.organizationId !== context.organizationId) {
    return { allowed: false, reason: 'cross_org' }
  }

  if (context.membership.status !== 'active') {
    return { allowed: false, reason: 'inactive_membership' }
  }

  if (context.userId === context.interactionCreatedBy) {
    return { allowed: true, reason: 'creator' }
  }

  if (context.membership.role === 'organization_admin' || context.membership.role === 'super_admin') {
    return { allowed: true, reason: 'organization_admin' }
  }

  if (ORG_WIDE_STELLA_ACCESS_ROLES.has(context.membership.role) && context.membership.role !== 'organization_admin' && context.membership.role !== 'super_admin') {
    // impact_manager / analyst — alcance real = organización completa (ver
    // nota de cabecera). `no_project_access` queda declarado en el tipo para
    // cuando exista una ACL por proyecto real; hoy es inalcanzable.
    return { allowed: true, reason: 'analyst_project_access' }
  }

  // reviewer, viewer: sin acceso general (más allá de su propia interacción,
  // ya resuelto arriba por la rama `creator`).
  return { allowed: false, reason: 'viewer_denied' }
}

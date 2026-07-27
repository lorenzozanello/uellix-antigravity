// lib/stella/access/__tests__/stella-interaction-access.test.ts
// Etapa A2.2 (STL-A22-014, DR-007 aprobado 2026-07-26). Cubre la sección 14
// del encargo en su totalidad.

import { describe, it, expect } from 'vitest'
import { canReadStellaInteraction, ORG_WIDE_STELLA_ACCESS_ROLES } from '../stella-interaction-access'
import type { StellaInteractionAccessContext } from '../stella-interaction-access'

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const CREATOR = 'user-creator'
const OTHER_USER = 'user-other'

function ctx(overrides: Partial<StellaInteractionAccessContext> = {}): StellaInteractionAccessContext {
  return {
    userId: OTHER_USER,
    organizationId: ORG_A,
    interactionCreatedBy: CREATOR,
    projectId: 'proj-1',
    isGlobalSuperAdmin: false,
    membership: { organizationId: ORG_A, role: 'analyst', status: 'active' },
    ...overrides,
  }
}

describe('canReadStellaInteraction', () => {
  it('creador activo autorizado', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: CREATOR, membership: { organizationId: ORG_A, role: 'viewer', status: 'active' } }),
    )
    expect(decision).toEqual({ allowed: true, reason: 'creator' })
  })

  it('creador con membresía inactiva rechazado', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: CREATOR, membership: { organizationId: ORG_A, role: 'organization_admin', status: 'inactive' } }),
    )
    expect(decision).toEqual({ allowed: false, reason: 'inactive_membership' })
  })

  it('viewer no-creador rechazado', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, membership: { organizationId: ORG_A, role: 'viewer', status: 'active' } }),
    )
    expect(decision).toEqual({ allowed: false, reason: 'viewer_denied' })
  })

  it('viewer creador autorizado (interpretación documentada: la regla de creador no distingue rol)', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: CREATOR, membership: { organizationId: ORG_A, role: 'viewer', status: 'active' } }),
    )
    expect(decision).toEqual({ allowed: true, reason: 'creator' })
  })

  it('reviewer tratado igual que viewer (no mencionado en la decisión aprobada, jerarquía por debajo de analyst)', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, membership: { organizationId: ORG_A, role: 'reviewer', status: 'active' } }),
    )
    expect(decision).toEqual({ allowed: false, reason: 'viewer_denied' })
  })

  it('analyst con acceso (alcance real: toda la organización, no hay ACL por proyecto)', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, membership: { organizationId: ORG_A, role: 'analyst', status: 'active' } }),
    )
    expect(decision).toEqual({ allowed: true, reason: 'analyst_project_access' })
  })

  it('impact_manager recibe el mismo trato que analyst', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, membership: { organizationId: ORG_A, role: 'impact_manager', status: 'active' } }),
    )
    expect(decision).toEqual({ allowed: true, reason: 'analyst_project_access' })
  })

  it('analyst sin acceso (membresía de otra organización) rechazado', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, membership: { organizationId: ORG_B, role: 'analyst', status: 'active' } }),
    )
    expect(decision).toEqual({ allowed: false, reason: 'cross_org' })
  })

  it('organization_admin autorizado para toda su organización', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, membership: { organizationId: ORG_A, role: 'organization_admin', status: 'active' } }),
    )
    expect(decision).toEqual({ allowed: true, reason: 'organization_admin' })
  })

  it('admin cross-org rechazado', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, membership: { organizationId: ORG_B, role: 'organization_admin', status: 'active' } }),
    )
    expect(decision).toEqual({ allowed: false, reason: 'cross_org' })
  })

  it('usuario sin membresía en absoluto rechazado', () => {
    const decision = canReadStellaInteraction(ctx({ userId: OTHER_USER, membership: null }))
    expect(decision).toEqual({ allowed: false, reason: 'cross_org' })
  })

  it('super_admin ordinario (sin membresía explícita en esta organización) rechazado', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, isGlobalSuperAdmin: true, membership: null }),
    )
    expect(decision).toEqual({ allowed: false, reason: 'support_reason_required' })
  })

  it('super_admin con membresía explícita organization_admin en esta organización autorizado', () => {
    const decision = canReadStellaInteraction(
      ctx({
        userId: OTHER_USER,
        isGlobalSuperAdmin: true,
        membership: { organizationId: ORG_A, role: 'organization_admin', status: 'active' },
      }),
    )
    expect(decision).toEqual({ allowed: true, reason: 'organization_admin' })
  })

  it('super_admin con membresía explícita de rol super_admin en esta organización autorizado', () => {
    const decision = canReadStellaInteraction(
      ctx({
        userId: OTHER_USER,
        isGlobalSuperAdmin: true,
        membership: { organizationId: ORG_A, role: 'super_admin', status: 'active' },
      }),
    )
    expect(decision).toEqual({ allowed: true, reason: 'organization_admin' })
  })

  it('interacción sin proyecto (projectId null) no afecta la decisión — el campo no se usa hoy', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, projectId: null, membership: { organizationId: ORG_A, role: 'analyst', status: 'active' } }),
    )
    expect(decision).toEqual({ allowed: true, reason: 'analyst_project_access' })
  })

  it('proyecto archivado no afecta la decisión (no hay ACL por proyecto; el campo se ignora igual)', () => {
    const decisionWithArchivedProject = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, projectId: 'archived-project', membership: { organizationId: ORG_A, role: 'analyst', status: 'active' } }),
    )
    expect(decisionWithArchivedProject).toEqual({ allowed: true, reason: 'analyst_project_access' })
  })

  it('cambio de rol: la decisión usa el rol de membresía VIGENTE, no el que tenía al crear la interacción', () => {
    // Un usuario que era analyst al crear la interacción y ahora es viewer:
    // ya no obtiene acceso por el rol antiguo — solo por ser el creador.
    const asCreatorNowViewer = canReadStellaInteraction(
      ctx({ userId: CREATOR, membership: { organizationId: ORG_A, role: 'viewer', status: 'active' } }),
    )
    expect(asCreatorNowViewer).toEqual({ allowed: true, reason: 'creator' })

    // Un tercero que era analyst y ahora es viewer pierde el acceso de alcance amplio.
    const asOtherNowViewer = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, membership: { organizationId: ORG_A, role: 'viewer', status: 'active' } }),
    )
    expect(asOtherNowViewer).toEqual({ allowed: false, reason: 'viewer_denied' })
  })

  it('fail-closed: un rol desconocido/no reconocido nunca se autoriza por defecto', () => {
    const decision = canReadStellaInteraction(
      ctx({ userId: OTHER_USER, membership: { organizationId: ORG_A, role: 'unknown_future_role', status: 'active' } }),
    )
    expect(decision.allowed).toBe(false)
  })

  it('ORG_WIDE_STELLA_ACCESS_ROLES documenta exactamente los 4 roles con alcance amplio', () => {
    expect([...ORG_WIDE_STELLA_ACCESS_ROLES].sort()).toEqual(
      ['analyst', 'impact_manager', 'organization_admin', 'super_admin'].sort(),
    )
  })
})

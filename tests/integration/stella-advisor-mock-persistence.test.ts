// tests/integration/stella-advisor-mock-persistence.test.ts
//
// Etapa B0 — prueba de regresión (2026-07-27) para el hallazgo de
// AUDIT_ERROR documentado en STELLA_B0_CONTROLLED_PILOT_IMPLEMENTATION_REPORT.md#0.5:
// `stella_interactions.pipeline_step` es `varchar(100)`, y un uso indebido
// del parámetro `step` de Advisor (transmitir una oración completa en vez de
// la etiqueta canónica del paso) hacía fallar el INSERT en 2 de 3 llamadas
// reales. Esta prueba reproduce los 3 casos CORREGIDOS (etiquetas canónicas
// reales: "Resultados"/"Narrativa"/"Grupos de interés", las mismas que usan
// las 7 páginas de pipeline reales) contra Postgres local real, usando el
// proveedor MOCK del piloto — nunca Gemini real.
//
// Usa una organización sintética PROPIA (no la de
// tests/smoke/stella-b0-real-smoke.test.ts): reutilizar esa organización
// causó exactamente la clase de fragilidad que esta prueba debía prevenir —
// al correr junto al resto de la suite de integración, la cuota mensual
// (compartida con las ejecuciones reales del smoke test) ya estaba agotada,
// y la prueba fallaba con QUOTA_EXCEEDED, no con el defecto que pretendía
// cubrir. Esta organización tiene una cuota generosa y nunca se usa fuera de
// este archivo.

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const ORG_ID = 'b0b0b0b0-0000-4000-a000-b0b0b0b0b0b0'
const USER_ID = 'b0b0b0b0-0000-4000-a001-b0b0b0b0b0b0'
const PROJECT_ID = 'b0b0b0b0-0000-4000-a002-b0b0b0b0b0b0'

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

describe('Etapa B0 — reproducción con proveedor mock de los 3 pasos canónicos (sin Gemini)', () => {
  const originalEnv: Record<string, string | undefined> = {}
  const OVERRIDES = {
    // Valor no funcional: solo satisface el chequeo de "no vacía" en
    // stellaState.canUseStella. En modo mock nunca llega a un adaptador
    // real, así que su contenido es irrelevante — no es un secreto.
    GEMINI_API_KEY: 'mock-key-not-used-in-mock-mode',
    STELLA_ENABLED: 'true',
    STELLA_ADVISOR_ENABLED: 'true',
    STELLA_PILOT_MODE: 'true',
    STELLA_PILOT_KILL_SWITCH: 'false',
    STELLA_PILOT_PROVIDER_MODE: 'mock',
    STELLA_PILOT_PAID_GEMINI_CONFIRMED: 'false', // no aplica en modo mock
    STELLA_PILOT_ORGANIZATION_IDS: ORG_ID,
    STELLA_PILOT_USER_IDS: USER_ID,
    STELLA_PILOT_ALLOW_ALL_ORG_USERS: 'false',
    STELLA_PILOT_ENABLED_ROLES: 'advisor',
    STELLA_PILOT_NOTICE_VERSION: 'v1',
  }

  beforeAll(async () => {
    for (const key of Object.keys(OVERRIDES) as (keyof typeof OVERRIDES)[]) {
      originalEnv[key] = process.env[key]
      process.env[key] = OVERRIDES[key]
    }

    const { db } = await import('@/db/client')
    const {
      organizations,
      organizationMembers,
      projects,
      impactNarratives,
      stakeholderGroups,
      outcomes,
    } = await import('@/db/schema')

    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string
    const adminClient: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })

    await db
      .insert(organizations)
      .values({
        id: ORG_ID,
        name: 'Org sintética — regresión pipeline_step (B0)',
        slug: `stella-mock-persistence-b0-${ORG_ID.slice(0, 8)}`,
        status: 'active',
        // Cuota generosa y dedicada: esta organización solo la usa este
        // archivo, así que nunca debería agotarse por otra ejecución.
        stellaMonthlyQuota: 100000,
      })
      .onConflictDoNothing()

    let email: string
    const { data: existingUser } = await adminClient.auth.admin.getUserById(USER_ID)
    if (existingUser?.user) {
      email = existingUser.user.email as string
    } else {
      email = `mock-persistence-b0-${randomUUID()}@test.local`
      const { error: userError } = await adminClient.auth.admin.createUser({
        id: USER_ID,
        email,
        password: `mock-persistence-${randomUUID()}`,
        email_confirm: true,
        user_metadata: { full_name: 'Usuario Sintético Regresión B0' },
      })
      if (userError) throw userError
      await new Promise((r) => setTimeout(r, 500))
    }

    await db
      .insert(organizationMembers)
      .values({ organizationId: ORG_ID, userId: USER_ID, role: 'organization_admin', status: 'active' })
      .onConflictDoNothing()

    await db
      .insert(projects)
      .values({
        id: PROJECT_ID,
        organizationId: ORG_ID,
        name: 'Proyecto sintético — regresión pipeline_step (SINTÉTICO)',
        status: 'active',
        createdBy: USER_ID,
      })
      .onConflictDoNothing()

    const { eq } = await import('drizzle-orm')

    const existingNarrative = await db.select({ id: impactNarratives.id }).from(impactNarratives).where(eq(impactNarratives.projectId, PROJECT_ID)).limit(1)
    if (existingNarrative.length === 0) {
      await db.insert(impactNarratives).values({
        projectId: PROJECT_ID,
        version: 'v1',
        narrativeText: 'Programa sintético de prueba para la regresión de pipeline_step.',
        theoryOfChangeSummary: 'Las organizaciones participantes fortalecen su capacidad organizacional.',
        status: 'active',
        createdBy: USER_ID,
      })
    }

    const existingStakeholder = await db.select({ id: stakeholderGroups.id }).from(stakeholderGroups).where(eq(stakeholderGroups.projectId, PROJECT_ID)).limit(1)
    let stakeholderGroupId: string
    if (existingStakeholder.length === 0) {
      const [inserted] = await db
        .insert(stakeholderGroups)
        .values({ projectId: PROJECT_ID, name: 'Grupo sintético', type: 'community', description: 'Grupo sintético para la prueba.' })
        .returning({ id: stakeholderGroups.id })
      stakeholderGroupId = inserted.id
    } else {
      stakeholderGroupId = existingStakeholder[0].id
    }

    const existingOutcome = await db.select({ id: outcomes.id }).from(outcomes).where(eq(outcomes.projectId, PROJECT_ID)).limit(1)
    if (existingOutcome.length === 0) {
      await db.insert(outcomes).values({
        projectId: PROJECT_ID,
        stakeholderGroupId,
        title: 'Outcome sintético de regresión',
        description: 'Descripción sintética.',
        outcomeType: 'organizational_capacity',
        status: 'active',
        createdBy: USER_ID,
      })
    }

    mockRequireOrganizationAccess.mockResolvedValue({
      user: { id: USER_ID, email, fullName: 'Usuario Sintético Regresión B0', avatarUrl: null, isSuperAdmin: false },
      membership: { id: 'mock-membership', organizationId: ORG_ID, userId: USER_ID, role: 'organization_admin', status: 'active' },
      organization: { id: ORG_ID, name: 'Org sintética — regresión pipeline_step (B0)', slug: 'mock-persistence', legalName: null, country: null, sector: null, status: 'active' },
    })

    // Consentimiento DR-005 y confirmación operativa del piloto, vía las
    // server actions oficiales (mismo patrón que el smoke test real).
    const { acceptStellaConsent } = await import('@/app/actions/stella/consent')
    const { getStellaConsentStatus } = await import('@/lib/stella/consent/consent-status')
    const consentStatus = await getStellaConsentStatus(ORG_ID)
    if (consentStatus.status !== 'valid') {
      const result = await acceptStellaConsent()
      if (!result.ok) throw new Error(`setup: acceptStellaConsent failed: ${result.error}`)
    }

    const { acceptStellaPilotConfirmation, getStellaPilotConfirmationStatusAction } = await import('@/app/actions/stella/pilot-confirmation')
    const confirmationStatus = await getStellaPilotConfirmationStatusAction()
    if (!(confirmationStatus.ok && confirmationStatus.data.status === 'valid')) {
      const result = await acceptStellaPilotConfirmation()
      if (!result.ok) throw new Error(`setup: acceptStellaPilotConfirmation failed: ${result.error}`)
    }
  }, 30000)

  const CASES = ['Resultados', 'Narrativa', 'Grupos de interés']

  it.each(CASES)('paso canónico "%s": respuesta mock válida → interacción persistida', async (step) => {
    const { getStellaAdvisor } = await import('@/app/actions/stella/advisor')
    const { db } = await import('@/db/client')
    const { stellaInteractions } = await import('@/db/schema')
    const { eq, and, desc } = await import('drizzle-orm')

    const result = await getStellaAdvisor(PROJECT_ID, step)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(typeof result.data.what_to_do).toBe('string')
    expect(result.data.what_to_do.length).toBeGreaterThan(0)

    const [row] = await db
      .select()
      .from(stellaInteractions)
      .where(and(eq(stellaInteractions.projectId, PROJECT_ID), eq(stellaInteractions.pipelineStep, step)))
      .orderBy(desc(stellaInteractions.createdAt))
      .limit(1)

    expect(row).toBeDefined()
    expect(row.pipelineStep).toBe(step) // etiqueta canónica, nunca una pregunta libre
    expect(row.modelUsed).toBe('stella-pilot-mock')
    expect(row.promptVersion).not.toBeNull()
    expect(row.contextSchemaVersion).not.toBeNull()
    expect(row.promptContentHash).not.toBeNull()
    expect(row.contextManifest).not.toBeNull()
    expect(row.responseJson).not.toBeNull()
  })

  it('las 3 interacciones quedaron persistidas, cada una al menos una vez (sin filas parciales)', async () => {
    const { db } = await import('@/db/client')
    const { stellaInteractions } = await import('@/db/schema')
    const { eq, and, inArray } = await import('drizzle-orm')

    const rows = await db
      .select({ id: stellaInteractions.id, pipelineStep: stellaInteractions.pipelineStep, responseJson: stellaInteractions.responseJson })
      .from(stellaInteractions)
      .where(and(eq(stellaInteractions.projectId, PROJECT_ID), inArray(stellaInteractions.pipelineStep, CASES)))

    for (const step of CASES) {
      const matches = rows.filter((r) => r.pipelineStep === step)
      expect(matches.length).toBeGreaterThanOrEqual(1)
    }
    // Ninguna fila parcial: toda fila de este proyecto tiene su respuesta.
    expect(rows.every((r) => r.responseJson !== null)).toBe(true)
  })
})

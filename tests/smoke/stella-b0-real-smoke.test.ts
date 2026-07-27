// tests/smoke/stella-b0-real-smoke.test.ts
//
// Etapa B0 — cierre del piloto restringido: smoke test REAL contra la API
// paga de Gemini, máximo 3 llamadas, únicamente datos sintéticos.
//
// Nunca corre salvo que STELLA_SMOKE_TEST_REAL sea exactamente 'true' —
// coincidencia exacta, mismo patrón que STELLA_EVAL_REAL_MODEL en
// tests/eval/run.ts. No forma parte de pnpm test / test:unit /
// test:integration / ningún workflow de CI — solo de
// `pnpm stella:pilot:smoke`, invocado a propósito por un humano.
//
// Llama a getStellaAdvisor() SIN MODIFICAR — la única pieza sustituida es la
// resolución de sesión (requireOrganizationAccess), porque este script no
// corre dentro de una petición real de Next.js con cookies de navegador; se
// reemplaza por un contexto sintético que apunta a una organización/usuario
// reales, creados aquí mismo en el stack local, exclusivamente con datos
// ficticios. Ninguna otra función de lib/stella/pilot/* o de advisor.ts se
// modifica, se mockea, ni se reimplementa: el gate del piloto, el
// consentimiento DR-005, la confirmación operativa, los guardarraíles de
// datos sensibles, la cuota, el rate limit, el adaptador real de Gemini y el
// registro de auditoría se ejecutan tal como existen en producción.
//
// Sin limpieza al final a propósito: el fixture (organización, usuario,
// proyecto, narrativa, stakeholder, outcome) se crea de forma idempotente
// (create-if-missing con IDs fijos) y se reutiliza en cada ejecución — ver
// el comentario junto a SMOKE_PROJECT_ID para la razón (decenas de tablas
// tienen FK NOT NULL sin CASCADE hacia organizations).

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'

const REAL = process.env.STELLA_SMOKE_TEST_REAL === 'true'

// IDs fijos y deterministas: deben coincidir EXACTAMENTE con
// STELLA_PILOT_ORGANIZATION_IDS / STELLA_PILOT_USER_IDS en .env.local, que ya
// se cargaron antes de que este proceso arrancara (vitest.setup.smoke.ts).
// No son secretos — son identificadores de datos sintéticos locales.
const SMOKE_ORG_ID = 'b0b0b0b0-0000-4000-8000-b0b0b0b0b0b0'
const SMOKE_USER_ID = 'b0b0b0b0-0000-4000-8001-b0b0b0b0b0b0'

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

// ID fijo del proyecto sintético — junto con SMOKE_ORG_ID/SMOKE_USER_ID, deja
// que este fixture sea create-if-missing en vez de delete-then-recreate. Se
// evitó a propósito una limpieza por DELETE al final: organizations tiene
// decenas de tablas con FK NOT NULL sin CASCADE apuntando hacia ella
// (incluidas stella_ai_consent_events/stella_pilot_confirmations, que deben
// sobrevivir como rastro de auditoría append-only) — borrar la organización
// exigiría vaciar cada una de esas tablas primero, lo cual excede el alcance
// de un smoke test y arriesga tocar filas no relacionadas. En su lugar, el
// fixture se crea UNA vez y se reutiliza en cada ejecución posterior.
const SMOKE_PROJECT_ID = 'b0b0b0b0-0000-4000-8002-b0b0b0b0b0b0'

describe.skipIf(!REAL)('Etapa B0 — smoke test real (Gemini pagado, datos sintéticos)', () => {
  const projectId = SMOKE_PROJECT_ID

  beforeAll(async () => {
    const { db } = await import('@/db/client')
    const {
      organizations,
      organizationMembers,
      projects,
      impactNarratives,
      stakeholderGroups,
      outcomes,
    } = await import('@/db/schema')
    const { createClient } = await import('@supabase/supabase-js')

    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })

    await db
      .insert(organizations)
      .values({
        id: SMOKE_ORG_ID,
        name: 'Fundación Horizonte Piloto (SINTÉTICO — B0)',
        slug: `fundacion-horizonte-piloto-b0-${SMOKE_ORG_ID.slice(0, 8)}`,
        status: 'active',
        stellaMonthlyQuota: 10,
      })
      .onConflictDoNothing()

    let email: string
    const { data: existingUser } = await adminClient.auth.admin.getUserById(SMOKE_USER_ID)
    if (existingUser?.user) {
      email = existingUser.user.email as string
    } else {
      email = `smoke-b0-${randomUUID()}@test.local`
      const { error: userError } = await adminClient.auth.admin.createUser({
        id: SMOKE_USER_ID,
        email,
        password: `smoke-${randomUUID()}`,
        email_confirm: true,
        user_metadata: { full_name: 'Usuario Sintético Piloto B0' },
      })
      if (userError) throw userError
      // El trigger de creación de perfil tarda un instante en poblar public.users.
      await new Promise((r) => setTimeout(r, 500))
    }

    await db
      .insert(organizationMembers)
      .values({
        organizationId: SMOKE_ORG_ID,
        userId: SMOKE_USER_ID,
        role: 'organization_admin',
        status: 'active',
      })
      .onConflictDoNothing()

    await db
      .insert(projects)
      .values({
        id: SMOKE_PROJECT_ID,
        organizationId: SMOKE_ORG_ID,
        name: 'Programa de fortalecimiento comunitario (SINTÉTICO)',
        status: 'active',
        createdBy: SMOKE_USER_ID,
      })
      .onConflictDoNothing()

    const existingNarrative = await db
      .select({ id: impactNarratives.id })
      .from(impactNarratives)
      .where(eq(impactNarratives.projectId, SMOKE_PROJECT_ID))
      .limit(1)
    if (existingNarrative.length === 0) {
      await db.insert(impactNarratives).values({
        projectId: SMOKE_PROJECT_ID,
        version: 'v1',
        narrativeText:
          'Programa de fortalecimiento comunitario. Talleres virtuales de fortalecimiento organizacional dirigidos a organizaciones comunitarias participantes.',
        theoryOfChangeSummary:
          'Las organizaciones participantes fortalecen su capacidad para planificar y hacer seguimiento a sus iniciativas.',
        status: 'active',
        createdBy: SMOKE_USER_ID,
      })
    }

    const existingStakeholder = await db
      .select({ id: stakeholderGroups.id })
      .from(stakeholderGroups)
      .where(eq(stakeholderGroups.projectId, SMOKE_PROJECT_ID))
      .limit(1)
    let stakeholderGroupId: string
    if (existingStakeholder.length === 0) {
      const [inserted] = await db
        .insert(stakeholderGroups)
        .values({
          projectId: SMOKE_PROJECT_ID,
          name: 'Organizaciones comunitarias participantes',
          type: 'community',
          description: 'Organizaciones comunitarias que participan en el programa de fortalecimiento (grupo, no individuos).',
        })
        .returning({ id: stakeholderGroups.id })
      stakeholderGroupId = inserted.id
    } else {
      stakeholderGroupId = existingStakeholder[0].id
    }

    const existingOutcome = await db
      .select({ id: outcomes.id })
      .from(outcomes)
      .where(eq(outcomes.projectId, SMOKE_PROJECT_ID))
      .limit(1)
    if (existingOutcome.length === 0) {
      await db.insert(outcomes).values({
        projectId: SMOKE_PROJECT_ID,
        stakeholderGroupId,
        title: 'Fortalecimiento de la capacidad organizacional',
        description:
          'Las organizaciones participantes fortalecen su capacidad para planificar y hacer seguimiento a sus iniciativas.',
        outcomeType: 'organizational_capacity',
        status: 'active',
        createdBy: SMOKE_USER_ID,
      })
    }

    mockRequireOrganizationAccess.mockResolvedValue({
      user: { id: SMOKE_USER_ID, email, fullName: 'Usuario Sintético Piloto B0', avatarUrl: null, isSuperAdmin: false },
      membership: { id: randomUUID(), organizationId: SMOKE_ORG_ID, userId: SMOKE_USER_ID, role: 'organization_admin', status: 'active' },
      organization: { id: SMOKE_ORG_ID, name: 'Fundación Horizonte Piloto (SINTÉTICO — B0)', slug: 'smoke', legalName: null, country: null, sector: null, status: 'active' },
    })
  }, 20000)

  it('registra (o confirma vigente) el consentimiento organizacional DR-005 vía la server action oficial', async () => {
    const { acceptStellaConsent } = await import('@/app/actions/stella/consent')
    const { getStellaConsentStatus } = await import('@/lib/stella/consent/consent-status')
    const status = await getStellaConsentStatus(SMOKE_ORG_ID)
    if (status.status === 'valid') return
    const result = await acceptStellaConsent()
    expect(result.ok).toBe(true)
  })

  it('registra (o confirma vigente) la confirmación operativa del piloto vía la server action oficial', async () => {
    const { acceptStellaPilotConfirmation, getStellaPilotConfirmationStatusAction } = await import('@/app/actions/stella/pilot-confirmation')
    const status = await getStellaPilotConfirmationStatusAction()
    if (status.ok && status.data.status === 'valid') return
    const result = await acceptStellaPilotConfirmation()
    expect(result.ok).toBe(true)
  })

  const CASES = [
    {
      label: 'Llamada 1 — pregunta metodológica general',
      step: 'Explica brevemente la diferencia entre una actividad y un outcome dentro de una cadena de impacto.',
    },
    {
      label: 'Llamada 2 — revisión del outcome sintético',
      step: 'Revisa este outcome sintético e identifica si describe un cambio observable sin inventar información adicional.',
    },
    {
      label: 'Llamada 3 — stakeholder sintético',
      step: 'Sugiere cómo mejorar la descripción de este stakeholder ficticio para que sea metodológicamente más clara, sin añadir datos no disponibles.',
    },
  ]

  for (const [i, testCase] of CASES.entries()) {
    it(`${testCase.label} (caso ${i + 1}/3, Gemini pagado real)`, async () => {
      const { getStellaAdvisor } = await import('@/app/actions/stella/advisor')
      const start = Date.now()
      const result = await getStellaAdvisor(projectId, testCase.step)
      const latencyMs = Date.now() - start

      // Nota: AdvisorOutputSchema no tiene un campo requires_human_review propio
      // (a diferencia de Validator/Reviewer) — la revisión humana obligatoria
      // para Advisor se exige a nivel de aviso del piloto (UI), no de schema.
      console.log(
        `[smoke-b0] caso=${i + 1} ok=${result.ok} latencyMs=${latencyMs}` +
          (result.ok ? ` schema_valid=true` : ` error=${result.error}`),
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(typeof result.data.what_to_do).toBe('string')
        expect(result.data.what_to_do.length).toBeGreaterThan(0)
      }
    }, 30000)
  }

  it('interruptor de emergencia: bloquea de inmediato incluso en modo mock, sin llamar al proveedor ni consumir cuota/rate-limit', async () => {
    const { getStellaAdvisor } = await import('@/app/actions/stella/advisor')
    const { checkStellaQuota } = await import('@/lib/stella/quota')

    const before = await checkStellaQuota(SMOKE_ORG_ID)

    const originalKillSwitch = process.env.STELLA_PILOT_KILL_SWITCH
    const originalProviderMode = process.env.STELLA_PILOT_PROVIDER_MODE
    process.env.STELLA_PILOT_KILL_SWITCH = 'true'
    process.env.STELLA_PILOT_PROVIDER_MODE = 'mock' // cinturón y tirantes: aun en modo mock, el kill switch debe ganar

    try {
      const result = await getStellaAdvisor(projectId, 'kill-switch-check')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('PILOT_KILL_SWITCH_ACTIVE')
    } finally {
      // Estado seguro de cierre: kill switch apagado, provider mode restaurado a paid_gemini.
      process.env.STELLA_PILOT_KILL_SWITCH = originalKillSwitch ?? 'false'
      process.env.STELLA_PILOT_PROVIDER_MODE = originalProviderMode ?? 'paid_gemini'
    }

    const after = await checkStellaQuota(SMOKE_ORG_ID)
    if (before.allowed && after.allowed) {
      expect(after.used).toBe(before.used) // el bloqueo del piloto nunca llega a la cuota
    }
  })
})

# Stella completa + cuotas de uso por organización

**Fecha:** 2026-07-02
**Estado:** Aprobado por Lorenzo, pendiente de plan de implementación.

## Contexto

Stella es la capa de IA de Uellix (Advisor, Validator, Composer) y, según Lorenzo, es clave en el
servicio: debe guiar al usuario paso a paso durante todo el pipeline SROI.

Estado encontrado antes de este trabajo:

- **Advisor**: construido y probado, presente en 6 de 7 pasos del pipeline (Narrativa, Stakeholders,
  Resultados, Indicadores, Evidencias, Proxies). Bajo demanda (botón "Preguntar a Stella").
- **Validator**: construido y probado, presente solo en el paso de Cálculo.
- **Composer**: prompt (`lib/stella/prompts/composer-system.ts`) y schema de salida
  (`lib/stella/schemas/composer-output.ts`) ya escritos, pero **sin server action ni UI** — nunca se
  pudo usar.
- Ningún flag de Stella (`STELLA_ENABLED`, `STELLA_ADVISOR_ENABLED`, `STELLA_VALIDATOR_ENABLED`,
  `STELLA_COMPOSER_ENABLED`) estaba configurado en Production de Vercel. Solo `STELLA_ENABLED` y
  `STELLA_VALIDATOR_ENABLED` existían en Preview.
- **Hallazgo adicional durante el diseño**: solo `app/actions/stella/validator.ts` escribe en la
  tabla de auditoría `stella_interactions`. `app/actions/stella/advisor.ts` no registra sus
  llamadas — bug de auditoría preexistente que además bloquea medir cuota de uso del Advisor.
- No existe ningún mecanismo de cuota o límite de uso de Stella por organización. Sin eso, activar
  Stella en producción significa costo real (Gemini API) sin control.
- No existe pasarela de pago en la plataforma. Lorenzo vende y cobra por fuera (la razón social que
  factura es **The Balance Corp**) y necesita asignar manualmente, desde un panel de administración,
  qué organización tiene acceso a Stella y con qué límite mensual.

## Decisiones tomadas con Lorenzo

1. Alcance: completar el Composer **y** hacer el Advisor más proactivo — ambas cosas.
2. Composer: botón "Redactar con Stella" **por sección** del reporte (no un botón único para las 12
   secciones).
3. Proactividad del Advisor: sin cobro real todavía, así que se resuelve con cuotas, no con llamadas
   automáticas a Gemini. El disparo de cada llamada sigue siendo explícito (clic del usuario) — la
   cuota es la que protege el costo, no la fricción de UX.
4. Billing: **sin Stripe por ahora.** Lorenzo necesita una "intranet de manejo maestro" donde, como
   super_admin de Uellix, asigne servicio y cuota de uso a cada organización manualmente. Los
   clientes compran y pagan por fuera de la plataforma.
5. Cuota agotada: **bloqueo duro.** Stella deja de responder hasta el próximo período o hasta que
   Lorenzo suba el límite a mano. El resto de la plataforma sigue funcionando normal.
6. Granularidad de cuota: **una sola cuota combinada** para Stella en general (Advisor + Validator +
   Composer cuentan contra el mismo número), no una cuota separada por rol.

## Diseño

### 1. Esquema: cuota por organización

Nuevas columnas en `organizations`:

- `stellaMonthlyQuota: integer | null` — `null` = ilimitado (uso interno/Uellix); número = cupo
  mensual de llamadas a Stella; **default `0`** para todas las organizaciones, existentes y nuevas.
  Cuota `0` es indistinguible de "nunca se le asignó plan" — ambos casos bloquean Stella hasta que
  Lorenzo asigne un valor explícito.
- `stellaPlanLabel: varchar(100) | null` — etiqueta libre para referencia de Lorenzo (ej. "Pro",
  "Piloto Q3"), no un enum cerrado.

Migración nueva (`00XX_stella_quota.sql` + snapshot generado con `pnpm db:generate`, aplicada a la
DB real con `pnpm db:migrate` bajo la autorización de escritura ya vigente).

No se crea una tabla nueva de tracking de uso — se cuenta directamente sobre `stella_interactions`
(`WHERE organization_id = X AND created_at >= inicio del mes calendario UTC actual`), reutilizando
el registro de auditoría que ya existe.

### 2. Corrección de auditoría en el Advisor

`app/actions/stella/advisor.ts` gana el mismo bloque de inserción en `stella_interactions` que ya
tiene `validator.ts` (organizationId, projectId, createdBy, stellaRole: 'advisor', pipelineStep:
`step`, contextHash, responseJson, modelUsed, tokensUsed; riskLevel/riskFlags quedan `null`, son
específicos del Validator). Sin esto, el conteo de cuota nunca reflejaría el uso real del Advisor.

### 3. `lib/stella/quota.ts` (nuevo)

```
checkStellaQuota(organizationId): Promise<
  | { allowed: true; used: number; quota: number | null }
  | { allowed: false; used: number; quota: number; reason: 'no_quota' | 'quota_exceeded' }
>
```

- `quota === null` → `allowed: true` siempre (ilimitado).
- `quota === 0` → `allowed: false, reason: 'no_quota'`.
- `quota > 0` → cuenta `stella_interactions` del mes en curso; si `used >= quota` →
  `allowed: false, reason: 'quota_exceeded'`; si no, `allowed: true`.

Se invoca en `advisor.ts`, `validator.ts` y el nuevo `composer.ts`, inmediatamente después del
chequeo de rate-limit existente y antes de construir contexto — para no gastar una llamada real a
Gemini si ya está bloqueado. Nuevo código de error `QUOTA_EXCEEDED` en las tres acciones, con un
mensaje construido con los números reales (`used`/`quota`) y una fecha de renovación (primer día del
próximo mes UTC), distinguiendo el caso "nunca tuviste plan asignado" del caso "llegaste al límite
este mes".

### 4. Panel admin `/admin/services` (nuevo)

Sigue el patrón ya establecido de `/admin/organizations` (`requireAdminAccess()`, tabla con acciones
inline). Por organización: nombre, `stellaPlanLabel`, `stellaMonthlyQuota`, uso del mes actual
(calculado en vivo desde `stella_interactions`, mismo helper que `quota.ts`), y un formulario para
editar plan/cuota. Nuevo `lib/admin/stella-services.ts` con `listOrganizationsWithStellaUsage()` y
`updateOrganizationStellaService(organizationId, { planLabel, monthlyQuota })`, ambos gateados por
`requireAdminAccess()` y con `logAuditAction`.

Se agrega un link "Servicios Stella" a la navegación de `/admin` (mismo patrón que el link "Acceso
(Signup)" agregado en la sesión anterior).

### 5. Stella Composer (nuevo, completa el tercer rol)

- `lib/stella/context/build-composer-context.ts` — espeja `build-advisor-context.ts`: valida
  propiedad del proyecto/reporte/sección, reúne narrativa, indicadores, resultados, evidencia
  (metadatos, no contenido crudo — mismo criterio de sanitización ya auditado como seguro) y
  resultados de cálculo relevantes a la sección pedida.
- `app/actions/stella/composer.ts` — `getStellaComposer(projectId, reportId, sectionId, sectionType)`,
  mismo patrón exacto que `advisor.ts`/`validator.ts` (flag gate → auth → cuota → rate-limit →
  contexto → prompt → Gemini → parseo con `ComposerOutputSchema` → insert en `stella_interactions`
  con `stellaRole: 'composer'`).
- `components/stella/StellaComposerPanel.tsx` — botón "Redactar con Stella" por sección del reporte.
  Al recibir el borrador (título, contenido, supuestos, limitaciones, evidencias/proxies citados),
  se muestra para revisión; un botón explícito "Usar este borrador" carga título+contenido en el
  formulario de edición de la sección (`updateReportSection`, ya existente) — nunca guarda solo.
- Se integra en `app/app/projects/[projectId]/report/[reportId]/page.tsx`, una instancia por
  sección.

### 6. Cobertura completa del Advisor

- Se agrega `StellaAdvisorPanel` también a la página de Cálculo (hoy solo tiene el Validator).
- Ajuste visual (no de comportamiento de red): cuando el paso está vacío/recién empezado (ej. cero
  stakeholder groups, cero outcomes — cada página ya tiene ese dato disponible), el panel de Stella
  se destaca visualmente (borde/badge de invitación) en vez del tratamiento neutro actual. La llamada
  a Gemini se sigue disparando únicamente con clic explícito del usuario — la cuota, no la fricción
  de UI, es lo que protege el costo.

### 7. Activación de flags

Una vez implementado y validado (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, y
verificación en vivo en preview): `STELLA_ENABLED`, `STELLA_ADVISOR_ENABLED`,
`STELLA_VALIDATOR_ENABLED`, `STELLA_COMPOSER_ENABLED` se configuran en `'true'` tanto en Preview como
en Production de Vercel (`vercel env add`). Como toda organización arranca en cuota `0`, activar las
flags globalmente no implica costo real hasta que Lorenzo asigne una cuota explícita desde
`/admin/services` — incluida su propia organización de pruebas ("The Balance Corp"), que también
empieza en `0`.

## Testing

- `tests/stella-quota.test.ts` — lógica de `checkStellaQuota` (null/0/N, límite exacto, mes que
  cambia).
- Actualizar `app/actions/stella/__tests__/advisor.test.ts` — cubrir el nuevo insert en
  `stella_interactions` y el nuevo código `QUOTA_EXCEEDED`.
- Actualizar `app/actions/stella/__tests__/validator.test.ts` — cubrir `QUOTA_EXCEEDED`.
- `app/actions/stella/__tests__/composer.test.ts` (nuevo) — mismo nivel de cobertura que
  advisor/validator: flag deshabilitado, no autenticado, cuota agotada, rate limit, contexto
  inválido, error de Gemini, error de parseo, éxito.
- `components/stella/__tests__/StellaComposerPanel.test.tsx` (nuevo) — estados idle/loading/error/
  success/disabled/quota-exceeded, y que "Usar este borrador" carga los campos correctos.
- `tests/admin-stella-services.service.test.ts` (nuevo) — listado con uso calculado, actualización
  de plan/cuota, auditoría.

## Fuera de alcance (explícito)

- Pasarela de pago / Stripe — Lorenzo asigna manualmente, sin cobro en la plataforma.
- Cuotas separadas por rol (Advisor/Validator/Composer) — una sola cuota combinada.
- Llamadas automáticas a Gemini sin clic del usuario — la cuota resuelve el control de costo, no la
  automatización del disparo.
- Un catálogo genérico de "servicios" más allá de Stella — el esquema se llama explícitamente
  `stellaMonthlyQuota`/`stellaPlanLabel`, no una tabla de planes genérica, porque hoy Stella es el
  único servicio que se gatea así.

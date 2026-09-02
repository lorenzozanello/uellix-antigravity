# Plan de Alertas — Stella (WS7)

> WS7 · Creado 2026-07-31 (campaña Fable Moonshot). Definiciones de alertas sobre
> señales que **existen hoy** en el sistema: logs de Vercel con prefijos `[stella]`
> y `[stella-rate-limit]`, la tabla `stella_interactions`, y el panel
> `/admin/services` (uso + tokens + costo estimado por org). Las alertas vía Sentry
> quedan referenciadas genéricamente hasta que WS3b entregue la instrumentación por
> tags; al aterrizar, cada alerta de logs de abajo debería migrar a un issue-alert
> de Sentry equivalente.
>
> No hay on-call formal en beta cerrada: "primera respuesta" = Lorenzo (super-admin).
> Cada alerta referencia la sección correspondiente de
> `docs/ops/runbooks/STELLA_INCIDENTS.md`.

## Convenciones

- **Señal**: dónde se observa (patrón de log de Vercel, consulta admin, tabla).
- **Umbral**: condición concreta que dispara la alerta.
- **Primera respuesta**: acción inmediata + sección del runbook de incidentes.
- Mientras no haya alerting automático, la revisión es **manual diaria** (beta
  cerrada): logs de Vercel filtrados por `[stella]` + vistazo a `/admin/services`.

## A1 — Errores Gemini sostenidos

- **Señal**: logs Vercel, patrón `[stella] Gemini API call failed` (el log incluye
  `status` redactado, nunca la key).
- **Umbral**: ≥ 5 ocurrencias en 15 minutos, o ≥ 2 con status 401/403 (cualquier
  401/403 es sospecha de key inválida/filtrada y se trata como crítico).
- **Primera respuesta**: STELLA_INCIDENTS.md § "A. Proveedor caído / errores
  Gemini masivos". 401/403 ⇒ rotar `GEMINI_API_KEY`; 429/5xx ⇒ kill-switch por
  capas y reintento en 30–60 min.
- **Sentry (cuando WS3b aterrice)**: issue-alert sobre eventos con tag de origen
  adapter Gemini, agrupados por status.

## A2 — Rate limiter distribuido degradado

- **Señal**: logs Vercel, patrón `[stella-rate-limit] Distributed limiter unavailable`.
- **Umbral**: ≥ 1 ocurrencia (el sistema falla cerrado: los usuarios ven
  `RATE_LIMIT_UNAVAILABLE`, así que una sola ocurrencia ya degrada servicio).
- **Primera respuesta**: STELLA_INCIDENTS.md § "E. Degradación de rate limit
  distribuido" — verificar vars KV en Vercel. Recordar RK-24 (fallback en memoria
  por instancia).

## A3 — Organización alcanza su cuota

- **Señal**: `/admin/services` — columna "Uso este mes" vs "Cuota mensual"; o
  SQL: `SELECT organization_id, COUNT(*) FROM stella_interactions WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') GROUP BY 1`.
- **Umbral**: `usedThisMonth >= quota` (bloqueada — sus usuarios ya ven
  QUOTA_EXCEEDED) o `usedThisMonth >= 0.8 * quota` (aviso temprano).
- **Primera respuesta**: contacto comercial con la org (¿subir plan?). No es un
  incidente técnico salvo que el consumo sea anómalo — en ese caso pasar a A4.
  Referencia: STELLA_INCIDENTS.md § "C. Consumo anómalo de cuota / costo".

## A4 — Pico de tokens (consumo anómalo)

- **Señal**: `/admin/services` — columna "Tokens este mes" (SUM de
  `stella_interactions.tokens_used`, mes UTC actual) y "Costo estimado (USD)".
  Para la media móvil: SQL sobre `stella_interactions` agrupando tokens por org y
  por día de los últimos 7 días.
- **Umbral**: tokens de una org en las últimas 24 h > **3× la media diaria de sus
  últimos 7 días** (con un piso mínimo de 50.000 tokens/día para no alertar sobre
  orgs casi inactivas).
- **Primera respuesta**: STELLA_INCIDENTS.md § "C. Consumo anómalo de cuota /
  costo" — revisar interacciones de la org (¿rol/step concentrado? ¿usuario
  único?), y si es abuso poner `stella_monthly_quota=0` (queda auditado). El costo
  estimado usa `lib/stella/cost-model.ts` (heurística — ver G9 antes de tomar
  decisiones de facturación con ese número).

## A5 — Interacciones sin tokens registrados

- **Señal**: SQL: `SELECT COUNT(*) FROM stella_interactions WHERE created_at >= now() - interval '1 day' AND tokens_used IS NULL`.
- **Umbral**: > 10 % de las interacciones del día con `tokens_used` null (el
  post-recovery check del runbook ya exige `tokens_used` no nulo).
- **Primera respuesta**: no bloquea a usuarios, pero rompe la visibilidad de costo
  (A4/G9). Investigar el adapter (¿cambió el shape de respuesta de Gemini?).
  Referencia general: STELLA_INCIDENTS.md § "Verificación post-recuperación".

## A6 — Errores de auditoría (AUDIT_ERROR)

- **Señal**: los usuarios reportan "Failed to record Stella interaction"; no hay
  log dedicado hoy (la acción devuelve el error sin loguear).
- **Umbral**: ≥ 1 reporte — el insert de auditoría es requisito de compliance; si
  falla, la respuesta del modelo se descarta.
- **Primera respuesta**: verificar estado de la base (Supabase) y del trigger
  append-only; escalar como incidente de trazabilidad. Referencia:
  STELLA_INCIDENTS.md § "B" (captura de evidencia) + soporte
  (`STELLA_SUPPORT_PLAYBOOK.md`, código AUDIT_ERROR).
- **Gap conocido**: falta un `console.error('[stella] audit insert failed')` en
  las acciones para que esto sea alertable por logs — propuesto para el WS dueño
  de `app/actions/stella/**` (WS7 no toca esos archivos).

## Higiene de las alertas

- Nunca incluir en una alerta el contenido de `response_json` ni claves; los logs
  `[stella]` ya redactan la key.
- Toda acción tomada en respuesta a una alerta sobre una org (cuota a 0, rotación
  de key, flags) debe quedar en el registro del incidente y, cuando aplica, en el
  audit log de la plataforma.

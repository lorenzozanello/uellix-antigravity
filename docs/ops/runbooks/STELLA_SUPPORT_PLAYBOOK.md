# Playbook de Soporte — Stella

> WS7 · Creado 2026-07-31 (campaña Fable Moonshot). Audiencia: quien atienda
> soporte de clientes (hoy: Lorenzo). Complementa — no reemplaza — el runbook de
> incidentes (`STELLA_INCIDENTS.md`): este documento es para responder a UN
> cliente; aquel es para apagar fuegos sistémicos.

## 1. Cómo consultar el uso de Stella de una organización

1. Iniciar sesión como super-admin → `/admin/services`.
2. La tabla muestra por organización: **Plan**, **Cuota mensual** ("Ilimitado" si
   null; 0 = bloqueada), **Uso este mes** (consultas), **Tokens este mes** y
   **Costo estimado (USD)**.
3. El "mes" es el mes calendario **UTC** — se reinicia el día 1 a las 00:00 UTC
   (misma convención que aplica el enforcement en cada consulta).
4. El costo es una **estimación** (heurística sobre el total de tokens; ver
   `lib/stella/cost-model.ts` y el gate G9) — no citarlo a clientes como cifra
   facturable.
5. Detalle fino (qué rol/paso, cuándo, qué usuario): tabla `stella_interactions`
   filtrando por `organization_id`. La respuesta completa del modelo está en
   `response_json` — **no** compartirla fuera del equipo sin revisar su contenido.
6. El cliente ve su propio estado en `Organización → Suscripción y Facturación`
   (misma fuente de conteo que el admin).

## 2. Mapa de errores usuario-visible → interpretación → acción

Importante sobre la UI: los paneles de Stella solo muestran texto específico para
**QUOTA_EXCEEDED** (pasan el mensaje del servidor tal cual) y ocultan el panel
entero en **DISABLED**. Todos los demás códigos se muestran como el error genérico
del panel:

- Advisor: «La orientación de Stella no está disponible temporalmente. Los datos de tu pipeline no se ven afectados.»
- Validator/Reviewer: «La revisión de Stella no está disponible temporalmente. Los datos de tu pipeline no se ven afectados.»
- Composer: «La redacción de Stella no está disponible temporalmente. El contenido de tu sección no se ve afectado.»

Por eso, ante "no está disponible temporalmente" hay que mirar el código real en
los logs / la respuesta del server action. Mapa completo (mensajes del servidor
citados EXACTOS desde `app/actions/stella/*.ts`):

| Código | Mensaje del servidor (exacto) | Qué significa | Acción de soporte |
|--------|-------------------------------|---------------|-------------------|
| `DISABLED` | "Stella Advisor is not enabled." / "Stella Validator is not enabled." / "Stella Composer is not enabled." / "Stella review role is not enabled." | Flag de entorno apagado (`STELLA_ENABLED`, el del rol, o falta `GEMINI_API_KEY`). El usuario NO ve error: el panel no aparece. | Si es intencional (kill-switch), comunicar mantenimiento. Si no, revisar env vars en Vercel (runbook incidentes, sección kill-switch). |
| `UNAUTHORIZED` | "Authentication required." / "Tu rol no tiene permiso para usar Stella." / "Project access denied." / "Report or project access denied." | Sesión vencida, rol sin permiso (p. ej. viewer), o el proyecto no pertenece a su organización. | Verificar rol del usuario con el admin de la org. Si reclama acceso a un proyecto ajeno a su org: NO es un bug — es el aislamiento funcionando. Accesos cruzados inesperados ⇒ incidente D (fuga entre orgs). |
| `QUOTA_EXCEEDED` (razón `no_quota`) | "Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo." | Org con cuota 0 (default fail-closed): nunca se le asignó plan. | Conversación comercial; si corresponde, asignar plan/cuota en `/admin/services` (queda auditado). |
| `QUOTA_EXCEEDED` (razón `quota_exceeded`) | "Alcanzaste el límite mensual de {N} consultas a Stella (usadas: {usadas}). Se renueva el {fecha}." | Cuota mensual agotada; la fecha de renovación ya viene en el mensaje (día 1 del mes UTC siguiente). | Confirmar consumo en `/admin/services`. Opciones: esperar la renovación o subir la cuota (decisión comercial). Consumo anómalo ⇒ incidente C. |
| `RATE_LIMITED` | "Rate limit exceeded. Resets at {hora}." | Tope de consultas por hora de la org (`STELLA_RATE_LIMIT_PER_HOUR`, default 100/h). | Pedir reintento pasada la hora indicada (UTC). Recurrente en uso legítimo ⇒ evaluar subir el límite. |
| `RATE_LIMIT_UNAVAILABLE` | "Stella rate limit service is temporarily unavailable." | El limitador distribuido (KV) no responde; el sistema falla **cerrado**. Log: `[stella-rate-limit] Distributed limiter unavailable`. | Es sistémico, no del cliente ⇒ incidente E. Avisar que se está trabajando en ello. |
| `TIMEOUT` | "Stella request timed out. Please try again." | La llamada a Gemini superó los 15 s. | Pedir un reintento. Repetido en varios usuarios ⇒ incidente A (proveedor). |
| `PARSE_ERROR` | "Stella returned an unexpected response format." — y en Composer también: "Stella generó cifras o referencias no verificables. Intentá de nuevo." | El modelo devolvió algo fuera de contrato y se **descartó** (fail-closed). La segunda variante es el guardrail anti-alucinación del composer haciendo su trabajo. | Un caso aislado: reintentar. Frecuente ⇒ posible cambio del modelo/prompt ⇒ incidente A/B. Nunca "recuperar" a mano la salida descartada. |
| `GEMINI_ERROR` | "Stella AI service encountered an error." | Error del proveedor. Log: `[stella] Gemini API call failed` con status redactado (401/403 = key; 429 = cuota proveedor; 5xx = outage). | Sistémico ⇒ incidente A. Al cliente: indisponibilidad temporal del servicio de IA, sus datos no se ven afectados. |
| `PAYLOAD_TOO_LARGE` | "El contexto del proyecto es demasiado grande para Stella. Reducí la cantidad de texto e intentá de nuevo." | El contexto del proyecto supera el tope de prompt (default 120.000 caracteres). | Único error accionable POR el cliente: sugerir acortar narrativas/textos muy largos del paso. Si el proyecto es legítimamente enorme, evaluar `STELLA_MAX_PROMPT_CHARS` (decisión de ingeniería, no de soporte). |
| `UNSUPPORTED_STEP` | "Unsupported advisor step." (o el mensaje del builder) | Se pidió un paso fuera del vocabulario (stakeholders, outcomes, narrative, indicators, evidence, proxies, calculation). No debería ocurrir desde la UI. | Si un cliente lo ve: probable manipulación de la request o bug de UI ⇒ escalar a ingeniería con la URL/paso exactos. |
| `AUDIT_ERROR` | "Failed to record Stella interaction. Please try again." | La respuesta del modelo se generó pero **no se pudo registrar la auditoría**, así que se descartó (compliance primero). | Pedir reintento. Persistente ⇒ problema de base de datos ⇒ escalar YA (alerta A6 del plan de alertas); afecta trazabilidad. |
| `UNKNOWN_ERROR` | "An unexpected error occurred." | Cualquier cosa no clasificada. | Recolectar hora UTC + org + proyecto + paso y escalar a ingeniería con logs. |

## 3. Criterios de escalamiento al runbook de incidentes

Escalar de "ticket de soporte" a `STELLA_INCIDENTS.md` cuando:

- **≥ 3 clientes distintos** reportan lo mismo en < 1 hora, o los logs muestran
  `[stella]` errores en ráfaga ⇒ incidente A.
- Un cliente reporta una respuesta de Stella **insegura, inventada o con datos de
  otra organización** ⇒ incidente B (y D si hay datos cruzados) — capturar el
  `stella_interactions.id` ANTES de cualquier otra cosa.
- Consumo/costo anómalo de una org (ver alerta A4) ⇒ incidente C.
- Cualquier `RATE_LIMIT_UNAVAILABLE` ⇒ incidente E.
- `AUDIT_ERROR` persistente ⇒ tratar como incidente de trazabilidad (base de datos).

## 4. Respuestas enlatadas (ES)

**Sin plan asignado:**
> ¡Hola! Stella todavía no está habilitada para tu organización — los planes se
> asignan manualmente desde Uellix (no hay pasarela de autoservicio). Escribinos
> a hola@uellix.com y lo activamos. Mientras tanto, el resto de la plataforma
> funciona con normalidad.

**Cuota agotada:**
> Tu organización alcanzó el límite mensual de consultas a Stella ({N} este mes).
> El cupo se renueva automáticamente el día 1 del próximo mes (UTC). Si
> necesitan más consultas antes, contanos y evaluamos ampliar el plan.

**Servicio de IA temporalmente caído (GEMINI_ERROR / TIMEOUT masivo):**
> Estamos viendo una indisponibilidad temporal del proveedor de IA que usa
> Stella. Tus datos y tu pipeline no se ven afectados — Stella nunca modifica
> información por sí sola. Te avisamos apenas se normalice; el resto de la
> plataforma sigue operativa.

**Contexto demasiado grande (PAYLOAD_TOO_LARGE):**
> El proyecto tiene tanto texto que supera el límite de contexto que le podemos
> enviar a Stella. Probá acortar o dividir las narrativas más largas del paso en
> el que estás y volvé a intentar. Si el volumen es necesario para tu caso,
> contanos y lo revisamos.

**Respuesta descartada por controles (PARSE_ERROR del composer):**
> Stella generó un borrador que no pasó nuestros controles automáticos (por
> ejemplo, cifras o referencias que no se pueden verificar contra tu proyecto),
> así que lo descartamos en lugar de mostrártelo — es el comportamiento esperado
> de seguridad. Volvé a intentarlo; suele resolverse en el siguiente intento.

**Reporte de contenido incorrecto/inseguro:**
> Gracias por reportarlo — lo tomamos en serio. Ya registramos el caso con el
> identificador interno de esa interacción y pausamos la función afectada
> mientras lo revisamos. Recordá que toda salida de Stella requiere revisión
> humana y no constituye certificación; te contactamos con lo que encontremos.

## 5. Qué NUNCA hacer en soporte

- No compartir `response_json` crudo ni logs con clientes.
- No prometer que Stella "certifica" o "aprueba" nada (rol no-certificante,
  reflejado en términos y privacidad).
- No tocar flags ni cuotas de producción para "probar" durante un ticket — todo
  cambio de cuota/plan queda auditado y debe ser una decisión explícita.
- No pedir al cliente material sensible (credenciales, evidencia confidencial)
  por canales de soporte.

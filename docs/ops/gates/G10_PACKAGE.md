# G10 Package — Piloto Controlado y Declaración PRODUCTION_READY

> Gate externo G10 (`docs/ops/STELLA_FABLE_EXTERNAL_GATES.md`). Tipo: **Todos**
> (meta-gate — agrega G1–G9). Dueño humano: **Lorenzo Zanello**, único con
> autoridad para declarar `PRODUCTION_READY`. Ningún agente de esta campaña,
> ni de ninguna futura, puede declarar este resultado.
>
> **Creado en la reconciliación documental 2026-07-31** a partir de la
> auditoría independiente `STELLA_MOONSHOT_INDEPENDENT_VERIFICATION`, que
> encontró G10 mencionado en STATUS/DECISIONS pero sin paquete propio.

## 1. Qué es G10 y qué no es

G10 **no** es un gate técnico nuevo — es el punto de agregación donde se
confirma que G1–G9 están superados con evidencia real y se autoriza un
**piloto controlado** antes de cualquier lanzamiento amplio. Superar G10 no
es lo mismo que declarar `PRODUCTION_READY`: esta última es la conclusión
de un piloto exitoso, no el inicio de uno.

Dos hitos distintos, no confundir:

1. **G10-piloto**: autorización para activar Stella con tráfico real en un
   subconjunto acotado de organizaciones, con monitoreo activo.
2. **G10-production**: declaración `PRODUCTION_READY` tras un piloto exitoso
   sin incidentes no mitigados, con Lorenzo firmando explícitamente.

## 2. Dependencias — G1 a G9 superados con evidencia real

| Gate | Qué debe estar cerrado antes de G10-piloto |
|---|---|
| G1 | Evaluación con Gemini real aprobada por Lorenzo (canary + 28 casos completos, `gates/G1_PACKAGE.md` §5) |
| G2 | Migraciones preparadas aplicadas en staging y verificadas (`gates/G2_PACKAGE.md`) |
| G3 | `pnpm test:rls` verde contra staging con los skips post-G2 flipeados (`gates/G3_PACKAGE.md`) |
| G4 | Al menos el primer rol (Validator) activado y observado por su ventana de 72h sin rollback (`gates/G4_PACKAGE.md`) |
| G5 | Decisión de producto tomada y reflejada en código/config (`gates/G5_PACKAGE.md`) |
| G6 | N/A para esta campaña (heredado de `reference_pdf_generation`) — no bloquea G10 |
| G7 | Revisión legal externa completa, Términos/Privacidad publicados (`gates/G7_PACKAGE.md`) |
| G8 | Smoke de Preview ejecutado y aprobado (`gates/G8_PACKAGE.md`) |
| G9 | Al menos una medición de calibración de costo completada (no necesita las 2 semanas de aceptación binaria para el piloto, pero sí una primera lectura — el piloto mismo genera los datos que G9 necesita) |

G10-piloto puede arrancar con G9 **en progreso** (el piloto es la fuente de
datos de G9), pero G10-production requiere G9 con su criterio de aceptación
(`gates/G9_PACKAGE.md` §7) cumplido.

## 3. Precondiciones adicionales (todas binarias)

- [ ] `docs/ops/STELLA_FABLE_RISK_REGISTER.md`: 0 riesgos P0 en estado ABIERTO
      (mitigados offline o preparados con su gate correspondiente superado).
- [ ] `docs/ops/STELLA_FABLE_DECISIONS.md`: DP-01 (G5), DP-03 (convivencia
      panel legacy/contextual), DP-04 (retención), DP-06 (enforcement de
      `risk_level=high`) resueltas — ninguna decisión de producto pendiente
      bloqueando el piloto.
- [ ] Runbook de incidentes (`docs/ops/runbooks/STELLA_INCIDENTS.md`) y
      playbook de soporte (`docs/ops/runbooks/STELLA_SUPPORT_PLAYBOOK.md`)
      revisados por quien esté de guardia durante el piloto.

## 4. Piloto por cohortes

### 4.1 Organizaciones autorizadas

- El piloto arranca con una lista explícita de organizaciones elegida por
  Lorenzo (recomendado: 1–3 organizaciones internas o de mayor confianza
  primero, nunca todo el universo de clientes de una vez).
- Cada organización del piloto recibe su cuota Stella (`stella_monthly_quota`)
  asignada explícitamente — nunca el fallback `|| 10` (ya corregido, RK-25) ni
  cuota 0 (fail-closed por defecto para el resto de organizaciones).
- Ninguna organización fuera de la lista debe tener Stella accesible durante
  el piloto — verificar `stellaConfig.isEnabled` + flags por rol + cuota 0
  como defensa en profundidad.

### 4.2 Feature flags durante el piloto

Replicar la secuencia de G4 (un flag a la vez, ventana de observación) mismo
si G4 ya se corrió para el rollout inicial — el piloto es una segunda pasada
con tráfico real de clientes, no solo interno:

1. `STELLA_VALIDATOR_ENABLED` → observar.
2. `STELLA_ADVISOR_ENABLED` → observar.
3. `STELLA_COMPOSER_ENABLED` → observar.
4. Roles reviewer (`STELLA_PROXY_REVIEWER_ENABLED` / `STELLA_EVIDENCE_REVIEWER_ENABLED`
   / `STELLA_AUDIT_ASSISTANT_ENABLED`) → uno a la vez, sólo tras `eval:roles`
   verde y G4 completo por rol.

### 4.3 Monitoreo durante el piloto

| Señal | Fuente | Umbral de atención |
|---|---|---|
| Errores Gemini sostenidos | Alerta A1 (`STELLA_ALERTS_PLAN.md`) | Ver umbral del plan de alertas |
| Rate limiter degradado a fallback en memoria | Alerta A2 + `warnMemoryFallbackOnce` en logs | Cualquier ocurrencia en producción se investiga (KV debería estar configurado) |
| Organización alcanza su cuota | Alerta A3 | Confirma que el fail-closed funciona como se espera, no es en sí un incidente |
| Pico de tokens / consumo anómalo | Alerta A4 | Ver umbral del plan de alertas |
| Interacciones sin `tokens_used` registrado | Alerta A5 | Cualquier ocurrencia bloquea la calibración de G9 — investigar el adapter |
| Errores de auditoría (`AUDIT_ERROR`) | Alerta A6 | Cualquier ocurrencia — el audit trail es append-only y no debe fallar silenciosamente |
| Costos reales vs. estimados | `lib/stella/cost-model.ts` + export de billing | Alimenta G9 |
| Denegaciones por rol/cuota inesperadas | `audit_logs` (`stella.denied`) | Confirmar que son denegaciones esperadas (rol insuficiente, cuota) y no un bug de `canUseStella` |

### 4.4 Soporte durante el piloto

- El playbook de soporte (`docs/ops/runbooks/STELLA_SUPPORT_PLAYBOOK.md`)
  debe estar en manos de quien atienda tickets de las organizaciones piloto,
  con el mapa completo de códigos de error y respuestas canned.
- Canal de escalamiento directo a quien pueda activar el kill-switch
  (`STELLA_ENABLED=false` o el flag del rol específico) sin pasar por el
  ciclo normal de deploy.

### 4.5 Incidentes

- Cualquier incidente durante el piloto sigue `docs/ops/runbooks/STELLA_INCIDENTS.md`.
- Un incidente que requiera kill-switch **detiene el reloj del piloto**: la
  ventana de observación se reinicia después de la resolución y el
  post-mortem, no se cuenta el tiempo pre-incidente como "piloto limpio".

## 5. Seguridad y revisión legal — checkpoints previos al piloto

- [ ] G7 (legal) completo — Términos/Privacidad publicados con el lenguaje
      de Stella revisado por el asesor externo.
- [ ] Suite de seguridad offline (`pnpm test:unit` — prompt injection, PII,
      poblaciones sensibles, aislamiento organizacional) verde en el
      checkpoint usado para el piloto.
- [ ] RLS verificado en staging (G3) — el piloto corre contra producción,
      que debe compartir la misma postura RLS que staging verificó.

## 6. Rollback

El rollback de un piloto en curso es **inmediato y de un solo paso**:

1. Apagar el flag del rol afectado (o `STELLA_ENABLED=false` para todo
   Stella) en Vercel — sin deploy, efecto inmediato.
2. Confirmar en `/admin/services` y en el panel del cliente que Stella
   quedó inaccesible para las organizaciones del piloto.
3. Post-mortem antes de reintentar: documentar en
   `docs/ops/runbooks/STELLA_INCIDENTS.md` qué falló y qué cambia antes de
   reactivar.
4. Ningún rollback de G10 implica rollback de datos — `stella_interactions`
   y `audit_logs` son append-only por diseño; lo que se revierte es
   exclusivamente el acceso (flags), nunca el historial.

## 7. Criterios de éxito — G10-piloto → G10-production

| # | Criterio |
|---|----------|
| P1 | Ventana de piloto de al menos 2 semanas consecutivas sin incidente que requiriera kill-switch |
| P2 | Las 6 alertas del plan (A1–A6) permanecieron dentro de umbral, o cualquier disparo fue investigado y cerrado con causa raíz documentada |
| P3 | G9 con su criterio de aceptación cumplido (`gates/G9_PACKAGE.md` §7: A1–A3) usando los datos generados por el piloto |
| P4 | Cero denegaciones inesperadas de `canUseStella` o de cuota (todas las que ocurrieron fueron el comportamiento esperado, no un bug) |
| P5 | Feedback cualitativo de al menos una organización piloto recogido y revisado (no un criterio numérico — confirma que el producto es usable, no solo que no truena) |
| P6 | 0 hallazgos P0 abiertos en `RISK_REGISTER.md` en el momento de la declaración |

## 8. Criterios de aborto

Abortar el piloto (rollback inmediato, §6) y no avanzar a G10-production si:

- Ocurre cualquier incidente de seguridad (fuga de PII, bypass de
  aislamiento organizacional, escritura no confirmada por el usuario).
- El costo real observado excede el estimado por más del umbral de G9
  (30 %) de forma sostenida y sin explicación — riesgo de sorpresa de
  facturación para Lorenzo.
- Cualquier organización del piloto reporta una salida de Stella que
  contradice el lenguaje de "nunca certifica" revisado en G7.
- El rate limiter cae reiteradamente al fallback en memoria en producción
  (señal de que KV no está correctamente configurado en el entorno real,
  no solo en teoría).

## 9. Aprobación explícita de Lorenzo — obligatoria en dos puntos

1. **Antes de G10-piloto**: Lorenzo aprueba explícitamente la lista de
   organizaciones, la secuencia de flags y la ventana de observación.
2. **Antes de G10-production**: Lorenzo revisa la evidencia de §7 (P1–P6)
   y firma la declaración `PRODUCTION_READY`. Esta firma **no puede
   delegarse a un agente ni inferirse de "todo está verde"** — es una
   decisión de negocio, no solo técnica.

## 10. Prohibición explícita

**Ningún documento de esta campaña, ningún agente, ningún commit puede
declarar `PRODUCTION_READY`.** El máximo que el trabajo offline puede
declarar es `STELLA_OFFLINE_RELEASE_CANDIDATE_READY` (ya declarado en
`STELLA_FABLE_STATUS.md`). La transición de `OFFLINE_RELEASE_CANDIDATE_READY`
a `PRODUCTION_READY` pasa exclusivamente por este gate, con evidencia real
de G1–G9 y la firma de Lorenzo en §9.2.

## 11. Sign-off

| Hito | Rol | Nombre | Decisión | Fecha |
|---|-----|--------|----------|-------|
| G10-piloto autorizado | Dueño humano | Lorenzo Zanello | PENDIENTE | ______ |
| G10-production (`PRODUCTION_READY`) | Dueño humano | Lorenzo Zanello | PENDIENTE | ______ |

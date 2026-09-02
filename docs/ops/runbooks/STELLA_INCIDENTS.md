# Runbook — Incidentes y Rollback de Stella

> WS7 · T7.1 · Creado 2026-07-31 (campaña Fable Moonshot). Preparación offline:
> ningún procedimiento de este runbook se ha ejecutado contra producción desde la campaña.

## Kill-switch por capas (rollback inmediato, sin deploy)

Los flags viven en Vercel como env vars (server-only, default `false`). Orden de
apagado del más quirúrgico al más amplio:

1. **Un rol:** `STELLA_ADVISOR_ENABLED` / `STELLA_VALIDATOR_ENABLED` /
   `STELLA_COMPOSER_ENABLED` / `STELLA_PROXY_REVIEWER_ENABLED` /
   `STELLA_EVIDENCE_REVIEWER_ENABLED` / `STELLA_AUDIT_ASSISTANT_ENABLED` = `false`.
2. **Todo Stella:** `STELLA_ENABLED=false` (gate global; `canUseStella` exige además key).
3. **Revocación dura:** rotar/retirar `GEMINI_API_KEY` en Vercel (Stella queda
   fail-closed: `canUseStella = isEnabled && apiKey`). Nota: el adapter no cachea el
   cliente (sin singleton), la rotación surte efecto en la siguiente request.

Cambiar un env var en Vercel requiere redeploy de la función → usar "Redeploy" del
último build verde, no un build nuevo.

## Incidentes tipo

### A. Proveedor caído / errores Gemini masivos
Síntoma: usuarios ven "GEMINI_ERROR"; en logs Vercel líneas `[stella] Gemini API call failed`.
1. Confirmar en logs el `status` (redactado, sin key) — 401/403 ⇒ key; 429 ⇒ cuota proveedor; 5xx ⇒ outage.
2. 401/403: rotar key (precedente real: incidente 2026-07-10, key filtrada/bloqueada,
   403 PERMISSION_DENIED — la rotación en Vercel resolvió).
3. 429/5xx: apagar el rol más ruidoso (capa 1) o todo Stella (capa 2); comunicar; reintentar en 30-60 min.
4. Post-incidente: registrar en audit interno; revisar `stella_interactions` del periodo.

### B. Salida insegura / alucinación reportada por cliente
1. Capturar `stella_interactions.id` (la respuesta completa está en `response_json`).
2. Apagar el rol afectado (capa 1).
3. Reproducir offline con el harness mock usando el `context_hash` como referencia.
4. No reactivar sin: caso añadido a la suite adversarial + verde.

### C. Consumo anómalo de cuota / costo
1. Revisar `app/admin/services` (usage por org) y `stella_interactions` por `organization_id`.
2. Poner `stella_monthly_quota=0` a la org afectada (super-admin UI; queda auditado
   como `stella_service.updated`).
3. Si es transversal: bajar `STELLA_RATE_LIMIT_PER_HOUR` o apagar capa 2.
4. Limitación conocida (RK-22): la cuota cuenta requests, no tokens — hasta cerrar
   WS7/T7.8 el costo real se estima manualmente.

### D. Sospecha de fuga entre organizaciones
1. Apagar capa 2 inmediatamente.
2. Evidencia: `stella_interactions` de ambas orgs + `context_hash`.
3. Verificar RLS de la tabla y el ownership check del builder implicado.
4. Tratar como incidente de seguridad (no solo bug): notificación según política de privacidad.

### E. Degradación de rate limit distribuido
Síntoma: log `[stella-rate-limit] Distributed limiter unavailable`.
- El sistema falla cerrado (RATE_LIMIT_UNAVAILABLE al usuario). Verificar vars KV en Vercel.
- Riesgo conocido (RK-24): el fallback en memoria es por instancia.

## Rollback de despliegues con cambios Stella

1. Vercel → Deployments → último build verde previo → "Promote to Production".
2. Los flags sobreviven al rollback (son env vars, no código).
3. Si el cambio incluía migración DB aplicada: seguir el rollback del paquete G2
   correspondiente (cada migración preparada de esta campaña incluye su script de
   rollback) — nunca improvisar SQL en producción.

## Verificación post-recuperación

- Smoke: invocar advisor en proyecto sintético de una org de prueba (guion en paquete G8 cuando exista).
- Logs sin `[stella]` errores nuevos durante 30 min.
- `stella_interactions` registrando de nuevo con `tokens_used` no nulo.

## Contactos y responsabilidad

- Dueño operativo: Lorenzo (super-admin).
- Sin on-call formal en beta cerrada; los incidentes de datos personales siguen la
  política de privacidad publicada (subprocesador Google/Gemini declarado).

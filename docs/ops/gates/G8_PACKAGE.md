# G8 Package — Preview Smoke de Stella (end-to-end manual)

- **Gate:** G8 — smoke funcional de Stella en un deployment **Preview** de Vercel
  antes de habilitar tráfico real.
- **Dueño humano / aprobador:** Lorenzo Zanello. Ningún agente ejecuta este smoke:
  requiere navegar Preview con credenciales reales.
- **Preparado por:** WS7 (branch `moonshot/ws7-ops`).
- **Estado:** LISTO PARA EJECUCIÓN HUMANA (no ejecutado).

---

## 1. Alcance

Guion de click-path (ES) sobre un deployment Preview que cubre:

1. Advisor contextual — camino feliz.
2. Denegación por cuota 0 (fail-closed).
3. Flag deshabilitado (el panel desaparece).
4. Composer — borrador + aplicar + verificación de no-autosave ("undo").

No toca producción. Solo escribe en la base del entorno Preview
(`stella_interactions` de la org de prueba) — nunca ejecutar contra la base de
producción.

## 2. Prerrequisitos (todos binarios)

| # | Prerrequisito | Verificación |
|---|---------------|--------------|
| P1 | Deployment Preview verde del commit candidato | Vercel → Deployments |
| P2 | Env vars en Preview: `STELLA_ENABLED=true`, `STELLA_ADVISOR_ENABLED=true`, `STELLA_COMPOSER_ENABLED=true`, `GEMINI_API_KEY` válida | Vercel → Settings → Environment Variables (scope Preview) |
| P3 | Vars KV del rate limit configuradas en Preview (si faltan, todo intento devuelve RATE_LIMIT_UNAVAILABLE y el smoke no puede pasar) | idem |
| P4 | **Org A (habilitada):** org de prueba con `stella_monthly_quota` ≥ 10 asignada vía `/admin/services`, con un proyecto que tenga al menos: 1 narrativa, 2+ stakeholders, 1 outcome con indicador, y un reporte con una sección editable | preparar antes del smoke |
| P5 | **Org B (bloqueada):** org de prueba con cuota **0** (default — basta con no asignarle plan) y un proyecto mínimo | idem |
| P6 | Usuario con rol que puede usar Stella en ambas orgs (admin u organization_admin); opcionalmente un usuario `viewer` para el paso 5 opcional | idem |

## 3. Guion (ES) — pasos, resultados esperados y evidencia

> Capturar **screenshot por paso** y guardarlos como
> `artifacts/g8-smoke/<fecha>/paso-NN.png` (local; no se commitean). Anotar la
> hora UTC de cada paso para poder correlacionar con logs de Vercel.

### Parte 1 — Advisor contextual: camino feliz (Org A)

| Paso | Acción | Resultado esperado |
|------|--------|--------------------|
| 1.1 | Iniciar sesión en el Preview con el usuario de Org A | Dashboard de la org |
| 1.2 | Ir a `Proyectos → [proyecto de prueba] → Pipeline → Grupos de interés` | Se ve el panel "Stella Advisor" con el botón **"Preguntar a Stella"** y la leyenda "Stella brinda orientación consultiva únicamente…" |
| 1.3 | Click en **"Preguntar a Stella"** | Skeleton de carga; en < 20 s aparece orientación en español, específica del paso (stakeholders), **sin** cifras inventadas ni promesas de certificación; se mantiene visible el aviso de revisión humana |
| 1.4 | Repetir 1.2–1.3 en el paso `Cálculo` | Respuesta coherente con el estado real del cálculo del proyecto (si no está listo, la orientación lo refleja — no inventa resultados) |
| 1.5 | En `/admin/services` (como super-admin) refrescar la fila de Org A | "Uso este mes" subió en 2; "Tokens este mes" > 0; "Costo estimado" muestra un valor ≈ formateado en USD |

**Evidencia:** screenshots 1.2–1.5 + fila de `stella_interactions` más reciente
(id, `stella_role='advisor'`, `pipeline_step`, `tokens_used` no nulo).

### Parte 2 — Denegación por cuota 0 (Org B)

| Paso | Acción | Resultado esperado |
|------|--------|--------------------|
| 2.1 | Cambiar a Org B (cuota 0) y abrir cualquier paso del pipeline | El panel de Stella es visible (el flag está ON) |
| 2.2 | Click en **"Preguntar a Stella"** | Mensaje exacto: **"Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo."** — sin llamada al modelo |
| 2.3 | Verificar en `/admin/services` | Org B sigue con "Uso este mes" = 0 y "Tokens este mes" = 0 (la denegación **no** consume ni registra interacción) |
| 2.4 | Ir a `Organización → Suscripción y Facturación` como Org B | Muestra **"Sin plan asignado"** y "contactá a Uellix" — nunca una cuota inventada (p. ej. 10) |

**Evidencia:** screenshots 2.2–2.4.

### Parte 3 — Flag deshabilitado

| Paso | Acción | Resultado esperado |
|------|--------|--------------------|
| 3.1 | En Vercel (scope Preview) poner `STELLA_ADVISOR_ENABLED=false` y redeploy del mismo build | Deployment verde |
| 3.2 | Como Org A, recargar un paso del pipeline | El panel del advisor **no se renderiza** (los paneles retornan `null` en DISABLED — no hay botón, no hay error) |
| 3.3 | Restaurar `STELLA_ADVISOR_ENABLED=true` + redeploy | El panel vuelve |

**Evidencia:** screenshots 3.2 (sin panel) y 3.3 (panel de vuelta).

### Parte 4 — Composer: borrador + aplicar + no-autosave (Org A)

| Paso | Acción | Resultado esperado |
|------|--------|--------------------|
| 4.1 | Ir al reporte del proyecto de prueba y abrir la edición de una sección; anotar el título y contenido actuales | Formulario con título/contenido visibles; panel "Stella Composer" con botón **"Redactar con Stella"** |
| 4.2 | Click en **"Redactar con Stella"** | En < 20 s aparece "Borrador propuesto" con título, contenido, supuestos/limitaciones si aplican, y la leyenda "Requiere revisión humana antes de guardar o publicar" |
| 4.3 | Click en **"Usar este borrador"** | Los campos del formulario se rellenan con el borrador — **sin guardado automático** |
| 4.4 | "Undo": recargar la página **sin guardar** | La sección vuelve a mostrar el título/contenido originales de 4.1 (el borrador nunca tocó la base) |
| 4.5 | (Opcional) Repetir 4.2–4.3 y esta vez guardar explícitamente | El contenido guardado es el borrador; queda en manos del flujo normal de edición |

**Evidencia:** screenshots 4.1–4.4; en 4.4 el contenido original visible.

### Parte 5 (opcional) — Rol sin permiso

| Paso | Acción | Resultado esperado |
|------|--------|--------------------|
| 5.1 | Iniciar sesión como usuario `viewer` de Org A y abrir un paso del pipeline | Si el panel es visible y se intenta usar: error de rol ("Tu rol no tiene permiso para usar Stella." → el panel muestra el estado de error genérico); nunca se llama al modelo |

## 4. Criterios de aprobación (binarios)

G8 **pasa** solo si TODOS se cumplen:

| # | Criterio |
|---|----------|
| A1 | Partes 1–4 completadas con los resultados esperados exactos |
| A2 | Ningún error `[stella]` inesperado en los logs de Vercel durante la ventana del smoke (los pasos de denegación no generan logs de error de Gemini) |
| A3 | `stella_interactions` registra las interacciones del camino feliz con `tokens_used` no nulo |
| A4 | La denegación por cuota no registró interacción ni consumo |
| A5 | Evidencia (screenshots + horas UTC) archivada localmente |

Cualquier NO ⇒ G8 falla; abrir hallazgo, corregir y repetir el guion completo.

## 5. Rollback

Sin rollback de datos: el smoke solo escribe filas de `stella_interactions` de
orgs de prueba en Preview. Restaurar los flags tocados en la Parte 3 y, si se
desea, poner `stella_monthly_quota=0` de nuevo a la Org A.

## 6. Sign-off

| Rol | Nombre | Decisión (APPROVE / REJECT) | Fecha |
|-----|--------|-----------------------------|-------|
| Dueño humano | Lorenzo Zanello | ______ | ______ |

# G9 Package — Calibración de Costo Real de Stella

- **Gate:** G9 — validar el modelo de costo (`lib/stella/cost-model.ts`) contra la
  facturación real de Gemini antes de usarlo para decisiones comerciales
  (pricing de planes, márgenes, límites por plan).
- **Dueño humano / aprobador:** Lorenzo Zanello (único con acceso al billing de
  Google AI Studio / Cloud).
- **Preparado por:** WS7 (branch `moonshot/ws7-ops`).
- **Estado:** DEFINIDO — ejecutable recién **después de G1 y G8** (hasta entonces
  no hay tráfico real que medir).
- **Prerrequisito de datos:** que las interacciones registren `tokens_used` no
  nulo (verificado en G8/A3; alerta A5 del plan de alertas lo vigila).

---

## 1. Qué afirma hoy el modelo de costo (a validar)

`lib/stella/cost-model.ts`, constantes al 2026-07-31
(fuente: https://ai.google.dev/gemini-api/docs/pricing, tier pago):

- Modelo: `gemini-2.5-flash` — input USD 0.30/1M tokens, output USD 2.50/1M
  (thinking tokens facturan como output).
- **Heurística mixta:** solo se almacena el total de tokens por interacción
  (`tokens_used`), no el split input/output. El modelo asume **80 % input /
  20 % output** ⇒ tarifa mezclada de **USD 0.74/1M tokens**.
- Modelos desconocidos caen al precio del modelo default.

Los tres puntos son supuestos, no hechos. G9 los convierte en números medidos.

## 2. Qué medir (después de G1/G8, con tráfico real o del smoke ampliado)

1. **Tokens por rol y por paso:** SQL sobre `stella_interactions`:
   `SELECT stella_role, pipeline_step, COUNT(*), AVG(tokens_used), MIN(tokens_used), MAX(tokens_used) FROM stella_interactions WHERE created_at >= <inicio ventana> GROUP BY 1, 2 ORDER BY 1, 2;`
   Registrar la tabla resultante por tamaño típico de proyecto (chico: ≤ 2
   outcomes; mediano: 3–6; grande: > 6) — el tamaño se anota manualmente por
   proyecto observado.
2. **Costo observado:** export de facturación de Gemini para la misma ventana
   (input que provee Lorenzo, ver §4), idealmente con desglose input/output
   tokens por día.
3. **Costo estimado:** para la misma ventana, `estimateCostUsd(SUM(tokens_used))`
   (el mismo cálculo que muestra `/admin/services`).

## 3. Cómo recalibrar las constantes (backfill)

Con el export de billing en mano:

1. **Split real input/output:** si el export desglosa tokens por dirección,
   `assumedInputShare = input_tokens / (input_tokens + output_tokens)` de la
   ventana. Actualizar `COST_MODEL_ASSUMPTIONS.assumedInputShare`.
2. **Precios:** verificar contra la página de pricing vigente y actualizar
   `pricesUsdPerMillionTokens` + `asOfDate` + `source` si Google cambió tarifas.
3. **Discrepancia de conteo:** si `SUM(tokens_used)` difiere del total de tokens
   facturado por Gemini en > 10 %, investigar el adapter (qué campo de usage se
   persiste) **antes** de tocar precios — no compensar un bug de conteo con
   constantes de precio.
4. Cada recalibración es un commit que actualiza SOLO las constantes y la fecha,
   citando la ventana medida en el mensaje del commit; los tests puros del
   modelo (`tests/stella-cost-model.test.ts`) no dependen de los valores exactos
   y siguen en verde.

## 4. Inputs que debe proveer Lorenzo

| Input | Detalle |
|-------|---------|
| Export de billing de Gemini | CSV/JSON desde Google AI Studio o Cloud Billing, ventana ≥ 14 días con tráfico, idealmente con desglose input/output. **Nunca commitearlo al repo** — contiene datos de cuenta; se archiva localmente |
| Ventana de medición | Fechas UTC inicio/fin, para que el SQL de §2 y el export cubran lo mismo |
| Clasificación de tamaño de proyectos | Etiqueta chico/mediano/grande de los proyectos activos en la ventana |

## 5. Criterios de aborto

No recalibrar constantes (mantener las vigentes) si ocurre cualquiera de:

- El export de billing no cubre la misma ventana UTC que el SQL de §2 —
  medir sobre ventanas distintas produce una comparación inválida.
- La discrepancia de conteo (§3.3) supera el 10 % — indica un bug de
  instrumentación en el adapter, no un problema de precio; corregir el
  conteo primero y repetir la medición antes de tocar constantes.
- Menos de 14 días de tráfico real disponibles, o el tráfico de la ventana
  es predominantemente de canary/smoke (no representativo de uso real).
- El export de billing no puede obtenerse sin exponer datos de cuenta más
  allá de lo necesario (en ese caso, escalar a Lorenzo en vez de aproximar).

## 6. Rollback

Este gate es de **solo lectura y cálculo** — no aplica cambios de esquema,
flags ni infraestructura. No hay estado remoto que revertir. El "rollback"
de una recalibración es exclusivamente de código:

1. Cada recalibración es un commit aislado que toca únicamente
   `lib/stella/cost-model.ts` (constantes + `asOfDate` + `source`).
2. Si una recalibración resulta errónea (p. ej. se descubre después que la
   ventana medida no era representativa), revertir ese commit puntual
   restaura las constantes anteriores sin afectar ningún otro sistema.
3. El export de billing usado como insumo nunca se commitea (§4) — no hay
   dato remoto que limpiar tras un rollback.

## 7. Criterio de aceptación (binario)

G9 **pasa** cuando, durante **2 semanas consecutivas** con tráfico real:

| # | Criterio |
|---|----------|
| A1 | \|costo estimado − costo observado\| / costo observado ≤ **30 %** en cada una de las 2 semanas |
| A2 | `SUM(tokens_used)` vs tokens facturados difieren ≤ 10 % (conteo confiable) |
| A3 | Las constantes del cost-model quedaron actualizadas (commit con ventana citada) y `/admin/services` muestra los valores recalibrados |

Mientras G9 no pase, todo número de costo en `/admin/services` se trata como
orden de magnitud (así lo dice el footer de la página) y **no** se usa para
fijar precios de planes.

## 8. Sign-off

| Rol | Nombre | Decisión (APPROVE / REJECT) | Fecha |
|-----|--------|-----------------------------|-------|
| Dueño humano | Lorenzo Zanello | ______ | ______ |

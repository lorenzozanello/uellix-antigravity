# Validación del cálculo SROI — modelo de control independiente

Estado: **modelo de control construido; comparación contra Uellix PENDIENTE** (sin sesión,
ver `00_EXECUTIVE_SUMMARY.md`).

## Convención de cálculo

Leída en modo lectura de `lib/pipeline/sroi-calculation.ts:699-703` para que el modelo de
control sea *comparable* (una discrepancia debe significar un defecto, no una diferencia
de convención):

```
gross = cantidad × proxy × años
net   = Σ_{yr=1..N} cantidad × proxy
                  × (1−dw)(1−attr)(1−disp)
                  × (1−dropoff)^(yr−1)
                  × 1/(1+r)^(yr−1)
SROI  = net / inversión_total
```

Notas relevantes del motor:
- El **año 1 no se descuenta ni sufre drop-off** (exponente `yr−1`), consistente entre
  ambos factores.
- `durationYears` se acota a `[1, 50]`; los cuatro porcentajes se acotan a `[0, 100]`
  vía `clamp()` (línea 686-690) — **relevante para la prueba negativa de ">100%": el motor
  no rechaza, satura**. Debe verificarse si la UI valida antes de llegar aquí.
- Todo se normaliza a **USD** (`amountUsd`, congelado al guardar). Como numerador y
  denominador se convierten al mismo tipo de cambio, **el ratio es invariante al FX**, por
  lo que este control se computa directamente en COP sin pérdida de validez.
- `quantity ≤ 0` o `proxy ≤ 0` → la línea se **omite silenciosamente** (línea 684), no
  produce error. Relevante para la prueba negativa de números negativos.

## Datos de entrada (del prompt)

| Outcome | Cantidad | Proxy (COP) | Años | dw | attr | disp | drop-off |
|---|---|---|---|---|---|---|---|
| 1 — Tiempo ahorrado | 20.592 h/año (120 × 3,3 × 52) | **AUSENTE** | 3 | 10% | 10% | 0% | 20% |
| 2 — Gasto evitado | 120 hogares | 636.000/hogar/año (53.000 × 12) | 3 | 15% | 10% | 0% | 15% |
| 3 — Bienestar | 220,8 personas (480 × 46%) | 300.000/persona/año | 2 | 20% | 20% | 5% | 25% |
| 4 — Capacidad | 22 participantes | 800.000/participante | 3 | 10% | 15% | 0% | 20% |

Inversión total: **235.000.000 COP** (180M financiero + 30M especie + 15M comunidad + 10M voluntariado).

## Resultado del modelo de control

Reproducible: `node independent_sroi.mjs`

| Concepto | r = 0% | r = 3,5% |
|---|---|---|
| Outcome 2 (net) | 150.194.898 | 145.711.968 |
| Outcome 3 (net) | 70.479.360 | 69.457.920 |
| Outcome 4 (net) | 32.852.160 | 31.914.981 |
| **Subtotal sin Outcome 1** | **253.526.418** | **247.084.869** |
| **SROI sin Outcome 1** | **1,079:1** | **1,051:1** |

## Hallazgo: el dataset no puede alcanzar el rango de control

El rango esperado es **2,7:1 – 3,2:1**. Sin el Outcome 1 el modelo aterriza en ~1,05–1,08.
Para alcanzar el rango, el Outcome 1 debería aportar entre 380M y 500M COP de valor neto,
es decir **~2/3 del total**.

Proxy por hora que sería necesario:

| Objetivo | r = 0% | r = 3,5% |
|---|---|---|
| 2,7:1 | 9.361 COP/h | 9.799 COP/h |
| 3,2:1 | 12.248 COP/h | 12.771 COP/h |

**Este valor no se ha aplicado.** Derivarlo hacia atrás desde el resultado esperado es
precisamente lo que el prompt prohíbe ("no fuerces el resultado para que coincida"), y
convertiría el control en una tautología: el modelo confirmaría el rango por construcción,
no por evidencia. Se necesita que el proxy del Outcome 1 se fije **por criterio
metodológico** (p. ej. salario mínimo por hora en Colombia, coste de oportunidad del
cuidador) y de forma independiente al ratio que produzca.

Para referencia — y explícitamente **no** como propuesta de valor a usar: el salario mínimo
colombiano 2025 ronda los ~5.400 COP/hora, aproximadamente la mitad del extremo inferior
del rango necesario. Esto sugiere que o bien el rango 2,7–3,2 se calculó con supuestos
distintos a los del prompt, o bien falta algún componente del dataset además del proxy.
Merece revisión antes de usar 2,7–3,2 como criterio de aceptación.

## Decisiones tomadas (2026-07-16, Lorenzo)

1. **Outcome 1 → se audita SIN valorar.** Se carga en la plataforma con su cantidad,
   duración y filtros (para ejercitar los módulos de outcomes/indicadores/filtros), pero
   sin proxy. El motor lo omitirá del cálculo por la regla `proxy ≤ 0 → continue`
   (`sroi-calculation.ts:684`) — comportamiento que se verificará explícitamente como
   parte de la auditoría.
2. **Rango de control 2,7:1 – 3,2:1 → NO APLICABLE en esta corrida.** Se sustituye por el
   valor de control **1,051:1 (r=3,5%)** / **1,079:1 (r=0%)** calculado arriba. El
   criterio de aceptación numérico pasa a ser: *la diferencia entre Uellix y este modelo
   debe ser < 2%*.
3. **Tasa de descuento → 3,5%**, fijada por la corrida (el esquema la permite nula sin
   default). Establecerla vía UI es en sí mismo un caso de prueba; el control cubre
   ambos escenarios (0% y 3,5%) por si el campo no fuera editable.
4. **Interpretación del Outcome 3 → cantidad = 220,8** (480 × Δ46%). Si la UI de Uellix
   impone otra lectura, se documenta como discrepancia de convención, no como defecto.

Pendiente de decisión futura (fuera del alcance de esta corrida): fijar un proxy del
Outcome 1 por criterio metodológico y revisar de dónde salía el rango 2,7–3,2.

## Comparación pendiente

Cuando haya sesión, comparar contra Uellix, campo a campo, y documentar toda diferencia
> 2%: cantidades · proxy values · valor bruto · deadweight · attribution · displacement ·
drop-off · descuento · valor presente · inversión · ratio SROI.

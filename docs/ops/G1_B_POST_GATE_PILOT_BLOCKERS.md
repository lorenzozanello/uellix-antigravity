# G1_B_POST_GATE_PILOT_BLOCKERS

> Hallazgos que **no** bloquean el gate G1-B y que **sí** deben resolverse o
> aceptarse explícitamente **antes de abrir tráfico piloto**.
>
> Registro creado a partir de la auditoría independiente adversarial de G1-B
> (Fable, read-only, reconstruyendo el path desde el código).
> Baseline: `aaaa02ad225724dc7ee77505090db013f71b7b3b` + delta local de G1-B.
>
> Un ítem sale de esta lista de una de dos maneras: **RESUELTO** (con el commit
> que lo cierra) o **ACEPTADO** (con una decisión firmada en
> `docs/ops/STELLA_FABLE_DECISIONS.md`). No hay una tercera.

---

## PB-01 — `PROVIDER_CALL_CONCURRENCY_PER_TICKET`

| | |
|---|---|
| **Clasificación** | `PILOT_BLOCKER` / `G9_COST_PERF` |
| **Estado** | **ABIERTO — no se arregla en G1-B, por decisión** |
| **Bloquea G1-B** | **No** |
| **Bloquea tráfico piloto** | **Sí** |
| **Origen** | auditoría independiente Fable, G1-B |

### El hallazgo

Un ticket que ya está `bound` puede recibir **entregas concurrentes**. El
protocolo gobernado cierra la transacción de `bind` antes de ejecutar — a
propósito, para no serializar una organización entera detrás del round trip de
un revisor — así que la reserva pasa a ser un **estado de fila**
(`status='bound'` con `expires_at` vivo), no un lock retenido.

Consecuencia: N entregas del **mismo** ticket pueden entrar en `execute` a la
vez, y cada una puede alcanzar al proveedor antes de que un `complete` gane la
carrera.

```
1 ticket  →  1 consumo de rate limit (se gasta en EMISIÓN)
          →  1 reserva de cuota
          →  N llamadas a Gemini
          →  1 settlement de Uellix
```

### Qué NO es

**No es un doble cobro** y no es un fallo de aislamiento. La contabilidad de
Uellix es correcta: el ledger cobra exactamente una unidad, y
`complete_operation_ticket` responde `replayed` a los perdedores, cuya respuesta
se **descarta** en vez de entregarse (`governed-operation.ts`, rama
`settled.kind === 'replayed'`, con su razonamiento explícito: devolver esos
datos sería entregar una segunda respuesta por una unidad cobrada).

**No es un agujero cross-tenant.** Todas las entregas concurrentes son del mismo
actor, la misma organización, el mismo proyecto y la misma categoría — el ticket
las suelda.

### Qué sí es

Una **asimetría de coste frente al proveedor**: Uellix cobra 1, Google puede
cobrar N. Bajo un solo usuario secuencial N=1 siempre. Bajo tráfico piloto —
doble clic, reintentos del navegador, un panel remontado, dos pestañas — N>1
deja de ser hipotético.

### Por qué no se arregla ahora

Cerrarlo requiere una de estas, y **ninguna** es un cambio pequeño ni revisable
dentro de un delta de precondiciones:

- un estado `bound → executing` con transición atómica;
- un lock adicional retenido durante el round trip (justo lo que el diseño
  actual evita a propósito);
- idempotencia del lado del proveedor;
- un rediseño de concurrencia.

Instrucción explícita del gate: **no implementar nada de eso en G1-B.**

### Qué exige antes del piloto

Una de dos:

1. **RESUELTO** — con un diseño que no reintroduzca la serialización por
   organización que `runGovernedStellaOperation` eliminó deliberadamente; o
2. **ACEPTADO** — con una decisión firmada que declare el techo de coste
   asumido, apoyada en una medición real de cuántas entregas concurrentes
   produce el producto (el panel ya distingue `start` de `retry`: `retry` reusa
   el ticket y **no** emite uno nuevo, así que el vector real es la
   concurrencia, no el reintento).

### Consecuencia para el CONTRATO DE EVIDENCIA de G1-B

PB-01 no sólo describe un riesgo de coste: es **la razón por la que
`operation_tickets.bound_at` no puede contar llamadas al proveedor**.

Una versión temprana del runbook afirmaba
«nº de llamadas ≤ Δ(tickets con `bound_at`)». Es falso por este mismo hallazgo:
un `bind` admite N ejecuciones. `bind` es condición **necesaria** para llegar al
proveedor, no proporcional a las llamadas.

Lo que sobrevive es una implicación en una sola dirección — **un ticket que
nunca alcanzó `bound_at` no pudo alcanzar al proveedor** — y sólo se usa para
probar **cero** en caminos que deben rechazar antes de `bind`
(`ZERO-CALL NEGATIVE-PATH EVIDENCE`, §3 del runbook). El conteo exacto del happy
path depende del gate A0 (§4.0 del runbook), no de esta tabla.

Corolario: **mientras PB-01 siga abierto, ninguna cifra derivada del ledger de
Uellix — `stella_interactions`, cuota, `audit_logs`, `completed_at` — puede
leerse como número de llamadas al proveedor.** Cerrar PB-01 es también lo que
haría innecesaria esa distinción.

### Evidencia

- `lib/stella/operation-ticket/governed-operation.ts` — «ONE TRANSACTION PER
  CALL» y la rama `replayed`.
- `db/prepared/stella_0016_reserved_quota_semantics.sql`, cuerpo de `bind`: un
  ticket ya `bound` con el mismo digest responde **idempotente** y deja seguir a
  la ejecución — que es exactamente el mecanismo de PB-01.
- `db/stella/operation-tickets.ts` — cabecera: cerrar la transacción de `bind`
  antes de generar es un requisito del protocolo (INT-INT-001 §4 paso 3).
- `components/stella/use-stella-operation.ts` — `start` vs `retry`.

---

## HZ-01 — `TEST_REAL_GEMINI_EGRESS`

| | |
|---|---|
| **Clasificación** | `TEST_HARNESS_HAZARD` / `FIX_BEFORE_COMMIT` |
| **Estado** | **CLOSED** — control estructural instalado y probado |
| **Bloquea G1-B** | No |
| **Bloquea tráfico piloto** | No |
| **Origen** | descubierto al escribir `provider-call-observability.test.ts` (G1-B) |

### Causa

`vi.mock('@google/genai')` **no intercepta bajo concurrencia**. Medido con una
sonda mínima sin código nuestro más allá del adapter:

| Caso | Resultado |
|---|---|
| dos adapters, **secuencial** | el mock aplica; cero red |
| dos adapters, **concurrente** (`Promise.all`) | **el mock se salta, carga el SDK real y sale una petición HTTPS a `generativelanguage.googleapis.com`** |

Calentar el registro de módulos con una llamada secuencial previa **no** lo
evita. La causa está en la resolución de dos `await import('@google/genai')`
concurrentes del mismo especificador.

### Impacto observado

Del orden de 4–8 peticiones reales, en cuatro ejecuciones durante el desarrollo,
con claves **inválidas** (`'AIza-CANARY-KEY-do-not-log'`, `'k'`). Google
respondió `400 INVALID_ARGUMENT / API_KEY_INVALID`. **Cero contenido generado,
cero cuota, cero facturación**, y los cuerpos sólo contenían cadenas canario del
propio test — ningún dato de proyecto ni de tenant. El incidente **no se oculta**:
está declarado en `G1_B_PROVIDER_INVOCATION_OBSERVABILITY_REPORT`.

### Riesgo potencial

**Una llamada facturable.** Medido en la máquina de desarrollo:
`AMBIENT_GEMINI_KEY_SET=true`. Un adapter construido sin `apiKey` explícito cae
en `stellaConfig.geminiApiKey` ← `process.env.GEMINI_API_KEY`; ese mismo escape
con la clave por defecto habría enviado el request a Google y habría facturado.
Lo único que lo evitó fue que el test pasaba una clave errónea.

La nota operativa histórica «hay que hacer `unset GEMINI_API_KEY` o fallan 3
tests» enmascaraba esto: trataba la variable como una molestia de aserciones,
cuando además era **lo único** que separaba un test concurrente de una llamada
real.

### Control permanente

`vitest.setup.network-guard.ts`, registrado como **primer** `setupFile` de la
config por defecto (heredado por la de integración vía `mergeConfig`) y añadido
explícitamente a la de e2e, que no declaraba ninguno.

- Envuelve `globalThis.fetch` — el **único** primitive de egreso del SDK 2.10.0,
  trazado por lectura de `dist/node/index.mjs` (`apiCall` → `fetch(url, requestInit)`;
  `DEFAULT_FETCHER` → `fetch(input, init)`; sin `https.request`, sin Dispatcher).
- Envuelve además `node:https` / `node:http` (`request`/`get`) como defensa en
  profundidad frente a un cambio de transporte en una versión futura.
- Rechaza `generativelanguage.googleapis.com`, `aiplatform.googleapis.com` y
  `vertexai.googleapis.com` con `TEST_REAL_GEMINI_NETWORK_BLOCKED`, **lanzado
  síncronamente y sin delegar** — probado con un spy como transporte que queda
  sin invocar.
- El error nombra sólo **host y método**. Nunca URL, query, path, headers,
  authorization, key ni body.
- **Sin opt-out.** No lee ninguna variable de entorno; no existe
  `ALLOW_REAL_GEMINI_TESTS` y hay un test que lo prohíbe.

### La evaluación real en vivo NO está bajo este guard

Sigue siendo exclusivamente el harness gobernado
`pnpm tsx tests/eval/stella-contextual-real/run.ts`
(`docs/ops/gates/G1_PACKAGE.md`), que **no corre bajo Vitest**, no carga ningún
setup file y conserva sus propios acknowledgements. La separación está probada:
el runner no importa `vitest.setup` ni `network-guard`, y el guard sólo figura
en las configs de Vitest.

> **Vitest → Gemini real IMPOSIBLE. Harness tsx → sigue permitido bajo sus propias guardas.**

### Limitación residual

Dos suites reemplazan el `fetch` global por un mock propio
(`tests/fx-sub-form.test.tsx`, `tests/sroi-demo-calculator.test.tsx`). En ellas
el guard queda sustituido — pero por un `vi.fn()` que no hace I/O, así que no hay
egreso posible. El wrapper de `node:http`/`node:https` sigue activo en esos
archivos. Un test que reemplazara el `fetch` global por un transporte **real**
eludiría el guard; hoy no existe ninguno.

---

## Fuera de alcance en este delta (registrados, no tocados)

No son bloqueadores de piloto por sí mismos; quedan aquí para que su ausencia
del delta sea **deliberada y visible**, no un olvido:

| ID | Ítem | Nota |
|---|---|---|
| BK-01 | `userQuestion` sin cablear en el path de inyección | el parámetro existe en `buildAdvisorContextualUserMessage` y ningún llamador lo pasa |
| BK-02 | asimetría raw/clean en `sanitizeNarrative` | `sanitizeUntrustedText` sí prueba ambas formas; `sanitizeNarrative` sólo la limpia |
| BK-03 | decisión de producto: ¿auditoría fail-closed? | hoy es fire-and-forget y observable; convertirla en bloqueante es una decisión de producto |
| BK-04 | verificador de bundle final | — |
| BK-05 | optimización de coste G9 | — |
| BK-06 | tuning de `thinkingConfig` | prohibido antes de medir |
| BK-07 | tuning de timeout | ver R4 del runbook: banda ambigua, n ≥ 3 |
| BK-08 | rediseño de `complete`/`rejected` | el caso «no sabemos si el cobro cayó» retiene la respuesta, que es lo correcto hoy |
| BK-09 | borrado total de la acción legacy | requiere migrar el harness de cuota multicategoría |
| BK-10 | `STELLA_LEGACY_ADVISOR_ENABLED` fuera de `STELLA_FEATURE_FLAGS` | añadirlo invalidaría evidencia de aprovisionamiento ya archivada (`checkpoint-a1`, `absentFlags`) |
| TOOLING-BK-STAGED-DELETION-SCAN | `pnpm secrets:scan:staged` emite un fatal por stderr ante archivos **eliminados** en el índice | Registrado en el delta de gobernanza G1-B (2026-08-17) y **no ampliado**. `pnpm secrets:scan` sobre el árbol completo no está afectado y es el que corre en CI, así que la puerta de credenciales sigue cerrada; lo que falla es la variante *staged*, y sólo cuando el índice contiene un borrado. Arreglarlo es un cambio en `scripts/scan-secrets.ts`, no en ningún paquete gobernado |
| POST_G1_B-0020-GRANT-INSPECTION | §0.4 de `stella_0020` inspecciona los escritores por `information_schema.role_table_grants` | La vista está **filtrada a los roles habilitados** de la sesión, así que su modo de fallo teórico es un **PASS falso**: un escritor que la sesión no ve es un escritor que la prueba de default-muerto no reporta. Fable lo confirmó y lo clasificó **NONBLOCKER**: sobre el objetivo real la comprobación corre como `postgres`, que es *grantor* de esos privilegios, y `stella_0017` ya retiró `authenticated`/`anon`/`service_role`. **Retenido, no cerrado.** El cambio es sustituir el predicado por `pg_class.relacl` + `aclexplode` (no filtrada), lo cual altera lo que el paquete REHÚSA y por tanto exige su propia revisión y su propio re-pin — no entra en un delta de gobernanza. Mientras tanto, la corroboración no filtrada vive en el preflight R1 del operador |

# Plan maestro revisado de Stella

**Fecha:** 2026-07-24 · **Rama:** `feature/stella-generation-copilot` · **Commit base:** `4c8a8ed`
**Estado:** corrige y sustituye la antigua "Fase 0" de `STELLA_IMPLEMENTATION_ROADMAP.md`. Las Fases 1-5 de ese documento siguen vigentes tras esta corrección; la fuente de verdad ejecutable pasa a ser `STELLA_REVISED_BACKLOG.csv`.

---

## 1. Diagnóstico validado (re-verificado contra código en esta sesión)

Los cinco documentos de auditoría (`STELLA_CURRENT_STATE_AUDIT.md` y anexos) se releyeron y se re-contrastaron contra el código. Se confirman sus hallazgos principales y se identifican **dos correcciones nuevas**, no presentes en la auditoría original:

1. **`stella_interactions` tiene grants de tabla contradictorios.** `db/migrations/0033_public_api_grants.sql:50` concede `SELECT, INSERT, UPDATE, DELETE` a `authenticated` — a diferencia de `audit_logs`/`sroi_calculation_runs`/`sroi_calculation_line_items`, que en el mismo fichero reciben deliberadamente solo `SELECT, INSERT` por ser append-only (`0033:56-58`). El carácter append-only de `stella_interactions` depende **únicamente** de que `0032_rls_specialized.sql` no defina políticas de UPDATE/DELETE — es una protección de una sola capa (ausencia de política), no de dos (grant + política). Esto se corrige documentalmente en esta etapa y se cubre con test (§5, A1.1); corregir el grant en sí queda fuera de alcance de A1 por ser un cambio de superficie más amplio, y se registra como tarea de una etapa posterior.
2. **La afirmación "Stella live in Production" no requiere corrección documental activa.** Se rastreó a `docs/superpowers/plans/2026-07-02-stella-complete-quotas.md:2085`, un plan **histórico y fechado** que describe una acción tomada en su momento (no verificable ni refutable desde el repo hoy). No se edita un documento histórico para no reescribir su registro. `STELLA_CURRENT_STATE_AUDIT.md §16` ya declara correctamente que el estado real en producción "no es verificable desde el repo" — eso es lo correcto, no una corrección pendiente.

Todo lo demás del diagnóstico original (prompts genéricos, ausencia de procedencia de campo, ausencia de arnés de evaluación, sanitización débil, ausencia de grounding/RAG/extracción documental) se confirma sin cambios.

---

## 2. Principios (aplicados, no solo enunciados)

- **Separación de responsabilidades.** Ninguna salida de Stella se auto-persiste al pipeline hoy (verificado: los 4 paneles son de solo lectura o requieren acción explícita del usuario). Esta etapa no cambia eso.
- **Trazabilidad.** Hoy `stella_interactions` registra organización/proyecto/usuario/rol/paso/modelo/tokens/riesgo/fecha, pero **no** versión de prompt, versión de esquema de contexto, ni un manifiesto de qué se consultó. Ésta es la etapa que lo cierra (§5).
- **Minimización de datos.** Ya es fuerte a nivel de *qué campos existen* en `StellaProjectContext` (sin PII, sin rutas, sin valores financieros). Esta etapa la hace **verificable en código** (guardarraíl determinista, §5 A1.5) en lugar de depender solo de la disciplina de quien escribió cada context builder.
- **Datos no confiables.** Existe sanitización básica pero `markAsData` nunca se usa. Esta etapa construye la infraestructura de envoltura de datos no confiables y la deja lista para adopción (§5 A1.5), sin retro-adaptar los cuatro *builders* de mensaje existentes por el motivo documentado en §4.
- **Control determinista.** Nuevo guardarraíl de contexto (§5 A1.5) que falla cerrado sin depender del criterio del modelo.
- **Evaluación antes de activación.** Se construye el arnés (§5 A1.7), apagado por defecto, sin ejecutarlo contra el modelo real en esta sesión.

---

## 3. Etapas A-F

### Etapa A1 — Seguridad técnica (esta sesión implementa esto)
Ver §5 para el detalle exacto. Resultado: RLS probado, prompts y esquema de contexto versionados, manifiesto de contexto auditable (sin payload bruto), guardarraíl determinista de contexto, suite adversarial estructural, arnés de evaluación apagado por defecto, corrección del modelo retirado, correcciones documentales.

### Etapa A2 — Gobernanza de datos (decisiones de producto, no código)
Documentada en `STELLA_DECISION_REGISTER.md`. Bloquea: activar cualquier flag de Stella, Evidence Intelligence (Fase 2), Proxy Intelligence (Fase 3). Cerrada — DR-001 a DR-007 implementados técnicamente (bloqueo PII/menores/salud, consentimiento organizacional, acceso interno, retención/purga, declaraciones de agregación verificadas).

### Secuencia B0-B5 → A3 → lanzamiento (actualizada en Etapa B0, 2026-07-26)

**Decisión del propietario (`A3-DEFERRED-UNTIL-POST-PILOT`, ver `STELLA_DECISION_REGISTER.md`):** la revisión legal y contractual formal (Etapa A3) se difiere hasta después de un piloto controlado con aliados seleccionados — **no se cancela**, se reubica. A3 no bloquea el desarrollo, las evaluaciones internas, la integración con Gemini API pagada, ni el piloto restringido. A3 SÍ es una compuerta obligatoria antes del lanzamiento comercial abierto, del acceso no restringido por organizaciones, y del procesamiento deliberado de datos personales sensibles o identificables.

La antigua "Etapa B" (Stella contextual y gobernada) se descompone en la siguiente secuencia:

1. **`B0` — Modo piloto restringido** (esta sesión implementa esto). Activación técnica controlada: allowlist de organizaciones/usuarios, kill switch, confirmación operativa de piloto (distinta del consentimiento DR-005), configuración explícita de proveedor pagado, solo el rol Advisor habilitado para modelo real. Ver `STELLA_B0_CONTROLLED_PILOT_IMPLEMENTATION_REPORT.md`.
2. **`B1` — Copiloto metodológico contextual por pasos.** Retro-adaptación de `buildAdvisorUserMessage`/`buildValidatorUserMessage`/`buildReviewerUserMessage` (y, en coordinación con quien mantiene sus pruebas, `buildComposerUserMessage`) al envoltorio de datos no confiables de A1.5 (`STL-B-EnvelopeAdoption`). No implementado todavía.
3. **`B2` — Composer funcional y guardas numéricas.** Esquema `ComposerOutputV2` (§7) con bloques narrativos sin cifras y referencias estructuradas validadas contra el proyecto — condición explícita antes de habilitar Composer para modelo real (ver B0 §10). No implementado todavía.
4. **`B3` — Evaluación real con Gemini API pagada.** Ejecución del arnés de evaluación (§5, A1.7) contra el modelo real, presupuesto acotado, por una persona, no automáticamente. No implementado todavía.
5. **`B4` — Piloto interno end-to-end.** Recorrido manual en preview con datos sintéticos, con resultado aprobado del arnés. No implementado todavía.
6. **`B5` — Piloto restringido con aliados.** Extensión del modo piloto de B0 a organizaciones aliadas reales, bajo el aviso y la confirmación operativa ya construidos. No implementado todavía.
7. **`A3` — Revisión legal y contractual del producto ya probado.** DPA con Google, subprocesadores, región de procesamiento, retención del proveedor, DR-008/DR-009. **No se declara completada por ninguna sesión de Claude Code** — no sustituye asesoría jurídica. Registrada en `STELLA_DECISION_REGISTER.md`. Reubicada aquí (antes estaba inmediatamente después de A2) — **no eliminada del roadmap**.
8. **Implementación de las decisiones de A3.**
9. **Lanzamiento comercial abierto.**

### Etapa C — Evidence Intelligence (antes "Fase 2", corregida)
**pgvector/embeddings ya NO se asumen obligatorios.** Empieza por extracción de texto, fragmentos citables, clasificación y **búsqueda textual** (`ILIKE`/`tsvector` de Postgres, ya disponible sin extensiones). La necesidad de recuperación semántica con embeddings queda sujeta a `STELLA_DECISION_REGISTER.md#DR-010` y se decide con datos reales de volumen/patrones de consulta, no por adelantado.

### Etapa D — Proxy Intelligence (antes "Fase 3", corregida)
**Desacoplada de RAG/embeddings del proyecto.** Reutiliza servicios de extracción documental de la Etapa C para verificar citas de fuentes externas, pero su pipeline (definición → búsqueda → recuperación → extracción → verificación → comparabilidad → `suggested` → aprobación → uso) es independiente y no requiere que la Etapa C haya implementado embeddings.

### Etapa E — Review, Calculation y Audit (antes "Fase 4")
Sin cambios de fondo.

### Etapa F — Portfolio Intelligence (antes "Fase 5")
Sin cambios de fondo.

---

## 4. Decisiones reversibles e irreversibles

| Decisión | Tipo | Justificación |
|---|---|---|
| Migraciones de esta etapa son aditivas (columnas nullable, sin `DROP`) | Reversible | Puede revertirse con `DROP COLUMN` sin pérdida de datos de negocio |
| `model_used` pierde su `DEFAULT` (no se reemplaza por otro valor fijo) | Reversible | `ALTER COLUMN ... SET DEFAULT` restaura si se decide lo contrario |
| No se persiste el payload/prompt crudo; se persiste un manifiesto estructural | **Semi-irreversible** | Las interacciones registradas ANTES de esta decisión nunca tendrán el payload crudo si más adelante se decide que sí hace falta (no hay forma de reconstruirlo retroactivamente). Se documenta como decisión consciente en `STELLA_DECISION_REGISTER.md#DR-006`, no como omisión |
| No se retro-adapta `buildXUserMessage` al envoltorio de datos no confiables en A1 | Reversible, diferida | Los tests existentes de `composer-system.test.ts` fijan el formato actual; adoptarlo es trabajo de la Etapa B, coordinado con quien mantiene esas pruebas |
| No se crea la tabla `ai_provenance_links` en esta etapa | Reversible, diferida | Se diseña completamente (§6) pero se implementa cuando exista un escritor real (Etapa B, reformulación/sugerencias) — crear una tabla sin escritor viola "no introduzcas dependencias sin justificar" |
| El arnés de evaluación no se ejecuta contra el modelo real en esta sesión | N/A (no ejecutado) | Requiere `STELLA_EVAL_REAL_MODEL=true` explícito y no se activa aquí |

---

## 5. Etapa A1 — detalle técnico (lo que esta sesión implementa)

| Bloque | Qué construye | Qué NO hace |
|---|---|---|
| A1.1 | Pruebas de integración RLS de `stella_interactions` con clientes autenticados reales (no service-role) | No cambia las políticas RLS existentes |
| A1.2 | Registro central de plantillas de prompt (`lib/stella/prompts/registry.ts`) + columnas `prompt_template_id`/`prompt_version` | No cambia el texto de ningún prompt |
| A1.3 | `context_schema_version` central + columna | No cambia la forma de `StellaProjectContext` |
| A1.4 | Manifiesto de contexto estructural (tipos de entidad, IDs, **nombres** de campo, conteos, hash, flags de sensibilidad) — nunca contenido textual | No persiste el payload/prompt crudo (decisión documentada, no implementación por defecto) |
| A1.5 | Guardarraíl determinista de contexto (`assertContextHasNoForbiddenData`, wired en las 4 acciones) + utilidad de envoltura de datos no confiables (construida y probada, **no** wired aún en los 4 *builders* de mensaje — ver §4) | No retro-adapta los prompts existentes (evidencia: rompería `composer-system.test.ts`, ver corrección en §4) |
| A1.6 | Suite adversarial estructural (10 payloads canónicos) contra sanitización, guardarraíl y envoltorio — sin llamar al modelo | No evalúa si el MODELO resiste la inyección (eso es A1.7/eval) |
| A1.7 | Esqueleto del arnés de evaluación: casos versionados, runner, rúbrica, JSON+Markdown, comparación entre corridas, gate `STELLA_EVAL_REAL_MODEL`, presupuesto máximo — probado con un *mock caller*, nunca ejecutado contra Gemini real en esta sesión | No se ejecuta contra el modelo real |
| A1.8 | Migración aditiva: elimina el `DEFAULT` obsoleto de `model_used` | No cambia el modelo configurado ni fuerza un valor nuevo |
| A1.9 | Corrección documental del mecanismo de inserción/bypass de RLS y del hallazgo del grant contradictorio | No edita documentos históricos fechados |

---

## 6. Procedencia como capacidad de dominio — diseño (no implementado en A1)

### Modelo propuesto

```
ai_provenance_links
├── id                    uuid PK
├── organization_id       uuid FK organizations        -- aislamiento multi-tenant, igual que el resto del esquema
├── project_id            uuid FK projects
├── stella_interaction_id uuid FK stella_interactions  NULL  -- NULL si origin_type no involucra a Stella
├── entity_type           varchar(50)   -- 'outcome' | 'indicator' | 'stakeholder_group' | 'theory_of_change_node' |
                                          -- 'financial_proxy' | 'sroi_report_section' | ... (extensible)
├── entity_id              uuid          -- fila afectada en su tabla real
├── field_name             varchar(100) NULL  -- NULL = procedencia a nivel de fila completa; valor = a nivel de campo
├── origin_type            varchar(30)   -- ver enum abajo
├── proposed_value          text NULL     -- lo que Stella propuso (si origin_type empieza por ai_/document_/externally_)
├── accepted_value          text NULL     -- lo que realmente quedó persistido tras la revisión humana
├── source_reference        text NULL     -- URL/documento/evidence_id si origin_type = document_extracted | externally_retrieved
├── verification_status     varchar(20)   -- 'unverified' | 'human_confirmed' | 'human_edited' | 'rejected'
├── accepted_by             uuid FK users NULL  -- quién aceptó la sugerencia
├── verified_by             uuid FK users NULL  -- quién verificó (puede ser distinto de quien aceptó)
├── created_at              timestamp
└── updated_at              timestamp

CHECK origin_type IN (
  'human_entered', 'ai_suggested', 'ai_reformulated', 'human_edited_ai',
  'document_extracted', 'externally_retrieved', 'system_calculated'
)
```

### Invariantes

1. **Toda fila de dominio tiene como máximo una procedencia activa por (entity_type, entity_id, field_name)** — un `UNIQUE` sobre esas tres columnas (con `field_name` normalizado a `''` cuando es a nivel de fila) evita ambigüedad sobre "cuál es la procedencia vigente". Ediciones posteriores crean una nueva fila y la anterior queda archivada (no se sobre-escribe: preserva historial).
2. **`stella_interaction_id` es obligatorio si y solo si `origin_type` empieza por `ai_`** (`ai_suggested`, `ai_reformulated`) — CHECK constraint. `document_extracted`/`externally_retrieved` no requieren una interacción de Stella (podrían venir de un pipeline de extracción sin llamada al modelo); `human_entered`/`system_calculated` nunca la requieren.
3. **`system_calculated` nunca tiene `accepted_by`** — el motor determinista no requiere aprobación humana por diseño (es cálculo, no propuesta). CHECK.
4. **Ninguna fila con `verification_status = 'unverified'` puede ser citada como evidencia aprobada en un reporte bloqueado** — esta regla vive en la lógica de la compuerta de bloqueo (`lib/pipeline/sroi-results.ts`), no en la base de datos; se documenta aquí como dependencia cruzada.
5. **Es append-only como `audit_logs`**: sin política de UPDATE; una corrección crea una fila nueva y marca la anterior con `updated_at` pero conserva su `origin_type`/`proposed_value` originales — igual patrón que el resto del sistema de auditoría.

### Relación con `stella_interactions`

`stella_interactions` registra **la llamada** (qué se le pidió a Stella y qué respondió). `ai_provenance_links` registra **el efecto** (qué fila/campo del dominio nació o cambió a partir de esa llamada, y qué hizo un humano con la propuesta). Son necesariamente tablas distintas: una interacción de Stella puede generar cero, una o varias propuestas; una propuesta aceptada puede editarse humanamente después sin generar una nueva interacción de Stella.

### ¿Migración ahora o al iniciar sugerencias?

**Decisión: al iniciar la Etapa B (sugerencias/reformulación), no ahora.** Razón: en Etapa A1 no existe ningún escritor de esta tabla — ni reformulación ni sugerencias están implementadas (prohibido explícitamente en esta sesión). Crear la tabla ahora violaría "no introduzcas dependencias sin justificar su necesidad" y dejaría una migración sin ningún código que la use, lo cual es exactamente el patrón de deuda que esta auditoría critica en otras partes del sistema (funciones declaradas pero no operativas). El diseño queda completo y listo para implementarse en el primer sprint de la Etapa B.

---

## 7. Arquitectura objetivo del Composer (diseño, no implementado en A1)

### Problema (confirmado en la auditoría original, GAP-P1-3)

`ComposerOutputSchema.draft_content` es texto libre (`composer-output.ts:15`); el modelo puede escribir una cifra dentro de la prosa que no coincide con el motor de cálculo.

### Esquema propuesto (objetivo, Etapa B)

```ts
interface ComposerBlock {
  kind: 'narrative' | 'value_reference' | 'evidence_citation'
  // narrative: texto libre redactado por Stella (prosa conectora, sin cifras)
  text?: string
  // value_reference: referencia estructurada, NUNCA un número escrito por el modelo
  refKind?: 'sroi_ratio' | 'net_social_value' | 'gross_social_value' | 'total_investment'
    | 'funder_investment' | 'funder_sroi_ratio'
  runId?: string        // ID de la corrida de cálculo citada — validado contra el proyecto
  funderId?: string     // solo para refKind de tipo funder_*
  // evidence_citation: referencia a evidencia real, validada contra el proyecto
  evidenceId?: string
}

interface ComposerOutputV2 {
  section_key: string
  draft_title: string
  blocks: ComposerBlock[]   // reemplaza a draft_content de texto libre
  assumptions: string[]
  limitations: string[]
}
```

### Invariantes

1. **Stella nunca emite un número en un bloque `narrative`** — se valida con una expresión que rechaza dígitos fuera de los bloques `value_reference` (regla determinista, no solo instrucción de prompt).
2. **Todo `runId`/`evidenceId`/`funderId` referenciado se valida contra el proyecto actual antes de renderizar** — si no pertenece al proyecto/organización, el bloque se descarta y se marca como error, nunca se renderiza un valor no verificado.
3. **El servidor renderiza el valor final** leyendo `sroi_calculation_runs`/`sroi_calculation_line_items` en el momento de mostrar el reporte — el número que ve el usuario siempre viene de una consulta a la corrida, nunca de `response_json`.

### Estrategia de migración

1. Añadir `ComposerOutputV2Schema` **junto a** (no en lugar de) el actual, detrás de un flag de esquema.
2. El editor de reporte aprende a renderizar `blocks[]` junto al formato antiguo de `draft_content` (compatibilidad hacia atrás con borradores ya guardados).
3. Una vez verificado en preview, el prompt del Composer se actualiza para emitir el nuevo esquema (Etapa B, coordinado con quien mantiene `composer-system.test.ts`).
4. `draft_content` se conserva como campo derivado (concatenación de los bloques `narrative`, con marcadores de posición legibles donde van las referencias) para no romper consumidores existentes durante la transición.

### Pruebas futuras (Etapa B)

- Un bloque `narrative` con un dígito se rechaza en validación.
- Un `runId` que no pertenece al proyecto se descarta sin renderizar.
- El valor mostrado en el reporte coincide exactamente con `sroi_calculation_runs` para el `runId` citado, en cada regeneración.

---

## 8. Gates de salida

| Gate | Etapa que cierra | Criterio |
|---|---|---|
| G1 | A1 | Ver `STELLA_STAGE_A_VALIDATION.json` — checklist exacto en la respuesta final de esta sesión |
| G2 | A2 | Todas las decisiones de `STELLA_DECISION_REGISTER.md` categoría "Gobernanza" resueltas por el propietario del producto |
| G3 | A3 | DPA firmado/verificado; política de privacidad revisada por asesoría legal externa |
| G4 | B | Suite de evaluación con ≥10 casos por rol, corrida real, con resultado aprobado documentado |
| G5 | C/D | Decisión `DR-010` (necesidad real de embeddings) tomada con datos de volumen reales |

---

## 9. Qué NO se implementa todavía (recordatorio explícito)

Activación de Stella en cualquier entorno · Evidence Intelligence · Grounding/búsqueda de proxies · Embeddings/RAG/pgvector · Portfolio Intelligence · Audit Room · Reformulación o sugerencias del pipeline · Nuevo esquema del Composer (solo diseñado) · Tabla `ai_provenance_links` (solo diseñada) · Retro-adaptación del envoltorio de datos no confiables en los 4 *builders* de mensaje existentes · Ejecución real del arnés de evaluación.

---

## 10. Estrategia de activación progresiva (actualizada en Etapa B0 — reemplaza la versión anterior de esta sección)

1. **B0 (esta sesión):** A1 + A2 cerradas; A3 diferida por decisión del propietario (`A3-DEFERRED-UNTIL-POST-PILOT`). Modo piloto restringido activado técnicamente: allowlist de organizaciones/usuarios (vacía por defecto = ningún acceso), kill switch, confirmación operativa de piloto, Gemini API pagada exclusivamente, solo el rol Advisor apto para modelo real (Composer/Validator/Reviewer permanecen con proveedor simulado).
2. **B1:** retro-adaptación del envoltorio de datos no confiables en los 4 *builders* de mensaje.
3. **B2:** esquema `ComposerOutputV2` con guardas numéricas — condición explícita antes de habilitar Composer para modelo real.
4. **B3:** ejecutar el arnés de evaluación contra el modelo real, en un entorno controlado, con presupuesto acotado, **por una persona**, no automáticamente.
5. **B4:** recorrido manual en preview con datos sintéticos, con resultado aprobado del arnés.
6. **B5:** piloto restringido con aliados reales, extendiendo la allowlist de B0 más allá de organizaciones sintéticas, bajo el aviso y la confirmación operativa ya construidos.
7. **A3:** revisión legal y contractual del producto ya probado en el piloto — compuerta obligatoria antes de continuar.
8. Implementación de las decisiones de A3.
9. Lanzamiento comercial abierto — go/no-go humano explícito, por organización (nunca todas a la vez).

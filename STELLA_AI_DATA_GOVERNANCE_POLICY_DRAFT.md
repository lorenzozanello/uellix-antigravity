# Política de gobernanza de datos e IA de Uellix (Stella)

**Estado: BORRADOR — NO APROBADO**

Este documento es un borrador de trabajo, no una política vigente. Ninguna de sus disposiciones tiene efecto hasta que el propietario de Uellix las apruebe explícitamente (ver `STELLA_A2_OWNER_DECISION_FORM.md`) y, para los asuntos marcados como pendientes de revisión legal, hasta que Etapa A3 concluya. No sustituye asesoría jurídica.

---

## 1. Propósito

Establecer qué datos puede procesar Stella (el conjunto de capacidades de IA de Uellix), bajo qué condiciones, con qué límites de retención y acceso, y qué responsabilidades existen si algo sale mal — de forma consistente con cómo Stella está construida hoy y con las decisiones que el propietario tome en `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md`.

## 2. Alcance

Aplica a las 6 capacidades de Stella (`advisor`, `validator`, `composer`, `proxy_reviewer`, `evidence_reviewer`, `audit_assistant`), a la tabla `stella_interactions`, y a cualquier dato que el producto envíe a un proveedor de IA externo en su nombre. No aplica a otras funciones de Uellix que no involucren IA.

## 3. Principios

- **Minimización:** Stella recibe solo los metadatos estrictamente necesarios para la tarea de cada rol — nunca archivos completos, nunca valores financieros de proxy, nunca hashes completos de evidencia.
- **Separación de responsabilidades:** Stella propone y analiza; el motor determinista de Uellix calcula; los humanos deciden y aprueban. Ninguna salida de Stella se persiste automáticamente al pipeline.
- **Trazabilidad:** toda interacción registra organización, proyecto, usuario, rol, versión de prompt, versión de esquema de contexto, y un manifiesto estructural de qué se consultó — sin guardar el contenido textual bruto enviado.
- **Control determinista:** las restricciones críticas (qué se envía, qué nunca se envía) se verifican en código, no dependen únicamente de instrucciones al modelo.
- **Evaluación antes de activación:** ningún flag de Stella se activa sin evidencia medible de que sus salidas cumplen una rúbrica de seguridad frente al modelo real.

## 4. Categorías de datos

| Categoría | Ejemplos en el contexto de Stella |
|---|---|
| Identidad de proyecto | ID de proyecto, ID de organización (nunca nombres de personas) |
| Narrativa | Texto libre escrito por un usuario describiendo el proyecto |
| Teoría de cambio | Nombres/descripciones de outcomes, nombres/unidades de indicadores |
| Evidencia | Título, tipo, estado, hash truncado a 8 caracteres (nunca el archivo ni el hash completo) |
| Proxies financieros | Nombre, fuente (nunca el valor monetario ni la moneda) |
| Cálculo | Totales agregados (nunca la fórmula completa ni el detalle línea por línea) |
| Respuesta generada | Prosa producida por el modelo — puede parafrasear cualquiera de las categorías anteriores |

## 5. Datos permitidos

Los campos listados en la sección 4 tal como los construyen los *context builders* actuales (`lib/stella/context/build-*-context.ts`), sujetos a la política de PII/menores/salud que resulte de `DR-001`/`DR-002`/`DR-003` una vez decididas.

## 6. Datos restringidos

- Valores financieros de proxy (nombre y fuente sí; valor y moneda, no — ya excluidos por diseño).
- Contenido completo de archivos de evidencia (ya excluido por diseño; relevante cuando exista Evidence Intelligence, Etapa C).
- Hash completo de evidencia (solo 8 caracteres truncados; ya excluido por diseño).

## 7. Datos prohibidos

- Secretos y credenciales (`GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, y patrones equivalentes) — bloqueados en código por `sanitize.ts` y por el guardarraíl determinista de contexto.
- El prompt/contexto crudo como columna persistida por defecto — decisión ya tomada (`DR-006`, ver STELLA_DECISION_REGISTER.md); solo se persiste un manifiesto estructural.
- **Pendiente de definición formal (DR-001/002/003):** PII de alto riesgo, datos identificables de menores, datos de salud individualizados.

## 8. Menores de edad

**Implementado técnicamente, con reservas (Etapa A2.3.1, 2026-07-26) — ver DR-002.** Cualquier señal individual identificable de un menor (edad + contexto de menor, reutilizando la detección de DR-001) se bloquea sin excepción antes de llegar al modelo, sin consultar ninguna declaración. Una mención agregada específica ("50 niños") se permite únicamente cuando existe una declaración verificada en `stella_sensitive_aggregation_declarations` (`lib/stella/aggregation/`) para la ENTIDAD exacta que contiene el texto, con `groupSize >= 10`, dimensiones estructurales dentro de la allowlist, y bajo la política vigente. Ver `lib/stella/context/sensitive-population.ts`, `lib/stella/aggregation/` y `STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md`. **Reserva:** no existe todavía una UI para crear/verificar declaraciones — el flujo solo es operable desde código. Esto NO es una revisión legal concluida.

**Actualización (Etapa A2.3.2, 2026-07-26):** la reserva de UI queda cerrada — `components/aggregation/OutcomeSensitiveAggregationPanel.tsx` permite crear/verificar/revocar/sustituir declaraciones desde el producto (montado por-outcome). El mecanismo de agregación ahora también es transaccional (sustitución atómica con rollback probado), concurrente-seguro (probado contra Postgres local), y resiste un cambio real de política de umbral sin invalidar silenciosamente declaraciones antiguas. Ver `STELLA_A2_AGGREGATION_OPERATIONS_REPORT.md`. **Esto sigue sin ser una revisión legal concluida** ni una garantía matemática de anonimización — ambas afirmaciones permanecen expresamente fuera de alcance.

## 9. Datos de salud

**Implementado técnicamente, con reservas (Etapa A2.3.1, 2026-07-26) — ver DR-003.** Mismo mecanismo y módulo que la sección 8: umbral mínimo de agregación confirmado en 10 (`MINIMUM_SENSITIVE_GROUP_SIZE`, única fuente de verdad en `lib/stella/aggregation/policy.ts`). Ver `STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md`. Misma reserva que la sección 8 (sin UI). Esto NO es una revisión legal concluida.

**Actualización (Etapa A2.3.2, 2026-07-26):** mismo cierre que la sección 8 (mecanismo compartido). Ver `STELLA_A2_AGGREGATION_OPERATIONS_REPORT.md`.

## 10. PII

**Pendiente — ver DR-001.** Postura por defecto mientras no exista una decisión aprobada: no existe detección de PII común más allá del bloqueo de patrones tipo secreto ya implementado.

## 11. Consentimiento

**Implementado técnicamente (Etapa A2.1, 2026-07-25) — ver DR-005.** Stella solo puede usarse cuando un `organization_admin` de la organización aceptó explícitamente la versión vigente de los términos de IA y de la política de datos (`stella_ai_consent_events`, evento `accepted` con `ai_terms_version`/`data_policy_version` resueltas en servidor). La cuota, el plan, los feature flags y la configuración de un `super_admin` global NO constituyen consentimiento — un `super_admin` sin membresía `organization_admin` explícita en la organización no puede aceptar ni revocar en su nombre. La compuerta corre antes de consumir cuota, antes del rate limit y antes de construir cualquier prompt; se verifica en las 4 acciones de Stella (`getStellaConsentStatus`). La revocación bloquea llamadas nuevas de inmediato y queda auditada; ninguna fila histórica se modifica o elimina. Esto es una implementación técnica, no una revisión legal de los términos en sí — ver Etapa A3.

## 12. Retención

**Implementado técnicamente, con reservas (Etapa A2.4, 2026-07-26) — ver DR-004.** Política diferenciada por categoría, aprobada por el propietario: `response_json` (la respuesta narrativa generada por Stella) retiene 24 meses por defecto desde su creación, configurable por organización entre 1 y 60 meses; al vencer, se redacta (`response_json = NULL`) preservando la fila completa (metadatos, `context_manifest`, hashes) — nunca se elimina una interacción. Metadatos de auditoría, `context_manifest`, eventos de consentimiento (DR-005) y declaraciones de agregación (DR-002/DR-003) se conservan mientras la organización exista, sin purga ejecutable en esta etapa (ningún evento de cierre contractual confiable existe todavía en el esquema — documentado como brecha, no inventado). Preservaciones (`holds`) a nivel organización/proyecto/interacción bloquean la purga cuando aplica una obligación legal, de auditoría o contractual. Ver `lib/stella/retention/policy.ts` y `STELLA_A2_DR004_RETENTION_IMPLEMENTATION_REPORT.md`. **Reserva:** estos períodos son política técnica inicial, no una garantía jurídica — pendientes de validación contractual y legal en Etapa A3.

## 13. Acceso interno

**Implementado técnicamente (Etapa A2.2, 2026-07-26) — ver DR-007.** El creador de una interacción la conserva mientras tenga membresía activa en la organización. `organization_admin`, `impact_manager` y `analyst` leen todas las interacciones de su organización — no porque exista una lista de control de acceso por proyecto (Uellix no tiene una hoy), sino porque "acceso al proyecto" y "acceso a la organización" son el mismo conjunto para esos roles en el modelo actual. `viewer` y `reviewer` NO tienen acceso general al historial (solo a su propia interacción como creador). Un `super_admin` global SIN una membresía explícita en la organización YA NO ve todas las organizaciones — ese bypass general se eliminó; no existe todavía un mecanismo de acceso excepcional auditado para soporte/incidentes (documentado como tarea futura, no implementado en este bloque). Esto es una implementación técnica, no una revisión legal — ver Etapa A3.

## 14. Auditoría

Cada interacción con Stella queda registrada en `stella_interactions` con: organización, proyecto, usuario, rol, paso del pipeline, modelo usado, tokens, nivel de riesgo, versión de prompt, versión de esquema de contexto, manifiesto de contexto, y hash del contrato de prompt — pero nunca el texto crudo enviado al modelo. El registro es append-only: ni la aplicación ni un usuario autenticado pueden modificarlo o borrarlo (verificado técnicamente en Etapa A1.5, migración `0043`).

## 15. Responsabilidades

- **Producto (Uellix):** define qué categorías de datos se envían a Stella, aprueba activaciones de flag, define la cuota por organización.
- **Ingeniería:** implementa los controles deterministas que esta política exija, mantiene las pruebas de integridad (versionado de prompts/esquema), no activa flags sin evaluación aprobada.
- **Organización cliente:** decide qué escribe en la narrativa/evidencia de su proyecto; acepta (cuando exista DR-005) el uso de IA sobre los datos de su proyecto.

## 16. Respuesta ante incidentes

**No definida formalmente en este borrador.** Si se detecta que datos prohibidos (sección 7) llegaron a enviarse a un proveedor externo, el incidente debería documentarse, la causa raíz corregirse en código (guardarraíl determinista, no solo instrucción de prompt), y notificarse según corresponda una vez que Etapa A3 defina las obligaciones contractuales/regulatorias aplicables.

## 17. Revisión periódica

Este borrador debería revisarse cada vez que: se agregue un campo nuevo a `StellaProjectContext`, se active un flag de Stella por primera vez para clientes reales, o cambien las decisiones `DR-001` a `DR-011`.

## 18. Relación con proveedores

Stella usa la API de Gemini (Google) como único proveedor de modelo hoy. Las condiciones contractuales del proveedor (DPA, uso de datos para reentrenamiento, región de procesamiento, subprocesadores) son objeto de `DR-008`/`DR-009` (Etapa A3, revisión legal) — **no se emite ninguna conclusión sobre esas condiciones en este documento.**

## 19. Decisiones todavía pendientes

`DR-001` (PII), `DR-002` (menores), `DR-003` (salud), `DR-004` (retención), `DR-005` (consentimiento), `DR-007` (acceso interno) — ver `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md`. `DR-008`/`DR-009` (legal, Etapa A3) — sin resolver, requieren asesoría jurídica externa. `DR-010` (necesidad de embeddings) — diferida intencionalmente hasta contar con datos reales de volumen. `DR-011` (fuentes permitidas para proxies) — bloquea el inicio de Etapa D.

## 20. Coherencia con el estado técnico actual

Al momento de este borrador (actualizado 2026-07-26, Etapa B0), verificado contra el código: Stella sigue apagada por defecto (`STELLA_ENABLED=false` en ausencia de configuración explícita, los 6 flags por rol en `false`, y el nuevo modo piloto también apagado por defecto — `STELLA_PILOT_MODE` ausente); no procesa contenido de documentos (no existe Evidence Intelligence); no realiza *grounding* ni búsqueda de proxies (no existe Proxy Intelligence); el manifiesto de contexto no guarda payload crudo (decisión `DR-006`, ya implementada); `response_json` sí puede contener prosa generada por el modelo; las decisiones de Etapa A3 (legal) siguen pendientes en su totalidad, ahora explícitamente diferidas (no canceladas) hasta después del piloto — ver `STELLA_DECISION_REGISTER.md#A3-DEFERRED-UNTIL-POST-PILOT`.

## 21. Etapa B0 — Piloto restringido (categoría de dato nueva y controles adicionales)

Se agrega una séptima categoría de dato a la lista de §4: **confirmación operativa del piloto** (`stella_pilot_confirmations`). Es un registro append-only, por usuario y por organización, de la aceptación (o revocación) de las reglas propias del piloto — "no voy a cargar datos prohibidos, voy a revisar cada respuesta antes de usarla". Es **distinta** del consentimiento organizacional de `DR-005` (`stella_ai_consent_events`, decisión exclusiva de `organization_admin`): la confirmación del piloto es una atestación personal que cualquier miembro activo acepta para sí mismo, y las dos nunca se fusionan en la misma tabla ni en el mismo checkbox.

Controles adicionales, activos solo mientras el piloto está habilitado (`STELLA_PILOT_MODE=true`, apagado por defecto):

- **Interruptor de emergencia** (`STELLA_PILOT_KILL_SWITCH`) con prioridad absoluta sobre cualquier otro flag o allowlist.
- **Listas de permitidos** de organización y de usuario — vacías por defecto, lo que significa **ningún acceso**, nunca "sin restricción".
- **`super_admin` no tiene bypass** en ningún control del piloto: ni en la función central de decisión (`getStellaPilotAccess()`), ni en la política RLS de `stella_pilot_confirmations` (que deliberadamente NO incluye la cláusula `OR current_user_is_super_admin()` presente en la política de `DR-005` — ver `db/policies/013_stella_pilot_confirmations_rls.sql`).
- **Ningún rol de Stella queda habilitado en el piloto salvo Advisor** (`DEFAULT_PILOT_ENABLED_ROLES = ['advisor']`) — Composer permanece excluido hasta que sus guardas numéricas (Etapa B2) estén verificadas; Validator/Reviewer permanecen excluidos mientras sus prompts sigan siendo genéricos.
- **La confirmación del piloto nunca sustituye ni relaja** ninguno de los controles ya vigentes: `DR-001` (PII), `DR-002`/`DR-003` (menores, salud), `DR-004` (retención), `DR-005` (consentimiento organizacional), `DR-007` (acceso de lectura) siguen aplicando sin excepción — verificado con una prueba dedicada que confirma que una confirmación de piloto válida no evita el bloqueo de datos sensibles.
- **Un API key nunca es prueba de nivel pagado.** El uso del proveedor real (`paid_gemini`) exige además `STELLA_PILOT_PAID_GEMINI_CONFIRMED=true`, una confirmación explícita y separada que solo el propietario de la organización puede establecer, tras verificar fuera de este código que existe facturación activa real.

Detalle completo en `STELLA_CONTROLLED_PILOT_POLICY.md` y `STELLA_B0_CONTROLLED_PILOT_IMPLEMENTATION_REPORT.md`.

---

**Estado: BORRADOR — NO APROBADO.**

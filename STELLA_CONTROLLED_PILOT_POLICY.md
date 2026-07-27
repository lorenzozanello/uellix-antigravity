# Política del piloto controlado de Stella (Etapa B0)

**Estado: BORRADOR OPERATIVO — vigente mientras el piloto está activo. No es una declaración de cumplimiento legal.**
**Fecha:** 2026-07-26. **Decisión del propietario que la origina:** ver `STELLA_DECISION_REGISTER.md#A3-DEFERRED-UNTIL-POST-PILOT`.

## 1. Propósito

Este documento define las reglas operativas bajo las cuales Stella puede usarse en un **piloto restringido**, con un número acotado de organizaciones y personas, ANTES de que la revisión legal y contractual formal del producto (Etapa A3) se realice. No sustituye esa revisión, no la anticipa y no constituye ninguna forma de aprobación legal.

## 2. Relación con Etapa A3 (revisión legal y contractual)

La Etapa A3 **se difiere, no se cancela**. El piloto existe precisamente para producir evidencia real de uso — con qué tipo de datos, con qué frecuencia, con qué resultados — que la revisión legal podrá usar como insumo. Mientras A3 esté pendiente:

- **Bloqueado:** lanzamiento comercial abierto; acceso sin restricción entre organizaciones; procesamiento deliberado de datos personales sensibles o identificables.
- **No bloqueado:** desarrollo continuo, evaluaciones internas, integración con la API paga de Gemini, y el piloto restringido descrito en este documento.

## 3. Alcance del piloto

- Solo el rol **Advisor** de Stella está habilitado por defecto (`DEFAULT_PILOT_ENABLED_ROLES = ['advisor']` en `lib/stella/pilot/config.ts`). Composer, Validator y los tres roles de Reviewer permanecen fuera del piloto hasta etapas posteriores (B2 para Composer; los demás mientras sus prompts sigan siendo genéricos).
- Solo organizaciones y usuarios explícitamente incluidos en las listas de permitidos (`STELLA_PILOT_ORGANIZATION_IDS`, `STELLA_PILOT_USER_IDS` o `STELLA_PILOT_ALLOW_ALL_ORG_USERS`) pueden usar Stella durante el piloto — una lista vacía significa **ningún acceso**, nunca "sin restricción".
- El piloto está **apagado por defecto**: sin configuración explícita de `STELLA_PILOT_MODE=true`, ninguna organización tiene acceso, sin importar cualquier otro flag preexistente de Stella.

## 4. Elegibilidad de participantes

- Rol de membresía: `organization_admin`, `impact_manager` o `analyst` (`PILOT_MEMBERSHIP_ROLE_ALLOWLIST`, comparación literal, sin jerarquía).
- `super_admin` **no tiene bypass** de ningún control del piloto — ni en la función de decisión (`getStellaPilotAccess()`), ni en la política RLS de `stella_pilot_confirmations`. Ver `STELLA_THREAT_MODEL.md#E4`.
- Membresía activa (`status = 'active'`) revalidada en cada solicitud, no solo al inicio del piloto.

## 5. Confirmación operativa personal (distinta del consentimiento organizacional)

Antes de usar Stella durante el piloto, cada persona debe aceptar personalmente — para sí misma, no en nombre de su organización — una atestación que declara: (a) que entiende que Stella está en fase piloto, (b) que la revisión legal definitiva está pendiente, (c) que no cargará datos personales sensibles o identificables, y (d) que revisará críticamente cada respuesta antes de usarla. Esta confirmación:

- Se registra en `stella_pilot_confirmations` (migración `0048_stella_pilot_confirmations.sql`), un registro append-only por usuario y organización.
- **No requiere** el rol `organization_admin` — cualquier miembro elegible la acepta para sí mismo, a diferencia del consentimiento de IA de DR-005 (`stella_ai_consent_events`), que solo un `organization_admin` puede otorgar en nombre de la organización.
- Queda "desactualizada" automáticamente si `STELLA_PILOT_NOTICE_VERSION` se incrementa, obligando a una nueva aceptación.
- Puede revocarse en cualquier momento (`revokeStellaPilotConfirmation()`), bloqueando inmediatamente el acceso de esa persona hasta que vuelva a confirmar.
- **Nunca** sustituye ni relaja el consentimiento organizacional de DR-005, que sigue siendo obligatorio de forma independiente.

## 6. Restricciones de datos (absolutas, sin excepción durante el piloto)

Ninguna confirmación del piloto habilita cargar:

- Datos personales identificables de individuos (nombres, contactos, identificadores gubernamentales).
- Datos de menores de edad identificables.
- Datos de salud individual.
- Documentos reales de proyectos reales con información sensible — solo datos sintéticos o ya-anonimizados según las reglas de DR-001/DR-002/DR-003.

Estos controles se aplican en `assertContextHasNoForbiddenData()` (`lib/stella/context/context-guardrails.ts`), que se ejecuta **independientemente** del resultado del gate del piloto — una confirmación de piloto válida y un `PILOT_ALLOWED` no evitan este guardarraíl. Ver la prueba dedicada en `app/actions/stella/__tests__/advisor.test.ts` ("a valid pilot confirmation NEVER bypasses the sensitive-data guardrail").

## 7. Proveedor de modelo: exclusivamente la modalidad paga de Gemini (o un simulador)

- `STELLA_PILOT_PROVIDER_MODE` solo acepta `'disabled'` (por defecto), `'mock'` o `'paid_gemini'`. Cualquier otro valor falla cerrado a `'disabled'`.
- **`'mock'`** usa `StellaPilotMockProvider` (`lib/stella/pilot/mock-provider.ts`): respuestas sintéticas fijas, claramente etiquetadas, sin ninguna llamada de red — permite ejercitar el pipeline completo (acceso → consentimiento → cuota → guardarraíles → límite de tasa → "proveedor" → parseo → auditoría) sin gastar presupuesto ni tocar Gemini real.
- **`'paid_gemini'`** requiere ADEMÁS `STELLA_PILOT_PAID_GEMINI_CONFIRMED=true` — una confirmación separada y explícita. Un `GEMINI_API_KEY` presente **nunca** es prueba de que existe facturación paga activa; esa distinción se mantiene deliberadamente en el código (`lib/stella/pilot/access.ts`, paso 12) y en el script de verificación previa (`scripts/stella-pilot-preflight.ts`).
- **Hallazgo del smoke test de cierre (2026-07-26):** aunque el gate del piloto solo permite a Advisor alcanzar el proveedor real, se descubrió que `STELLA_VALIDATOR_ENABLED`/`STELLA_COMPOSER_ENABLED` (flags heredados, no relacionados con B0) pueden dejar a Validator/Composer con acceso directo a Gemini real, sin pasar por NINGUNA allowlist del piloto, ya que esos roles no tienen el gate integrado. **Mientras el piloto esté activo, ambos deben permanecer en `false`** — ver `STELLA_B0_CONTROLLED_PILOT_IMPLEMENTATION_REPORT.md#12.1`.
- La modalidad gratuita de Gemini, Google AI Studio como entorno operativo, *Grounding*, Google Search, Google Maps, la File API y el *caching* explícito de contexto están **fuera de alcance** para el piloto — ninguno de estos componentes está integrado ni configurado en este código.

## 8. Interruptor de emergencia (kill switch)

`STELLA_PILOT_KILL_SWITCH=true` bloquea el piloto para **todas** las organizaciones y usuarios de inmediato, con prioridad sobre cualquier otro flag, allowlist o confirmación — es el primer paso evaluado en `getStellaPilotAccess()`. Se documenta como el mecanismo de contención inmediata en caso de un incidente durante el piloto.

## 9. Retención y auditoría (sin excepción para datos del piloto)

- La política de retención de DR-004 (`lib/stella/retention/`) aplica sin cambios: `response_json` se purga según la ventana configurada por organización (24 meses por defecto); metadatos, manifiesto de contexto, eventos de consentimiento/confirmación y `audit_logs` se conservan indefinidamente por ausencia de un evento de cierre contractual en el esquema (brecha documentada, no un descuido).
- El acceso de lectura a interacciones pasadas sigue gobernado por DR-007 (`lib/stella/access/stella-interaction-access.ts`) — no se introduce ninguna ruta de lectura nueva para datos del piloto.
- Las métricas del piloto se derivan de `stella_interactions` y `audit_logs` ya existentes — no se crea ninguna tabla nueva de métricas con contenido duplicado.

## 10. Incidentes durante el piloto

Ante sospecha de una carga indebida de datos sensibles, una fuga cross-organización, o cualquier comportamiento inesperado del modelo: (1) activar `STELLA_PILOT_KILL_SWITCH=true` de inmediato, (2) revisar `audit_logs` filtrado por `organization_id` y por las acciones `stella_pilot_confirmation.*`/`stella_sensitive_data.blocked`, (3) notificar a los participantes afectados, (4) documentar el incidente antes de reactivar el piloto.

## 11. Verificación previa antes de cualquier llamada real

`pnpm stella:pilot:preflight` (`scripts/stella-pilot-preflight.ts`) reporta PASS/FAIL/NOT VERIFIED por cada control verificable desde código, sin imprimir secretos, IDs de allowlist ni prompts, y señala explícitamente qué controles **no puede** verificar (facturación activa real, cuenta de facturación, términos contractuales) porque dependen de una confirmación externa del propietario.

## 12. Condiciones de salida del piloto (hacia B1 en adelante)

El piloto se considera listo para avanzar a Etapa B1 (copiloto metodológico por pasos) cuando: se ejecutó al menos una llamada real limitada y exitosa contra Gemini pagado con datos sintéticos (ver `STELLA_B0_CONTROLLED_PILOT_IMPLEMENTATION_REPORT.md`), no se registraron incidentes de fuga de datos, y el propietario decide explícitamente ampliar el alcance.

## 13. Lo que este documento NO afirma

No afirma que Stella cumple con ninguna regulación de protección de datos específica, no constituye asesoría legal, y no reemplaza la revisión formal de Etapa A3. Cualquier lectura de este documento como una declaración de cumplimiento es incorrecta.

---

**Referencias:** `STELLA_DECISION_REGISTER.md#A3-DEFERRED-UNTIL-POST-PILOT`, `STELLA_AI_DATA_GOVERNANCE_POLICY_DRAFT.md#21`, `STELLA_THREAT_MODEL.md#E4-E5`, `STELLA_PILOT_PARTICIPANT_NOTICE_DRAFT.md`, `STELLA_B0_CONTROLLED_PILOT_IMPLEMENTATION_REPORT.md`.

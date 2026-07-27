# Matriz de implementación derivada — Etapa A2

**Estado:** documento de preparación. Ninguna de las opciones descritas aquí ha sido implementada. Sirve para construir el backlog de Etapa A2 una vez que el propietario responda `STELLA_A2_OWNER_DECISION_FORM.md`.

Convención: por cada decisión, se listan las opciones evaluadas en `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md` y, para cada una, los cambios técnicos concretos que requeriría, sus riesgos de implementación, y qué pruebas harían falta.

---

## DR-001 — PII

### Opción A: bloquear PII de alto riesgo
**Cambios técnicos:**
- Nuevo módulo de detección de patrones de PII de alto riesgo (regex por categoría: documento de identidad, tarjeta de pago, etc.), análogo a `hasForbiddenPattern` en `lib/stella/context/sanitize.ts`.
- Extensión de `assertContextHasNoForbiddenData` (`lib/stella/context/context-guardrails.ts`) para invocar la nueva detección y lanzar `StellaContextGuardrailError` si hay coincidencia.
- Nuevo código de error/mensaje en las 4 acciones de servidor (ya existe el patrón `CONTEXT_GUARDRAIL_FAILED`; podría reutilizarse o especializarse).
- UI: mensaje explicando qué se bloqueó (sin revelar el patrón exacto detectado, para no filtrar el propio dato sensible en el mensaje de error) y cómo editar la narrativa/campo afectado.

**Riesgos:**
- Falsos positivos (un número de referencia interno coincide con un patrón de documento de identidad) — requiere calibración con datos reales antes de generalizar.
- Bloqueo intempestivo puede frustrar al usuario si no hay una ruta clara de corrección.

**Pruebas:**
- Casos positivos por categoría de PII de alto riesgo (deben bloquear).
- Casos con datos que PARECEN PII pero no lo son (deben pasar) — para medir falsos positivos.

### Opción B: detectar y advertir
**Cambios técnicos:**
- Mismo módulo de detección que la Opción A, pero en vez de lanzar, añade una entrada a `sensitivityFlags` en `buildContextManifest` (`lib/stella/context/build-context-manifest.ts` — el campo ya existe desde Etapa A1.4).
- Sin cambios en las 4 acciones de servidor más allá de que el manifiesto ya se persiste tal cual.

**Riesgos:**
- No previene el envío — solo lo audita después del hecho.

**Pruebas:**
- Un contexto con un patrón de PII común activa el flag correspondiente en el manifiesto; un contexto sin PII no lo activa.

### Opción C: statu quo
**Cambios técnicos:** ninguno.
**Riesgos:** el riesgo actual permanece sin cambio ni visibilidad.
**Pruebas:** ninguna nueva.

---

## DR-002 — Datos de menores

### Opción A: prohibir datos identificables
**Cambios técnicos:**
- Requiere PRIMERO una definición de producto de qué combinaciones de campos son "identificables" (no es una decisión técnica).
- Una vez definida: nuevo patrón de detección + extensión del guardarraíl de contexto, mismo mecanismo que DR-001 Opción A.

**Riesgos:** sin la definición previa, cualquier regla de código sería arbitraria; requiere iteración con casos reales del dominio de Uellix.

**Pruebas:** casos de prueba que representen exactamente las combinaciones acordadas como identificables (deben bloquear) y agregados/anonimizados (deben pasar).

### Opción B: permitir solo agregados
**Cambios técnicos:** análogo a la Opción A pero sin bloqueo — se documentaría como guía de uso, no como control de código, salvo que se decida reforzarlo con detección (converge con DR-001 Opción B).
**Riesgos:** depende de que los usuarios sigan la guía; sin control de código, no es verificable.
**Pruebas:** ninguna automatizable sin un mecanismo de detección.

### Opción C: sin restricción especial
**Cambios técnicos:** ninguno más allá de la política general de PII (DR-001).
**Riesgos:** el caso de mayor sensibilidad del catálogo queda sin barrera dedicada.
**Pruebas:** ninguna nueva.

---

## DR-003 — Datos de salud

Estructura idéntica a DR-002 (mismo mecanismo técnico subyacente — extensión del guardarraíl de contexto), sustituyendo "menores" por "salud" y con la definición previa necesaria siendo el umbral mínimo de agregación, no una lista de combinaciones identificables.

---

## DR-004 — Retención

### Opción A: retención indefinida (statu quo)
**Cambios técnicos:** ninguno.
**Riesgos:** el activo más sensible (`response_json`) crece sin límite.
**Pruebas:** ninguna nueva.

### Opción B: retención configurable por organización
**Cambios técnicos:**
- Migración aditiva: columna de configuración de retención por organización (p. ej. en `organizations` o una tabla de configuración dedicada).
- Job programado (cron/worker) que identifica filas de `stella_interactions` fuera de la ventana de retención de su organización.
- El job NO debe hacer `DELETE` de la fila completa (rompería la garantía append-only y el valor de auditoría) — debe anular selectivamente el campo `response_json` (p. ej. a `NULL` o a un marcador `'[purged]'`), preservando organización/proyecto/rol/fecha/versión.
- Esto requiere que el job corra con un rol que SÍ tenga privilegio de `UPDATE` sobre esa columna específica — hoy `authenticated` no lo tiene (Etapa A1.5, migración `0043`) y el job debería correr como un proceso de servidor equivalente a `postgres`/`service_role`, nunca como un endpoint invocable por un usuario.

**Riesgos:**
- Si el job se implementa mal, podría violar la garantía append-only que Etapa A1.5 acaba de cerrar — requiere revisión de seguridad específica antes de aprobarse.
- Requiere monitoreo (alertas si el job falla silenciosamente).

**Pruebas:**
- Una fila fuera de la ventana de retención pierde su `response_json` pero conserva el resto de columnas.
- El job no puede ejecutarse como `authenticated`; solo como el proceso de servidor autorizado.
- Una fila dentro de la ventana no se modifica.

### Opción C: retención diferenciada por categoría (recomendada)
**Cambios técnicos:** igual que la Opción B, pero con ventanas distintas para `response_json` (corta) vs. metadatos/manifiesto (indefinida, sin job de purga para esas columnas).
**Riesgos:** los mismos que B, acotados a una sola columna.
**Pruebas:** las mismas que B.

---

## DR-005 — Consentimiento

### Opción A: cuota como consentimiento (statu quo)
**Cambios técnicos:** ninguno.
**Riesgos:** confunde un control operativo con un consentimiento informado; no es defendible como evidencia de consentimiento ante una auditoría o disputa.
**Pruebas:** ninguna nueva.

### Opción B: consentimiento explícito (recomendada)
**Cambios técnicos:**
- Tabla nueva, p. ej. `organization_ai_consent`: `organization_id` (FK), `terms_version` (varchar), `accepted_at` (timestamp), `accepted_by` (FK users), `status` (`active`/`revoked`), `revoked_at`/`revoked_by` (nullable).
- Migración aditiva + política RLS análoga a las tablas existentes (lectura para miembros de la organización, escritura restringida a `organization_admin`).
- *Server action* de aceptación (`acceptAiConsent`) y de revocación (`revokeAiConsent`), ambas auditadas (posible fila en `audit_logs`, ya existente).
- Nuevo gate en las 4 acciones de Stella: además de `stellaConfig.isEnabled` y la cuota, verificar consentimiento vigente antes de proceder — fail-closed si no existe.
- UI: pantalla de aceptación de términos (con versión mostrada), indicador de estado de consentimiento, botón de revocación visible solo para `organization_admin`.

**Riesgos:**
- Introduce un nuevo punto de fallo/gate en las 4 acciones — debe probarse exhaustivamente para no romper el flujo cuando el consentimiento SÍ existe.
- Requiere UX cuidadosa para no confundir "cuota asignada" con "consentimiento aceptado" — son conceptos distintos que un usuario podría esperar que sean lo mismo.

**Pruebas:**
- Sin consentimiento vigente, las 4 acciones devuelven un error específico (no genérico) sin exponer nada del contexto.
- Con consentimiento activo, el flujo procede sin cambios respecto al comportamiento actual (una vez que cuota/flags también lo permitan).
- Revocar consentimiento bloquea inmediatamente el uso, sin esperar a un ciclo de cuota.
- Prueba de integración RLS: solo `organization_admin` puede escribir en `organization_ai_consent`; cualquier miembro puede leer el estado.

### Opción C: cláusula contractual fuera de la aplicación
**Cambios técnicos:** ninguno en el producto — el consentimiento vive en un contrato firmado externamente.
**Riesgos:** el sistema no puede verificar por sí mismo si existe consentimiento vigente; depende de un proceso externo sincronizado manualmente.
**Pruebas:** no aplicable (no hay superficie de código que probar).

---

## DR-007 — Acceso interno a `stella_interactions`

### Opción A: statu quo (todo miembro activo lee todo)
**Cambios técnicos:** ninguno.
**Riesgos:** condicionado a que DR-001/002/003 garanticen que el contenido nunca es sensible.
**Pruebas:** ninguna nueva (ya cubierto por `tests/integration/stella-interactions-rls.test.ts`).

### Opción B: restringir a `analyst` o superior
**Cambios técnicos:**
- Editar la política RLS `stella_interactions_select_member_or_admin` (nueva migración de política, no se edita el archivo original) para excluir el rol `viewer` de la condición de lectura.
- Verificar `organization_members.role` en la política, no solo pertenencia a la organización.

**Riesgos:** un `viewer` que hoy tiene acceso lo perdería — posible impacto en cualquier UI que asuma que todo miembro puede ver el historial de Stella; requiere auditar componentes de frontend que consuman esta tabla.

**Pruebas:** prueba de integración RLS nueva por rol: `viewer` ya no puede leer; `analyst`/`organization_admin`/`super_admin` sí.

### Opción C: restringir al creador + admins
**Cambios técnicos:**
- Política RLS más granular: `created_by = auth.uid() OR current_user_is_org_admin_or_super_admin()`.
- Requiere una función auxiliar de "es admin de esta organización" si no existe ya (`current_user_is_super_admin()` ya existe; faltaría el equivalente para `organization_admin`).

**Riesgos:** mayor fragmentación de colaboración entre pares del mismo rol (`analyst` no ve el trabajo de otro `analyst` con Stella) — validar con el propietario si esto es deseable antes de implementar.

**Pruebas:** prueba de integración RLS: el creador ve su propia interacción; otro `analyst` no admin no la ve; `organization_admin`/`super_admin` sí.

---

## Nota general de secuenciación

Ninguna de las opciones anteriores debe implementarse hasta que:
1. El propietario responda `STELLA_A2_OWNER_DECISION_FORM.md`.
2. Para DR-004 (retención) y DR-007 (acceso), cualquier migración de esquema o de política debe ser aditiva y no debe debilitar la garantía append-only que Etapa A1.5 ya verificó (migraciones `0042`-`0044`, política RLS de `stella_interactions`).
3. Para DR-001/002/003, la implementación técnica es la MISMA extensión del guardarraíl de contexto en los 3 casos — conviene implementarlas juntas una vez decididas, no una por una.

# Registro de decisiones pendientes de Stella

**Fecha:** 2026-07-24. Ninguna decisión de este registro se declara resuelta por esta sesión. Las marcadas "Legal/Producto" requieren al propietario del producto o asesoría jurídica externa — Claude Code no las sustituye.

---

## DR-001 · Política de PII en el contexto enviado al modelo

**Contexto:** `narrativeSummary` y los títulos de outcomes/evidencia se envían a Gemini tras sanitización básica (control chars + blocklist de 9 patrones). No hay clasificación de PII.

**Opciones:**
- (A) Bloquear el envío si se detecta un patrón de PII (regex de email/teléfono/documento de identidad) hasta que el usuario confirme.
- (B) Permitir el envío pero registrar la detección en el manifiesto de contexto (`sensitivityFlags`), sin bloquear.
- (C) No hacer nada adicional (statu quo).

**Ventajas / Riesgos:** (A) es más seguro pero añade fricción y falsos positivos; (B) da visibilidad sin fricción pero no previene el envío; (C) mantiene el riesgo actual.

**Recomendación técnica:** (B) como mínimo inmediato, con camino hacia (A) para categorías de alto riesgo (menores, salud) una vez definidas en DR-002/DR-003.

**Decisión requerida del propietario:** ¿qué categorías de PII bloquean el envío vs. solo se señalan?

**Impacto si se aplaza:** el contexto sigue pudiendo llevar PII no clasificada a un tercero. Bloquea: activar cualquier flag de Stella (Etapa A2 → B).

**Evidencia revisada (Etapa A2, 2026-07-25):** desarrollo completo de opciones, riesgos y recomendación en `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md#DR-001`; matriz de implementación por opción en `STELLA_A2_IMPLEMENTATION_OPTIONS.md#DR-001`; formulario de decisión en `STELLA_A2_OWNER_DECISION_FORM.md`. Sigue **PENDIENTE**.

---

## DR-002 · Datos de menores de edad

**Contexto:** Uellix mide impacto social; los proyectos pueden involucrar beneficiarios menores de edad (p. ej. programas educativos).

**Opciones:** (A) Prohibir explícitamente cualquier dato identificable de menores en el contexto enviado a Stella. (B) Permitir agregados/anonimizados únicamente. (C) Sin restricción especial.

**Recomendación técnica:** (A) — es el estándar más defendible y el más simple de implementar como regla dura en el guardarraíl de contexto.

**Decisión requerida:** confirmar (A) y definir qué cuenta como "identificable" en este dominio (¿nombres de escuela + cohorte + edad ya son identificables?).

**Impacto si se aplaza:** bloquea Evidence Intelligence (Etapa C) más que a Stella hoy, porque hoy solo se envían metadatos sin nombres de personas.

**Evidencia revisada (Etapa A2, 2026-07-25):** desarrollo completo de opciones, riesgos y recomendación en `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md#DR-002`; matriz de implementación por opción en `STELLA_A2_IMPLEMENTATION_OPTIONS.md#DR-002`; formulario de decisión en `STELLA_A2_OWNER_DECISION_FORM.md`.

**Estado (Etapa A2.3, 2026-07-26 → corregido): `IMPLEMENTACIÓN PARCIAL — BLOQUEO FAIL-CLOSED COMPLETADO; CAMINO DE AGREGADOS VERIFICADOS PENDIENTE`.** El propietario aprobó la opción (B). Etapa A2.3 implementó correctamente el bloqueo: cualquier señal individual de menor se bloquea sin excepción; cualquier mención agregada específica se bloqueaba también, porque no existía ningún productor real de una declaración de agregación verificada — el "camino permitido" no era alcanzable en la práctica. Esa etapa **no debía declararse `IMPLEMENTADA TÉCNICAMENTE` de forma completa** (corrección de esta sesión, no una regresión: el gate de Etapa A2.3 documentaba la brecha como riesgo residual, pero el estado resumido en este registro sobre-simplificaba diciendo "implementada técnicamente" sin esa salvedad).

**Estado (Etapa A2.3.1, 2026-07-26): `APROBADO CON RESERVAS`.** Se cerró la brecha: `stella_sensitive_aggregation_declarations` (migración `0046`) es la fuente estructurada y verificada de tamaño de grupo; `lib/stella/aggregation/` provee creación/verificación/revocación/consulta con roles exactos (`organization_admin`/`analyst` para crear, solo `organization_admin` para verificar/revocar, sin bypass de `super_admin`), re-validación del umbral y de las dimensiones en el momento de verificar (no solo al crear), e integración con el guardarraíl acotada a la entidad exacta. Probado de punta a punta contra el stack local: un agregado de 10 verificado desbloquea la entidad exacta; uno de 9 falla en verificación y sigue bloqueado; una declaración de otra entidad nunca desbloquea. **Reserva:** no existe ninguna UI para crear/verificar declaraciones — los servicios y *server actions* están listos, pero el flujo solo es operable desde código/consola hoy. Ver `STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md`.

**Estado (Etapa A2.3.2, 2026-07-26): ver `STELLA_A2_AGGREGATION_OPERATIONS_REPORT.md` para el veredicto formal.** Cerradas las 8 reservas operativas de Etapa A2.3.1: sustitución transaccional con rollback probado, bloqueo de fila (`FOR UPDATE`) en verificar/revocar, 6 escenarios de concurrencia real contra Postgres local, cambio de política v1→v2 probado sin tocar la constante productiva, consulta batch (elimina el patrón N+1 del guardarraíl), mensajes de bloqueo reescritos como instrucción accionable, y — cerrando la reserva única de Etapa A2.3.1 — una UI operativa (`components/aggregation/OutcomeSensitiveAggregationPanel.tsx`, montada por-outcome) que permite crear/verificar/revocar/sustituir declaraciones sin tocar código. Ver `STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md` (adenda) para el detalle de cada reserva cerrada.

---

## DR-003 · Datos de salud

**Contexto:** proyectos de salud pueden generar evidencia/indicadores con datos de salud de beneficiarios.

**Opciones/Recomendación:** análogas a DR-002. Datos de salud agregados (tasas, conteos) son habitualmente aceptables; datos de salud individualizados no deberían llegar nunca al modelo.

**Decisión requerida:** confirmar el umbral de agregación mínimo aceptable.

**Impacto si se aplaza:** igual que DR-002.

**Evidencia revisada (Etapa A2, 2026-07-25):** desarrollo completo de opciones, riesgos y recomendación en `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md#DR-003`; matriz de implementación por opción en `STELLA_A2_IMPLEMENTATION_OPTIONS.md#DR-003`; formulario de decisión en `STELLA_A2_OWNER_DECISION_FORM.md`.

**Estado (Etapa A2.3, 2026-07-26 → corregido): `IMPLEMENTACIÓN PARCIAL — BLOQUEO FAIL-CLOSED COMPLETADO; CAMINO DE AGREGADOS VERIFICADOS PENDIENTE`.** El propietario confirmó el umbral mínimo de agregación en 10 (`MINIMUM_SENSITIVE_GROUP_SIZE`). Misma corrección que DR-002: el bloqueo estaba completo, pero sin ningún productor real de declaración verificada, por lo que declarar "implementada técnicamente" sin salvedad sobre-simplificaba el estado real.

**Estado (Etapa A2.3.1, 2026-07-26): `APROBADO CON RESERVAS`.** Mismo mecanismo y módulo que DR-002 (`lib/stella/aggregation/`, compartiendo la reutilización de `detectHighRiskPii` de DR-001 para la señal individual). Ver `STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md` y la reserva idéntica a DR-002 (sin UI de gestión de declaraciones).

**Estado (Etapa A2.3.2, 2026-07-26):** mismo cierre que DR-002 (mecanismo compartido, `lib/stella/aggregation/`) — ver `STELLA_A2_AGGREGATION_OPERATIONS_REPORT.md` para el veredicto formal.

---

## DR-004 · Retención de `stella_interactions` y del futuro manifiesto de contexto

**Contexto:** hoy la tabla es append-only sin política de expiración. El nuevo `context_manifest` (A1.4) no contiene contenido textual, pero si en el futuro se decide guardar una copia sanitizada del contexto (§3.3 del encargo), esa copia necesitaría retención propia.

**Opciones:** (A) Retención indefinida (como el resto del audit trail de Uellix). (B) Retención configurable por organización con purga automática. (C) Retención distinta para `response_json` (puede contener texto narrativo generado) vs. metadatos (org/proyecto/rol/fecha).

**Recomendación técnica:** (C) — separar la retención del contenido narrativo generado de la retención de los metadatos de auditoría, porque son activos de sensibilidad distinta.

**Decisión requerida:** política de retención por categoría de dato.

**Impacto si se aplaza:** bloquea Etapa A3 (revisión legal) y cualquier compromiso contractual de retención con clientes.

**Evidencia revisada (Etapa A2, 2026-07-25):** desglose por categoría de dato (metadatos de auditoría, manifiesto, respuestas generadas, futuro contenido documental) y recomendación de retención diferenciada en `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md#DR-004`; diseño técnico de purga que preserva la garantía append-only en `STELLA_A2_IMPLEMENTATION_OPTIONS.md#DR-004`; formulario de decisión en `STELLA_A2_OWNER_DECISION_FORM.md`. Sigue **PENDIENTE**.

**Estado (Etapa A2.4, 2026-07-26): `APROBADO CON RESERVAS`.** El propietario aprobó la política técnica inicial (opción C: retención diferenciada por categoría) directamente en el encargo de esta etapa: `response_json` retiene 24 meses por defecto (configurable por organización entre 1 y 60 meses); metadatos de auditoría, `context_manifest`, eventos de consentimiento (DR-005), declaraciones de agregación (DR-002/DR-003) y `audit_logs` se conservan mientras la organización exista, sin purga ejecutable en esta etapa. Se construyó el motor completo de purga: `stella_retention_settings`/`stella_retention_holds`/`stella_retention_purge_runs` (migración `0047`), servicio de elegibilidad puro, purga por lotes transaccional con `SELECT...FOR UPDATE`, idempotencia (`idempotency_key` único), reanudación desde cursor, holds que bloquean la purga a nivel organización/proyecto/interacción, y auditoría transaccional (no best-effort) para holds/configuración. `response_json` se redacta (`NULL`) preservando la fila completa — nunca se elimina una interacción. Probado de punta a punta contra Postgres local: 19 pruebas en `tests/integration/stella-retention-purge.test.ts` + 9 en `tests/integration/stella-retention-rls.test.ts`. **Reserva:** los períodos de retención son política técnica inicial, no una garantía jurídica — pendientes de validación contractual y legal en Etapa A3; además, ningún evento de cierre contractual/desactivación de organización existe hoy en el esquema, por lo que la retención posterior al cierre (5 años) no tiene un disparador ejecutable todavía (documentado como brecha, no inventado). Ver `STELLA_A2_DR004_RETENTION_IMPLEMENTATION_REPORT.md`.

---

## DR-005 · Consentimiento por organización

**Contexto:** no existe hoy ningún mecanismo de opt-in/opt-out de Stella a nivel de organización más allá de la cuota (que por defecto es 0).

**Opciones:** (A) Cuota > 0 = consentimiento implícito (statu quo, ya que un `super_admin` de Uellix asigna la cuota manualmente). (B) Checkbox explícito de aceptación de términos de IA por organización, además de la cuota. (C) Cláusula contractual firmada fuera de la aplicación.

**Recomendación técnica:** (B) — la cuota es un control operativo, no un consentimiento informado; conviene un registro explícito y fechado.

**Decisión requerida:** ¿la cuota basta como consentimiento, o hace falta un registro explícito adicional?

**Impacto si se aplaza:** bloquea Etapa A2 → activación de cualquier flag para clientes reales.

**Evidencia revisada (Etapa A2, 2026-07-25):** desarrollo completo de opciones, riesgos y recomendación (registro explícito y versionado, separado de cuota) en `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md#DR-005`; diseño técnico de la tabla `organization_ai_consent` y el gate adicional en las 4 acciones en `STELLA_A2_IMPLEMENTATION_OPTIONS.md#DR-005`; formulario de decisión en `STELLA_A2_OWNER_DECISION_FORM.md`.

**Estado (Etapa A2.1, 2026-07-25): IMPLEMENTADA TÉCNICAMENTE — no es una revisión legal concluida.** El propietario aprobó la recomendación (B) vía `STELLA_A2_OWNER_DECISION_FORM.md`; la compuerta de consentimiento organizacional (tabla `stella_ai_consent_events`, servicio `getStellaConsentStatus`, server actions `acceptStellaConsent`/`revokeStellaConsent`, integrada en las 4 acciones de Stella antes de cuota/rate-limit/modelo) está implementada y probada — ver `STELLA_A2_DR005_IMPLEMENTATION_REPORT.md`. Esto NO sustituye la revisión legal de los términos de IA en sí (Etapa A3, `DR-008`/`DR-009`), que sigue pendiente.

---

## DR-006 · Persistencia del contexto — manifiesto vs. payload

**Contexto:** el encargo de esta sesión prohíbe expresamente guardar el payload/prompt bruto por defecto. Esta sesión implementa un **manifiesto estructural** (tipos de entidad, IDs, nombres de campo, conteos, hash, flags de sensibilidad) en su lugar.

**Opciones:** (A) Manifiesto únicamente (lo implementado). (B) Manifiesto + copia sanitizada del texto completo enviado, en una tabla separada con retención propia y permisos restrictivos. (C) Manifiesto + el texto completo sin sanitizar (rechazado — viola minimización).

**Ventajas de (B) sobre (A):** permite auditoría forense exacta de qué vio el modelo, útil ante una disputa metodológica.
**Riesgos de (B):** duplica contenido potencialmente sensible; requiere su propia política de retención/acceso/borrado.

**Recomendación técnica:** empezar con (A) (ya implementado). Escalar a (B) solo si Etapa A3 (legal) o un cliente exige reconstrucción exacta del payload, y en ese caso implementarlo como tabla separada, nunca como columna en `stella_interactions`.

**Decisión requerida:** ¿(A) es suficiente para las necesidades de auditoría del negocio, o se requiere (B)?

**Impacto si se aplaza:** ninguno inmediato — (A) ya está implementado y es la opción por defecto más segura.

---

## DR-007 · Acceso a `stella_interactions`

**Contexto:** hoy cualquier miembro activo de la organización puede leer TODAS las interacciones de Stella de su organización (política RLS `stella_interactions_select_member_or_admin`), sin distinción de rol interno (`viewer` ve lo mismo que `organization_admin`).

**Opciones:** (A) Statu quo (todo miembro activo lee todo). (B) Restringir lectura a roles `analyst` o superior. (C) Restringir a quien creó la interacción + `organization_admin`/`super_admin`.

**Recomendación técnica:** (A) es razonable para un audit trail interno (todos deberían poder ver qué le preguntó su equipo a Stella), pero **si el manifiesto o el `response_json` llegara a contener algo sensible**, (A) expone eso a todo el equipo, incluidos roles de solo lectura.

**Decisión requerida:** ¿el `viewer` debe poder leer `stella_interactions`?

**Impacto si se aplaza:** bajo — el statu quo ya está en producción (si Stella se activara) y no empeora con esta sesión.

**Evidencia revisada (Etapa A2, 2026-07-25):** evaluación explícita de los 5 perfiles relevantes (creador, `analyst`, `organization_admin`, `viewer`, `super_admin`) en `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md#DR-007`; diseño de las 3 variantes de política RLS en `STELLA_A2_IMPLEMENTATION_OPTIONS.md#DR-007`; formulario de decisión en `STELLA_A2_OWNER_DECISION_FORM.md`.

**Estado (Etapa A2.2, 2026-07-26): IMPLEMENTADA TÉCNICAMENTE — no es una revisión legal concluida.** El propietario aprobó la matriz de acceso (creador; `organization_admin`/`impact_manager`/`analyst` con acceso a toda la organización, por ausencia real de ACL por proyecto en Uellix; `viewer`/`reviewer` sin acceso general; `super_admin` sin bypass general). Implementado en `db/policies/010_stella_interactions_access_control_rls.sql` (RLS) y `lib/stella/access/{stella-interaction-access,stella-interaction-reads}.ts` (la misma matriz aplicada a las lecturas que bypasean RLS vía Drizzle/`DATABASE_URL`) — ver `STELLA_A2_DR007_IMPLEMENTATION_REPORT.md` para la matriz completa, las decisiones interpretativas documentadas (tratamiento de `reviewer` y de "viewer creador"), y el riesgo residual del acceso excepcional de soporte (deliberadamente no implementado en este bloque).

---

## DR-008 · DPA con Google / condiciones del proveedor

**Categoría:** **Legal.** No resoluble por esta sesión.

**Contexto:** narrative, títulos y ratios se enviarían a la API de Gemini si se activara Stella. No hay evidencia en el repositorio de un DPA firmado o revisado.

**Decisión requerida:** revisión legal externa del DPA de Google Cloud/Gemini API, condiciones de uso de datos para entrenamiento (¿Google usa el contenido de la API para reentrenar modelos por defecto? Depende del producto/tier contratado), y subprocesadores.

**Impacto si se aplaza:** **bloquea Etapa A3 completa** y, por tanto, cualquier activación en producción con datos de clientes reales.

---

## DR-009 · Región de procesamiento

**Categoría:** **Legal/Producto.**

**Contexto:** no hay configuración de región para la llamada a Gemini (`gemini-client.ts` no especifica región).

**Decisión requerida:** ¿los clientes de Uellix tienen requisitos de residencia de datos (p. ej. LATAM, UE) que exijan fijar una región de procesamiento específica de la API?

**Impacto si se aplaza:** bloquea Etapa A3 para clientes con requisitos regulatorios de residencia de datos.

---

## A3-DEFERRED-UNTIL-POST-PILOT · Diferimiento formal de la revisión legal y contractual (Etapa A3)

**Categoría:** Gobernanza/Producto. **Decisión del propietario, registrada en Etapa B0 (2026-07-26).**

**Decisión:** la revisión legal y contractual formal de Stella (Etapa A3 — DR-008, DR-009 y el resto de temas legales pendientes) **se difiere** hasta que la plataforma esté funcionalmente desarrollada y haya superado un piloto controlado con aliados seleccionados. Esta es una decisión explícita de secuenciación, **no una cancelación**: A3 permanece en el roadmap, reubicada después del piloto restringido (B5) y antes del lanzamiento comercial abierto — ver la secuencia actualizada en `STELLA_REVISED_MASTER_PLAN.md`.

**Qué NO bloquea A3 diferida:**
- El desarrollo continuo de Stella (Etapas B1-B5).
- Evaluaciones internas (arnés de evaluación, `tests/eval/`).
- La integración con Gemini API en su **modalidad pagada** (obligatoria durante desarrollo y piloto — ver más abajo).
- El piloto restringido con aliados seleccionados (Etapa B0-B5), siempre bajo los controles de acceso, consentimiento y datos ya construidos (DR-001, DR-002/DR-003, DR-004, DR-005, DR-007) y los nuevos controles de esta etapa (allowlist de piloto, confirmación operativa, kill switch).

**Qué SÍ bloquea A3 diferida (compuertas obligatorias antes de):**
- El lanzamiento comercial abierto (disponibilidad general, sin restricción de organización).
- El acceso no restringido por organizaciones (cualquier organización, sin allowlist).
- El procesamiento deliberado de datos personales sensibles o identificables (más allá del bloqueo fail-closed que DR-002/DR-003 ya aplican por defecto).

**Condiciones obligatorias mientras A3 esté diferida:**
- Se usará **exclusivamente la modalidad pagada** de Gemini API durante desarrollo y piloto — nunca la gratuita, nunca un proyecto sin facturación activa (ver §11 de `STELLA_B0_CONTROLLED_PILOT_IMPLEMENTATION_REPORT.md` para la distinción entre lo verificable desde código y lo que requiere confirmación externa del propietario).
- Los aliados participantes del piloto deben ser informados explícitamente (`STELLA_PILOT_PARTICIPANT_NOTICE_DRAFT.md`) de que: Stella está en fase piloto; la revisión legal definitiva está pendiente; sus resultados requieren revisión humana; no deben cargar datos personales sensibles o identificables.

**Aclaración explícita:** esta decisión **no significa que Uellix afirme cumplimiento legal** — es una decisión de secuenciación de producto, con controles técnicos compensatorios (los DR ya implementados) mientras la revisión legal formal no ocurre.

**Relación con DR-008/DR-009:** ambas siguen **PENDIENTES** (categoría Legal, no resolubles por esta sesión) — este diferimiento no las resuelve, solo pospone el momento en que se vuelven una compuerta obligatoria (de "antes de Etapa A3" a "antes del lanzamiento comercial abierto", vía A3 reubicada en la nueva secuencia).

---

## DR-010 · Necesidad real de recuperación semántica (embeddings/pgvector) para Evidence Intelligence

**Categoría:** Producto/Arquitectura.

**Contexto:** la auditoría original asumía pgvector como parte obligatoria de Evidence Intelligence. Esta sesión corrige esa asunción: la Etapa C debe **empezar** con extracción + fragmentos citables + búsqueda textual (usable sin extensiones nuevas), y decidir la necesidad de embeddings con datos reales.

**Datos que faltan para decidir:**
- Volumen esperado de documentos por proyecto (¿decenas? ¿cientos?).
- Longitud típica de los documentos (páginas).
- Patrones de consulta esperados (¿"encuentra el fragmento que dice X" literal, o "qué evidencia respalda este outcome" semántico?).
- Presupuesto de infraestructura para una extensión de base de datos adicional y su mantenimiento.
- Si la privacidad del cliente permite generar embeddings (que también implican una llamada a un proveedor de IA) del contenido completo de sus documentos.

**Recomendación técnica:** no decidir esto ahora; instrumentar la Etapa C con búsqueda textual primero y medir si es insuficiente en la práctica antes de añadir pgvector.

**Decisión requerida:** ninguna todavía — este ítem es un marcador para revisitar con datos, no una decisión a forzar hoy.

**Impacto si se aplaza:** ninguno — es la recomendación misma.

---

## DR-011 · Política de fuentes permitidas para Proxy Intelligence

**Categoría:** Producto/Metodología.

**Contexto:** la Etapa D (búsqueda de proxies) requiere grounding de búsqueda con citación obligatoria. Falta decidir qué fuentes se consideran "oficiales" para este dominio.

**Opciones:** (A) Allowlist explícita de dominios (Banco Mundial, PNUD, DANE, OCDE, BID, CEPAL, organismos estadísticos oficiales — coherente con `ANTIGRAVITY.md`'s lista de fuentes prioritarias ya usada en `scripts/seed-proxies.ts`). (B) Cualquier fuente que el grounding de Gemini devuelva, sin filtrar por dominio. (C) Allowlist + revisión humana obligatoria caso por caso (ya existe la revisión humana obligatoria por diseño; la pregunta es si además se restringe el dominio de búsqueda).

**Recomendación técnica:** (A) — restringir el grounding a una allowlist de dominios oficiales reduce drásticamente el riesgo de citar fuentes no autorizadas, y es coherente con la práctica ya establecida en `scripts/seed-proxies.ts`.

**Decisión requerida:** confirmar la allowlist de dominios y su proceso de actualización.

**Impacto si se aplaza:** bloquea el inicio de la Etapa D.

---

## Resumen de bloqueos

| Decisión | Bloquea |
|---|---|
| DR-001, DR-002, DR-003, DR-005 | Etapa A2 → activar cualquier flag de Stella |
| DR-004 | Etapa A3 (diferida — ver A3-DEFERRED-UNTIL-POST-PILOT) |
| DR-006 | Ninguno (ya resuelta por defecto con la opción más segura) |
| DR-007 | Ninguno urgente |
| DR-008, DR-009 | Lanzamiento comercial abierto y procesamiento deliberado de datos sensibles/identificables — YA NO bloquean el desarrollo, las evaluaciones internas, Gemini pagado, ni el piloto restringido (ver A3-DEFERRED-UNTIL-POST-PILOT) |
| A3-DEFERRED-UNTIL-POST-PILOT | Lanzamiento comercial abierto; acceso no restringido por organizaciones; procesamiento deliberado de datos sensibles/identificables. NO bloquea B0-B5 |
| DR-010 | Nada por ahora (es una decisión diferida a propósito) |
| DR-011 | Etapa D |

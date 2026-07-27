# Paquete de decisiones de gobernanza — Etapa A2

**Fecha:** 2026-07-25 · **Estado:** documento de preparación — ninguna decisión aquí está aprobada. Ver `STELLA_A2_OWNER_DECISION_FORM.md` para registrar la decisión del propietario.

Este documento convierte `DR-001`, `DR-002`, `DR-003`, `DR-004`, `DR-005` y `DR-007` de `STELLA_DECISION_REGISTER.md` en un paquete evaluable. No decide por el propietario de Uellix — presenta opciones, riesgos y recomendaciones, y espera aprobación explícita antes de que ninguna política o comportamiento cambie.

**Contexto técnico común a las 6 decisiones (verificado contra el código, no supuesto):**
- Stella está completamente apagada: `STELLA_ENABLED=false` y los 6 flags por rol en `false`/sin definir. Ninguna organización puede invocarla hoy.
- Cuando esté activa, cada rol recibe un `StellaProjectContext` — un objeto de solo metadatos, nunca archivos ni contenido de documentos: `narrativeSummary` (texto libre del proyecto), nombres/descripciones de outcomes, nombres/unidades de indicadores, títulos/tipo/estado de evidencia (nunca el archivo ni su hash completo, solo 8 caracteres truncados), nombres/fuente de proxies (nunca su valor monetario ni moneda — esos campos viajan vacíos por diseño), totales de cálculo (nunca la fórmula completa), y conteos.
- La respuesta del modelo (`response_json`) sí puede contener prosa generada por IA — un resumen, una redacción sugerida — que a su vez puede citar o parafrasear lo que había en el contexto.
- `stella_interactions` es un registro de auditoría append-only (ver Etapa A1/A1.5): hoy sin política de retención, con lectura permitida a cualquier miembro activo de la organización.

---

## DR-001 · Política de PII

**1. Pregunta concreta:** ¿Uellix debe detectar/advertir sobre PII común en lo que se envía a Stella, bloquear categorías de PII de alto riesgo, o mantener el statu quo (ninguna clasificación)?

**2. Situación actual:** `sanitizeString`/`sanitizeNarrative` (`lib/stella/context/sanitize.ts`) truncan longitud y filtran una lista fija de 9 patrones tipo secreto (`GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `sk_`, etc.). No hay ninguna detección de PII (nombres de personas, correos, teléfonos, documentos de identidad).

**3. Datos que Stella procesa actualmente:** `narrativeSummary` es texto libre escrito por un usuario de la organización — puede contener, sin que nada lo impida hoy, el nombre de un beneficiario, un correo, o cualquier dato personal que el usuario haya decidido escribir en la narrativa del proyecto. Los nombres de outcomes/evidencia/proxies son etiquetas cortas, con el mismo riesgo en menor escala.

**4. Riesgo si no se decide:** el contexto puede seguir pudiendo llevar PII no clasificada a un proveedor externo (Google/Gemini) sin que Uellix tenga ninguna señal de ello, ni en el momento del envío ni después (el `context_manifest` de Etapa A1 registra conteos y nombres de campo, no si un campo *contenía* PII).

**5. Opciones:**
- **(A) Bloquear el envío** si un patrón de PII de alto riesgo (regex de documento de identidad, tarjeta, etc.) aparece en cualquier campo del contexto, hasta que el usuario confirme o edite.
- **(B) Detectar y advertir** — igual detección, pero solo se registra en `sensitivityFlags` del manifiesto; el envío continúa.
- **(C) Statu quo** — sin detección adicional.

**6. Ventajas por opción:**
- (A): la protección más fuerte; imposible enviar PII de alto riesgo sin que un humano lo apruebe explícitamente.
- (B): visibilidad sin fricción; útil para auditar retroactivamente cuánto PII ha pasado, sin bloquear el flujo de trabajo.
- (C): cero esfuerzo de implementación, cero fricción de producto.

**7. Desventajas por opción:**
- (A): falsos positivos (un regex de documento de identidad puede coincidir con un número de referencia interno); fricción para el usuario; requiere una UX de "editar y reintentar".
- (B): no previene nada — si el dato no debía enviarse, ya se envió.
- (C): el riesgo actual permanece sin cambios ni visibilidad.

**8. Recomendación técnica:** modelo híbrido — (B) como mínimo inmediato para TODA categoría de PII común (nombres, correos, teléfonos), escalando a (A) solo para categorías de alto riesgo una vez que DR-002/DR-003 definan qué cuenta como "alto riesgo" en este dominio (menores, salud). Justificación: (A) sin una definición previa de "alto riesgo" bloquearía con criterios inventados; (B) da la visibilidad necesaria para calibrar el umbral con datos reales antes de decidir qué se bloquea.

**9. Recomendación de producto:** evaluar el costo de fricción de (A) con organizaciones piloto antes de generalizarlo — un bloqueo mal calibrado puede hacer que el usuario abandone el flujo de Stella por completo.

**10. Dependencias legales:** ninguna resolución legal externa es estrictamente necesaria para (B); (A) para categorías de alto riesgo puede beneficiarse de una revisión de qué constituye "dato personal" bajo las normativas aplicables a los mercados de Uellix (Etapa A3).

**11. Efecto sobre experiencia de usuario:** (B) es invisible para el usuario final (solo aparece en auditoría interna); (A) introduce una pausa/confirmación en el flujo de generación de Stella.

**12. Efecto sobre arquitectura y base de datos:** (B) añade un flag a `sensitivityFlags` (ya existe el campo en el manifiesto, Etapa A1.4) — no requiere migración. (A) requiere una nueva función de guardarraíl determinista (paralela a `assertContextHasNoForbiddenData`) y un código de error/mensaje específico para las 4 acciones de servidor.

**13. Efecto sobre costos y operación:** mínimo — la detección por regex es local, sin llamada a un proveedor externo ni costo variable.

**14. Tareas que se crearían al aprobar:** (B) → tarea de detección + flag en manifiesto + prueba. (A) → tarea de guardarraíl bloqueante + UX de confirmación + pruebas adversariales específicas de PII.

**15. Criterios de aceptación futuros:** una prueba que confirme que un patrón de PII común activa el flag (B) o el bloqueo (A) en el manifiesto/respuesta, sin falsos negativos en los casos de prueba definidos.

**16. Decisión registrada:** PENDIENTE.

---

## DR-002 · Datos de menores de edad

**1. Pregunta concreta:** ¿se prohíbe explícitamente cualquier dato identificable de menores en lo que se envía a Stella, y qué combinaciones de campos cuentan como "identificables" en el dominio de Uellix?

**2. Situación actual:** ninguna regla especial para menores. Un proyecto educativo o de protección infantil podría tener narrativas, nombres de outcomes o evidencia que mencionen edades, nombres de escuela, o cohortes de beneficiarios menores de edad.

**3. Datos que Stella procesa actualmente:** los mismos campos de texto libre de DR-001 (`narrativeSummary`, nombres/descripciones). Hoy NO se envían datos de beneficiarios individuales de forma estructurada (no hay una tabla de "beneficiarios" en el contexto) — el riesgo es que un usuario escriba esos datos dentro del texto libre.

**4. Riesgo si no se decide:** más relevante para la Etapa C (Evidence Intelligence, cuando se procese contenido real de documentos) que para el uso actual de Stella, porque hoy solo se envían metadatos sin nombres de personas por diseño de los context builders — pero el texto libre de `narrativeSummary` no está exento de este riesgo.

**5. Opciones:**
- **(A) Prohibir** cualquier dato directamente identificable de menores (nombres propios, fecha de nacimiento exacta, combinaciones cuasi-identificables como "escuela X + cohorte Y + edad Z").
- **(B) Permitir solo agregados/anonimizados** (conteos, rangos de edad, sin nombres).
- **(C) Sin restricción especial** más allá de la política general de PII (DR-001).

**6. Ventajas:** (A) es el estándar más defendible y más simple de codificar como regla dura; (B) preserva utilidad analítica sin exponer identidad; (C) no añade trabajo adicional.

**7. Desventajas:** (A)/(B) requieren definir "identificable" con precisión suficiente para ser una regla de código, no solo una política de intención — sin esa definición, la regla no es implementable; (C) deja el riesgo más sensible del dominio sin ninguna barrera dedicada.

**8. Recomendación técnica:** (A), pero **no implementable hoy sin que el propietario confirme qué combinaciones de campos se consideran identificables en el dominio de Uellix** (¿nombre de escuela + cohorte + edad ya es identificable? ¿nombre de escuela solo?). Esa definición es un insumo de producto, no una decisión técnica.

**9. Recomendación de producto:** tratar esto como el caso de mayor sensibilidad del catálogo de datos — aplicar el criterio más conservador por defecto (cualquier mención de una persona menor de edad por nombre se trata como prohibida) hasta que exista una definición más matizada.

**10. Dependencias legales:** posible relevancia de normativas de protección de datos de menores según jurisdicción de los clientes de Uellix (Etapa A3) — no se emite conclusión aquí.

**11. Efecto sobre experiencia de usuario:** si se bloquea, el usuario de un proyecto educativo/de protección infantil necesitaría reescribir su narrativa en términos agregados antes de poder usar Stella en esas secciones.

**12. Efecto sobre arquitectura y base de datos:** una regla de este tipo se implementaría como una extensión del guardarraíl determinista de contexto (`assertContextHasNoForbiddenData`), no como una tabla nueva — no requiere migración por sí sola.

**13. Efecto sobre costos y operación:** mínimo si es una regla de patrón; podría requerir soporte manual para organizaciones que necesiten ayuda reescribiendo narrativas bloqueadas.

**14. Tareas que se crearían al aprobar:** definición formal de "identificable" (producto) → implementación del patrón de detección (ingeniería) → suite de pruebas con casos límite → mensaje de error específico en las 4 acciones.

**15. Criterios de aceptación futuros:** casos de prueba que representen las combinaciones de campos acordadas como identificables deben ser bloqueados; casos agregados/anonimizados deben pasar.

**16. Decisión registrada:** PENDIENTE.

---

## DR-003 · Datos de salud

**1. Pregunta concreta:** ¿se prohíbe información de salud individualizada, se permite solo agregada, y cuál es el umbral mínimo de agregación aceptable?

**2. Situación actual:** análoga a DR-002 — ninguna regla especial. Proyectos de salud podrían generar evidencia/indicadores con datos de salud de beneficiarios en su narrativa o en títulos de evidencia.

**3. Datos que Stella procesa actualmente:** igual superficie que DR-001/DR-002 — texto libre y etiquetas cortas, no una tabla estructurada de datos clínicos.

**4. Riesgo si no se decide:** datos de salud individualizados (p. ej. "el paciente X mostró mejora en Y") podrían aparecer en una narrativa y enviarse a un proveedor externo sin ninguna barrera dedicada, más allá de la política general de PII.

**5. Opciones:**
- **(A) Prohibir** información de salud individualizada; permitir solo agregados (tasas, conteos, promedios poblacionales).
- **(B) Permitir con advertencia** (igual patrón que DR-001 opción B).
- **(C) Sin restricción especial.**

**6. Ventajas:** (A) es el estándar más defendible para datos de salud, categoría típicamente considerada sensible; (B) da visibilidad sin fricción; (C) no añade trabajo.

**7. Desventajas:** (A) requiere definir el umbral mínimo de agregación aceptable (¿"3 de 5 participantes mejoraron" es agregado o suficientemente pequeño para ser identificable?) antes de poder codificarse; (B)/(C) dejan el riesgo sin barrera dedicada.

**8. Recomendación técnica:** análoga a DR-002 — (A) en principio, pendiente de que el propietario defina el umbral de agregación mínimo (p. ej., "resultados de salud solo se pueden mencionar si agregan a 10+ personas").

**9. Recomendación de producto:** consultar si Uellix ya tiene clientes en el sector salud con requisitos regulatorios específicos (posible insumo para Etapa A3) antes de fijar el umbral.

**10. Dependencias legales:** posible relevancia de normativas de datos de salud según jurisdicción — no se emite conclusión aquí.

**11. Efecto sobre experiencia de usuario:** igual que DR-002 — el usuario de un proyecto de salud necesitaría escribir en términos agregados.

**12. Efecto sobre arquitectura y base de datos:** igual patrón que DR-002 — extensión del guardarraíl existente, sin migración necesaria por sí sola.

**13. Efecto sobre costos y operación:** mínimo.

**14. Tareas que se crearían al aprobar:** definición del umbral de agregación (producto) → implementación → pruebas → mensajes de error.

**15. Criterios de aceptación futuros:** casos de prueba con datos individualizados deben bloquearse; casos agregados sobre el umbral acordado deben pasar.

**16. Decisión registrada:** PENDIENTE.

---

## DR-004 · Retención

**1. Pregunta concreta:** ¿qué política de retención aplica a cada categoría de dato relacionada con Stella, y deben tener retenciones distintas entre sí?

**2. Situación actual:** `stella_interactions` es append-only sin ninguna política de expiración — cada fila persiste indefinidamente. El `context_manifest` (Etapa A1.4) no contiene texto crudo, pero `response_json` sí puede contener prosa generada extensa.

**3. Datos que Stella procesa actualmente, por categoría:**
- **Metadatos de auditoría** (organización, proyecto, usuario, rol, paso, modelo, fecha, versión de prompt/esquema) — bajo volumen, sensibilidad baja, valor de auditoría alto y duradero.
- **Manifiesto de contexto** (`context_manifest`) — nombres de campo, conteos, hash, flags de sensibilidad — nunca contenido textual; sensibilidad ya minimizada por diseño.
- **Respuestas generadas** (`response_json`) — prosa que puede parafrasear información sensible del contexto (narrativa, nombres); el activo de mayor sensibilidad de esta tabla.
- **Futuro contenido documental** (Etapa C, Evidence Intelligence) — no existe todavía; su política de retención debería decidirse cuando se diseñe esa capacidad, no ahora.

**4. Riesgo si no se decide:** compromisos contractuales de retención con clientes no pueden ofrecerse de forma creíble; la exposición acumulada de `response_json` (el activo más sensible) crece indefinidamente sin ningún control.

**5. Opciones:**
- **(A) Retención indefinida** para todo, como el resto del *audit trail* de Uellix.
- **(B) Retención configurable por organización**, con purga automática.
- **(C) Retención diferenciada por categoría** — indefinida para metadatos/manifiesto (bajo riesgo, alto valor de auditoría), acotada para `response_json` (mayor riesgo).

**6. Ventajas:** (A) es simple y ya es el patrón existente; (B) da control al cliente; (C) alinea el nivel de protección con la sensibilidad real de cada dato.

**7. Desventajas:** (A) acumula el activo más sensible (`response_json`) sin límite; (B) es más complejo de implementar (requiere un mecanismo de purga y configuración por organización) y podría romper la garantía append-only si no se diseña con cuidado (una purga programada NO es lo mismo que permitir UPDATE/DELETE arbitrario — debe seguir siendo un proceso controlado, no un privilegio del usuario final); (C) requiere una purga selectiva por columna, no por fila completa, lo cual añade complejidad de migración/consulta.

**8. Recomendación técnica:** (C) — separar la retención del contenido narrativo generado (mayor riesgo) de la retención de los metadatos de auditoría (menor riesgo, mayor valor probatorio), porque son activos de sensibilidad distinta y una política única los trataría igual sin justificación.

**9. Recomendación de producto:** definir la retención de `response_json` en función de cuánto tiempo el usuario necesita revisar/editar un borrador antes de descartarlo — probablemente semanas, no años.

**10. Dependencias legales:** **bloquea Etapa A3** — cualquier compromiso contractual de retención con clientes requiere que esta decisión esté tomada primero.

**11. Efecto sobre experiencia de usuario:** si `response_json` se purga, el usuario perdería acceso a borradores antiguos de Stella después del período de retención — debe comunicarse claramente en la UI.

**12. Efecto sobre arquitectura y base de datos:** requiere un job de purga programado (no un endpoint que el usuario pueda invocar), posiblemente una columna de "purgar después de" o un cálculo basado en `created_at`; debe preservar la fila (para no romper la garantía append-only de auditoría) mientras purga solo el campo `response_json` a un valor nulo o un marcador de "purgado", si se opta por (C).

**13. Efecto sobre costos y operación:** reduce el volumen de almacenamiento de la tabla de mayor crecimiento potencial (`response_json` puede ser texto largo); un job de purga tiene un costo operativo pequeño pero no nulo (monitoreo, alertas si falla).

**14. Tareas que se crearían al aprobar:** definir períodos de retención por categoría (producto) → diseñar el mecanismo de purga que preserve append-only (ingeniería) → migración aditiva para columnas de soporte si se necesitan → job programado → pruebas de que la purga no afecta el manifiesto ni los metadatos.

**15. Criterios de aceptación futuros:** una fila cuyo `response_json` fue purgado sigue siendo legible como registro de auditoría (organización, rol, fecha, versión) pero no expone el contenido generado; el job de purga no puede ejecutar UPDATE/DELETE arbitrario sobre filas fuera de su ventana de retención.

**16. Decisión registrada:** PENDIENTE.

---

## DR-005 · Consentimiento por organización

**1. Pregunta concreta:** ¿la cuota de Stella (ya asignada manualmente por un `super_admin`) basta como consentimiento informado, o se requiere un registro explícito y versionado adicional?

**2. Situación actual:** no existe ningún mecanismo de opt-in/opt-out más allá de la cuota mensual (por defecto 0, asignada manualmente). La cuota es un control operativo/de costos, no un registro de consentimiento informado sobre el uso de IA con los datos del proyecto.

**3. Datos que Stella procesa actualmente:** irrelevante a nivel de campo — esta decisión es sobre el MECANISMO de autorización, no sobre qué datos se envían.

**4. Riesgo si no se decide:** bloquea Etapa A2 → activación de cualquier flag para clientes reales, porque no habría evidencia de que la organización aceptó informadamente que sus datos de proyecto se envíen a un proveedor de IA externo.

**5. Opciones:**
- **(A) Cuota > 0 = consentimiento implícito** (statu quo).
- **(B) Registro explícito** por organización, separado de cuota y de los feature flags, con versión de términos aceptados, fecha, actor que aceptó, y posibilidad de revocación.
- **(C) Cláusula contractual firmada** fuera de la aplicación (sin registro en el producto).

**6. Ventajas:** (A) no requiere ningún desarrollo adicional; (B) es verificable, auditable, revocable, y no depende de que un contrato en papel esté sincronizado con el estado real de la aplicación; (C) mantiene el consentimiento en el instrumento legal más fuerte (el contrato), fuera del código.

**7. Desventajas:** (A) confunde un control operativo (cuota) con un consentimiento informado — un `super_admin` de Uellix asignando cuota no es lo mismo que la organización cliente aceptando el uso de IA; (B) requiere una tabla/campo nuevo, una *server action*, una UI de aceptación, y una forma de revocar; (C) no es verificable desde el producto — el sistema no podría, por sí mismo, confirmar que existe consentimiento vigente.

**8. Recomendación técnica:** (B) — un registro explícito y versionado es la única opción de las tres que el propio sistema puede verificar antes de permitir el uso de Stella, sin depender de un proceso externo al código.

**9. Recomendación de producto:** el registro debería ser responsabilidad de un `organization_admin` (no de cualquier miembro), y debería quedar claramente separado de la asignación de cuota (que sigue siendo responsabilidad de Uellix como proveedor).

**10. Dependencias legales:** el TEXTO de los términos que la organización acepta (qué dice exactamente el consentimiento, en qué idioma, con qué alcance) requiere redacción legal — no se redacta aquí.

**11. Efecto sobre experiencia de usuario:** un `organization_admin` vería una pantalla de aceptación de términos de uso de IA antes de que su organización pueda usar Stella, incluso si ya tiene cuota asignada; debe poder ver el estado de consentimiento y revocarlo.

**12. Efecto sobre arquitectura y base de datos:** requiere una tabla nueva (p. ej. `organization_ai_consent`) con columnas de organización, versión de términos, fecha, usuario que aceptó, y estado (activo/revocado) — ver `STELLA_A2_IMPLEMENTATION_OPTIONS.md` para el detalle técnico completo por opción.

**13. Efecto sobre costos y operación:** mínimo — una tabla pequeña, sin costo variable.

**14. Tareas que se crearían al aprobar:** migración aditiva para la tabla de consentimiento → *server action* de aceptación/revocación → verificación en las 4 acciones de Stella (gate adicional junto a `STELLA_ENABLED`/cuota) → UI → auditoría de cambios de consentimiento → pruebas.

**15. Criterios de aceptación futuros:** ninguna acción de Stella se ejecuta para una organización sin un registro de consentimiento vigente (si se aprueba B); revocar consentimiento bloquea el uso inmediatamente, igual que la cuota en 0 hoy.

**16. Decisión registrada:** PENDIENTE.

---

## DR-007 · Acceso interno a `stella_interactions`

**1. Pregunta concreta:** ¿todo miembro activo de una organización debe poder leer todas las interacciones de Stella de su organización, o el acceso debe restringirse por rol interno o por relación con la interacción?

**2. Situación actual:** la política RLS `stella_interactions_select_member_or_admin` permite a CUALQUIER miembro activo de la organización (incluido `viewer`, el rol de menor privilegio) leer TODAS las interacciones de su organización, sin distinción de rol ni de si esa persona creó la interacción.

**3. Datos que Stella procesa actualmente:** lo relevante aquí es qué puede LEER cada rol interno, no qué se envía al modelo — específicamente, `response_json` (la prosa generada, que puede parafrasear narrativa/nombres del proyecto) y el `context_manifest` (metadatos estructurales, ya minimizados).

**4. Riesgo si no se decide:** bajo en el estado actual (Stella está apagada, no hay datos reales que exponer), pero si el manifiesto o `response_json` llegaran a contener algo sensible en el futuro, el statu quo expone eso a todo el equipo, incluidos roles de solo lectura, sin ninguna razón operativa que lo justifique explícitamente.

**5. Opciones — evaluando específicamente estos 5 perfiles: creador de la interacción, `analyst`, `organization_admin`, `viewer`, `super_admin`:**
- **(A) Statu quo:** todo miembro activo lee todo.
- **(B) Restringir a `analyst` o superior:** `viewer` pierde acceso de lectura a `stella_interactions`.
- **(C) Restringir al creador + `organization_admin`/`super_admin`:** un `analyst` que no creó la interacción no la vería, salvo que sea también admin.

**6. Ventajas:** (A) es simple y coherente con "todo el equipo debería poder ver qué le preguntó su equipo a Stella"; (B) reduce la superficie de exposición al rol de menor privilegio sin restringir la colaboración entre roles operativos; (C) es el más restrictivo, alineado con un modelo de "necesidad de saber" estricto.

**7. Desventajas:** (A) no distingue sensibilidad; (B) un `viewer` legítimamente interesado en el progreso metodológico del proyecto pierde visibilidad; (C) fragmenta la colaboración — un `analyst` no podría revisar el trabajo de otro `analyst` con Stella sin ser admin, lo cual podría ir en contra de cómo equipos pequeños realmente trabajan.

**8. Recomendación técnica:** (A) es razonable como punto de partida para un *audit trail* interno **siempre que `response_json` no llegue a contener algo que un `viewer` no debería ver** — es decir, esta decisión está acoplada a DR-001/DR-002/DR-003 (si esas políticas garantizan que nunca hay PII/menores/salud en el contexto, el contenido generado tampoco debería tenerlo, y (A) es seguro). Si esas políticas no llegan a ese nivel de garantía, (B) es la opción más proporcionada.

**9. Recomendación de producto:** consultar si `viewer` es un rol pensado para stakeholders externos (financiadores, auditores externos) o solo para miembros internos de bajo involucramiento — la respuesta cambia el cálculo de riesgo sustancialmente.

**10. Dependencias legales:** ninguna identificada más allá de lo ya cubierto por DR-001/002/003.

**11. Efecto sobre experiencia de usuario:** (B)/(C) ocultarían una sección de la interfaz (historial de interacciones con Stella) a ciertos roles — requiere una comunicación clara de por qué no la ven, para no parecer un error.

**12. Efecto sobre arquitectura y base de datos:** cambiar la política RLS existente (`002_stella_interactions_rls.sql`) — no requiere una migración de esquema, pero SÍ requiere una migración de política (`.sql` de políticas, ya es el patrón de este repo) y pruebas de integración RLS nuevas para cada rol afectado.

**13. Efecto sobre costos y operación:** ninguno significativo.

**14. Tareas que se crearían al aprobar:** redacción de la nueva política RLS → migración de política → pruebas de integración por rol (ampliando `tests/integration/stella-interactions-rls.test.ts`) → actualización de la UI que lista interacciones si corresponde.

**15. Criterios de aceptación futuros:** pruebas de integración que confirmen que cada rol ve exactamente lo que la opción elegida especifica, ni más ni menos.

**16. Decisión registrada:** PENDIENTE.

---

## Resumen de dependencias entre decisiones

- DR-001/002/003 comparten el mismo mecanismo técnico (extensión del guardarraíl de contexto) — conviene decidirlas en conjunto para no implementar 3 variantes del mismo control por separado.
- DR-007 está acoplada al resultado de DR-001/002/003: cuanto más fuerte sea la garantía de que el contexto/respuesta nunca lleva datos sensibles, más segura es la opción (A) de DR-007.
- DR-005 bloquea la activación de cualquier flag de Stella para clientes reales, independientemente de qué se decida en las demás.
- DR-004 bloquea Etapa A3 completa (revisión legal), no solo la activación de Stella.

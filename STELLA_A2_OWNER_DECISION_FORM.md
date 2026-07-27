# Formulario de decisión del propietario — Etapa A2

**Instrucciones:** para cada decisión, marca una opción y añade comentarios si quieres ajustar algo. No necesitas releer todo el repositorio — el detalle completo de cada decisión está en `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md` y las opciones técnicas concretas en `STELLA_A2_IMPLEMENTATION_OPTIONS.md`, por si quieres profundizar antes de responder. Ninguna casilla de este documento viene pre-marcada.

---

## DR-001 · PII

**Recomendación:** modelo híbrido — detectar y advertir (sin bloquear) para PII común; bloquear solo categorías de alto riesgo, una vez definidas junto con DR-002/DR-003.

**Decisión propuesta:**
[ ] Aprobar recomendación
[ ] Elegir alternativa: bloquear todo PII común desde ya (Opción A completa)
[ ] Elegir alternativa: no hacer nada por ahora (statu quo, Opción C)
[ ] Solicitar ajuste

**Comentarios:**

---

## DR-002 · Datos de menores

**Recomendación:** prohibir datos directamente identificables de menores; permitir solo agregados/anonimizados. Requiere que definas qué combinaciones de campos cuentan como "identificables" en tus proyectos (ver pregunta abajo).

**Decisión propuesta:**
[ ] Aprobar recomendación
[ ] Elegir alternativa: permitir agregados sin restricción adicional (Opción B)
[ ] Elegir alternativa: sin restricción especial (Opción C)
[ ] Solicitar ajuste

**Pregunta que necesito que respondas para poder implementar esto:** en tus proyectos, ¿"nombre de escuela + cohorte + edad" ya cuenta como identificable, o hace falta más para considerarlo así?

**Comentarios:**

---

## DR-003 · Datos de salud

**Recomendación:** prohibir información de salud individualizada; permitir solo agregados. Requiere que definas el umbral mínimo de agregación aceptable (ver pregunta abajo).

**Decisión propuesta:**
[ ] Aprobar recomendación
[ ] Elegir alternativa: permitir con advertencia, sin bloquear (Opción B)
[ ] Elegir alternativa: sin restricción especial (Opción C)
[ ] Solicitar ajuste

**Pregunta que necesito que respondas para poder implementar esto:** ¿cuántas personas mínimo debe agregar un resultado de salud para considerarse seguro de enviar (por ejemplo, "10 o más")?

**Comentarios:**

---

## DR-004 · Retención

**Recomendación:** retención diferenciada por categoría — indefinida para metadatos de auditoría y el manifiesto de contexto (bajo riesgo, alto valor probatorio); acotada para las respuestas generadas por Stella (`response_json`, el activo más sensible).

**Decisión propuesta:**
[ ] Aprobar recomendación
[ ] Elegir alternativa: retención indefinida para todo (Opción A)
[ ] Elegir alternativa: retención configurable por organización, con purga (Opción B)
[ ] Solicitar ajuste

**Pregunta que necesito que respondas para poder implementar esto:** si apruebas la recomendación, ¿cuánto tiempo debería conservarse una respuesta generada por Stella antes de purgarse (semanas, meses)?

**Comentarios:**

---

## DR-005 · Consentimiento por organización

**Recomendación:** registro explícito y versionado por organización, separado de la cuota y de los feature flags — con fecha, actor que aceptó, y posibilidad de revocación.

**Decisión propuesta:**
[ ] Aprobar recomendación
[ ] Elegir alternativa: la cuota ya asignada basta como consentimiento (statu quo, Opción A)
[ ] Elegir alternativa: cláusula contractual fuera de la aplicación (Opción C)
[ ] Solicitar ajuste

**Comentarios:**

---

## DR-007 · Acceso interno a `stella_interactions`

**Recomendación:** mantener el acceso actual (todo miembro activo lee todo), condicionado a que DR-001/002/003 garanticen que el contenido generado por Stella nunca lleva PII/datos de menores/salud. Si esa garantía no te convence, la alternativa más proporcionada es restringir la lectura a `analyst` o superior (el rol `viewer` dejaría de ver el historial de Stella).

**Decisión propuesta:**
[ ] Aprobar recomendación (mantener acceso actual, condicionado a DR-001/002/003)
[ ] Elegir alternativa: restringir a `analyst` o superior (Opción B)
[ ] Elegir alternativa: restringir al creador + admins (Opción C)
[ ] Solicitar ajuste

**Comentarios:**

---

## Cierre

**Nombre del responsable:**

**Fecha:**

**Versión del paquete revisado:** `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md` — 2026-07-25

**Aprobación para implementar A2:**
[ ] Sí
[ ] No
[ ] Parcial (indicar cuáles decisiones sí, en comentarios)

**Comentarios finales:**

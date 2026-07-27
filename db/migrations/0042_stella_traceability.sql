-- 0042_stella_traceability.sql
--
-- Etapa A1 (STL-A1-005, STL-A1-013). Aditiva; no toca ninguna fila existente,
-- no impone NOT NULL sobre columnas nuevas (serían filas históricas rotas si
-- alguna vez las hubiera). Dos cambios independientes sobre `stella_interactions`:
--
-- 1) Trazabilidad de prompt/esquema/contexto (STL-A1-002, STL-A1-003, STL-A1-004).
--    Hasta ahora una fila de `stella_interactions` registraba la respuesta y un
--    hash del contexto, pero no qué VERSIÓN de prompt ni de esquema de contexto
--    la produjo, ni qué se consultó para construirla. Estas cuatro columnas
--    cierran esa brecha (ver STELLA_GAP_ANALYSIS.md#GAP-P0-5).
--
--    `context_manifest` es deliberadamente un resumen ESTRUCTURAL (tipos de
--    entidad, IDs, NOMBRES de campo, conteos, hash, flags de sensibilidad) —
--    nunca el texto/prompt bruto enviado al modelo. Esa es una decisión
--    explícita, no una omisión: ver STELLA_DECISION_REGISTER.md#DR-006.
--
-- 2) Corrección de `model_used` (STL-A1-013). Su DEFAULT apuntaba a
--    'gemini-2.0-flash', un modelo retirado por Google (ver lib/stella/config.ts).
--    Las 4 acciones de Stella (advisor/composer/validator/reviewer) ya pasan
--    siempre `modelUsed: response.modelUsed` explícitamente, así que el DEFAULT
--    nunca se ha usado en la práctica — pero, de usarse alguna vez por un
--    inserto futuro que lo omitiera, dejaría una fila de auditoría afirmando
--    falsamente que se usó un modelo distinto del real. Se elimina el DEFAULT
--    en vez de sustituirlo por otro valor fijo: cualquier valor fijo (incluido
--    el modelo actualmente configurado) podría divergir en el futuro del
--    modelo realmente configurado en `GEMINI_MODEL`, lo cual sería la misma
--    clase de mentira silenciosa. La columna sigue siendo NOT NULL: cada
--    inserción debe seguir aportando el modelo real explícitamente.

ALTER TABLE "stella_interactions"
  ADD COLUMN IF NOT EXISTS "prompt_template_id" varchar(150),
  ADD COLUMN IF NOT EXISTS "prompt_version" integer,
  ADD COLUMN IF NOT EXISTS "context_schema_version" integer,
  ADD COLUMN IF NOT EXISTS "context_manifest" jsonb;

ALTER TABLE "stella_interactions"
  ALTER COLUMN "model_used" DROP DEFAULT;

-- 0046_stella_sensitive_aggregation_declarations.sql
--
-- Etapa A2.3.1 (STL-A231-004, DR-002/DR-003 — cierre de la brecha de datos
-- documentada en STELLA_A2_DR002_DR003_IMPLEMENTATION_REPORT.md#8). Tabla
-- nueva, aditiva, no modifica ninguna tabla ni migracion existente.
--
-- Proposito: fuente estructurada, auditable y verificada de que un dato de
-- menores/salud de una entidad especifica del proyecto es un AGREGADO real
-- (tamano de grupo >= MINIMUM_SENSITIVE_GROUP_SIZE, verificado por un actor
-- autorizado), para que lib/stella/context/sensitive-population.ts deje de
-- bloquear TODA mencion agregada por falta de una declaracion verificable.
--
-- Diseno elegido: Opcion B del encargo (tabla central polimorfica
-- entity_type/entity_id), NO Opcion A (columnas por entidad — duplicaria el
-- mismo conjunto de columnas en outcomes/indicators/stakeholder_groups/
-- evidence_items/sroi_report_sections) ni Opcion C (tabla por tipo de
-- entidad — 5 tablas casi identicas para 5 tipos de entidad reales). La
-- naturaleza polimorfica se compensa (ver justificacion completa en
-- STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md#5-6):
--   - entity_type restringido por CHECK a una allowlist fija de entidades
--     REALES (no se acepta ningun string arbitrario).
--   - La existencia de la fila (entity_id) y su pertenencia a
--     organization_id/project_id se valida SIEMPRE en el servicio
--     (lib/stella/aggregation/entity-validation.ts), nunca solo por FK —
--     una FK polimorfica no es posible en Postgres sin particionar por
--     tabla, y particionar 5 tablas para esto seria sobre-ingenieria.
--   - Unicidad: a lo sumo una declaracion ACTIVA (pending|verified) por
--     (organization_id, project_id, entity_type, entity_id,
--     sensitive_category) — indice unico parcial abajo.
--
-- Estado e historial: fila mutable con estado (pending -> verified ->
-- (revoked | superseded)), igual patron que financial_proxies.review_status
-- (fila mutable + reviewer_id/reviewed_at), NO un log de eventos como
-- stella_ai_consent_events — aqui SI existe un "estado vigente" que se
-- consulta constantemente desde el guardarrail de contexto en cada llamada a
-- Stella, así que una fila de estado actual es la consulta mas simple y
-- rapida; el historial completo se reconstruye siguiendo
-- supersedes_declaration_id/superseded_by_declaration_id. Los campos
-- materiales (group_size, sensitive_category, dimensions, verified_by,
-- verified_at) NUNCA se modifican tras la verificacion: el servicio no
-- expone ninguna funcion de "editar" esos campos — un cambio material
-- siempre crea una declaracion NUEVA y marca la anterior como 'superseded'.
--
-- Minimizacion de datos (ver header de
-- lib/stella/aggregation/types.ts): esta tabla NUNCA almacena nombres,
-- diagnosticos, testimonios, direcciones ni el payload enviado a Stella.
-- `dimensions` solo admite codigos de una taxonomia fija (age_band, gender,
-- etc.), nunca valores libres. `count_source_note`/`count_source_id` son una
-- referencia ESTRUCTURAL a la fuente del conteo (tipo + id de fila),
-- nunca el contenido de esa fuente.
--
-- Privilegios minimos desde el inicio (leccion de 0033/0043): authenticated
-- recibe solo SELECT. Todas las escrituras legitimas pasan exclusivamente
-- por lib/stella/aggregation/declaration-service.ts via Drizzle sobre
-- DATABASE_URL (rol `postgres`, bypasea RLS y privilegios de tabla).

CREATE TABLE "stella_sensitive_aggregation_declarations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "project_id" uuid NOT NULL REFERENCES "projects"("id"),

  "entity_type" varchar(50) NOT NULL,
  "entity_id" uuid NOT NULL,

  "sensitive_category" varchar(20) NOT NULL,
  "aggregation_level" varchar(20) NOT NULL DEFAULT 'aggregate',

  "group_size" integer NOT NULL,
  "group_size_bucket" varchar(20) NOT NULL,
  -- Codigos de taxonomia fija unicamente (ver ALLOWED_AGGREGATION_DIMENSIONS
  -- en lib/stella/aggregation/policy.ts) — nunca valores libres.
  "dimensions" text[] NOT NULL DEFAULT '{}',

  "count_source_type" varchar(40) NOT NULL,
  -- Referencia estructural opcional a la fila que respalda el conteo
  -- (p. ej. un indicator_id si count_source_type = 'indicator_measurement').
  -- Nunca el contenido de esa fila.
  "count_source_id" uuid,
  "count_source_note" varchar(255),

  "verification_status" varchar(20) NOT NULL DEFAULT 'pending',

  "declared_by" uuid NOT NULL REFERENCES "users"("id"),
  "verified_by" uuid REFERENCES "users"("id"),
  "verified_at" timestamp,

  -- Resueltos SIEMPRE en servidor al declarar/verificar — nunca aceptados
  -- del cliente. minimum_group_size_applied solo se rellena al verificar
  -- (es el umbral que gobernó esa verificación concreta).
  "policy_version" varchar(20) NOT NULL,
  "minimum_group_size_applied" integer,

  "revoked_by" uuid REFERENCES "users"("id"),
  "revoked_at" timestamp,
  "revocation_reason" varchar(255),

  "supersedes_declaration_id" uuid REFERENCES "stella_sensitive_aggregation_declarations"("id"),
  "superseded_by_declaration_id" uuid REFERENCES "stella_sensitive_aggregation_declarations"("id"),

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,

  CONSTRAINT "ssad_entity_type_check" CHECK (
    "entity_type" IN ('project', 'outcome', 'indicator', 'stakeholder_group', 'evidence', 'report_section')
  ),
  CONSTRAINT "ssad_sensitive_category_check" CHECK (
    "sensitive_category" IN ('minors', 'health', 'minors_and_health')
  ),
  CONSTRAINT "ssad_aggregation_level_check" CHECK ("aggregation_level" = 'aggregate'),
  CONSTRAINT "ssad_group_size_positive_check" CHECK ("group_size" > 0),
  CONSTRAINT "ssad_group_size_bucket_check" CHECK (
    "group_size_bucket" IN ('below_10', '10_49', '50_249', '250_plus')
  ),
  CONSTRAINT "ssad_verification_status_check" CHECK (
    "verification_status" IN ('pending', 'verified', 'revoked', 'superseded')
  ),
  CONSTRAINT "ssad_count_source_type_check" CHECK (
    "count_source_type" IN (
      'project_record', 'indicator_measurement', 'stakeholder_record',
      'verified_external_evidence', 'manual_verified_declaration'
    )
  ),
  CONSTRAINT "ssad_verified_pair_check" CHECK (
    ("verification_status" = 'verified'
      AND "verified_by" IS NOT NULL
      AND "verified_at" IS NOT NULL
      AND "minimum_group_size_applied" IS NOT NULL)
    OR "verification_status" != 'verified'
  ),
  CONSTRAINT "ssad_revoked_pair_check" CHECK (
    ("verification_status" = 'revoked' AND "revoked_by" IS NOT NULL AND "revoked_at" IS NOT NULL)
    OR "verification_status" != 'revoked'
  )
);

-- A lo sumo una declaracion ACTIVA (pending|verified) por entidad+categoria.
-- Una declaracion revoked/superseded no cuenta para esta unicidad, lo que
-- permite crear la declaracion sustituta sin violar el indice.
CREATE UNIQUE INDEX "ssad_active_unique_idx"
  ON "stella_sensitive_aggregation_declarations"
  ("organization_id", "project_id", "entity_type", "entity_id", "sensitive_category")
  WHERE "verification_status" IN ('pending', 'verified');

CREATE INDEX "ssad_org_project_idx"
  ON "stella_sensitive_aggregation_declarations" ("organization_id", "project_id");
CREATE INDEX "ssad_entity_idx"
  ON "stella_sensitive_aggregation_declarations" ("entity_type", "entity_id");

ALTER TABLE "stella_sensitive_aggregation_declarations" ENABLE ROW LEVEL SECURITY;

-- Privilegios minimos desde el inicio (ver nota de cabecera). `anon` no
-- recibe nada (sin GRANT explicito).
REVOKE ALL ON TABLE "stella_sensitive_aggregation_declarations" FROM "authenticated";
GRANT SELECT ON TABLE "stella_sensitive_aggregation_declarations" TO "authenticated";

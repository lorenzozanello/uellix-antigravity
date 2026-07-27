-- 0045_stella_ai_consent.sql
--
-- Etapa A2.1 (STL-A21-003, DR-005 aprobado 2026-07-25 via
-- STELLA_A2_OWNER_DECISION_FORM.md). Tabla nueva, aditiva, append-only. No
-- modifica ninguna tabla ni migracion existente.
--
-- Diseno elegido: Opcion B (registro append-only de eventos), no Opcion A
-- (fila mutable de estado actual) ni Opcion C (estado + eventos). El estado
-- vigente se resuelve con una sola consulta indexada (el evento mas
-- reciente por organizacion, ORDER BY occurred_at DESC LIMIT 1 sobre el
-- indice (organization_id, occurred_at)), lo que hace innecesaria una tabla
-- de estado separada sin perder velocidad de lectura. Justificacion
-- completa: STELLA_A2_DR005_IMPLEMENTATION_REPORT.md#3.
--
-- Solo 2 valores de event_type: 'accepted' y 'revoked'. NO se modela
-- 'superseded' como fila propia: una aceptacion anterior queda superada
-- implicitamente en cuanto existe una fila 'accepted' posterior para la
-- misma organizacion (occurred_at mayor). Anadir una tercera fila explicita
-- solo para anunciar ese mismo hecho no aporta informacion nueva y crea una
-- fuente adicional de inconsistencia si alguna vez se insertara una
-- aceptacion sin su 'superseded' correspondiente.
--
-- Privilegios: leccion aprendida de la migracion 0033 (otorgo
-- SELECT/INSERT/UPDATE/DELETE a `authenticated` sobre stella_interactions
-- sin necesidad; cerrado recien en Etapa A1.5 via la migracion 0043). Esta
-- tabla se crea DESDE EL INICIO con privilegios minimos para `authenticated`
-- (solo SELECT) -- no hace falta una migracion de endurecimiento posterior.
-- Las inserciones legitimas siempre pasan por Drizzle sobre DATABASE_URL
-- (rol `postgres`, superusuario, bypasea RLS y privilegios de tabla) -- el
-- mismo mecanismo que ya usa recordStellaInteraction().

CREATE TABLE "stella_ai_consent_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "event_type" varchar(20) NOT NULL,
  -- Obligatorias solo para 'accepted' (ver CHECK abajo); una revocacion no
  -- declara versiones nuevas, se refiere a la aceptacion vigente via
  -- supersedes_event_id.
  "ai_terms_version" varchar(20),
  "data_policy_version" varchar(20),
  "capability_scope" text[],
  "actor_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "occurred_at" timestamp DEFAULT now() NOT NULL,
  "reason" text,
  "supersedes_event_id" uuid REFERENCES "stella_ai_consent_events"("id"),
  "metadata" jsonb,
  CONSTRAINT "stella_ai_consent_events_event_type_check"
    CHECK ("event_type" IN ('accepted', 'revoked')),
  CONSTRAINT "stella_ai_consent_events_accepted_versions_check"
    CHECK (
      ("event_type" = 'accepted' AND "ai_terms_version" IS NOT NULL AND "data_policy_version" IS NOT NULL AND "capability_scope" IS NOT NULL)
      OR "event_type" = 'revoked'
    )
);

-- Resuelve "estado vigente por organizacion" con un solo index scan.
CREATE INDEX "stella_ai_consent_events_org_occurred_idx"
  ON "stella_ai_consent_events" ("organization_id", "occurred_at" DESC);

ALTER TABLE "stella_ai_consent_events" ENABLE ROW LEVEL SECURITY;

-- Privilegios minimos desde el inicio (ver nota de privilegios arriba).
-- `anon` no recibe nada (ya cubierto por el REVOKE ALL ... FROM anon global
-- de la migracion 0033, que aplica a "ALL TABLES IN SCHEMA public" en el
-- momento de esa migracion -- para una tabla creada despues, `anon` no
-- tiene privilegios por defecto salvo que se otorguen explicitamente, y
-- aqui no se le otorga ninguno).
REVOKE ALL ON TABLE "stella_ai_consent_events" FROM "authenticated";
GRANT SELECT ON TABLE "stella_ai_consent_events" TO "authenticated";

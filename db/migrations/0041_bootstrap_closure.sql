-- 0041_bootstrap_closure.sql
--
-- Migración correctiva (F0-04 + F2-02). NO modifica ninguna migración
-- histórica ya aplicada: cierra los dos huecos que impedían que el bootstrap
-- fuese autocontenido y reaplicable.
--
-- Hueco 1 — `db/policies/008_marketing_leads_rls.sql` era el único fichero de
--   políticas sin migración equivalente. Una base creada sólo con la cadena de
--   migraciones dejaba `marketing_leads` SIN RLS y sin políticas, pese a que
--   la tabla guarda PII (correos de leads comerciales). El procedimiento
--   documentado exigía ejecutarlo a mano en el editor SQL de Supabase.
--
-- Hueco 2 — `0033_public_api_grants.sql` ejecuta
--   `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated`,
--   lo que también revoca los helpers de RLS de Storage creados por
--   `supabase/migrations/20260716000001_storage_policies.sql`. `0039` los
--   vuelve a conceder, pero sólo si se aplica DESPUÉS de que esos helpers
--   existan. Reaplicar 0033 por separado (reset, restauración de backup,
--   despliegue idempotente) deja la evidencia inutilizable en silencio:
--   verificado el 2026-07-24, 5 de 28 pruebas de integración fallando con
--   `permission denied for function can_write_evidence_object`.
--
--   Esta migración vuelve a conceder los permisos al final de la cadena y es
--   idempotente, de modo que el estado final ya no depende del orden en que se
--   apliquen las capas.
--
-- Todo el fichero es idempotente: puede ejecutarse dos veces seguidas.

-- ─── Hueco 1: RLS de marketing_leads ────────────────────────────────────────

ALTER TABLE public.marketing_leads ENABLE ROW LEVEL SECURITY;

-- Sólo los super_admin leen los leads (contienen PII). Se usa el helper de
-- `private`, no el de `public`: PostgREST auto-expone `public` como RPC.
DROP POLICY IF EXISTS "super_admins_read_marketing_leads" ON public.marketing_leads;
CREATE POLICY "super_admins_read_marketing_leads"
  ON public.marketing_leads FOR SELECT
  TO authenticated
  USING (private.current_user_is_super_admin());

-- El formulario público de demo inserta sin sesión.
DROP POLICY IF EXISTS "anon_insert_marketing_leads" ON public.marketing_leads;
CREATE POLICY "anon_insert_marketing_leads"
  ON public.marketing_leads FOR INSERT
  TO anon
  WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_insert_marketing_leads" ON public.marketing_leads;
CREATE POLICY "authenticated_insert_marketing_leads"
  ON public.marketing_leads FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Sin políticas de UPDATE ni DELETE: los leads son append-only.

-- `0033` revoca todo sobre `anon` por defecto; el INSERT anónimo necesita el
-- privilegio de tabla además de la política.
GRANT INSERT ON public.marketing_leads TO anon;
GRANT INSERT, SELECT ON public.marketing_leads TO authenticated;

-- ─── Hueco 2: permisos de los helpers de Storage, independientes del orden ──
-- Se envuelve en un bloque condicional porque las funciones las crea una
-- migración de Supabase (fuera de la cadena de Drizzle): si alguien aplica sólo
-- las migraciones de Drizzle contra una base sin Storage, esto no debe romper.

DO $$
BEGIN
  IF to_regprocedure('public.can_read_evidence_object(text, uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.can_read_evidence_object(text, uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.can_read_evidence_object(text, uuid) TO authenticated;
  ELSE
    RAISE WARNING 'can_read_evidence_object no existe: aplica supabase/migrations antes que las migraciones de Drizzle (pnpm db:bootstrap:local lo hace en el orden correcto)';
  END IF;

  IF to_regprocedure('public.can_write_evidence_object(text, uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.can_write_evidence_object(text, uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.can_write_evidence_object(text, uuid) TO authenticated;
  ELSE
    RAISE WARNING 'can_write_evidence_object no existe: aplica supabase/migrations antes que las migraciones de Drizzle (pnpm db:bootstrap:local lo hace en el orden correcto)';
  END IF;
END $$;

// tests/integration/bootstrap-invariants.test.ts
//
// F0-04 + F2-02 — Verifica los invariantes que debe cumplir la base tras el
// bootstrap. En CI se ejecuta DESPUÉS de aplicar el bootstrap dos veces
// seguidas, de modo que un fallo aquí significa que la segunda aplicación
// rompió algo (que es exactamente lo que ocurría con 0033 y los helpers de
// Storage: la evidencia dejaba de funcionar en silencio).
//
// La guarda de host de vitest.setup.integration.ts garantiza que esto sólo
// puede ejecutarse contra un stack de loopback.

import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import journal from '@/db/migrations/meta/_journal.json'

async function scalar<T>(query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await db.execute(query)) as unknown as Record<string, unknown>[]
  return Object.values(rows[0])[0] as T
}

describe('Invariantes del bootstrap local', () => {
  it('registra todas las migraciones del journal', async () => {
    const applied = await scalar<number>(
      sql`select count(*)::int from drizzle.__drizzle_migrations`,
    )
    expect(applied).toBe(journal.entries.length)
  })

  it('crea las 37 tablas de negocio en public', async () => {
    const tables = await scalar<number>(sql`
      select count(*)::int from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`)
    expect(tables).toBe(37)
  })

  it('no deja drift de esquema respecto a db/schema.ts', async () => {
    // `drizzle-kit check` cubre el journal; aquí se comprueba una muestra de
    // columnas añadidas por las últimas migraciones, que es lo que se rompería
    // si alguien aplicase la cadena a medias.
    const columns = await scalar<number>(sql`
      select count(*)::int from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'sroi_reports' and column_name = 'include_evidence_confidence')
          or (table_name = 'organizations' and column_name = 'stripe_customer_id')
          or (table_name = 'users' and column_name = 'deleted_at')
        )`)
    expect(columns).toBe(3)
  })

  describe('SEC-02 — fuente única de políticas RLS', () => {
    it('tiene los tres helpers en el esquema private', async () => {
      const count = await scalar<number>(sql`
        select count(*)::int from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname like 'current_user_%'`)
      expect(count).toBe(3)
    })

    it('NO tiene copias duplicadas en public', async () => {
      // Si alguien ejecuta db/policies/001_initial_auth_rls.sql a mano, crea
      // estos duplicados en `public`, que PostgREST auto-expone como RPC.
      const count = await scalar<number>(sql`
        select count(*)::int from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'current_user_%'`)
      expect(count).toBe(0)
    })
  })

  describe('SEC-03 — permisos de los helpers de Storage', () => {
    it('authenticated conserva EXECUTE tras el segundo bootstrap', async () => {
      const canRead = await scalar<boolean>(sql`
        select has_function_privilege('authenticated', 'public.can_read_evidence_object(text,uuid)', 'EXECUTE')`)
      const canWrite = await scalar<boolean>(sql`
        select has_function_privilege('authenticated', 'public.can_write_evidence_object(text,uuid)', 'EXECUTE')`)

      // Éste es el invariante que 0033 rompía al reaplicarse: sin él, toda
      // subida y lectura de evidencia falla con permission denied.
      expect(canRead).toBe(true)
      expect(canWrite).toBe(true)
    })

    it('anon NO tiene EXECUTE sobre los helpers', async () => {
      const canRead = await scalar<boolean>(sql`
        select has_function_privilege('anon', 'public.can_read_evidence_object(text,uuid)', 'EXECUTE')`)
      expect(canRead).toBe(false)
    })
  })

  it('anon no puede ejecutar ninguna función del esquema public', async () => {
    const rows = (await db.execute(sql`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prokind = 'f'
        and has_function_privilege('anon', p.oid, 'EXECUTE')`)) as unknown as {
      proname: string
    }[]

    expect(rows.map((r) => r.proname)).toEqual([])
  })

  it('protege marketing_leads con RLS (contiene PII)', async () => {
    const rls = await scalar<boolean>(sql`
      select relrowsecurity from pg_class where relname = 'marketing_leads'`)
    const policies = await scalar<number>(sql`
      select count(*)::int from pg_policies where tablename = 'marketing_leads'`)

    expect(rls).toBe(true)
    expect(policies).toBeGreaterThanOrEqual(3)
  })

  it('mantiene el bucket de evidencia privado', async () => {
    const isPublic = await scalar<boolean>(sql`
      select public from storage.buckets where id = 'uellix-evidence'`)
    expect(isPublic).toBe(false)
  })

  it('mantiene los disparadores append-only', async () => {
    const count = await scalar<number>(sql`
      select count(*)::int from pg_trigger
      where tgname in (
        'trg_audit_logs_append_only',
        'trg_sroi_runs_append_only',
        'trg_sroi_line_items_append_only'
      )`)
    expect(count).toBe(3)
  })
})

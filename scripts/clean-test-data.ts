// scripts/clean-test-data.ts
//
// F0-06 — Procedimiento seguro para identificar y eliminar datos de prueba.
// SÓLO puede ejecutarse contra un stack local: usa la misma guarda de host que
// los seeds (`db/guard.ts`, F0-05).
//
// Por qué hace falta
// ------------------
// Las suites de integración limpian lo que pueden, pero `audit_logs` tiene una
// FK a `organizations` y es APPEND-ONLY por disparador (`0030_immutability.sql`):
// cualquier DELETE lanza excepción, incluso para el rol propietario. Eso es
// deliberado —es la garantía de trazabilidad del producto— y significa que una
// organización que llegó a generar auditoría no puede borrarse por la vía normal.
// Este script es el único lugar donde ese disparador se desactiva, y lo hace
// dentro de una transacción, en local, y sólo para las filas de las
// organizaciones identificadas como de prueba.
//
// Uso:
//   pnpm db:clean:test-data              # simulacro: enumera sin borrar
//   pnpm db:clean:test-data --confirm    # ejecuta el borrado
//
// QUÉ ELIMINA (sólo para organizaciones cuyo slug case con TEST_SLUG_PATTERNS):
//   • storage.objects del bucket uellix-evidence bajo los proyectos afectados
//   • evidence_items, sroi_* (reports, sections, runs, line items, reviews,
//     review items, assignment inputs, filter sets), outcome_proxy_assignments,
//     outcome_funder_allocations, outcome_taxonomy_mappings, indicators,
//     outcomes, stakeholder_groups, impact_narratives, theory_of_change_*,
//     methodology_review_*, project_investments, projects, portfolios
//   • funders, financial_proxies, proxy_sources, fx_rates (org-scoped),
//     invitations, organization_members, stella_interactions
//   • audit_logs de esas organizaciones (con el disparador append-only
//     desactivado temporalmente dentro de la transacción)
//   • las propias organizations
//
// QUÉ NO TOCA:
//   • Ninguna organización cuyo slug no case con los patrones de prueba.
//   • Usuarios de auth (los borra la propia suite mediante la API de Supabase).
//   • Catálogos globales: taxonomy_catalogs, taxonomy_codes, ni los proxies
//     financieros de sistema (organization_id IS NULL).
//   • marketing_leads.

import 'dotenv/config'
import postgres from 'postgres'
import { assertLocalDatabase } from '../db/guard'

/** Sólo se consideran de prueba las organizaciones con estos prefijos. */
const TEST_SLUG_PATTERNS = [
  'test-org-%',
  'rls-test-org-%',
  'other-org-%',
  'org-a-%',
  'org-b-%',
]

/** Tablas org-scoped, en orden inverso de dependencia. */
const ORG_SCOPED_TABLES = [
  'sroi_run_review_items',
  'sroi_run_reviews',
  'sroi_calculation_line_items',
  'sroi_calculation_runs',
  'sroi_report_sections',
  'sroi_reports',
  'sroi_filter_sets',
  'sroi_assignment_inputs',
  'outcome_proxy_assignments',
  'outcome_funder_allocations',
  'outcome_taxonomy_mappings',
  'methodology_review_matrix_items',
  'methodology_review_matrix',
  'theory_of_change_links',
  'theory_of_change_nodes',
  'evidence_items',
  'indicators',
  'outcomes',
  'stakeholder_groups',
  'impact_narratives',
  'project_investments',
  'projects',
  'portfolios',
  'funders',
  'financial_proxies',
  'proxy_sources',
  'fx_rates',
  'invitations',
  'organization_members',
  'stella_interactions',
]

const confirm = process.argv.includes('--confirm')

async function main() {
  assertLocalDatabase({ context: 'pnpm db:clean:test-data' })

  const sql = postgres(process.env.DATABASE_URL as string, { max: 1, onnotice: () => {} })

  try {
    const orgs = await sql<{ id: string; slug: string; name: string }[]>`
      select id, slug, name from organizations
      where ${sql.unsafe(
        TEST_SLUG_PATTERNS.map((p) => `slug like '${p}'`).join(' or '),
      )}
      order by slug`

    if (orgs.length === 0) {
      console.log('\nNo hay organizaciones de prueba que limpiar.\n')
      return
    }

    const ids = orgs.map((o) => o.id)

    console.log(`\nOrganizaciones de prueba identificadas: ${orgs.length}`)
    for (const org of orgs.slice(0, 10)) console.log(`  • ${org.slug}`)
    if (orgs.length > 10) console.log(`  … y ${orgs.length - 10} más`)

    const [{ n: auditRows }] = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_logs where organization_id = any(${ids})`
    const [{ n: projectRows }] = await sql<{ n: number }[]>`
      select count(*)::int as n from projects where organization_id = any(${ids})`

    console.log(`\n  proyectos asociados     : ${projectRows}`)
    console.log(`  entradas de auditoría   : ${auditRows}`)

    if (!confirm) {
      console.log('\nSIMULACRO — no se ha borrado nada.')
      console.log('Para ejecutar el borrado: pnpm db:clean:test-data --confirm\n')
      return
    }

    // Objetos de Storage: fuera de la transacción, porque viven en el
    // almacenamiento de objetos y no participan del rollback de Postgres.
    const projectIds = await sql<{ id: string }[]>`
      select id from projects where organization_id = any(${ids})`
    let storageDeleted = 0
    if (projectIds.length > 0) {
      const result = await sql`
        delete from storage.objects
        where bucket_id = 'uellix-evidence'
          and split_part(name, '/', 1) = any(${projectIds.map((p) => p.id)})
        returning 1`
      storageDeleted = result.length
    }

    // Cómo se scopea cada tabla. No todas cuelgan de `organization_id`:
    // outcomes, indicators, stakeholder_groups e impact_narratives sólo tienen
    // `project_id`. Se resuelve consultando el catálogo en vez de codificarlo,
    // para que añadir una tabla al esquema no rompa este script en silencio.
    const scoping = await sql<{ table_name: string; has_org: boolean; has_project: boolean }[]>`
      select t.table_name,
             bool_or(c.column_name = 'organization_id') as has_org,
             bool_or(c.column_name = 'project_id') as has_project
      from information_schema.tables t
      join information_schema.columns c
        on c.table_schema = t.table_schema and c.table_name = t.table_name
      where t.table_schema = 'public' and t.table_name = any(${ORG_SCOPED_TABLES})
      group by t.table_name`
    const scopeByTable = new Map(scoping.map((s) => [s.table_name, s]))

    let totalRows = 0
    await sql.begin(async (tx) => {
      for (const table of ORG_SCOPED_TABLES) {
        const scope = scopeByTable.get(table)
        if (!scope) {
          console.warn(`  ! ${table} no existe en el esquema — se omite`)
          continue
        }

        let result: unknown[]
        if (scope.has_org) {
          result = await tx.unsafe(
            `delete from ${table} where organization_id = any($1) returning 1`,
            [ids],
          )
        } else if (scope.has_project) {
          result = await tx.unsafe(
            `delete from ${table} where project_id in (
               select id from projects where organization_id = any($1)
             ) returning 1`,
            [ids],
          )
        } else {
          throw new Error(
            `${table} no tiene ni organization_id ni project_id: no se puede acotar el borrado con seguridad`,
          )
        }
        totalRows += result.length
      }

      // audit_logs es append-only por disparador. Se desactiva SÓLO aquí,
      // dentro de la transacción, y se reactiva siempre — incluso si el borrado
      // falla, el ROLLBACK deja el disparador como estaba.
      await tx.unsafe('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only')
      try {
        const result = await tx.unsafe(
          'delete from audit_logs where organization_id = any($1) returning 1',
          [ids],
        )
        totalRows += result.length
      } finally {
        await tx.unsafe('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only')
      }

      const deletedOrgs = await tx.unsafe(
        'delete from organizations where id = any($1) returning 1',
        [ids],
      )
      totalRows += deletedOrgs.length
    })

    console.log(`\n✓ Eliminadas ${orgs.length} organizaciones de prueba`)
    console.log(`  filas de negocio y auditoría : ${totalRows}`)
    console.log(`  objetos de Storage           : ${storageDeleted}`)

    const [{ n: remaining }] = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_logs where organization_id = any(${ids})`
    if (remaining !== 0) {
      throw new Error(`Quedaron ${remaining} entradas de auditoría sin borrar`)
    }

    // Comprobación de que el disparador quedó activo.
    const [{ n: trigger }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_trigger
      where tgname = 'trg_audit_logs_append_only' and tgenabled = 'O'`
    if (trigger !== 1) {
      throw new Error(
        'El disparador append-only de audit_logs NO quedó activo. Reactívalo con: ' +
          'ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only',
      )
    }
    console.log('  disparador append-only       : reactivado y verificado\n')
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error('\n✗ Falló la limpieza de datos de prueba:')
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

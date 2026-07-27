// scripts/bootstrap-local.ts
//
// F0-04 + F2-02 — Procedimiento único y reproducible para dejar un stack local
// completo y verificado. Sustituye a la secuencia manual que documentaba el
// README (aplicar `db/policies/*.sql` a mano en el editor SQL de Supabase),
// que además degradaba la seguridad (ver AUDITORIA §8, SEC-02).
//
// Por qué no se invoca `drizzle-kit migrate`
// ------------------------------------------
// `drizzle-kit migrate` **se traga el error de Postgres** y sale con código 1
// sin imprimir nada. Ése fue el motivo de que el fallo original (34 de 41
// migraciones aplicadas) resultara indiagnosticable durante la auditoría.
// Aquí se usa el migrador de `drizzle-orm`, que propaga el error real con su
// código SQLSTATE, la sentencia y el detalle.
//
// Diagnóstico registrado (F0-04): el fallo NO era Node 24. Se reprodujo con el
// mismo Node v24.16.0 sobre una base limpia y las migraciones se aplicaron sin
// error. La causa era el estado del `drizzle.__drizzle_migrations` de una base
// preexistente, cuyo último `created_at` no correspondía a la entrada esperada
// del journal, de modo que el conjunto pendiente empezaba antes de lo previsto.
//
// Idempotente: puede ejecutarse dos veces seguidas sin romper nada.

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { assertLocalDatabase } from '../db/guard'

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'db/migrations')
const ENV_OUT = path.resolve(process.cwd(), '.env.test.local')

/** Nº de entradas del journal: 41 históricas + 0041_bootstrap_closure. */
const EXPECTED_MIGRATIONS = readJournalCount()
/** Tablas de negocio esperadas en `public` tras la cadena completa. */
const EXPECTED_PUBLIC_TABLES = 37

function readJournalCount(): number {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: unknown[] }
  return journal.entries.length
}

// ── Utilidades de salida ────────────────────────────────────────────────────

const step = (n: number, total: number, text: string) =>
  console.log(`\n[${n}/${total}] ${text}`)
const ok = (text: string) => console.log(`   ✓ ${text}`)
const info = (text: string) => console.log(`     ${text}`)

class BootstrapError extends Error {
  constructor(problem: string, remedy: string) {
    super(`${problem}\n\n  Cómo resolverlo:\n    ${remedy}\n`)
    this.name = 'BootstrapError'
  }
}

// ── Supabase local ──────────────────────────────────────────────────────────

/**
 * Invoca la CLI de Supabase.
 *
 * Se usa `execSync` con una cadena única en lugar de `execFileSync`: en Windows
 * `pnpm` es un `.cmd`, y desde Node 20.12 spawnear un `.cmd` sin shell falla
 * con EINVAL (endurecimiento por CVE-2024-27980). Todos los argumentos de este
 * módulo son literales estáticos —ninguno procede de entrada de usuario—, así
 * que la concatenación no introduce riesgo de inyección.
 */
function runSupabase(args: string[]): string {
  return execSync(['pnpm', 'supabase', ...args].join(' '), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function isSupabaseRunning(): boolean {
  try {
    runSupabase(['status'])
    return true
  } catch {
    return false
  }
}

/** Lee la configuración del stack local. Nunca imprime claves. */
function readSupabaseEnv(): Record<string, string> {
  const raw = runSupabase([
    'status',
    '-o',
    'env',
    '--override-name',
    'api.url=NEXT_PUBLIC_SUPABASE_URL',
    '--override-name',
    'auth.anon_key=NEXT_PUBLIC_SUPABASE_ANON_KEY',
    '--override-name',
    'auth.service_role_key=SUPABASE_SERVICE_ROLE_KEY',
    '--override-name',
    'db.url=DATABASE_URL',
  ])

  const env: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/)
    if (match) env[match[1]] = match[2]
  }

  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'DATABASE_URL',
  ]
  const missing = required.filter((k) => !env[k])
  if (missing.length > 0) {
    throw new BootstrapError(
      `No se pudo leer la configuración del stack local: faltan ${missing.join(', ')}.`,
      'Ejecuta `pnpm supabase stop` y vuelve a lanzar `pnpm db:bootstrap:local`.',
    )
  }

  return env
}

// ── Verificación de invariantes ─────────────────────────────────────────────

interface Check {
  name: string
  /** Devuelve null si pasa, o el motivo del fallo. */
  run: (sql: postgres.Sql) => Promise<string | null>
  remedy: string
}

const CHECKS: Check[] = [
  {
    name: `${EXPECTED_MIGRATIONS} migraciones registradas`,
    run: async (sql) => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from drizzle.__drizzle_migrations`
      return row.n === EXPECTED_MIGRATIONS
        ? null
        : `hay ${row.n}, se esperaban ${EXPECTED_MIGRATIONS}`
    },
    remedy: 'Reinicia desde cero: `pnpm db:reset:local`.',
  },
  {
    name: `${EXPECTED_PUBLIC_TABLES} tablas en public`,
    run: async (sql) => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`
      return row.n === EXPECTED_PUBLIC_TABLES
        ? null
        : `hay ${row.n}, se esperaban ${EXPECTED_PUBLIC_TABLES}`
    },
    remedy: 'Reinicia desde cero: `pnpm db:reset:local`.',
  },
  {
    name: 'helpers de RLS en el esquema private',
    run: async (sql) => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname like 'current_user_%'`
      return row.n === 3 ? null : `hay ${row.n} de 3`
    },
    remedy: 'Falta 0031_rls_core.sql. Reinicia desde cero: `pnpm db:reset:local`.',
  },
  {
    name: 'sin helpers duplicados en public (SEC-02)',
    run: async (sql) => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'current_user_%'`
      return row.n === 0
        ? null
        : `hay ${row.n} copias en public; PostgREST las auto-expone como RPC`
    },
    remedy:
      'Alguien ejecutó db/policies/001_initial_auth_rls.sql a mano. Ese fichero está superado por 0031_rls_core.sql. Reinicia desde cero: `pnpm db:reset:local`.',
  },
  {
    name: 'helpers de Storage con permiso para authenticated (SEC-03)',
    run: async (sql) => {
      const [row] = await sql<{ r: boolean | null; w: boolean | null }[]>`
        select
          has_function_privilege('authenticated', 'public.can_read_evidence_object(text,uuid)', 'EXECUTE') as r,
          has_function_privilege('authenticated', 'public.can_write_evidence_object(text,uuid)', 'EXECUTE') as w`
      if (row.r && row.w) return null
      return `read=${row.r} write=${row.w}: la subida y lectura de evidencia está rota`
    },
    remedy:
      'Se reaplicó 0033_public_api_grants.sql sin volver a conceder los permisos. Vuelve a ejecutar `pnpm db:bootstrap:local`, que aplica 0041_bootstrap_closure.sql.',
  },
  {
    name: 'anon sin EXECUTE sobre los helpers de Storage',
    run: async (sql) => {
      const [row] = await sql<{ r: boolean | null; w: boolean | null }[]>`
        select
          has_function_privilege('anon', 'public.can_read_evidence_object(text,uuid)', 'EXECUTE') as r,
          has_function_privilege('anon', 'public.can_write_evidence_object(text,uuid)', 'EXECUTE') as w`
      return !row.r && !row.w ? null : `read=${row.r} write=${row.w}`
    },
    remedy: 'Revisa 0041_bootstrap_closure.sql: debe revocar anon antes de conceder a authenticated.',
  },
  {
    name: 'anon sin EXECUTE sobre ninguna función de public',
    run: async (sql) => {
      const rows = await sql<{ proname: string }[]>`
        select p.proname from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prokind = 'f'
          and has_function_privilege('anon', p.oid, 'EXECUTE')`
      return rows.length === 0
        ? null
        : `anon puede ejecutar: ${rows.map((r) => r.proname).join(', ')}`
    },
    remedy:
      'PostgREST expone las funciones de public como /rest/v1/rpc/*. Muévelas al esquema private o revoca EXECUTE de anon.',
  },
  {
    name: 'RLS activa en marketing_leads (PII)',
    run: async (sql) => {
      const [row] = await sql<{ rls: boolean; policies: number }[]>`
        select c.relrowsecurity as rls,
               (select count(*)::int from pg_policies where tablename = 'marketing_leads') as policies
        from pg_class c where c.relname = 'marketing_leads'`
      if (!row) return 'la tabla marketing_leads no existe'
      if (!row.rls) return 'RLS desactivada'
      if (row.policies < 3) return `sólo ${row.policies} políticas de 3`
      return null
    },
    remedy: 'Falta 0041_bootstrap_closure.sql. Vuelve a ejecutar `pnpm db:bootstrap:local`.',
  },
  {
    name: 'bucket uellix-evidence privado',
    run: async (sql) => {
      const [row] = await sql<{ public: boolean }[]>`
        select public from storage.buckets where id = 'uellix-evidence'`
      if (!row) return 'el bucket no existe'
      return row.public ? 'el bucket es PÚBLICO' : null
    },
    remedy:
      'Falta supabase/migrations/20260723_create_evidence_bucket.sql. Reinicia: `pnpm db:reset:local`.',
  },
  {
    name: 'políticas de storage.objects presentes',
    run: async (sql) => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_policies where schemaname = 'storage'`
      return row.n >= 3 ? null : `hay ${row.n}, se esperaban al menos 3`
    },
    remedy:
      'Falta supabase/migrations/20260716000001_storage_policies.sql. Reinicia: `pnpm db:reset:local`.',
  },
  {
    name: 'disparadores append-only activos',
    run: async (sql) => {
      const rows = await sql<{ tgname: string }[]>`
        select tgname from pg_trigger
        where tgname in (
          'trg_audit_logs_append_only',
          'trg_sroi_runs_append_only',
          'trg_sroi_line_items_append_only'
        )`
      return rows.length === 3 ? null : `hay ${rows.length} de 3`
    },
    remedy: 'Falta 0030_immutability.sql. Reinicia desde cero: `pnpm db:reset:local`.',
  },
]

// ── Programa principal ──────────────────────────────────────────────────────

async function main() {
  const TOTAL = 5
  console.log('\n══ Bootstrap del stack local de Uellix ══')

  // 1 — Supabase local
  step(1, TOTAL, 'Levantando Supabase local')
  if (isSupabaseRunning()) {
    ok('ya estaba en ejecución')
  } else {
    info('arrancando contenedores (puede tardar en la primera ejecución)...')
    try {
      runSupabase(['start'])
    } catch (error) {
      throw new BootstrapError(
        `No se pudo arrancar Supabase: ${(error as Error).message.split('\n')[0]}`,
        '¿Está Docker en ejecución? Compruébalo con `docker version`.',
      )
    }
    ok('arrancado')
  }

  const env = readSupabaseEnv()

  // 2 — Guarda de host (F0-05). Antes de abrir ninguna conexión.
  step(2, TOTAL, 'Verificando que el destino es local')
  assertLocalDatabase({
    context: 'pnpm db:bootstrap:local',
    targets: [
      { label: 'PostgreSQL', envVar: 'DATABASE_URL (supabase status)', value: env.DATABASE_URL },
      {
        label: 'API de Supabase',
        envVar: 'NEXT_PUBLIC_SUPABASE_URL (supabase status)',
        value: env.NEXT_PUBLIC_SUPABASE_URL,
      },
    ],
    env: {},
  })
  ok('ambos destinos son de loopback')

  const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} })

  try {
    // 3 — Migraciones. `supabase start` ya aplicó supabase/migrations/*
    //     (auth trigger, políticas de Storage, bucket) ANTES que esta cadena,
    //     que es el orden que 0039 necesita.
    step(3, TOTAL, 'Aplicando migraciones de Drizzle')
    const before = await countMigrations(sql)
    try {
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER })
    } catch (error) {
      const pg = error as { message?: string; code?: string; detail?: string; hint?: string }
      throw new BootstrapError(
        [
          'Falló la aplicación de migraciones.',
          `    mensaje : ${pg.message ?? String(error)}`,
          pg.code ? `    sqlstate: ${pg.code}` : '',
          pg.detail ? `    detalle : ${pg.detail}` : '',
          pg.hint ? `    pista   : ${pg.hint}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        'Si la base quedó a medias, reinicia desde cero con `pnpm db:reset:local`.',
      )
    }
    const after = await countMigrations(sql)
    ok(
      before === after
        ? `sin cambios: ya estaban las ${after} migraciones (ejecución idempotente)`
        : `aplicadas ${after - before} migraciones (${before} → ${after})`,
    )

    // 3b — Reparación de los permisos dependientes del orden (F2-02).
    //
    // 0041 es idempotente y se reaplica SIEMPRE, al margen del registro de
    // migraciones. Motivo: el registro impide que 0041 vuelva a ejecutarse,
    // pero el escenario que rompe los permisos —reaplicar 0033 durante una
    // restauración de backup o un despliegue idempotente— sí puede repetirse.
    // Sin este paso el bootstrap detectaría el problema pero no lo arreglaría.
    const closure = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, '0041_bootstrap_closure.sql'),
      'utf8',
    )
    await sql.unsafe(closure)
    ok('permisos de Storage y RLS de marketing_leads reafirmados (idempotente)')

    // 4 — Invariantes
    step(4, TOTAL, 'Verificando invariantes del esquema y de los permisos')
    const failures: string[] = []
    for (const check of CHECKS) {
      const problem = await check.run(sql)
      if (problem === null) {
        ok(check.name)
      } else {
        console.error(`   ✗ ${check.name}: ${problem}`)
        failures.push(`  • ${check.name}: ${problem}\n    → ${check.remedy}`)
      }
    }
    if (failures.length > 0) {
      throw new BootstrapError(
        `${failures.length} invariante(s) no se cumplen:\n\n${failures.join('\n\n')}`,
        'Corrige lo anterior y vuelve a ejecutar `pnpm db:bootstrap:local`.',
      )
    }

    // 5 — Configuración para las pruebas de integración
    step(5, TOTAL, 'Escribiendo .env.test.local')
    writeTestEnv(env)
    ok(`${path.basename(ENV_OUT)} actualizado (ignorado por git)`)

    console.log('\n══ Stack local listo ══')
    console.log('  pnpm test:integration    ejecuta la suite de integración/RLS')
    console.log('  pnpm db:seed:local       crea organizaciones y usuarios de prueba')
    console.log('  pnpm dev                 arranca la aplicación\n')
  } finally {
    await sql.end()
  }
}

async function countMigrations(sql: postgres.Sql): Promise<number> {
  // La existencia se comprueba en una consulta APARTE: Postgres resuelve las
  // relaciones en tiempo de PARSEO, así que un `where to_regclass(...) is not
  // null` en la misma sentencia no evita el error 42P01 sobre una base limpia,
  // donde el esquema `drizzle` todavía no existe.
  const [exists] = await sql<{ present: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as present`
  if (!exists?.present) return 0

  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from drizzle.__drizzle_migrations`
  return row?.n ?? 0
}

function writeTestEnv(env: Record<string, string>) {
  const body = [
    '# Generado por `pnpm db:bootstrap:local`. NO editar a mano.',
    '# Contiene únicamente credenciales del stack LOCAL de Supabase, que son',
    '# idénticas en cualquier máquina y no dan acceso a ningún dato real.',
    '# Ignorado por git (.gitignore: .env*).',
    '',
    `NEXT_PUBLIC_SUPABASE_URL=${env.NEXT_PUBLIC_SUPABASE_URL}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
    `SUPABASE_SERVICE_ROLE_KEY=${env.SUPABASE_SERVICE_ROLE_KEY}`,
    `DATABASE_URL=${env.DATABASE_URL}`,
    '',
  ].join('\n')
  fs.writeFileSync(ENV_OUT, body, { encoding: 'utf8' })
}

main().catch((error) => {
  if (error instanceof BootstrapError) {
    console.error(`\n✗ ${error.message}`)
  } else {
    console.error('\n✗ Error inesperado durante el bootstrap:')
    console.error(error)
  }
  process.exit(1)
})

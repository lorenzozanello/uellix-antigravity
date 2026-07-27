// db/guard.ts
//
// Guarda de host para todo proceso fuera de la aplicación (seeds, scripts de
// mantenimiento, pruebas de integración) que abre una conexión a la base de
// datos o al API de Supabase.
//
// Motivo (F0-05, hallazgo OPS-01 de AUDITORIA_ESTADO_ACTUAL.md §14.3):
// `scripts/seed-proxies.ts`, `scripts/seed-taxonomies.ts` y
// `vitest.setup.integration.ts` resuelven su conexión desde `.env` / `.env.local`,
// que apuntan al proyecto Supabase remoto. Exportar variables en la shell NO
// basta, porque `import 'dotenv/config'` carga `.env` por su cuenta. Durante la
// auditoría del 2026-07-24 esto provocó una escritura accidental en producción,
// y `tests/integration/rls.test.ts` es peor todavía: crea organizaciones,
// proyectos, usuarios y objetos de Storage.
//
// Reglas de esta guarda:
//   1. Nunca imprime la URL completa, ni usuario, contraseña, token o puerto.
//      Sólo el hostname, que es lo único necesario para decidir y diagnosticar.
//   2. Aborta el proceso (exit 1) cuando el host no es de loopback.
//   3. La única forma de permitir un host remoto es una variable de entorno con
//      un valor largo y explícito (ver ALLOW_REMOTE_TOKEN). No es un booleano ni
//      un `--force`: no se activa por accidente ni por copiar y pegar un comando.
//
// La aplicación Next.js NO usa esta guarda: en producción debe conectarse al
// host remoto. La guarda protege únicamente los puntos de entrada ejecutables.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1'])

/**
 * Mapa de entorno mínimo. Deliberadamente NO es `NodeJS.ProcessEnv`: Next.js
 * augmenta ese tipo con campos obligatorios (`NODE_ENV`), lo que obligaría a
 * cada prueba a construir un entorno completo sólo para verificar una variable.
 * `process.env` es asignable a este tipo.
 */
export type EnvLike = Record<string, string | undefined>

/** Nombre de la variable de escape y valor exacto que debe tomar. */
export const ALLOW_REMOTE_ENV = 'UELLIX_ALLOW_REMOTE_DB'
export const ALLOW_REMOTE_TOKEN = 'YES-I-INTEND-TO-WRITE-TO-A-REMOTE-DATABASE'

export interface ConnectionTarget {
  /** Etiqueta legible: se muestra en los mensajes. Nunca un secreto. */
  label: string
  /** Nombre de la variable de entorno de la que se leyó. Nunca su valor. */
  envVar: string
  /** La URL a inspeccionar. NUNCA se imprime. */
  value: string | undefined
}

export class RemoteDatabaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteDatabaseError'
  }
}

/**
 * Extrae el hostname de una URL sin exponer ninguna otra parte.
 *
 * NO se delega en `new URL()` como fuente primaria. Una contraseña de Postgres
 * con `@` y `/` sin escapar (frecuente y perfectamente válida) hace que el
 * parser WHATWG devuelva un host EQUIVOCADO en lugar de fallar: para
 * `postgresql://user:p@ss:w/ord@db.remoto.example/postgres` devuelve `ss`.
 * Un host mal extraído que casualmente fuese `localhost` haría pasar una
 * conexión remota, así que aquí se usa extracción posicional y se contrasta.
 *
 * Algoritmo:
 *   1. Quitar esquema, query y fragmento.
 *   2. Tomar todo lo posterior al ÚLTIMO `@` (el userinfo queda descartado
 *      completo, contenga los `@` que contenga).
 *   3. Recortar en el primer `/` y quitar el puerto.
 *   4. Contrastar con `new URL()` cuando éste sepa parsear la cadena. Si ambos
 *      métodos discrepan, la URL es ambigua y se devuelve `null` —
 *      **fallo cerrado**: quien llama lo tratará como host no permitido.
 *
 * Devuelve `null` cuando no hay host determinable con certeza.
 */
export function extractHostname(rawUrl: string): string | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  const positional = extractHostnamePositional(trimmed)
  if (!positional) return null

  // Contraste: si el parser estándar acepta la cadena y coincide, hay acuerdo.
  // Si no coincide, la cadena es ambigua y no se afirma ningún host.
  let parsed: string | null = null
  try {
    const host = new URL(trimmed).hostname
    parsed = host ? normalizeHost(host) : null
  } catch {
    parsed = null // El parser no la acepta; nos quedamos con la posicional.
  }

  if (parsed !== null && parsed !== positional) return null

  return positional
}

function extractHostnamePositional(url: string): string | null {
  const withoutScheme = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')

  // Query y fragmento pueden contener `@` y falsear el "último @".
  const withoutQuery = withoutScheme.split(/[?#]/)[0]

  // Todo lo anterior al último `@` es userinfo, sin importar su contenido.
  const afterUserInfo = withoutQuery.slice(withoutQuery.lastIndexOf('@') + 1)
  const hostPort = afterUserInfo.split('/')[0]
  if (!hostPort) return null

  // IPv6 entre corchetes: [::1]:5432
  const bracketed = hostPort.match(/^\[([^\]]+)\]/)
  if (bracketed) return normalizeHost(bracketed[1])

  const host = hostPort.split(':')[0]
  return host ? normalizeHost(host) : null
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '')
}

/** ¿El host es de loopback? */
export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false
  return LOOPBACK_HOSTS.has(normalizeHost(host))
}

/** ¿Está activo el mecanismo de escape explícito? */
export function isRemoteExplicitlyAllowed(
  env: EnvLike = process.env,
): boolean {
  return env[ALLOW_REMOTE_ENV] === ALLOW_REMOTE_TOKEN
}

function buildFailureMessage(target: ConnectionTarget, host: string | null): string {
  const shown = host ?? '(host indeterminable)'
  return [
    '',
    '════════════════════════════════════════════════════════════════',
    '  ABORTADO: guarda de host de base de datos (F0-05)',
    '════════════════════════════════════════════════════════════════',
    `  Destino    : ${target.label}`,
    `  Variable   : ${target.envVar}`,
    `  Hostname   : ${shown}`,
    '',
    '  Este proceso escribe datos y sólo puede ejecutarse contra un',
    '  stack local. El host resuelto no es de loopback.',
    '',
    '  Causa habitual: los scripts hacen `import \'dotenv/config\'`, que',
    '  carga `.env` — no `.env.local` ni las variables que exportaste en',
    '  la shell. Comprueba de dónde procede realmente la conexión.',
    '',
    '  Para trabajar en local:',
    '    pnpm db:bootstrap:local',
    '',
    '  Ese comando levanta Supabase, aplica las migraciones y escribe la',
    '  configuración local en .env.test.local. No se muestran cadenas de',
    '  conexión aquí a propósito: esta guarda nunca imprime credenciales,',
    '  ni siquiera las de ejemplo.',
    '',
    `  Hosts permitidos: ${[...LOOPBACK_HOSTS].join(', ')}`,
    '════════════════════════════════════════════════════════════════',
    '',
  ].join('\n')
}

/**
 * Valida una lista de destinos. Lanza `RemoteDatabaseError` en el primero que
 * no sea local. No imprime nada: quien llama decide cómo reportar.
 *
 * Se exporta por separado de `assertLocalDatabase` para poder probarla sin
 * matar el proceso de pruebas.
 */
export function checkLocalTargets(
  targets: ConnectionTarget[],
  env: EnvLike = process.env,
): void {
  if (isRemoteExplicitlyAllowed(env)) return

  for (const target of targets) {
    if (target.value === undefined || target.value.trim() === '') {
      throw new RemoteDatabaseError(
        buildFailureMessage(target, null).replace(
          '(host indeterminable)',
          '(variable ausente o vacía)',
        ),
      )
    }

    const host = extractHostname(target.value)
    if (!isLoopbackHost(host)) {
      throw new RemoteDatabaseError(buildFailureMessage(target, host))
    }
  }
}

/**
 * Punto de entrada para scripts. Valida y, si algo falla, imprime el motivo y
 * termina el proceso con código 1.
 *
 * Por defecto valida `DATABASE_URL` y, cuando existe, `NEXT_PUBLIC_SUPABASE_URL`
 * — las pruebas de integración escriben por ambos caminos (Drizzle directo y
 * API de Supabase), así que comprobar sólo uno dejaría el otro abierto.
 */
export function assertLocalDatabase(options: {
  /** Para el mensaje: qué se estaba a punto de ejecutar. */
  context: string
  /** Destinos adicionales o sustitutos de los predeterminados. */
  targets?: ConnectionTarget[]
  env?: EnvLike
} ): void {
  const env = options.env ?? process.env
  const targets = options.targets ?? defaultTargets(env)

  try {
    checkLocalTargets(targets, env)
  } catch (error) {
    if (error instanceof RemoteDatabaseError) {
      console.error(error.message)
      console.error(`  Contexto: ${options.context}\n`)
      process.exit(1)
    }
    throw error
  }

  if (isRemoteExplicitlyAllowed(env)) {
    console.warn(
      `[guard] ${ALLOW_REMOTE_ENV} está activo: la guarda de host NO se aplicó ` +
        `a "${options.context}". Esto permite escribir en una base remota.`,
    )
  }
}

/** Destinos que se validan cuando quien llama no especifica otra cosa. */
export function defaultTargets(env: EnvLike = process.env): ConnectionTarget[] {
  const targets: ConnectionTarget[] = [
    { label: 'PostgreSQL (Drizzle)', envVar: 'DATABASE_URL', value: env.DATABASE_URL },
  ]

  if (env.NEXT_PUBLIC_SUPABASE_URL !== undefined) {
    targets.push({
      label: 'API de Supabase',
      envVar: 'NEXT_PUBLIC_SUPABASE_URL',
      value: env.NEXT_PUBLIC_SUPABASE_URL,
    })
  }

  return targets
}

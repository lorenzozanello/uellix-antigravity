// tests/db-guard.test.ts
//
// F0-05 — Pruebas de la guarda de host. El criterio de aceptación exige
// demostrar que una URL remota es rechazada y que la salida no expone secretos.

import { describe, it, expect } from 'vitest'
import {
  ALLOW_REMOTE_ENV,
  ALLOW_REMOTE_TOKEN,
  RemoteDatabaseError,
  checkLocalTargets,
  defaultTargets,
  extractHostname,
  isLoopbackHost,
  isRemoteExplicitlyAllowed,
  type ConnectionTarget,
} from '../db/guard'

// Credenciales ficticias, inventadas para esta prueba. No corresponden a
// ningún entorno real de Uellix.
const REMOTE_PG = 'postgresql://postgres:s3cr3t-p4ssw0rd@db.ejemplo-remoto.supabase.co:5432/postgres'
const REMOTE_API = 'https://ejemplo-remoto.supabase.co'
const LOCAL_PG = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'
const LOCAL_API = 'http://127.0.0.1:55321'

const target = (value: string | undefined, label = 'PostgreSQL'): ConnectionTarget => ({
  label,
  envVar: 'DATABASE_URL',
  value,
})

describe('extractHostname', () => {
  it('extrae el host de una cadena de Postgres', () => {
    expect(extractHostname(REMOTE_PG)).toBe('db.ejemplo-remoto.supabase.co')
    expect(extractHostname(LOCAL_PG)).toBe('127.0.0.1')
  })

  it('extrae el host de una URL https', () => {
    expect(extractHostname(REMOTE_API)).toBe('ejemplo-remoto.supabase.co')
    expect(extractHostname(LOCAL_API)).toBe('127.0.0.1')
  })

  it('resuelve el host aunque la contraseña contenga @ y / sin escapar', () => {
    // `new URL()` devuelve 'ss' para esta cadena: descarta el userinfo por el
    // PRIMER `@` en vez de por el último. La extracción posicional acierta.
    const gnarly = 'postgresql://postgres:p@ss:w/ord@db.ejemplo-remoto.supabase.co:5432/postgres'
    expect(extractHostname(gnarly)).toBe('db.ejemplo-remoto.supabase.co')
  })

  it('ignora los @ que aparecen en la query', () => {
    const withQuery = 'postgresql://user:pw@db.ejemplo-remoto.supabase.co:5432/postgres?opts=a@b'
    expect(extractHostname(withQuery)).toBe('db.ejemplo-remoto.supabase.co')
  })

  it('devuelve null (falla cerrada) cuando la URL es ambigua', () => {
    // Si los dos métodos de extracción discrepan no se afirma ningún host.
    // Regresión de seguridad: un host mal extraído que fuese `localhost`
    // habría hecho pasar una conexión remota.
    const ambiguous = 'postgresql://user:pw@localhost/x@db.ejemplo-remoto.supabase.co/postgres'
    const host = extractHostname(ambiguous)
    expect(isLoopbackHost(host)).toBe(false)
  })

  it('soporta IPv6 entre corchetes', () => {
    expect(extractHostname('postgresql://user:pw@[::1]:5432/postgres')).toBe('::1')
  })

  it('devuelve null cuando no hay host determinable', () => {
    expect(extractHostname('')).toBeNull()
    expect(extractHostname('   ')).toBeNull()
  })
})

describe('isLoopbackHost', () => {
  it('acepta las formas de loopback', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
  })

  it('rechaza hosts remotos', () => {
    for (const host of ['db.ejemplo-remoto.supabase.co', '10.0.0.5', 'ejemplo.com', null]) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })

  it('rechaza hosts que sólo CONTIENEN una forma de loopback', () => {
    // Regresión: la guarda ad-hoc anterior de create-test-user.ts usaba
    // `includes()` como respaldo y estos hosts la superaban.
    for (const host of ['localhost.atacante.com', 'no-127.0.0.1.ejemplo.com', 'mi-localhost']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('checkLocalTargets', () => {
  it('acepta destinos de loopback', () => {
    expect(() =>
      checkLocalTargets([target(LOCAL_PG), target(LOCAL_API, 'API de Supabase')], {}),
    ).not.toThrow()
  })

  it('RECHAZA una cadena de Postgres remota', () => {
    expect(() => checkLocalTargets([target(REMOTE_PG)], {})).toThrow(RemoteDatabaseError)
  })

  it('RECHAZA una URL de API remota', () => {
    expect(() => checkLocalTargets([target(REMOTE_API, 'API de Supabase')], {})).toThrow(
      RemoteDatabaseError,
    )
  })

  it('RECHAZA si cualquiera de los destinos es remoto, aunque el resto sea local', () => {
    expect(() =>
      checkLocalTargets([target(LOCAL_PG), target(REMOTE_API, 'API de Supabase')], {}),
    ).toThrow(RemoteDatabaseError)
  })

  it('RECHAZA cuando la variable está ausente o vacía', () => {
    expect(() => checkLocalTargets([target(undefined)], {})).toThrow(RemoteDatabaseError)
    expect(() => checkLocalTargets([target('')], {})).toThrow(RemoteDatabaseError)
    expect(() => checkLocalTargets([target('   ')], {})).toThrow(RemoteDatabaseError)
  })
})

describe('el mensaje de error no expone secretos', () => {
  function messageFor(value: string): string {
    try {
      checkLocalTargets([target(value)], {})
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('se esperaba que la guarda lanzara')
  }

  it('no contiene la contraseña, el usuario, el puerto ni la URL completa', () => {
    const message = messageFor(REMOTE_PG)

    expect(message).not.toContain('s3cr3t-p4ssw0rd')
    expect(message).not.toContain(REMOTE_PG)
    expect(message).not.toContain('postgres:s3cr3t')
    expect(message).not.toContain(':5432')
    expect(message).not.toMatch(/\/\/[^/\s]*:[^/\s]*@/) // ningún par usuario:contraseña@
  })

  it('sí contiene el hostname, que es lo necesario para diagnosticar', () => {
    expect(messageFor(REMOTE_PG)).toContain('db.ejemplo-remoto.supabase.co')
  })

  it('nombra la variable de entorno pero nunca su valor', () => {
    const message = messageFor(REMOTE_API)
    expect(message).toContain('DATABASE_URL')
    expect(message).not.toContain(REMOTE_API)
  })
})

describe('mecanismo de escape explícito', () => {
  it('está desactivado por defecto', () => {
    expect(isRemoteExplicitlyAllowed({})).toBe(false)
  })

  it('no se activa con valores de conveniencia', () => {
    for (const value of ['1', 'true', 'yes', 'TRUE', 'on', '']) {
      expect(isRemoteExplicitlyAllowed({ [ALLOW_REMOTE_ENV]: value })).toBe(false)
    }
  })

  it('sólo se activa con el token exacto', () => {
    expect(isRemoteExplicitlyAllowed({ [ALLOW_REMOTE_ENV]: ALLOW_REMOTE_TOKEN })).toBe(true)
  })

  it('cuando está activo, permite un destino remoto', () => {
    expect(() =>
      checkLocalTargets([target(REMOTE_PG)], { [ALLOW_REMOTE_ENV]: ALLOW_REMOTE_TOKEN }),
    ).not.toThrow()
  })

  it('el token es largo y no se teclea por accidente', () => {
    expect(ALLOW_REMOTE_TOKEN.length).toBeGreaterThan(30)
    expect(ALLOW_REMOTE_TOKEN).toMatch(/REMOTE/)
  })
})

describe('defaultTargets', () => {
  it('siempre valida DATABASE_URL', () => {
    const targets = defaultTargets({ DATABASE_URL: LOCAL_PG })
    expect(targets.map((t) => t.envVar)).toContain('DATABASE_URL')
  })

  it('valida también el API de Supabase cuando está definido', () => {
    const targets = defaultTargets({
      DATABASE_URL: LOCAL_PG,
      NEXT_PUBLIC_SUPABASE_URL: LOCAL_API,
    })
    expect(targets.map((t) => t.envVar)).toEqual([
      'DATABASE_URL',
      'NEXT_PUBLIC_SUPABASE_URL',
    ])
  })

  it('un DATABASE_URL local con un API remoto sigue siendo rechazado', () => {
    // Este es exactamente el escenario del incidente: la shell exportaba el
    // Postgres local mientras dotenv dejaba el API apuntando al proyecto remoto.
    const env = { DATABASE_URL: LOCAL_PG, NEXT_PUBLIC_SUPABASE_URL: REMOTE_API }
    expect(() => checkLocalTargets(defaultTargets(env), env)).toThrow(RemoteDatabaseError)
  })
})

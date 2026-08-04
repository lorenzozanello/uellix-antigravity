// tests/capability-baseline-artifact.test.ts
//
// El baseline como artefacto, no como efecto secundario.
//
// Hasta 2026-08-04 `scripts/capability-dry-run.sh` empezaba haciendo
// `pg_dumpall --roles-only` y `pg_dump --schema-only` contra el contenedor
// `supabase_db_uellix-stella-g2-local-rehearsal`, escribía el resultado en un
// `mktemp -d` y lo borraba en el trap de salida. El baseline nunca se commiteó,
// nunca se hasheó, y sólo existía mientras ese contenedor concreto estuviera
// vivo. Cuando se detuvo el stack, el ensayo entero quedó bloqueado.
//
// Estas pruebas fijan las tres propiedades que evitan que eso vuelva a pasar:
//
//   1. los artefactos existen y cuadran con el manifiesto;
//   2. no contienen datos ni secretos;
//   3. el dry-run los consume y NO puede volver a tocar el stack persistente.
//
// La verificación de que además *restauran* 38/107/10 es ejecutable y vive en
// `scripts/capability-baseline-verify.sh`: necesita Docker y no cabe en una
// suite unitaria. Aquí se comprueba que ese script existe y afirma esos números.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const BASE = path.resolve(process.cwd(), 'db', 'baseline')
const SCRIPTS = path.resolve(process.cwd(), 'scripts')

const ROLES = 'stella_g2_roles.sql'
const SCHEMA = 'stella_g2_schema.sql'
const POST = 'stella_g2_post_restore.sql'
const MANIFEST = 'MANIFEST.sha256'

const ARTIFACTS = [ROLES, SCHEMA, POST] as const

/** Se lee como buffer: el hash es de bytes, no de texto reinterpretado. */
const bytes = (f: string) => readFileSync(path.join(BASE, f))
const text = (f: string) => readFileSync(path.join(BASE, f), 'utf8')

describe('los artefactos de baseline existen y cuadran con el manifiesto', () => {
  it.each([...ARTIFACTS, MANIFEST])('%s está presente', (f) => {
    expect(existsSync(path.join(BASE, f))).toBe(true)
  })

  it('el manifiesto cubre exactamente los tres artefactos', () => {
    const listed = text(MANIFEST)
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.replace(/^\S+\s+\*?/, '').trim())
    expect(listed.sort()).toEqual([...ARTIFACTS].sort())
  })

  it.each(ARTIFACTS)('el SHA-256 de %s coincide con el manifiesto', (f) => {
    const line = text(MANIFEST)
      .split('\n')
      .find((l) => l.trim().endsWith(f))
    expect(line, `${f} no aparece en el manifiesto`).toBeDefined()
    const expected = line!.trim().split(/\s+/)[0]
    expect(createHash('sha256').update(bytes(f)).digest('hex')).toBe(expected)
  })

  it('el manifiesto usa rutas relativas', () => {
    // Una ruta absoluta ataría el manifiesto a la máquina que lo generó.
    expect(text(MANIFEST)).not.toMatch(/(^|\s)\*?([A-Za-z]:[\\/]|\/(c|home|Users)\/)/m)
  })
})

describe('determinismo — nada que cambie entre ejecuciones', () => {
  it.each(ARTIFACTS)('%s fija la clave de \\restrict en vez del nonce de pg_dump', (f) => {
    // psql 17.6 emite `\restrict <nonce aleatorio>`. Sin normalizar, cada
    // regeneración produciría un hash distinto sin que cambie una sola línea
    // de DDL. La clave fija conserva la protección contra inyección de
    // meta-comandos y hace el artefacto reproducible.
    const t = text(f)
    if (!t.includes('\\restrict')) return
    expect(t).toMatch(/^\\restrict uellix_baseline_g2$/m)
    expect(t).toMatch(/^\\unrestrict uellix_baseline_g2$/m)
  })

  it.each(ARTIFACTS)('%s no lleva rutas temporales ni nombres de contenedor', (f) => {
    const t = text(f)
    expect(t).not.toMatch(/\/tmp\/[A-Za-z0-9._-]{6,}/)
    expect(t).not.toMatch(/uellix_cap_baseline_(clone|src|verify|copy)/)
  })

  it.each(ARTIFACTS)('%s termina en LF, sin CR', (f) => {
    // .gitattributes fija eol=lf para que un checkout en Windows no reescriba
    // los bytes y rompa el manifiesto.
    expect(bytes(f).includes(0x0d)).toBe(false)
  })
})

describe('sin datos de tabla', () => {
  it.each(ARTIFACTS)('%s no contiene COPY ni su terminador', (f) => {
    const t = text(f)
    expect(t).not.toMatch(/^COPY /m)
    expect(t).not.toMatch(/^\\\.$/m)
  })

  it('el schema no tiene INSERT fuera de cuerpos de función', () => {
    // Los únicos INSERT legítimos viven dentro de CREATE FUNCTION (realtime.send,
    // storage.can_insert_object, public.handle_new_user…). Un INSERT en DDL de
    // primer nivel sería contenido de tabla filtrado al artefacto.
    //
    // La pertenencia se decide con la señal que el propio pg_dump emite —el
    // bloque `-- Name: …; Type: …` que precede a cada objeto— y no rastreando
    // dollar-quoting a mano: un rastreador por líneas se equivoca en cuanto un
    // cuerpo abre y cierra su etiqueta en la misma línea.
    const lines = text(SCHEMA).split('\n')
    let currentType: string | null = null
    const offenders: Array<{ line: number; type: string | null }> = []
    lines.forEach((line, i) => {
      const header = line.match(/^-- Name: .+; Type: ([A-Z ]+); Schema: /)
      if (header) currentType = header[1]
      if (/^\s*INSERT INTO/.test(line) && currentType !== 'FUNCTION') {
        offenders.push({ line: i + 1, type: currentType })
      }
    })
    expect(offenders).toEqual([])
  })

  it.each([ROLES, POST])('%s no contiene INSERT en absoluto', (f) => {
    expect(text(f)).not.toMatch(/^\s*INSERT INTO/m)
  })
})

describe('sin secretos', () => {
  const FORBIDDEN: ReadonlyArray<{ what: string; re: RegExp }> = [
    { what: 'JWT', re: /eyJ[A-Za-z0-9_-]{10,}/ },
    { what: 'clave publicable/secreta de Supabase', re: /sb_(secret|publishable)_[A-Za-z0-9_-]+/ },
    { what: 'clave de Stripe', re: /\b(sk|pk|whsec)_(live|test)_[A-Za-z0-9]+/ },
    { what: 'clave de Google', re: /AIza[0-9A-Za-z_-]{20,}/ },
    { what: 'connection string con credenciales', re: /postgres(ql)?:\/\/[^\s'"]*:[^\s'"]*@/ },
    { what: 'host remoto de Supabase', re: /https?:\/\/[a-z0-9-]+\.supabase\.(co|in)/ },
    { what: 'hash de contraseña', re: /md5[0-9a-f]{32}|SCRAM-SHA-256\$/ },
    { what: 'literal de email', re: /'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'/ },
  ]

  it.each(ARTIFACTS)('%s no expone secretos ni datos personales', (f) => {
    const t = text(f)
    // Se reporta QUÉ clase apareció, nunca el valor.
    const found = FORBIDDEN.filter((p) => p.re.test(t)).map((p) => p.what)
    expect(found).toEqual([])
  })

  it('el volcado de roles se generó con --no-role-passwords', () => {
    // `pg_dumpall --roles-only` sin ese flag emite `PASSWORD 'SCRAM-SHA-256$...'`
    // en cada CREATE ROLE con login.
    expect(text(ROLES)).not.toMatch(/\bPASSWORD\b/i)
  })
})

describe('el artefacto reproduce el contrato que el arnés necesita', () => {
  it('el schema declara las 38 tablas de public', () => {
    const created = text(SCHEMA).match(/^CREATE TABLE public\./gm) ?? []
    expect(created).toHaveLength(38)
  })

  it('post_restore aporta lo que pg_dump omite: owner y USAGE de public', () => {
    const t = text(POST)
    expect(t).toMatch(/ALTER SCHEMA public OWNER TO pg_database_owner;/)
    expect(t).toMatch(/GRANT USAGE ON SCHEMA public TO PUBLIC;/)
  })

  it('el schema NO trae la concesión a PUBLIC — de ahí que post_restore exista', () => {
    // Si una futura versión de pg_dump empezara a emitirla, esta prueba falla y
    // obliga a revisar si post_restore sigue haciendo falta, en vez de dejar una
    // duplicación silenciosa.
    expect(text(SCHEMA)).not.toMatch(/GRANT USAGE ON SCHEMA public TO PUBLIC;/)
  })

  it('el README documenta el orden de restauración y los conteos esperados', () => {
    const readme = text('README.md')
    expect(readme).toContain(ROLES)
    expect(readme).toContain(SCHEMA)
    expect(readme).toContain(POST)
    expect(readme).toMatch(/38\s*\/\s*107\s*\/\s*10|38 tablas/)
  })
})

describe('el dry-run ya no puede alcanzar el stack persistente', () => {
  const dryRun = () => readFileSync(path.join(SCRIPTS, 'capability-dry-run.sh'), 'utf8')

  it('no queda ninguna referencia ejecutable al contenedor persistente', () => {
    // El nombre puede seguir apareciendo en comentarios que explican la
    // migración; lo que no puede haber es una línea de código que lo use.
    const code = dryRun()
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(code).not.toMatch(/supabase_db_uellix-stella-g2-local-rehearsal/)
    expect(code).not.toMatch(/LIVE_CONTAINER/)
    expect(code).not.toMatch(/127\.0\.0\.1:56322/)
  })

  it('no genera su baseline con pg_dump ni pg_dumpall', () => {
    const code = dryRun()
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(code).not.toMatch(/\bpg_dumpall\b/)
    expect(code).not.toMatch(/\bpg_dump\b/)
  })

  it('consume los tres artefactos y verifica el manifiesto antes de empezar', () => {
    const code = dryRun()
    for (const f of ARTIFACTS) expect(code).toContain(f)
    expect(code).toMatch(/sha256sum -c MANIFEST\.sha256/)
  })

  it('corre aislado: --network none y sin publicar puertos', () => {
    const code = dryRun()
    expect(code).toMatch(/--network none/)
    expect(code).not.toMatch(/-p\s+\d+:\d+/)
  })

  it('el restore del baseline no silencia errores con || true', () => {
    // El `|| true` de las tres líneas de sembrado era exactamente el mecanismo
    // por el que un baseline mal restaurado se reportaba como verde.
    const restoreLines = dryRun()
      .split('\n')
      .filter((l) => ARTIFACTS.some((a) => l.includes(a)) && l.includes('psql') === false && l.includes('PSQL'))
    expect(restoreLines.length).toBeGreaterThan(0)
    for (const l of restoreLines) expect(l).not.toMatch(/\|\|\s*true/)
  })
})

describe('el verificador desechable existe y afirma el baseline', () => {
  const verify = () => readFileSync(path.join(SCRIPTS, 'capability-baseline-verify.sh'), 'utf8')

  it('está presente', () => {
    expect(existsSync(path.join(SCRIPTS, 'capability-baseline-verify.sh'))).toBe(true)
  })

  it('afirma 38 tablas, 107 policies y 10 triggers', () => {
    const code = verify()
    expect(code).toMatch(/assert_eq "tablas public"\s+"38"/)
    expect(code).toMatch(/assert_eq "policies public"\s+"107"/)
    expect(code).toMatch(/assert_eq "triggers public"\s+"10"/)
  })

  it('no depende del stack persistente ni monta volumen alguno', () => {
    const code = verify()
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(code).not.toMatch(/supabase_db_uellix-stella-g2-local-rehearsal/)
    expect(code).not.toMatch(/-v\s+supabase_/)
    expect(code).toMatch(/--network none/)
  })

  it('destruye su contenedor pase o falle', () => {
    expect(verify()).toMatch(/trap cleanup EXIT/)
  })
})

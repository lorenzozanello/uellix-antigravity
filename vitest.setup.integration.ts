// vitest.setup.integration.ts
//
// F0-05 — Las pruebas de integración escriben datos reales: crean
// organizaciones, proyectos, usuarios de auth y objetos de Storage. Antes,
// este archivo cargaba `.env.local`, cuyo DATABASE_URL apunta al proyecto
// Supabase REMOTO, de modo que `pnpm test:integration` sembraba producción con
// tenants de prueba (AUDITORIA_ESTADO_ACTUAL.md, hallazgo OPS-01).
//
// Dos cambios estructurales:
//   1. Ya NO se lee `.env.local`. Las pruebas de integración leen únicamente
//      `.env.test.local`, que genera `pnpm db:bootstrap:local` a partir de
//      `supabase status`. Así no existe ningún camino por el que la
//      configuración de producción llegue a esta suite por omisión.
//   2. La guarda de host (`db/guard.ts`) valida el resultado final. Si algo
//      apuntara fuera de loopback, la suite falla antes de abrir conexión.

import * as dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { checkLocalTargets, defaultTargets, RemoteDatabaseError } from './db/guard'

const ENV_FILE = '.env.test.local'
const envPath = path.resolve(process.cwd(), ENV_FILE)

// `override: false` (por defecto) preserva lo que ya venga del entorno: permite
// que CI inyecte la configuración del stack efímero sin tocar el archivo.
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath })
}

if (!process.env.DATABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
  throw new Error(
    [
      '',
      'Faltan las variables del stack local para las pruebas de integración.',
      '',
      `Se esperaba ${ENV_FILE} en la raíz del repositorio, o las variables ya`,
      'presentes en el entorno (DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL,',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY).',
      '',
      'Genera el entorno local con:',
      '    pnpm db:bootstrap:local',
      '',
      'Estas pruebas NO leen .env.local a propósito: ese archivo apunta al',
      'proyecto remoto y ejecutarlas contra él sembraría datos de prueba en',
      'producción.',
      '',
    ].join('\n'),
  )
}

try {
  checkLocalTargets(defaultTargets())
} catch (error) {
  if (error instanceof RemoteDatabaseError) {
    // Se relanza en lugar de process.exit() para que Vitest muestre el motivo
    // como fallo de setup en vez de matar el runner sin explicación.
    throw new Error(
      `${error.message}\n  Contexto: pnpm test:integration (suite que escribe datos)\n`,
    )
  }
  throw error
}

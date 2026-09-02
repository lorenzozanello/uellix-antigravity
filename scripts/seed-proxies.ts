// scripts/seed-proxies.ts
//
// Seeds system-level (organizationId: null) financial proxies from
// verifiable official sources, per ANTIGRAVITY.md's priority source list
// (PNUD/UNDP, World Bank, OECD, UN, IDB, CEPAL, official statistical bodies).
//
// Every entry here was checked against a live source at the time it was
// added (see the `verifiedOn` / URL in each entry) rather than pulled from
// training memory — proxy values like this change over time and Uellix's
// entire premise is that proxies must be traceable to a real, current
// source. Do not add entries you have not personally verified.
//
// Idempotent: safe to re-run. Skips sources/proxies that already exist
// (matched by name). Seeded proxies land with reviewStatus: 'suggested',
// NOT 'approved' — per docs/12_BACKLOG.md Sprint 5 criteria ("Aprobación
// humana obligatoria"), a human must explicitly approve each one via
// /admin/proxies before it can be used in an SROI calculation.
//
// Usage: pnpm db:seed:local:proxies
// Requires: at least one user with is_super_admin = true already exists
// (used as createdBy — the proxies table has a NOT NULL FK to users).
//
// LOCAL ONLY, FAIL-CLOSED. This script used to `import 'dotenv/config'` and
// then `import { db }` from db/client, which resolved `DATABASE_URL` — so a
// remote connection string in `.env` (or exported in the shell) silently made
// `pnpm db:seed:proxies` write synthetic fixtures to a managed database. It
// now resolves this worktree's pinned local stack through
// `createLocalDatabaseClient`, which ignores `DATABASE_URL` entirely and runs
// the `local_seed` capability guard before any socket is opened. There is no
// flag, env var or argument that lets this script reach a remote target.

import { createLocalDatabaseClient } from '../db/client'
import { describeError } from '../db/safety/redact-error'
import { users, proxySources, financialProxies } from '../db/schema'
import { eq, isNull, and } from 'drizzle-orm'

interface SeedSource {
  name: string
  description: string
  url: string
}

interface SeedProxy {
  sourceName: string
  name: string
  description: string
  proxyType: string
  currency: string
  value: string
  unit: string
  referenceYear: number
  thematicArea: string
  methodology: string
  confidenceLevel: 'high' | 'medium' | 'low'
  methodologicalRisk: 'low' | 'medium' | 'high'
}

const SOURCES: SeedSource[] = [
  {
    name: 'Banco Mundial',
    description: 'World Bank Group — línea internacional de pobreza y estadísticas de desarrollo.',
    url: 'https://www.worldbank.org/en/news/factsheet/2025/06/05/june-2025-update-to-global-poverty-lines',
  },
]

// Verified 2026-07-01 against the World Bank's June 2025 poverty line
// update (https://www.worldbank.org/en/news/factsheet/2025/06/05/june-2025-update-to-global-poverty-lines).
// This update replaced the prior $2.15/day (2017 PPP) figure with $3.00/day
// (2021 PPP) for the International Poverty Line — verify again before
// approving if this script is run long after the date above, since the
// World Bank revises these periodically.
const PROXIES: SeedProxy[] = [
  {
    sourceName: 'Banco Mundial',
    name: 'Línea Internacional de Pobreza (extrema)',
    description:
      'Umbral internacional de pobreza extrema del Banco Mundial, actualizado en junio de 2025 a $3.00/día (PPA 2021), reemplazando el umbral anterior de $2.15/día (PPA 2017).',
    proxyType: 'poverty_line',
    currency: 'USD',
    value: '3.00',
    unit: 'día/persona (PPA 2021)',
    referenceYear: 2025,
    thematicArea: 'reduccion_pobreza',
    methodology:
      'Uso típico: comparar ingreso/consumo per cápita de la población objetivo contra este umbral para estimar personas elevadas por encima de la línea de pobreza extrema como resultado de una intervención.',
    confidenceLevel: 'high',
    methodologicalRisk: 'medium',
  },
]

async function main() {
  const client = createLocalDatabaseClient({ capability: 'local_seed' })
  const { db } = client
  for (const warning of client.warnings) console.warn(`[seed-proxies] ${warning}`)
  console.log(`[seed-proxies] ${client.decision.auditLine}`)

  const [admin] = await db.select().from(users).where(eq(users.isSuperAdmin, true)).limit(1)
  if (!admin) {
    console.error(
      '[seed-proxies] No user with is_super_admin = true found. Create one before running this script.'
    )
    await client.close()
    process.exit(1)
  }

  const sourceIdByName = new Map<string, string>()

  for (const source of SOURCES) {
    const existing = await db
      .select()
      .from(proxySources)
      .where(and(isNull(proxySources.organizationId), eq(proxySources.name, source.name)))
      .then((rows) => rows[0])

    if (existing) {
      console.log(`[seed-proxies] Source "${source.name}" already exists — skipping.`)
      sourceIdByName.set(source.name, existing.id)
      continue
    }

    const [inserted] = await db
      .insert(proxySources)
      .values({
        organizationId: null,
        name: source.name,
        description: source.description,
        url: source.url,
        status: 'active',
        createdBy: admin.id,
      })
      .returning()

    console.log(`[seed-proxies] Created source "${source.name}" (${inserted.id}).`)
    sourceIdByName.set(source.name, inserted.id)
  }

  for (const proxy of PROXIES) {
    const sourceId = sourceIdByName.get(proxy.sourceName)
    if (!sourceId) {
      console.warn(`[seed-proxies] Skipping "${proxy.name}" — source "${proxy.sourceName}" not resolved.`)
      continue
    }

    const existing = await db
      .select()
      .from(financialProxies)
      .where(and(isNull(financialProxies.organizationId), eq(financialProxies.name, proxy.name)))
      .then((rows) => rows[0])

    if (existing) {
      console.log(`[seed-proxies] Proxy "${proxy.name}" already exists — skipping.`)
      continue
    }

    const [inserted] = await db
      .insert(financialProxies)
      .values({
        organizationId: null,
        sourceId,
        name: proxy.name,
        description: proxy.description,
        proxyType: proxy.proxyType,
        currency: proxy.currency,
        value: proxy.value,
        unit: proxy.unit,
        referenceYear: proxy.referenceYear,
        thematicArea: proxy.thematicArea,
        methodology: proxy.methodology,
        confidenceLevel: proxy.confidenceLevel,
        methodologicalRisk: proxy.methodologicalRisk,
        reviewStatus: 'suggested',
        createdBy: admin.id,
      })
      .returning()

    console.log(`[seed-proxies] Created proxy "${proxy.name}" (${inserted.id}) — status: suggested, needs approval.`)
  }

  console.log('[seed-proxies] Done. Review and approve seeded proxies at /admin/proxies before use.')
  await client.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('[seed-proxies] Failed:', describeError(err))
  process.exit(1)
})

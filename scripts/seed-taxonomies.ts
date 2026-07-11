// scripts/seed-taxonomies.ts
//
// Seeds the Fase 3 interoperability reference catalogs (ODS, IRIS+) and their
// codes from lib/taxonomies/seed-data.ts. Catalogs/codes are GLOBAL reference
// data (not org-scoped) — shared standard vocabularies.
//
// Idempotent: safe to re-run. Catalogs are matched by `code`, codes by
// (catalog_id, code); existing rows are updated in place, new ones inserted.
//
// Usage: pnpm db:seed:taxonomies

import 'dotenv/config'
import { db } from '../db/client'
import { taxonomyCatalogs, taxonomyCodes } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import { TAXONOMY_SEED } from '../lib/taxonomies/seed-data'

async function main() {
  let catalogsUpserted = 0
  let codesUpserted = 0

  for (const catalog of TAXONOMY_SEED) {
    const existing = await db
      .select()
      .from(taxonomyCatalogs)
      .where(eq(taxonomyCatalogs.code, catalog.code))
      .then((r) => r[0] ?? null)

    let catalogId: string
    if (existing) {
      await db
        .update(taxonomyCatalogs)
        .set({ name: catalog.name, version: catalog.version, sourceUrl: catalog.sourceUrl ?? null, updatedAt: new Date() })
        .where(eq(taxonomyCatalogs.id, existing.id))
      catalogId = existing.id
    } else {
      const inserted = await db
        .insert(taxonomyCatalogs)
        .values({ code: catalog.code, name: catalog.name, version: catalog.version, sourceUrl: catalog.sourceUrl ?? null })
        .returning()
        .then((r) => r[0])
      catalogId = inserted.id
    }
    catalogsUpserted += 1

    for (let i = 0; i < catalog.codes.length; i++) {
      const item = catalog.codes[i]
      const existingCode = await db
        .select()
        .from(taxonomyCodes)
        .where(and(eq(taxonomyCodes.catalogId, catalogId), eq(taxonomyCodes.code, item.code)))
        .then((r) => r[0] ?? null)

      if (existingCode) {
        await db
          .update(taxonomyCodes)
          .set({ label: item.label, description: item.description ?? null, sortOrder: i })
          .where(eq(taxonomyCodes.id, existingCode.id))
      } else {
        await db
          .insert(taxonomyCodes)
          .values({ catalogId, code: item.code, label: item.label, description: item.description ?? null, sortOrder: i })
      }
      codesUpserted += 1
    }
    console.log(`  ✓ ${catalog.code} (${catalog.codes.length} codes)`)
  }

  console.log(`Done. ${catalogsUpserted} catalogs, ${codesUpserted} codes upserted.`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })

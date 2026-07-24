// tests/integration/cleanup.ts
//
// F0-05 — Ayudas de limpieza compartidas por las suites de integración.
//
// Restricción de diseño que conviene entender antes de tocar esto:
// `audit_logs` tiene una FK a `organizations` y es APPEND-ONLY por disparador
// (`0030_immutability.sql`). Cualquier DELETE sobre `audit_logs` lanza
// excepción, incluso para el rol propietario. La consecuencia es que **una
// organización que llegó a generar una entrada de auditoría no se puede
// borrar**, y eso es deliberado: es la garantía de trazabilidad del producto.
//
// Por tanto las suites limpian todo lo que sí es borrable, y las
// organizaciones con rastro de auditoría quedan para
// `pnpm db:clean:test-data`, que sí puede saltarse el disparador porque es un
// procedimiento explícito, guardado por host y restringido a entornos locales.

import { inArray, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { organizations } from '@/db/schema'

/**
 * Borra las organizaciones indicadas que NO tengan entradas en `audit_logs`.
 * Devuelve los ids que no se pudieron borrar por tener rastro inmutable.
 */
export async function deleteOrganizationsWithoutAuditTrail(
  orgIds: string[],
): Promise<string[]> {
  if (orgIds.length === 0) return []

  const withAudit = await db.execute<{ organization_id: string }>(sql`
    select distinct organization_id
    from audit_logs
    where organization_id in ${sql`(${sql.join(orgIds.map((id) => sql`${id}`), sql`, `)})`}
  `)

  const blocked = new Set(
    (withAudit as unknown as { organization_id: string }[]).map((r) => r.organization_id),
  )
  const deletable = orgIds.filter((id) => !blocked.has(id))

  if (deletable.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, deletable))
  }

  return [...blocked]
}

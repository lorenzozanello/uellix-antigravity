// lib/pipeline/domain-object-versions.ts
// FIBIU-03 — generic domain-object version lineage (FIBC-002 / FIBC-045 /
// FIBDB-004). Append-only lineage for any versioned domain object, keyed by
// (object_type, object_id). Ordinal + supersedes_version_id give a
// deterministic, walkable history: each new version points at the version it
// replaces, and no version is ever updated or deleted once written — the
// database enforces that independently (trg_domain_object_versions_append_only,
// db/migrations/0045_fib_domain_object_version_lineage.sql), and this module
// deliberately exposes no update/delete function so there is no service-layer
// path to attempt one either.
//
// A "legacy" object — one that predates FIBIU-03 or has never been versioned
// through this module — has no rows here. getLatestDomainObjectVersion
// returns null for it; nothing in this module synthesizes a version 1 for an
// object that was never actually versioned (FIBC-045: "legacy object not
// fabricated into versioned authority").

import { createHash } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { domainObjectVersions } from '@/db/schema'

export type DomainObjectVersion = typeof domainObjectVersions.$inferSelect

/**
 * Deterministic content hash for a version's payload. Not a security
 * boundary — a stable fingerprint so two versions can be compared for
 * drift without re-reading the full payload.
 */
export function computeDomainObjectVersionContentHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export interface CreateDomainObjectVersionInput {
  organizationId: string
  objectType: string
  objectId: string
  payload: Record<string, unknown>
  actorId: string
}

/**
 * Append a new version for (objectType, objectId). Ordinal is one past the
 * current maximum for that object (1 for the first version); supersedesVersionId
 * links to the version that was current before this call, or null when this is
 * the object's first version.
 *
 * Not wrapped in an explicit transaction — mirrors the same
 * select-max-then-insert-under-a-unique-index shape used for
 * sroi_calculation_runs.version (lib/pipeline/sroi-calculation.ts): the
 * (object_type, object_id, ordinal) unique constraint is the authoritative
 * guard, turning a concurrent race into a clean retryable error rather than a
 * silent duplicate ordinal.
 */
export async function createDomainObjectVersion(
  input: CreateDomainObjectVersionInput
): Promise<DomainObjectVersion> {
  const current = await getLatestDomainObjectVersion(input.objectType, input.objectId)
  const ordinal = (current?.ordinal ?? 0) + 1

  const [created] = await db
    .insert(domainObjectVersions)
    .values({
      organizationId: input.organizationId,
      objectType: input.objectType,
      objectId: input.objectId,
      ordinal,
      payloadJson: input.payload,
      contentHash: computeDomainObjectVersionContentHash(input.payload),
      supersedesVersionId: current?.id ?? null,
      createdBy: input.actorId,
    })
    .returning()

  return created
}

/** The current (highest-ordinal) version for an object, or null if it has never been versioned. */
export async function getLatestDomainObjectVersion(
  objectType: string,
  objectId: string
): Promise<DomainObjectVersion | null> {
  const rows = await db
    .select()
    .from(domainObjectVersions)
    .where(and(eq(domainObjectVersions.objectType, objectType), eq(domainObjectVersions.objectId, objectId)))
    .orderBy(desc(domainObjectVersions.ordinal))
    .limit(1)
  return rows[0] ?? null
}

/** Full lineage for an object, oldest first. Empty for a never-versioned (legacy) object. */
export async function listDomainObjectVersions(
  objectType: string,
  objectId: string
): Promise<DomainObjectVersion[]> {
  return db
    .select()
    .from(domainObjectVersions)
    .where(and(eq(domainObjectVersions.objectType, objectType), eq(domainObjectVersions.objectId, objectId)))
    .orderBy(domainObjectVersions.ordinal)
}

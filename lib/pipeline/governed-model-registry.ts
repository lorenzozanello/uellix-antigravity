// lib/pipeline/governed-model-registry.ts
// FIBIU-01 — governed model registry (FIBC-003 / FIBDB-002). The eight seed
// identities here mirror db/migrations/0040_governed_model_registry.sql's
// INSERT exactly; a test cross-checks the two never drift apart.

import { createHash } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { governedModelRegistry } from '@/db/schema'

/**
 * Deterministic identity hash for a governed model version. Not a hash of
 * external content — none of these definitions are codified as hashable
 * artifacts yet; that belongs to each model's owning FIBIU (e.g. the proxy
 * defendibility rubric's factor ranges are FIBDB-044, owned by FIBIU-09).
 * This is a stable, reproducible, non-fabricated value tied to the exact
 * (model_id, version) tuple: it changes if and only if a new version is
 * registered, which is what FIBIU-01's immutability test relies on.
 */
export function computeGovernedModelIdentityHash(modelId: string, version: string): string {
  return createHash('sha256').update(`${modelId}:${version}`).digest('hex')
}

// The methodology row reuses the real sealed hash of the frozen PC-01B
// methodology authority document (canonical_authority_sha256 in
// docs/ops/pc01b/PC01B_HUMAN_METHODOLOGY_AUTHORITY_v1.0.0.seal.json) instead
// of a synthetic identity hash — a genuine, independently verifiable artifact
// already exists for it.
const PC01B_METHODOLOGY_AUTHORITY_SHA256 =
  '03212c661f07200d128c2374173f7bbd996b8eab0f3eb1b59cd517187f159938'

export type GovernedModelSeed = {
  modelId: string
  version: string
  definitionHash: string
}

export const GOVERNED_MODEL_REGISTRY_SEED: readonly GovernedModelSeed[] = [
  { modelId: 'SROI_READINESS_MODEL', version: '1.0.0', definitionHash: computeGovernedModelIdentityHash('SROI_READINESS_MODEL', '1.0.0') },
  { modelId: 'PROXY_DEFENDIBILITY_RUBRIC', version: '1.0.0', definitionHash: computeGovernedModelIdentityHash('PROXY_DEFENDIBILITY_RUBRIC', '1.0.0') },
  { modelId: 'SROI_SENSITIVITY_MODEL', version: '1.0.0', definitionHash: computeGovernedModelIdentityHash('SROI_SENSITIVITY_MODEL', '1.0.0') },
  { modelId: 'PUBLIC_REPORT_VERIFICATION_POLICY', version: '1.0.0', definitionHash: computeGovernedModelIdentityHash('PUBLIC_REPORT_VERIFICATION_POLICY', '1.0.0') },
  { modelId: 'PROXY_MATERIAL_CHANGE_POLICY', version: '1.0.0', definitionHash: computeGovernedModelIdentityHash('PROXY_MATERIAL_CHANGE_POLICY', '1.0.0') },
  { modelId: 'PROXY_MATERIAL_FIELDS', version: '1.0.0', definitionHash: computeGovernedModelIdentityHash('PROXY_MATERIAL_FIELDS', '1.0.0') },
  { modelId: 'PC01B_HUMAN_METHODOLOGY_AUTHORITY', version: '1.0.0', definitionHash: PC01B_METHODOLOGY_AUTHORITY_SHA256 },
  { modelId: 'SROI_CALCULATION_ENGINE', version: '1.0.0', definitionHash: computeGovernedModelIdentityHash('SROI_CALCULATION_ENGINE', '1.0.0') },
]

/**
 * W2-B2-R1 / R-B2-03 — versions registered AFTER the 0040 seed, by the same
 * append-only convention: each entry mirrors exactly one later migration's
 * INSERT and a test cross-checks the two never drift apart. The 0040 seed
 * above is NOT modified (FIBC-003: a new version is a new row, never an
 * in-place mutation), which is also why this is a sibling constant rather
 * than an extension of GOVERNED_MODEL_REGISTRY_SEED — that constant is
 * pinned to 0040's eight 1.0.0 rows by lib/pipeline/governed-model-registry
 * .test.ts and must keep meaning exactly that.
 */
export const GOVERNED_MODEL_REGISTRY_APPENDS: readonly (GovernedModelSeed & { migration: string })[] = [
  {
    modelId: 'PROXY_MATERIAL_FIELDS',
    version: '1.1.0',
    definitionHash: computeGovernedModelIdentityHash('PROXY_MATERIAL_FIELDS', '1.1.0'),
    migration: 'db/migrations/0056_fib_proxy_material_fields_editability.sql',
  },
]

/** Read the full governed model registry. */
export async function listGovernedModels() {
  return db.select().from(governedModelRegistry)
}

/**
 * The current (most recently registered) version row for a governed model,
 * or null if it has never been registered. FIBIU-02 resolves
 * methodology_version and calculation_engine_version through this — a
 * live read, not the TS seed constants, so a newly registered version is
 * picked up without a redeploy.
 */
export async function getCurrentGovernedModelVersion(modelId: string) {
  const rows = await db
    .select()
    .from(governedModelRegistry)
    .where(eq(governedModelRegistry.modelId, modelId))
    .orderBy(desc(governedModelRegistry.effectiveFrom))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Register a new governed model version. Never updates an existing
 * (model_id, version) row — a semantic change to a governed model always
 * means a new version, never in-place mutation (FIBC-003).
 */
export async function registerGovernedModelVersion(seed: GovernedModelSeed) {
  const [row] = await db
    .insert(governedModelRegistry)
    .values(seed)
    .onConflictDoNothing({ target: [governedModelRegistry.modelId, governedModelRegistry.version] })
    .returning()
  return row ?? null
}

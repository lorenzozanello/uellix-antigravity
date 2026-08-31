// lib/pipeline/run-version-identity.ts
// FIBIU-02 (FIBC-001/FIBDB-001) — resolves the run version identity triple:
// methodology_version, calculation_engine_version, build_identity. All three
// are system-assigned at run time from governed_model_registry (FIBIU-01)
// and the build environment — there is no human boundary, and no path that
// lets a caller supply one of these values directly.
//
// Fails closed (FIBC-001 FC): if any of the three cannot be resolved, this
// throws rather than letting calculateAndPersistSroiRun persist a run with a
// partial or fabricated identity.

import { getCurrentGovernedModelVersion } from '@/lib/pipeline/governed-model-registry'
import { resolveBuildIdentity } from '@/lib/pipeline/build-identity'

export const METHODOLOGY_MODEL_ID = 'PC01B_HUMAN_METHODOLOGY_AUTHORITY'
export const CALCULATION_ENGINE_MODEL_ID = 'SROI_CALCULATION_ENGINE'

export interface RunVersionIdentity {
  methodologyVersion: string
  calculationEngineVersion: string
  buildIdentity: string
}

export class RunVersionIdentityUnresolvedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunVersionIdentityUnresolvedError'
  }
}

/**
 * Resolve the run version identity triple for a new calculation run.
 * Throws RunVersionIdentityUnresolvedError — never returns a partial
 * triple — when any of the three cannot be resolved.
 */
export async function resolveRunVersionIdentity(
  env: Record<string, string | undefined> = process.env
): Promise<RunVersionIdentity> {
  const [methodology, engine] = await Promise.all([
    getCurrentGovernedModelVersion(METHODOLOGY_MODEL_ID),
    getCurrentGovernedModelVersion(CALCULATION_ENGINE_MODEL_ID),
  ])
  const buildIdentity = resolveBuildIdentity(env)

  const missing: string[] = []
  if (!methodology) missing.push('methodology_version')
  if (!engine) missing.push('calculation_engine_version')
  if (!buildIdentity) missing.push('build_identity')

  if (missing.length > 0) {
    throw new RunVersionIdentityUnresolvedError(
      `Cannot persist a calculation run: unable to resolve [${missing.join(', ')}]. ` +
        'FIBC-001 requires the full run version identity triple to be resolvable before a run is calculated.'
    )
  }

  return {
    methodologyVersion: methodology!.version,
    calculationEngineVersion: engine!.version,
    buildIdentity: buildIdentity!,
  }
}

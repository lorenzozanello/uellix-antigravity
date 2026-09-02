// lib/pipeline/run-version-identity.test.ts
// FIBIU-02 acceptance tests: every new run resolves all three identities;
// a missing identity rejects persistence (fails closed).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getCurrentGovernedModelVersionMock } = vi.hoisted(() => ({
  getCurrentGovernedModelVersionMock: vi.fn(),
}))

vi.mock('@/lib/pipeline/governed-model-registry', () => ({
  getCurrentGovernedModelVersion: getCurrentGovernedModelVersionMock,
}))

import {
  resolveRunVersionIdentity,
  RunVersionIdentityUnresolvedError,
  METHODOLOGY_MODEL_ID,
  CALCULATION_ENGINE_MODEL_ID,
} from './run-version-identity'

const METHODOLOGY_ROW = { modelId: METHODOLOGY_MODEL_ID, version: '1.0.0' }
const ENGINE_ROW = { modelId: CALCULATION_ENGINE_MODEL_ID, version: '1.0.0' }

function mockRegistry(methodology: unknown, engine: unknown) {
  getCurrentGovernedModelVersionMock.mockImplementation(async (modelId: string) => {
    if (modelId === METHODOLOGY_MODEL_ID) return methodology
    if (modelId === CALCULATION_ENGINE_MODEL_ID) return engine
    return null
  })
}

describe('resolveRunVersionIdentity', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves all three identities when the registry and build environment are complete', async () => {
    mockRegistry(METHODOLOGY_ROW, ENGINE_ROW)
    const identity = await resolveRunVersionIdentity({ VERCEL_GIT_COMMIT_SHA: 'sha-1' })
    expect(identity).toEqual({
      methodologyVersion: '1.0.0',
      calculationEngineVersion: '1.0.0',
      buildIdentity: 'sha-1',
    })
  })

  it('fails closed when methodology_version cannot be resolved', async () => {
    mockRegistry(null, ENGINE_ROW)
    await expect(
      resolveRunVersionIdentity({ VERCEL_GIT_COMMIT_SHA: 'sha-1' })
    ).rejects.toThrow(RunVersionIdentityUnresolvedError)
  })

  it('fails closed when calculation_engine_version cannot be resolved', async () => {
    mockRegistry(METHODOLOGY_ROW, null)
    await expect(
      resolveRunVersionIdentity({ VERCEL_GIT_COMMIT_SHA: 'sha-1' })
    ).rejects.toThrow(RunVersionIdentityUnresolvedError)
  })

  it('fails closed when build_identity cannot be resolved from the environment', async () => {
    mockRegistry(METHODOLOGY_ROW, ENGINE_ROW)
    await expect(resolveRunVersionIdentity({})).rejects.toThrow(
      RunVersionIdentityUnresolvedError
    )
  })

  it('never returns a partial triple — all three or an error, nothing in between', async () => {
    mockRegistry(null, null)
    let thrown: unknown
    try {
      await resolveRunVersionIdentity({})
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RunVersionIdentityUnresolvedError)
    expect((thrown as Error).message).toMatch(/methodology_version/)
    expect((thrown as Error).message).toMatch(/calculation_engine_version/)
    expect((thrown as Error).message).toMatch(/build_identity/)
  })
})

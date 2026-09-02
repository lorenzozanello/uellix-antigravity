// lib/pipeline/governed-model-registry.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Mock db client the same way tests/projects.service.test.ts does — no live
// connection, just enough chain surface for the two functions under test.
// vi.mock() is hoisted above every import, so the mocks it references must be
// created inside vi.hoisted() rather than as plain top-level consts.
const { insertMock, valuesMock, onConflictDoNothingMock, returningMock, selectMock, fromMock, updateMock } =
  vi.hoisted(() => ({
    insertMock: vi.fn().mockReturnThis(),
    valuesMock: vi.fn().mockReturnThis(),
    onConflictDoNothingMock: vi.fn().mockReturnThis(),
    returningMock: vi.fn().mockResolvedValue([]),
    selectMock: vi.fn().mockReturnThis(),
    fromMock: vi.fn().mockResolvedValue([]),
    updateMock: vi.fn(),
  }))

vi.mock('@/db/client', () => ({
  db: {
    insert: insertMock,
    values: valuesMock,
    onConflictDoNothing: onConflictDoNothingMock,
    returning: returningMock,
    select: selectMock,
    from: fromMock,
    update: updateMock,
  },
}))

import {
  GOVERNED_MODEL_REGISTRY_SEED,
  computeGovernedModelIdentityHash,
  listGovernedModels,
  registerGovernedModelVersion,
} from './governed-model-registry'

const REQUIRED_MODEL_IDS = [
  'SROI_READINESS_MODEL',
  'PROXY_DEFENDIBILITY_RUBRIC',
  'SROI_SENSITIVITY_MODEL',
  'PUBLIC_REPORT_VERIFICATION_POLICY',
  'PROXY_MATERIAL_CHANGE_POLICY',
  'PROXY_MATERIAL_FIELDS',
  'PC01B_HUMAN_METHODOLOGY_AUTHORITY',
  'SROI_CALCULATION_ENGINE',
]

describe('GOVERNED_MODEL_REGISTRY_SEED', () => {
  it('holds exactly the eight governed-model rows required by FIBC-003', () => {
    expect(GOVERNED_MODEL_REGISTRY_SEED).toHaveLength(8)
    expect(GOVERNED_MODEL_REGISTRY_SEED.map((m) => m.modelId).sort()).toEqual(
      [...REQUIRED_MODEL_IDS].sort()
    )
  })

  it('starts every model at version 1.0.0', () => {
    for (const model of GOVERNED_MODEL_REGISTRY_SEED) {
      expect(model.version).toBe('1.0.0')
    }
  })

  it('gives every model a 64-character hex definition hash', () => {
    for (const model of GOVERNED_MODEL_REGISTRY_SEED) {
      expect(model.definitionHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('reuses the real sealed PC-01B methodology authority hash, not an invented one', () => {
    const methodology = GOVERNED_MODEL_REGISTRY_SEED.find(
      (m) => m.modelId === 'PC01B_HUMAN_METHODOLOGY_AUTHORITY'
    )
    expect(methodology?.definitionHash).toBe(
      '03212c661f07200d128c2374173f7bbd996b8eab0f3eb1b59cd517187f159938'
    )
  })

  it('never assigns two models the same identity', () => {
    const ids = GOVERNED_MODEL_REGISTRY_SEED.map((m) => `${m.modelId}:${m.version}`)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('computeGovernedModelIdentityHash', () => {
  it('is deterministic for the same identity', () => {
    const a = computeGovernedModelIdentityHash('SROI_READINESS_MODEL', '1.0.0')
    const b = computeGovernedModelIdentityHash('SROI_READINESS_MODEL', '1.0.0')
    expect(a).toBe(b)
  })

  it('changes when the version changes — a semantic change means a new version', () => {
    const v1 = computeGovernedModelIdentityHash('SROI_READINESS_MODEL', '1.0.0')
    const v2 = computeGovernedModelIdentityHash('SROI_READINESS_MODEL', '1.1.0')
    expect(v1).not.toBe(v2)
  })
})

describe('registerGovernedModelVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    insertMock.mockReturnThis()
    valuesMock.mockReturnThis()
    onConflictDoNothingMock.mockReturnThis()
    returningMock.mockResolvedValue([
      { id: 'row-1', modelId: 'SROI_READINESS_MODEL', version: '1.1.0', definitionHash: 'x'.repeat(64) },
    ])
  })

  it('only ever inserts — never updates an existing governed model row', async () => {
    await registerGovernedModelVersion({
      modelId: 'SROI_READINESS_MODEL',
      version: '1.1.0',
      definitionHash: 'x'.repeat(64),
    })
    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('keys the conflict target on (model_id, version) so re-registering the same version never mutates it', async () => {
    await registerGovernedModelVersion({
      modelId: 'SROI_READINESS_MODEL',
      version: '1.0.0',
      definitionHash: 'x'.repeat(64),
    })
    expect(onConflictDoNothingMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.any(Array) })
    )
  })
})

describe('listGovernedModels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads through select().from(), never a write path', async () => {
    fromMock.mockResolvedValueOnce([])
    await listGovernedModels()
    expect(selectMock).toHaveBeenCalled()
    expect(fromMock).toHaveBeenCalled()
    expect(insertMock).not.toHaveBeenCalled()
  })
})

describe('deploy-time seed migration stays in sync with the TS seed constants', () => {
  it('embeds exactly the same (model_id, version, definition_hash) triples as db/migrations/0040_governed_model_registry.sql', () => {
    const migrationPath = path.resolve(
      process.cwd(),
      'db',
      'migrations',
      '0040_governed_model_registry.sql'
    )
    const sql = readFileSync(migrationPath, 'utf8')
    const tupleRe = /\('([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g
    const found: { modelId: string; version: string; definitionHash: string }[] = []
    let match: RegExpExecArray | null
    while ((match = tupleRe.exec(sql)) !== null) {
      found.push({ modelId: match[1], version: match[2], definitionHash: match[3] })
    }
    expect(found).toEqual(GOVERNED_MODEL_REGISTRY_SEED)
  })
})

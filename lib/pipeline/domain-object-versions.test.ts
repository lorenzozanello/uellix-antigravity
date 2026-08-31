// lib/pipeline/domain-object-versions.test.ts
// FIBIU-03 acceptance tests: version lineage deterministic, supersession
// linkage correct, protected history not silently mutated, legacy object not
// fabricated into versioned authority.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Mock db client the same way lib/pipeline/governed-model-registry.test.ts
// does — no live connection, just enough chain surface for the functions
// under test. vi.mock() is hoisted above imports, so referenced mocks must be
// created inside vi.hoisted().
const {
  insertMock,
  valuesMock,
  returningMock,
  selectMock,
  fromMock,
  whereMock,
  orderByMock,
  limitMock,
  updateMock,
  deleteMock,
} = vi.hoisted(() => ({
  insertMock: vi.fn().mockReturnThis(),
  valuesMock: vi.fn().mockReturnThis(),
  returningMock: vi.fn().mockResolvedValue([]),
  selectMock: vi.fn().mockReturnThis(),
  fromMock: vi.fn().mockReturnThis(),
  whereMock: vi.fn().mockReturnThis(),
  orderByMock: vi.fn().mockReturnThis(),
  limitMock: vi.fn().mockResolvedValue([]),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
}))

vi.mock('@/db/client', () => ({
  db: {
    insert: insertMock,
    values: valuesMock,
    returning: returningMock,
    select: selectMock,
    from: fromMock,
    where: whereMock,
    orderBy: orderByMock,
    limit: limitMock,
    update: updateMock,
    delete: deleteMock,
  },
}))

import {
  computeDomainObjectVersionContentHash,
  createDomainObjectVersion,
  getLatestDomainObjectVersion,
  listDomainObjectVersions,
} from './domain-object-versions'

const ORG_ID = 'org-1'
const ACTOR_ID = 'user-1'
const OBJECT_TYPE = 'indicator'
const OBJECT_ID = 'indicator-1'

describe('computeDomainObjectVersionContentHash', () => {
  it('is deterministic for the same payload', () => {
    const a = computeDomainObjectVersionContentHash({ name: 'x' })
    const b = computeDomainObjectVersionContentHash({ name: 'x' })
    expect(a).toBe(b)
  })

  it('changes when the payload changes', () => {
    const a = computeDomainObjectVersionContentHash({ name: 'x' })
    const b = computeDomainObjectVersionContentHash({ name: 'y' })
    expect(a).not.toBe(b)
  })

  it('produces a 64-character hex digest', () => {
    expect(computeDomainObjectVersionContentHash({ any: 'thing' })).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('getLatestDomainObjectVersion — legacy object not fabricated into versioned authority', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null for an object that has never been versioned, rather than synthesizing one', async () => {
    limitMock.mockResolvedValueOnce([])
    const latest = await getLatestDomainObjectVersion(OBJECT_TYPE, 'never-versioned-legacy-id')
    expect(latest).toBeNull()
  })
})

describe('listDomainObjectVersions — legacy object not fabricated into versioned authority', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns an empty lineage for a legacy object, never a fabricated version 1', async () => {
    orderByMock.mockResolvedValueOnce([])
    const versions = await listDomainObjectVersions(OBJECT_TYPE, 'never-versioned-legacy-id')
    expect(versions).toEqual([])
  })
})

describe('createDomainObjectVersion — version lineage deterministic + supersession linkage correct', () => {
  beforeEach(() => vi.clearAllMocks())

  it('assigns ordinal 1 with no supersedes_version_id for the first version of an object', async () => {
    limitMock.mockResolvedValueOnce([]) // no current version
    returningMock.mockResolvedValueOnce([
      { id: 'v1', objectType: OBJECT_TYPE, objectId: OBJECT_ID, ordinal: 1, supersedesVersionId: null },
    ])

    const v1 = await createDomainObjectVersion({
      organizationId: ORG_ID,
      objectType: OBJECT_TYPE,
      objectId: OBJECT_ID,
      payload: { name: 'first' },
      actorId: ACTOR_ID,
    })

    expect(v1.ordinal).toBe(1)
    expect(v1.supersedesVersionId).toBeNull()
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ ordinal: 1, supersedesVersionId: null })
    )
  })

  it('increments the ordinal deterministically and links supersedes_version_id to the prior version', async () => {
    limitMock.mockResolvedValueOnce([
      { id: 'v1', objectType: OBJECT_TYPE, objectId: OBJECT_ID, ordinal: 1, supersedesVersionId: null },
    ])
    returningMock.mockResolvedValueOnce([
      { id: 'v2', objectType: OBJECT_TYPE, objectId: OBJECT_ID, ordinal: 2, supersedesVersionId: 'v1' },
    ])

    const v2 = await createDomainObjectVersion({
      organizationId: ORG_ID,
      objectType: OBJECT_TYPE,
      objectId: OBJECT_ID,
      payload: { name: 'second' },
      actorId: ACTOR_ID,
    })

    expect(v2.ordinal).toBe(2)
    expect(v2.supersedesVersionId).toBe('v1')
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ ordinal: 2, supersedesVersionId: 'v1' })
    )
  })

  it('chains a third version onto the second — the lineage walks deterministically, not just pairwise', async () => {
    limitMock.mockResolvedValueOnce([
      { id: 'v2', objectType: OBJECT_TYPE, objectId: OBJECT_ID, ordinal: 2, supersedesVersionId: 'v1' },
    ])
    returningMock.mockResolvedValueOnce([
      { id: 'v3', objectType: OBJECT_TYPE, objectId: OBJECT_ID, ordinal: 3, supersedesVersionId: 'v2' },
    ])

    const v3 = await createDomainObjectVersion({
      organizationId: ORG_ID,
      objectType: OBJECT_TYPE,
      objectId: OBJECT_ID,
      payload: { name: 'third' },
      actorId: ACTOR_ID,
    })

    expect(v3.ordinal).toBe(3)
    expect(v3.supersedesVersionId).toBe('v2')
  })
})

describe('protected history not silently mutated', () => {
  it('exposes no update or delete function — there is no service-layer path to mutate a version', async () => {
    const mod = await import('./domain-object-versions')
    const exportedNames = Object.keys(mod)
    const mutating = exportedNames.filter((name) => /update|delete|remove|edit/i.test(name))
    expect(mutating).toEqual([])
  })

  it('never calls db.update or db.delete from createDomainObjectVersion', async () => {
    vi.clearAllMocks()
    limitMock.mockResolvedValueOnce([])
    returningMock.mockResolvedValueOnce([{ id: 'v1', ordinal: 1, supersedesVersionId: null }])
    await createDomainObjectVersion({
      organizationId: ORG_ID,
      objectType: OBJECT_TYPE,
      objectId: OBJECT_ID,
      payload: { name: 'first' },
      actorId: ACTOR_ID,
    })
    expect(updateMock).not.toHaveBeenCalled()
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('the append-only trigger for domain_object_versions exists in the migration that creates the table', () => {
    const migrationPath = path.resolve(
      process.cwd(),
      'db',
      'migrations',
      '0045_fib_domain_object_version_lineage.sql'
    )
    const sql = readFileSync(migrationPath, 'utf8')
    expect(sql).toMatch(/CREATE TABLE "domain_object_versions"/)
    expect(sql).toMatch(/trg_domain_object_versions_append_only/)
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON domain_object_versions/)
    // No UPDATE or DELETE RLS policy — denied by omission.
    expect(sql).not.toMatch(/domain_object_versions FOR UPDATE/)
    expect(sql).not.toMatch(/domain_object_versions FOR DELETE/)
  })
})

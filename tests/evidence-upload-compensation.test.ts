// tests/evidence-upload-compensation.test.ts
//
// M2-COMP-01 — a file upload that stores no bytes must not leave a row that
// reads as evidence.
//
// ---------------------------------------------------------------------------
// WHAT THE ORIGINAL DEFECT LOOKED LIKE, AND WHY IT WAS INVISIBLE
// ---------------------------------------------------------------------------
// `evidence_items` has RLS enabled and NO DELETE policy, while the DELETE
// privilege is granted through `uellix_writer`. PostgreSQL applies RLS as a
// scan filter, so the compensating `DELETE` was legal, matched nothing, and
// reported zero rows without raising. Measured on PG 17.6 as `uellix_app`:
//
//     INSERT 0 1      the row commits
//     DELETE 0        no error; the transaction COMMITs
//     SELECT          the row survives: status 'draft', file_path NULL
//
// A `draft` row with no file is counted by the SROI evidence gate, listed on
// the evidence screen, and published by the report verification query. That is
// the harm — not untidiness.
//
// ---------------------------------------------------------------------------
// HOW THESE TESTS MODEL RLS
// ---------------------------------------------------------------------------
// The row count is the only thing RLS changes here, so it is the thing the
// fake driver lets each test set. `compensationRows: []` IS "the policy
// filtered the row out"; `[{ id }]` is "the policy let it through". Both
// regimes are the ones measured against a real PostgreSQL, and neither is
// reachable by inspecting an error, which is the entire point.
//
// Every test in the first two blocks fails against the original code: it issued
// a DELETE, so no UPDATE is recorded and no row ever reaches 'archived'.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'

const PROJECT = '22222222-2222-4222-8222-222222222222'
const OTHER_PROJECT = '33333333-3333-4333-8333-333333333333'
const ORG = '44444444-4444-4444-8444-444444444444'
const EVIDENCE = '55555555-5555-4555-8555-555555555555'
const USER = '66666666-6666-4666-8666-666666666666'

const h = vi.hoisted(() => {
  const state = {
    project: null as Record<string, unknown> | null,
    insertThrows: false,
    uploadError: null as { message: string } | null,
    finalizeThrows: false,
    /** What the compensating UPDATE ... RETURNING comes back with. */
    compensationRows: [{ id: '55555555-5555-4555-8555-555555555555' }] as { id: string }[],
    compensationThrows: false,
    auditThrows: false,
  }
  const calls = {
    deletes: [] as unknown[],
    finalizeUpdates: [] as { values: Record<string, unknown> }[],
    compensationUpdates: [] as { values: Record<string, unknown>; predicate: unknown }[],
    uploads: [] as { path: string }[],
  }
  return { state, calls }
})

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn().mockResolvedValue({
    user: { id: '66666666-6666-4666-8666-666666666666' },
    organization: { id: '44444444-4444-4444-8444-444444444444' },
    membership: { role: 'analyst' },
  }),
}))

vi.mock('@/lib/auth/permissions', () => ({ hasRole: () => true }))

// Pass-through. The contexts themselves are proved against a live database in
// tests/authenticated-database-context.test.ts; what matters here is that the
// compensation opens one at all and reads the row count inside it.
vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationDatabaseContext: async (cb: () => unknown) => cb(),
}))

vi.mock('@/lib/pipeline/confidence-score', () => ({
  recalculateConfidenceScore: vi.fn(),
}))

const logAuditAction = vi.fn<(entry: Record<string, unknown>) => Promise<void>>(async () => {
  if (h.state.auditThrows) throw new Error('audit insert failed')
})
vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: (entry: unknown) => logAuditAction(entry as Record<string, unknown>),
  AUDIT_ACTIONS: {
    EVIDENCE_CREATED: 'evidence_item.created',
    EVIDENCE_UPLOAD_FAILED: 'evidence_item.upload_failed',
    EVIDENCE_ARCHIVED: 'evidence_item.archived',
    EVIDENCE_REVIEW_STATUS_CHANGED: 'evidence_item.review_status_changed',
    EVIDENCE_VERSION_CREATED: 'evidence_version.created',
    EVIDENCE_VERSION_INTEGRITY_VERIFIED: 'evidence_version.integrity_verified',
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    storage: {
      from: () => ({
        upload: async (path: string) => {
          h.calls.uploads.push({ path })
          return { error: h.state.uploadError }
        },
      }),
    },
  }),
}))

vi.mock('@/db/client', () => {
  const tableName = (t: unknown) =>
    (t as { _?: { name?: string } })?._?.name ??
    (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')]

  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          // FIBIU-04 — getLatestEvidenceVersion (lib/pipeline/evidence-versions.ts)
          // reads .where().orderBy().limit(); evidence_versions has no rows in
          // this fake driver (M2-COMP-01 is about the evidence_items row, not
          // version lineage), so it always returns [] — createEvidenceVersion
          // then computes ordinal=1, exactly the first-version case.
          const limitEmpty = { limit: async () => [] }
          return {
            where: () => ({
              limit: async () => (tableName(table) === 'projects' && h.state.project ? [h.state.project] : []),
              orderBy: () => limitEmpty,
            }),
          }
        },
      }),

      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => ({
          returning: async () => {
            if (h.state.insertThrows) throw new Error('insert failed')
            if (tableName(table) === 'evidence_versions') {
              return [{ id: 'ver-1', ordinal: 1, supersedesVersionId: null, ...vals }]
            }
            return [{ id: EVIDENCE, projectId: PROJECT, organizationId: ORG, filePath: null }]
          },
        }),
      }),

      // Recorded and never expected: a DELETE against this table erases nothing
      // and says nothing. Its absence is asserted directly.
      delete: () => ({
        where: async (predicate: unknown) => {
          h.calls.deletes.push(predicate)
          return []
        },
      }),

      update: () => ({
        set: (values: Record<string, unknown>) => ({
          // Awaited directly by phase 3; `.returning()` is the compensation.
          where: (predicate: unknown) => ({
            then: (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) => {
              h.calls.finalizeUpdates.push({ values })
              return h.state.finalizeThrows
                ? Promise.reject(new Error('finalize failed')).then(onOk, onErr)
                : Promise.resolve([]).then(onOk, onErr)
            },
            returning: async () => {
              h.calls.compensationUpdates.push({ values, predicate })
              if (h.state.compensationThrows) throw new Error('compensation statement failed')
              return h.state.compensationRows
            },
          }),
        }),
      }),
    },
  }
})

import * as evidenceModule from '@/lib/pipeline/evidence'
import { createFileEvidenceForProject, EvidenceUploadCompensationError } from '@/lib/pipeline/evidence'
import { evidenceItems } from '@/db/schema'

const INPUT = {
  title: 'Encuesta de salida',
  file: {
    name: 'encuesta.txt',
    mimeType: 'text/plain' as const,
    size: 12,
    buffer: Buffer.from('hola mundo\n\n', 'utf8'),
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.project = { id: PROJECT, organizationId: ORG }
  h.state.insertThrows = false
  h.state.uploadError = null
  h.state.finalizeThrows = false
  h.state.compensationRows = [{ id: EVIDENCE }]
  h.state.compensationThrows = false
  h.state.auditThrows = false
  h.calls.deletes.length = 0
  h.calls.finalizeUpdates.length = 0
  h.calls.compensationUpdates.length = 0
  h.calls.uploads.length = 0
})

const auditEntries = () => logAuditAction.mock.calls.map(([entry]) => entry)
const uploadFailedEntry = () =>
  auditEntries().find((entry) => entry.action === 'evidence_item.upload_failed')

/** The rejection reason, typed — `.catch(e => e)` alone widens to a union. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise
    throw new Error('expected the call to reject, but it resolved')
  } catch (error) {
    return error as Error & Record<string, unknown>
  }
}

/* -------------------------------------------------------------------------- */
/* The happy path is unchanged                                                */
/* -------------------------------------------------------------------------- */

describe('a stored upload still finalises and is still indexable', () => {
  it('writes the file path, logs the creation and compensates nothing', async () => {
    const evidence = await createFileEvidenceForProject(PROJECT, INPUT)

    expect(evidence.id).toBe(EVIDENCE)
    expect(h.calls.finalizeUpdates).toHaveLength(1)
    expect(h.calls.finalizeUpdates[0].values.filePath).toBe(`${PROJECT}/${EVIDENCE}/encuesta.txt`)
    expect(h.calls.compensationUpdates).toHaveLength(0)
    // FIBIU-04 (FIBC-006) — createFileEvidenceForProject now also creates the
    // evidence item's first dedicated version row (evidence_version.created),
    // alongside the pre-existing evidence_item.created event.
    expect(auditEntries().map((e) => e.action)).toEqual(['evidence_item.created', 'evidence_version.created'])
  })

  it('never issues a DELETE against evidence_items', async () => {
    await createFileEvidenceForProject(PROJECT, INPUT)
    expect(h.calls.deletes).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Storage failure                                                            */
/* -------------------------------------------------------------------------- */

describe('a failed storage upload withdraws its row', () => {
  beforeEach(() => {
    h.state.uploadError = { message: 'new row violates row-level security policy' }
  })

  it('archives the reserved row instead of deleting it', async () => {
    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow('Storage upload failed')

    expect(h.calls.deletes).toHaveLength(0)
    expect(h.calls.compensationUpdates).toHaveLength(1)
    expect(h.calls.compensationUpdates[0].values.status).toBe('archived')
  })

  it('scopes the compensation to the row, its project, its organisation, and to rows with no stored bytes', async () => {
    // The tenancy argument, stated as the statement itself. `file_path IS NULL`
    // is what makes the path incapable of touching stored evidence: measured on
    // PG 17.6, the same UPDATE against a row that HAS a path reports 0.
    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow()

    expect(h.calls.compensationUpdates[0].predicate).toEqual(
      and(
        eq(evidenceItems.id, EVIDENCE),
        eq(evidenceItems.projectId, PROJECT),
        eq(evidenceItems.organizationId, ORG),
        isNull(evidenceItems.filePath),
      ),
    )
  })

  it('records the withdrawal in the audit trail', async () => {
    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow()

    expect(uploadFailedEntry()).toMatchObject({
      entityType: 'evidence_item',
      entityId: EVIDENCE,
      organizationId: ORG,
      projectId: PROJECT,
      actorUserId: USER,
      contentModifying: true,
      afterJson: { stage: 'upload', compensated: true, status: 'archived' },
    })
    // W1-05-RM1 R-2: beforeJson is real (a read, not fabricated) — this
    // driver reports no prior row, so it is honestly null, never invented.
    expect(uploadFailedEntry()).toHaveProperty('beforeJson')
  })

  it('does not score the withdrawn row', async () => {
    // computeConfidenceScore gives a file row 35 points for its type alone, so
    // recalculating here would publish a positive confidence for a file that
    // does not exist.
    const { recalculateConfidenceScore } = await import('@/lib/pipeline/confidence-score')
    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow()
    expect(recalculateConfidenceScore).not.toHaveBeenCalled()
  })

  it('reports the storage failure, not the compensation, when the compensation worked', async () => {
    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow(
      'Storage upload failed: new row violates row-level security policy',
    )
  })
})

/* -------------------------------------------------------------------------- */
/* The defect itself: a compensation that touches nothing                     */
/* -------------------------------------------------------------------------- */

describe('a compensation that affects zero rows is a failure, not a success', () => {
  beforeEach(() => {
    h.state.uploadError = { message: 'storage is unreachable' }
    h.state.compensationRows = [] // exactly what RLS does with no DELETE policy
  })

  it('throws EvidenceUploadCompensationError rather than the storage error', async () => {
    // THIS is the assertion the original code cannot pass: it awaited a DELETE
    // that reported zero rows and threw the storage error as if compensation
    // had happened.
    const failure = await rejectionOf(createFileEvidenceForProject(PROJECT, INPUT))

    expect(failure).toBeInstanceOf(EvidenceUploadCompensationError)
    expect(failure.code).toBe('EVIDENCE_COMPENSATION_NOT_APPLIED')
    expect(failure.stage).toBe('upload')
    expect(failure.evidenceId).toBe(EVIDENCE)
  })

  it('leaves the surviving row named in the audit trail', async () => {
    // The only durable record that a row was left behind. It is written before
    // the throw, and from its own context, so the throw cannot discard it.
    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow()

    expect(uploadFailedEntry()).toMatchObject({
      entityId: EVIDENCE,
      afterJson: { stage: 'upload', compensated: false, status: null },
    })
  })

  it('does not leak the storage message into the compensation error', async () => {
    const failure = await rejectionOf(createFileEvidenceForProject(PROJECT, INPUT))
    expect(failure.message).not.toContain('storage is unreachable')
  })
})

/* -------------------------------------------------------------------------- */
/* Failures of the compensation machinery itself                              */
/* -------------------------------------------------------------------------- */

describe('the compensation cannot fail quietly either', () => {
  it('propagates an error raised by the compensating statement', async () => {
    h.state.uploadError = { message: 'boom' }
    h.state.compensationThrows = true

    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow(
      'compensation statement failed',
    )
  })

  it('still reports a successful compensation when only the audit write fails', async () => {
    // The trail is best-effort; the verdict is not. A lost audit row must not
    // turn a compensation that worked into a reported failure.
    h.state.uploadError = { message: 'boom' }
    h.state.auditThrows = true

    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow('Storage upload failed')
  })

  it('still reports a failed compensation when the audit write also fails', async () => {
    h.state.uploadError = { message: 'boom' }
    h.state.auditThrows = true
    h.state.compensationRows = []

    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toBeInstanceOf(
      EvidenceUploadCompensationError,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* The other two ways out                                                     */
/* -------------------------------------------------------------------------- */

describe('the earlier and later failures', () => {
  it('compensates nothing when the row was never inserted', async () => {
    h.state.insertThrows = true

    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow('insert failed')

    expect(h.calls.uploads).toHaveLength(0)
    expect(h.calls.compensationUpdates).toHaveLength(0)
    expect(h.calls.deletes).toHaveLength(0)
  })

  it('withdraws the row when finalisation fails after a successful upload', async () => {
    // One transaction, so there is no partial finalise: the row still has no
    // file path and nothing can rediscover the object from it.
    h.state.finalizeThrows = true

    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow('finalize failed')

    expect(h.calls.uploads).toHaveLength(1)
    expect(h.calls.compensationUpdates).toHaveLength(1)
    expect(h.calls.compensationUpdates[0].values.status).toBe('archived')
    expect(uploadFailedEntry()).toMatchObject({ afterJson: { stage: 'finalize', compensated: true } })
  })

  it('raises the compensation failure over the finalisation failure', async () => {
    h.state.finalizeThrows = true
    h.state.compensationRows = []

    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toBeInstanceOf(
      EvidenceUploadCompensationError,
    )
  })

  it('refuses before any row exists when the project is not the caller organisation\'s', async () => {
    // The cross-project case cannot reach the compensation at all: phase 1
    // verifies ownership before it inserts, so there is nothing to compensate
    // and no statement aimed at another tenant's row.
    h.state.project = { id: OTHER_PROJECT, organizationId: 'ffffffff-0000-4000-8000-00000000000f' }

    await expect(createFileEvidenceForProject(OTHER_PROJECT, INPUT)).rejects.toThrow(
      'Project does not belong to your organization',
    )

    expect(h.calls.compensationUpdates).toHaveLength(0)
    expect(h.calls.uploads).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Repeated compensation                                                      */
/* -------------------------------------------------------------------------- */

describe('compensating twice', () => {
  it('is idempotent: the second pass matches the same row and changes nothing', async () => {
    h.state.uploadError = { message: 'boom' }

    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow('Storage upload failed')
    await expect(createFileEvidenceForProject(PROJECT, INPUT)).rejects.toThrow('Storage upload failed')

    expect(h.calls.compensationUpdates).toHaveLength(2)
    expect(h.calls.compensationUpdates[0].predicate).toEqual(h.calls.compensationUpdates[1].predicate)
    // `status = 'archived'` over a row already archived is the same row and the
    // same value; the guard that matters is `file_path IS NULL`, which keeps a
    // repeat from ever reaching a row that acquired bytes in between.
    expect(h.calls.compensationUpdates[1].values.status).toBe('archived')
  })
})

/* -------------------------------------------------------------------------- */
/* No new client-callable primitive                                           */
/* -------------------------------------------------------------------------- */

describe('the compensation is not a capability', () => {
  it('is not exported, so nothing outside the service can aim it at a row', async () => {
    // Phase E: fixing compensation must not create a general "withdraw this
    // evidence id" primitive that a stale client, or any client, can call.
    expect(Object.keys(evidenceModule)).not.toContain('compensateFailedFileUpload')

    const exportedFunctions = Object.entries(evidenceModule)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
    expect(exportedFunctions).not.toContain('deleteEvidenceForProject')
  })
})

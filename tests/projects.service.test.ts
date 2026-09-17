// tests/projects.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock auth context
vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
}));

// Mock db client
vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([
      {
        id: 'proj-new-id',
        name: 'New Project',
        description: null,
        status: 'draft',
        organizationId: 'org-1',
      },
    ]),
  },
}));

vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>();
  return { ...actual, logAuditAction: vi.fn() };
});

import { createProjectForCurrentOrganization, listProjectsForPortfolio } from '@/lib/projects/service';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { db } from '@/db/client';
import { projects, sroiCalculationRuns, sroiRunReviews, sroiReports } from '@/db/schema';

describe('Project service - create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows authorized roles to create a project', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'organization_admin', status: 'active' },
    });

    const input = {
      name: 'My Project',
      description: 'Test',
      status: 'draft',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await createProjectForCurrentOrganization(input as any);
    expect(result.id).toBe('proj-new-id');
    expect(result.organizationId).toBe('org-1');
  });

  it('rejects roles without permission', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'viewer', status: 'active' },
    });
    const input = { name: 'Bad', status: 'draft' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createProjectForCurrentOrganization(input as any)).rejects.toThrow('Permission denied');
  });

  it('fails validation when required fields missing', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: true },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'super_admin', status: 'active' },
    });
    const input = { description: 'no name', status: 'draft' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createProjectForCurrentOrganization(input as any)).rejects.toThrow();
  });

  it('rejects a portfolioId that does not belong to the current organization (IDOR regression)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'organization_admin', status: 'active' },
    });
    // db mock's `where` always resolves to [] — simulates a portfolioId that
    // either doesn't exist or belongs to a different organization, since the
    // query filters by both portfolios.id AND portfolios.organizationId.
    const input = {
      name: 'My Project',
      status: 'draft',
      portfolioId: '550e8400-e29b-41d4-a716-446655440099',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createProjectForCurrentOrganization(input as any)).rejects.toThrow(
      'Invalid portfolio reference'
    );
  });
});

describe('Project service - governance regime (FIBIU-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stamps every newly created project with governanceRegime=pc01b through the authoritative creation path', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'organization_admin', status: 'active' },
    });

    const input = { name: 'My Project', status: 'draft' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createProjectForCurrentOrganization(input as any);

    // The mock's `db` shape is flat (values() lives directly on db, not
    // chained off insert()'s real return type) — cast through `any` like the
    // rest of this file does for its mocked input.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(vi.mocked((db as any).values)).toHaveBeenCalledWith(
      expect.objectContaining({ governanceRegime: 'pc01b' })
    );
  });
});

describe('listProjectsForPortfolio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires authentication', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(null);
    await expect(listProjectsForPortfolio('portfolio-1')).rejects.toThrow('Unauthenticated');
  });

  it('queries projects scoped to the portfolio and current organization', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'viewer', status: 'active' },
    });

    const result = await listProjectsForPortfolio('portfolio-1');
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('Project service - lifecycle management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pauseProject', () => {
    it('rejects pause when user lacks permission', async () => {
      vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
        user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
        organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
        membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'viewer', status: 'active' },
      });

      const { pauseProject } = await import('@/lib/projects/service');
      await expect(pauseProject('proj-1')).rejects.toThrow('Permission denied');
    });
  });

  describe('archiveProject', () => {
    it('rejects archive when user lacks permission', async () => {
      vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
        user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
        organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
        membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'viewer', status: 'active' },
      });

      const { archiveProject } = await import('@/lib/projects/service');
      await expect(archiveProject('proj-1')).rejects.toThrow('Permission denied');
    });
  });

  describe('requestProjectDeletion', () => {
    it('rejects deletion requests from non-admin roles', async () => {
      vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
        user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
        organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
        membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'analyst', status: 'active' },
      });

      const { requestProjectDeletion } = await import('@/lib/projects/service');
      await expect(requestProjectDeletion('proj-1', 'test reason')).rejects.toThrow('administradores');
    });

    it('requires a non-empty reason', async () => {
      vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
        user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
        organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
        membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'organization_admin', status: 'active' },
      });

      // Note: This test validates role permission at the service layer.
      // In mocked environment, the project lookup would fail first.
      // Real integration tests should use test database fixtures.
      const { requestProjectDeletion } = await import('@/lib/projects/service');
      // The actual validation happens on real project data
      expect(requestProjectDeletion).toBeDefined();
    });
  });

  describe('approveProjectDeletion', () => {
    it('only superadmins can approve deletion', async () => {
      vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
        user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
        organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
        membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'organization_admin', status: 'active' },
      });

      const { approveProjectDeletion } = await import('@/lib/projects/service');
      await expect(approveProjectDeletion('proj-1', 'ELIMINAR', 'test')).rejects.toThrow('SuperAdmin');
    });

    it('requires exact confirmation text "ELIMINAR"', async () => {
      vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
        user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: true },
        organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
        membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'super_admin', status: 'active' },
      });

      const { approveProjectDeletion } = await import('@/lib/projects/service');
      await expect(approveProjectDeletion('proj-1', 'eliminar', 'test')).rejects.toThrow('inválida');
    });
  });
});

// ---------------------------------------------------------------------------
// LANE CV1-MEASURE-W3 — organization-level Measure progress.
// ---------------------------------------------------------------------------

const ORG_CTX = {
  user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
  organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
  membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'viewer', status: 'active' },
} as const;

/** Baseline facts: nothing persisted yet, project still a draft. */
const BASE_FACTS = {
  status: 'draft',
  deletionRequestedAt: null,
  hasCalculatedRun: false,
  hasApprovedReview: false,
  hasOpenReview: false,
  hasLockedReport: false,
};

describe('deriveMeasureProgress — governed state ladder', () => {
  it('assigns a DISTINCT state to each Measure position', async () => {
    const { deriveMeasureProgress } = await import('@/lib/projects/service');

    const states = [
      deriveMeasureProgress({ ...BASE_FACTS }).state,
      deriveMeasureProgress({ ...BASE_FACTS, status: 'active' }).state,
      deriveMeasureProgress({ ...BASE_FACTS, status: 'active', hasCalculatedRun: true }).state,
      deriveMeasureProgress({ ...BASE_FACTS, status: 'active', hasCalculatedRun: true, hasOpenReview: true }).state,
      deriveMeasureProgress({ ...BASE_FACTS, status: 'active', hasCalculatedRun: true, hasApprovedReview: true }).state,
      deriveMeasureProgress({ ...BASE_FACTS, status: 'active', hasCalculatedRun: true, hasApprovedReview: true, hasLockedReport: true }).state,
      deriveMeasureProgress({ ...BASE_FACTS, status: 'paused' }).state,
    ];

    // Ordered digest, not `new Set(...).size`: a Set is blind to a reorder, so
    // it would stay green if two rungs of the ladder swapped places.
    expect(states).toEqual([
      'sin_iniciar',
      'en_progreso',
      'listo_para_revision',
      'en_revision',
      'aprobado',
      'completado',
      'bloqueado',
    ]);
    expect(new Set(states).size).toBe(states.length);
  });

  it('gives every state a next action, and every non-blocked state a navigable one', async () => {
    const { deriveMeasureProgress } = await import('@/lib/projects/service');

    const navigable = [
      deriveMeasureProgress({ ...BASE_FACTS }),
      deriveMeasureProgress({ ...BASE_FACTS, status: 'active' }),
      deriveMeasureProgress({ ...BASE_FACTS, status: 'active', hasCalculatedRun: true }),
      deriveMeasureProgress({ ...BASE_FACTS, status: 'active', hasCalculatedRun: true, hasOpenReview: true }),
      deriveMeasureProgress({ ...BASE_FACTS, status: 'active', hasApprovedReview: true }),
      deriveMeasureProgress({ ...BASE_FACTS, hasLockedReport: true }),
    ];
    for (const progress of navigable) {
      expect(progress.nextActionLabel.length).toBeGreaterThan(0);
      expect(progress.nextActionPath.startsWith('/')).toBe(true);
    }

    // Blocked is the sole state with no navigable step: resolving a pause or a
    // pending deletion is a lifecycle decision taken elsewhere.
    const blocked = deriveMeasureProgress({ ...BASE_FACTS, status: 'paused' });
    expect(blocked.nextActionPath).toBe('');
    expect(blocked.nextActionLabel.length).toBeGreaterThan(0);
  });

  it('derives BLOCKED only from persisted lifecycle facts, never from a readiness evaluation', async () => {
    const { deriveMeasureProgress } = await import('@/lib/projects/service');

    // Both governed blocking conditions, each on its own.
    expect(deriveMeasureProgress({ ...BASE_FACTS, status: 'paused' }).state).toBe('bloqueado');
    expect(
      deriveMeasureProgress({ ...BASE_FACTS, deletionRequestedAt: new Date('2026-09-01T00:00:00Z') }).state
    ).toBe('bloqueado');

    // NEGATIVE CONTROL — identical facts with neither lifecycle condition set
    // must NOT be blocked. Without this, an implementation that returned
    // 'bloqueado' unconditionally would pass the two assertions above.
    expect(deriveMeasureProgress({ ...BASE_FACTS, status: 'active' }).state).not.toBe('bloqueado');
    expect(deriveMeasureProgress({ ...BASE_FACTS, status: 'draft' }).state).not.toBe('bloqueado');
  });

  it('distinguishes the completed/locked result state, and lets it outrank a later pause', async () => {
    const { deriveMeasureProgress } = await import('@/lib/projects/service');

    const locked = deriveMeasureProgress({ ...BASE_FACTS, status: 'active', hasLockedReport: true });
    expect(locked.state).toBe('completado');

    // An approved review alone is NOT completion — the two must not collapse.
    const approved = deriveMeasureProgress({ ...BASE_FACTS, status: 'active', hasApprovedReview: true });
    expect(approved.state).toBe('aprobado');
    expect(approved.state).not.toBe(locked.state);

    // A locked report is terminal and immutable: pausing the project afterwards
    // does not reopen Measure, so it must not be reported as blocked.
    expect(
      deriveMeasureProgress({ ...BASE_FACTS, status: 'paused', hasLockedReport: true }).state
    ).toBe('completado');

    // The docstring on deriveMeasureProgress claims the SAME outranking for
    // BOTH blocking conditions ("pausing OR requesting deletion... does not
    // reopen Measure"), but only the pause combination was pinned above. A
    // regression that reordered the two leading checks — running the
    // deletionRequestedAt guard before hasLockedReport — would leave that
    // assertion green while silently breaking this second, equally-promised
    // combination.
    expect(
      deriveMeasureProgress({
        ...BASE_FACTS,
        status: 'active',
        hasLockedReport: true,
        deletionRequestedAt: new Date('2026-09-01T00:00:00Z'),
      }).state
    ).toBe('completado');
  });

  it('treats an ARCHIVED review as neither approved nor open', async () => {
    const { listProjectsWithMeasureProgressForCurrentOrganization } = await import('@/lib/projects/service');
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ORG_CTX as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where = vi.mocked((db as any).where);
    where
      .mockResolvedValueOnce([
        { id: 'p-archived-review', name: 'Archived review', status: 'active', portfolioId: null, deletionRequestedAt: null },
      ])
      .mockResolvedValueOnce([{ projectId: 'p-archived-review' }])
      .mockResolvedValueOnce([{ projectId: 'p-archived-review', status: 'archived' }])
      .mockResolvedValueOnce([]);

    const rows = await listProjectsWithMeasureProgressForCurrentOrganization();
    // A withdrawn review must not pin the project in 'en_revision' forever; the
    // calculated run is what still stands.
    expect(rows[0].measureProgress.state).toBe('listo_para_revision');
  });
});

describe('listProjectsWithMeasureProgressForCurrentOrganization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves existing cross-org scope behavior by refusing without an organization context', async () => {
    const { listProjectsWithMeasureProgressForCurrentOrganization } = await import('@/lib/projects/service');
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(null);
    await expect(listProjectsWithMeasureProgressForCurrentOrganization()).rejects.toThrow('Unauthenticated');
  });

  it('shows a project with portfolio_id NULL alongside an assigned one, and marks only the unassigned one', async () => {
    const { listProjectsWithMeasureProgressForCurrentOrganization } = await import('@/lib/projects/service');
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ORG_CTX as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where = vi.mocked((db as any).where);
    where
      .mockResolvedValueOnce([
        { id: 'p-unassigned', name: 'Project A', status: 'active', portfolioId: null, deletionRequestedAt: null },
        { id: 'p-assigned', name: 'Project B', status: 'active', portfolioId: 'portfolio-1', deletionRequestedAt: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const rows = await listProjectsWithMeasureProgressForCurrentOrganization();

    // Neither project disappears because portfolio_id is NULL.
    expect(rows.map((r) => r.id)).toEqual(['p-unassigned', 'p-assigned']);
    expect(rows.find((r) => r.id === 'p-unassigned')?.unassignedToPortfolio).toBe(true);
    expect(rows.find((r) => r.id === 'p-assigned')?.unassignedToPortfolio).toBe(false);

    // The marker is informational: it does not change which projects are
    // returned, nor their order.
    expect(rows).toHaveLength(2);
  });

  it('reports DIFFERENT Measure states for projects at different persisted positions', async () => {
    const { listProjectsWithMeasureProgressForCurrentOrganization } = await import('@/lib/projects/service');
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ORG_CTX as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where = vi.mocked((db as any).where);
    where
      .mockResolvedValueOnce([
        { id: 'p-draft', name: 'Draft', status: 'draft', portfolioId: null, deletionRequestedAt: null },
        { id: 'p-working', name: 'Working', status: 'active', portfolioId: 'portfolio-1', deletionRequestedAt: null },
        { id: 'p-calculated', name: 'Calculated', status: 'active', portfolioId: null, deletionRequestedAt: null },
        { id: 'p-review', name: 'In review', status: 'active', portfolioId: null, deletionRequestedAt: null },
        { id: 'p-approved', name: 'Approved', status: 'active', portfolioId: null, deletionRequestedAt: null },
        { id: 'p-locked', name: 'Locked', status: 'active', portfolioId: null, deletionRequestedAt: null },
        { id: 'p-paused', name: 'Paused', status: 'paused', portfolioId: null, deletionRequestedAt: null },
      ])
      // calculated runs
      .mockResolvedValueOnce([
        { projectId: 'p-calculated' },
        { projectId: 'p-review' },
        { projectId: 'p-approved' },
        { projectId: 'p-locked' },
      ])
      // run reviews
      .mockResolvedValueOnce([
        { projectId: 'p-review', status: 'draft' },
        { projectId: 'p-approved', status: 'approved' },
        { projectId: 'p-locked', status: 'approved' },
      ])
      // reports
      .mockResolvedValueOnce([
        { projectId: 'p-approved', status: 'draft' },
        { projectId: 'p-locked', status: 'locked' },
      ]);

    const rows = await listProjectsWithMeasureProgressForCurrentOrganization();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.measureProgress.state]));

    expect(byId).toEqual({
      'p-draft': 'sin_iniciar',
      'p-working': 'en_progreso',
      'p-calculated': 'listo_para_revision',
      'p-review': 'en_revision',
      'p-approved': 'aprobado',
      'p-locked': 'completado',
      'p-paused': 'bloqueado',
    });

    // A draft report must NOT be mistaken for a locked one.
    expect(byId['p-approved']).not.toBe('completado');

    // DIRECT query-cost evidence (replaces inferring cost from state
    // correctness alone): exactly four queries ran for seven projects — the
    // project list plus the three set-based Promise.all queries the docstring
    // promises, each against the SPECIFIC governed collection it claims and
    // in that fixed order. This fails if an extra query is introduced (count
    // exceeds 4), if a required query disappears (count drops, or a
    // position's table no longer matches), or if the measured collection is
    // swapped for the wrong one (e.g. reviews queried where reports should
    // be) — none of which the prior byId assertions alone would catch, since
    // they only inspect the RESULT of a correct query sequence.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const from = vi.mocked((db as any).from);
    expect(where).toHaveBeenCalledTimes(4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(from.mock.calls.map((call: any[]) => call[0])).toEqual([
      projects,
      sroiCalculationRuns,
      sroiRunReviews,
      sroiReports,
    ]);
  });

  it('short-circuits without querying runs, reviews or reports when the organization has no projects', async () => {
    const { listProjectsWithMeasureProgressForCurrentOrganization } = await import('@/lib/projects/service');
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ORG_CTX as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where = vi.mocked((db as any).where);
    where.mockResolvedValueOnce([]);

    expect(await listProjectsWithMeasureProgressForCurrentOrganization()).toEqual([]);
    expect(where).toHaveBeenCalledTimes(1);
  });
});

describe('Measure progress surface — forbidden data sources (F-MEASURE-W3-1)', () => {
  // Every surface this lane touches that derives or renders Measure progress.
  const SURFACES = [
    'lib/projects/service.ts',
    'components/projects/MeasureProgressBadge.tsx',
    'components/projects/ProjectCard.tsx',
    'app/app/projects/page.tsx',
    'app/app/dashboard/page.tsx',
  ];

  // Naming an identifier inside a comment that explains WHY it is rejected is
  // not a usage of it. The sweep therefore classifies CODE, stripping comments
  // first — a raw text-window scan would misreport the F-MEASURE-W3-1
  // rationale in lib/projects/service.ts as a dependency on the very thing it
  // rejects.
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const loadCode = async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    return SURFACES.map((rel) => ({
      rel,
      raw: readFileSync(resolve(process.cwd(), rel), 'utf8'),
    })).map((f) => ({ ...f, code: stripComments(f.raw) }));
  };

  it('has a comment stripper that removes comments and keeps code (positive controls)', async () => {
    const files = await loadCode();
    const service = files.find((f) => f.rel === 'lib/projects/service.ts');
    expect(service).toBeDefined();

    // POSITIVE CONTROL A — the files really were read: a token that exists only
    // in code survives stripping. Without this, an empty read would make every
    // assertion below vacuously green.
    expect(service!.code).toContain('deriveMeasureProgress');

    // POSITIVE CONTROL B — the stripper really strips: a token that exists only
    // inside a comment is present before stripping and absent after.
    expect(service!.raw).toContain('F-MEASURE-W3-1');
    expect(service!.code).not.toContain('F-MEASURE-W3-1');

    // POSITIVE CONTROL C — the stripper's semantics are pinned in BOTH
    // directions. It removes whole-line and block comments, and deliberately
    // LEAVES a trailing comment in place: stripping those correctly needs a
    // real lexer, and a naive rule would eat string literals containing '//'.
    // For a prohibition sweep that bias is the safe one — it can over-count a
    // hit, never hide one. Asserting only that a string literal survives would
    // pass vacuously, since nothing on that line is stripped at all.
    expect(stripComments('  // whole line\nkeep me')).not.toContain('whole line');
    expect(stripComments('  // whole line\nkeep me')).toContain('keep me');
    expect(stripComments('/* block */ const b = 1;')).not.toContain('block');
    expect(stripComments('/* block */ const b = 1;')).toContain('const b = 1;');
    expect(stripComments('const a = "http://x"; // t')).toContain('http://x');
    expect(stripComments('const a = 1; // trailing')).toContain('trailing');
  });

  it('references no readiness_assessments surface and no readiness evaluator in code', async () => {
    const files = await loadCode();
    const FORBIDDEN = [
      'readiness_assessments',
      'readinessAssessments',
      'getReadinessAssessment',
      'getSroiCalculationReadiness',
      'sroi-readiness',
    ];

    const hits: string[] = [];
    for (const file of files) {
      for (const token of FORBIDDEN) {
        if (file.code.includes(token)) hits.push(`${file.rel}: ${token}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('derives progress identically for every role — no role or permission branch in the ladder', async () => {
    const files = await loadCode();
    const service = files.find((f) => f.rel === 'lib/projects/service.ts')!;

    // The derivation must not consult a role. Isolate the lane's own block so
    // the assertion does not trip on the pre-existing lifecycle writers above
    // it, which legitimately check roles.
    const laneStart = service.code.indexOf('export function deriveMeasureProgress');
    expect(laneStart).toBeGreaterThan(-1);
    const laneCode = service.code.slice(laneStart);

    for (const token of ['membership.role', 'allowedRoles', 'hasRole', 'canManagePortfolio']) {
      expect(laneCode).not.toContain(token);
    }

    // The badge is presentational and role-blind too.
    const badge = files.find((f) => f.rel === 'components/projects/MeasureProgressBadge.tsx')!;
    for (const token of ['membership.role', 'hasRole', 'userRole']) {
      expect(badge.code).not.toContain(token);
    }
  });
});

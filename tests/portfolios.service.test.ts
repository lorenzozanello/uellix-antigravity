// tests/portfolios.service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock context
vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'new-id', name: 'Test', description: null, status: 'active' }]),
  },
}));

vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>();
  return { ...actual, logAuditAction: vi.fn() };
});

import { readFileSync } from 'node:fs';
import {
  createPortfolioForCurrentOrganization,
  updatePortfolioForCurrentOrganization,
  archivePortfolioForCurrentOrganization,
} from '@/lib/portfolios/service';
import {
  assignProjectToPortfolioForCurrentOrganization,
  unassignProjectFromPortfolioForCurrentOrganization,
  moveProjectToPortfolioForCurrentOrganization,
} from '@/lib/projects/service';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { db as typedDb } from '@/db/client';

// The mocked module shape (vi.mock above) does not match the real
// PostgresJsDatabase type; these tests reach into the mock's own vi.fn()s
// directly, which the real type does not expose.
const db = typedDb as unknown as Record<'where' | 'set' | 'returning' | 'values', ReturnType<typeof vi.fn>>;

/**
 * A real drizzle query builder is both awaitable (a select's terminal
 * `.where(...)` resolves directly) and chainable (an update's `.where(...)`
 * is followed by `.returning()`). This mock's `where` is called from both
 * shapes in these tests, so it must satisfy both: thenable for a direct
 * `await ...where(...)`, and exposing `.returning()` for the update chain.
 */
function mockWhereResult(selectArray: unknown[], returningArray: unknown[]) {
  return {
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(selectArray).then(resolve, reject),
    returning: vi.fn().mockResolvedValue(returningArray),
  };
}

function mockContext(role: string) {
  vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
    user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
    organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
    membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: role as never, status: 'active' },
  });
}

describe('Portfolio service - create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows authorized roles to create', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'impact_manager', status: 'active' },
    });

    const input = { name: 'My Portfolio', description: 'desc' };
    const result = await createPortfolioForCurrentOrganization(input);
    expect(result.id).toBe('new-id');
    expect(result.name).toBe('Test');
  });

  it('rejects roles without permission', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'viewer', status: 'active' },
    });
    const input = { name: 'Bad', description: '' };
    await expect(createPortfolioForCurrentOrganization(input)).rejects.toThrow('Permission denied');
  });

  it('fails validation when name missing', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'user-1', email: 'test@example.com', fullName: null, avatarUrl: null, isSuperAdmin: true },
      organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'super_admin', status: 'active' },
    });
    const input = { description: 'no name' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createPortfolioForCurrentOrganization(input as any)).rejects.toThrow();
  });
});

// PORTFOLIO_PF2_EXECUTION_AUTHORITY_v1.0.0.json — composition, lifecycle,
// permissions. Cross-organization, archived-refusal and zero-row-move
// behaviors are proven against a real PostgreSQL instance in
// tests/postgres/portfolio-composition.pg.test.ts (POSTGRES_CONTRACT); the
// controls below are the ones a mocked unit test proves well: permission
// denial (fails before any db call), the status input contract, and the
// verb/entityType each governed write emits.
describe('Portfolio service - update (PF2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.where.mockReturnValue(
      mockWhereResult(
        [{ id: 'p1', organizationId: 'org-1', name: 'Old name', description: 'Old desc', status: 'active' }],
        [{ id: 'p1', organizationId: 'org-1', name: 'New name', description: 'New desc', status: 'active' }],
      ) as never,
    );
  });

  it('NEG-PERM-1: denies analyst', async () => {
    mockContext('analyst');
    await expect(updatePortfolioForCurrentOrganization('p1', { name: 'x' })).rejects.toThrow('Permission denied');
  });

  it('POS-COMP-2: allows impact_manager and emits portfolio.updated against entityType portfolio', async () => {
    mockContext('impact_manager');
    const result = await updatePortfolioForCurrentOrganization('p1', { name: 'New name', description: 'New desc' });
    expect(result.name).toBe('New name');
    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(vi.mocked(logAuditAction)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'portfolio.updated', entityType: 'portfolio', contentModifying: true }),
    );
  });

  it('PF2-NEG-STATUS-1: a status field supplied to update is not written', async () => {
    mockContext('impact_manager');
    await updatePortfolioForCurrentOrganization('p1', { name: 'x', status: 'archived' } as never);
    const setCallArgs = db.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setCallArgs).not.toHaveProperty('status');
  });
});

describe('Portfolio service - archive (PF2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.where.mockReturnValue(
      mockWhereResult(
        [{ id: 'p1', organizationId: 'org-1', name: 'Name', description: null, status: 'active' }],
        [{ id: 'p1', organizationId: 'org-1', name: 'Name', description: null, status: 'archived' }],
      ) as never,
    );
  });

  it('NEG-PERM-1: denies analyst', async () => {
    mockContext('analyst');
    await expect(archivePortfolioForCurrentOrganization('p1')).rejects.toThrow('Permission denied');
  });

  it('POS-COMP-2 / POS-COMP-4: archiving writes only status, emits portfolio.archived', async () => {
    mockContext('impact_manager');
    const result = await archivePortfolioForCurrentOrganization('p1');
    expect(result.status).toBe('archived');
    const setCallArgs = db.set.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(setCallArgs).sort()).toEqual(['status', 'updatedAt'].sort());
    const { logAuditAction } = await import('@/lib/audit/logger');
    expect(vi.mocked(logAuditAction)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'portfolio.archived', entityType: 'portfolio', contentModifying: true }),
    );
  });

  it('PF2-NEG-UNARCHIVE-1: refuses to re-archive an already-archived portfolio (no unarchive path exists)', async () => {
    db.where.mockReturnValue(
      mockWhereResult(
        [{ id: 'p1', organizationId: 'org-1', name: 'Name', description: null, status: 'archived' }],
        [],
      ) as never,
    );
    mockContext('impact_manager');
    await expect(archivePortfolioForCurrentOrganization('p1')).rejects.toThrow('ya está archivado');
  });
});

describe('Portfolio composition - assign/unassign/move permission gate (PF2 NEG-PERM-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('denies analyst on assign', async () => {
    mockContext('analyst');
    await expect(assignProjectToPortfolioForCurrentOrganization('proj-1', 'p1')).rejects.toThrow('Permission denied');
  });

  it('denies analyst on unassign', async () => {
    mockContext('analyst');
    await expect(unassignProjectFromPortfolioForCurrentOrganization('proj-1', 'p1')).rejects.toThrow(
      'Permission denied',
    );
  });

  it('denies analyst on move', async () => {
    mockContext('analyst');
    await expect(moveProjectToPortfolioForCurrentOrganization('proj-1', 'p1', 'p2')).rejects.toThrow(
      'Permission denied',
    );
  });
});

describe('NEG-PERM-3: no inline role array survives on any Portfolio composition path', () => {
  // The historical defect named by the authority: lib/portfolios/
  // service.ts:41, app/app/portfolios/page.tsx:22 and app/app/portfolios/
  // new/page.tsx:17-19 each carried the identical four-element array
  // including 'analyst'. Every Portfolio COMPOSITION gate must now consult
  // canManagePortfolio instead. lib/projects/service.ts is deliberately
  // excluded from this check: its own inline role arrays gate unrelated
  // project-lifecycle actions (create, pause, resume, archive, delete) that
  // are outside PF2's scope — only the three new composition functions this
  // mission adds to that file (assign/unassign/move) are in scope, and they
  // are covered by the permission-gate describe block above.
  const INLINE_ARRAY_PATTERN = /\[\s*['"]super_admin['"]\s*,\s*['"]organization_admin['"]\s*,\s*['"]impact_manager['"]\s*,\s*['"]analyst['"]\s*\]/;

  const PORTFOLIO_COMPOSITION_PATHS = [
    'lib/portfolios/service.ts',
    'app/app/portfolios/page.tsx',
    'app/app/portfolios/new/page.tsx',
    'app/app/portfolios/[portfolioId]/page.tsx',
    'app/app/portfolios/[portfolioId]/actions.ts',
  ];

  it.each(PORTFOLIO_COMPOSITION_PATHS)('%s carries no inline four-role composition array', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(INLINE_ARRAY_PATTERN.test(source)).toBe(false);
  });
});

// FIBIU-17 (FIBC-021, W2-B5, HPO-ODS-W2-17) — this file's own readiness-
// adjacent control: the portfolio-level readiness statistic
// getPortfolioAnalytics surfaces is explicitly labelled
// LEGACY_NON_AUTHORITATIVE, never presented as canonical FIBC-021 readiness.
// aggregatePortfolioSroi is pure and needs no DB mock beyond this file's own.
describe('Portfolio service - readiness disposition', () => {
  it('the readiness statistic is presented as LEGACY_NON_AUTHORITATIVE, never canonical readiness', async () => {
    const { aggregatePortfolioSroi } = await import('@/lib/portfolios/analytics');
    const result = aggregatePortfolioSroi([]);
    expect(result.readinessSource).toBe('LEGACY_NON_AUTHORITATIVE');
  });
});

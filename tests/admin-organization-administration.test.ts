/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/admin-organization-administration.test.ts
//
// The wrapper that replaced `db.update(organizations)` for the two
// administrative columns (RR-CAP-10-A). What matters here is not that it
// issues a query — it is WHICH query, with what validated, and what the caller
// learns when the capability refuses.
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const executed = vi.hoisted(() => ({ calls: [] as any[], fail: false }));

vi.mock('@/db/client', () => ({
  db: {
    execute: vi.fn().mockImplementation((q: unknown) => {
      executed.calls.push(q);
      if (executed.fail) return Promise.reject(new Error('permission denied for table organizations'));
      return Promise.resolve([]);
    }),
  },
}));

import {
  callAdminSetStellaService,
  callAdminSetOrganizationStatus,
  OrganizationAdministrationError,
} from '@/lib/admin/organization-administration';

const ORG = '11111111-1111-4111-8111-111111111111';

/** The SQL drizzle would emit, flattened enough to assert the function name on. */
const lastSql = () => JSON.stringify(executed.calls[executed.calls.length - 1]);

beforeEach(() => {
  vi.clearAllMocks();
  executed.calls = [];
  executed.fail = false;
});

describe('callAdminSetStellaService', () => {
  it('calls the definer function, not an UPDATE', async () => {
    await callAdminSetStellaService(ORG, { monthlyQuota: 100, planLabel: 'Enterprise' });

    expect(executed.calls).toHaveLength(1);
    expect(lastSql()).toContain('admin_set_stella_service');
    expect(lastSql()).not.toContain('update');
  });

  it('carries a null quota through: the runtime reads null as unlimited', async () => {
    await callAdminSetStellaService(ORG, { monthlyQuota: null });
    expect(executed.calls).toHaveLength(1);
  });

  it('refuses a non-UUID organization id before touching the database', async () => {
    // The binding would be safe either way; the point is that an unparseable
    // client-supplied field fails as input validation, not as a type error
    // surfaced from the driver.
    await expect(
      callAdminSetStellaService('org-1' as any, { monthlyQuota: 1 })
    ).rejects.toThrow();
    expect(executed.calls).toHaveLength(0);
  });

  it('refuses a negative quota and a non-integer quota', async () => {
    await expect(callAdminSetStellaService(ORG, { monthlyQuota: -1 })).rejects.toThrow();
    await expect(callAdminSetStellaService(ORG, { monthlyQuota: 1.5 })).rejects.toThrow();
    expect(executed.calls).toHaveLength(0);
  });

  it('refuses a plan label longer than the column', async () => {
    await expect(
      callAdminSetStellaService(ORG, { monthlyQuota: 1, planLabel: 'x'.repeat(101) })
    ).rejects.toThrow();
    expect(executed.calls).toHaveLength(0);
  });

  it('sanitises the refusal: no SQLSTATE, no statement, no driver prose', async () => {
    executed.fail = true;

    await expect(
      callAdminSetStellaService(ORG, { monthlyQuota: 1 })
    ).rejects.toBeInstanceOf(OrganizationAdministrationError);

    await callAdminSetStellaService(ORG, { monthlyQuota: 1 }).catch((e: Error) => {
      // The database answers every refusal identically on purpose; re-exposing
      // the driver's message here would undo that.
      expect(e.message).not.toContain('permission denied');
      expect(e.message).not.toContain('organizations');
      expect((e as any).cause).toBeUndefined();
    });
  });
});

describe('callAdminSetOrganizationStatus', () => {
  it('calls the definer function with a validated status', async () => {
    await callAdminSetOrganizationStatus(ORG, 'suspended');

    expect(lastSql()).toContain('admin_set_organization_status');
    expect(lastSql()).not.toContain('update');
  });

  it('refuses a status outside the fixed pair', async () => {
    // `organizations.status` carries no CHECK constraint in the baseline, so an
    // invented value would otherwise reach the column and read as "not
    // suspended" everywhere.
    await expect(callAdminSetOrganizationStatus(ORG, 'platinum' as any)).rejects.toThrow();
    expect(executed.calls).toHaveLength(0);
  });

  it('refuses a non-UUID organization id', async () => {
    await expect(callAdminSetOrganizationStatus('nope' as any, 'active')).rejects.toThrow();
    expect(executed.calls).toHaveLength(0);
  });

  it('sanitises the refusal', async () => {
    executed.fail = true;
    await expect(
      callAdminSetOrganizationStatus(ORG, 'active')
    ).rejects.toBeInstanceOf(OrganizationAdministrationError);
  });
});

describe('the module itself', () => {
  const src = readFileSync('lib/admin/organization-administration.ts', 'utf8')
    .split(String.fromCharCode(10))
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join(String.fromCharCode(10));

  it('never reaches for service_role', () => {
    // A service-role client would bypass RLS entirely and write no audit row —
    // the repair would be undone by the thing meant to apply it.
    expect(src).not.toMatch(/service_role|SERVICE_ROLE|serviceRole/);
  });

  it('derives the actor from the session, never from an argument', () => {
    // auth.uid() inside the definer, established by withSuperAdminDatabaseContext.
    // Nothing here may accept an actor id, or the audit row becomes assertable.
    expect(src).not.toMatch(/actorUserId|actorId|p_actor/);
  });

  it('has no fallback to a direct UPDATE and no feature flag', () => {
    // A fallback would keep the statement RR-CAP-10 exists to remove alive in
    // the tree; a flag defaulting to the old path would mean the boundary is
    // off in production while the tests exercise the new one.
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/_AVAILABLE|featureFlag|FEATURE_FLAG/);
  });
});

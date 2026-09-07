// tests/tenancy/s2-selected-org-carrier.test.ts
//
// S2 — Selected-organization session carrier.
//
// Binds by id to docs/ops/tenancy/MULTI_ORG_TENANT_SCOPE_TEST_MANIFEST_v1.0.0.json
// (P-3) and to the S2 additions in
// docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_v1.0.0.json
// (NS2-1..NS2-6) and
// docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.1.json
// (T-S2-CARRIER-1, T-S2-CARRIER-2). None of those controls is restated in
// full prose here — each `it()` names the id it proves.
//
// THE CONTROL THIS FILE EXISTS TO GUARANTEE ABOVE ALL OTHERS (NS2-4): no
// canonical authorization surface consumes this carrier. If that control is
// ever weakened to make the carrier "useful", the mission has silently
// performed S3 without S3's lineage — see the header of
// lib/auth/selected-organization.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

/* -------------------------------------------------------------------------- */
/* A minimal fake of the next/headers cookies() surface this module uses.    */
/* -------------------------------------------------------------------------- */

interface StoredCookie {
  value: string
  options?: Record<string, unknown>
}

class FakeCookieStore {
  private readonly entries = new Map<string, StoredCookie>()

  get(name: string): { name: string; value: string } | undefined {
    const entry = this.entries.get(name)
    return entry ? { name, value: entry.value } : undefined
  }

  set(name: string, value: string, options?: Record<string, unknown>): void {
    this.entries.set(name, { value, options })
  }

  delete(nameOrOptions: string | { name: string; path?: string }): void {
    const name = typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions.name
    this.entries.delete(name)
  }

  /** Test-only introspection — never part of the real cookies() API. */
  raw(name: string): StoredCookie | undefined {
    return this.entries.get(name)
  }

  clear(): void {
    this.entries.clear()
  }
}

const fakeCookieStore = new FakeCookieStore()

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => fakeCookieStore),
}))

const mockRedirect = vi.fn((p: string) => {
  throw new Error(`REDIRECT:${p}`)
})
vi.mock('next/navigation', () => ({
  redirect: (p: string) => mockRedirect(p),
}))

const mockRequireAuth = vi.fn()
const mockListSelectableMemberships = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireAuth: () => mockRequireAuth(),
  listSelectableMemberships: () => mockListSelectableMemberships(),
}))

// Rendering chrome only — this suite is about the carrier and the selection
// act, not about markup.
vi.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children: unknown }) => children,
  CardHeader: ({ children }: { children: unknown }) => children,
  CardTitle: ({ children }: { children: unknown }) => children,
  CardContent: ({ children }: { children: unknown }) => children,
}))
vi.mock('@/components/ui/button', () => ({ Button: () => null }))
vi.mock('@/components/states/ErrorState', () => ({ ErrorState: () => null }))

import * as carrier from '@/lib/auth/selected-organization'
import {
  SELECTED_ORGANIZATION_COOKIE_NAME,
  SELECTED_ORGANIZATION_COOKIE_PATH,
  setSelectedOrganization,
  getSelectedOrganizationId,
  clearSelectedOrganization,
} from '@/lib/auth/selected-organization'
import {
  selectOrganizationAction,
  clearOrganizationSelectionAction,
} from '@/app/(authenticated)/app/organizations/select/actions'
import SelectOrganizationPage from '@/app/(authenticated)/app/organizations/select/page'

const USER = { id: '00000000-0000-4000-8000-00000000f001', email: 'f1@example.test', isSuperAdmin: false }
const SUPER_ADMIN = { ...USER, isSuperAdmin: true }
const ORG_A = '00000000-0000-4000-8000-0000000000aa'
const ORG_B = '00000000-0000-4000-8000-0000000000bb'
const MEMBERSHIP_A = { id: 'm1', role: 'organization_admin', organizationId: ORG_A, userId: USER.id }
const ORGANIZATION_A = { id: ORG_A, name: 'Org A' }
const SELECTABLE_A = [{ membership: MEMBERSHIP_A, organization: ORGANIZATION_A }]

function formDataWith(organizationId: string | null): FormData {
  const fd = new FormData()
  if (organizationId !== null) fd.set('organizationId', organizationId)
  return fd
}

async function locationOf(entry: () => Promise<unknown>): Promise<string | null> {
  try {
    await entry()
    return null
  } catch (error) {
    const message = (error as Error).message
    if (message.startsWith('REDIRECT:')) return message.slice('REDIRECT:'.length)
    throw error
  }
}

beforeEach(() => {
  fakeCookieStore.clear()
  mockRedirect.mockClear()
  mockRequireAuth.mockReset()
  mockListSelectableMemberships.mockReset()
  vi.restoreAllMocks()
})

/* -------------------------------------------------------------------------- */
/* Cookie contract — NS2-1, P-3                                              */
/* -------------------------------------------------------------------------- */

describe('cookie contract: attributes are exact (NS2-1 / P-3)', () => {
  it('sets HttpOnly, Secure, SameSite=Lax individually — each asserted, not combined', async () => {
    await setSelectedOrganization(ORG_A)
    const stored = fakeCookieStore.raw(SELECTED_ORGANIZATION_COOKIE_NAME)
    expect(stored).toBeDefined()
    expect(stored!.options?.httpOnly).toBe(true)
    expect(stored!.options?.secure).toBe(true)
    expect(stored!.options?.sameSite).toBe('lax')
  })

  it('sets NO Max-Age and NO Expires — the cookie must die with the session', async () => {
    await setSelectedOrganization(ORG_A)
    const stored = fakeCookieStore.raw(SELECTED_ORGANIZATION_COOKIE_NAME)
    expect(stored!.options).not.toHaveProperty('maxAge')
    expect(stored!.options).not.toHaveProperty('expires')
  })

  it('scopes the cookie to a Path that excludes /login, /admin and /auth (measured route-tree justification)', async () => {
    await setSelectedOrganization(ORG_A)
    const stored = fakeCookieStore.raw(SELECTED_ORGANIZATION_COOKIE_NAME)
    expect(stored!.options?.path).toBe(SELECTED_ORGANIZATION_COOKIE_PATH)
    expect(SELECTED_ORGANIZATION_COOKIE_PATH).toBe('/app')
  })

  it('uses a cookie name distinct from the Supabase auth carrier', () => {
    expect(SELECTED_ORGANIZATION_COOKIE_NAME).not.toMatch(/^sb-/)
    expect(SELECTED_ORGANIZATION_COOKIE_NAME).toBe('uellix_selected_organization_id')
  })
})

/* -------------------------------------------------------------------------- */
/* Session-only lifetime — NS2-2                                             */
/* -------------------------------------------------------------------------- */

describe('session-only lifetime (NS2-2)', () => {
  it('a new session (a fresh cookie jar) starts with NO selection', async () => {
    expect(await getSelectedOrganizationId()).toBeNull()
  })

  it('clearing the carrier removes it entirely, not merely blanks its value', async () => {
    await setSelectedOrganization(ORG_A)
    expect(await getSelectedOrganizationId()).toBe(ORG_A)

    await clearSelectedOrganization()
    expect(fakeCookieStore.raw(SELECTED_ORGANIZATION_COOKIE_NAME)).toBeUndefined()
    expect(await getSelectedOrganizationId()).toBeNull()
  })

  it('is never written to any persistent store — the carrier module imports no database client', () => {
    const source = read('lib/auth/selected-organization.ts')
    expect(source).not.toMatch(/@\/db\/client/)
    expect(source).not.toMatch(/@\/db\/schema/)
  })
})

/* -------------------------------------------------------------------------- */
/* Exact payload — P-3, "no CommercialAccount"                                */
/* -------------------------------------------------------------------------- */

describe('exact payload: organization id only', () => {
  it('round-trips the exact organization id and nothing else (T-S2-CARRIER-1)', async () => {
    await setSelectedOrganization(ORG_A)
    const stored = fakeCookieStore.raw(SELECTED_ORGANIZATION_COOKIE_NAME)!
    expect(stored.value).toBe(ORG_A)
    // The stored value is a bare id, never an envelope a role or permission
    // could be smuggled inside.
    expect(() => JSON.parse(stored.value)).toThrow()
  })

  it('refuses a non-UUID payload rather than writing it verbatim', async () => {
    await expect(setSelectedOrganization('not-an-organization-id')).rejects.toThrow()
    expect(fakeCookieStore.raw(SELECTED_ORGANIZATION_COOKIE_NAME)).toBeUndefined()
  })

  it('carries no CommercialAccount identifier, role or permission field — by construction and by source', () => {
    // Comments are stripped: this asserts about CODE, not about prose that
    // documents which fields are deliberately absent (which legitimately
    // names them in order to say so).
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    const carrierSource = stripComments(read('lib/auth/selected-organization.ts'))
    const actionsSource = stripComments(read('app/(authenticated)/app/organizations/select/actions.ts'))
    for (const source of [carrierSource, actionsSource]) {
      expect(source).not.toMatch(/CommercialAccount|commercial_account|commercialAccountId/)
      expect(source).not.toMatch(/\brole\b\s*[:=]/i)
      expect(source).not.toMatch(/\bpermission\b/i)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Valid member selection / invalid non-member rejection — the SELECTION ACT  */
/* -------------------------------------------------------------------------- */

describe('selection action: valid member selection', () => {
  it('writes the carrier and redirects to the dashboard when the caller is an active member', async () => {
    mockRequireAuth.mockResolvedValue(USER)
    mockListSelectableMemberships.mockResolvedValue(SELECTABLE_A)

    const location = await locationOf(() => selectOrganizationAction(formDataWith(ORG_A)))

    expect(location).toBe('/app/dashboard')
    expect(await getSelectedOrganizationId()).toBe(ORG_A)
    expect(mockListSelectableMemberships).toHaveBeenCalled()
  })
})

describe('selection action: invalid / non-member rejection', () => {
  it('refuses an organization the caller is not an active member of — no fallback, no partial write', async () => {
    mockRequireAuth.mockResolvedValue(USER)
    mockListSelectableMemberships.mockResolvedValue(SELECTABLE_A) // active member of A only

    const location = await locationOf(() => selectOrganizationAction(formDataWith(ORG_B)))

    expect(location).toBe('/app/organizations/select?error=not_a_member')
    // No fallback to the caller's OWN membership either — the refused
    // request leaves the carrier exactly as it was: unset.
    expect(await getSelectedOrganizationId()).toBeNull()
  })

  it('refuses when the caller has no active membership at all', async () => {
    mockRequireAuth.mockResolvedValue(USER)
    mockListSelectableMemberships.mockResolvedValue([])

    const location = await locationOf(() => selectOrganizationAction(formDataWith(ORG_A)))

    expect(location).toBe('/app/organizations/select?error=not_a_member')
    expect(await getSelectedOrganizationId()).toBeNull()
  })

  it('refuses a missing organizationId rather than guessing one', async () => {
    mockRequireAuth.mockResolvedValue(USER)
    mockListSelectableMemberships.mockResolvedValue(SELECTABLE_A)

    const location = await locationOf(() => selectOrganizationAction(formDataWith(null)))

    expect(location).toBe('/app/organizations/select?error=missing_organization')
    expect(mockListSelectableMemberships).not.toHaveBeenCalled()
    expect(await getSelectedOrganizationId()).toBeNull()
  })

  it('an unauthenticated caller is sent to /login before any membership check runs', async () => {
    mockRequireAuth.mockImplementation(() => {
      throw new Error('REDIRECT:/login')
    })

    const location = await locationOf(() => selectOrganizationAction(formDataWith(ORG_A)))

    expect(location).toBe('/login')
    expect(mockListSelectableMemberships).not.toHaveBeenCalled()
  })

  it('NS2-6: a super admin gets NO exemption from the membership check in the selection act', async () => {
    mockRequireAuth.mockResolvedValue(SUPER_ADMIN)
    mockListSelectableMemberships.mockResolvedValue([]) // no membership anywhere

    const location = await locationOf(() => selectOrganizationAction(formDataWith(ORG_A)))

    expect(location).toBe('/app/organizations/select?error=not_a_member')
    expect(await getSelectedOrganizationId()).toBeNull()
  })

  it('does not leave a stale carrier from a PRIOR selection after a refused re-selection', async () => {
    await setSelectedOrganization(ORG_A)
    mockRequireAuth.mockResolvedValue(USER)
    mockListSelectableMemberships.mockResolvedValue(SELECTABLE_A) // no longer a member of B

    await locationOf(() => selectOrganizationAction(formDataWith(ORG_B)))

    // Refused — the PRIOR selection (A) is untouched, never silently
    // replaced by the rejected request.
    expect(await getSelectedOrganizationId()).toBe(ORG_A)
  })

  it('S3-5 / NO_FALLBACK: proof is against the REQUESTED organization, never the CURRENTLY SELECTED one', async () => {
    // The caller is currently selected into A, but is an active member of B
    // too, and is now switching TO B. A proof keyed on the CURRENT selection
    // (the pre-S3 getCurrentMembership shape) would check membership in A —
    // the organization being switched AWAY FROM — and wrongly refuse.
    await setSelectedOrganization(ORG_A)
    mockRequireAuth.mockResolvedValue(USER)
    mockListSelectableMemberships.mockResolvedValue([
      SELECTABLE_A[0],
      { membership: { id: 'm2', role: 'viewer', organizationId: ORG_B, userId: USER.id }, organization: { id: ORG_B, name: 'Org B' } },
    ])

    const location = await locationOf(() => selectOrganizationAction(formDataWith(ORG_B)))

    expect(location).toBe('/app/dashboard')
    expect(await getSelectedOrganizationId()).toBe(ORG_B)
  })
})

describe('selection action: explicit clear', () => {
  it('clears the carrier and redirects back to the selector', async () => {
    await setSelectedOrganization(ORG_A)
    mockRequireAuth.mockResolvedValue(USER)

    const location = await locationOf(() => clearOrganizationSelectionAction())

    expect(location).toBe('/app/organizations/select')
    expect(await getSelectedOrganizationId()).toBeNull()
  })

  it('an unauthenticated caller is sent to /login before the carrier is touched', async () => {
    await setSelectedOrganization(ORG_A)
    mockRequireAuth.mockImplementation(() => {
      throw new Error('REDIRECT:/login')
    })

    const location = await locationOf(() => clearOrganizationSelectionAction())

    expect(location).toBe('/login')
    // Refused before the clear — the prior selection is untouched.
    expect(await getSelectedOrganizationId()).toBe(ORG_A)
  })
})

/* -------------------------------------------------------------------------- */
/* No autoselection — NS2-5                                                  */
/* -------------------------------------------------------------------------- */

describe('no autoselection (NS2-5 / MS3-7)', () => {
  it('rendering the selector page with exactly one selectable membership does NOT write the carrier', async () => {
    const setSpy = vi.spyOn(carrier, 'setSelectedOrganization')
    mockRequireAuth.mockResolvedValue(USER)
    mockListSelectableMemberships.mockResolvedValue(SELECTABLE_A)

    await SelectOrganizationPage({ searchParams: Promise.resolve({}) })

    expect(setSpy).not.toHaveBeenCalled()
    expect(await getSelectedOrganizationId()).toBeNull()
  })

  it('a subject who just self-service-founded an organization likewise has no carrier until an explicit act', async () => {
    // The founding transaction (app/(authenticated)/app/onboarding/actions.ts)
    // is S1-exclusive and never calls anything in
    // lib/auth/selected-organization.ts — proven structurally, not behaviourally,
    // because S2 owns no path inside that file.
    const onboardingActions = read('app/(authenticated)/app/onboarding/actions.ts')
    expect(onboardingActions).not.toMatch(/selected-organization/)
    expect(onboardingActions).not.toMatch(new RegExp(SELECTED_ORGANIZATION_COOKIE_NAME))
  })
})

/* -------------------------------------------------------------------------- */
/* Carrier tampering is inert and non-fatal — NS2-3                          */
/* -------------------------------------------------------------------------- */

describe('carrier tampering is inert and non-fatal (NS2-3)', () => {
  it('a malformed cookie value is read back as no selection, never thrown', async () => {
    fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, 'not-a-uuid')
    await expect(getSelectedOrganizationId()).resolves.toBeNull()
  })

  it('an empty cookie value is read back as no selection', async () => {
    fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, '')
    await expect(getSelectedOrganizationId()).resolves.toBeNull()
  })

  it('a well-formed but unknown/non-member organization id is readable as a STRING only — the read path performs no lookup and yields no data', async () => {
    // "Yields no data" here means exactly what INERTNESS guarantees: reading
    // the carrier back never queries a membership or organization table. The
    // module has no database import at all (asserted above), so there is no
    // lookup this value could ever drive.
    fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, ORG_B)
    const value = await getSelectedOrganizationId()
    expect(value).toBe(ORG_B)
    expect(typeof value).toBe('string')
  })

  it('cookie deletion yields NO selection, never a default', async () => {
    await setSelectedOrganization(ORG_A)
    fakeCookieStore.delete(SELECTED_ORGANIZATION_COOKIE_NAME)
    expect(await getSelectedOrganizationId()).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* Carrier inertness RETIRED BY REPLACEMENT — S3 supersedes NS2-4             */
/* -------------------------------------------------------------------------- */
//
// NS2-4 asserted that FIVE canonical surfaces never import the carrier. S3
// deliberately makes exactly ONE of them false: lib/auth/database-context.ts
// now consumes the carrier's value, by design — see
// REQUEST_PRINCIPAL_CONTRACT and INERTNESS_RETIREMENT in
// docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.4.json.
// This block does not delete that guarantee; it NARROWS it to the three
// surfaces that must STILL hold it, and adds the S3 assertions that prove the
// widening happened exactly once, through exactly one call site, without
// reversing the leaf's import direction. MS3-10 exists to prove this
// replacement, not merely the deletion, is what stands here.

describe('carrier inertness RETIRED BY REPLACEMENT (S3 supersedes NS2-4)', () => {
  const NARROWED_SURFACES_STILL_NOT_CONSUMING = [
    'db/identity-context.ts',
    'lib/auth/permissions.ts',
    'lib/auth/roles.ts',
  ]

  it.each(NARROWED_SURFACES_STILL_NOT_CONSUMING)(
    '%s STILL does not import lib/auth/selected-organization (INERTNESS_RETIREMENT.what_MUST_STILL_HOLD)',
    (relativePath) => {
      const source = read(relativePath)
      expect(source).not.toMatch(/selected-organization/)
    }
  )

  it.each(NARROWED_SURFACES_STILL_NOT_CONSUMING)(
    '%s STILL does not reference the carrier cookie name literal',
    (relativePath) => {
      const source = read(relativePath)
      expect(source).not.toMatch(new RegExp(SELECTED_ORGANIZATION_COOKIE_NAME))
    }
  )

  it('lib/auth/database-context.ts is the ONE surface S3 widens — it now imports the carrier', () => {
    const source = read('lib/auth/database-context.ts')
    expect(source).toMatch(/from '\.\/selected-organization'/)
  })

  it('S3-1 / the widening is EXACTLY ONE call site — getSelectedOrganizationId is read once, inside the revalidating principal path', () => {
    const source = read('lib/auth/database-context.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    const callSites = source.match(/\bgetSelectedOrganizationId\s*\(/g) ?? []
    expect(callSites.length).toBe(1)
  })

  it('the carrier module itself STILL imports NOTHING from any authorization surface (it remains a leaf)', () => {
    const source = read('lib/auth/selected-organization.ts')
    const AUTHORIZATION_SURFACES = [
      'db/identity-context.ts',
      'lib/auth/database-context.ts',
      'lib/auth/session.ts',
      'lib/auth/permissions.ts',
      'lib/auth/roles.ts',
    ]
    for (const surface of AUTHORIZATION_SURFACES) {
      const bareModule = surface.replace(/\.ts$/, '').replace(/^lib\//, '@/lib/').replace(/^db\//, '@/db/')
      expect(source).not.toContain(`from '${bareModule}'`)
    }
  })

  it('import direction is database-context -> selected-organization, NEVER the reverse (MS3-12)', () => {
    const carrierSource = read('lib/auth/selected-organization.ts')
    expect(carrierSource).not.toMatch(/from ['"][.@].*database-context['"]/)

    const databaseContextSource = read('lib/auth/database-context.ts')
    expect(databaseContextSource).toMatch(/from ['"]\.\/selected-organization['"]/)
  })
})

/* -------------------------------------------------------------------------- */
/* No ORGANIZATION-SCOPED behavior — narrowed by S3, not deleted by it        */
/* -------------------------------------------------------------------------- */
//
// Before S3 this block asserted the selection surface performed NO
// database-context work at all. That is no longer true — both files now call
// listSelectableMemberships(), an UNSCOPED enumerator that does reach the
// database. What remains, and is asserted below, is narrower and still load
// -bearing: neither file opens an ORGANIZATION-SCOPED context, constructs a
// principal, or touches an RLS/GUC/capability literal — selecting an
// organization changes what the NEXT request revalidates, never what THIS
// one is authorized to do.

describe('selection surface: unscoped enumeration only, no organization-scoped context (S3 narrows the S2 guarantee)', () => {
  it('the selection action imports no ORGANIZATION-SCOPED or super-admin database wrapper', () => {
    const source = read('app/(authenticated)/app/organizations/select/actions.ts')
    expect(source).not.toMatch(
      /withOrganizationDatabaseContext|withAuthenticatedDatabaseContext|withSuperAdminDatabaseContext|withDatabaseIdentityContext/
    )
    expect(source).not.toMatch(/@\/db\/client|@\/db\/schema/)
    // …but it DOES now reach the database, through the enumerator — the S3
    // change this block exists to narrow, not hide.
    expect(source).toMatch(/listSelectableMemberships/)
  })

  it('the selector page imports no ORGANIZATION-SCOPED or super-admin database wrapper', () => {
    const source = read('app/(authenticated)/app/organizations/select/page.tsx')
    expect(source).not.toMatch(
      /withOrganizationDatabaseContext|withAuthenticatedDatabaseContext|withSuperAdminDatabaseContext|withDatabaseIdentityContext/
    )
    expect(source).toMatch(/listSelectableMemberships/)
  })

  it('selecting an organization does not touch RLS, a GUC, or any capability check — no such literal exists in either file', () => {
    for (const p of [
      'app/(authenticated)/app/organizations/select/actions.ts',
      'app/(authenticated)/app/organizations/select/page.tsx',
      'lib/auth/selected-organization.ts',
    ]) {
      const source = read(p)
      expect(source).not.toMatch(/app\.organization_id|current_user_org_ids|uellix_capability\./)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Route location                                                             */
/* -------------------------------------------------------------------------- */

describe('route location: the pre-organization selector', () => {
  it('exists at the declared pre-organization location', () => {
    expect(
      existsSync(path.join(ROOT, 'app/(authenticated)/app/organizations/select/page.tsx'))
    ).toBe(true)
    expect(
      existsSync(path.join(ROOT, 'app/(authenticated)/app/organizations/select/actions.ts'))
    ).toBe(true)
  })

  it('does NOT exist beneath the organization-gated workspace — the circular gate', () => {
    expect(existsSync(path.join(ROOT, 'app/app/organizations/select/page.tsx'))).toBe(false)
  })

  it('the singular organization workspace is untouched by this batch', () => {
    expect(existsSync(path.join(ROOT, 'app/app/organization'))).toBe(true)
  })
})

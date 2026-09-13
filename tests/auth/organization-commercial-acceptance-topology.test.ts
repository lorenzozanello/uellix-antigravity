// tests/auth/organization-commercial-acceptance-topology.test.ts
//
// L1 (HPO-ODS-W2-29) — THE STRUCTURAL CENSUSES.
//
// These are the controls that make the ATTACHMENT_TOPOLOGY completeness claim
// FALSIFIABLE rather than a snapshot. They are EQUALITY-shaped throughout: a
// containment assertion is green for every superset, so it cannot fail on the
// exact event a census exists to catch (mutation MUT-L1-census-to-containment,
// demonstrated executably at the bottom of this file).
//
// Nothing here touches a database. The behavioural half lives in
// tests/auth/organization-commercial-acceptance-enforcement.test.ts and the
// database half in tests/postgres/organization-commercial-acceptance*.pg.test.ts.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = path.resolve(process.cwd())
const SCAN_ROOTS = ['app', 'lib', 'db', 'components']

/** Every non-test .ts/.tsx under `dir`, walked by hand (no glob dependency). */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    if (entry === '__tests__') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, '/')

/**
 * COMMENTS ARE REMOVED BEFORE ANY STRUCTURAL SCAN.
 *
 * Every control in this file asserts something about CODE, and several are
 * NEGATIVE assertions. A negative run over raw file text is
 * VACUOUS-BY-INVERSION: it fails whenever a module merely DOCUMENTS the thing
 * it must not do — which every module here does, at length and on purpose. An
 * assertion that the L1 resolver never reads ACTIVE_WITHOUT_STRIPE must be
 * measuring the QUERY, not the paragraph explaining why the query does not
 * read it. Symmetrically, the POSITIVE censuses must not count a call site
 * that exists only inside a code comment.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const SOURCES: { file: string; source: string }[] = SCAN_ROOTS.flatMap((r) =>
  walk(path.join(ROOT, r)).map((f) => ({ file: rel(f), source: stripComments(readFileSync(f, 'utf8')) }))
)
const codeOf = (file: string) => stripComments(readFileSync(path.join(ROOT, file), 'utf8'))

/* -------------------------------------------------------------------------- */
/* TOPO-producer-census-exact — LOAD-BEARING COMPLETENESS CONTROL FOR U-AO-4   */
/* -------------------------------------------------------------------------- */

/**
 * The nearest enclosing declaration name above `index`, so the census reads as
 * a list of SYMBOLS rather than of line numbers. Every anchor in the authority
 * is a RE-MEASUREMENT OBLIGATION matched on symbol, never on line number — the
 * parent's own lineage has twice had anchors drift between authoring and
 * implementation.
 */
function enclosingSymbol(source: string, index: number): string {
  const before = source.slice(0, index)
  // TOP-LEVEL declarations only, anchored at column 0. An unanchored pattern
  // matches every `const check =` inside a function body and reports the
  // nearest LOCAL instead of the enclosing function — which is how a census
  // silently attributes a call site to the wrong symbol.
  const decl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)|^(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=/gm
  let name = '<module>'
  let m: RegExpExecArray | null
  while ((m = decl.exec(before)) !== null) name = m[1] ?? m[2] ?? name
  return name
}

interface Mention {
  readonly site: string
  readonly kind: 'RETURN' | 'CONSTRUCTION' | 'CONSUMER'
}

/**
 * The enclosing symbols of every `withDatabaseIdentityContext(...)` invocation
 * in `file` whose identity literal passes a NULL (or NON-NULL) organizationId.
 *
 * Joins on the CALL, brace-balanced from the opening parenthesis, so an
 * ordinary object literal carrying an `organizationId` property elsewhere in
 * the module cannot be counted as a chokepoint call site.
 */
function identityContextCallSites(file: string, want: 'NULL' | 'NON_NULL'): string[] {
  const source = codeOf(file)
  const sites: string[] = []
  const re = /withDatabaseIdentityContext\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const open = source.indexOf('(', m.index + m[0].length - 1)
    let depth = 0
    let end = -1
    for (let i = open; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) continue
    const args = source.slice(open, end)
    const arg = /organizationId:\s*([A-Za-z0-9_.]+)/.exec(args)
    if (!arg) continue
    const isNull = arg[1] === 'null'
    if ((want === 'NULL') === isNull) sites.push(enclosingSymbol(source, m.index))
  }
  // NOT de-duplicated. Two call sites inside ONE function are TWO call sites,
  // and collapsing them here would let a census report a smaller number than
  // the authority measured and still look like it agreed with it.
  return sites
}

/**
 * EVERY occurrence of the OrganizationContext type annotation across app/,
 * lib/, db/ and components/, classified. The sweep is UNRESTRICTED — it
 * carries no assumption about the FORM a producer takes — which is what makes
 * the negative claim "there is no ungoverned producer" a MEASUREMENT rather
 * than a failure to find.
 */
function censusOrganizationContextMentions(): Mention[] {
  const mentions: Mention[] = []
  for (const { file, source } of SOURCES) {
    const re = /(Promise<\s*OrganizationContext\b[^>]*>)|(:\s*OrganizationContext\b)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      const symbol = enclosingSymbol(source, m.index)
      const site = `${file}:${symbol}`
      if (m[1]) {
        // A Promise<OrganizationContext...> is a RETURN position only when it
        // annotates the function's own result. Inside a `callback:` parameter
        // it is the callback's return type — a CONSUMER position.
        const lineStart = source.lastIndexOf('\n', m.index) + 1
        const line = source.slice(lineStart, source.indexOf('\n', m.index))
        mentions.push({ site, kind: /callback|=>\s*Promise</.test(line) && /\(context/.test(line) ? 'CONSUMER' : 'RETURN' })
      } else {
        const lineStart = source.lastIndexOf('\n', m.index) + 1
        const line = source.slice(lineStart, source.indexOf('\n', m.index))
        mentions.push({ site, kind: /^\s*const\s+\w+\s*:\s*OrganizationContext\s*=/.test(line) ? 'CONSTRUCTION' : 'CONSUMER' })
      }
    }
  }
  return mentions
}

/**
 * THE GOVERNED PRODUCER SET.
 *
 * The four ENFORCEMENT surfaces the authority enumerates, PLUS the ONE bounded
 * discharge boundary the SAME authority mandates.
 *
 * >>> READ THIS BEFORE TREATING THE FIFTH ENTRY AS A DEFECT. <<<
 *
 * ATTACHMENT_TOPOLOGY.THE_ORGANIZATIONCONTEXT_PRODUCER_CENSUS enumerates FOUR
 * production sites, measured at 975e5e48 — BEFORE any L1 discharge boundary
 * existed. DISCHARGE_BOUNDARY.AUTHORIZED, in the same artifact, then REQUIRES
 * "ONE new bounded organization-scoped acceptance-discharge boundary", and
 * ATTACHMENT_TOPOLOGY.DISCHARGE_SURFACE_RELATION states in terms that the
 * discharge surface is served "never by any of the four enforcement surfaces
 * above, because all four enforce L1 and the discharge surface must not". A
 * boundary that opens a resolved selected-organization scope and must NOT be
 * one of the four is, structurally, a FIFTH producer — the authority creates
 * it knowingly.
 *
 * THE ALTERNATIVES WERE MEASURED AND ARE WORSE:
 *   - A new context TYPE carrying membership + organization would be a FIFTH
 *     structural type and would turn the F-RECERT-1 Disposition-B control
 *     (c.1) RED, which is a HARD prohibition.
 *   - Reusing AuthenticatedContext (already one of the four named types) and
 *     handing it out under a NON-NULL organization scope would quietly convert
 *     a type the authority classifies as NON-selected-org into a
 *     selected-org carrier — corrupting the meaning of a governed type to
 *     preserve a numeral, which is precisely what (c.2) exists to detect.
 *
 * SO THE NUMERAL MOVES AND THE PROPERTY DOES NOT. Every load-bearing
 * characteristic of the frozen control is preserved: the assertion is
 * SORTED-LIST EQUALITY (never containment), every entry is NAMED, the sweep
 * over remaining mentions is EXHAUSTIVE, and the control goes RED the moment
 * an UNGOVERNED producer appears. What it no longer asserts is the literal
 * "four", because four is not true at a head where the authority itself
 * mandates the fifth.
 *
 * THIS DIVERGENCE FROM THE FROZEN CONTROL'S NUMERAL IS RECORDED AS AN OPEN
 * FINDING FOR INDEPENDENT CERTIFICATION and is NOT claimed to be discharged
 * here. No control id, description or count in the test manifest was changed.
 */
const GOVERNED_PRODUCERS = [
  // RETURN sites — the two routing producers.
  'lib/auth/session.ts:getCurrentOrganizationContext',
  'lib/auth/session.ts:requireOrganizationAccess',
  // CONSTRUCTION sites — the two database-context producers ...
  'lib/auth/database-context.ts:withOptionalDatabaseIdentityContext',
  'lib/auth/database-context.ts:withOrganizationDatabaseContext',
  // ... plus the ONE authority-mandated discharge boundary.
  'lib/auth/database-context.ts:withOrganizationAcceptanceDischargeContext',
].sort()

describe('TOPO-producer-census-exact (LOAD-BEARING, U-AO-4)', () => {
  it('the sweep is not vacuous — it found OrganizationContext mentions to classify', () => {
    expect(censusOrganizationContextMentions().length).toBeGreaterThan(0)
    expect(SOURCES.length).toBeGreaterThan(0)
  })

  it('the set of PRODUCTION sites is EXACTLY the governed set, by sorted-list equality', () => {
    const producers = censusOrganizationContextMentions()
      .filter((m) => m.kind === 'RETURN' || m.kind === 'CONSTRUCTION')
      .map((m) => m.site)
    expect([...new Set(producers)].sort()).toEqual(GOVERNED_PRODUCERS)
  })

  it('the TWO return-annotated producers are the two routing surfaces in lib/auth/session.ts', () => {
    const returns = censusOrganizationContextMentions().filter((m) => m.kind === 'RETURN').map((m) => m.site)
    expect([...new Set(returns)].sort()).toEqual([
      'lib/auth/session.ts:getCurrentOrganizationContext',
      'lib/auth/session.ts:requireOrganizationAccess',
    ])
  })

  it('EVERY remaining mention is a CONSUMER position — the negative claim is measured, not a failure to find', () => {
    const consumers = censusOrganizationContextMentions().filter((m) => m.kind === 'CONSUMER').map((m) => m.site)
    // Consumers are enumerated by equality too: a NEW consumer is harmless
    // (it inherits L1 from whichever producer handed it the context) but a
    // mention that this classifier could not place would show up here as an
    // unexpected entry rather than being silently swallowed.
    expect([...new Set(consumers)].sort()).toEqual([
      'lib/auth/database-context.ts:withOptionalDatabaseIdentityContext',
      'lib/auth/database-context.ts:withOrganizationAcceptanceDischargeContext',
      'lib/auth/database-context.ts:withOrganizationDatabaseContext',
      'lib/auth/session.ts:runWithOptionalOrganizationAccess',
      'lib/auth/session.ts:runWithOrganizationAccess',
      'lib/pipeline/proxies.ts:updateFinancialProxyReviewStatusForContext',
      'lib/pipeline/sroi-results.ts:assertRunMethodologyApprovalAllowed',
    ])
  })

  it('EACH of the four ENFORCEMENT surfaces reaches the L1 predicate — no single-surface attachment', () => {
    // mutation MUT-L1-attach-to-one-surface-only: attaching L1 at one surface
    // and leaving the others ungated keeps every page render working, so the
    // gap surfaces only through a Route Handler or a service that obtains its
    // context by a different route. Asserted STRUCTURALLY, per surface, by
    // slicing each function's own body.
    const session = codeOf('lib/auth/session.ts')
    const dbctx = codeOf('lib/auth/database-context.ts')
    const bodyOf = (source: string, start: string) => {
      const i = source.indexOf(start)
      expect(i, `enforcement surface not found by symbol: ${start}`).toBeGreaterThan(-1)
      const end = source.indexOf('\nexport ', i + 1)
      return source.slice(i, end === -1 ? undefined : end)
    }
    expect(bodyOf(session, 'export const requireOrganizationAccess')).toMatch(/isOrganizationAcceptanceCurrent/)
    expect(bodyOf(session, 'export const getCurrentOrganizationContext')).toMatch(/isOrganizationAcceptanceCurrent/)
    expect(bodyOf(dbctx, 'export async function withOrganizationDatabaseContext')).toMatch(
      /assertOrganizationAcceptanceCurrent/
    )
    expect(bodyOf(dbctx, 'export async function withOptionalDatabaseIdentityContext')).toMatch(
      /resolveOrganizationAcceptanceCurrent/
    )
  })

  it('the two INHERITING composers are NOT gated twice', () => {
    // runWithOrganizationAccess inherits L1 twice over; runWithOptionalOrganizationAccess
    // inherits it from withOptionalDatabaseIdentityContext. A separate check in
    // either would be a third place to keep in step for no additional guarantee.
    const session = codeOf('lib/auth/session.ts')
    for (const composer of ['runWithOrganizationAccess', 'runWithOptionalOrganizationAccess']) {
      const i = session.indexOf(`export async function ${composer}`)
      expect(i).toBeGreaterThan(-1)
      const end = session.indexOf('\nexport ', i + 1)
      const body = session.slice(i, end === -1 ? undefined : end)
      expect(body, `${composer} must inherit L1, never re-check it`).not.toMatch(
        /isOrganizationAcceptanceCurrent|assertOrganizationAcceptanceCurrent/
      )
    }
  })
})

/* -------------------------------------------------------------------------- */
/* TOPO-chokepoint-census-exact — CORROBORATING ONLY, NOT A COMPLETENESS PROOF */
/* -------------------------------------------------------------------------- */

describe('TOPO-chokepoint-census-exact (CORROBORATING ONLY)', () => {
  // ITS PASSING IS NOT SUFFICIENT TO ESTABLISH U-AO-4 COMPLETENESS and MUST
  // NOT be cited as if it were. app.organization_id is read by ZERO live
  // tenant RLS predicates, so a census pinned to it cannot falsify a widening
  // of the tenant-scope surface. Completeness is carried by
  // TOPO-producer-census-exact above. Inverting the two reproduces the exact
  // R1 defect this artifact was remediated to remove.

  it('app.organization_id is written at EXACTLY ONE site', () => {
    const writers = SOURCES.filter((s) => /set_config\(\s*'app\.organization_id'/.test(s.source)).map((s) => s.file)
    expect(writers.sort()).toEqual(['db/identity-context.ts'])
  })

  it('withDatabaseIdentityContext is imported by EXACTLY TWO non-test modules', () => {
    const importers = SOURCES.filter((s) =>
      /import\s*\{[^}]*\bwithDatabaseIdentityContext\b[^}]*\}\s*from/.test(s.source)
    ).map((s) => s.file)
    expect(importers.sort()).toEqual(['lib/auth/database-context.ts', 'lib/auth/session.ts'])
  })

  it('EXACTLY THREE non-test call sites pass a NON-NULL organizationId — the two producers plus the discharge boundary', () => {
    // The THIRD entry is the same authority-mandated discharge boundary
    // GOVERNED_PRODUCERS documents above, and for the same reason: it must
    // open a resolved selected-organization scope in order to write an
    // organisation-scoped row under FORCE RLS. Equality-shaped, so a FOURTH
    // non-null call site goes RED.
    //
    // SCOPED TO `withDatabaseIdentityContext(` INVOCATIONS, not to every
    // `organizationId:` occurrence. The unscoped form counts ordinary object
    // literals — `loadSelectableMembershipsWithinContext` builds a
    // SelectableMembership carrying `organizationId: row.organizationId` and
    // opens no context at all — so it reports enumerator plumbing as a
    // selected-organization chokepoint. The census must join on the CALL.
    const nonNull = identityContextCallSites('lib/auth/database-context.ts', 'NON_NULL')
    expect(nonNull.length, 'one non-null call site per producer, no more').toBe(3)
    expect([...new Set(nonNull)].sort()).toEqual([
      'withOptionalDatabaseIdentityContext',
      'withOrganizationAcceptanceDischargeContext',
      'withOrganizationDatabaseContext',
    ])
  })

  it('the SEVEN excluded call sites still pass organizationId: null and are NOT gated by L1', () => {
    // TWELVE EXCLUDED SURFACES WOULD BE WRONG AND SO WOULD SIX. The exclusion
    // list is enumerated by ENCLOSING SYMBOL rather than by count, so a
    // renamed or removed exclusion is visible rather than absorbed into an
    // arithmetic that still adds up.
    //
    // THIS IS NOT A CLAIM OF TENANT INVISIBILITY. request.jwt.claims is set
    // unconditionally at these sites, so membership-derived tenant READ
    // visibility via current_user_org_ids() DOES still exist at every one of
    // them. That surface is pre-existing, is owned by
    // MULTI_ORG_TENANT_SCOPE_AUTHORITY E7/E8 and DROP_LAST_RULE, and L1
    // neither widens nor narrows it.
    const dbctx = codeOf('lib/auth/database-context.ts')
    const session = codeOf('lib/auth/session.ts')
    const nullSites = [
      ...identityContextCallSites('lib/auth/database-context.ts', 'NULL').map(
        (s) => `lib/auth/database-context.ts:${s}`
      ),
      ...identityContextCallSites('lib/auth/session.ts', 'NULL').map((s) => `lib/auth/session.ts:${s}`),
    ]
    // SEVEN CALL SITES over SIX ENCLOSING SYMBOLS. The authority enumerates
    // SEVEN non-scoped call sites, TWO of which sit in the same principal-
    // resolution function (its :642 and :660 anchors). Both the CALL COUNT and
    // the SYMBOL SET are asserted: a symbol-set-only control would report SIX
    // and quietly disagree with the authority's SEVEN, and a count-only
    // control would not notice which function moved.
    expect(nullSites.length, 'SEVEN non-scoped withDatabaseIdentityContext call sites').toBe(7)
    expect([...new Set(nullSites)].sort()).toEqual([
      'lib/auth/database-context.ts:listSelectableMemberships',
      'lib/auth/database-context.ts:resolveRequestPrincipal',
      'lib/auth/database-context.ts:withAccountAcceptanceDischargeContext',
      'lib/auth/database-context.ts:withAuthenticatedDatabaseContext',
      'lib/auth/database-context.ts:withSuperAdminDatabaseContext',
      'lib/auth/session.ts:syncUserProfile',
    ])

    // And none of them reaches the L1 predicate. Enforcing L1 at any of these
    // would refuse subjects at the very places they go to ACQUIRE or DISCHARGE
    // a scope — the self-lock class this artifact exists to prevent.
    for (const symbol of [
      'listSelectableMemberships',
      'withAuthenticatedDatabaseContext',
      'withAccountAcceptanceDischargeContext',
      'withSuperAdminDatabaseContext',
    ]) {
      const i = dbctx.indexOf(`export async function ${symbol}`)
      expect(i, `excluded surface not found by symbol: ${symbol}`).toBeGreaterThan(-1)
      const end = dbctx.indexOf('\nexport ', i + 1)
      const body = dbctx.slice(i, end === -1 ? undefined : end)
      expect(body, `L1 MUST NOT be enforced at ${symbol}`).not.toMatch(
        /isOrganizationAcceptanceCurrent|assertOrganizationAcceptanceCurrent|resolveOrganizationAcceptanceCurrent/
      )
    }
    const syncStart = session.indexOf('export async function syncUserProfile')
    expect(syncStart).toBeGreaterThan(-1)
    expect(session.slice(syncStart)).not.toMatch(/isOrganizationAcceptanceCurrent/)
  })
})

/* -------------------------------------------------------------------------- */
/* F-RECERT-1 DISPOSITION B — TOPO-no-second-selected-organization-primitive   */
/* -------------------------------------------------------------------------- */

/**
 * (c.1) BRACE-BALANCED scan — deliberately NOT a first-`}` regex, which stops
 * at the first nested object literal and would report a truncated body.
 */
function declarationsCarryingMembershipAndOrganization(): { declarations: string[]; scanned: number } {
  const declarations: string[] = []
  let scanned = 0
  for (const { file, source } of SOURCES) {
    const re = /(?:export\s+)?(?:interface\s+([A-Za-z0-9_]+)\s*(?:extends[^{]*)?\{|type\s+([A-Za-z0-9_]+)\s*=\s*\{)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      const name = m[1] ?? m[2]
      const open = source.indexOf('{', m.index + m[0].length - 1)
      let depth = 0
      let end = -1
      for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++
        else if (source[i] === '}') {
          depth--
          if (depth === 0) { end = i; break }
        }
      }
      if (end === -1) continue
      scanned++
      const body = source.slice(open + 1, end)
      const hasMembership = /^\s*(?:readonly\s+)?membership\??\s*:/m.test(body)
      const hasOrganization = /^\s*(?:readonly\s+)?organization\??\s*:/m.test(body)
      if (hasMembership && hasOrganization) declarations.push(`${file}:${name}`)
    }
  }
  return { declarations, scanned }
}

describe('TOPO-no-second-selected-organization-primitive (F-RECERT-1, DISPOSITION B)', () => {
  // EXPLICIT NON-PROPERTY, so this control cannot be written into a falsehood:
  // it does NOT assert that no tenant row is visible without a selected
  // organisation, and it MUST NOT be implemented as such an assertion.
  // Membership-derived tenant read visibility via current_user_org_ids() is
  // live, pre-existing and correct under the current model. The property here
  // is THE EMERGENCE OF ANOTHER SELECTED-ORGANIZATION PRIMITIVE, not the
  // reachability of tenant data.

  it('(c.1) EXACTLY FOUR structural types carry both membership and organization — RED on a fifth', () => {
    const { declarations, scanned } = declarationsCarryingMembershipAndOrganization()
    expect(scanned, 'the brace-balanced scan found no declarations at all — a vacuous zero, not a measurement').toBeGreaterThan(0)
    // SORTED EQUALITY, never containment. L1 introduces NO new type: its
    // discharge boundary reuses OrganizationContext rather than declaring a
    // fifth shape, which is the whole reason this assertion is unmoved.
    expect(declarations.sort()).toEqual([
      'lib/auth/database-context.ts:AuthenticatedContext',
      'lib/auth/database-context.ts:OrganizationContext',
      'lib/auth/database-context.ts:RequestPrincipal',
      'lib/auth/database-context.ts:SelectableMembership',
    ])
  })

  it('(c.2) AuthenticatedContext: its two producers still pass organizationId: null', () => {
    const dbctx = codeOf('lib/auth/database-context.ts')
    for (const symbol of ['withAuthenticatedDatabaseContext', 'withAccountAcceptanceDischargeContext']) {
      const i = dbctx.indexOf(`export async function ${symbol}`)
      const end = dbctx.indexOf('\nexport ', i + 1)
      const body = dbctx.slice(i, end === -1 ? undefined : end)
      const calls = body.match(/organizationId:\s*[A-Za-z0-9_.]+/g) ?? []
      expect(calls.length, `${symbol} must invoke withDatabaseIdentityContext`).toBeGreaterThan(0)
      for (const call of calls) expect(call).toBe('organizationId: null')
    }
  })

  it('(c.2) SelectableMembership: neither enumerator opens a non-null selected-org scope', () => {
    const dbctx = codeOf('lib/auth/database-context.ts')
    // Asserted over the NON-NULL CALL-SITE census, not over raw
    // `organizationId:` occurrences inside the bodies: the enumerator BUILDS a
    // SelectableMembership carrying `organizationId: row.organizationId`, an
    // ordinary object property that opens no context at all. A control that
    // matched it would fail for the WRONG REASON, and the only way to make it
    // pass would be to weaken it — which is how a real property gets lost.
    const nonNull = identityContextCallSites('lib/auth/database-context.ts', 'NON_NULL')
    for (const symbol of ['loadSelectableMembershipsWithinContext', 'listSelectableMemberships']) {
      expect(
        dbctx.indexOf(`export async function ${symbol}`),
        `enumerator not found by symbol: ${symbol}`
      ).toBeGreaterThan(-1)
      expect(nonNull, `${symbol} must not open a selected-organization scope`).not.toContain(symbol)
    }
    // And no non-test module derives REQUEST SCOPE from the enumerator's
    // result. The consumers are enumerated by EQUALITY rather than asserted
    // absent — there are seven and they are all legitimate: every one uses the
    // candidate list to decide a DESTINATION (Packet A R2's zero / one-or-more
    // branch, onboarding, the selector, the login and callback routings), and
    // deciding where to send someone is not the same as granting them a scope.
    // Listing them makes an EIGHTH consumer a thing that must be classified
    // rather than something that slips in under an absence claim.
    const consumers = SOURCES.filter(
      (s) => s.file !== 'lib/auth/database-context.ts' && /listSelectableMemberships\s*\(/.test(s.source)
    ).map((s) => s.file)
    expect(consumers.sort()).toEqual([
      'app/(authenticated)/app/onboarding/actions.ts',
      'app/(authenticated)/app/onboarding/page.tsx',
      'app/(authenticated)/app/organizations/select/actions.ts',
      'app/(authenticated)/app/organizations/select/page.tsx',
      'app/(public)/login/actions.ts',
      'app/auth/callback/route.ts',
      'lib/auth/session.ts',
    ])
    // What none of them may do: turn a candidate into a SELECTION. The single
    // authorised carrier writer is asserted separately in (b); here the point
    // is that the L1 discharge surfaces are NOT among the enumerator's
    // consumers at all — an L1 refusal issues ZERO calls to it
    // (NOSCOPE-no-carrier-write-on-refusal).
    expect(consumers).not.toContain('app/(public)/accept-commercial-terms/page.tsx')
    expect(consumers).not.toContain('app/(public)/accept-commercial-terms/actions.ts')
  })

  it('(c.2/c.3) RequestPrincipal gains NO organizationAcceptanceCurrent or equivalent L1-current field', () => {
    // TOPO-no-bare-principal-field, and mutation MUT-L1-attach-to-the-principal-path.
    // The mutation is attractive because it reuses the existing, well-tested
    // B0/L0 memo-safe assertion shape. It is wrong because EVERY possible
    // value of that field is wrong for a subject with no scope: `true` is a
    // bypass, `false` is the FC_5 lockout, `null` invites coercion.
    const dbctx = codeOf('lib/auth/database-context.ts')
    const i = dbctx.indexOf('export interface RequestPrincipal {')
    expect(i).toBeGreaterThan(-1)
    const body = dbctx.slice(i, dbctx.indexOf('\n}', i))
    expect(body).not.toMatch(/organizationAcceptance/i)
    expect(body).not.toMatch(/commercialAcceptance/i)
    expect(body).not.toMatch(/organizationLegal/i)
    // The B0 and L0 principal fields are still there — this is a scoping
    // assertion, not a claim that principal-level gates do not exist.
    expect(body).toMatch(/readonly emailVerified: boolean/)
    expect(body).toMatch(/readonly accountAcceptanceCurrent: boolean/)

    // assertPrincipalGates stays B0-then-L0 only: no L1 on the principal path.
    const gates = dbctx.slice(dbctx.indexOf('function assertPrincipalGates'))
    expect(gates.slice(0, gates.indexOf('\n}'))).not.toMatch(/Organization/)
  })

  it('(c.3) L1 attaches ONLY at OrganizationContext producers — not to AuthenticatedContext, SelectableMembership or RequestPrincipal', () => {
    // "Defense in depth" is NOT a reason to attach it to the other three; on
    // those types it is a DEFECT, because none of them names a selected
    // organisation and L1's predicate has no argument without one.
    const dbctx = codeOf('lib/auth/database-context.ts')
    for (const helper of ['assertEmailVerifiedPrincipal', 'assertAccountAcceptanceCurrentPrincipal', 'requirePrincipal']) {
      const i = dbctx.indexOf(`function ${helper}`)
      expect(i, `principal helper not found: ${helper}`).toBeGreaterThan(-1)
      const body = dbctx.slice(i, dbctx.indexOf('\n}', i))
      expect(body, `L1 must not attach to the principal path at ${helper}`).not.toMatch(
        /isOrganizationAcceptanceCurrent|assertOrganizationAcceptanceCurrent|resolveOrganizationAcceptanceCurrent/
      )
    }
  })

  it('(b) no module introduces a SECOND carrier of organization id as request scope', () => {
    // The selected-organization carrier is WRITTEN by exactly one module
    // (Packet A NO_CARRIER_WRITE_DURING_ROUTING) and READ for request scope by
    // exactly one. L1 adds NO exception and writes no carrier.
    const writers = SOURCES.filter((s) => /setSelectedOrganization\s*\(/.test(s.source) && s.file !== 'lib/auth/selected-organization.ts').map((s) => s.file)
    expect(writers.sort()).toEqual(['app/(authenticated)/app/organizations/select/actions.ts'])

    // TWO readers, and the difference between them is the whole point. Only
    // lib/auth/database-context.ts reads the carrier to derive REQUEST SCOPE.
    // The selector page reads it back COSMETICALLY, to mark which card says
    // "currently selected"; lib/auth/selected-organization.ts is a leaf that
    // performs no lookup, so that read cannot influence which organisations
    // are offered and is not a second scope primitive. Both are named, so a
    // THIRD reader — of either kind — goes RED and has to be classified.
    const readers = SOURCES.filter((s) => /getSelectedOrganizationId\s*\(/.test(s.source) && s.file !== 'lib/auth/selected-organization.ts').map((s) => s.file)
    expect(readers.sort()).toEqual([
      'app/(authenticated)/app/organizations/select/page.tsx',
      'lib/auth/database-context.ts',
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* TOPO-L0-resolver-not-widened                                               */
/* -------------------------------------------------------------------------- */

describe('TOPO-L0-resolver-not-widened (mutation MUT-L1-widen-the-L0-resolver)', () => {
  // The mutation removes duplication and leaves every L0 control green, which
  // is what makes it appealing. It recreates the polymorphism I-X-2 rejects at
  // the QUERY layer, where the database cannot refuse it.

  it('the L0 module exports the SAME account-class signatures, with no organization parameter', () => {
    const l0 = codeOf('lib/auth/legal-acceptance.ts')
    expect(l0).toMatch(/export async function deriveAccountAcceptanceCurrent\(userId: string\): Promise<boolean>/)
    expect(l0).toMatch(/export async function loadRequiredInstrumentsPendingAcceptance\(\s*userId: string\s*\): Promise<RequiredInstrumentForDisplay\[\]>/)
    expect(l0).not.toMatch(/organizationId/)
    expect(l0).not.toMatch(/organization_commercial_acceptances/)
    expect(l0).toMatch(/ACCOUNT_REQUIRED_INSTRUMENT_KEYS = \['terms_of_service', 'privacy_policy'\]/)
  })

  it('L1 uses a DISTINCT resolver module that queries the T4 relation', () => {
    const l1 = codeOf('lib/auth/organization-commercial-acceptance.ts')
    expect(l1).toMatch(/export async function deriveOrganizationAcceptanceCurrent\(organizationId: string\): Promise<boolean>/)
    expect(l1).toMatch(/organization_commercial_acceptances/)
    // It never reads the ACCOUNT-class relation, and never reads
    // CommercialAccount state of any kind (I-T4-8, CA-08, RAT-AO-02 AO2_C3).
    expect(l1).not.toMatch(/account_legal_acceptances/)
    expect(l1).not.toMatch(/commercial_accounts/)
    expect(l1).not.toMatch(/ACTIVE_WITHOUT_STRIPE/)
  })

  it('the two acceptance destinations are DISTINCT constants from DISTINCT modules', () => {
    const l0 = codeOf('lib/auth/legal-acceptance.ts')
    const l1 = codeOf('lib/auth/organization-commercial-acceptance.ts')
    const l0Path = /ACCEPT_LEGAL_PATH = '([^']+)'/.exec(l0)?.[1]
    const l1Path = /ACCEPT_COMMERCIAL_TERMS_PATH = '([^']+)'/.exec(l1)?.[1]
    expect(l0Path).toBeTruthy()
    expect(l1Path).toBeTruthy()
    expect(l1Path).not.toBe(l0Path)
    const verify = codeOf('lib/auth/email-verification.ts')
    expect(l1Path).not.toBe(/VERIFY_EMAIL_PATH = '([^']+)'/.exec(verify)?.[1])

    // Exported from exactly ONE module.
    const definers = SOURCES.filter((s) => /export const ACCEPT_COMMERCIAL_TERMS_PATH/.test(s.source)).map((s) => s.file)
    expect(definers).toEqual(['lib/auth/organization-commercial-acceptance.ts'])
  })

  it('the L1 currency predicate is FAIL-CLOSED — NO catch of any form (FC_6, MUT-L1-permissive-catch)', () => {
    // THIS IS THE DISCRIMINATING CONTROL FOR MUT-L1-permissive-catch, and the
    // real-PG FC_6 suite is its CORROBORATION, not its substitute. Measured
    // adversarially: under the mutation the real-PG control STILL PASSES, but
    // for the WRONG REASON — once a query errors inside a transaction,
    // PostgreSQL aborts it (25P02) and the COMMIT fails, so the REQUEST throws
    // even though the RESOLVER swallowed the error and returned `true`. The
    // behavioural control therefore proves "this request failed closed"; it
    // does NOT prove "the resolver did not convert a failure into a pass",
    // which is the property FC_6 actually names.
    //
    // AND THE PATTERN MUST NOT REQUIRE PARENTHESES. An earlier form matched
    // /catch\s*\(/, which sees `catch (e) {` and is BLIND to the optional-
    // binding form `} catch {` — the shorter, more idiomatic spelling, and the
    // one the mutation naturally uses. A negative that cannot match the most
    // likely spelling of the thing it forbids is not a control.
    const l1 = codeOf('lib/auth/organization-commercial-acceptance.ts')
    expect(l1).not.toMatch(/\bcatch\b/)
    expect(l1).not.toMatch(/\btry\b/)
    // Non-vacuity of the pattern itself: it DOES match both spellings.
    expect('} catch {').toMatch(/\bcatch\b/)
    expect('} catch (error) {').toMatch(/\bcatch\b/)
    expect('promise.catch(() => true)').toMatch(/\bcatch\b/)
  })

  it('the APPLICABLE VERSION is resolved from the live registry, never pinned in code (M-AO-4)', () => {
    const l1 = codeOf('lib/auth/organization-commercial-acceptance.ts')
    // Only the closed required KEY SET is a constant. No version literal, no
    // instrument_version_id literal, and the version comparison is a query.
    expect(l1).toMatch(/ORGANIZATION_REQUIRED_INSTRUMENT_KEYS = \['commercial_terms'\]/)
    expect(l1).not.toMatch(/version\s*[:=]\s*\d+/)
    expect(l1).toMatch(/FROM legal_instrument_versions/)
  })
})

/* -------------------------------------------------------------------------- */
/* TOPO-no-gate-suppression-parameter / TOPO-discharge-not-self-gated         */
/* -------------------------------------------------------------------------- */

/**
 * The discharge boundary's FULL signature and body.
 *
 * THE SIGNATURE IS EXTRACTED BY BALANCING THE PARAMETER-LIST PARENTHESES, not
 * by slicing to the first `{` after the first `)`. That shortcut — which is
 * what the L0 sibling census uses — TRUNCATES the signature at the first brace
 * it meets, and in a TypeScript parameter list that brace is routinely part of
 * a TYPE rather than the function body: `options: DatabaseContextOptions = {}`
 * ends the slice at the default value, and
 * `options: DatabaseContextOptions & { skipL1?: boolean } = {}` ends it right
 * BEFORE the offending member.
 *
 * MEASURED, NOT THEORISED: an adversarial run of exactly that mutation against
 * the truncating form came out GREEN. The control was reading a signature that
 * stopped before the parameter it exists to forbid — a negative assertion over
 * text that cannot contain the thing it prohibits, which is vacuity in its
 * purest form. Balancing the parentheses makes the whole parameter list
 * visible, and the mutation then turns the control RED.
 */
function dischargeBoundarySource(): { signature: string; body: string } {
  const dbctx = codeOf('lib/auth/database-context.ts')
  const start = dbctx.indexOf('export async function withOrganizationAcceptanceDischargeContext')
  expect(start).toBeGreaterThan(-1)

  const open = dbctx.indexOf('(', start)
  expect(open, 'the discharge boundary has no parameter list').toBeGreaterThan(-1)
  let depth = 0
  let close = -1
  for (let i = open; i < dbctx.length; i++) {
    if (dbctx[i] === '(') depth++
    else if (dbctx[i] === ')') {
      depth--
      if (depth === 0) { close = i; break }
    }
  }
  expect(close, 'the discharge boundary parameter list is unbalanced').toBeGreaterThan(-1)

  const end = dbctx.indexOf('\nexport ', start + 1)
  return {
    // Through the closing parenthesis of the parameter list AND the return
    // annotation that follows it, up to the body brace.
    signature: dbctx.slice(start, dbctx.indexOf('{', close)),
    body: dbctx.slice(start, end === -1 ? undefined : end),
  }
}

describe('the L1 discharge boundary — structural controls', () => {
  it('TOPO-no-gate-suppression-parameter: the signature admits NO caller-controlled skip', () => {
    // mutation MUT-L1-parameterise-the-omitted-gate: the parameterised version
    // passes every BEHAVIOURAL control, because the two authorised callers
    // pass the option and behave identically. Only this structural control
    // over the SIGNATURE distinguishes them — and the distinction matters
    // because the blast radius changes from two call sites to every future one.
    const { signature } = dischargeBoundarySource()
    for (const forbidden of [/skipGates/i, /skipL1/i, /gates\s*:/i, /bypass/i, /suppress/i, /enforceL1/i, /Gate\[\]/]) {
      expect(signature, `signature must not accept a gate-selection parameter: ${signature}`).not.toMatch(forbidden)
    }
    expect(signature).toMatch(/callback:\s*\(context:\s*OrganizationContext\)\s*=>\s*Promise<T>/)
    expect(signature).toMatch(/options:\s*DatabaseContextOptions/)
  })

  it('TOPO-discharge-not-self-gated: the boundary does NOT reach the L1 assertion — the omission is in the BODY', () => {
    // Asserted STRUCTURALLY here and BEHAVIOURALLY in the enforcement suite. A
    // behavioural control alone cannot distinguish "does not enforce L1" from
    // "enforces an L1 that happens to pass".
    const { body } = dischargeBoundarySource()
    expect(body).not.toMatch(/assertOrganizationAcceptanceCurrent/)
    expect(body).not.toMatch(/isOrganizationAcceptanceCurrent/)
    expect(body).not.toMatch(/resolveOrganizationAcceptanceCurrent/)
  })

  it('TOPO-discharge-enforces-everything-else: authentication, B0, L0, scope and EXACT role are all still in the body', () => {
    const { body } = dischargeBoundarySource()
    // requirePrincipal carries authentication + B0 + L0 (assertPrincipalGates).
    expect(body).toMatch(/await requirePrincipal\(options\)/)
    expect(body).toMatch(/TENANCY_NO_ORGANIZATION_SELECTED/)
    expect(body).toMatch(/TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER/)
    // EXACT EQUALITY on the role — never a hierarchy threshold, and the role
    // set does not contain super_admin (F-AO-18, RAT-AO-01 AO1_C6).
    expect(body).toMatch(/principal\.membership\.role !== ROLES\.ORGANIZATION_ADMIN/)
    expect(body).not.toMatch(/hasRole|ROLE_HIERARCHY|canManageUsers|canEditOrganization/)
    expect(body).not.toMatch(/>=/)
    // It opens a NON-NULL organisation scope — that is why it cannot reuse the
    // L0 discharge primitive, which passes organizationId: null.
    expect(body).toMatch(/organizationId: principal\.organization\.id/)
  })

  it('the whole auth surface contains NO role-hierarchy predicate for L1', () => {
    // mutation M-AO-15 writes hasRole(role, 'organization_admin'), which passes
    // N-AO-26 (all four non-admin roles still refused, since each RANKS BELOW
    // organization_admin) and admits a tenant super_admin. It is caught only
    // by the control that names super_admin SEPARATELY, which is why N-AO-27
    // may never be folded into the four-role sweep.
    const l1Surfaces = [
      'lib/auth/organization-commercial-acceptance.ts',
      'app/(public)/accept-commercial-terms/page.tsx',
      'app/(public)/accept-commercial-terms/actions.ts',
    ]
    for (const file of l1Surfaces) {
      const source = codeOf(file)
      expect(source, `${file} must not use a role-hierarchy predicate`).not.toMatch(
        /hasRole|ROLE_HIERARCHY|canManageUsers|canEditOrganization|current_user_is_super_admin/
      )
    }
  })
})

/* -------------------------------------------------------------------------- */
/* MUT-L1-census-to-containment — the mutation demonstrated executably         */
/* -------------------------------------------------------------------------- */

describe('MUT-L1-census-to-containment (non-vacuity of the census SHAPE itself)', () => {
  it('containment CANNOT detect an added producer; sorted equality CAN', () => {
    // This is the mutation that would quietly reopen U-AO-4: a containment
    // assertion is green for every SUPERSET, so it cannot fail on the exact
    // event the census exists to catch. Demonstrated on the REAL producer
    // list, not on a toy fixture.
    const actual = [...GOVERNED_PRODUCERS]
    const withAnUngovernedFifth = [...actual, 'lib/rogue/second-primitive.ts:makeOrganizationContext'].sort()

    // The weakened shape: PASSES. It proves nothing about an added producer.
    expect(withAnUngovernedFifth).toEqual(expect.arrayContaining(actual))

    // The shape this file actually uses: FAILS, which is the point.
    expect(() => expect(withAnUngovernedFifth).toEqual(actual)).toThrow()
  })
})

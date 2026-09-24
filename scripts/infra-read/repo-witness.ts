// scripts/infra-read/repo-witness.ts
//
// Same-run repository-identity witness for V-R2.S2 projects[*].link.repo
// (v1.0.7, owner decision CV1_INFRA_LINK_REPO_WITNESS_INVENTORY_READ_OWNER_DECISION).
//
// Two governed executions stopped on OPAQUE_HIGH_ENTROPY at exactly
// V-R2.S2 / projects[*].link.repo. This module can adjudicate THAT finding,
// and only that one, as EXPECTED_PROVIDER_IDENTIFIER, and only when the
// linked repository is bound, within the SAME execution, to an identity GitHub
// itself returned from its documented inventory of the authenticated user's
// repositories (GET /user/repos, operationId repos/list-for-authenticated-user).
//
// Properties, each tested and mutation-pinned:
//   * NO VERCEL VALUE REACHES GITHUB. The only request input is a page number;
//     link.repoId is an in-memory comparison key and never a request input.
//   * BOUNDED MEMORY. Retained state is the finite target set, at most the
//     matched identities per target, and page-control metadata. A page's
//     non-matching repositories are discarded as soon as it is compared; the
//     whole inventory is never held, logged or persisted.
//   * EXACTLY ONCE. Pagination always runs to COMPLETION (an empty page) even
//     after every target matched: "exists exactly once" is established, not
//     assumed from id uniqueness. Zero or multiple matches STOP.
//   * EXACT BINDING. numeric link.repoId === id, link.type === 'github',
//     link.repo === name, link.org === owner.login, full_name ===
//     owner.login + '/' + name. Strict string equality: no case folding or
//     trimming (no provider documentation justifies normalizing).
//   * FAIL CLOSED. Anything else (a malformed page or item, a pagination
//     loop, the page cap, an out-of-order page, UNKNOWN) is a Refusal.

import { Refusal } from './ops'

export interface WitnessTarget {
  readonly projectId: string
  readonly repoId: number
  readonly linkType: string
  readonly linkRepo: string
  readonly linkOrg: string
}

interface GithubIdentity {
  readonly id: number
  readonly name: string
  readonly fullName: string
  readonly ownerLogin: string
}

/** Defensive bound: 100 pages x 100 = 10,000 accessible repositories. Beyond it the traversal STOPs. */
export const MAX_INVENTORY_PAGES = 100
export const INVENTORY_PAGE_SIZE = 100

/**
 * v1.0.8: GitHub's documented repository-name grammar, verbatim from
 * https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository
 * ("must not exceed 100 characters, and can only contain ASCII letters, digits,
 * and the characters ., -, and _"). Defense in depth: a link.repo outside it is
 * never deferred, never a witness target, never explained by the evidence
 * re-scan. It only NARROWS; it does not normalize anything.
 */
export const GITHUB_REPOSITORY_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

export const ADJUDICATION_CLASSIFICATION = 'EXPECTED_PROVIDER_IDENTIFIER'
export const ADJUDICATION_BASIS = 'SAME_RUN_AUTHENTICATED_REPOSITORY_INVENTORY_ID_MATCH'

function stop(token: string, detail: string): never {
  throw new Refusal(token, detail)
}

export function isRepoId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

export class RepositoryInventoryWitness {
  private readonly targets = new Map<number, WitnessTarget[]>()
  private readonly matches = new Map<number, GithubIdentity[]>()
  private nextPage = 1
  private started = false
  private complete = false
  private lastPageSignature: string | undefined

  /** Registered from the SAME run's V-R2.S2 projection, before the traversal starts. */
  addTarget(t: WitnessTarget): void {
    if (this.started) stop('STOP_WITNESS_ORDER', 'a target was registered after the inventory traversal started')
    if (!isRepoId(t.repoId)) stop('STOP_WITNESS_UNKNOWN', 'link.repoId is not a positive safe integer')
    for (const [k, v] of [['projectId', t.projectId], ['linkType', t.linkType], ['linkRepo', t.linkRepo], ['linkOrg', t.linkOrg]] as const) {
      if (typeof v !== 'string' || v === '') stop('STOP_WITNESS_UNKNOWN', `target ${k} missing or not a string`)
    }
    if (!GITHUB_REPOSITORY_NAME_RE.test(t.linkRepo)) stop('STOP_WITNESS_UNKNOWN', 'link.repo is outside the documented repository-name grammar')
    const list = this.targets.get(t.repoId) ?? []
    list.push(Object.freeze({ ...t }))
    this.targets.set(t.repoId, list)
  }

  hasTargets(): boolean {
    return this.targets.size > 0
  }

  isComplete(): boolean {
    return this.complete
  }

  /** The page the next G-R5 request must ask for; refuses once the traversal is complete. */
  expectedPage(): number {
    if (!this.hasTargets()) stop('STOP_READ_AUTHORITY_EXCEEDED', 'G-R5 without an adjudication target')
    if (this.complete) stop('STOP_READ_AUTHORITY_EXCEEDED', 'G-R5 after the inventory traversal completed')
    return this.nextPage
  }

  /**
   * Consumes ONE projected page (an array of {id,name,full_name,owner.login}),
   * retains only target matches, discards everything else, and returns control
   * metadata only.
   */
  ingestPage(page: number, projection: unknown): { readonly page: number; readonly item_count: number } {
    if (page !== this.expectedPage()) stop('STOP_PAGINATION_INCOMPLETE', 'G-R5 page is not the next expected page')
    this.started = true
    if (!Array.isArray(projection)) stop('STOP_PROVIDER_OUTPUT_UNPARSABLE', 'G-R5 page is not an array')
    if (projection.length > INVENTORY_PAGE_SIZE) stop('STOP_PAGINATION_INCOMPLETE', 'G-R5 page exceeds per_page')
    if (projection.length === 0) {
      this.complete = true
      this.nextPage = page + 1
      return { page, item_count: 0 }
    }
    let first = 0
    let last = 0
    projection.forEach((raw, i) => {
      const item = raw as Record<string, unknown> | null
      const owner = item && typeof item.owner === 'object' && item.owner !== null ? (item.owner as Record<string, unknown>).login : undefined
      if (!item || !isRepoId(item.id) || typeof item.name !== 'string' || item.name === '' || typeof item.full_name !== 'string' || typeof owner !== 'string' || owner === '') {
        stop('STOP_PROVIDER_OUTPUT_UNPARSABLE', 'G-R5 repository item lacks a valid id, name, full_name or owner.login')
      }
      if (i === 0) first = item.id as number
      last = item.id as number
      if (this.targets.has(item.id as number)) {
        const list = this.matches.get(item.id as number) ?? []
        list.push(Object.freeze({ id: item.id as number, name: item.name as string, fullName: item.full_name as string, ownerLogin: owner }))
        this.matches.set(item.id as number, list)
      }
      // A non-matching item is not retained anywhere past this point.
    })
    const signature = `${first}:${last}:${projection.length}`
    if (signature === this.lastPageSignature) stop('STOP_PAGINATION_LOOP', 'G-R5 returned the same page twice')
    this.lastPageSignature = signature
    this.nextPage = page + 1
    if (this.nextPage > MAX_INVENTORY_PAGES && !this.complete) {
      // The next request would exceed the cap: the traversal cannot complete.
      stop('STOP_PAGINATION_INCOMPLETE', `G-R5 inventory exceeds ${MAX_INVENTORY_PAGES} pages`)
    }
    return { page, item_count: projection.length }
  }

  /**
   * Verdict for every target. Returns the matched identities (id + owner.login
   * only) on PASS; throws on anything else.
   */
  verdict(): { readonly resolved: readonly { readonly id: number; readonly owner: { readonly login: string } }[]; readonly adjudicated: readonly WitnessTarget[] } {
    if (!this.hasTargets()) stop('STOP_WITNESS_UNKNOWN', 'no adjudication target')
    if (!this.complete) stop('STOP_PAGINATION_INCOMPLETE', 'the inventory traversal did not complete')
    const resolved: { id: number; owner: { login: string } }[] = []
    const adjudicated: WitnessTarget[] = []
    for (const [repoId, targets] of this.targets) {
      const found = this.matches.get(repoId) ?? []
      if (found.length === 0) stop('STOP_WITNESS_ZERO_MATCH', 'a link.repoId has no repository in the authenticated inventory')
      if (found.length > 1) stop('STOP_WITNESS_MULTIPLE_MATCH', 'a link.repoId matched more than one repository')
      const gh = found[0]
      if (gh.id !== repoId) stop('STOP_WITNESS_ID_MISMATCH', 'repository id does not equal link.repoId')
      if (gh.fullName !== `${gh.ownerLogin}/${gh.name}`) stop('STOP_WITNESS_FULL_NAME_INCOHERENT', 'full_name is not owner.login/name')
      for (const t of targets) {
        if (t.linkType !== 'github') stop('STOP_WITNESS_TYPE_MISMATCH', 'link.type is not github')
        if (t.linkRepo !== gh.name) stop('STOP_WITNESS_NAME_MISMATCH', 'link.repo does not equal the repository name')
        if (t.linkOrg !== gh.ownerLogin) stop('STOP_WITNESS_OWNER_MISMATCH', 'link.org does not equal owner.login')
        adjudicated.push(t)
      }
      resolved.push({ id: gh.id, owner: { login: gh.ownerLogin } })
    }
    return { resolved, adjudicated }
  }

  /** Test introspection: retained state is bounded by the target set, not the inventory. */
  retainedCounts(): { readonly targets: number; readonly matchedIdentities: number } {
    let m = 0
    for (const l of this.matches.values()) m += l.length
    let t = 0
    for (const l of this.targets.values()) t += l.length
    return { targets: t, matchedIdentities: m }
  }
}

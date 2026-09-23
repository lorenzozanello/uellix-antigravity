// scripts/infra-read/ops.ts
//
// CLOSED OPERATION REGISTRY for the CV1 control-plane read authority (PR #214).
//
// Every provider operation the safe-read executor may perform is declared here
// and nowhere else. A caller selects an operation by id and supplies typed
// parameters; it never supplies an endpoint, a method, a flag or an argv. The
// executor builds the invocation from this registry and then re-validates the
// built invocation against the exact shape the registry allows, so a bug in a
// builder cannot become a write.
//
// Authority: docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_AUTHORITY_v1.0.0.json
// as amended through v1.0.4. Field allowlists below are the concrete,
// executable form of each read's field_allowlist. Nothing outside them is ever
// emitted as evidence.

export type Plane = 'PLANE-V' | 'PLANE-G' | 'PLANE-X'
export type OpClass = 'GOVERNED_READ' | 'PACMI'
export type Tool = 'gh' | 'vercel' | 'git'

/**
 * EXECUTE_NOW — may run in the read-only control-plane phase.
 * F_IMMEDIATE_ONLY_BEFORE_MUTATION — authorized, but only as the immediate
 * prestate of a named mutation; refused in the read-only phase (V-R4).
 */
export type Freshness = 'EXECUTE_NOW' | 'F_IMMEDIATE_ONLY_BEFORE_MUTATION'

/**
 * Whether evidence from this op may be cited as a standing prestate for a
 * future mutation. It never may: a current observation is evidence for the
 * instant it names and must be re-read immediately before any mutation.
 */
export const PRESTATE_VALIDITY = 'EVIDENCE_ONLY__NOT_A_STANDING_PRESTATE' as const

// ---------------------------------------------------------------- constants

export const GH_OWNER = 'lorenzozanello'
export const GH_REPO = 'uellix-antigravity'
export const GH_REPO_PATH = `/repos/${GH_OWNER}/${GH_REPO}`
export const X_R1_URL = 'https://github.com/lorenzozanello/uellix-antigravity.git'
export const FIXED_PROTECTED_BRANCHES = ['main', 'integration/commercial-v1'] as const
export const RELEASE_BRANCH = 'release/commercial-v1'
export const ANTIGRAVITY_PROJECT = 'uellix-antigravity'
export const PRODUCTION_WEB_PROJECT = 'uellix-production-web'

/** Tool versions the flag semantics were MEASURED against. Drift fails closed. */
export const PINNED_TOOL_VERSIONS = { gh: '2.93.0', vercel: '54.14.2' } as const

const TEAM = 'team_[A-Za-z0-9]{6,64}'
const PRJ = 'prj_[A-Za-z0-9]{6,64}'
const UNTIL = '(?:&until=[0-9]{1,20})?'
const BRANCH_ENC = '[A-Za-z0-9._%-]{1,250}'
const SHA40 = '[0-9a-f]{40}'
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const GH = esc(GH_REPO_PATH)

export const TEAM_ID_RE = new RegExp(`^${TEAM}$`)
export const PROJECT_ID_RE = new RegExp(`^${PRJ}$`)
export const SHA40_RE = new RegExp(`^${SHA40}$`)
export const UNTIL_RE = /^[0-9]{1,20}$/
/** G-R5 page number: 1..999, digits only, no sign, no leading zero (v1.0.7). */
export const INVENTORY_PAGE_RE = /^[1-9][0-9]{0,2}$/
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]{1,200}$/

export type Params = Readonly<Record<string, string | undefined>>

export interface OpDef {
  readonly id: string
  readonly read: string
  readonly cls: OpClass
  readonly plane: Plane
  readonly tool: Tool
  readonly freshness: Freshness
  readonly nodeIds: readonly string[]
  /** Exact regex the built endpoint path must match (gh/vercel governed reads). */
  readonly pathPattern?: RegExp
  /** gh list endpoints use --paginate --slurp; vercel pagination is explicit via &until. */
  readonly ghPaginate?: boolean
  /** Fixed argv for non-path ops (PACMI, git). */
  readonly fixedArgs?: readonly string[]
  /** Dotted field paths; `[]` marks an array; a trailing `.**` admits a subtree. */
  readonly allowlist: readonly string[]
  /** Fields recorded as presence booleans only, never their contents. */
  readonly presenceOnly?: readonly string[]
  /** HTTP statuses that are a valid, interpretable outcome besides 200. */
  readonly acceptedStatuses?: readonly number[]
  readonly build?: (p: Params) => string
}

export class Refusal extends Error {
  constructor(readonly token: string, detail: string) {
    super(`${token}: ${detail}`)
    this.name = 'Refusal'
  }
}

function req(p: Params, key: string, re: RegExp): string {
  const v = p[key]
  if (typeof v !== 'string' || !re.test(v)) {
    throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', `parameter ${key} missing or malformed`)
  }
  return v
}

function until(p: Params): string {
  const v = p.until
  if (v === undefined) return ''
  if (!UNTIL_RE.test(v)) throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'until malformed')
  return `&until=${v}`
}

function branchEnc(p: Params): string {
  const b = p.branch
  if (typeof b !== 'string' || !BRANCH_NAME_RE.test(b) || b.includes('..')) {
    throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'branch missing or malformed')
  }
  return encodeURIComponent(b)
}

const PROTECTION_FIELDS = [
  'required_status_checks.strict',
  'required_status_checks.contexts[]',
  'required_status_checks.checks[].context',
  'required_status_checks.checks[].app_id',
  'required_pull_request_reviews.required_approving_review_count',
  'required_pull_request_reviews.dismiss_stale_reviews',
  'required_pull_request_reviews.require_code_owner_reviews',
  'required_pull_request_reviews.require_last_push_approval',
  'enforce_admins.enabled',
  'required_linear_history.enabled',
  'allow_force_pushes.enabled',
  'allow_deletions.enabled',
  'block_creations.enabled',
  'required_conversation_resolution.enabled',
  'lock_branch.enabled',
  'restrictions.users[].login',
  'restrictions.teams[].slug',
  'restrictions.apps[].slug',
] as const

const PROJECT_IDENTITY_FIELDS = [
  'id', 'name', 'accountId', 'createdAt', 'updatedAt',
  'link.type', 'link.repo', 'link.org', 'link.repoId', 'link.productionBranch',
] as const

const DEPLOY_HOOK_METADATA = [
  'link.deployHooks[].id', 'link.deployHooks[].name', 'link.deployHooks[].ref', 'link.deployHooks[].createdAt',
] as const

const PAGINATION = ['pagination.next', 'pagination.count'] as const

const ops: OpDef[] = [
  // ------------------------------------------------------------- PLANE-G
  {
    id: 'G-R1', read: 'G-R1', cls: 'GOVERNED_READ', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-4'], pathPattern: new RegExp(`^${GH}$`), build: () => GH_REPO_PATH,
    allowlist: [
      'id', 'node_id', 'full_name', 'owner.login', 'default_branch', 'private', 'visibility',
      'archived', 'disabled', 'fork', 'created_at', 'updated_at',
      // RC-9b: the authenticated permission object, captured WITHIN the first G-R1 read.
      'permissions.admin', 'permissions.maintain', 'permissions.push', 'permissions.triage', 'permissions.pull',
    ],
  },
  {
    id: 'G-R3', read: 'G-R3', cls: 'GOVERNED_READ', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-4', 'DN-11', 'DN-12'], pathPattern: new RegExp(`^${GH}$`), build: () => GH_REPO_PATH,
    allowlist: ['default_branch', 'id', 'node_id', 'full_name'],
  },
  {
    // Non-emptiness witness for limbs A and C: a 404 on protection is only
    // interpretable if the SAME encoded branch path resolves here (DF-3/DF-5 class).
    id: 'G-R2.WITNESS', read: 'G-R2', cls: 'GOVERNED_READ', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-4', 'DN-8', 'DN-9', 'DN-12'],
    pathPattern: new RegExp(`^${GH}/branches/${BRANCH_ENC}$`),
    build: (p) => `${GH_REPO_PATH}/branches/${branchEnc(p)}`,
    allowlist: ['name', 'protected', 'commit.sha'],
    acceptedStatuses: [404],
  },
  {
    id: 'G-R2.A', read: 'G-R2', cls: 'GOVERNED_READ', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-4', 'DN-8', 'DN-9', 'DN-12'],
    pathPattern: new RegExp(`^${GH}/branches/${BRANCH_ENC}/protection$`),
    build: (p) => `${GH_REPO_PATH}/branches/${branchEnc(p)}/protection`,
    allowlist: [...PROTECTION_FIELDS],
    acceptedStatuses: [404],
  },
  {
    id: 'G-R2.B', read: 'G-R2', cls: 'GOVERNED_READ', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-4', 'DN-7', 'DN-8', 'DN-9', 'DN-10', 'DN-12'],
    pathPattern: new RegExp(`^${GH}/rulesets\\?per_page=100$`),
    build: () => `${GH_REPO_PATH}/rulesets?per_page=100`, ghPaginate: true,
    allowlist: ['[].id', '[].name', '[].target', '[].source', '[].source_type', '[].enforcement'],
  },
  {
    id: 'G-R2.B.DETAIL', read: 'G-R2', cls: 'GOVERNED_READ', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-4', 'DN-7', 'DN-8', 'DN-9', 'DN-10', 'DN-12'],
    pathPattern: new RegExp(`^${GH}/rulesets/[0-9]{1,12}$`),
    build: (p) => `${GH_REPO_PATH}/rulesets/${req(p, 'rulesetId', /^[0-9]{1,12}$/)}`,
    allowlist: [
      'id', 'name', 'target', 'source', 'source_type', 'enforcement',
      'conditions.ref_name.include[]', 'conditions.ref_name.exclude[]',
      'conditions.repository_name.include[]', 'conditions.repository_name.exclude[]',
      'rules[].type', 'rules[].parameters.**',
      'bypass_actors[].actor_type', 'bypass_actors[].actor_id',
    ],
  },
  {
    id: 'G-R2.C', read: 'G-R2', cls: 'GOVERNED_READ', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-4', 'DN-8', 'DN-9', 'DN-12'],
    pathPattern: new RegExp(`^${GH}/rules/branches/${BRANCH_ENC}\\?per_page=100$`),
    build: (p) => `${GH_REPO_PATH}/rules/branches/${branchEnc(p)}?per_page=100`, ghPaginate: true,
    allowlist: ['[].type', '[].parameters.**', '[].ruleset_id', '[].ruleset_source_type', '[].ruleset_source'],
  },
  {
    // CORROBORATIVE_AUTHORIZED_READ (v1.0.2): serves no node; falsifies the corpus parse.
    id: 'G-R4.RUNS', read: 'G-R4', cls: 'GOVERNED_READ', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW',
    nodeIds: [],
    pathPattern: new RegExp(`^${GH}/commits/${SHA40}/check-runs\\?per_page=100$`),
    build: (p) => `${GH_REPO_PATH}/commits/${req(p, 'sha', SHA40_RE)}/check-runs?per_page=100`, ghPaginate: true,
    allowlist: [
      '[].total_count', '[].check_runs[].id', '[].check_runs[].name', '[].check_runs[].status',
      '[].check_runs[].conclusion', '[].check_runs[].started_at', '[].check_runs[].completed_at',
      '[].check_runs[].head_sha', '[].check_runs[].app.slug',
    ],
  },
  {
    id: 'G-R4.STATUS', read: 'G-R4', cls: 'GOVERNED_READ', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW',
    nodeIds: [],
    pathPattern: new RegExp(`^${GH}/commits/${SHA40}/status$`),
    build: (p) => `${GH_REPO_PATH}/commits/${req(p, 'sha', SHA40_RE)}/status`,
    allowlist: ['state', 'sha', 'total_count', 'statuses[].context', 'statuses[].state'],
  },
  {
    // v1.0.7 (owner decision LRW-2): the authenticated user's repository
    // inventory, officially documented as GET /user/repos
    // (repos/list-for-authenticated-user). ONE read class; it paginates only
    // because the endpoint does. Its ONLY input is the page number: no Vercel
    // value (link.repo, link.org, link.repoId) can reach the request. Pages are
    // reduced to target matches in-process (repo-witness.ts) before any scan or
    // evidence; the inventory is never persisted.
    id: 'G-R5', read: 'G-R5', cls: 'GOVERNED_READ', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-2', 'DN-11'],
    pathPattern: /^\/user\/repos\?per_page=100&page=[1-9][0-9]{0,2}$/,
    build: (p) => `/user/repos?per_page=100&page=${req(p, 'page', INVENTORY_PAGE_RE)}`,
    allowlist: ['[].id', '[].name', '[].full_name', '[].owner.login'],
  },

  // ------------------------------------------------------------- PLANE-V
  {
    id: 'V-R2.S1', read: 'V-R2', cls: 'GOVERNED_READ', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-2', 'DN-11'],
    pathPattern: new RegExp(`^/v2/teams\\?limit=100${UNTIL}$`),
    build: (p) => `/v2/teams?limit=100${until(p)}`,
    allowlist: ['teams[].id', 'teams[].slug', 'teams[].name', ...PAGINATION],
  },
  {
    id: 'V-R2.S2', read: 'V-R2', cls: 'GOVERNED_READ', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-2', 'DN-11'],
    pathPattern: new RegExp(`^/v9/projects\\?teamId=${TEAM}&limit=100${UNTIL}$`),
    build: (p) => `/v9/projects?teamId=${req(p, 'teamId', TEAM_ID_RE)}&limit=100${until(p)}`,
    allowlist: [...PROJECT_IDENTITY_FIELDS.map((f) => `projects[].${f}`), ...PAGINATION],
  },
  {
    id: 'V-R2.S3', read: 'V-R2', cls: 'GOVERNED_READ', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-2', 'DN-11'],
    pathPattern: new RegExp(`^/v9/projects/${PRODUCTION_WEB_PROJECT}\\?teamId=${TEAM}$`),
    build: (p) => `/v9/projects/${PRODUCTION_WEB_PROJECT}?teamId=${req(p, 'teamId', TEAM_ID_RE)}`,
    allowlist: [...PROJECT_IDENTITY_FIELDS],
    acceptedStatuses: [404],
  },
  {
    id: 'V-R2.L1', read: 'V-R2', cls: 'GOVERNED_READ', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-2', 'DN-11'],
    pathPattern: new RegExp(`^/v9/projects/${PRJ}/domains\\?teamId=${TEAM}&limit=100${UNTIL}$`),
    build: (p) => `/v9/projects/${req(p, 'projectId', PROJECT_ID_RE)}/domains?teamId=${req(p, 'teamId', TEAM_ID_RE)}&limit=100${until(p)}`,
    allowlist: [
      'domains[].name', 'domains[].apexName', 'domains[].projectId', 'domains[].verified',
      'domains[].createdAt', 'domains[].redirect', ...PAGINATION,
    ],
  },
  {
    id: 'V-R2.L3', read: 'V-R2', cls: 'GOVERNED_READ', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-2', 'DN-11'],
    pathPattern: new RegExp(`^/v4/aliases\\?projectId=${PRJ}&teamId=${TEAM}&limit=100${UNTIL}$`),
    build: (p) => `/v4/aliases?projectId=${req(p, 'projectId', PROJECT_ID_RE)}&teamId=${req(p, 'teamId', TEAM_ID_RE)}&limit=100${until(p)}`,
    allowlist: [
      'aliases[].uid', 'aliases[].alias', 'aliases[].deploymentId', 'aliases[].projectId',
      'aliases[].created', 'aliases[].updated', ...PAGINATION,
    ],
  },
  {
    // decrypt=false is part of the literal pattern; decrypt=true cannot match.
    id: 'V-R2.L5', read: 'V-R2', cls: 'GOVERNED_READ', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-2', 'DN-11'],
    pathPattern: new RegExp(`^/v10/projects/${PRJ}/env\\?decrypt=false&teamId=${TEAM}$`),
    build: (p) => `/v10/projects/${req(p, 'projectId', PROJECT_ID_RE)}/env?decrypt=false&teamId=${req(p, 'teamId', TEAM_ID_RE)}`,
    allowlist: [
      'envs[].id', 'envs[].key', 'envs[].target[]', 'envs[].target', 'envs[].gitBranch', 'envs[].type',
      'envs[].createdAt', 'envs[].updatedAt', 'envs[].customEnvironmentIds[]', ...PAGINATION,
    ],
  },
  {
    id: 'V-R2.L7', read: 'V-R2', cls: 'GOVERNED_READ', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-2', 'DN-11'],
    pathPattern: new RegExp(`^/v6/deployments\\?projectId=${PRJ}&teamId=${TEAM}&limit=100${UNTIL}$`),
    build: (p) => `/v6/deployments?projectId=${req(p, 'projectId', PROJECT_ID_RE)}&teamId=${req(p, 'teamId', TEAM_ID_RE)}&limit=100${until(p)}`,
    allowlist: [
      'deployments[].uid', 'deployments[].name', 'deployments[].url', 'deployments[].target',
      'deployments[].readyState', 'deployments[].source', 'deployments[].createdAt',
      'deployments[].meta.githubCommitSha', 'deployments[].meta.githubCommitRef', 'deployments[].meta.githubRepo',
      ...PAGINATION,
    ],
  },
  {
    id: 'V-R1', read: 'V-R1', cls: 'GOVERNED_READ', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-1', 'DN-11', 'DN-14'],
    pathPattern: new RegExp(`^/v9/projects/${ANTIGRAVITY_PROJECT}\\?teamId=${TEAM}$`),
    build: (p) => `/v9/projects/${ANTIGRAVITY_PROJECT}?teamId=${req(p, 'teamId', TEAM_ID_RE)}`,
    allowlist: [
      ...PROJECT_IDENTITY_FIELDS, ...DEPLOY_HOOK_METADATA,
      'link.gitCredentialId', 'commandForIgnoringBuildStep', 'gitForkProtection', 'gitLFS',
      'autoExposeSystemEnvs', 'autoAssignCustomDomains', 'autoJobCancelation', 'ssoProtection.deploymentType',
      // v1.0.4 LOCUS PIN of v1.0.0's mandatory automatic-deployment limb.
      'gitProviderOptions.createDeployments',
    ],
    presenceOnly: ['passwordProtection', 'trustedIps'],
  },
  {
    // Concrete enumeration of the Git integration block (v1.0.4 replaces the
    // by-subtraction allowlist, the one place RC-5 did not hold).
    id: 'V-R3', read: 'V-R3', cls: 'GOVERNED_READ', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-3', 'DN-7', 'DN-14'],
    pathPattern: new RegExp(`^/v9/projects/${ANTIGRAVITY_PROJECT}\\?teamId=${TEAM}$`),
    build: (p) => `/v9/projects/${ANTIGRAVITY_PROJECT}?teamId=${req(p, 'teamId', TEAM_ID_RE)}`,
    allowlist: [
      'id', 'name', 'link.type', 'link.repo', 'link.org', 'link.repoId', 'link.productionBranch',
      'link.gitCredentialId', 'link.createdAt', 'link.updatedAt', ...DEPLOY_HOOK_METADATA,
      'commandForIgnoringBuildStep', 'gitForkProtection', 'gitLFS', 'autoExposeSystemEnvs',
      'autoAssignCustomDomains', 'gitComments.onCommit', 'gitComments.onPullRequest',
      'gitProviderOptions.createDeployments', 'rootDirectory',
    ],
  },
  {
    // Authorized, but F-IMMEDIATE only: DN-11's THROUGHOUT clause needs a
    // bracketing read around M-7. Refused in the read-only phase.
    id: 'V-R4.DEPLOYMENTS', read: 'V-R4', cls: 'GOVERNED_READ', plane: 'PLANE-V', tool: 'vercel',
    freshness: 'F_IMMEDIATE_ONLY_BEFORE_MUTATION', nodeIds: ['DN-11'],
    pathPattern: new RegExp(`^/v6/deployments\\?projectId=${PRJ}&teamId=${TEAM}&target=production&limit=100${UNTIL}$`),
    build: (p) => `/v6/deployments?projectId=${req(p, 'projectId', PROJECT_ID_RE)}&teamId=${req(p, 'teamId', TEAM_ID_RE)}&target=production&limit=100${until(p)}`,
    allowlist: [
      'deployments[].uid', 'deployments[].target', 'deployments[].readyState', 'deployments[].source',
      'deployments[].createdAt', 'deployments[].meta.githubCommitSha', 'deployments[].meta.githubCommitRef',
      ...PAGINATION,
    ],
  },

  // ------------------------------------------------------------- PLANE-X
  {
    id: 'X-R1', read: 'X-R1', cls: 'GOVERNED_READ', plane: 'PLANE-X', tool: 'git', freshness: 'EXECUTE_NOW',
    nodeIds: ['DN-5', 'DN-7'],
    fixedArgs: ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.extraHeader=', 'ls-remote', X_R1_URL],
    allowlist: ['total_ref_count', 'refs[].name', 'refs[].sha', 'release_heads[]', 'release_tags[]', 'main_head'],
  },

  // ------------------------------------------------------------- PACMI (RC-9a)
  {
    id: 'PACMI-G1', read: 'PACMI-G1', cls: 'PACMI', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW',
    nodeIds: [], fixedArgs: ['auth', 'status', '--json', 'hosts'],
    allowlist: [
      'hosts.github.com[].login', 'hosts.github.com[].active', 'hosts.github.com[].state',
      'hosts.github.com[].scopes', 'hosts.github.com[].tokenSource', 'hosts.github.com[].gitProtocol',
      'hosts.github.com[].host',
    ],
  },
  {
    id: 'PACMI-V1', read: 'PACMI-V1', cls: 'PACMI', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: [], fixedArgs: ['whoami', '--format', 'json'],
    allowlist: ['username', 'uid', 'id'],
  },
  {
    id: 'PACMI-V2', read: 'PACMI-V2', cls: 'PACMI', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: [], fixedArgs: ['teams', 'list', '--format', 'json'],
    allowlist: ['teams[].id', 'teams[].slug', 'teams[].name', 'teams[].current'],
  },
  {
    id: 'PACMI-V3', read: 'PACMI-V3', cls: 'PACMI', plane: 'PLANE-V', tool: 'vercel', freshness: 'EXECUTE_NOW',
    nodeIds: [], fixedArgs: ['teams', 'members', '--format', 'json'],
    // Minimization is applied BEFORE projection: only the authenticated row survives.
    allowlist: ['members[].uid', 'members[].username', 'members[].role'],
  },
]

export const REGISTRY: ReadonlyMap<string, OpDef> = new Map(ops.map((o) => [o.id, Object.freeze(o)]))

export function getOp(id: string): OpDef {
  const op = REGISTRY.get(id)
  if (!op) throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', `operation ${JSON.stringify(id)} is not in the closed registry`)
  return op
}

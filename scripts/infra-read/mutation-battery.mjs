// scripts/infra-read/mutation-battery.mjs — production-code mutation battery for the safe-read executor.
//
//   node scripts/infra-read/mutation-battery.mjs              every mutant; exit 0 only if ALL are killed
//   node scripts/infra-read/mutation-battery.mjs --only A,B   a subset (same aggregate rule)
//   node scripts/infra-read/mutation-battery.mjs --self-test  proves the battery FAILS when fed a survivor
//   add --json <file> to write the rows
//
// Run from the repository root. Each mutant is applied, tests/infra-read is run,
// and the file is restored from an in-memory byte copy (never git checkout) and
// verified by SHA-256. The UNMUTATED suite must be green first, or no verdict
// means anything. v1.0.5: verdict logic moved to mutation-verdict.mjs (the
// v1.0.4 summary reported SURVIVED as AS_EXPECTED and could not fail).
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { aggregate, classify, verdictOf } from './mutation-verdict.mjs'

const R = process.cwd().split('\\').join('/') + '/'
const F = (p) => R + 'scripts/infra-read/' + p
const G = F('guards.ts'), E = F('executor.ts'), X = F('xcc1.ts'), P = F('protocol.ts'), S = F('evidence-scan.ts')
const C = F('certification.ts'), O = F('ops.ts'), RG = F('run-governed-reads.ts'), D = F('safe-diagnostic.ts')
const W = F('repo-witness.ts'), A = F('evidence-adjudication.ts'), SS = R + 'scripts/scan-secrets.ts'
const XR1 = "fixedArgs: ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.extraHeader=', 'ls-remote', X_R1_URL]"

// [id, description, file, find, replace, expectation]
export const MUTANTS = [
  // ---- retained from v1.0.4 (GitHub / Vercel POST+body+write-op, ordering, projection, XCC-1, DN-0)
  ['M01', 'gh exact-shape check removed (POST/body forms)', G, "if (!sameArgv(inv.argv, expected)) throw new Refusal('STOP_GH_NON_GET_OR_BODY_FORM'", "if (false) throw new Refusal('STOP_GH_NON_GET_OR_BODY_FORM'", 'KILLED'],
  ['M02', 'gh denylist emptied (exact shape still operative)', G, 'export const GH_FORBIDDEN_FLAGS = [', 'export const GH_FORBIDDEN_FLAGS = [] as string[]; const _unused = [', 'KILLED'],
  ['M03', 'vercel exact-shape check removed (POST/body forms)', G, "if (!sameArgv(inv.argv, expected)) throw new Refusal('STOP_VERCEL_NON_GET_OR_BODY_FORM'", "if (false) throw new Refusal('STOP_VERCEL_NON_GET_OR_BODY_FORM'", 'KILLED'],
  ['M04', 'projection conformance disabled', G, 'export function assertProjectionConforms(op: OpDef, projection: unknown): void {', 'export function assertProjectionConforms(op: OpDef, projection: unknown): void { return;', 'KILLED'],
  ['M05', 'G-R1-first check removed (G-R2 before G-R1)', E, "if (!s.ghRepo) throw new Refusal('STOP_GR1_NOT_FIRST'", "if (false) throw new Refusal('STOP_GR1_NOT_FIRST'", 'KILLED'],
  ['M06', 'RC-9b check removed', E, "if (op.read === 'G-R2' && !s.rc9bDischarged) {", 'if (false) {', 'KILLED'],
  ['M07', 'RNA-1 exclusion removed', E, 'if (name === ANTIGRAVITY_PROJECT || s.antigravityIds.has(prj)) {', 'if (false) {', 'KILLED'],
  ['M08', 'freshness refusal removed', E, "if (op.freshness !== 'EXECUTE_NOW') {", 'if (false) {', 'KILLED'],
  ['M09', 'post-projection secret detectors removed', E, 'if (hits.length > 0) {', 'if (false) {', 'KILLED'],
  ['M10', 'X-R1 preflight requirement removed', E, "if (op.id === 'X-R1' && !s.xcc1PreflightPassed) {", 'if (false) {', 'KILLED'],
  ['M11', 'GIT_ASKPASS dropped from the XCC-1 env', X, "  GIT_ASKPASS: '',\n", '', 'KILLED'],
  ['M12', 'ceiling directory dropped from the XCC-1 env', X, '  env.GIT_CEILING_DIRECTORIES = ctx.root\n', '', 'KILLED'],
  ['M13', 'isolation listing accepts file origins', X, "if (origin !== 'command line:') throw", 'if (false) throw', 'KILLED'],
  ['M14', 'no-commit-since-DN-0 guard disabled (stale DN-0 head)', P, 'export function assertNoCommitSinceDn0(git: LocalGit, dn0: Dn0Result): void {', 'export function assertNoCommitSinceDn0(git: LocalGit, dn0: Dn0Result): void { return;', 'KILLED'],
  ['M15', 'post-certification MODIFY accepted', P, "if (kind !== 'A' || !cfg.allowedPostCertificationAdditions", 'if (false && !cfg.allowedPostCertificationAdditions', 'KILLED'],
  ['M16', 'env-value detector removed', S, "{ id: 'ENV_VALUE_FIELD', re: /", "{ id: 'ENV_VALUE_FIELD', re: /(?!)", 'KILLED'],
  ['M17', 'V-R1 allowlist admits deploy-hook url', O, "  'link.deployHooks[].id', 'link.deployHooks[].name',", "  'link.deployHooks[].url', 'link.deployHooks[].id', 'link.deployHooks[].name',", 'KILLED'],
  ['M18', 'vercel write-operation-id check removed', G, "  if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) {", '  if (false) {', 'KILLED'],
  // ---- v1.0.5: B-1 and the certification predicate
  ['N01', 'B-1 reintroduced: predicate requires the author-guessed verdict name', C, '  const v = verdict.verdict\n', "  const v = verdict.verdict\n  if (typeof v === 'string' && !/^INFRA_EXECUTOR_HARDENING_IC_PASS/.test(v)) return { ok: false, reason: 'verdict name' }\n", 'KILLED'],
  ['N02', 'B-1 reintroduced at the entry point: a verdict pattern configured for the recert event', RG, '      { path: deltaRecertEventPathFor(certifiedCandidate), packageId: EXECUTOR_DELTA_RECERT_PACKAGE_ID, certifiedCandidate },', '      { path: deltaRecertEventPathFor(certifiedCandidate), packageId: EXECUTOR_DELTA_RECERT_PACKAGE_ID, certifiedCandidate, verdict: /^INFRA_EXECUTOR_HARDENING_IC_PASS/ },', 'KILLED'],
  ['N03', 'candidate binding removed (wrong-candidate PASS accepted)', C, '  if (cand !== req.certifiedCandidate) return', '  if (false) return', 'KILLED'],
  ['N04', 'verdict judged by substring (FAIL containing PASS accepted)', C, "  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(verdict)) return undefined", "  if (verdict.includes('PASS')) return 'PASS'\n  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(verdict)) return undefined", 'KILLED'],
  ['N05', 'blocking-count check removed', C, '  if (verdict.blocking_findings !== 0) return', '  if (false) return', 'KILLED'],
  ['N06', 'document-class check removed', C, "  if (typeof cls !== 'string' || !cls.startsWith(CERTIFICATION_DOCUMENT_CLASS_PREFIX)) {", '  if (false) {', 'KILLED'],
  // ---- v1.0.5: environment
  ['N07', 'gh env guard reverted to a case-sensitive denylist (mixed-case GH_TOKEN)', G, "    assertProviderEnv(inv.env, GH_ENV_ALLOWED_UPPER, 'gh')", "    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) if (k in inv.env) throw new Refusal('STOP_CREDENTIAL_OVERRIDE_IN_ENV', k)", 'KILLED'],
  ['N08', 'vercel env guard reverted to a case-sensitive denylist (mixed-case VERCEL_TOKEN)', G, "    assertProviderEnv(inv.env, VERCEL_ENV_ALLOWED_UPPER, 'vercel')", "    for (const k of ['VERCEL_TOKEN']) if (k in inv.env) throw new Refusal('STOP_CREDENTIAL_OVERRIDE_IN_ENV', k)", 'KILLED'],
  ['N09', 'credential-name check made case-sensitive', G, '    if (CREDENTIAL_NAME_RE.test(u)) throw', '    if (CREDENTIAL_NAME_RE.test(k)) throw', 'KILLED'],
  ['N10', 'constructed env compares names case-sensitively', G, '    const u = k.toUpperCase()\n    const list = byUpper.get(u) ?? []', '    const u = k\n    const list = byUpper.get(u) ?? []', 'KILLED'],
  // ---- v1.0.5: free-text detectors and write-set classification
  ['N11', 'vcp_ detector removed', S, "{ id: 'VERCEL_VCP_TOKEN', re: /", "{ id: 'VERCEL_VCP_TOKEN', re: /(?!)", 'KILLED'],
  ['N12', 'URL userinfo detector reverted to the v1.0.4 user:password form', S, "[^/\\s@\"'<>]+@/i },", "[^/\\s:@\"]+:[^/\\s@\"]+@/i },", 'KILLED'],
  ['N13', 'env-assignment detector removed', S, "{ id: 'ENV_ASSIGNMENT_SECRET', re: /", "{ id: 'ENV_ASSIGNMENT_SECRET', re: /(?!)", 'KILLED'],
  ['N14', 'keyword-adjacent classic-token detector removed', S, "{ id: 'KEYWORD_ADJACENT_OPAQUE', re: /", "{ id: 'KEYWORD_ADJACENT_OPAQUE', re: /(?!)", 'KILLED'],
  ['N15', 'designated fixtures accepted regardless of counts (global suppression)', S, "return sameCounts(countByDetector(findings), designatedFixture) ? 'EXPECTED_DETECTIONS' : 'FAIL'", "return 'EXPECTED_DETECTIONS'", 'KILLED'],
  // ---- v1.0.5: envelope
  ['N16', 'raw provider key injected into the evidence envelope', E, "      record_kind: op.cls === 'PACMI' ? 'PACMI_EVIDENCE' : 'GOVERNED_READ_EVIDENCE',", "      raw_exit: res.status, record_kind: op.cls === 'PACMI' ? 'PACMI_EVIDENCE' : 'GOVERNED_READ_EVIDENCE',", 'KILLED'],
  ['N17', 'envelope allowlist disabled', E, 'export function assertEnvelopeConforms(record: unknown): void {', 'export function assertEnvelopeConforms(record: unknown): void { return;', 'KILLED'],
  // ---- v1.0.5: XCC-1 normative contract
  ['N18', 'X-R1 registry drops the credential.helper reset', O, XR1, "fixedArgs: ['-c', 'core.askPass=', '-c', 'http.extraHeader=', 'ls-remote', X_R1_URL]", 'KILLED'],
  ['N19', 'X-R1 registry drops the core.askPass reset', O, XR1, "fixedArgs: ['-c', 'credential.helper=', '-c', 'http.extraHeader=', 'ls-remote', X_R1_URL]", 'KILLED'],
  ['N20', 'X-R1 registry drops the http.extraHeader reset', O, XR1, "fixedArgs: ['-c', 'credential.helper=', '-c', 'core.askPass=', 'ls-remote', X_R1_URL]", 'KILLED'],
  ['N21', 'preflight argv drops the credential.helper reset', X, "export const XCC1_PREFLIGHT_ARGS = ['-c', 'credential.helper=', ", 'export const XCC1_PREFLIGHT_ARGS = [', 'KILLED'],
  ['N22', 'terminal prompt enabled in the XCC-1 env', X, "  GIT_TERMINAL_PROMPT: '0',\n", "  GIT_TERMINAL_PROMPT: '1',\n", 'KILLED'],
  ['N23', 'system-config isolation dropped from the XCC-1 env', X, "  GIT_CONFIG_NOSYSTEM: '1',\n", '', 'KILLED'],
  ['N24', 'normative X-R1 argv check removed from the guard', G, '  asXcc1Refusal(() => assertXcc1NormativeArgv(inv.argv))\n', '', 'KILLED'],
  // ---- v1.0.5: DN-0 fetch and RC-9a identity
  ['N25', 'DN-0 residual-vector (insteadOf/cookieFile) check removed', P, '  if (residual.status !== 1) throw', '  if (false) throw', 'KILLED'],
  ['N26', 'DN-0 fetch drops the credential.helper reset', P, "export const DN0_FETCH_ARGS = ['-c', 'credential.helper=', ", 'export const DN0_FETCH_ARGS = [', 'KILLED'],
  ['N27', 'RC-9a identity assertion removed', P, 'host.login === expected.githubLogin && host.tokenSource === expected.githubTokenSource &&', 'true &&', 'KILLED'],
  ['N28', 'DN-0 origin https-without-userinfo check removed', P, '  if (remote.status !== 0) throw', '  if (false) throw', 'KILLED'],
  ['N29', 'DN-0 residual probe reads config VALUES (--name-only dropped)', P, "  const residual = git.run(['config', '--name-only', '--get-regexp', DN0_FETCH_RESIDUAL_VECTOR_REGEX])", "  const residual = git.run(['config', '--get-regexp', DN0_FETCH_RESIDUAL_VECTOR_REGEX])", 'KILLED'],
  // ---- v1.0.6: safe structural diagnostic (the decision itself is M09)
  ['D01', 'diagnostic carries the raw value', D, "    slash_count: count(text, /\\//g),\n  }", "    slash_count: count(text, /\\//g),\n    value: span.value,\n  }", 'KILLED'],
  ['D02', 'diagnostic smuggles a value PREFIX inside an allowed field', D, '    normalized_schema_path: schemaPathFor(op, span.generic),', '    normalized_schema_path: schemaPathFor(op, span.generic) + text.slice(0, 6),', 'KILLED'],
  ['D03', 'diagnostic smuggles a value SUFFIX inside an allowed field', D, '    normalized_schema_path: schemaPathFor(op, span.generic),', '    normalized_schema_path: schemaPathFor(op, span.generic) + text.slice(-6),', 'KILLED'],
  ['D04', 'diagnostic carries a hash / digest of the value', D, "    slash_count: count(text, /\\//g),\n  }", "    slash_count: count(text, /\\//g),\n    digest: process.getBuiltinModule('node:crypto').createHash('sha256').update(text).digest('hex'),\n  }", 'KILLED'],
  ['D05', 'diagnostic hides a digest prefix inside the path', D, '    normalized_schema_path: schemaPathFor(op, span.generic),', "    normalized_schema_path: schemaPathFor(op, span.generic) + '#' + process.getBuiltinModule('node:crypto').createHash('sha256').update(text).digest('hex').slice(0, 8),", 'KILLED'],
  ['D06', 'wrong field path: array marker not normalized', D, "const star = (p: string) => p.split('[]').join('[*]')", 'const star = (p: string) => p', 'KILLED'],
  ['D07', 'wrong field path: outermost span chosen instead of innermost', D, 's.end - s.start < best.end - best.start', 's.end - s.start > best.end - best.start', 'KILLED'],
  ['D08', 'unexpected diagnostic key', D, "    slash_count: count(text, /\\//g),\n  }", "    slash_count: count(text, /\\//g),\n    leaf_index: 0,\n  }", 'KILLED'],
  ['D09', 'a provider key under .** is echoed in the path', D, '      if (generic === base || generic.startsWith(`${base}.`) || generic.startsWith(`${base}[]`)) return star(p)', '      if (generic === base || generic.startsWith(`${base}.`) || generic.startsWith(`${base}[]`)) return star(generic)', 'KILLED'],
  ['N30', 'an append-only historical recert re-bound to the supplied candidate (event-path dead end)', RG, '      { path: EXECUTOR_DIAGNOSTIC_RECERT_EVENT.path, packageId: EXECUTOR_DIAGNOSTIC_RECERT_EVENT.packageId, certifiedCandidate: EXECUTOR_DIAGNOSTIC_RECERT_EVENT.certifiedCandidate },', '      { path: EXECUTOR_DIAGNOSTIC_RECERT_EVENT.path, packageId: EXECUTOR_DIAGNOSTIC_RECERT_EVENT.packageId, certifiedCandidate },', 'KILLED'],
  ['D10', 'refusal token changed by the diagnostic', D, "    super('STOP_SECRET_BEARING_FIELD_RETURNED',", "    super('STOP_SECRET_DIAGNOSTIC',", 'KILLED'],
  // ---- v1.0.7: G-R5 inventory witness (owner decision LRW-2)
  ['W01', 'G-R5 request carries a repository name', O, "    build: (p) => `/user/repos?per_page=100&page=${req(p, 'page', INVENTORY_PAGE_RE)}`,", "    build: (p) => `/user/repos?per_page=100&page=${req(p, 'page', INVENTORY_PAGE_RE)}&q=${p.repo ?? ''}`,", 'KILLED'],
  ['W02', 'G-R5 request carries an org', O, "    build: (p) => `/user/repos?per_page=100&page=${req(p, 'page', INVENTORY_PAGE_RE)}`,", "    build: (p) => `/user/repos?per_page=100&page=${req(p, 'page', INVENTORY_PAGE_RE)}&affiliation=${p.org ?? ''}`,", 'KILLED'],
  ['W03', 'G-R5 request carries the repoId', O, "    build: (p) => `/user/repos?per_page=100&page=${req(p, 'page', INVENTORY_PAGE_RE)}`,", "    build: (p) => p.repoId ? `/repositories/${p.repoId}` : `/user/repos?per_page=100&page=${req(p, 'page', INVENTORY_PAGE_RE)}`,", 'KILLED'],
  ['W04', 'raw inventory page persisted (no reduction before the record)', E, "      projection = this.witness.ingestPage(Number(params.page), emptyInventoryPage ? [] : projection)", "      this.witness.ingestPage(Number(params.page), emptyInventoryPage ? [] : projection)", 'KILLED'],
  ['W05', 'non-matching repositories retained (whole inventory accumulated)', W, '      if (this.targets.has(item.id as number)) {', '      if (true) {', 'KILLED'],
  ['W06', 'pagination stops once every target matched (before completeness)', W, "    this.lastPageSignature = signature\n", "    this.lastPageSignature = signature\n    if ([...this.targets.keys()].every((k) => this.matches.has(k))) this.complete = true\n", 'KILLED'],
  ['W07', 'duplicate match ignored', W, "      if (found.length > 1) stop(", "      if (false) stop(", 'KILLED'],
  ['W08', 'zero match ignored', W, "      if (found.length === 0) stop(", "      if (false) stop(", 'KILLED'],
  ['W09', 'id binding replaced by a name match', W, "      if (this.targets.has(item.id as number)) {\n        const list = this.matches.get(item.id as number) ?? []\n        list.push(Object.freeze({ id: item.id as number, name: item.name as string, fullName: item.full_name as string, ownerLogin: owner }))\n        this.matches.set(item.id as number, list)\n      }", "      const byName = [...this.targets.entries()].find(([, ts]) => ts.some((t) => t.linkRepo === item.name))\n      if (byName) {\n        const list = this.matches.get(byName[0]) ?? []\n        list.push(Object.freeze({ id: byName[0], name: item.name as string, fullName: item.full_name as string, ownerLogin: owner }))\n        this.matches.set(byName[0], list)\n      }", 'KILLED'],
  ['W10', 'name equality skipped', W, "        if (t.linkRepo !== gh.name) stop(", "        if (false) stop(", 'KILLED'],
  ['W11', 'owner equality skipped', W, "        if (t.linkOrg !== gh.ownerLogin) stop(", "        if (false) stop(", 'KILLED'],
  ['W12', 'full_name coherence skipped', W, "      if (gh.fullName !== `${gh.ownerLogin}/${gh.name}`) stop(", "      if (false) stop(", 'KILLED'],
  ['W13', 'witness type equality skipped', W, "        if (t.linkType !== 'github') stop(", "        if (false) stop(", 'KILLED'],
  ['W14', 'deferral accepts a non-github link.type', E, "    if (!pr || !link || typeof pr.id !== 'string' || link.type !== 'github' || !isRepoId(link.repoId) ||", "    if (!pr || !link || typeof pr.id !== 'string' || !isRepoId(link.repoId) ||", 'KILLED'],
  ['W15', 'witness shared across executions (prior-run witness reused)', E, '  readonly witness = new RepositoryInventoryWitness()', '  readonly witness: RepositoryInventoryWitness = ((globalThis as unknown as { __w?: RepositoryInventoryWitness }).__w ??= new RepositoryInventoryWitness())', 'KILLED'],
  ['W16', 'adjudicated values shared across executions', E, '  private readonly adjudicatedValues = new Set<string>()', '  private readonly adjudicatedValues: Set<string> = ((globalThis as unknown as { __a?: Set<string> }).__a ??= new Set<string>())', 'KILLED'],
  ['W17', 'identity hard-coded when GitHub returned none', W, "      const found = this.matches.get(repoId) ?? []", "      const found = this.matches.get(repoId) ?? [{ id: repoId, name: targets[0].linkRepo, fullName: `${targets[0].linkOrg}/${targets[0].linkRepo}`, ownerLogin: targets[0].linkOrg }]", 'KILLED'],
  ['W18', 'OPAQUE_HIGH_ENTROPY suppressed globally', E, "      if (!deferred) throw new SecretDetectedRefusal(", "      if (!deferred && hits.some((h) => h.detector !== 'OPAQUE_HIGH_ENTROPY')) throw new SecretDetectedRefusal(", 'KILLED'],
  ['W19', 'every detector suppressed on link.repo (both detector layers removed; grammar layer kept)', E, "    if (l.detector !== 'OPAQUE_HIGH_ENTROPY' || l.generic !== 'projects[].link.repo' || typeof l.value !== 'string') return undefined\n    // v1.0.8: only a value inside GitHub's documented repository-name grammar can await the witness.\n    if (!GITHUB_REPOSITORY_NAME_RE.test(l.value)) return undefined\n    if (scanText(l.value).some((f) => f.detector !== 'OPAQUE_HIGH_ENTROPY')) return undefined\n", "    if (l.generic !== 'projects[].link.repo' || typeof l.value !== 'string') return undefined\n    if (!GITHUB_REPOSITORY_NAME_RE.test(l.value)) return undefined\n", 'KILLED'],
  ['W20', 'a 403 treated as a successful page', E, "  if (res.status === 0) return 200", "  if (res.status === 0 || /HTTP 403/.test(res.stderr)) return 200", 'KILLED'],
  ['W21', 'a rate limit treated as a successful page', E, "  if (res.status === 0) return 200", "  if (res.status === 0 || /HTTP 429/.test(res.stderr)) return 200", 'KILLED'],
  ['W22', 'G-R5 projection broadened', O, "    allowlist: ['[].id', '[].name', '[].full_name', '[].owner.login'],", "    allowlist: ['[].id', '[].name', '[].full_name', '[].owner.login', '[].private', '[].html_url'],", 'KILLED'],
  ['W23', 'another read class added', O, "    allowlist: ['[].id', '[].name', '[].full_name', '[].owner.login'],\n  },", "    allowlist: ['[].id', '[].name', '[].full_name', '[].owner.login'],\n  },\n  { id: 'G-R6', read: 'G-R6', cls: 'GOVERNED_READ', plane: 'PLANE-G', tool: 'gh', freshness: 'EXECUTE_NOW', nodeIds: [], pathPattern: /^\\/user$/, build: () => '/user', allowlist: ['login'] },", 'KILLED'],
  ['W24', 'pending V-R2.S2 record validated before the witness', E, "      this.pendingAdjudications.set(record, deferred)\n      return record", "      this.pendingAdjudications.set(record, deferred)\n      VALIDATED.add(record)\n      return record", 'KILLED'],
  ['W25', 'TI-2 reverted to the owner/name comparison', E, "get(proj, 'link.repo') === GH_REPO &&", "get(proj, 'link.repo') === REPO_FULL_NAME &&", 'KILLED'],
  ['W26', 'TI-2 no longer enforced on V-R1', E, "        if (op.id === 'V-R1' && !ti2) throw", "        if (false) throw", 'KILLED'],
  ['W27', 'RC-9a no longer requires the repo scope', P, '    scopeList.includes(REQUIRED_GITHUB_SCOPE)', '    true', 'KILLED'],
  ['W28', 'evidence re-scan ignores the adjudication marker', A, "    if (typeof p?.id === 'string' && ids.has(p.id) && typeof repo === 'string' &&", "    if (typeof p?.id === 'string' && typeof repo === 'string' &&", 'KILLED'],
  ['W29', 'evidence re-scan ignores the same-run value check', A, " && isAdjudicatedValue(repo)) out.add(repo)", ") out.add(repo)", 'KILLED'],
  ['W30', 'delta-recert path no longer candidate-derived (one-use dead end)', RG, "  return `docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_DELTA_RECERT_${candidate.slice(0, 12).toUpperCase()}_IC_v1.0.0.json`", "  return 'docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_DELTA_RECERT_IC_v1.0.0.json'", 'KILLED'],
  ['W31', 'witness page-loop detection removed', W, "    if (signature === this.lastPageSignature) stop(", "    if (false) stop(", 'KILLED'],
  ['W32', 'witness page cap removed', W, "    if (this.nextPage > MAX_INVENTORY_PAGES && !this.complete) {", "    if (false) {", 'KILLED'],
  // ---- v1.0.8: private-key detector reuse + documented repository-name grammar (recert NB-1)
  ['P01', 'private-key detector removed from the runtime catalog', S, "  { id: 'PRIVATE_KEY_BLOCK', re: PRIVATE_KEY_BLOCK_PATTERN },\n", '', 'KILLED'],
  ['P02', 'runtime catalog uses a narrower COPY instead of the shared pattern (catalog only updated in tests)', S, "{ id: 'PRIVATE_KEY_BLOCK', re: PRIVATE_KEY_BLOCK_PATTERN }", "{ id: 'PRIVATE_KEY_BLOCK', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ }", 'KILLED'],
  ['P03', 'shared pattern narrowed back to the previous label set (authority says STOP, runtime accepts ENCRYPTED/DSA/PGP BLOCK)', SS, 'export const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/', 'export const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/', 'KILLED'],
  ['P04', 'repo-gate annotation allowance applied at runtime (provider text exempts itself)', S, "export function scanText(text: string, detectors: readonly Detector[] = DETECTORS): Finding[] {\n", "export function scanText(text: string, detectors: readonly Detector[] = DETECTORS): Finding[] {\n  if (/secret-scan-ok:\\s*\\S+/.test(text)) return []\n", 'KILLED'],
  ['P05', 'grammar layer removed from deferral', E, "    if (!GITHUB_REPOSITORY_NAME_RE.test(l.value)) return undefined\n    if (scanText(l.value)", "    if (scanText(l.value)", 'KILLED'],
  ['P06', 'grammar layer removed from the witness target', W, "    if (!GITHUB_REPOSITORY_NAME_RE.test(t.linkRepo)) stop(", "    if (false) stop(", 'KILLED'],
  ['P07', 'grammar layer removed from the evidence re-scan (private key/other finding explained after the witness)', A, "      GITHUB_REPOSITORY_NAME_RE.test(repo) &&\n", '', 'KILLED'],
  ['P08', 'detector layer removed from the evidence re-scan', A, "      scanText(repo).every((f) => f.detector === 'OPAQUE_HIGH_ENTROPY') && isAdjudicatedValue(repo)) out.add(repo)", "      isAdjudicatedValue(repo)) out.add(repo)", 'KILLED'],
  ['P09', 'the old b25f2d32 event accepted for the new candidate', RG, '      { path: deltaRecertEventPathFor(certifiedCandidate), packageId: EXECUTOR_DELTA_RECERT_PACKAGE_ID, certifiedCandidate },', '      { path: deltaRecertEventPathFor(INVENTORY_WITNESS_CANDIDATE), packageId: EXECUTOR_DELTA_RECERT_PACKAGE_ID, certifiedCandidate: INVENTORY_WITNESS_CANDIDATE },', 'KILLED'],
  ['P10', 'the fixed b25f2d32 history event dropped from the chain', RG, '      { path: deltaRecertEventPathFor(INVENTORY_WITNESS_CANDIDATE), packageId: EXECUTOR_DELTA_RECERT_PACKAGE_ID, certifiedCandidate: INVENTORY_WITNESS_CANDIDATE },\n', '', 'KILLED'],
  // ---- v1.0.9: V-R2.L7 deployments[*].meta.githubRepo, SAME-RUN + SAME-PROJECT exact match only (owner OPTION 1)
  ['L01', 'L7: same-project binding removed (any witnessed project explains the value)', E, "    const witnessed = this.witnessedLinkRepoByProject.get(scopeKey(teamId, projectId))\n", "    const witnessed = [...this.witnessedLinkRepoByProject.values()][0]\n", 'KILLED'],
  ['L02', 'L7: historical witness allowed (binding shared across executions)', E, '  private readonly witnessedLinkRepoByProject = new Map<string, string>()', '  private readonly witnessedLinkRepoByProject: Map<string, string> = ((globalThis as unknown as { __l7?: Map<string, string> }).__l7 ??= new Map<string, string>())', 'KILLED'],
  ['L03', 'L7: case folded before the comparison', E, "    if (l.value !== witnessed) return false\n", "    if (l.value.toLowerCase() !== witnessed.toLowerCase()) return false\n", 'KILLED'],
  ['L04', 'L7: grammar layer removed', E, "    if (!GITHUB_REPOSITORY_NAME_RE.test(l.value)) return false\n", '', 'KILLED'],
  ['L05', 'L7: equality removed (any grammar-valid, entropy-only value adjudicated)', E, "    if (l.value !== witnessed) return false\n", '', 'KILLED'],
  ['L06', 'L7: a non-entropy finding at the leaf accepted (entropy + another detector)', E, "    if (l.detector !== 'OPAQUE_HIGH_ENTROPY') return false\n", '', 'KILLED'],
  ['L07', 'L7: value-level other-detector check removed', E, "    if (scanText(l.value).some((f) => f.detector !== 'OPAQUE_HIGH_ENTROPY')) return false\n", '', 'KILLED'],
  ['L08', "L7: bound to ANOTHER project's adjudication in the same team", E, "    const witnessed = this.witnessedLinkRepoByProject.get(scopeKey(teamId, projectId))\n", "    const witnessed = [...this.witnessedLinkRepoByProject].find(([k]) => JSON.parse(k)[0] === teamId)?.[1]\n", 'KILLED'],
  ['L09', 'L7: team/scope dropped from the binding (project id only)', E, "    const witnessed = this.witnessedLinkRepoByProject.get(scopeKey(teamId, projectId))\n", "    const witnessed = [...this.witnessedLinkRepoByProject].find(([k]) => JSON.parse(k)[1] === projectId)?.[1]\n", 'KILLED'],
  ['L10', 'L7: G-R5 provenance bypassed (binding recorded at V-R2.S2 deferral)', E, "      for (const t of deferred) this.witness.addTarget(t)\n", "      for (const t of deferred) { this.witness.addTarget(t); this.witnessedLinkRepoByProject.set(scopeKey(params.teamId ?? '', t.projectId), t.linkRepo) }\n", 'KILLED'],
  ['L11', 'L7: an unresolved (pending) V-R2.S2 accepted as the source', E, "    const witnessed = this.witnessedLinkRepoByProject.get(scopeKey(teamId, projectId))\n", "    const witnessed = this.witnessedLinkRepoByProject.get(scopeKey(teamId, projectId)) ?? [...this.pendingAdjudications.values()].flat().find((t) => t.projectId === projectId)?.linkRepo\n", 'KILLED'],
  ['L12', 'L7: path restriction removed (the witnessed value explained at any L7 leaf)', E, "    if (l.generic !== 'deployments[].meta.githubRepo' || typeof l.value !== 'string') return false\n", "    if (typeof l.value !== 'string') return false\n", 'KILLED'],
  ['L13', 'L7: exception globalized (every L7 finding explained)', E, "    const hits = deploymentRepo ? [] : scanned\n", "    const hits = op.id === 'V-R2.L7' ? [] : scanned\n", 'KILLED'],
  ['L14', "L7 envelope: adjudication no longer bound to the record's own request scope", E, "      !endpoint.startsWith(`/v6/deployments?projectId=${x.project_id}&teamId=${x.team_id}&`)) {", '      false) {', 'KILLED'],
  ['L15', "EC-1: the bundle's own V-R2.S2 binding dropped (caller lookup only)", A, '  const bound: SameProjectLookup = (t, p, v) => bundle(t, p, v) && sameProject(t, p, v)', '  const bound: SameProjectLookup = (t, p, v) => sameProject(t, p, v)', 'KILLED'],
  ['L16', 'EC-1: the in-run same-project lookup dropped (bundle only)', A, '  const bound: SameProjectLookup = (t, p, v) => bundle(t, p, v) && sameProject(t, p, v)', '  const bound: SameProjectLookup = (t, p, v) => bundle(t, p, v)', 'KILLED'],
  ['L17', 'EC-1: L7 detector layer removed (a mixed value has its entropy finding explained)', A, "      scanText(value).every((f) => f.detector === 'OPAQUE_HIGH_ENTROPY') && sameProject(a.team_id, a.project_id, value)) out.add(value)", '      sameProject(a.team_id, a.project_id, value)) out.add(value)', 'KILLED'],
  ['L18', 'EC-1: L7 grammar layer removed', A, "    if (typeof value === 'string' && GITHUB_REPOSITORY_NAME_RE.test(value) &&\n", "    if (typeof value === 'string' &&\n", 'KILLED'],
  ['L19', "EC-1: L7 adjudication no longer bound to the record's own request scope", A, "    !endpoint.startsWith(`/v6/deployments?projectId=${a.project_id}&teamId=${a.team_id}&`)) return out", '    false) return out', 'KILLED'],
  ['L20', 'the fixed 00d6d383 history event dropped from the chain', RG, '      { path: deltaRecertEventPathFor(SCANNER_HARDENING_CANDIDATE), packageId: EXECUTOR_DELTA_RECERT_PACKAGE_ID, certifiedCandidate: SCANNER_HARDENING_CANDIDATE },\n', '', 'KILLED'],
  ['L21', 'the old 00d6d383 event accepted for the new candidate', RG, '      { path: deltaRecertEventPathFor(certifiedCandidate), packageId: EXECUTOR_DELTA_RECERT_PACKAGE_ID, certifiedCandidate },', '      { path: deltaRecertEventPathFor(SCANNER_HARDENING_CANDIDATE), packageId: EXECUTOR_DELTA_RECERT_PACKAGE_ID, certifiedCandidate: SCANNER_HARDENING_CANDIDATE },', 'KILLED'],
]

// Behaviour-neutral: a comment edit. Expected KILLED, so it MUST be reported UNEXPECTED.
const SELF_TEST_SURVIVOR = ['S01', 'SELF-TEST: behaviour-neutral comment edit, deliberately expected KILLED', G, '// scripts/infra-read/guards.ts\n', '// scripts/infra-read/guards.ts (mutation battery self-test)\n', 'KILLED']

const sha = (b) => createHash('sha256').update(b).digest('hex')
function suite() {
  const r = spawnSync('npx vitest run tests/infra-read', { cwd: R, encoding: 'utf8', shell: true, timeout: 480000 })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

function runOne([id, desc, file, find, replace, expect]) {
  const orig = readFileSync(file)
  const text = orig.toString('utf8')
  const count = text.split(find).length - 1
  if (count !== 1) return { id, desc, verdict: `INVALID_ANCHOR_COUNT_${count}`, failing: null, expect, classification: 'UNEXPECTED' }
  // Function replacer: a string replacement would expand $&, $', $` and $$ patterns.
  writeFileSync(file, text.replace(find, () => replace))
  let r
  try { r = suite() } finally {
    writeFileSync(file, orig)
    if (sha(readFileSync(file)) !== sha(orig)) { console.log('RESTORE FAILED for', file); process.exit(9) }
  }
  const verdict = verdictOf(r.status, r.out)
  const failing = /Tests\s+(\d+) failed/.exec(r.out)
  // WHY it died: the first failing tests, as vitest names them.
  const killedBy = [...new Set(r.out.split(/\r?\n/).filter((l) => /^\s*FAIL\s+tests\//.test(l)).map((l) => l.replace(/^\s*FAIL\s+/, '').trim()))].slice(0, 4)
  return { id, desc, verdict, failing: failing ? Number(failing[1]) : null, killedBy, expect, classification: classify(expect, verdict) }
}

function baselineGreen() {
  const r = suite()
  const passed = /Tests\s+(\d+) passed/.exec(r.out)
  console.log(`BASELINE ${r.status === 0 ? 'GREEN' : 'NOT_GREEN'}${passed ? ` (${passed[1]} passed)` : ''}`)
  return r.status === 0
}

function report(rows) {
  for (const r of rows) console.log([r.id, r.desc, `${r.verdict}${r.failing !== null ? ` (${r.failing} failing)` : ''}`, `expect ${r.expect}`, r.classification].join(' | '))
  const a = aggregate(rows)
  console.log(`MUTANTS=${a.total} AS_EXPECTED=${a.asExpected} UNEXPECTED=${a.unexpected}`)
  console.log(`BATTERY=${a.pass ? 'PASS' : 'FAIL'}`)
  return a
}

const argv = process.argv.slice(2)
const jsonAt = argv.indexOf('--json')
const jsonPath = jsonAt === -1 ? undefined : argv[jsonAt + 1]
const onlyAt = argv.indexOf('--only')
const only = onlyAt === -1 ? undefined : new Set(argv[onlyAt + 1].split(','))

if (argv.includes('--check-anchors')) {
  // Static: every anchor occurs exactly once. Runs no test.
  const bad = [...MUTANTS, SELF_TEST_SURVIVOR].filter(([, , file, find]) => readFileSync(file, 'utf8').split(find).length - 1 !== 1)
  for (const m of bad) console.log(`ANCHOR_INVALID ${m[0]} ${m[1]}`)
  console.log(`ANCHORS=${bad.length === 0 ? 'OK' : 'INVALID'} (${MUTANTS.length + 1} checked)`)
  process.exit(bad.length === 0 ? 0 : 1)
}

if (!baselineGreen()) { console.log('BATTERY=FAIL (unmutated suite is not green; no verdict is meaningful)'); process.exit(3) }

if (argv.includes('--self-test')) {
  // A real kill next to a real survivor: the battery must report the survivor UNEXPECTED and FAIL.
  const rows = [runOne(MUTANTS.find((m) => m[0] === 'M05')), runOne(SELF_TEST_SURVIVOR)]
  const a = report(rows)
  const s = rows[1]
  const ok = !a.pass && s.verdict === 'SURVIVED' && s.classification === 'UNEXPECTED' && rows[0].classification === 'AS_EXPECTED'
  console.log(`SELF_TEST=${ok ? 'PASS (the battery failed when fed a survivor)' : 'FAIL (the battery did not fail on a survivor)'}`)
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ mode: 'self-test', rows, aggregate: a, self_test: ok ? 'PASS' : 'FAIL' }, null, 1)}\n`)
  process.exit(ok ? 0 : 1)
}

const selected = only ? MUTANTS.filter((m) => only.has(m[0])) : MUTANTS
const rows = selected.map(runOne)
const a = report(rows)
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ mode: only ? 'subset' : 'full', rows, aggregate: a }, null, 1)}\n`)
process.exit(a.pass ? 0 : 1)

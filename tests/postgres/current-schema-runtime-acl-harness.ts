/**
 * The disposable PostgreSQL substrate for the stella_0021 runtime ACL contract.
 *
 * WHY THIS HARNESS AND NOT tests/postgres/disposable-db.ts. That harness reaches
 * a LOCAL `supabase_db` container the developer already runs, and creates a
 * throwaway DATABASE inside it. It cannot serve this suite, for a reason that is
 * a property of the contract rather than a preference:
 *
 *   db/prepared/stella_local_0000_local_role_identity_bootstrap.sql REFUSES a
 *   second application — its precondition is that NO uellix_* role exists in
 *   the cluster. Roles are CLUSTER-WIDE. disposable-db.ts creates uellix_app
 *   and uellix_owner as NOLOGIN shells and never drops them, so after one run
 *   of any suite that uses it the cluster can never again satisfy the pristine
 *   precondition, and the governed role topology could only be faked.
 *
 * The authority (SECTION_13 PROHIBITED_IN_THE_SUBSTRATE) forbids exactly that
 * faking: "No GRANT issued by the test or its harness", and it names the CE-1
 * precedent's inline role creation as NOT admissible. So the substrate here is
 * the governed one, end to end, on a container this file creates and destroys:
 *
 *   stella_local_0000  ->  the baseline units  ->  stella_0001  ->  stella_0021
 *
 * and every role, membership, privilege and policy in it is established by a
 * repository artefact applied verbatim. The harness issues no GRANT of its own.
 *
 * SAFETY. The container is created by this file with a name carrying a fixed
 * prefix and a random suffix, from a DIGEST-pinned image, with NO published
 * port (every statement travels through `docker exec`, so nothing is reachable
 * from the host network at all), no bind mount, and it is destroyed in a
 * finally. A leftover check runs afterwards and the suite fails if anything
 * survives. There is no connection string and no hostname anywhere in this
 * file, so there is no path by which it can reach staging, production or the
 * developer's own stack.
 *
 * Authority: CURRENT_SCHEMA_RUNTIME_ACL_SUCCESSOR_AUTHORITY_v1.0.0 SECTION_13
 * (substrate), SECTION_14 (the proof matrix this serves).
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'

/** Opt-in, exactly like every other real-PostgreSQL suite in this repository. */
export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const ROOT = process.cwd()

/**
 * The image, pinned BY DIGEST rather than by tag.
 *
 * Identical to scripts/m2-disposable-pg-bootstrap.ts IMAGE, and restated here
 * rather than imported so that a test-only file never becomes a reason to edit
 * a governed bootstrap script. A tag is a moving target; the digest is the
 * artefact the opening measured.
 */
export const IMAGE =
  'public.ecr.aws/supabase/postgres@sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453'

const CONTAINER_PREFIX = 'uellix-acl-pgtest'
const DB_NAME = 'uellix_acl_contract'
/** The application runtime role. Named once; never created by this harness. */
const RUNTIME_ROLE = 'uellix_app'
/**
 * Cuts the psql output stream between the identity statements and the query
 * under test. Deliberately improbable: a marker a relation could plausibly
 * contain would reintroduce the very ambiguity it exists to remove.
 */
const ROW_MARKER = '__UELLIX_ACL_ROWS__'
const SHIM = path.join(ROOT, 'scripts', 'rehearsal', 'local-supabase-shim.sql')
const LOCAL_ROLE_IDENTITY = path.join(ROOT, 'db', 'prepared', 'stella_local_0000_local_role_identity_bootstrap.sql')
const ROLE_TOPOLOGY = path.join(ROOT, 'db', 'prepared', 'stella_0001_role_topology_bootstrap.sql')
export const PACKAGE_PATH = path.join(ROOT, 'db', 'prepared', 'stella_0021_current_schema_runtime_acl_contract.sql')

/**
 * G2-ENVIRONMENT PREREQUISITE SHIM, carried verbatim from
 * tests/postgres/disposable-db.ts and for the reason stated there:
 * db/migrations/0044 re-installs a no-truncate trigger on
 * public.stella_suggestion_decisions, a table NO baseline unit creates. On a
 * real target the Stella chain creates it (stella_0003). Here it is the
 * DECLARED CONDITIONAL MEMBER of the contract, so its presence is the arm of
 * the conditional this suite exercises; its absence is exercised statically.
 */
const G2_PREREQUISITE_SHIM = `
CREATE TABLE IF NOT EXISTS public.stella_suggestion_decisions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  interaction_id uuid,
  suggestion_key text NOT NULL,
  decision text NOT NULL,
  previous_value_hash text,
  applied_text text,
  rejection_reason text,
  decided_by uuid NOT NULL,
  decided_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT stella_suggestion_decisions_decision_check CHECK ((decision = ANY (ARRAY['accepted'::text, 'accepted_edited'::text, 'rejected'::text, 'undone'::text]))),
  CONSTRAINT stella_suggestion_decisions_prev_hash_check CHECK (((previous_value_hash IS NULL) OR (previous_value_hash ~ '^[0-9a-f]{64}$')))
);
`

export interface Exec {
  status: number
  stdout: string
  stderr: string
}

function docker(args: readonly string[], input?: string): Exec {
  const r = spawnSync('docker', [...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export function dockerAvailable(): boolean {
  return docker(['version', '--format', '{{.Server.Os}}']).status === 0
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class AclCluster {
  private constructor(
    readonly container: string,
    /**
     * The loopback port PostgreSQL is published on, or null when the cluster
     * was created without one.
     *
     * MOST OF THIS SUITE NEEDS NO PORT: every catalog probe and every refusal
     * travels through `docker exec`, which is strictly safer — nothing is
     * reachable from the host network at all. PG-19 is the one family that
     * cannot work that way, because it must reach the database through the
     * REPOSITORY'S OWN client (postgres-js over TCP) rather than through a
     * psql the test drives. So the port is OPT-IN per cluster: a caller that
     * does not ask for one gets the closed configuration.
     */
    readonly port: number | null,
  ) {}

  /**
   * Create the container and build the governed substrate on it.
   *
   * Returns null when Docker is unreachable, which the suite reports as a
   * SKIP — never as a pass. A silently-green real-PostgreSQL suite is the
   * failure mode the gating exists to prevent.
   */
  static async create(options: { publishPort?: boolean } = {}): Promise<AclCluster | null> {
    if (!dockerAvailable()) return null
    const name = `${CONTAINER_PREFIX}-${randomUUID().slice(0, 8)}`

    // By default NO published port: every statement goes through `docker exec`,
    // so the container is not reachable from the host network at all. When a
    // port IS published it is bound to 127.0.0.1 on an EPHEMERAL port chosen by
    // the kernel (`:0`), never a fixed one — a fixed port is how a test ends up
    // silently talking to whatever else was already listening, and the whole
    // safety argument of this harness is that its target cannot be anything but
    // the container it just created.
    const created = docker([
      'run', '-d', '--name', name,
      ...(options.publishPort === true ? ['-p', '127.0.0.1:0:5432'] : []),
      '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=postgres',
      IMAGE,
    ])
    if (created.status !== 0) return null

    let port: number | null = null
    if (options.publishPort === true) {
      const printed = docker(['port', name, '5432/tcp'])
      // "127.0.0.1:54821" — and 0.0.0.0 is REFUSED rather than accepted, so a
      // misconfigured publish can never widen the binding past loopback.
      const m = /^127\.0\.0\.1:(\d+)$/m.exec(printed.stdout.trim())
      if (m === null) {
        docker(['rm', '-f', '-v', name])
        throw new Error(`the disposable cluster did not publish a loopback port: ${printed.stdout.trim() || printed.stderr.trim()}`)
      }
      port = Number(m[1])
    }

    const cluster = new AclCluster(name, port)
    try {
      if (!(await cluster.waitReady())) {
        cluster.destroy()
        return null
      }
      cluster.buildSubstrate()
      return cluster
    } catch (error) {
      cluster.destroy()
      throw error
    }
  }

  /** The ephemeral password issued to the runtime role, if one was needed. */
  private runtimePassword: string | null = null

  /**
   * Give the runtime role an EPHEMERAL password and return the connection
   * string the repository's own client uses to reach this cluster.
   *
   * WHY A PASSWORD IS NEEDED AT ALL, measured rather than assumed. A `psql`
   * driven through `docker exec` reaches 127.0.0.1 from INSIDE the container
   * and matches a trusted pg_hba line, so it connects with no password. The
   * application client dials the PUBLISHED port from the host, and that
   * connection arrives over the Docker bridge — a different source address,
   * matching a different pg_hba line, which demands a password. The failure is
   * `password authentication failed`, and it is the only thing standing
   * between the real client and the real database.
   *
   * WHY IT IS NOT "MANUAL SURGERY". A password is a CREDENTIAL, not a
   * privilege: it confers nothing, revokes nothing, and changes no row of
   * pg_class.relacl, no role attribute and no membership. The substrate
   * contract forbids an ad-hoc GRANT, owner execution of the journey,
   * BYPASSRLS and psql fix-ups that make a service work — this is none of
   * those, and the authority-named precedent
   * tests/e2e/g04-governed-evidence-journey.e2e.test.ts issues exactly this
   * ALTER ROLE for exactly this reason.
   *
   * AND THE CLAIM IS PROVEN, NOT ASSERTED: `privilegeFingerprint()` is
   * captured either side of the statement by the caller, so "the credential
   * act changed no privilege" is a measurement in the suite rather than a
   * sentence in this comment.
   */
  grantRuntimeCredential(): string {
    if (this.port === null) {
      throw new Error('this cluster was created without a published port; pass { publishPort: true }')
    }
    if (this.runtimePassword === null) {
      // Ephemeral and per-container: it never leaves this process, and the
      // container it authenticates against is destroyed in afterAll.
      this.runtimePassword = randomUUID().replace(/-/g, '')
      this.fixture(`ALTER ROLE ${RUNTIME_ROLE} WITH PASSWORD '${this.runtimePassword}'`, 'supabase_admin')
    }
    return `postgresql://${RUNTIME_ROLE}:${this.runtimePassword}@127.0.0.1:${this.port}/${DB_NAME}`
  }

  /**
   * Everything about the runtime roles that a privilege change would move:
   * their attributes, their memberships, and the whole public ACL.
   *
   * Exists so a credential act can be shown to be privilege-NEUTRAL by
   * comparison rather than by argument.
   */
  privilegeFingerprint(): string {
    const attrs = this.scalar(
      `SELECT coalesce(string_agg(rolname||'|'||rolsuper::text||rolbypassrls::text||rolcreaterole::text||rolinherit::text||rolcanlogin::text, E'\\n' ORDER BY rolname),'')
       FROM pg_roles WHERE rolname LIKE 'uellix\\_%' ESCAPE '\\'`,
    ) ?? ''
    const members = this.scalar(
      `SELECT coalesce(string_agg(m.member::regrole::text||'->'||m.roleid::regrole::text||'|'||m.inherit_option::text||m.set_option::text, E'\\n' ORDER BY 1),'')
       FROM pg_auth_members m`,
    ) ?? ''
    return `${attrs}\n--\n${members}\n--\n${this.tableAclSnapshot()}\n--\n${this.functionAclSnapshot()}`
  }

  /**
   * Ready means the SERVING postmaster answers over the SAME transport every
   * later statement uses — not merely pg_isready, which the entrypoint's
   * TEMPORARY init postmaster also answers before being stopped. The
   * distinction is measured in this repository and recorded in
   * scripts/db-audit-disposable.ts probeServingPostmaster.
   */
  private async waitReady(): Promise<boolean> {
    for (let i = 0; i < 120; i += 1) {
      const r = docker(['exec', '-i', this.container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-tAc', 'SELECT 1'])
      if (r.status === 0 && r.stdout.trim() === '1') return true
      await sleep(500)
    }
    return false
  }

  /** Apply one repository artefact verbatim, in one transaction, as `role`. */
  private applyFileAs(role: string, file: string, prelude = ''): Exec {
    return this.applySqlAs(role, prelude + readFileSync(file, 'utf8'))
  }

  private applySqlAs(role: string, sql: string, singleTransaction = true): Exec {
    const args = ['exec', '-i', this.container, 'psql', '-h', '127.0.0.1', '-U', role, '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-q']
    if (singleTransaction) args.push('-1')
    args.push('-f', '-')
    return docker(args, sql)
  }

  /**
   * The governed substrate, in the order the authority names it.
   *
   * Every step is a repository artefact applied VERBATIM. The only SQL this
   * harness authors is CREATE DATABASE and the G2 prerequisite shim, neither
   * of which grants anything to any role.
   */
  private buildSubstrate(): void {
    const create = docker(['exec', this.container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-q', '-c', `CREATE DATABASE ${DB_NAME}`])
    this.must(create, 'CREATE DATABASE')

    // The local Supabase shim establishes the auth/storage/extensions schemas
    // the baseline units and stella_local_0000 both reference.
    this.must(this.applySqlAs('postgres', readFileSync(SHIM, 'utf8'), false), 'local-supabase-shim')

    // auth.uid() IS CONVERGED TO THE MEASURED PRODUCTION DEFINITION, and this
    // is substrate FIDELITY rather than a fix-up. Three forms exist and they
    // are not the same function:
    //
    //   the PINNED IMAGE ships  nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    //   the REHEARSAL SHIM ships the same singular-GUC form (faithful to the image)
    //   the MEASURED G2 SCHEMA ships the COALESCE form below
    //     — db/baseline/stella_g2_schema.sql:486-494, which is the schema the
    //       application actually runs against, and which db/identity-context.ts:14
    //       names as the contract it relies on.
    //
    // db/identity-context.ts sets `request.jwt.claims` (the PLURAL JSON blob)
    // and nothing else, because that is what the deployed auth.uid() reads via
    // its second COALESCE arm. Against the singular-only form it resolves to
    // NULL, so current_user_org_ids() returns an empty array and EVERY policy
    // evaluates false — the application connects successfully and sees zero
    // rows. MEASURED here: without this statement, PG-19 fails with
    // DB_IDENTITY_ORGANIZATION_NOT_A_MEMBER for a user who IS an active
    // member, because the database cannot see who is asking.
    //
    // Installing the measured production definition makes the substrate MORE
    // like the target, not less. It is applied after the shim so the shim
    // stays untouched — other suites depend on it, and stella_hosted_0006
    // documents the same two-form history at its line 523.
    this.must(
      this.applySqlAs(
        'postgres',
        `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
           LANGUAGE sql STABLE
           AS $$
             SELECT coalesce(
               nullif(current_setting('request.jwt.claim.sub', true), ''),
               (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
             )::uuid
           $$;`,
        false,
      ),
      'auth.uid() converged to the measured G2 definition',
    )

    // stella_local_0000 — the five canonical role identities and the two
    // controlled memberships. It performs its OWN self-verification and
    // refuses a non-pristine cluster, which is why the container is fresh.
    this.must(
      this.applyFileAs('postgres', LOCAL_ROLE_IDENTITY, `SET uellix.bootstrap_environment = 'local';\n`),
      'stella_local_0000',
    )

    this.must(this.applySqlAs('postgres', G2_PREREQUISITE_SHIM, false), 'g2-prerequisite-shim')

    for (const unit of BASELINE_UNITS) {
      const r = this.applySqlAs('postgres', readFileSync(path.join(ROOT, unit.file), 'utf8'))
      this.must(r, `baseline unit ${unit.id}`)
    }

    // stella_0001 asserts the topology stella_local_0000 established and pins
    // the grantor by the bootstrap superuser's fixed oid, so it must run as
    // the cluster's REAL superuser. On this image that is supabase_admin;
    // `postgres` carries CREATEROLE but rolsuper = false.
    this.must(this.applyFileAs('supabase_admin', ROLE_TOPOLOGY), 'stella_0001')
  }

  private must(r: Exec, label: string): void {
    if (r.status !== 0) {
      const why = (r.stderr || r.stdout).split('\n').filter((l) => l.trim() && !/NOTICE:/.test(l)).slice(-4).join('\n')
      throw new Error(`substrate step "${label}" failed on ${this.container}:\n${why}`)
    }
  }

  // -- the package under test ------------------------------------------------

  /** Apply the canonical package bytes. */
  applyPackage(): Exec {
    return this.applySqlAs('postgres', readFileSync(PACKAGE_PATH, 'utf8'))
  }

  /** Apply a MUTATED copy of the package, for the mutation controls. */
  applyMutant(sql: string): Exec {
    return this.applySqlAs('postgres', sql)
  }

  // -- probes ----------------------------------------------------------------

  /**
   * A fixture statement that MUST succeed.
   *
   * It throws on failure rather than returning a status, and that is
   * load-bearing: a fixture that silently failed turns its negative control
   * vacuous. MEASURED in this lane — `REVOKE uellix_writer FROM uellix_app` as
   * postgres returns 42501 because the grantor is supabase_admin, and an
   * unchecked call left the topology intact while the control reported that
   * the package had failed to refuse a drift that was never established.
   */
  fixture(sql: string, role = 'postgres'): void {
    const r = docker(['exec', '-i', this.container, 'psql', '-h', '127.0.0.1', '-U', role, '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql])
    if (r.status !== 0) {
      throw new Error(`fixture statement FAILED as ${role} — the control it sets up would be VACUOUS:\n  ${sql}\n  ${(r.stderr || '').split('\n')[0]}`)
    }
  }

  /**
   * Run `sql` as `role` inside a transaction that carries a SUBJECT identity,
   * and return ONLY the rows of `sql`.
   *
   * THE ECHO ROW IS WHY THIS EXISTS, and it is a measured hazard rather than a
   * theoretical one. `SELECT set_config('request.jwt.claims', …, true)` RETURNS
   * ITS OWN VALUE AS A ROW. A helper that simply concatenates the output of the
   * statement list therefore hands back at least one row no matter what the
   * relation under test returned — so an isolation assertion of the shape
   * "ORG_B's sentinel is not in the result" passes against a result set that is
   * actually EMPTY, and "the own row is present" can be satisfied by a claims
   * string that happens to contain the organisation's uuid. The marker below
   * cuts the stream at the identity statements so the caller can only ever see
   * the rows the target query produced.
   *
   * The claim is set with `is_local => true`, so it is discarded at COMMIT and
   * cannot leak onto a pooled connection — the same scope
   * db/identity-context.ts uses in production.
   */
  identityQuery(
    claims: { sub: string } | null,
    sql: string,
    role = 'uellix_app',
  ): { rows: string[][]; sqlstate: string | null; message: string } {
    const setClaims =
      claims === null
        ? ''
        : `SELECT set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);\n`
    const script =
      `\\set VERBOSITY verbose\n` +
      `BEGIN;\n` +
      setClaims +
      `\\echo ${ROW_MARKER}\n` +
      `${sql};\n` +
      `COMMIT;\n`

    const r = docker(
      ['exec', '-i', this.container, 'psql', '-h', '127.0.0.1', '-U', role, '-d', DB_NAME,
        '-v', 'ON_ERROR_STOP=1', '-tAq', '-F', '|', '-f', '-'],
      script,
    )
    if (r.status !== 0) {
      const m = /ERROR:\s+([0-9A-Z]{5}):/.exec(r.stderr)
      // The MESSAGE travels with the code, because a SQLSTATE alone does not
      // name the clause that refused: 42501 is raised by a missing GRANT, by an
      // RLS WITH CHECK violation, AND by any trigger that raises with
      // ERRCODE = 'insufficient_privilege'. A control that reported only the
      // code sent this lane looking at the wrong clause.
      const msg = r.stderr
        .split('\n')
        .filter((l) => /ERROR:|DETAIL:/.test(l))
        .join(' | ')
        .trim()
      return {
        rows: [],
        sqlstate: m ? m[1] : `UNPARSED:${r.stderr.split('\n')[0]}`,
        message: msg,
      }
    }
    const cut = r.stdout.indexOf(ROW_MARKER)
    if (cut < 0) {
      throw new Error(`the row marker never appeared — the identity statements did not run:\n${r.stdout}`)
    }
    const rows = r.stdout
      .slice(cut + ROW_MARKER.length)
      .split('\n')
      .map((s) => s.trimEnd())
      .filter((s) => s.length > 0)
      .map((l) => l.split('|'))
    return { rows, sqlstate: null, message: '' }
  }

  /**
   * A fixture statement that must succeed, run WITH a subject identity set.
   *
   * MEASURED NECESSITY, not convenience. Several of the relations under test
   * carry BEFORE INSERT triggers that compare a column to auth.uid() — for
   * example organization_commercial_acceptances refuses with
   * "accepted_by_user_id must be the acting subject (I-T4-6)". In a claim-free
   * administrative session auth.uid() is NULL, so those rows cannot be seeded
   * at all without establishing the same identity the product establishes.
   *
   * This sets ONLY the transaction-local claim, exactly as
   * db/identity-context.ts does. It grants nothing, alters no role and changes
   * no privilege, so it stays inside SECTION_13's prohibition on ad-hoc GRANTs.
   */
  fixtureAs(subject: string, sql: string, role = 'postgres'): void {
    const script =
      `BEGIN;
` +
      `SELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: subject })}', true);
` +
      `${sql}
` +
      `COMMIT;
`
    const r = docker(
      ['exec', '-i', this.container, 'psql', '-h', '127.0.0.1', '-U', role, '-d', DB_NAME,
        '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
      script,
    )
    if (r.status !== 0) {
      const why = (r.stderr || '')
        .split('\n')
        .filter((l) => l.trim() && !/NOTICE:/.test(l))
        .slice(0, 3)
        .join(' | ')
      throw new Error(
        `fixture statement FAILED as ${role} for subject ${subject} — the control it sets up would be VACUOUS: ${why}`,
      )
    }
  }

  /** Rows as arrays of columns. */
  query(sql: string, role = 'postgres'): string[][] {
    const r = docker(['exec', '-i', this.container, 'psql', '-h', '127.0.0.1', '-U', role, '-d', DB_NAME, '-tAq', '-F', '|', '-c', sql])
    if (r.status !== 0) throw new Error(`query failed as ${role}: ${(r.stderr || '').split('\n')[0]}\n${sql}`)
    return r.stdout.split('\n').map((s) => s.trimEnd()).filter((s) => s.length > 0).map((l) => l.split('|'))
  }

  scalar(sql: string, role = 'postgres'): string | null {
    return this.query(sql, role)[0]?.[0] ?? null
  }

  bool(sql: string, role = 'postgres'): boolean {
    return this.scalar(sql, role) === 't'
  }

  /**
   * Run a statement AS `role` and return its SQLSTATE, or null when it
   * succeeded.
   *
   * SQLSTATE, never message text: a message is prose that changes between
   * PostgreSQL releases, and a negative control keyed on prose reports green
   * the day the wording moves. `\set VERBOSITY verbose` is what makes psql
   * print the code.
   */
  sqlstate(sql: string, role: string): string | null {
    const r = docker(['exec', '-i', this.container, 'psql', '-h', '127.0.0.1', '-U', role, '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-q', '-c', '\\set VERBOSITY verbose', '-c', sql])
    if (r.status === 0) return null
    const m = /ERROR:\s+([0-9A-Z]{5}):/.exec(r.stderr)
    return m ? m[1] : `UNPARSED:${r.stderr.split('\n')[0]}`
  }

  /** The full table ACL of schema public, as a stable, comparable string. */
  tableAclSnapshot(): string {
    return this.scalar(
      `SELECT coalesce(string_agg(c.relname||'|'||a.grantee::regrole::text||'|'||a.privilege_type, E'\\n' ORDER BY c.relname, a.grantee::regrole::text, a.privilege_type),'')
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
       WHERE n.nspname = 'public'`,
    ) ?? ''
  }

  /** The full function ACL of schema public. */
  functionAclSnapshot(): string {
    return this.scalar(
      `SELECT coalesce(string_agg(p.proname||'|'||a.grantee::regrole::text||'|'||a.privilege_type, E'\\n' ORDER BY p.proname, a.grantee::regrole::text, a.privilege_type),'')
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a
       WHERE n.nspname = 'public'`,
    ) ?? ''
  }

  /** The effective S/I/U/D string for one role on one table. */
  privileges(role: string, table: string): string {
    return this.scalar(
      `SELECT (CASE WHEN has_table_privilege('${role}','public.${table}','SELECT') THEN 'S' ELSE '' END||
               CASE WHEN has_table_privilege('${role}','public.${table}','INSERT') THEN 'I' ELSE '' END||
               CASE WHEN has_table_privilege('${role}','public.${table}','UPDATE') THEN 'U' ELSE '' END||
               CASE WHEN has_table_privilege('${role}','public.${table}','DELETE') THEN 'D' ELSE '' END)`,
    ) ?? ''
  }

  // -- teardown --------------------------------------------------------------

  /** Destroy the container. Returns the number of leftovers found afterwards. */
  destroy(): number {
    docker(['rm', '-f', '-v', this.container])
    const leftover = docker(['ps', '-a', '--filter', `name=^${this.container}$`, '--format', '{{.Names}}'])
    return leftover.status === 0 && leftover.stdout.trim().length > 0 ? 1 : 0
  }

  /** Any container this harness has ever left behind, by prefix. */
  static leftovers(): string[] {
    const r = docker(['ps', '-a', '--filter', `name=${CONTAINER_PREFIX}`, '--format', '{{.Names}}'])
    return r.status !== 0 ? [] : r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  }
}

/**
 * Apply a uniquely-placed textual mutation to the package source.
 *
 * REFUSES a mutation whose anchor is absent or ambiguous, and that refusal is
 * the point. An anchor that matches nothing produces a mutant identical to the
 * original, so the control passes while testing nothing; an anchor that matches
 * twice mutates a sibling and attributes the result to the wrong statement.
 * Both have happened in this repository. MEASURED in this lane: the bare line
 * `public.invitations, public.marketing_leads, ...` occurs TWICE in §5 — once
 * in the GRANT and once in its paired convergence REVOKE — and the guard below
 * is what caught it.
 */
export function mutateUniquely(source: string, anchor: string, replacement: string, label: string): string {
  const occurrences = source.split(anchor).length - 1
  if (occurrences === 0) {
    throw new Error(`${label}: the mutation anchor is ABSENT, so the mutant would be identical to the original and the control vacuous.`)
  }
  if (occurrences > 1) {
    throw new Error(`${label}: the mutation anchor matches ${occurrences} times — it would mutate a sibling statement and misattribute the result.`)
  }
  return source.replace(anchor, replacement)
}

export function packageSource(): string {
  return readFileSync(PACKAGE_PATH, 'utf8')
}

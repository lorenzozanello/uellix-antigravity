// tests/capability-isolation.test.ts
//
// Static gate for the public-capability campaign (stella_0006..0010).
//
// WHAT THIS SUITE IS. The capability model rests on one claim: enabling one
// capability does not enable another. That claim is meant to be provable from
// the catalogue — disjoint executors, disjoint definers, disjoint grants — and
// the LIVE proof needs a database, which this unit is forbidden from touching.
//
// So this suite proves the half that can be proved offline: that the SQL which
// would produce that catalogue says what the design says it says. It reads
// db/prepared/*.sql as text. No database, no network, no fixtures.
//
// WHAT IT IS NOT. It is not a substitute for the live suites
// (invitation-capability, public-verification-capability,
// stripe-webhook-capability, public-lead-capability,
// organization-bootstrap-capability), which are DESIGNED in the per-capability
// documents and NOT implemented here because they require a disposable stack.
// A green run here means "the packages are internally consistent and isolated
// by construction", not "the capabilities work".
//
// Sibling of tests/prepared-stella-sql.test.ts, which lints the whole prepared
// directory for dynamic SQL. This one is about the capability campaign
// specifically and about isolation between its five members.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')
const DOCS = path.resolve(process.cwd(), 'docs', 'ops')
const read = (name: string) => readFileSync(path.join(PREPARED, name), 'utf8')

/** Strip -- line comments so prose about a rule is never mistaken for the rule. */
function code(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      let inString = false
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "'") {
          if (inString && line[i + 1] === "'") i++
          else inString = !inString
        } else if (!inString && line[i] === '-' && line[i + 1] === '-') {
          return line.slice(0, i)
        }
      }
      return line
    })
    .join('\n')
}

/**
 * The functions a package defines, split into HEADER (everything from the
 * CREATE line to `AS $$`) and BODY (between the dollar quotes).
 *
 * Counting keywords over raw text does not work here and the first draft of
 * this file proved it: `RAISE EXCEPTION 'accept_invitation is not a SECURITY
 * DEFINER owned by ...'` is a string literal in a postcondition, and a naive
 * `match(/SECURITY DEFINER/g)` counts it as a second function. Parsing the
 * structure removes that whole class of false positive rather than adding one
 * exception per occurrence.
 */
interface ParsedFunction {
  readonly name: string
  readonly header: string
  readonly body: string
}

function parseFunctions(sql: string): ParsedFunction[] {
  const out: ParsedFunction[] = []
  const re = /CREATE OR REPLACE FUNCTION\s+uellix_capability\.(\w+)\s*\(([\s\S]*?)\n?AS \$\$([\s\S]*?)\n\$\$;/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    out.push({ name: m[1], header: m[2], body: m[3] })
  }
  return out
}

/** Column names of a CREATE TABLE, ignoring CONSTRAINT and CHECK clauses. */
function columnNames(sql: string, table: string): string[] {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`)
  const m = re.exec(sql)
  if (!m) return []
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(CONSTRAINT|CHECK|PRIMARY KEY|UNIQUE|FOREIGN KEY)\b/i.test(l))
    .map((l) => l.split(/\s+/)[0])
    .filter((n) => /^[a-z_]+$/.test(n))
}

interface Capability {
  readonly id: string
  readonly forward: string
  readonly rollback: string
  readonly definer: string
  readonly executor: string
  readonly functions: readonly string[]
  readonly policyPrefix: string
  readonly policyCount: number
  readonly restrictiveCount: number
  readonly doc: string
}

const CAPABILITIES: Capability[] = [
  {
    id: 'CAP-01',
    forward: 'stella_0006_invitation_capability.sql',
    rollback: 'stella_0006_rollback.sql',
    definer: 'uellix_cap_invitation',
    executor: 'uellix_app',
    functions: ['accept_invitation'],
    policyPrefix: 'cap_invitation_',
    policyCount: 9,   // 6 permissive + 3 RESTRICTIVE (round 2, F-02)
    restrictiveCount: 3,
    doc: 'capabilities/CAP_01_INVITATIONS.md',
  },
  {
    id: 'CAP-02',
    forward: 'stella_0007_public_verification_capability.sql',
    rollback: 'stella_0007_rollback.sql',
    definer: 'uellix_cap_verification',
    executor: 'uellix_app',
    functions: ['verify_report', 'record_verification_hit'],
    policyPrefix: 'cap_verification_',
    // 5 permissive + 4 RESTRICTIVE. The two added for RR-CAP-13 bound the rows
    // of organizations and sroi_calculation_runs, whose only bound used to be
    // the JOIN inside verify_report.
    policyCount: 9,
    restrictiveCount: 4,
    doc: 'capabilities/CAP_02_PUBLIC_VERIFICATION.md',
  },
  {
    id: 'CAP-03',
    forward: 'stella_0008_stripe_webhook_identity.sql',
    rollback: 'stella_0008_rollback.sql',
    definer: 'uellix_cap_stripe',
    executor: 'uellix_stripe',
    functions: ['stripe_begin_event', 'stripe_apply_subscription', 'stripe_fail_event'],
    policyPrefix: 'cap_stripe_',
    // 4 permissive + 2 RESTRICTIVE. CAP-03 was the one capability with none at
    // all (RR-CAP-14): the whole tenancy bound was a six-column GRANT, which
    // says which FIELDS and never which ROWS.
    policyCount: 6,
    restrictiveCount: 2,
    doc: 'capabilities/CAP_03_STRIPE.md',
  },
  {
    id: 'CAP-04',
    forward: 'stella_0009_public_lead_capability.sql',
    rollback: 'stella_0009_rollback.sql',
    definer: 'uellix_cap_lead',
    executor: 'uellix_app',
    functions: ['submit_lead'],
    policyPrefix: 'cap_lead_',
    policyCount: 2,   // cap_lead_insert + the RESTRICTIVE cap_lead_deny_runtime
    restrictiveCount: 1,
    doc: 'capabilities/CAP_04_PUBLIC_LEADS.md',
  },
  {
    id: 'CAP-05',
    forward: 'stella_0010_organization_bootstrap_capability.sql',
    rollback: 'stella_0010_rollback.sql',
    definer: 'uellix_cap_bootstrap',
    executor: 'uellix_app',
    functions: ['bootstrap_organization'],
    policyPrefix: 'cap_bootstrap_',
    policyCount: 11,  // 8 permissive + 3 RESTRICTIVE
    restrictiveCount: 3,
    doc: 'capabilities/CAP_05_ORGANIZATION_BOOTSTRAP.md',
  },
]

const ALL_DEFINERS = CAPABILITIES.map((c) => c.definer)

// ---------------------------------------------------------------------------
// 1. The campaign exists in the shape the model describes
// ---------------------------------------------------------------------------

describe('capability campaign — inventory', () => {
  it.each(CAPABILITIES)('$id ships a forward script and a rollback', (cap) => {
    expect(existsSync(path.join(PREPARED, cap.forward)), cap.forward).toBe(true)
    expect(existsSync(path.join(PREPARED, cap.rollback)), cap.rollback).toBe(true)
  })

  it.each(CAPABILITIES)('$id has a source-of-truth document', (cap) => {
    expect(existsSync(path.join(DOCS, cap.doc)), cap.doc).toBe(true)
  })

  it('the common model document exists and states nothing is enabled', () => {
    const model = readFileSync(path.join(DOCS, 'DATABASE_CAPABILITY_MODEL.md'), 'utf8')
    expect(model).toMatch(/Ninguna capacidad habilitada/i)
    expect(model).toMatch(/Nada aplicado/i)
  })

  it.each(CAPABILITIES)('$id declares itself DESIGN and NOT APPLIED', (cap) => {
    // The header is the first thing an operator reads before running the file.
    // If it ever stops saying this, that is a decision someone has to make on
    // purpose.
    expect(read(cap.forward)).toMatch(/NOT APPLIED ANYWHERE/)
  })
})

// ---------------------------------------------------------------------------
// 2. Isolation — the property the whole design is for
// ---------------------------------------------------------------------------

describe('capability isolation — one capability does not enable another', () => {
  it('every capability has its OWN definer role, shared with no other', () => {
    expect(new Set(ALL_DEFINERS).size).toBe(CAPABILITIES.length)
  })

  it('no capability function name is claimed by two packages', () => {
    const all = CAPABILITIES.flatMap((c) => c.functions)
    expect(new Set(all).size).toBe(all.length)
  })

  it.each(CAPABILITIES)('$id grants EXECUTE on its own functions to exactly one role: $executor', (cap) => {
    // Only grants on uellix_capability functions count. Each package also
    // grants EXECUTE on the three public.current_user_* RLS helpers to its own
    // definer — without which every policy-guarded read inside the definer
    // fails 42501 against somebody else's {public} policy. Those are a
    // different statement with a different purpose and are checked separately.
    const grants = [
      ...code(read(cap.forward)).matchAll(
        /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+uellix_capability\.[\s\S]*?TO\s+(\w+)\s*;/gi,
      ),
    ].map((m) => m[1])
    expect(grants.length).toBe(cap.functions.length)
    expect(new Set(grants)).toEqual(new Set([cap.executor]))
  })

  it.each(CAPABILITIES)('$id grants the RLS helpers only to its own definer', (cap) => {
    const helperGrants = [
      ...code(read(cap.forward)).matchAll(
        /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.current_user_[\s\S]*?TO\s+(\w+)\s*;/gi,
      ),
    ].map((m) => m[1])
    // CAP-04 touches only marketing_leads, whose policies name anon /
    // authenticated / the capability role and never {public}, so its definer
    // never evaluates a helper and never needs the grant.
    if (cap.id === 'CAP-04') {
      expect(helperGrants).toEqual([])
    } else {
      expect(helperGrants.length).toBe(3)
      expect(new Set(helperGrants)).toEqual(new Set([cap.definer]))
    }
  })

  it.each(CAPABILITIES)('$id never grants a table privilege to another capability role', (cap) => {
    const body = code(read(cap.forward))
    for (const other of ALL_DEFINERS) {
      if (other === cap.definer) continue
      expect(body, `${cap.forward} mentions ${other} in a GRANT`).not.toMatch(
        new RegExp(`GRANT[^;]*\\bTO\\s+${other}\\b`, 'i'),
      )
    }
  })

  it('only CAP-03 introduces a LOGIN role, and it is uellix_stripe', () => {
    for (const cap of CAPABILITIES) {
      const body = code(read(cap.forward))
      const loginRoles = [...body.matchAll(/ALTER ROLE\s+(\w+)\s*\n?\s*LOGIN\b/gi)].map((m) => m[1])
      if (cap.id === 'CAP-03') {
        expect(loginRoles).toEqual(['uellix_stripe'])
      } else {
        expect(loginRoles, `${cap.forward} creates a LOGIN role`).toEqual([])
      }
    }
  })

  it('the runtime cannot execute any Stripe function — that is what stops an endpoint moving a quota', () => {
    const body = code(read('stella_0008_stripe_webhook_identity.sql'))
    expect(body).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION[^;]*TO\s+uellix_app\b/i)
  })

  it('the Stripe identity can execute nothing outside CAP-03', () => {
    for (const cap of CAPABILITIES) {
      if (cap.id === 'CAP-03') continue
      expect(code(read(cap.forward))).not.toMatch(/TO\s+uellix_stripe\b/i)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Nothing reaches anon, authenticated, service_role or PUBLIC
// ---------------------------------------------------------------------------

describe('capability campaign — no capability widens a pre-existing role', () => {
  it.each(CAPABILITIES)('$id grants nothing to anon, authenticated or service_role', (cap) => {
    const body = code(read(cap.forward))
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(body, `${cap.forward} grants to ${role}`).not.toMatch(
        new RegExp(`GRANT[^;]*\\bTO\\s+${role}\\b`, 'i'),
      )
    }
  })

  it.each(CAPABILITIES)('$id grants nothing to PUBLIC', (cap) => {
    // REVOKE ... FROM PUBLIC is required; GRANT ... TO PUBLIC is forbidden.
    expect(code(read(cap.forward))).not.toMatch(/GRANT[^;]*\bTO\s+PUBLIC\b/i)
  })

  it.each(CAPABILITIES)('$id creates no policy without a TO clause', (cap) => {
    // A policy with no TO is TO PUBLIC — the exact defect stella_0005c had to
    // repair. Every CREATE POLICY in this campaign must name its role.
    const policies = [
      ...code(read(cap.forward)).matchAll(/CREATE POLICY\s+(\w+)[\s\S]*?(?=;)/gi),
    ]
    expect(policies.length).toBeGreaterThan(0)
    for (const p of policies) {
      expect(p[0], `policy ${p[1]} in ${cap.forward} has no TO clause`).toMatch(/\bTO\s+\w+/i)
    }
  })

  it.each(CAPABILITIES)('$id revokes EXECUTE from PUBLIC for every function it creates', (cap) => {
    const body = code(read(cap.forward))
    const revokes = [...body.matchAll(/REVOKE\s+ALL\s+ON\s+FUNCTION[\s\S]*?FROM\s+PUBLIC\s*;/gi)]
    // A function created with a NULL proacl is EXECUTE TO PUBLIC implicitly, so
    // the REVOKE is what closes the default rather than defensive noise.
    expect(revokes.length).toBe(cap.functions.length)
  })
})

// ---------------------------------------------------------------------------
// 4. The SECURITY DEFINER standard
// ---------------------------------------------------------------------------

describe('capability campaign — SECURITY DEFINER standard', () => {
  it.each(CAPABILITIES)('$id: every function is SECURITY DEFINER with an empty search_path', (cap) => {
    const parsed = parseFunctions(code(read(cap.forward)))
    expect(new Set(parsed.map((f) => f.name))).toEqual(new Set(cap.functions))
    for (const fn of parsed) {
      expect(fn.header, `${fn.name} is not SECURITY DEFINER`).toMatch(/\bSECURITY DEFINER\b/)
      expect(fn.header, `${fn.name} has no empty search_path`).toMatch(/SET search_path = ''/)
      // Never IMMUTABLE: these read or write rows, so an immutable declaration
      // would license the planner to cache across snapshots.
      expect(fn.header, `${fn.name} is IMMUTABLE`).not.toMatch(/\bIMMUTABLE\b/)
    }
  })

  it.each(CAPABILITIES)('$id: every function body qualifies every reference', (cap) => {
    // With search_path = '' an unqualified name does not resolve at all, so
    // this is really a check that nothing was written which would fail at run
    // time in a place — inside a webhook, inside an accept link — where
    // discovering it is expensive.
    for (const fn of parseFunctions(code(read(cap.forward)))) {
      const unqualified = [...fn.body.matchAll(/\b(?:FROM|JOIN|INSERT INTO|UPDATE)\s+(?!public\.|uellix_capability\.|pg_catalog\.|unnest|EXCLUDED)([a-z_]+)/g)]
        .map((m) => m[1])
        // `IS DISTINCT FROM p_stripe_customer_id` matches the FROM alternative
        // and is not a relation reference at all. Local variables and
        // parameters carry the p_/v_/c_ prefixes this campaign uses, so they
        // are excluded by name rather than by weakening the pattern.
        .filter((n) => !/^(p|v|c)_/.test(n))
        .filter((n) => !['set', 'select'].includes(n))
      expect(unqualified, `${fn.name} has unqualified relation references`).toEqual([])
    }
  })

  it.each(CAPABILITIES)('$id: every function is owned by its capability role', (cap) => {
    const body = code(read(cap.forward))
    const owners = [
      ...body.matchAll(/ALTER FUNCTION\s+uellix_capability\.[\s\S]*?OWNER TO\s+(\w+)\s*;/gi),
    ].map((m) => m[1])
    expect(owners.length).toBe(cap.functions.length)
    expect(new Set(owners)).toEqual(new Set([cap.definer]))
  })

  it.each(CAPABILITIES)('$id: the definer role is NOLOGIN and has no dangerous attribute', (cap) => {
    const body = code(read(cap.forward))
    const re = new RegExp(`ALTER ROLE\\s+${cap.definer}\\s*\\n?\\s*([^;]+);`, 'i')
    const attrs = re.exec(body)
    expect(attrs, `${cap.forward} does not set attributes on ${cap.definer}`).not.toBeNull()
    for (const forbidden of ['NOLOGIN', 'NOBYPASSRLS', 'NOCREATEROLE', 'NOCREATEDB', 'NOSUPERUSER']) {
      expect(attrs![1], `${cap.definer} missing ${forbidden}`).toContain(forbidden)
    }
  })

  it.each(CAPABILITIES)('$id: the definer role is granted to NOBODY', (cap) => {
    // Stronger than the invariant this replaced. An earlier revision granted
    // the capability role to uellix_owner with INHERIT FALSE / SET TRUE, so it
    // could transfer ownership of the function — and SET ROLE authorisation is
    // TRANSITIVE, so uellix_migrator (a LOGIN role that can SET ROLE to
    // uellix_owner) could reach every capability role in two statements. The
    // model's claim that no connection string resolves to a capability role
    // was false while that grant existed.
    //
    // Doing the ownership transfer in the superuser window removes the need for
    // the grant entirely, and the claim becomes true.
    const body = code(read(cap.forward))
    const grants = [...body.matchAll(new RegExp(`GRANT\\s+${cap.definer}\\s+TO\\s+`, 'gi'))]
    expect(grants, `${cap.definer} is granted to someone`).toEqual([])
  })

  it.each(CAPABILITIES)('$id: the function lifecycle happens in the superuser window', (cap) => {
    // ALTER FUNCTION ... OWNER TO R requires R to hold CREATE on the schema,
    // which the capability role deliberately does not have; and CREATE OR
    // REPLACE on a second apply requires ownership resolved through
    // has_privs_of_role. Both fail if the block runs under SET ROLE
    // uellix_owner. Everything about the function must come after RESET ROLE.
    const body = code(read(cap.forward))
    const reset = body.lastIndexOf('RESET ROLE;')
    expect(reset).toBeGreaterThan(-1)
    for (const marker of ['CREATE OR REPLACE FUNCTION uellix_capability.', 'OWNER TO ' + cap.definer]) {
      const at = body.indexOf(marker)
      expect(at, `${marker} appears before the last RESET ROLE`).toBeGreaterThan(reset)
    }
  })

  it.each(CAPABILITIES)('$id: no dynamic SQL beyond the fixed-literal CREATE ROLE', (cap) => {
    const body = code(read(cap.forward))
    // Same admitted forms as tests/prepared-stella-sql.test.ts: EXECUTE FUNCTION
    // (trigger syntax), EXECUTE ON (the privilege name), and a self-contained
    // literal. Nothing may be concatenated onto an executed literal.
    const executes = [...body.matchAll(/\bEXECUTE\s+'([^']*)'/g)].map((m) => m[1])
    for (const stmt of executes) {
      expect(stmt, `dynamic statement in ${cap.forward}`).toMatch(
        /^(CREATE ROLE \w+|DROP ROLE \w+|REVOKE .+|GRANT .+|ALTER .+|DROP SCHEMA \w+)$/,
      )
    }
    expect(body).not.toMatch(/EXECUTE\s+format\s*\(/i)
    expect(body).not.toMatch(/EXECUTE\s+'[^']*'\s*\|\|/)
  })

  it.each(CAPABILITIES)('$id: no CASCADE anywhere', (cap) => {
    // CASCADE on a DROP ROLE or DROP TABLE would silently remove objects the
    // operator was never told about. A loud failure is the correct outcome.
    expect(code(read(cap.forward))).not.toMatch(/\bCASCADE\b/i)
    expect(code(read(cap.rollback))).not.toMatch(/\bCASCADE\b/i)
  })

  it.each(CAPABILITIES)('$id: contains no password', (cap) => {
    expect(code(read(cap.forward))).not.toMatch(/\bPASSWORD\b/i)
    expect(code(read(cap.rollback))).not.toMatch(/\bPASSWORD\b/i)
  })
})

// ---------------------------------------------------------------------------
// 4b. Regressions pinned by the disposable dry run
// ---------------------------------------------------------------------------
// Every case here failed against a real PostgreSQL 17.6 and is invisible to
// reading. They are kept as static gates so the same mistake cannot return.

describe('capability campaign — dry-run regressions', () => {
  it.each(CAPABILITIES)('$id: no SQL-standard construct is over-qualified', (cap) => {
    // COALESCE, NULLIF, GREATEST and LEAST are grammar productions that build
    // CoalesceExpr / NullIfExpr nodes. There are no pg_proc rows with those
    // names, so `pg_catalog.coalesce(...)` parses as a function call and dies
    // «function pg_catalog.coalesce(...) does not exist» — at RUN time, since
    // plpgsql does not resolve SQL expressions at CREATE FUNCTION. Being
    // grammar, they cannot be shadowed by search_path either, so qualifying
    // them buys nothing and costs the capability.
    expect(code(read(cap.forward))).not.toMatch(
      /pg_catalog\.(coalesce|nullif|greatest|least)\s*\(/i,
    )
  })

  it.each(CAPABILITIES)('$id: no aggregate is used on a uuid column', (cap) => {
    // PostgreSQL has no min()/max() for uuid. `min(o.id)` raises 42883 inside
    // the function, which for CAP-03 means inside a live webhook.
    for (const fn of parseFunctions(code(read(cap.forward)))) {
      expect(fn.body, `${fn.name} aggregates a uuid`).not.toMatch(/\bmin\s*\(\s*\w+\.id\s*\)/i)
      expect(fn.body, `${fn.name} aggregates a uuid`).not.toMatch(/\bmax\s*\(\s*\w+\.id\s*\)/i)
    }
  })

  it.each(CAPABILITIES)('$id: has_any_column_privilege is never asked for DELETE', (cap) => {
    // DELETE and TRUNCATE have no column-level form, so
    // has_any_column_privilege(..., 'DELETE') raises «unrecognized privilege
    // type» rather than returning false — and it aborted a whole package.
    const body = code(read(cap.forward))
    const calls = [...body.matchAll(/has_any_column_privilege\([\s\S]{0,200}?\)/g)].map((m) => m[0])
    for (const call of calls) {
      expect(call, 'column privilege check asks for a table-only mode').not.toMatch(
        /'(DELETE|TRUNCATE|TRIGGER)'/,
      )
    }
  })

  it('CAP-04 uses an UNTARGETED ON CONFLICT', () => {
    // Measured: naming an arbiter makes its columns part of the statement's
    // SELECT requirement, so a targeted conflict clause and a SELECT-less
    // definer are mutually exclusive. Plain INSERT and untargeted DO NOTHING
    // both succeed for this definer; the targeted form is denied.
    const body = code(read('stella_0009_public_lead_capability.sql'))
    expect(body).toMatch(/ON CONFLICT DO NOTHING;/)
    expect(body).not.toMatch(/ON CONFLICT\s*\([^)]*\)\s*DO NOTHING/)
  })

  it('CAP-01 reads without the lock before taking it', () => {
    // SELECT ... FOR UPDATE is filtered by the UPDATE policy's USING clause,
    // and this capability's is USING (status = 'pending'). A locking read of an
    // already-accepted row therefore returns NOT FOUND, which made the
    // idempotent-replay branch unreachable: a user reloading the accept page
    // got a refusal instead of their membership.
    const fn = parseFunctions(code(read('stella_0006_invitation_capability.sql')))[0]
    const firstRead = fn.body.indexOf('FROM public.invitations i')
    const firstLock = fn.body.indexOf('FOR UPDATE')
    const replay = fn.body.indexOf("v_inv_status = 'accepted'")
    expect(firstRead).toBeGreaterThan(-1)
    expect(replay, 'the replay branch runs before any lock').toBeLessThan(firstLock)
  })

  it.each(CAPABILITIES.filter((c) => c.id !== 'CAP-04'))(
    '$id grants the RLS helpers, without which every guarded read dies at 42501',
    (cap) => {
      // The pre-existing policies on these tables are {public}: they apply to
      // EVERY role, the definer included, and call the three SECURITY DEFINER
      // helpers whose EXECUTE stella_0004 revoked from PUBLIC.
      const body = code(read(cap.forward))
      for (const helper of ['current_user_org_ids', 'current_user_is_super_admin', 'current_user_role_in_org']) {
        expect(body, `${cap.id} does not grant ${helper}`).toMatch(
          new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${helper}`),
        )
      }
    },
  )

  it.each(CAPABILITIES.filter((c) => ['CAP-01', 'CAP-05'].includes(c.id)))(
    '$id grants USAGE on schema auth, because its body calls auth.uid()',
    (cap) => {
      // Resolving auth.uid() needs USAGE on schema auth FOR THE DEFINER.
      // stella_0004 granted it to uellix_owner only, and stella_0005d exists
      // because exactly this was missed once already for schema storage.
      const body = code(read(cap.forward))
      expect(body).toMatch(new RegExp(`GRANT USAGE ON SCHEMA auth TO ${cap.definer}`))
      expect(code(read(cap.rollback))).toMatch(
        new RegExp(`REVOKE ALL ON SCHEMA auth FROM ${cap.definer}`),
      )
    },
  )

  it.each(CAPABILITIES.filter((c) => ['CAP-02', 'CAP-03', 'CAP-04'].includes(c.id)))(
    '$id does NOT grant schema auth — no body of its calls auth.uid()',
    (cap) => {
      expect(code(read(cap.forward))).not.toMatch(/GRANT USAGE ON SCHEMA auth/)
    },
  )

  it('CAP-03 does not mark a failure inside the transaction it aborts', () => {
    // UPDATE ... SET status='failed' followed by RAISE in the same transaction
    // is rolled back BY that RAISE: the event stays 'processing' with a NULL
    // error code, and every retry gets in_progress until the lease expires —
    // the silent loss the handler exists to prevent. Marking a failure belongs
    // to stripe_fail_event, which runs in its own transaction.
    const fns = parseFunctions(code(read('stella_0008_stripe_webhook_identity.sql')))
    const apply = fns.find((f) => f.name === 'stripe_apply_subscription')!
    expect(apply.body).not.toMatch(/SET status\s*=\s*'failed'/)
    // stripe_fail_event now routes 'not_applicable' to the ignored state, so
    // the assignment is a CASE rather than a literal. What the gate has to hold
    // is that the failure marking lives HERE, in its own transaction, and
    // nowhere else.
    const fail = fns.find((f) => f.name === 'stripe_fail_event')!
    expect(fail.body).toMatch(/status\s*=\s*CASE WHEN p_error_code/)
    expect(fail.body).toMatch(/'failed'/)
  })

  it.each(CAPABILITIES)('$id: every function collapses engine errors into the uniform refusal', (cap) => {
    // Without this, a 23505 reaches the caller with PostgreSQL's DETAIL — which
    // quotes row values: a real user id from user_single_active_membership, or
    // a Stripe subscription id from organizations_stripe_subscription_id_unique.
    for (const fn of parseFunctions(code(read(cap.forward)))) {
      if (fn.header.includes('LANGUAGE sql')) continue // no EXCEPTION in SQL functions
      expect(fn.body, `${fn.name} has no EXCEPTION block`).toMatch(/EXCEPTION[\s\S]*WHEN OTHERS THEN/)
      expect(fn.body, `${fn.name} logs SQLERRM`).not.toMatch(/RAISE LOG[^;]*SQLERRM/)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Uniform refusal
// ---------------------------------------------------------------------------

describe('capability campaign — uniform refusal', () => {
  it.each(CAPABILITIES)('$id raises only the uniform error, with no detail', (cap) => {
    // Only RAISEs inside a FUNCTION BODY matter. The precondition and
    // postcondition DO blocks are operator-facing and are allowed to be
    // specific: they run at apply time, before anyone can call anything.
    for (const fn of parseFunctions(code(read(cap.forward)))) {
      const raises = [...fn.body.matchAll(/RAISE EXCEPTION\s+'([^']*)'/g)].map((m) => m[1])
      for (const message of raises) {
        expect(
          [
            'capability request denied',
            // Contention is not a refusal, and the two must not share a
            // message: 'denied' tells the handler to stop, 'contended'
            // tells it to retry. Collapsing them is how a signed Stripe
            // delivery got dropped (RR-CAP-03-B).
            'capability request contended',
            'organization slug is already taken',
          ],
          `${fn.name} raises "${message}"`,
        ).toContain(message)
      }
    }
  })

  it.each(CAPABILITIES)('$id never returns a HINT or DETAIL from a function body', (cap) => {
    // USING HINT/DETAIL travels to the client and would reintroduce the
    // distinguishability the uniform message exists to remove.
    for (const fn of parseFunctions(code(read(cap.forward)))) {
      expect(fn.body, `${fn.name} attaches HINT/DETAIL`).not.toMatch(/USING[^;]*\b(HINT|DETAIL)\s*=/i)
    }
  })

  it('only CAP-05 has a distinguishable error, and it is the slug', () => {
    for (const cap of CAPABILITIES) {
      const body = code(read(cap.forward))
      const hasU0002 = /ERRCODE = 'U0002'/.test(body)
      expect(hasU0002, `${cap.id} uses U0002`).toBe(cap.id === 'CAP-05')
    }
  })

  it('CAP-01 does not write on any refusal path', () => {
    // The old acceptInvitation flipped an expired invitation to 'expired' and
    // THEN raised, so anyone holding an expired token could drive writes. The
    // function body must contain no UPDATE/INSERT before its first successful
    // branch — approximated here by requiring that no RAISE follows a write in
    // the expiry region.
    const body = code(read('stella_0006_invitation_capability.sql'))
    const fn = body.split('CREATE OR REPLACE FUNCTION')[1]
    const expiryIndex = fn.indexOf('expires_at <=')
    const firstWrite = fn.search(/\b(INSERT INTO|UPDATE)\s+public\./)
    expect(expiryIndex).toBeGreaterThan(-1)
    expect(firstWrite, 'a write precedes the expiry check').toBeGreaterThan(expiryIndex)
  })
})

// ---------------------------------------------------------------------------
// 6. Per-capability exclusions that ARE the design
// ---------------------------------------------------------------------------

describe('CAP-02 — the read capability cannot reach private data', () => {
  const body = code(read('stella_0007_public_verification_capability.sql'))

  it.each([
    'evidence_items',
    'sroi_report_sections',
    'sroi_calculation_line_items',
    'methodology_review_matrix',
  ])('grants nothing on %s', (table) => {
    expect(body).not.toMatch(new RegExp(`GRANT[^;]*ON\\s+public\\.${table}\\b`, 'i'))
  })

  it('verify_report is STABLE, so the public read path cannot write', () => {
    // Not a convention: the planner refuses a write in a STABLE function, so a
    // later edit that added one would fail at creation time.
    expect(body).toMatch(/CREATE OR REPLACE FUNCTION uellix_capability\.verify_report[\s\S]*?\nSTABLE\n/)
  })

  it('every visibility flag defaults to false — publishing is opt-in', () => {
    // The flag list is DERIVED from the CREATE TABLE, not written here.
    //
    // This test used to iterate four hardcoded names and was titled "all four".
    // Adversarial round 2 added show_issued_on and show_report_variant, and this
    // test kept passing while either of them could default to true — mutation
    // M-08 in tests/helpers/capability-mutations.ts is exactly that edit, and it
    // survived a 220/220 run of this file. A hardcoded list cannot see the name
    // that is not on it, which is a property of hardcoded lists and not of that
    // particular list, so the fix is to stop keeping one.
    const table = /CREATE TABLE IF NOT EXISTS public\.report_public_disclosures \(([\s\S]*?)\n\);/.exec(body)
    expect(table).not.toBeNull()
    const flags = [...table![1].matchAll(/^\s*(show_\w+)\s+boolean/gm)].map((m) => m[1])
    expect(flags.length, 'the disclosure table declares no visibility flag').toBeGreaterThanOrEqual(6)
    for (const flag of flags) {
      expect(body, `${flag} is not NOT NULL DEFAULT false`).toMatch(
        new RegExp(`${flag}\\s+boolean\\s+NOT NULL DEFAULT false`),
      )
    }
  })

  it('the hit counter carries no personal data and no column to put it in', () => {
    const table = /CREATE TABLE IF NOT EXISTS public\.capability_verification_hits \(([\s\S]*?)\);/.exec(body)
    expect(table).not.toBeNull()
    for (const forbidden of ['ip', 'user_agent', 'referer', 'referrer', 'fingerprint', 'session']) {
      expect(table![1].toLowerCase()).not.toContain(forbidden)
    }
  })
})

describe('CAP-03 — the webhook identity is contained', () => {
  const body = code(read('stella_0008_stripe_webhook_identity.sql'))

  it('uellix_stripe receives no table privilege at all', () => {
    expect(body).not.toMatch(/GRANT[^;]*ON\s+public\.[^;]*TO\s+uellix_stripe\b/i)
  })

  it('uellix_stripe has no membership in any role', () => {
    expect(body).not.toMatch(/GRANT\s+\w+\s+TO\s+uellix_stripe\b/i)
  })

  it('the event table has no payload column', () => {
    // Column NAMES, not raw text: last_error_code is CHECK-constrained to a
    // fixed list containing the value 'signature', and a substring scan over
    // the whole CREATE TABLE would read that constraint as a column.
    const columns = columnNames(body, 'stripe_webhook_events')
    expect(columns.length).toBeGreaterThan(0)
    for (const forbidden of ['payload', 'body', 'raw', 'signature', 'request']) {
      expect(columns, `stripe_webhook_events has a ${forbidden} column`).not.toContain(forbidden)
    }
  })

  it('event_id is the PRIMARY KEY — idempotency is atomic, not check-then-act', () => {
    expect(body).toMatch(/event_id\s+text\s+PRIMARY KEY/)
    expect(body).toMatch(/ON CONFLICT \(event_id\) DO UPDATE/)
  })

  it('the audit policy REQUIRES a null actor', () => {
    // The mirror of the uellix_app policy stella_0005c wrote. A billing change
    // made by Stripe must not be attributed to a person.
    const policy = /CREATE POLICY cap_stripe_insert_audit([\s\S]*?);/.exec(body)
    expect(policy).not.toBeNull()
    expect(policy![1]).toMatch(/actor_user_id IS NULL/)
  })

  it('the definer cannot rename an organisation or delete an event', () => {
    const updateGrant = /GRANT UPDATE \(([^)]*)\)\s*\n?\s*ON public\.organizations/.exec(body)
    expect(updateGrant).not.toBeNull()
    for (const col of ['name', 'slug', 'status']) {
      expect(updateGrant![1]).not.toContain(col)
    }
    expect(body).not.toMatch(/GRANT[^;]*\bDELETE\b[^;]*TO\s+uellix_cap_stripe/i)
  })
})

describe('CAP-04 — the lead writer cannot read', () => {
  const body = code(read('stella_0009_public_lead_capability.sql'))

  it('grants INSERT and only INSERT to the definer', () => {
    const grants = [...body.matchAll(/GRANT\s+([A-Z ,()a-z_]+?)\s+ON public\.marketing_leads TO uellix_cap_lead/g)]
    expect(grants.length).toBe(1)
    expect(grants[0][1]).toMatch(/^INSERT/)
  })

  it('the function returns void and never uses RETURNING', () => {
    const fn = body.split('CREATE OR REPLACE FUNCTION uellix_capability.submit_lead')[1]
    expect(fn).toMatch(/RETURNS void/)
    expect(fn.split('$$')[1] ?? '').not.toMatch(/RETURNING/i)
  })

  it('revokes the runtime writer privileges — the package is a net reduction', () => {
    expect(body).toMatch(/REVOKE SELECT, INSERT, UPDATE, DELETE ON public\.marketing_leads FROM uellix_writer/)
  })

  it('retires the two dead PostgREST-era policies but keeps the super-admin read', () => {
    expect(body).toMatch(/DROP POLICY IF EXISTS anon_insert_marketing_leads/)
    expect(body).toMatch(/DROP POLICY IF EXISTS authenticated_insert_marketing_leads/)
    expect(body).not.toMatch(/DROP POLICY IF EXISTS super_admins_read_marketing_leads/)
  })

  it('the rollback restores the privileges it took away, rather than improving on the way out', () => {
    // A rollback that quietly hardens produces a state matching neither before
    // nor after, and the next operator cannot tell which they are looking at.
    const rb = code(read('stella_0009_rollback.sql'))
    expect(rb).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.marketing_leads TO uellix_writer/)
    expect(rb).toMatch(/CREATE POLICY anon_insert_marketing_leads/)
    expect(rb).toMatch(/CREATE POLICY authenticated_insert_marketing_leads/)
  })

  it('lead_status is not a parameter of the function', () => {
    const signature = /submit_lead\(([\s\S]*?)\)\s*RETURNS void/.exec(body)
    expect(signature).not.toBeNull()
    expect(signature![1]).not.toMatch(/status/i)
  })
})

describe('CAP-05 — bootstrap cannot choose owner, role, plan or quota', () => {
  const body = code(read('stella_0010_organization_bootstrap_capability.sql'))

  it('the signature carries no subject, role, plan or quota parameter', () => {
    const signature = /bootstrap_organization\(([\s\S]*?)\)\s*RETURNS TABLE/.exec(body)
    expect(signature).not.toBeNull()
    for (const forbidden of ['user_id', 'owner', 'role', 'plan', 'quota', 'flag', 'admin']) {
      expect(signature![1].toLowerCase(), `signature accepts ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('the subject comes from auth.uid()', () => {
    expect(body).toMatch(/v_subject\s*:=\s*auth\.uid\(\)/)
  })

  it('the INSERT grant on organizations excludes every billing column', () => {
    const grant = /GRANT INSERT \(([^)]*)\)\s*\n?\s*ON public\.organizations/.exec(body)
    expect(grant).not.toBeNull()
    for (const col of ['stella_monthly_quota', 'stella_plan_label', 'stripe']) {
      expect(grant![1]).not.toContain(col)
    }
  })

  it('the membership policy pins the founding role', () => {
    const policy = /CREATE POLICY cap_bootstrap_insert_members([\s\S]*?);/.exec(body)
    expect(policy).not.toBeNull()
    expect(policy![1]).toMatch(/role = 'organization_admin'/)
  })

  it('slug uniqueness is atomic, and names the constraint rather than the column', () => {
    // ON CONFLICT (slug) would put an OUT variable of the same name into an
    // expression context, where plpgsql substitutes it. Naming the constraint
    // avoids that and pins the one the precondition verified.
    expect(body).toMatch(/ON CONFLICT ON CONSTRAINT organizations_slug_unique DO NOTHING/)
    expect(body).not.toMatch(/ON CONFLICT \(slug\)/)
  })

  it('the reserved-slug denylist covers the application\'s own routes', () => {
    for (const reserved of ['app', 'api', 'verify', 'invite', 'login', 'admin']) {
      expect(body).toMatch(new RegExp(`'${reserved}'`))
    }
  })

  it('leaves the two historic policies it was designed around untouched', () => {
    expect(body).not.toMatch(/DROP POLICY IF EXISTS members_insert_admin/)
    expect(body).not.toMatch(/DROP POLICY IF EXISTS orgs_insert_super_admin/)
  })

  it('creates no LOGIN bootstrap identity', () => {
    // The postcondition MENTIONS uellix_bootstrap in order to assert its
    // absence, so this has to look for a creation, not for the name.
    expect(body).not.toMatch(/CREATE ROLE uellix_bootstrap\b/)
    expect(body).not.toMatch(/ALTER ROLE\s+\w+\s*\n?\s*LOGIN\b/)
  })
})

// ---------------------------------------------------------------------------
// 7. Preconditions, postconditions and rollback symmetry
// ---------------------------------------------------------------------------

describe('capability campaign — packages guard themselves', () => {
  it.each(CAPABILITIES)('$id asserts the same order-independent baseline', (cap) => {
    const body = code(read(cap.forward))
    // 38 tables and 105 policies, counted EXCLUDING everything the campaign
    // introduces. A raw global count would couple the five packages into an
    // implicit ordering the design does not have.
    expect(body).toMatch(/\)\) <> 38 THEN/)
    expect(body).toMatch(/\)\) <> 105 THEN/)
    expect(body).toMatch(/anon_insert_marketing_leads/)
  })

  it.each(CAPABILITIES)('$id refuses to run as the wrong identity', (cap) => {
    expect(code(read(cap.forward))).toMatch(/rolsuper FROM pg_roles WHERE rolname = current_user/)
  })

  it.each(CAPABILITIES)('$id verifies its own policy count in a postcondition', (cap) => {
    const body = code(read(cap.forward))
    expect(body).toContain(cap.policyPrefix)
    // Every package counts policies in its postcondition. CAP-04 counts the
    // policies REMAINING on marketing_leads rather than its own single one,
    // because what it has to prove is that the two retired ones are gone.
    expect(body).toMatch(/v_policies <> \d+ THEN/)
  })

  it.each(CAPABILITIES)('$id creates exactly the policies it claims', (cap) => {
    const created = [...code(read(cap.forward)).matchAll(/CREATE POLICY\s+(\w+)/g)]
      .map((m) => m[1])
      .filter((n) => n.startsWith(cap.policyPrefix))
    expect(created.length).toBe(cap.policyCount)
  })

  it.each(CAPABILITIES)('$id declares the RESTRICTIVE policies its bounds depend on', (cap) => {
    // Permissive policies are combined with OR, and the 105 {public} baseline
    // policies apply to the capability definers too — their predicates call
    // auth.uid(), a SESSION GUC that SECURITY DEFINER does not reset, so inside
    // the definer they resolve to the CALLER, not to the empty set. Every "the
    // policy bounds this even if the body were rewritten" claim was false until
    // these landed: a RESTRICTIVE policy is ANDed and cannot be OR-ed away.
    const restrictive = [...code(read(cap.forward)).matchAll(/CREATE POLICY\s+(\w+)[\s\S]*?(?=;)/g)]
      .filter((m) => /AS RESTRICTIVE/i.test(m[0]))
      .map((m) => m[1])
    expect(restrictive.length, `${cap.id} restrictive policy count`).toBe(cap.restrictiveCount)
    for (const name of restrictive) {
      expect(code(read(cap.rollback)), `${cap.rollback} does not drop ${name}`).toMatch(
        new RegExp(`DROP POLICY IF EXISTS\\s+${name}\\b`),
      )
    }
  })

  it.each(CAPABILITIES)('$id rollback drops every policy the forward creates', (cap) => {
    const created = [...code(read(cap.forward)).matchAll(/CREATE POLICY\s+(\w+)/g)]
      .map((m) => m[1])
      .filter((n) => n.startsWith(cap.policyPrefix))
    const dropped = code(read(cap.rollback))
    for (const name of created) {
      expect(dropped, `${cap.rollback} does not drop ${name}`).toMatch(
        new RegExp(`DROP POLICY IF EXISTS\\s+${name}\\b`),
      )
    }
  })

  it.each(CAPABILITIES)('$id rollback drops every function and the definer role', (cap) => {
    const rb = code(read(cap.rollback))
    for (const fn of cap.functions) {
      expect(rb, `${cap.rollback} does not drop ${fn}`).toMatch(
        new RegExp(`DROP FUNCTION IF EXISTS uellix_capability\\.${fn}\\b`),
      )
    }
    expect(rb).toMatch(new RegExp(`DROP ROLE ${cap.definer}`))
  })

  it.each(CAPABILITIES)('$id rollback drops the shared schema only when it is empty', (cap) => {
    // The five packages are independent, so a rollback must not remove a schema
    // another capability still owns objects in.
    const rb = code(read(cap.rollback))
    expect(rb).toMatch(/NOT EXISTS \([\s\S]*?nspname = 'uellix_capability'[\s\S]*?\)/)
    expect(rb).toMatch(/DROP SCHEMA uellix_capability/)
  })

  it.each(CAPABILITIES)('$id rollback ends with a postcondition, not with hope', (cap) => {
    expect(code(read(cap.rollback))).toMatch(/RAISE NOTICE/)
    expect(code(read(cap.rollback))).toMatch(/RAISE EXCEPTION/)
  })
})

// ---------------------------------------------------------------------------
// 8. Nothing is enabled
// ---------------------------------------------------------------------------

describe('capability campaign — no capability is enabled by this design', () => {
  it('the Stripe route still refuses', () => {
    const route = readFileSync(
      path.join(process.cwd(), 'app', 'api', 'webhooks', 'stripe', 'route.ts'),
      'utf8',
    )
    expect(route).toMatch(/const WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false/)
  })

  it('the lead route still refuses', () => {
    const route = readFileSync(
      path.join(process.cwd(), 'app', 'api', 'marketing', 'lead', 'route.ts'),
      'utf8',
    )
    expect(route).toMatch(/const LEAD_CAPTURE_POLICY_AVAILABLE = false/)
  })

  it('only the declared administrative wrapper calls a capability function', () => {
    // Enabling a capability is a separate, reviewed act. If a NEW name appears
    // here, someone wired a surface without going through the rollout in its
    // capability document.
    //
    // The allowlist has exactly one entry, and it is not a relaxation: the two
    // administrative columns of `organizations` left the runtime UPDATE grant
    // in stella_0011, so `db.update(organizations).set({ stellaMonthlyQuota })`
    // is now refused by the ACL for every caller. RR-CAP-10-A recorded that as
    // "a code change must land before the package"; this module IS that change.
    // The two admin services reach the capability only through it.
    const ALLOWED = new Set([
      path.join('lib', 'admin', 'organization-administration.ts'),
      // These two import the wrapper and name the functions in their prose, so
      // they match the pattern without issuing a call. The assertion below
      // proves that: only the wrapper may contain `uellix_capability.` in CODE.
      path.join('lib', 'admin', 'organizations.ts'),
      path.join('lib', 'admin', 'stella-services.ts'),
      // The SECOND declared surface, added when the three dead
      // `db.update(organizations)` statements left the Stripe webhook.
      //
      // Neither of these issues a call: `contracts.ts` is types plus frozen
      // descriptors that NAME each package's functions, and `stripe-webhook.ts`
      // holds the same names as data so a signature drift in stella_0008 fails
      // a focused test rather than a live webhook. The statements themselves
      // live in db/capabilities/stripe-capability-executor.ts, on a connection
      // that authenticates as `uellix_stripe` — which is the point: `uellix_app`
      // has no EXECUTE on them, so the runtime client could not call them even
      // if one of these files tried.
      path.join('lib', 'capabilities', 'contracts.ts'),
      path.join('lib', 'capabilities', 'stripe-webhook.ts'),
      // THE WRAPPER ITSELF (adversarial finding A-F9). It is the one file that
      // may name these functions in code, and until now it was not merely
      // allowed — it was OUT OF SCAN. The loop below walked `lib` and `app`,
      // and all three literal `uellix_capability.stripe_*` invocations live in
      // `db/`, so a FOURTH invocation added anywhere under db/ would not have
      // broken the invariant this test's own comment declares.
      path.join('db', 'capabilities', 'stripe-capability-executor.ts'),
    ])

    // `db` is scanned, not assumed. The whole claim is "only the wrapper issues
    // these calls", and a scan that cannot see the directory the wrapper lives
    // in cannot make it.
    for (const dir of ['lib', 'app', 'db']) {
      const root = path.join(process.cwd(), dir)
      const hits = grepTree(root, /uellix_capability\./).filter((f) => !ALLOWED.has(f))
      expect(hits, `${dir}/ references uellix_capability outside the wrapper`).toEqual([])
    }

    // ...and the wrapper is the file that actually contains them, so the
    // allow-list entry above is not excusing an empty file. Without this, the
    // scan would still pass on the day the executor was emptied or renamed —
    // which is the same blind spot A-F9 named, one level in.
    const wrapper = readFileSync(
      path.join(process.cwd(), 'db', 'capabilities', 'stripe-capability-executor.ts'),
      'utf8',
    )
    expect([...wrapper.matchAll(/uellix_capability\.stripe_\w+/g)].map((m) => m[0]).sort()).toEqual([
      'uellix_capability.stripe_apply_subscription',
      'uellix_capability.stripe_begin_event',
      'uellix_capability.stripe_fail_event',
    ])

    // …and in the two services the reference must be PROSE, never a statement.
    // Stripping comments is the difference between "documents the boundary" and
    // "issues its own capability call behind the wrapper's back".
    for (const f of ['lib/admin/organizations.ts', 'lib/admin/stella-services.ts']) {
      const code = readFileSync(path.join(process.cwd(), f), 'utf8')
        .split(String.fromCharCode(10))
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
        .join(String.fromCharCode(10))
      expect(code, `${f} calls a capability function directly`).not.toMatch(/uellix_capability\./)
    }
  })
})

function grepTree(dir: string, pattern: RegExp): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === '.next') continue
      const full = path.join(d, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry) && pattern.test(readFileSync(full, 'utf8'))) {
        out.push(path.relative(process.cwd(), full))
      }
    }
  }
  walk(dir)
  return out
}

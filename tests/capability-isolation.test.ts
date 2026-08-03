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
    policyCount: 6,
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
    policyCount: 5,
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
    policyCount: 4,
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
    policyCount: 1,
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
    policyCount: 8,
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

  it.each(CAPABILITIES)('$id grants EXECUTE to exactly one role: $executor', (cap) => {
    const grants = [
      ...code(read(cap.forward)).matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION[\s\S]*?TO\s+(\w+)\s*;/gi),
    ].map((m) => m[1])
    expect(grants.length).toBe(cap.functions.length)
    expect(new Set(grants)).toEqual(new Set([cap.executor]))
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

  it.each(CAPABILITIES)('$id: the definer is held only by uellix_owner, INHERIT FALSE', (cap) => {
    const body = code(read(cap.forward))
    const grants = [...body.matchAll(new RegExp(`GRANT\\s+${cap.definer}\\s+TO\\s+(\\w+)([^;]*);`, 'gi'))]
    expect(grants.length).toBe(1)
    expect(grants[0][1]).toBe('uellix_owner')
    expect(grants[0][2]).toMatch(/INHERIT FALSE/i)
    expect(grants[0][2]).toMatch(/ADMIN FALSE/i)
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
          ['capability request denied', 'organization slug is already taken'],
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

  it('all four visibility flags default to false — publishing is opt-in', () => {
    for (const flag of ['show_organization_name', 'show_report_title', 'show_headline_ratio', 'show_totals']) {
      expect(body).toMatch(new RegExp(`${flag}\\s+boolean\\s+NOT NULL DEFAULT false`))
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

  it('slug uniqueness is atomic, not check-then-act', () => {
    expect(body).toMatch(/ON CONFLICT \(slug\) DO NOTHING/)
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

  it('no application module calls a capability function yet', () => {
    // Enabling a capability is a separate, reviewed act. If this ever fails,
    // someone wired a surface without going through the rollout in its
    // capability document.
    for (const dir of ['lib', 'app']) {
      const root = path.join(process.cwd(), dir)
      const hits = grepTree(root, /uellix_capability\./)
      expect(hits, `${dir}/ references uellix_capability`).toEqual([])
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

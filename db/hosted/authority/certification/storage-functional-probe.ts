// db/hosted/authority/certification/storage-functional-probe.ts
// M-2 — the probe that makes COMPLETE mean the Storage surface WORKS.
//
// ---------------------------------------------------------------------------
// THE BLIND SPOT THIS CLOSES
// ---------------------------------------------------------------------------
// Every certification before this one measured INSTALLATION. `stella_0019`
// (T11) was recorded INSTALLED because its witnesses said so: the function
// exists, its body names four roles, its owner is uellix_owner, its ACL did not
// move, the three storage policies are intact. All of that was true, and all of
// it was also true on a database where every single upload was refused.
//
// MEASURED on the managed shape after stella_hosted_0003 and 0004, 2026-08-15,
// with T11 installed and all eleven witnesses green:
//
//   super_admin organization_admin impact_manager analyst
//   reviewer viewer inactive no-membership cross-org
//     -> write DENY, read DENY.  All nine.
//
// The cause was one missing table privilege — `uellix_owner` could not SELECT
// public.organization_members, which both SECURITY DEFINER bodies join — and
// the bodies' own `EXCEPTION WHEN OTHERS THEN RETURN false` turned the
// permission error into a denial. A structural witness cannot see that, because
// nothing structural is wrong. Only calling the thing finds it.
//
// So COMPLETE is now a conjunction that includes this probe, and the packages
// grew guards (stella_0019 §0.7b/§0.7c) so the same gap refuses rather than
// installs. Both are needed: the guard stops it happening, the probe stops it
// happening SILENTLY if some future edit removes the guard.
//
// ---------------------------------------------------------------------------
// WHY IT DRIVES THE POLICY AND NOT THE FUNCTION
// ---------------------------------------------------------------------------
// The obvious probe is `SELECT public.can_write_evidence_object(path, uuid)`.
// It is worthless, and measuring it was how that was established.
//
// MEASURED, both directions: both tables have RLS ENABLED, both are owned by
// `postgres` on the managed shape, and `uellix_owner` holds no BYPASSRLS — so
// their SELECT policies are evaluated FOR THE DEFINER, and those policies read
// `organization_id = ANY (current_user_org_ids())`, which resolves `auth.uid()`,
// which is `request.jwt.claim.sub`. From an ordinary administrative psql session
// no claim is set, no row is visible, and the helper returns FALSE — on a
// perfectly healthy database.
//
//   claim unset -> can_read_evidence_object(...) = false
//   claim set   -> can_read_evidence_object(...) = true
//
// A probe calling the function bare would therefore report DENY-for-all on a
// database where every upload works, and could not be told apart from the real
// outage. The probe below becomes `authenticated`, sets a real claim, and lets
// the policy on storage.objects decide — which is the integration the product
// actually depends on.
//
// ---------------------------------------------------------------------------
// WHAT IS SHIMMED, AND WHAT IS NOT
// ---------------------------------------------------------------------------
// `storage.objects` is the four-column shim in lab-environment.ts, and
// `storage.foldername` is a `string_to_array` stand-in — both declared in
// LAB_SHIMS. Everything the probe actually tests is REAL: the three baseline
// policies verbatim from the baseline, the two SECURITY DEFINER helpers as the
// chain published them, the RLS on public.projects and public.organization_
// members, the privilege state the prechain units produced, and the role rows.
// The shim supplies a table to insert into and a path parser; it supplies none
// of the authorisation.

/* -------------------------------------------------------------------------- */
/* The fixture, as identifiers                                                 */
/* -------------------------------------------------------------------------- */

/** Recognisable in a failure message, and impossible to mistake for real data. */
const ORG_A = 'a0000000-0000-4000-8000-0000000000a1'
const ORG_B = 'b0000000-0000-4000-8000-0000000000b2'
/** The project every case probes unless it is the cross-org control. */
export const PROBE_PROJECT_A = 'c0000000-0000-4000-8000-0000000000c3'
const PROJECT_B = 'd0000000-0000-4000-8000-0000000000d4'

/** The object the READ half is measured against, planted before the matrix runs. */
const SEED_OBJECT = `${PROBE_PROJECT_A}/evidence/seed.txt`

export type Decision = 'ALLOW' | 'DENY'

export interface StorageFunctionalCase {
  /** Stable id; appears in the artefact and in any mismatch message. */
  readonly id: string
  readonly userId: string
  /** Which project's namespace this case writes into. */
  readonly project: string
  readonly expectedWrite: Decision
  readonly expectedRead: Decision
  /** The contract sentence this case exists to hold to. */
  readonly why: string
}

/**
 * The role matrix, as data.
 *
 * The fixture SQL, the probe SQL and the assertions are all GENERATED from this
 * array, so a case cannot be expected in one place and exercised in another.
 *
 * WRITE follows stella_0019's four-role contract — the roles at or above
 * `analyst` in lib/auth/roles.ts ROLE_HIERARCHY, the same four
 * db/migrations/0031_rls_core.sql names in evidence_items_insert.
 *
 * READ follows the baseline read helper, which stella_0019 deliberately does
 * NOT touch: any ACTIVE member of the owning organisation, whatever their role.
 * That asymmetry is the contract, so `reviewer` and `viewer` expecting
 * DENY-on-write and ALLOW-on-read is the point of including them rather than an
 * inconsistency.
 */
export const STORAGE_FUNCTIONAL_MATRIX: readonly StorageFunctionalCase[] = [
  {
    id: 'super_admin',
    userId: '11111111-0000-4000-8000-000000000001',
    project: PROBE_PROJECT_A,
    expectedWrite: 'ALLOW',
    expectedRead: 'ALLOW',
    why:
      'stella_0019 adds super_admin to the write list, and requires an ACTIVE membership row for ' +
      'it like every other role — the body calls no current_user_is_super_admin(), so a platform ' +
      'super admin with no membership is still refused (see the no_membership case).',
  },
  {
    id: 'organization_admin',
    userId: '22222222-0000-4000-8000-000000000002',
    project: PROBE_PROJECT_A,
    expectedWrite: 'ALLOW',
    expectedRead: 'ALLOW',
    why: 'In the baseline two-role list and in the corrected four-role one. Must never regress.',
  },
  {
    id: 'impact_manager',
    userId: '33333333-0000-4000-8000-000000000003',
    project: PROBE_PROJECT_A,
    expectedWrite: 'ALLOW',
    expectedRead: 'ALLOW',
    why:
      'THE DEFECT M-2 NAMES. The baseline body refused it the object while evidence_items_insert ' +
      'accepted its row, so the table said yes and the bucket said no. stella_0019 closes that.',
  },
  {
    id: 'analyst',
    userId: '44444444-0000-4000-8000-000000000004',
    project: PROBE_PROJECT_A,
    expectedWrite: 'ALLOW',
    expectedRead: 'ALLOW',
    why: 'In the baseline two-role list and in the corrected four-role one. Must never regress.',
  },
  {
    id: 'reviewer',
    userId: '55555555-0000-4000-8000-000000000005',
    project: PROBE_PROJECT_A,
    expectedWrite: 'DENY',
    expectedRead: 'ALLOW',
    why:
      'BELOW the upload threshold in lib/auth/permissions.ts, so write is refused — and stella_0019 ' +
      '§2 refuses to install a body that names it. Read is ALLOWED because the read helper admits ' +
      'any active member, which stella_0019 does not change.',
  },
  {
    id: 'viewer',
    userId: '66666666-0000-4000-8000-000000000006',
    project: PROBE_PROJECT_A,
    expectedWrite: 'DENY',
    expectedRead: 'ALLOW',
    why: 'The lowest role. Same asymmetry as reviewer, and the same reason.',
  },
  {
    id: 'inactive_membership',
    userId: '77777777-0000-4000-8000-000000000007',
    project: PROBE_PROJECT_A,
    expectedWrite: 'DENY',
    expectedRead: 'DENY',
    why:
      'An organization_admin row whose status is `inactive`. Both helpers require om.status = ' +
      "'active'; a removed member keeping write access is the failure stella_0019 §2 checks for by " +
      'asserting the status filter survived the republish.',
  },
  {
    id: 'no_membership',
    userId: '88888888-0000-4000-8000-000000000008',
    project: PROBE_PROJECT_A,
    expectedWrite: 'DENY',
    expectedRead: 'DENY',
    why: 'A real user row with no membership anywhere. The join produces nothing.',
  },
  {
    id: 'cross_org',
    userId: '99999999-0000-4000-8000-000000000009',
    project: PROBE_PROJECT_A,
    expectedWrite: 'DENY',
    expectedRead: 'DENY',
    why:
      'An ACTIVE organization_admin — of the OTHER organisation. The strongest negative in the set: ' +
      'a role the write list names, a status the filter accepts, and the wrong organisation.',
  },
  {
    id: 'cross_org_own_project',
    userId: '99999999-0000-4000-8000-000000000009',
    project: PROJECT_B,
    expectedWrite: 'ALLOW',
    expectedRead: 'DENY',
    why:
      'THE CONTROL FOR THE LINE ABOVE, and the reason the pair is worth more than either half. The ' +
      'same user, the same session shape, their OWN project: write ALLOWED. Without it, `cross_org ' +
      'DENY` is equally consistent with a broken user, a broken fixture or a dead surface — which ' +
      'is exactly how a total outage passed for a working isolation boundary. Read is DENY only ' +
      'because the seeded object lives under project A; this case reads nothing of its own.',
  },
]

/* -------------------------------------------------------------------------- */
/* The SQL                                                                     */
/* -------------------------------------------------------------------------- */

/** Distinct rows only — `cross_org` and `cross_org_own_project` share a user. */
const DISTINCT_USERS: readonly StorageFunctionalCase[] = STORAGE_FUNCTIONAL_MATRIX.filter(
  (c, i, all) => all.findIndex((o) => o.userId === c.userId) === i,
)

/**
 * The membership each fixture user gets.
 *
 * Keyed by case id rather than derived from it, because two of them are
 * deliberately NOT what their name suggests: `inactive_membership` holds an
 * organization_admin role, and `no_membership` holds no row at all.
 */
const MEMBERSHIP: Readonly<Record<string, { org: string; role: string; status: string } | null>> = {
  super_admin: { org: ORG_A, role: 'super_admin', status: 'active' },
  organization_admin: { org: ORG_A, role: 'organization_admin', status: 'active' },
  impact_manager: { org: ORG_A, role: 'impact_manager', status: 'active' },
  analyst: { org: ORG_A, role: 'analyst', status: 'active' },
  reviewer: { org: ORG_A, role: 'reviewer', status: 'active' },
  viewer: { org: ORG_A, role: 'viewer', status: 'active' },
  inactive_membership: { org: ORG_A, role: 'organization_admin', status: 'inactive' },
  no_membership: null,
  cross_org: { org: ORG_B, role: 'organization_admin', status: 'active' },
  cross_org_own_project: null, // same user as cross_org; its row is written once, above.
}

/**
 * The fixture and the two probe functions, APPLIED (not read).
 *
 * Split from the matrix query below because both harnesses read results through
 * probes that require exactly one line of output — `queryDocument` in
 * remediation-certify.ts refuses anything else by design — and a script that
 * mixes DDL, DML and a projection is one psql setting away from returning two.
 * Applying and reading are different operations here, so they are different
 * strings.
 *
 * Applied by the administrative identity because it writes baseline rows that
 * RLS would otherwise hide from the writer.
 *
 * The two probe functions are SECURITY INVOKER on purpose. A definer here would
 * evaluate the policy with the harness's privileges and would answer ALLOW for
 * everything, which is the one result this probe must never be able to produce
 * by construction.
 */
export const STORAGE_FUNCTIONAL_FIXTURE_SQL = `
SET search_path = public;

INSERT INTO public.organizations (id, name, slug) VALUES
  ('${ORG_A}', 'Uellix probe org A', 'uellix-probe-org-a'),
  ('${ORG_B}', 'Uellix probe org B', 'uellix-probe-org-b')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email) VALUES
${DISTINCT_USERS.map((c) => `  ('${c.userId}', '${c.id}@uellix-probe.invalid')`).join(',\n')}
ON CONFLICT DO NOTHING;

INSERT INTO public.projects (id, organization_id, name, created_by) VALUES
  ('${PROBE_PROJECT_A}', '${ORG_A}', 'Uellix probe project A', '22222222-0000-4000-8000-000000000002'),
  ('${PROJECT_B}', '${ORG_B}', 'Uellix probe project B', '99999999-0000-4000-8000-000000000009')
ON CONFLICT DO NOTHING;

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
${STORAGE_FUNCTIONAL_MATRIX.filter((c) => MEMBERSHIP[c.id] !== null)
  .map((c) => {
    const m = MEMBERSHIP[c.id]!
    return `  ('${m.org}', '${c.userId}', '${m.role}', '${m.status}')`
  })
  .join(',\n')}
ON CONFLICT DO NOTHING;

-- The object the READ half is measured against. Planted as the administrative
-- identity, which owns storage.objects and is therefore not filtered by the
-- policy under test.
INSERT INTO storage.objects (bucket_id, name, owner)
VALUES ('uellix-evidence', '${SEED_OBJECT}', '22222222-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;

-- SECURITY INVOKER. It BECOMES \`authenticated\`, sets a real claim, and lets the
-- policy answer. The insert that succeeds is a real row through insert_evidence.
CREATE OR REPLACE FUNCTION public.uellix_probe_storage_write(p_sub uuid, p_path text)
RETURNS text LANGUAGE plpgsql AS $probe$
DECLARE v text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', p_sub::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO storage.objects (bucket_id, name, owner)
    VALUES ('uellix-evidence', p_path, p_sub);
    v := 'ALLOW';
  EXCEPTION WHEN OTHERS THEN
    v := 'DENY';
  END;
  RESET ROLE;
  RETURN v;
END $probe$;

CREATE OR REPLACE FUNCTION public.uellix_probe_storage_read(p_sub uuid, p_path text)
RETURNS text LANGUAGE plpgsql AS $probe$
DECLARE v text; n int;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', p_sub::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO n FROM storage.objects
     WHERE bucket_id = 'uellix-evidence' AND name = p_path;
    v := CASE WHEN n > 0 THEN 'ALLOW' ELSE 'DENY' END;
  EXCEPTION WHEN OTHERS THEN
    v := 'DENY';
  END;
  RESET ROLE;
  RETURN v;
END $probe$;
`

/**
 * The matrix itself: ONE row, ONE column, ONE JSON document.
 *
 * Shaped that way so the harness parses a result rather than scraping a log,
 * and so `queryDocument`'s "exactly one line" guard is a real check on this
 * probe rather than an obstacle to it.
 */
export const STORAGE_FUNCTIONAL_MATRIX_SQL = `
SELECT json_object_agg(c.id, json_build_object(
  'write', public.uellix_probe_storage_write(c.sub, c.project || '/evidence/' || c.id || '.txt'),
  'read',  public.uellix_probe_storage_read(c.sub, '${SEED_OBJECT}')
))::text
FROM (VALUES
${STORAGE_FUNCTIONAL_MATRIX.map(
  (c) => `  ('${c.id}', '${c.userId}'::uuid, '${c.project}')`,
).join(',\n')}
) AS c(id, sub, project);
`

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

export interface StorageFunctionalObservation {
  readonly [caseId: string]: { readonly write?: string; readonly read?: string }
}

export interface StorageFunctionalMismatch {
  readonly caseId: string
  readonly operation: 'write' | 'read'
  readonly expected: Decision
  readonly observed: string
  readonly why: string
}

export interface StorageFunctionalResult {
  readonly ran: boolean
  readonly passed: boolean
  readonly cases: number
  readonly mismatches: readonly StorageFunctionalMismatch[]
  readonly observation: StorageFunctionalObservation | null
  readonly detail: string
  /** Kept beside the result so the artefact says what the probe is worth. */
  readonly shimNote: string
}

const SHIM_NOTE =
  'storage.objects is the four-column shim and storage.foldername is a string_to_array stand-in ' +
  '(both declared in LAB_SHIMS). The three storage policies, both SECURITY DEFINER helpers, the ' +
  'RLS on public.projects and public.organization_members, and every privilege the prechain units ' +
  'produced are REAL. The shim supplies a table and a path parser and no authorisation.'

/** The probe did not run at all. Never a pass — an absence is not evidence. */
export function storageFunctionalNotRun(reason: string): StorageFunctionalResult {
  return {
    ran: false,
    passed: false,
    cases: STORAGE_FUNCTIONAL_MATRIX.length,
    mismatches: [],
    observation: null,
    detail: `NOT RUN: ${reason}. An unrun probe is recorded as a failure, because a certification ` +
      'that could pass by skipping its own functional evidence is the defect this closes, moved.',
    shimNote: SHIM_NOTE,
  }
}

/**
 * Compare an observation against the declared matrix.
 *
 * A MISSING case fails exactly as a wrong one does. Without that, deleting a
 * row from the matrix — or from the SQL that renders it — would be a way to
 * pass, and the negative controls are the rows somebody would be tempted to
 * delete.
 */
export function evaluateStorageFunctionalProbe(
  observation: StorageFunctionalObservation,
): StorageFunctionalResult {
  const mismatches: StorageFunctionalMismatch[] = []

  for (const c of STORAGE_FUNCTIONAL_MATRIX) {
    const observed = observation[c.id]
    for (const op of ['write', 'read'] as const) {
      const expected = op === 'write' ? c.expectedWrite : c.expectedRead
      const actual = observed?.[op]
      if (actual !== expected) {
        mismatches.push({
          caseId: c.id,
          operation: op,
          expected,
          observed: actual ?? 'NOT_OBSERVED',
          why: c.why,
        })
      }
    }
  }

  const passed = mismatches.length === 0
  return {
    ran: true,
    passed,
    cases: STORAGE_FUNCTIONAL_MATRIX.length,
    mismatches,
    observation,
    detail: passed
      ? `${STORAGE_FUNCTIONAL_MATRIX.length}/${STORAGE_FUNCTIONAL_MATRIX.length} cases matched the ` +
        'declared matrix, driven through the storage.objects policies as `authenticated` with real ' +
        'request.jwt.claim.sub claims'
      : `${mismatches.length} mismatch(es): ` +
        mismatches
          .map((m) => `${m.caseId}.${m.operation} expected ${m.expected}, observed ${m.observed}`)
          .join('; '),
    shimNote: SHIM_NOTE,
  }
}

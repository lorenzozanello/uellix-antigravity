// tests/golden/fixtures/pilot-fixture.ts
//
// THE COMMERCIAL PILOT FIXTURE — DEFINITIONS ONLY, DELIBERATELY INERT.
//
// ===========================================================================
// WHAT THIS IS AND, MORE IMPORTANTLY, WHAT IT IS NOT
// ===========================================================================
// This module DEFINES the pilot shape the Golden Journeys expect to traverse:
// one organisation, three projects at different completion states, several
// roles, representative evidence and results, an exception case, enough
// variation for the portfolio surface to be more than a single row, and
// placeholders for the evaluation leg.
//
// It WRITES NOTHING. There is no database client here, no seeding function, no
// migration and no environment read. It is a set of frozen constants.
//
// That is a deliberate boundary, not an unfinished one. The write-set this
// lane is authorised for excludes `db/**`, and a fixture that provisioned
// itself would have to reach a database — which at this base means either a
// canonical environment (forbidden) or an invented local one (out of scope and
// certain to drift from the real schema). Materialising the fixture belongs to
// the lane that also owns the target, because a fixture and the schema it is
// inserted into have to be certified together or not at all.
//
// So this file is the CONTRACT for that future materialisation: the journeys
// reference these identifiers, and whoever provisions the pilot must produce
// exactly these rows. Writing the contract first is what stops the fixture
// from being reverse-engineered later out of whatever a passing test happened
// to need.
//
// ===========================================================================
// WHY EVERY IDENTIFIER CARRIES THE SAME PREFIX
// ===========================================================================
// `golden-pilot-` prefixes every id, name and address. A single greppable
// namespace means a row belonging to this fixture can be recognised in any
// environment it reaches by inspection alone, with no lookup table. If one of
// these strings is ever found in a canonical environment, that is immediately
// legible as an incident rather than as an ambiguous unfamiliar row.
//
// The e-mail addresses use `@golden-pilot.invalid`. `.invalid` is reserved by
// RFC 2606 and can never resolve, so a fixture address cannot accidentally
// become a real mailbox that a misconfigured run sends to.

/** The single namespace every fixture identifier carries. */
export const PILOT_NAMESPACE = 'golden-pilot'

/** Reserved, non-resolvable mail domain. See RFC 2606. */
export const PILOT_MAIL_DOMAIN = 'golden-pilot.invalid'

/**
 * Completion states the three projects occupy.
 *
 * Three distinct states, not three copies of one: a portfolio that renders
 * three identical rows cannot demonstrate that it renders state at all, and
 * the frozen J1 path ends in "review and approval", which only means something
 * if some project has not reached it.
 */
export type PilotCompletionState = 'COMPLETE_LOCKED' | 'IN_PROGRESS' | 'INCOMPLETE_EXCEPTION'

export type PilotRole =
  | 'organization_admin'
  | 'impact_manager'
  | 'analyst'
  | 'reviewer'
  | 'viewer'

export interface PilotMember {
  readonly handle: string
  readonly email: string
  readonly role: PilotRole
}

export interface PilotEvidence {
  readonly id: string
  readonly title: string
  /** Whether this item is expected to reach an indexed state. */
  readonly indexed: boolean
  /** Present only on the exception case, naming why it cannot index. */
  readonly exception?: string
}

export interface PilotResult {
  readonly runId: string
  /**
   * `null` models a locked run with no defensible monetisation.
   *
   * Not an oversight and not a placeholder for a number nobody chose. The
   * public verification page has an explicit branch for it
   * (`data-testid="verify-no-ratio"`) precisely because a null ratio must
   * never render as `null:1` or `0:1`. A fixture without this case would let a
   * journey pass while the only interesting branch on that page went
   * untraversed.
   */
  readonly sroiRatio: string | null
  readonly currency: 'USD'
  readonly totalInvestment: string
  readonly netSocialValue: string
}

export interface PilotProject {
  readonly id: string
  readonly name: string
  readonly completionState: PilotCompletionState
  readonly evidence: readonly PilotEvidence[]
  readonly result: PilotResult | null
  /** Set only where a locked report exists, which is the only case J3 can resolve. */
  readonly verificationLocator: string | null
  /** Whether the project is expected to appear on the portfolio surface. */
  readonly portfolioVisible: boolean
}

export interface PilotOrganization {
  readonly id: string
  readonly name: string
  readonly members: readonly PilotMember[]
  readonly projects: readonly PilotProject[]
}

/**
 * The organisation. One, not several.
 *
 * J1's cross-tenant negative control needs a SECOND tenant to be refused from,
 * and it is declared separately below rather than as a second full
 * organisation — the control only needs a principal that does not belong here,
 * and giving it a complete project tree would invite a journey to traverse it
 * as if it were part of the pilot.
 */
export const PILOT_ORGANIZATION: PilotOrganization = {
  id: `${PILOT_NAMESPACE}-org-01`,
  name: 'Golden Pilot Impact Foundation',
  members: [
    { handle: `${PILOT_NAMESPACE}-admin`, email: `admin@${PILOT_MAIL_DOMAIN}`, role: 'organization_admin' },
    { handle: `${PILOT_NAMESPACE}-manager`, email: `manager@${PILOT_MAIL_DOMAIN}`, role: 'impact_manager' },
    { handle: `${PILOT_NAMESPACE}-analyst`, email: `analyst@${PILOT_MAIL_DOMAIN}`, role: 'analyst' },
    { handle: `${PILOT_NAMESPACE}-reviewer`, email: `reviewer@${PILOT_MAIL_DOMAIN}`, role: 'reviewer' },
    { handle: `${PILOT_NAMESPACE}-viewer`, email: `viewer@${PILOT_MAIL_DOMAIN}`, role: 'viewer' },
  ],
  projects: [
    {
      id: `${PILOT_NAMESPACE}-project-complete`,
      name: 'Rural Water Access — closed cycle',
      completionState: 'COMPLETE_LOCKED',
      evidence: [
        { id: `${PILOT_NAMESPACE}-ev-complete-01`, title: 'Baseline household survey', indexed: true },
        { id: `${PILOT_NAMESPACE}-ev-complete-02`, title: 'Endline household survey', indexed: true },
      ],
      result: {
        runId: `${PILOT_NAMESPACE}-run-complete`,
        sroiRatio: '3.40',
        currency: 'USD',
        totalInvestment: '250000.00',
        netSocialValue: '850000.00',
      },
      // The ONLY locator in the fixture. J3 resolves this one; everything else
      // is a negative case by construction rather than by configuration.
      verificationLocator: `${PILOT_NAMESPACE}-locator-complete`,
      portfolioVisible: true,
    },
    {
      id: `${PILOT_NAMESPACE}-project-in-progress`,
      name: 'Youth Employment — mid cycle',
      completionState: 'IN_PROGRESS',
      evidence: [
        { id: `${PILOT_NAMESPACE}-ev-progress-01`, title: 'Programme intake register', indexed: true },
        { id: `${PILOT_NAMESPACE}-ev-progress-02`, title: 'Partial attendance log', indexed: false },
      ],
      result: null,
      verificationLocator: null,
      portfolioVisible: true,
    },
    {
      // The exception case. Carries a locked run whose ratio is null, which is
      // the branch the verification page renders specially.
      id: `${PILOT_NAMESPACE}-project-exception`,
      name: 'Community Health — no defensible monetisation',
      completionState: 'INCOMPLETE_EXCEPTION',
      evidence: [
        {
          id: `${PILOT_NAMESPACE}-ev-exception-01`,
          title: 'Qualitative testimony bundle',
          indexed: false,
          exception: 'no proxy in the registry monetises this outcome defensibly',
        },
      ],
      result: {
        runId: `${PILOT_NAMESPACE}-run-exception`,
        sroiRatio: null,
        currency: 'USD',
        totalInvestment: '90000.00',
        netSocialValue: '0.00',
      },
      verificationLocator: null,
      portfolioVisible: true,
    },
  ],
}

/**
 * A principal belonging to no pilot organisation.
 *
 * J1's frozen negative control intent is that "a principal from another tenant
 * must be refused at each tenant-scoped step". This is that principal.
 */
export const PILOT_FOREIGN_PRINCIPAL = {
  handle: `${PILOT_NAMESPACE}-foreign`,
  email: `foreign@${PILOT_MAIL_DOMAIN}`,
  organizationId: `${PILOT_NAMESPACE}-org-foreign`,
} as const

/**
 * A locator guaranteed not to resolve.
 *
 * Used by J3's negative control. Held as a constant rather than generated per
 * run so a failure names a stable value: a random locator would make two
 * failing runs look like two different defects.
 */
export const PILOT_UNKNOWN_LOCATOR = `${PILOT_NAMESPACE}-locator-does-not-exist`

/**
 * The evaluation leg's placeholder.
 *
 * The frozen authority records that the evaluation surface has no runtime.
 * This constant exists so the evaluation step has something to NAME while it
 * is blocked, and so the conversion to a positive assertion has a defined
 * subject. It is explicitly not a stand-in implementation.
 */
export const PILOT_EVALUATE_PLACEHOLDER = {
  subjectProjectId: `${PILOT_NAMESPACE}-project-complete`,
  contract: 'EVALUATE_RUNTIME_ABSENT_AT_THIS_BASE',
} as const

/** Every identifier the fixture introduces, for namespace assertions. */
export function allPilotIdentifiers(): readonly string[] {
  const ids: string[] = [PILOT_ORGANIZATION.id, PILOT_UNKNOWN_LOCATOR, PILOT_FOREIGN_PRINCIPAL.organizationId]
  for (const member of PILOT_ORGANIZATION.members) ids.push(member.handle, member.email)
  ids.push(PILOT_FOREIGN_PRINCIPAL.handle, PILOT_FOREIGN_PRINCIPAL.email)
  for (const project of PILOT_ORGANIZATION.projects) {
    ids.push(project.id)
    if (project.verificationLocator !== null) ids.push(project.verificationLocator)
    if (project.result !== null) ids.push(project.result.runId)
    for (const evidence of project.evidence) ids.push(evidence.id)
  }
  return ids
}

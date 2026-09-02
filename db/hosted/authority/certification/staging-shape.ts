// db/hosted/authority/certification/staging-shape.ts
// COMMIT 5.3 — the EXACT shape of the measured staging project, reproduced
// locally, and the pin that makes "exact" a checkable claim.
//
// ---------------------------------------------------------------------------
// WHY THE CURRENT BOOTSTRAP CANNOT PRODUCE THE STAGING SHAPE
// ---------------------------------------------------------------------------
// `pnpm certify:pg176` provisions with `db/prepared/hosted/*.hosted.sql` as they
// are TODAY, and that bootstrap already carries §5d (E-01) and §5e (E-04),
// added by Commit 5.1. A container provisioned from it reaches the prechain
// authority state directly — which is the right thing to certify for a FRESH
// project and is exactly the wrong thing to certify the remediation against:
//
//   * `stella_hosted_0002` §0 (S6) refuses when
//     `assert_capability_membership_topology` already exists, because that is
//     its own witness. Provisioned from today's bootstrap, the remediation is
//     refused before it does anything — correctly, and uselessly.
//   * a witness taken on that container reports INSTALLED before the package
//     has run, so "ABSENT → apply → INSTALLED" would be unmeasurable.
//
// The staging project was bootstrapped BEFORE Commit 5.1. The shape this module
// reproduces is therefore the bootstrap as it existed then — not a
// reconstruction, not today's file with sections deleted, but the exact bytes.
//
// ---------------------------------------------------------------------------
// WHY A GIT BLOB IS THE PIN AND NOT A COPY IN THE TREE
// ---------------------------------------------------------------------------
// The alternative was to check a second 49 KB bootstrap into the repository as
// a fixture. Rejected on two grounds:
//
//   * a file under db/ that looks like a bootstrap and is not the bootstrap is
//     a file someone eventually applies. The staging shape is a HISTORICAL
//     artefact and belongs in history.
//   * a copy is a second spelling. It would silently stop being "what staging
//     got" the moment anyone touched it, and the digest would move with it.
//
// A git blob is content-addressed: `79205b75…` IS the pin, and `git cat-file`
// either returns exactly those bytes or fails. The SHA-256 below is checked on
// top of it so that a reader who does not think in git object ids still has
// something to compare, and so that a corrupted object store is caught rather
// than applied.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

/**
 * The commit that last touched the bootstrap before Commit 5.1 reconciled it.
 *
 * Recorded for a human reading a refusal; the resolution goes through the BLOB
 * id, which cannot drift if this branch is rewritten.
 */
export const STAGING_SHAPE_SOURCE_COMMIT = '4ee87cb'

/**
 * The bootstrap staging was actually provisioned with.
 *
 * git blob id — SHA-1 over the object's own bytes, so this identifier and the
 * content are the same fact. `db/prepared/…sql` and `db/prepared/hosted/…hosted.sql`
 * were byte-identical at that commit and therefore share one blob.
 */
export const STAGING_SHAPE_BOOTSTRAP_BLOB = '79205b75b41eefe38221f4c4d02d5bbc60ce9bd2'

/** SHA-256 of the LF-normalized bytes, in the spelling every other pin uses. */
export const STAGING_SHAPE_BOOTSTRAP_SHA256 =
  '2b2df1abf1ba19411ba55b6a3a4a62653bfe784bc79977d3f24e6a6dc531d602'

/** Repo-relative path the blob was at, for the report and for a human. */
export const STAGING_SHAPE_BOOTSTRAP_PATH =
  'db/prepared/hosted/stella_hosted_0001_managed_role_bootstrap.hosted.sql'

/**
 * What the pre-Commit-5.1 bootstrap does NOT establish, and therefore what the
 * remediation is measured on.
 *
 * Stated as data rather than prose so the harness can print it beside the first
 * observation: a reviewer who sees `ABSENT` should be able to see, in the same
 * breath, which facts are absent and why they were expected to be.
 */
export const STAGING_SHAPE_OPEN_DEFECTS: readonly { readonly id: string; readonly fact: string }[] = [
  { id: 'E-02', fact: 'uellix_migrator is NOCREATEROLE and holds no CREATE on the database' },
  { id: 'E-01', fact: 'uellix_owner holds none of the eight prechain object privileges' },
  { id: 'E-04', fact: 'uellix_bootstrap.assert_capability_membership_topology does not exist' },
  { id: 'E-03', fact: 'assert_hosted_capabilities carries the original body, not the certified one' },
]

export class StagingShapeRefusal extends Error {
  readonly code: string
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.code = code
    this.name = 'StagingShapeRefusal'
  }
}

export interface ResolvedStagingShapeBootstrap {
  readonly blob: string
  readonly path: string
  readonly sourceCommit: string
  readonly sha256: string
  /** LF-normalized. See `normalizeForApply`. */
  readonly sql: string
}

/**
 * LF, always, before anything is sent to a server.
 *
 * `core.autocrlf=true` is set in this checkout. PostgreSQL stores a function
 * body exactly as it receives it, so a CRLF apply produces a `prosrc` that
 * hashes differently from the same body applied on Linux — and the remediation
 * witness identifies the certified body BY that hash. Normalizing on the way in
 * makes the measurement a statement about the SQL rather than about the machine
 * that ran it.
 */
export function normalizeForApply(sql: string): string {
  return sql.replace(/\r\n?/g, '\n')
}

/**
 * The historical bootstrap, from the object store, verified twice.
 *
 * Reads through `git cat-file`, which resolves by content hash: there is no
 * path to mistype and no working-tree state that can change the answer. A
 * shallow clone without history fails here rather than silently provisioning
 * the CURRENT bootstrap and certifying the remediation against a project that
 * does not need it.
 */
export function resolveStagingShapeBootstrap(root: string): ResolvedStagingShapeBootstrap {
  let raw: string
  try {
    raw = execFileSync('git', ['cat-file', 'blob', STAGING_SHAPE_BOOTSTRAP_BLOB], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    throw new StagingShapeRefusal(
      'STAGING_SHAPE_BLOB_UNREACHABLE',
      `git object ${STAGING_SHAPE_BOOTSTRAP_BLOB} could not be read from ${root} ` +
        `(${error instanceof Error ? error.message.split('\n')[0] : String(error)}). That blob is the ` +
        `bootstrap the staging project was provisioned with (${STAGING_SHAPE_BOOTSTRAP_PATH} at ` +
        `${STAGING_SHAPE_SOURCE_COMMIT}). Without it this harness would have to provision from the ` +
        `CURRENT bootstrap, which already carries §5d and §5e — and would then certify the ` +
        `remediation against a database that does not need remediating. A shallow clone is the ` +
        `usual cause; fetch the full history rather than substituting a file.`,
    )
  }

  const sql = normalizeForApply(raw)
  const sha256 = createHash('sha256').update(sql, 'utf8').digest('hex')
  if (sha256 !== STAGING_SHAPE_BOOTSTRAP_SHA256) {
    throw new StagingShapeRefusal(
      'STAGING_SHAPE_DIGEST_MISMATCH',
      `blob ${STAGING_SHAPE_BOOTSTRAP_BLOB} hashes to ${sha256}, and the pin is ` +
        `${STAGING_SHAPE_BOOTSTRAP_SHA256}. A git blob cannot change content and keep its id, so ` +
        `this means the object store returned something else — the pin is doing exactly the job it ` +
        `exists for and nothing should be applied.`,
    )
  }

  return {
    blob: STAGING_SHAPE_BOOTSTRAP_BLOB,
    path: STAGING_SHAPE_BOOTSTRAP_PATH,
    sourceCommit: STAGING_SHAPE_SOURCE_COMMIT,
    sha256,
    sql,
  }
}

/**
 * A guard the harness calls before it provisions: the historical bootstrap must
 * NOT already contain what the remediation delivers.
 *
 * Cheap, and it catches the one mistake that would invalidate every downstream
 * result while looking like a pass — pointing the staging shape at a bootstrap
 * that already reconciled, so `ABSENT` was never measurable.
 */
export function assertStagingShapeIsUnremediated(sql: string): void {
  const forbidden: readonly [string, string][] = [
    [
      'assert_capability_membership_topology',
      'E-04 — this is the remediation\'s own witness. A bootstrap that installs it makes §0 (S6) ' +
        'refuse the package and makes the ABSENT→INSTALLED transition unmeasurable.',
    ],
    [
      'ALTER ROLE uellix_migrator WITH CREATEROLE',
      'E-02 — the installer attribute the remediation exists to set.',
    ],
    [
      'GRANT SELECT, REFERENCES ON TABLE public.organizations TO uellix_owner',
      'E-01 — a prechain object privilege the remediation grants.',
    ],
  ]
  const problems = forbidden
    .filter(([needle]) => sql.includes(needle))
    .map(([needle, why]) => `${needle} — ${why}`)

  if (problems.length > 0) {
    throw new StagingShapeRefusal(
      'STAGING_SHAPE_ALREADY_REMEDIATED',
      `the bootstrap resolved for the staging shape already establishes: ${problems.join(' | ')}. ` +
        `This harness would then be certifying the remediation against a project that does not ` +
        `need it, and would report PASS for a sequence nobody will run.`,
    )
  }
}

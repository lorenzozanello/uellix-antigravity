// db/hosted/baseline-journal-wrapper.ts
// TRAIN 5C2 — RR-25, IMPLEMENTED. The bytes that make the journal real.
//
// ---------------------------------------------------------------------------
// WHAT THE PREVIOUS TRAIN LEFT UNDONE, STATED PLAINLY
// ---------------------------------------------------------------------------
// `baseline-journal.ts` designed a ledger and exported `journalInsertSql()`.
// Nothing called it. No artefact contained the INSERT it describes. So
// `baselineUnitsInstalled` would still have come from a list somebody typed, and
// the gate said so and refused — correctly. A descriptor is not an
// implementation, and this file is the implementation.
//
// ---------------------------------------------------------------------------
// THE DESIGN CONSTRAINT THAT DECIDES EVERYTHING BELOW
// ---------------------------------------------------------------------------
// The journal row and the unit's effects must commit ATOMICALLY. Not "the row is
// written promptly after"; that is two transactions with a crash window between
// them, and a crash in that window leaves a unit applied and unrecorded — which
// is the exact state the ledger exists to make impossible to reach silently.
//
// psql gives one mechanism for this: `-1` wraps everything the invocation
// executes in ONE transaction. So the INSERT has to be inside that invocation.
//
// ---------------------------------------------------------------------------
// AND WHY A WRAPPER, NOT A COPY
// ---------------------------------------------------------------------------
// The obvious way to get the INSERT into the invocation is to generate fifty
// derived files, each the unit's SQL plus the append. That is fifty copies of
// the entire baseline corpus checked in beside the corpus — a second full set of
// bytes that can drift from the first, which is the failure this repository
// spends its `hosted:verify` and `storage:verify` budget preventing.
//
// So each wrapper INCLUDES its unit instead of copying it:
//
//     \ir ../../../supabase/migrations/0031_rls_core.sql
//     INSERT INTO uellix_provisioning.applied_units (...) VALUES (...);
//
// `\ir` is resolved by psql relative to the wrapper's own directory and splices
// the file into the same session, so `-1` covers both. The canonical SQL stays
// the only copy of itself. The wrapper is ~20 lines, deterministic, hash-pinned,
// and a reviewer can read the whole thing.
//
// ---------------------------------------------------------------------------
// THE HONEST LIMITS, BECAUSE THEY ARE NOT ZERO
// ---------------------------------------------------------------------------
//   1. `project_ref` is supplied by the operator (`-v uellix_project_ref=…`).
//      Nothing server-side on Supabase reports the project ref, so it cannot be
//      derived in-band. Three things constrain it instead: a CHECK on the shape,
//      a CHECK that REFUSES the known production ref (so a mis-typed target
//      rolls the unit back rather than recording it), and after the fact
//      `reconcileJournal` compares it with `projectRefFromHost(connectionHost)`.
//      It is constrained and cross-checked, not trusted.
//
//   2. A wrapper cannot record FAILED. A failed unit rolls back, and a row
//      written inside the rolled-back transaction goes with it. That is the
//      correct trade: the ledger never claims an apply that did not happen, and
//      the absence of a row is what a failure looks like. `FAILED` remains in
//      the status domain for the ONE writer that runs outside a unit's
//      transaction — the human-boundary reconciler of unit 41's PART B.
//
//   3. PART B of unit 41 is never journalled by its channel. It is applied
//      through a surface that cannot join a psql transaction, so its state is
//      RECONSTRUCTED from `pg_policies`. A fact read from the catalogue cannot
//      disagree with the catalogue.

import { BASELINE_UNITS, type BaselineUnit } from './baseline-manifest'
import { stripSqlLiteralsAndBodies } from './baseline-scanner'
import { JOURNAL_SCHEMA, JOURNAL_TABLE } from './baseline-journal'
import { sha256OfSql } from './hosted-package-manifest'
import { PSQL_ARTEFACT, STORAGE_UNIT_SOURCE, buildStorageArtefacts } from './storage-policy-artifact'
import { KNOWN_PRODUCTION_IDENTIFIERS } from './target-identity'

/** Where the wrappers are written. Checked in so a reviewer reads bytes, not intent. */
export const JOURNAL_WRAPPER_DIR = 'db/prepared/journal'

/** psql variable the operator must supply. Absent ⇒ the wrapper refuses. */
export const PROJECT_REF_VAR = 'uellix_project_ref'

/** Unit ZERO: creates the ledger before unit 1 can write to it. */
export const JOURNAL_BOOTSTRAP_FILE = `${JOURNAL_WRAPPER_DIR}/000_journal_bootstrap.sql`

export const STORAGE_UNIT_ID = '20260716000001_storage_policies.sql'

/** Deterministic wrapper path for a unit. Ordinal-prefixed so `ls` is the order. */
export function wrapperPathFor(unit: Pick<BaselineUnit, 'ordinal' | 'id'>): string {
  return `${JOURNAL_WRAPPER_DIR}/${String(unit.ordinal).padStart(3, '0')}_${unit.id}`
}

/** `db/prepared/journal/x.sql` → `../../../` gets back to the repository root. */
const TO_ROOT = '../../../'

const sqlLiteral = (v: string | null | undefined): string =>
  v === null || v === undefined ? 'NULL' : `'${v.replace(/'/g, "''")}'`

/* -------------------------------------------------------------------------- */
/* Unit ZERO                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The ledger's own DDL, with the two CHECKs that make a wrong target fail
 * CLOSED rather than get recorded.
 *
 * `applied_units_not_production_check` is the one worth pausing on. It is not
 * decoration: because the INSERT lives inside the unit's transaction, a row
 * naming the production project raises, and the raise rolls back the UNIT. The
 * database refuses to apply a baseline unit that would be recorded against
 * production. That is a stronger guarantee than any check in this repository can
 * make from outside the connection.
 */
export function journalBootstrapArtefact(
  productionRefs: readonly string[] = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs,
): string {
  // AN EMPTY VETO IS NOT A PERMISSIVE VETO — IT IS INVALID DDL.
  //
  // Adversarial review executed `journalBootstrapArtefact([])` and got
  // `CHECK (project_ref NOT IN ())`, a PostgreSQL syntax error: unit ZERO would
  // fail to apply rather than degrade safely. That is arguably fail-closed by
  // accident, but "the production veto turns into a parse error" is not a
  // property anyone should have to discover at apply time. It refuses here,
  // where the message can say why.
  if (productionRefs.length === 0) {
    throw new Error(
      'JOURNAL_BOOTSTRAP_REFUSED: the production project-ref denylist is empty, so the ledger would ' +
        'carry no veto against recording a unit as applied to production. Load ' +
        'KNOWN_PRODUCTION_IDENTIFIERS.projectRefs first.',
    )
  }
  const denylist = productionRefs.map((r) => sqlLiteral(r)).join(', ')
  return `-- ============================================================================
-- GENERATED — DO NOT EDIT. Unit ZERO of PHASE_BASELINE.
-- Regenerate with \`pnpm journal:generate\`; \`pnpm journal:verify\` compares bytes.
-- ============================================================================
--
-- Runs BEFORE unit 1, because a unit cannot record itself in a table that does
-- not exist. This is the ONLY uellix_* schema PHASE_BASELINE creates.
--
--   psql -1 -v ON_ERROR_STOP=1 -v ${PROJECT_REF_VAR}=<staging-ref> -f ${JOURNAL_BOOTSTRAP_FILE}
--
-- ============================================================================
\\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS ${JOURNAL_SCHEMA};

CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
  id                      bigserial   PRIMARY KEY,
  environment             text        NOT NULL,
  project_ref             text        NOT NULL,
  package_id              text        NOT NULL,
  phase                   text        NOT NULL,
  source_sha256           text        NOT NULL,
  derived_sha256          text,
  security_surface_digest text,
  status                  text        NOT NULL,
  applied_at              timestamptz NOT NULL DEFAULT now(),
  apply_current_user      text        NOT NULL DEFAULT current_user,
  apply_session_user      text        NOT NULL DEFAULT session_user,
  CONSTRAINT applied_units_status_check CHECK (
    status IN ('APPLIED', 'FAILED', 'MANUAL_BOUNDARY_PENDING', 'MANUAL_BOUNDARY_VERIFIED')
  ),
  CONSTRAINT applied_units_env_check         CHECK (environment = 'staging'),
  CONSTRAINT applied_units_project_ref_check CHECK (project_ref ~ '^[a-z]{20}$'),
  CONSTRAINT applied_units_sha_check         CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  -- THE VETO. A row naming production raises inside the unit's transaction, so
  -- the unit rolls back. Applying to the wrong project stops being a thing that
  -- gets noticed afterwards.
  CONSTRAINT applied_units_not_production_check CHECK (project_ref NOT IN (${denylist}))
);

-- One APPLIED row per unit per project. 28 of the 40 Drizzle units cannot
-- survive a second application, so the database refuses to RECORD one rather
-- than leaving two contradictory rows for a reader to arbitrate.
CREATE UNIQUE INDEX IF NOT EXISTS applied_units_one_applied_per_package
  ON ${JOURNAL_TABLE} (project_ref, package_id)
  WHERE status = 'APPLIED';

-- The boundary ledger for unit 41 PART B is a SEPARATE row shape: at most one
-- open boundary per project, so a second PENDING cannot hide an unfinished one.
CREATE UNIQUE INDEX IF NOT EXISTS applied_units_one_open_boundary
  ON ${JOURNAL_TABLE} (project_ref, package_id)
  WHERE status = 'MANUAL_BOUNDARY_PENDING';
`
}

/* -------------------------------------------------------------------------- */
/* The per-unit wrappers                                                      */
/* -------------------------------------------------------------------------- */

export interface WrapperInputs {
  readonly unit: BaselineUnit
  /** Repo-relative path the wrapper `\ir`-includes. */
  readonly includes: string
  /** Hash of the INCLUDED file when it differs from the canonical unit. */
  readonly derivedSha256: string | null
  readonly securitySurfaceDigest: string | null
  /** Set for unit 41: says in the artefact itself that this is half a unit. */
  readonly partialNote: string | null
}

/**
 * One wrapper. Pure function of its inputs — same bytes every time, which is
 * what lets `journal:verify` regenerate and compare.
 */
export function buildJournalWrapper(input: WrapperInputs): string {
  const { unit } = input
  const partial = input.partialNote
    ? ['--', ...input.partialNote.split('\n').map((l) => `-- ${l}`)]
    : []

  return [
    '-- ============================================================================',
    `-- GENERATED — DO NOT EDIT. Unit ${unit.ordinal}/${BASELINE_UNITS.length}: ${unit.id}`,
    '-- ============================================================================',
    '--',
    `-- Includes:      ${input.includes}`,
    `-- Source SHA256: ${unit.sha256}`,
    ...(input.derivedSha256 ? [`-- Derived SHA256: ${input.derivedSha256}`] : []),
    '--',
    '-- This wrapper exists so the journal row and the unit COMMIT TOGETHER. psql',
    '-- -1 wraps the whole invocation in one transaction and \\ir splices the unit',
    '-- into it, so a crash at any point leaves BOTH or NEITHER. The unit is not',
    '-- copied here — it is included, so this file cannot drift from it.',
    ...partial,
    '--',
    `--   psql -1 -v ON_ERROR_STOP=1 -v ${PROJECT_REF_VAR}=<staging-ref> \\`,
    `--        -f ${wrapperPathFor(unit)}`,
    '--',
    '-- ============================================================================',
    '\\set ON_ERROR_STOP on',
    '',
    '-- THE REFUSAL IS A SERVER-SIDE ERROR, NOT \\quit.',
    '--',
    "-- The first version ended the refusal branch with `\\quit 1`. Reviewer B read",
    '-- exec_command_quit() in psql\'s command.c and found it takes NO ARGUMENT: the',
    '-- 1 is not an exit code, and psql terminates with status 0. Any orchestration',
    '-- checking $? would have read a refused unit as a successful one — the ledger',
    '-- would be honest and the shell around it would not.',
    '--',
    '-- RAISE inside the branch produces a real error, so ON_ERROR_STOP exits 3 and',
    '-- the transaction rolls back. It changes nothing: the include is in the OTHER',
    '-- branch and never runs.',
    `\\if :{?${PROJECT_REF_VAR}}`,
    '',
    '-- SHAPE GUARD, BEFORE ANY UNIT SQL RUNS.',
    '--',
    "-- `\\if :{?var}` tests whether the variable is DEFINED, not whether it holds",
    '-- anything. `-v ref=\"$UNSET_SHELL_VAR\"` defines it as the EMPTY STRING, so',
    '-- the refusal branch below never fires and what actually stopped the unit was',
    "-- the ledger's CHECK constraint — a third line of defence doing a first line's",
    '-- job. Independent audit found it. The CHECK stays; this refuses earlier and',
    '-- says why, and it catches empty, whitespace and malformed alike.',
    `SET LOCAL uellix.project_ref = :'${PROJECT_REF_VAR}';`,
    'DO $guard$',
    'BEGIN',
    "  IF coalesce(current_setting('uellix.project_ref', true), '') !~ '^[a-z]{20}$' THEN",
    `    RAISE EXCEPTION 'REFUSED: ${PROJECT_REF_VAR} is absent, empty, whitespace or not a 20-lowercase-letter Supabase project ref. Nothing was applied.';`,
    '  END IF;',
    'END $guard$;',
    '',
    `\\ir ${TO_ROOT}${input.includes}`,
    '',
    '-- The journal row. INSIDE this transaction, by construction.',
    `INSERT INTO ${JOURNAL_TABLE}`,
    '  (environment, project_ref, package_id, phase,',
    '   source_sha256, derived_sha256, security_surface_digest, status)',
    'VALUES',
    `  ('staging', :'${PROJECT_REF_VAR}', ${sqlLiteral(unit.id)}, 'PHASE_BASELINE',`,
    `   ${sqlLiteral(unit.sha256)}, ${sqlLiteral(input.derivedSha256)}, ${sqlLiteral(input.securitySurfaceDigest)}, 'APPLIED');`,
    '',
    '\\else',
    `\\echo 'REFUSED: -v ${PROJECT_REF_VAR}=<ref> was not supplied.'`,
    "\\echo 'The journal cannot record which project this unit was applied to,'",
    "\\echo 'and an unattributed row is a row that could describe any database.'",
    'DO $refused$ BEGIN',
    `  RAISE EXCEPTION 'REFUSED: ${PROJECT_REF_VAR} was not supplied; nothing was applied.';`,
    'END $refused$;',
    '\\endif',
    '',
  ].join('\n')
}

/* -------------------------------------------------------------------------- */
/* Generation over the whole corpus                                           */
/* -------------------------------------------------------------------------- */

export type WrapperRefusal = {
  readonly unit: string
  readonly kind:
    | 'WRAPPER_UNIT_UNREADABLE'
    | 'WRAPPER_UNIT_SHA_MISMATCH'
    | 'WRAPPER_UNIT_HAS_TRANSACTION_CONTROL'
    | 'WRAPPER_UNIT_HAS_META_COMMAND'
  readonly detail: string
}

export interface GeneratedWrappers {
  /** Repo-relative path → exact bytes. Includes unit ZERO. */
  readonly files: Readonly<Record<string, string>>
  /** Ordered apply commands, unit ZERO first. */
  readonly commands: readonly string[]
  readonly refusals: readonly WrapperRefusal[]
}

/**
 * `BEGIN` / `COMMIT` inside an included unit would end the transaction `-1`
 * opened, and everything after it — including the journal INSERT — would commit
 * separately. The atomicity claim would become false while every file still
 * looked right. Measured across all fifty units today: zero occurrences. This
 * refuses if that ever changes.
 *
 * TESTED AGAINST CODE, NOT TEXT. The first version anchored on `^` over the raw
 * file and refused three units on `END;` — the token that closes a PL/pgSQL
 * block. At top level `END;` really is COMMIT; inside `$$…$$` it is the end of a
 * function body and means nothing about transactions. The guard runs after
 * `stripSqlLiteralsAndBodies`, so the two cannot be confused; and the anchor
 * moved from line-start to statement-start because stripping a body collapses
 * the lines it spanned.
 */
const TRANSACTION_CONTROL = /(?:^|;)\s*(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION)\s*;/i

/**
 * A `\` meta-command in an INCLUDED file is executed by psql, not the server,
 * and is outside anything the transaction can undo. None of the fifty has one.
 */
const META_COMMAND = /^[ \t]*\\[a-z]/im

export function buildAllJournalWrappers(
  readSql: (file: string) => string | null,
  units: readonly BaselineUnit[] = BASELINE_UNITS,
): GeneratedWrappers {
  const files: Record<string, string> = {
    [JOURNAL_BOOTSTRAP_FILE]: journalBootstrapArtefact(),
  }
  const commands: string[] = [applyCommandFor(JOURNAL_BOOTSTRAP_FILE)]
  const refusals: WrapperRefusal[] = []

  // Unit 41 includes its PART A artefact, not the canonical file. The canonical
  // file carries PART B, which the measured identity cannot apply — including it
  // here would put the blocked statements back into the psql channel through the
  // very mechanism built to keep them out.
  let partA: { sha256: string; digest: string } | null = null
  const storageSource = readSql(STORAGE_UNIT_SOURCE)
  if (storageSource !== null) {
    const artefacts = buildStorageArtefacts(storageSource)
    // PART A's OWN digest, not PART B's. The row describes the half that ran.
    partA = { sha256: artefacts.psqlSha256, digest: artefacts.psqlSecuritySurfaceDigest }
  }

  for (const unit of units) {
    const isStorage = unit.id === STORAGE_UNIT_ID
    const includes = isStorage ? PSQL_ARTEFACT : unit.file

    const body = readSql(includes)
    if (body === null) {
      refusals.push({
        unit: unit.id,
        kind: 'WRAPPER_UNIT_UNREADABLE',
        detail: `${includes} could not be read, so no wrapper can pin what it includes.`,
      })
      continue
    }
    // EVERY INCLUDED FILE IS HASH-CHECKED AGAINST WHAT THE ROW WILL RECORD.
    //
    // The first version wrote `!isStorage && …`, exempting the ONE unit whose
    // `\ir` target is a generated artefact rather than the hash-pinned canonical
    // file. Adversarial review broke it by appending
    // `GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;` to the checked-in PART
    // A: generation refused nothing, and the wrapper recorded the hash derived
    // from the untouched canonical source — a hash that did not describe the
    // bytes psql would apply. `journal:verify` could not see it either, because
    // the wrapper references PART A by PATH and its own bytes were unchanged.
    // And the storage unit creates no tables, so `reconcileJournal`'s catalogue
    // cross-check skips it and the false attestation survives reconciliation.
    //
    // The exemption was the whole hole. The storage unit is now checked against
    // the DERIVED hash — the same value the row records — so the ledger cannot
    // describe bytes other than the ones applied.
    const expectedSha = isStorage ? partA?.sha256 : unit.sha256
    if (expectedSha === undefined) {
      refusals.push({
        unit: unit.id,
        kind: 'WRAPPER_UNIT_UNREADABLE',
        detail:
          `${STORAGE_UNIT_SOURCE} could not be read, so the PART A artefact has no derived hash to ` +
          `check ${includes} against. An unpinned include is an include nobody verified.`,
      })
      continue
    }
    if (sha256OfSql(body) !== expectedSha) {
      refusals.push({
        unit: unit.id,
        kind: 'WRAPPER_UNIT_SHA_MISMATCH',
        detail:
          `${includes} hashes to ${sha256OfSql(body).slice(0, 12)}…, expected ` +
          `${expectedSha.slice(0, 12)}…${isStorage ? ' (derived from the canonical unit 41)' : ' (manifest pin)'}. ` +
          `A wrapper recording one hash while including different bytes would put a TRUE-looking lie ` +
          `in the ledger.`,
      })
      continue
    }
    const code = stripSqlLiteralsAndBodies(body)
    if (TRANSACTION_CONTROL.test(code)) {
      refusals.push({
        unit: unit.id,
        kind: 'WRAPPER_UNIT_HAS_TRANSACTION_CONTROL',
        detail:
          `${includes} contains explicit transaction control, which would close the transaction ` +
          `psql -1 opened. The journal INSERT would then commit separately and the atomicity this ` +
          `whole mechanism exists for would be gone while the files still looked correct.`,
      })
      continue
    }
    if (META_COMMAND.test(body)) {
      refusals.push({
        unit: unit.id,
        kind: 'WRAPPER_UNIT_HAS_META_COMMAND',
        detail: `${includes} contains a psql meta-command, which executes outside the transaction.`,
      })
      continue
    }

    const path = wrapperPathFor(unit)
    files[path] = buildJournalWrapper({
      unit,
      includes,
      derivedSha256: isStorage ? (partA?.sha256 ?? null) : null,
      securitySurfaceDigest: isStorage ? (partA?.digest ?? null) : null,
      partialNote: isStorage
        ? 'PART A ONLY. The three policies on storage.objects (PART B) are NOT in the\n' +
          'included artefact and are NOT recorded by this row. An APPLIED row here means\n' +
          'the two public helpers exist — nothing more. Unit 41 reaches UNIT_41_COMPLETE\n' +
          'only when pg_policies independently shows PART B, never when this row exists.'
        : null,
    })
    commands.push(applyCommandFor(path))
  }

  return { files, commands, refusals }
}

export function applyCommandFor(wrapperPath: string): string {
  return `psql -1 -v ON_ERROR_STOP=1 -v ${PROJECT_REF_VAR}="$UELLIX_STAGING_REF" -f ${wrapperPath}`
}

/**
 * The check the gate runs: do the bytes on disk actually carry the append?
 *
 * Deliberately not "does a wrapper exist" — a wrapper that includes its unit and
 * forgets the INSERT applies the unit and records nothing, which is precisely
 * the RR-25 state wearing an implementation's clothes.
 */
export function wrapperCarriesJournalAppend(content: string | null): boolean {
  if (content === null) return false
  return (
    new RegExp(`INSERT\\s+INTO\\s+${JOURNAL_TABLE.replace('.', '\\.')}`, 'i').test(content) &&
    /\\ir\s+\S+/.test(content) &&
    content.includes(`:'${PROJECT_REF_VAR}'`)
  )
}

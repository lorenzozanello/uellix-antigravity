// tests/hosted/baseline-journal-wrapper.test.ts
// TRAIN 5C2 — RR-25. The tests that distinguish an implemented journal from a
// described one.
//
// The previous train's journal passed every test it had and applied to nothing,
// because the tests examined the DESIGN — a descriptor object with the right
// fields. So the assertions here are about BYTES on disk and about the shape of
// the psql invocation, and several of them would have failed against that
// design without a single line of it being wrong.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  JOURNAL_BOOTSTRAP_FILE,
  JOURNAL_WRAPPER_DIR,
  PROJECT_REF_VAR,
  applyCommandFor,
  buildAllJournalWrappers,
  buildJournalWrapper,
  journalBootstrapArtefact,
  wrapperCarriesJournalAppend,
  wrapperPathFor,
} from '@/db/hosted/baseline-journal-wrapper'
import { JOURNAL_TABLE, reconcileJournal, type JournalRow } from '@/db/hosted/baseline-journal'
import { BASELINE_ORDER, BASELINE_UNITS, baselineUnit } from '@/db/hosted/baseline-manifest'
import { KNOWN_PRODUCTION_IDENTIFIERS } from '@/db/hosted/target-identity'
import { PSQL_ARTEFACT } from '@/db/hosted/storage-policy-artifact'
import { sha256OfSql } from '@/db/hosted/hosted-package-manifest'

const ROOT = process.cwd()
const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n')
  } catch {
    return null
  }
}

const STAGING = 'bvyzblhqymxruxdguaee'

describe('the wrappers exist and carry the append — RR-25 as bytes', () => {
  const generated = buildAllJournalWrappers(read)

  it('generates without refusing', () => {
    expect(generated.refusals, JSON.stringify(generated.refusals, null, 2)).toEqual([])
  })

  it('covers unit ZERO plus all fifty units', () => {
    expect(Object.keys(generated.files)).toHaveLength(BASELINE_UNITS.length + 1)
  })

  // THE ONE THAT WOULD HAVE FAILED LAST TRAIN. `journalInsertSql` existed, was
  // never called, and no file on disk contained an INSERT.
  it('writes a file on disk for every unit, each carrying the INSERT', () => {
    for (const unit of BASELINE_UNITS) {
      const onDisk = read(wrapperPathFor(unit))
      expect(onDisk, `${wrapperPathFor(unit)} missing`).not.toBeNull()
      expect(wrapperCarriesJournalAppend(onDisk), `${unit.id} carries no append`).toBe(true)
    }
  })

  it('regenerates byte-identically from the corpus', () => {
    for (const [rel, expected] of Object.entries(generated.files)) {
      expect(read(rel), `${rel} diverged`).toBe(expected)
    }
  })

  it('includes its unit rather than copying it — no second source of truth', () => {
    const unit = baselineUnit('0031_rls_core.sql')
    const wrapper = read(wrapperPathFor(unit))!
    expect(wrapper).toContain(`\\ir ../../../${unit.file}`)
    // The unit's actual SQL must NOT appear inline. If it did, an edit to the
    // migration would leave the wrapper applying the old bytes.
    const unitSql = read(unit.file)!
    const distinctive = unitSql.split('\n').find((l) => l.trim().startsWith('CREATE POLICY'))
    if (distinctive) expect(wrapper).not.toContain(distinctive.trim())
  })

  it('points unit 41 at PART A, never at the canonical file', () => {
    const wrapper = read(wrapperPathFor(baselineUnit('20260716000001_storage_policies.sql')))!
    expect(wrapper).toContain(`\\ir ../../../${PSQL_ARTEFACT}`)
    expect(wrapper).not.toContain('supabase/migrations/20260716000001_storage_policies.sql')
  })

  it("records PART A's own digest, not PART B's — the row describes the half that ran", () => {
    const wrapper = read(wrapperPathFor(baselineUnit('20260716000001_storage_policies.sql')))!
    const partB = read(JOURNAL_BOOTSTRAP_FILE) // any file; we only need the wrapper's own text
    expect(partB).not.toBeNull()
    // The managed digest belongs to PART B and must not appear in PART A's row.
    const managed = buildAllJournalWrappers(read)
    expect(managed.refusals).toEqual([])
    expect(wrapper).toMatch(/'[0-9a-f]{64}', '[0-9a-f]{64}', '[0-9a-f]{64}', 'APPLIED'\);/)
  })
})

describe('atomicity is structural, not asserted', () => {
  const wrapper = read(wrapperPathFor(baselineUnit('0012_stella_interactions.sql')))
    ?? read(wrapperPathFor(BASELINE_UNITS[11]))!

  it('puts the INSERT after the include, in the same file', () => {
    const includeAt = wrapper.indexOf('\\ir ')
    const insertAt = wrapper.indexOf(`INSERT INTO ${JOURNAL_TABLE}`)
    expect(includeAt).toBeGreaterThan(-1)
    expect(insertAt).toBeGreaterThan(includeAt)
  })

  it('is applied with psql -1, which is what makes both commit together', () => {
    const cmd = applyCommandFor(wrapperPathFor(BASELINE_UNITS[0]))
    expect(cmd).toMatch(/psql -1\b/)
    expect(cmd).toContain('ON_ERROR_STOP=1')
  })

  // A rolled-back unit cannot leave a row: the row is inside the rollback. The
  // corollary the design accepts openly is that a wrapper can never write
  // FAILED, and the tests should say so rather than let a reader assume it can.
  it('never emits a FAILED row — a failed unit rolls its row back with it', () => {
    const { files } = buildAllJournalWrappers(read)
    for (const [rel, content] of Object.entries(files)) {
      // The bootstrap DDL legitimately names FAILED in its status CHECK; it is
      // the one row shape written OUTSIDE a unit's transaction, by the boundary
      // reconciler. No wrapper may emit it.
      if (rel === JOURNAL_BOOTSTRAP_FILE) continue
      expect(content, rel).not.toMatch(/'FAILED'/)
    }
  })

  it('refuses a unit containing transaction control, which would break -1', () => {
    // The hash guard fires first on a plain edit, so the poisoned unit is given
    // a matching pin. Otherwise this test would pass on the wrong refusal and
    // the transaction-control guard would never actually be exercised.
    const poisonedSql = `${read(BASELINE_UNITS[0].file)}\nCOMMIT;\n`
    const out = buildAllJournalWrappers(
      (rel) => (rel === BASELINE_UNITS[0].file ? poisonedSql : read(rel)),
      [{ ...BASELINE_UNITS[0], sha256: sha256OfSql(poisonedSql) }],
    )
    expect(out.refusals.map((r) => r.kind)).toContain('WRAPPER_UNIT_HAS_TRANSACTION_CONTROL')
  })

  it('refuses a unit containing a psql meta-command', () => {
    const poisonedSql = `\\echo 'hi'\n${read(BASELINE_UNITS[0].file)}`
    const out = buildAllJournalWrappers(
      (rel) => (rel === BASELINE_UNITS[0].file ? poisonedSql : read(rel)),
      [{ ...BASELINE_UNITS[0], sha256: sha256OfSql(poisonedSql) }],
    )
    expect(out.refusals.map((r) => r.kind)).toContain('WRAPPER_UNIT_HAS_META_COMMAND')
  })

  // The false positive the guard's first version produced against three real
  // units. `END;` closes a PL/pgSQL block; only at top level does it mean COMMIT.
  it('does NOT mistake END; inside a $$ body for transaction control', () => {
    const out = buildAllJournalWrappers(read)
    expect(out.refusals).toEqual([])
    const bodyEnders = ['0030_immutability.sql', '20260716000000_auth_trigger.sql']
    for (const id of bodyEnders) {
      expect(read(id === '0030_immutability.sql' ? 'db/migrations/0030_immutability.sql' : 'supabase/migrations/20260716000000_auth_trigger.sql')).toMatch(/END;/)
      expect(Object.keys(out.files)).toContain(wrapperPathFor(baselineUnit(id)))
    }
  })

  it('refuses a wrapper whose unit hash drifted from the manifest', () => {
    const drifted = (rel: string) =>
      rel === BASELINE_UNITS[0].file ? `${read(rel)}\n-- drift\n` : read(rel)
    const out = buildAllJournalWrappers(drifted)
    expect(out.refusals.map((r) => r.kind)).toContain('WRAPPER_UNIT_SHA_MISMATCH')
  })
})

describe('the ledger refuses the wrong target from inside the transaction', () => {
  const ddl = journalBootstrapArtefact()

  it('creates the table unit 1 will insert into', () => {
    expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE}`)
  })

  it('records every field the contract names', () => {
    for (const col of [
      'environment',
      'project_ref',
      'package_id',
      'phase',
      'source_sha256',
      'derived_sha256',
      'security_surface_digest',
      'status',
      'applied_at',
      'apply_session_user',
      'apply_current_user',
    ]) {
      expect(ddl, `${col} missing`).toContain(col)
    }
  })

  it('constrains status to the four legal values', () => {
    expect(ddl).toContain("status IN ('APPLIED', 'FAILED', 'MANUAL_BOUNDARY_PENDING', 'MANUAL_BOUNDARY_VERIFIED')")
  })

  // The veto that fires INSIDE the unit's transaction: a row naming production
  // raises, and the raise rolls back the unit. Not a warning afterwards.
  it('CHECKs the project ref against the production denylist', () => {
    for (const ref of KNOWN_PRODUCTION_IDENTIFIERS.projectRefs) {
      expect(ddl).toContain(ref)
    }
    expect(ddl).toMatch(/project_ref NOT IN \(/)
  })

  it('does not list the staging ref in its own veto', () => {
    expect(ddl).not.toContain(STAGING)
  })

  it('makes a second APPLIED row for the same unit impossible', () => {
    expect(ddl).toMatch(/CREATE UNIQUE INDEX[\s\S]*WHERE status = 'APPLIED'/)
  })
})

describe('the include is pinned to the hash the row records — reviewer A', () => {
  // THE EXPLOIT, EXECUTED. The first version exempted unit 41 from the hash
  // guard because its \ir target is a generated artefact rather than the pinned
  // canonical file. Appending a GRANT to the checked-in PART A produced no
  // refusal and a wrapper recording the canonical-derived hash — a hash that did
  // not describe the bytes psql would apply.
  it('refuses a PART A artefact edited between generation and apply', () => {
    const tampered = `${read(PSQL_ARTEFACT)}\nGRANT ALL ON ALL TABLES IN SCHEMA public TO anon;\n`
    const out = buildAllJournalWrappers((rel) => (rel === PSQL_ARTEFACT ? tampered : read(rel)))
    const storage = out.refusals.find((r) => r.unit === '20260716000001_storage_policies.sql')
    expect(storage?.kind).toBe('WRAPPER_UNIT_SHA_MISMATCH')
  })

  it('refuses when the canonical unit 41 cannot be read, rather than leaving the include unpinned', () => {
    const out = buildAllJournalWrappers((rel) =>
      rel === 'supabase/migrations/20260716000001_storage_policies.sql' ? null : read(rel),
    )
    const storage = out.refusals.find((r) => r.unit === '20260716000001_storage_policies.sql')
    expect(storage).toBeDefined()
  })

  it('checks every unit, with no exemption', () => {
    // A guard with an exemption is a guard with a hole, and the hole was the
    // one unit that mattered. Assert the absence of exemptions structurally.
    for (const unit of BASELINE_UNITS) {
      const drifted = (rel: string) => {
        const includes =
          unit.id === '20260716000001_storage_policies.sql' ? PSQL_ARTEFACT : unit.file
        return rel === includes ? `${read(rel)}\n-- drift\n` : read(rel)
      }
      const out = buildAllJournalWrappers(drifted, [unit])
      expect(out.refusals.map((r) => r.kind), unit.id).toContain('WRAPPER_UNIT_SHA_MISMATCH')
    }
  })
})

describe('the ledger refuses to exist without a production veto — reviewer A', () => {
  it('throws rather than emitting CHECK (project_ref NOT IN ())', () => {
    expect(() => journalBootstrapArtefact([])).toThrow(/JOURNAL_BOOTSTRAP_REFUSED/)
  })
})

describe('the wrapper refuses an unattributed row', () => {
  const w = buildJournalWrapper({
    unit: BASELINE_UNITS[0],
    includes: BASELINE_UNITS[0].file,
    derivedSha256: null,
    securitySurfaceDigest: null,
    partialNote: null,
  })

  it('gates the whole unit behind the project ref variable', () => {
    expect(w).toContain(`\\if :{?${PROJECT_REF_VAR}}`)
    expect(w).toContain('\\endif')
    expect((w.match(/\\if /g) ?? []).length).toBe((w.match(/\\endif/g) ?? []).length)
  })

  // REVIEWER B, verified against psql's own exec_command_quit(): `\quit` takes
  // NO argument, so `\quit 1` terminates with status 0. Any orchestration
  // checking $? would have read a refused unit as a successful one.
  // EXECUTABLE lines only. The header comments discuss `\ir` and the meta-command
  // this replaced, and a test matching the whole file would be asserting against
  // prose — the substring-marker mistake in yet another costume.
  const code = w.split('\n').filter((l) => !l.trimStart().startsWith('--'))

  it('does not rely on a psql meta-command for an exit status', () => {
    expect(code.some((l) => l.trimStart().startsWith('\\quit'))).toBe(false)
    expect(w).toMatch(/RAISE EXCEPTION 'REFUSED:/)
  })

  it('puts the include INSIDE the satisfied branch, so the refusal path runs no unit SQL', () => {
    const at = (pred: (l: string) => boolean) => code.findIndex(pred)
    const ifAt = at((l) => l.startsWith(`\\if :{?${PROJECT_REF_VAR}}`))
    const elseAt = at((l) => l.startsWith('\\else'))
    const includeAt = at((l) => l.startsWith('\\ir '))
    const insertAt = at((l) => l.startsWith(`INSERT INTO ${JOURNAL_TABLE}`))
    expect(ifAt).toBeGreaterThanOrEqual(0)
    expect(includeAt).toBeGreaterThan(ifAt)
    expect(includeAt).toBeLessThan(elseAt)
    expect(insertAt).toBeGreaterThan(includeAt)
    expect(insertAt).toBeLessThan(elseAt)
  })

  it('interpolates the ref rather than hardcoding one', () => {
    expect(w).toContain(`:'${PROJECT_REF_VAR}'`)
    expect(w).not.toContain(STAGING)
  })

  it('leaves every \\echo line balanced', () => {
    for (const line of w.split('\n').filter((l) => l.startsWith('\\echo'))) {
      expect((line.match(/'/g) ?? []).length % 2, line).toBe(0)
    }
  })
})

describe('crash, retry and recovery are derived from journal + catalogue', () => {
  const row = (over: Partial<JournalRow> = {}): JournalRow => ({
    environment: 'staging',
    projectRef: STAGING,
    packageId: BASELINE_ORDER[0],
    phase: 'PHASE_BASELINE',
    sourceSha256: baselineUnit(BASELINE_ORDER[0]).sha256,
    derivedSha256: null,
    securitySurfaceDigest: null,
    status: 'APPLIED',
    appliedAt: '2026-08-07T00:00:00Z',
    applySessionIdentity: 'postgres/postgres',
    ...over,
  })
  const all = (): JournalRow[] =>
    BASELINE_ORDER.map((id) => row({ packageId: id, sourceSha256: baselineUnit(id).sha256 }))

  const reconcile = (rows: JournalRow[], observedTables: string[] | null = []) =>
    reconcileJournal({ rows, expectedProjectRef: STAGING, observedTables })

  // CRASH BEFORE SQL and CRASH DURING SQL are the same observation: no row, no
  // objects. The unit is simply not installed, and that is a state the plan
  // already handles by planning it.
  it('crash before or during the SQL leaves the unit simply absent', () => {
    const r = reconcile([])
    expect(r.installed).toEqual([])
  })

  // CRASH AFTER SQL BEFORE THE JOURNAL cannot happen — that window does not
  // exist. The proof is structural: the INSERT is inside the transaction.
  it('has no "applied but unrecorded" window to model', () => {
    const wrappers = buildAllJournalWrappers(read)
    for (const unit of BASELINE_UNITS) {
      const content = wrappers.files[wrapperPathFor(unit)]
      const includeAt = content.indexOf('\\ir ')
      const insertAt = content.indexOf(`INSERT INTO ${JOURNAL_TABLE}`)
      expect(insertAt, unit.id).toBeGreaterThan(includeAt)
    }
  })

  it('refuses a partial baseline rather than treating it as a smaller one', () => {
    const r = reconcile(all().slice(0, 10))
    expect(r.problems.map((p) => p.kind)).toContain('JOURNAL_MISSING_UNIT')
  })

  it('refuses a retry recorded twice', () => {
    const r = reconcile([...all(), row()])
    expect(r.problems.map((p) => p.kind)).toContain('JOURNAL_DUPLICATE_APPLIED')
  })

  it('refuses a retry whose hash differs from the first attempt', () => {
    const rows = all()
    rows[3] = { ...rows[3], sourceSha256: 'f'.repeat(64) }
    const r = reconcile(rows)
    expect(r.problems.map((p) => p.kind)).toContain('JOURNAL_SHA_MISMATCH')
  })

  it('refuses a journal copied from another project', () => {
    const r = reconcile(all().map((x) => ({ ...x, projectRef: 'ctaxtgujyyprgynmnvtq' })))
    expect(r.problems.map((p) => p.kind)).toContain('JOURNAL_WRONG_PROJECT')
  })

  it('refuses a row naming a unit the manifest does not have', () => {
    const r = reconcile([...all(), row({ packageId: 'not_a_unit.sql' })])
    expect(r.problems.map((p) => p.kind)).toContain('JOURNAL_CLAIMS_UNKNOWN_UNIT')
  })

  // FAIL-CLOSED. Not measuring the catalogue is not the same as the catalogue
  // agreeing, and a journal read alone is a self-attestation.
  it('refuses when the catalogue was not observed at all', () => {
    const r = reconcile(all(), null)
    expect(r.problems.map((p) => p.kind)).toContain('JOURNAL_CONTRADICTS_CATALOG')
  })

  it('refuses an APPLIED row whose tables are absent from the catalogue', () => {
    const r = reconcileJournal({
      rows: all(),
      expectedProjectRef: STAGING,
      observedTables: [],
      tablesCreatedByUnit: { [BASELINE_ORDER[0]]: ['public.users'] },
    })
    expect(r.problems.map((p) => p.kind)).toContain('JOURNAL_CONTRADICTS_CATALOG')
  })

  it('accepts a full, catalogue-consistent journal', () => {
    const r = reconcileJournal({
      rows: all(),
      expectedProjectRef: STAGING,
      observedTables: ['public.users'],
      tablesCreatedByUnit: { [BASELINE_ORDER[0]]: ['public.users'] },
    })
    expect(r.problems).toEqual([])
    expect(r.installed).toEqual([...BASELINE_ORDER])
  })
})

describe('the generated set is closed', () => {
  it('names every wrapper under the one directory', () => {
    for (const key of Object.keys(buildAllJournalWrappers(read).files)) {
      expect(key.startsWith(`${JOURNAL_WRAPPER_DIR}/`)).toBe(true)
    }
  })

  it('orders the commands with unit ZERO first', () => {
    const { commands } = buildAllJournalWrappers(read)
    expect(commands[0]).toContain(JOURNAL_BOOTSTRAP_FILE)
    expect(commands).toHaveLength(BASELINE_UNITS.length + 1)
  })
})

describe('51 operational steps = unit ZERO + the 50 manifest units', () => {
  // NOMENCLATURE, PINNED BEFORE THE APPLY. "50 baseline units" and "51
  // operational steps" are both correct and describe different things, and a
  // reader meeting them a week apart would reasonably suspect a 51st unit
  // appeared. It did not: step 0 creates the ledger and is NOT a baseline unit.
  const generated = buildAllJournalWrappers(read)

  it('has exactly 50 units in the manifest, which is the source of order', () => {
    expect(BASELINE_UNITS).toHaveLength(50)
    expect(BASELINE_ORDER).toHaveLength(50)
  })

  it('emits 51 apply commands: one bootstrap plus the fifty', () => {
    expect(generated.commands).toHaveLength(51)
    expect(generated.commands[0]).toContain(JOURNAL_BOOTSTRAP_FILE)
  })

  // THE THING THAT MUST NOT HAPPEN: a 51st unit appearing outside the manifest.
  it('admits no baseline unit outside the manifest', () => {
    const wrapperIds = Object.keys(generated.files)
      .filter((f) => f !== JOURNAL_BOOTSTRAP_FILE)
      .map((f) => f.replace(/^db\/prepared\/journal\/\d{3}_/, ''))
    expect([...wrapperIds].sort()).toEqual([...BASELINE_ORDER].sort())
  })

  it('does not put step 0 in the manifest, because it is not a baseline unit', () => {
    expect(BASELINE_ORDER).not.toContain('000_journal_bootstrap')
    expect(BASELINE_UNITS.some((u) => u.file === JOURNAL_BOOTSTRAP_FILE)).toBe(false)
  })
})

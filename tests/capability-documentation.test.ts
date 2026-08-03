// tests/capability-documentation.test.ts
//
// Documentary coverage, as a gate rather than as a habit.
//
// The reaudit's list of things the suite did not pin ended with "cobertura
// documental", and that item is not cosmetic. Three of the twenty-two surviving
// mutations attack policies that NO capability document mentioned: the three
// RESTRICTIVE ones added in adversarial round 2, and the three disclosures_*
// ones that carry CAP-02's internal write path. A policy nobody documented is a
// policy nobody will notice the loss of — M-11 deletes disclosures_update_admin
// outright and the suite stayed green.
//
// So the first gate here is mechanical: every CREATE POLICY in a package must
// be named in that package's document. The rest pin the specific corrections
// this unit made, because a correction that nothing checks is a correction with
// a half-life.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parsePolicies } from './helpers/sql-structure'
import { DISCLOSURE_FLAGS, FORWARD, ROLLBACK, codeOnly } from './helpers/capability-gates'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')
const OPS = path.resolve(process.cwd(), 'docs', 'ops')

const sql = (f: string) => readFileSync(path.join(PREPARED, f), 'utf8')
const doc = (f: string) => readFileSync(path.join(OPS, f), 'utf8')

const DOCS: ReadonlyArray<{ id: string; forward: string; doc: string }> = [
  { id: 'CAP-01', forward: FORWARD.CAP01, doc: 'capabilities/CAP_01_INVITATIONS.md' },
  { id: 'CAP-02', forward: FORWARD.CAP02, doc: 'capabilities/CAP_02_PUBLIC_VERIFICATION.md' },
  { id: 'CAP-03', forward: FORWARD.CAP03, doc: 'capabilities/CAP_03_STRIPE.md' },
  { id: 'CAP-04', forward: FORWARD.CAP04, doc: 'capabilities/CAP_04_PUBLIC_LEADS.md' },
  { id: 'CAP-05', forward: FORWARD.CAP05, doc: 'capabilities/CAP_05_ORGANIZATION_BOOTSTRAP.md' },
]

describe('documentary coverage — every policy is described where it is owned', () => {
  it.each(DOCS)('$id: its document names every policy the package creates', ({ forward, doc: d }) => {
    const text = doc(d)
    const undocumented = parsePolicies(sql(forward))
      .map((p) => p.name)
      .filter((name) => !text.includes(name))
    expect(undocumented).toEqual([])
  })

  it.each(DOCS)('$id: its document states the RESTRICTIVE policies as restrictive', ({ forward, doc: d }) => {
    // Naming the policy is not enough, and neither is the word appearing
    // somewhere in the file — the first version asserted exactly that, so a
    // document naming nine restrictive policies and describing eight of them as
    // permissive would have passed. The whole point of the round-2 additions is
    // that a permissive twin is OR-ed away by the {public} baseline, so a
    // document that lists them without the mode teaches the wrong model.
    //
    // The check: each RESTRICTIVE policy must be named in a SECTION that
    // discusses restrictiveness. Section, not paragraph — these documents put
    // the policies in a markdown table and the argument in the prose beside it,
    // and a table row is its own paragraph.
    const text = doc(d)
    const restrictive = parsePolicies(sql(forward)).filter((p) => p.permissive === 'RESTRICTIVE')
    if (restrictive.length === 0) return
    const sections = text.split(/\n(?=#{2,4} )/)
    for (const p of restrictive) {
      const described = sections.some((s) => s.includes(p.name) && /RESTRICTIVE/.test(s))
      expect(
        described,
        `${d} names ${p.name} in a section that never mentions RESTRICTIVE`,
      ).toBe(true)
    }
  })
})

describe('documentary coverage — the corrections this unit made', () => {
  it('CAP-05 describes claim-by-INSERT, not the FOR UPDATE-first model', () => {
    const text = doc('capabilities/CAP_05_ORGANIZATION_BOOTSTRAP.md')
    expect(text).toMatch(/RECLAMAR LA CLAVE, PRIMERO/)
    expect(text).toMatch(/ON CONFLICT ON CONSTRAINT capability_bootstrap_attempts_pkey/)
    // The old model claimed FOR UPDATE at step 5 serialised concurrent calls.
    // It locks nothing when the row does not exist, and the document said so
    // for three revisions.
    expect(text).not.toMatch(/se reclama con `FOR UPDATE`/)
    expect(text).toMatch(/ON CONFLICT ON CONSTRAINT organizations_slug_unique/)
    expect(text, 'the doc still shows the ambiguous conflict target').not.toMatch(
      /ON CONFLICT \(slug\) DO NOTHING/,
    )
  })

  it('CAP-02 documents all six publication flags', () => {
    const text = doc('capabilities/CAP_02_PUBLIC_VERIFICATION.md')
    for (const flag of DISCLOSURE_FLAGS) expect(text, flag).toContain(flag)
    expect(text).toMatch(/seis/i)
  })

  it('CAP-03 pins RR-CAP-10 as a blocking precondition, by name', () => {
    const text = doc('capabilities/CAP_03_STRIPE.md')
    expect(text).toMatch(/RR-CAP-10/)
    expect(text).toMatch(/ORGANIZATION_QUOTA_COLUMN_HARDENING/)
    expect(text).toMatch(/PRECONDICI[ÓO]N BLOQUEANTE/i)
  })

  it('CAP-03 no longer presents client_reference_id as a live resolution path', () => {
    const text = doc('capabilities/CAP_03_STRIPE.md')
    // The string may appear — the document has to EXPLAIN the removal — but it
    // must never appear as a branch that still exists.
    // Not `/ya no existe|ya no est|DP-CAP-15/`: DP-CAP-15 appears throughout
    // the document, so that alternation was satisfied whether or not the branch
    // was presented as removed. The removal has to be stated.
    expect(text, 'the document does not state that the branch was removed').toMatch(
      /La rama `client_reference_id` ya no existe/,
    )
    // The package MUST still discuss it in prose — removing a branch without
    // recording why invites its return. What must be absent is the identifier
    // in executable code, which is what codeOnly() leaves behind.
    expect(sql(FORWARD.CAP03)).toMatch(/client_reference_id/)
    expect(codeOnly(sql(FORWARD.CAP03)), 'it is back in executable code').not.toMatch(
      /client_reference_id/,
    )
  })

  it('the central model carries fifteen product decisions, not fourteen', () => {
    const text = doc('DATABASE_CAPABILITY_MODEL.md')
    expect(text).toMatch(/DP-CAP-15/)
    expect(text).toMatch(/quince/i)
    for (let n = 1; n <= 15; n++)
      expect(text, `DP-CAP-${String(n).padStart(2, '0')} is missing`).toContain(
        `DP-CAP-${String(n).padStart(2, '0')}`,
      )
  })

  it('the risk register indexes RR-CAP-10 and no longer contradicts itself on RR-CAP-0', () => {
    const text = doc('STELLA_FABLE_RISK_REGISTER.md')
    expect(text).toMatch(/RR-CAP-10/)
    expect(text).toMatch(/PRECONDICI[ÓO]N BLOQUEANTE DE CAP-03/i)
    // The contradiction: the RR-CAP-0 ROW asserted "the design has never run
    // against any database" while the prose below it described a two-pass dry
    // run. Asserting the absence of one phrasing pins a diff, not a property —
    // any rewording of the same false claim would pass. So the POSITIVE form is
    // asserted too: the row must say what did happen.
    expect(text, 'RR-CAP-0 still claims the design never ran').not.toMatch(
      /El diseño \*\*no se ha ejecutado contra ninguna base\*\*/,
    )
    const row = text.split('\n').find((l) => l.startsWith('| **RR-CAP-0**'))
    expect(row, 'RR-CAP-0 has no row').toBeDefined()
    expect(row, 'the RR-CAP-0 row does not record the dry run').toMatch(/dry run|contenedor desechable/i)
    expect(row, 'the RR-CAP-0 row does not name what is still open').toMatch(/Supabase gestionado/i)
  })

  it('the risk register does not present the mutation work as closed', () => {
    // "0 of N mutations survive" is agreement between the catalogue and the
    // gates — two files written together — not coverage of the design. Two
    // reviewers found eleven real escapes in one session. A register that reads
    // CERRADO here would be overstating what was measured.
    const text = doc('STELLA_FABLE_RISK_REGISTER.md')
    const row = text.split('\n').find((l) => l.startsWith('| **RR-CAP-12**'))
    expect(row, 'RR-CAP-12 is not registered').toBeDefined()
    expect(row).not.toMatch(/\*\*CERRADO\*\*/)
    expect(row).toMatch(/MITIGADO/)
    expect(row, 'the residual is not stated').toMatch(/no los ejercita ninguna mutaci/i)
  })

  it('G2 records the dry-run that exists and still says nothing was applied live', () => {
    const text = doc('gates/G2_PACKAGE.md')
    expect(text, 'G2 still claims zero dry-run').not.toMatch(/\*\*Cero dry-run\.\*\*/)
    expect(text).toMatch(/contenedor desechable/)
    expect(text).toMatch(/Nada de esto se ha aplicado al stack vivo/)
    expect(text).toMatch(/G2 formal: NO EJECUTADO/)
  })

  it('the CAP-05 rollback describes the retained tables exactly, and claims no monopoly', () => {
    const text = sql(ROLLBACK.CAP05)
    expect(text, 'still claims to be the only rollback that drops a table').not.toMatch(
      /THIS IS THE ONE ROLLBACK THAT DROPS ITS TABLE/,
    )
    expect(text, 'still claims three retained tables').not.toMatch(
      /The other three capability tables are retained/,
    )
    expect(text).toMatch(/rollbacks retain TWO of them/)
    for (const t of ['report_public_disclosures', 'stripe_webhook_events'])
      expect(text, t).toContain(t)
  })
})

// tests/stella-db-model-default.test.ts
//
// G1-B PRECONDITIONS — P0: THE DATABASE MUST NOT CHOOSE STELLA'S MODEL.
//
// ---------------------------------------------------------------------------
// WHAT WAS WRONG
// ---------------------------------------------------------------------------
// `db/migrations/0012_stella_interactions.sql` created the ledger column as
//
//     model_used varchar(100) DEFAULT 'gemini-2.0-flash' NOT NULL
//
// and `db/schema.ts` mirrored it. `gemini-2.0-flash` was retired by Google and
// returns 404 (see lib/stella/config.ts). So the column default names a model
// that cannot be called — a SECOND SOURCE OF TRUTH for Stella's model target,
// one that no longer agrees with the only real one,
// `STELLA_DEFAULT_GEMINI_MODEL`.
//
// ---------------------------------------------------------------------------
// WHY IT IS REMOVED RATHER THAN RETARGETED TO gemini-3.6-flash
// ---------------------------------------------------------------------------
// Retargeting keeps the defect and hides it. `model_used` records WHICH MODEL
// ANSWERED — it is a measurement, not a configuration — and a default is the
// database inventing a measurement for a row whose writer did not supply one.
// The governed path never needs it: `uellix_stella_ops.complete_operation_ticket`
// resolves `v_model := COALESCE(p_model_used, 'not-applicable')` and names the
// column explicitly in its INSERT, so the DEFAULT clause is unreachable from
// the only writer that exists (stella_0017 revoked INSERT from every runtime
// principal). Removing it therefore changes no behaviour and closes the drift.
//
// ---------------------------------------------------------------------------
// WHAT THIS SUITE PINS
// ---------------------------------------------------------------------------
//   1. `db/schema.ts` carries no provider model id at all — as a default or
//      otherwise. This is the assertion that fails if someone "fixes" the
//      default by editing the literal.
//   2. The forward package that drops it on a live database exists and is
//      idempotent.
//
// It deliberately does NOT scan `db/migrations/0012_*.sql` or
// `db/baseline/stella_g2_schema.sql`: applied history and a pg_dump are
// RECORDS of what happened, and rewriting a record to satisfy a test is the
// worst possible way to pass one.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { STELLA_DEFAULT_GEMINI_MODEL } from '@/lib/stella/config'
import {
  ADMINISTRATIVE_UNITS,
  POSTCHAIN_ADMINISTRATIVE_UNITS,
  PRECHAIN_LEDGER_MODEL_DEFAULT,
  sha256OfPreparedSql,
} from '@/db/hosted/prechain-ownership'
import { HOSTED_CHAIN, HOSTED_PACKAGE_MANIFEST } from '@/db/hosted/hosted-package-manifest'

const ROOT = process.cwd()
const SCHEMA = path.join(ROOT, 'db/schema.ts')
const FORWARD = path.join(ROOT, 'db/prepared/stella_0020_stella_interactions_model_default.sql')
const ROLLBACK = path.join(ROOT, 'db/prepared/stella_0020_rollback.sql')

/**
 * Strip line comments before asserting on a source.
 *
 * The finding is about EXECUTABLE content, and the explanation of the finding
 * necessarily names the retired model. A scanner that cannot tell a `--`/`//`
 * line from a statement would force the fix to ship without its reason — which
 * is how the original default survived three model retirements in the first
 * place.
 */
function statementsOnly(source: string, marker: '--' | '//'): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart()
      return !t.startsWith(marker) && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

/**
 * Any string that looks like a hosted-LLM model id. Broad on purpose: the
 * finding is "a provider model is hardcoded in the schema", not "this exact
 * string is". A new provider must not slip in under a name this list misses.
 */
const PROVIDER_MODEL_PATTERN = /['"](?:gemini|gpt|claude|llama|mistral|command|grok)[-\w.]*['"]/i

describe('db/schema.ts never names a provider model', () => {
  const schema = readFileSync(SCHEMA, 'utf8')

  it('declares no column DEFAULT carrying a provider model id', () => {
    const defaults = schema.match(/\.default\(\s*['"][^'"]*['"]\s*\)/g) ?? []
    const offending = defaults.filter((d) => PROVIDER_MODEL_PATTERN.test(d))
    expect(offending).toEqual([])
  })

  it('contains no provider model literal in any statement', () => {
    const hits = statementsOnly(schema, '//')
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => PROVIDER_MODEL_PATTERN.test(line))
    expect(hits).toEqual([])
  })

  it('does not restate the model target the config owns', () => {
    expect(statementsOnly(schema, '//')).not.toContain(STELLA_DEFAULT_GEMINI_MODEL)
  })

  it('still declares model_used as NOT NULL — the column is required, only its default is gone', () => {
    expect(schema).toMatch(/modelUsed:\s*varchar\('model_used',\s*\{\s*length:\s*100\s*\}\)\.notNull\(\)/)
  })
})

describe('prepared stella_0020 drops the default on a live database', () => {
  it('the forward package exists', () => {
    expect(existsSync(FORWARD)).toBe(true)
  })

  it('drops the default and nothing else structural', () => {
    const sql = statementsOnly(readFileSync(FORWARD, 'utf8'), '--')
    expect(sql).toMatch(/ALTER\s+TABLE\s+public\.stella_interactions\s+ALTER\s+COLUMN\s+model_used\s+DROP\s+DEFAULT/i)
    // The column stays NOT NULL and the table keeps its data: a package that
    // dropped the column or the constraint would satisfy the assertion above
    // and destroy the ledger.
    expect(sql).not.toMatch(/DROP\s+COLUMN/i)
    expect(sql).not.toMatch(/DROP\s+TABLE/i)
    expect(sql).not.toMatch(/DELETE\s+FROM/i)
    expect(sql).not.toMatch(/TRUNCATE/i)
    expect(sql).not.toMatch(/DROP\s+NOT\s+NULL/i)
  })

  it('has a rollback that restores a default without naming a live model target', () => {
    expect(existsSync(ROLLBACK)).toBe(true)
    const sql = statementsOnly(readFileSync(ROLLBACK, 'utf8'), '--')
    expect(sql).toMatch(/SET\s+DEFAULT/i)
    // The rollback restores the HISTORICAL value 0012 wrote, which is a retired
    // model. That is correct for a rollback (it restores what was there) and is
    // the reason the rollback must never be read as a model recommendation.
    expect(sql).toContain('gemini-2.0-flash')
    expect(sql).not.toContain(STELLA_DEFAULT_GEMINI_MODEL)
  })
})

/**
 * G1-B GOVERNANCE — the channel this package reaches a hosted database through.
 *
 * THE FINDING. The header used to say the hosted variant "is generated and
 * authorised through the normal channel (pnpm hosted:generate / the operator
 * runbook)". No manifest entry existed, so `hosted:generate` produced nothing
 * and `hosted:verify` covered nothing: an operator following that sentence
 * would have found no artefact and applied the canonical file directly, which
 * is an UNGOVERNED apply and the class of the T1 incident.
 *
 * THE RESOLUTION is NOT to add it to that manifest, and the reason is
 * structural: HOSTED_CHAIN *is* HOSTED_PACKAGE_MANIFEST, so an entry there is a
 * governed chain LINK — a T-number, an authority window, a witness, a
 * `.governed.sql`, and `uellix_migrator` as its only applying identity — and it
 * would move A1_EXPECTED_PACKAGE_COUNT, reclassifying an installation already
 * certified at 11/11 as incomplete. It is registered as a PRECHAIN
 * ADMINISTRATIVE UNIT instead: pinned by digest, applied by the administrative
 * session, covered by both certification harnesses.
 */
describe('stella_0020 is governed by a channel that actually exists', () => {
  const forward = () => statementsOnly(readFileSync(FORWARD, 'utf8'), '--')
  const rollback = () => statementsOnly(readFileSync(ROLLBACK, 'utf8'), '--')
  const code = (file: string) =>
    statementsOnly(readFileSync(file, 'utf8'), '--').replace(/'(?:[^']|'')*'/g, "''")

  it('is registered in the prechain registry, pinned to the bytes on disk', () => {
    expect(PRECHAIN_LEDGER_MODEL_DEFAULT.sourceFile).toBe(
      'db/prepared/stella_0020_stella_interactions_model_default.sql',
    )
    expect(sha256OfPreparedSql(readFileSync(FORWARD, 'utf8'))).toBe(
      PRECHAIN_LEDGER_MODEL_DEFAULT.sourceSha256,
    )
    expect(ADMINISTRATIVE_UNITS.map((u) => u.id)).toContain(PRECHAIN_LEDGER_MODEL_DEFAULT.id)
  })

  it('is applied AFTER the chain, because stella_0017 is what makes it appliable', () => {
    // Measured by pnpm certify:pg176, not reasoned: before T1 the package
    // aborts, naming authenticated and service_role, which hold the baseline
    // INSERT grant that stella_0017 (T8) withdraws.
    expect(PRECHAIN_LEDGER_MODEL_DEFAULT.applyWindow).toBe('postchain')
    expect(POSTCHAIN_ADMINISTRATIVE_UNITS.map((u) => u.id)).toContain(
      PRECHAIN_LEDGER_MODEL_DEFAULT.id,
    )
    // and the package says so where an operator reads it
    const header = readFileSync(FORWARD, 'utf8')
    expect(header).toMatch(/AFTER THE CHAIN, NOT BEFORE IT/)
    expect(header).toContain('stella_0017')
  })

  it('its rollback is governed by the SAME registry entry, and exists', () => {
    expect(PRECHAIN_LEDGER_MODEL_DEFAULT.rollbackFile).toBe('db/prepared/stella_0020_rollback.sql')
    expect(PRECHAIN_LEDGER_MODEL_DEFAULT.forwardOnlyNoRollbackReason).toBeNull()
    expect(existsSync(path.join(ROOT, PRECHAIN_LEDGER_MODEL_DEFAULT.rollbackFile!))).toBe(true)
  })

  it('is NOT a chain link, and produces no derived hosted artefact', () => {
    expect(HOSTED_CHAIN).not.toContain(PRECHAIN_LEDGER_MODEL_DEFAULT.id)
    expect(HOSTED_PACKAGE_MANIFEST.map((e) => e.sourceFile)).not.toContain(
      'stella_0020_stella_interactions_model_default.sql',
    )
    // The canonical file IS the artefact. A `.hosted.sql` sitting next to it
    // would be the second source of truth `hosted:verify` reports as an ORPHAN.
    for (const name of [
      'stella_0020_stella_interactions_model_default.hosted.sql',
      'stella_0020_rollback.hosted.sql',
    ]) {
      expect(existsSync(path.join(ROOT, 'db/prepared/hosted', name)), name).toBe(false)
    }
  })

  it('no longer claims a channel it is not in, and says so as a correction', () => {
    const header = readFileSync(FORWARD, 'utf8')
    // The false sentence is still QUOTED — deliberately. A header that silently
    // dropped it would leave the next reader unable to tell a corrected claim
    // from one nobody ever made, and this repository has already paid for one
    // ungoverned apply. What must not survive is the sentence presented as
    // GUIDANCE, so the quote is required to sit inside the correction.
    expect(header).toMatch(/THE CORRECTION[\s\S]{0,600}?was FALSE/)
    expect(header).toMatch(/PRECHAIN ADMINISTRATIVE UNIT/)
    expect(header).toMatch(/db\/hosted\/prechain-ownership\.ts/)
    // No operator instruction pointing at the generation pipeline.
    expect(header).not.toMatch(/^--\s+pnpm hosted:(generate|verify)/m)
  })

  it('carries the same measured-owner identity contract as stella_hosted_0008', () => {
    for (const sql of [forward(), rollback()]) {
      // Measured, never named.
      expect(sql).not.toMatch(/current_user\s*<>\s*'uellix_owner'/)
      expect(sql).toMatch(/pg_get_userbyid\(c\.relowner\)/)
      expect(sql).toMatch(/v_owner\s*=\s*current_user/)
      // Assumed only where it can be assumed.
      expect(sql).toMatch(/pg_has_role\(current_user, 'uellix_owner', 'USAGE'\)/)
      expect(sql).toMatch(/pg_has_role\(current_user, 'uellix_owner', 'SET'\)/)
      expect(sql).toMatch(/is neither that role nor able to assume it/)
      // Given back, and asserted.
      expect(sql).toMatch(/RESET ROLE;/)
      expect(sql).toMatch(/IF current_user <> session_user THEN/)
    }
  })

  it('names both identity outcomes so an operator can read the branch it took', () => {
    expect(forward()).toMatch(/SESSION_IS_OWNER/)
    expect(forward()).toMatch(/OWNER_ASSUMABLE/)
  })

  it('creates no grant, policy or role, and moves no owner', () => {
    for (const file of [FORWARD, ROLLBACK]) {
      const sql = code(file)
      expect(sql).not.toMatch(/^\s*GRANT\b/im)
      expect(sql).not.toMatch(/^\s*REVOKE\b/im)
      expect(sql).not.toMatch(/\bCREATE\s+(POLICY|ROLE|TABLE|SCHEMA|TRIGGER)\b/i)
      expect(sql).not.toMatch(/OWNER\s+TO/i)
      expect(sql).not.toMatch(/ROW\s+LEVEL\s+SECURITY/i)
    }
  })

  it('proves the owner and the ACL did not move, rather than claiming it', () => {
    expect(forward()).toMatch(/v_owner_now <> v_owner_pre/)
    expect(forward()).toMatch(/v_acl_now IS DISTINCT FROM v_acl_pre/)
  })

  it('still keeps NOT NULL and still refuses to name a live model target', () => {
    const sql = forward()
    expect(sql).toMatch(/attnotnull/)
    expect(sql).toMatch(/no longer NOT NULL/)
    expect(sql).not.toContain(STELLA_DEFAULT_GEMINI_MODEL)
  })
})

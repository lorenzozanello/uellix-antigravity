// db/hosted/generate-hosted-package.ts
// TRAIN 5B — the deterministic generator.
//
// Takes a canonical prepared package plus its manifest entry and produces the
// managed-Supabase artefact. It is a pure function of (entry, source): no
// filesystem, no clock, no randomness — so `pnpm hosted:verify` can regenerate
// everything and compare byte for byte, which is what makes the checked-in
// artefacts auditable rather than merely present.
//
// TWO REFUSALS, AND THEY GUARD OPPOSITE FAILURES
//
//   HOSTED_SOURCE_SHA_MISMATCH   — the canonical file moved. Somebody patched
//                                  `db/prepared/**` without regenerating. This
//                                  is the refusal Phase 10 asks for by name.
//
//   HOSTED_REWRITE_COUNT_MISMATCH — the canonical file is EXACTLY the pinned
//                                  one, but a rule fired a different number of
//                                  times. That can only mean a rule's pattern
//                                  changed, and a loosened pattern is how a
//                                  generator starts rewriting things nobody
//                                  reviewed. A hash cannot see this; only the
//                                  counts can.
//
// Both are thrown, never logged-and-continued. A generator that warns is a
// generator whose warning ends up in a scrollback nobody reads.

import { HOSTED_REWRITE_RULES, rewriteForManagedSupabase } from './rewrite-rules'
import { sha256OfSql, type HostedManifestEntry } from './hosted-package-manifest'

export interface GeneratedHostedPackage {
  readonly name: string
  readonly sql: string
  readonly counts: Readonly<Record<string, number>>
  /** SHA-256 of the generated artefact, for the manifest report and the runner. */
  readonly generatedSha256: string
}

function header(entry: HostedManifestEntry, counts: Record<string, number>): string {
  const applied = HOSTED_REWRITE_RULES.map((r) => `--   ${r.id}: ${counts[r.id]}`).join('\n')
  return [
    '-- ============================================================================',
    `-- ${entry.name} — MANAGED SUPABASE VARIANT`,
    '-- GENERATED — DO NOT EDIT. Regenerate with `pnpm hosted:generate`.',
    '-- ============================================================================',
    '--',
    `-- Derived from: db/prepared/${entry.sourceFile}`,
    `-- Source SHA-256 (LF-normalized): ${entry.sourceSha256}`,
    '--',
    '-- The canonical file above is the ONLY source of truth. This artefact exists',
    '-- because managed Supabase exposes no superuser and does not let `postgres`',
    '-- grant USAGE on schema auth. Editing THIS file instead of the canonical one',
    '-- creates the second source of truth the design exists to prevent — and the',
    '-- verification suite will fail, because it regenerates and compares bytes.',
    '--',
    '-- Rewrite rules applied (id: times fired):',
    applied,
    '--',
    '-- Nothing else was changed. No policy predicate, no ownership transfer, no',
    '-- REVOKE, no SECURITY DEFINER marker, no search_path, no CHECK and no',
    '-- self-verification block differs from the canonical source.',
    '-- ============================================================================',
    '',
  ].join('\n')
}

export function generateHostedPackage(
  entry: HostedManifestEntry,
  canonicalSql: string,
): GeneratedHostedPackage {
  const actualSha = sha256OfSql(canonicalSql)
  if (actualSha !== entry.sourceSha256) {
    throw new Error(
      `HOSTED_SOURCE_SHA_MISMATCH: db/prepared/${entry.sourceFile} no longer hashes to the value ` +
        `pinned in db/hosted/hosted-package-manifest.ts.\n` +
        `  pinned: ${entry.sourceSha256}\n` +
        `  actual: ${actualSha}\n` +
        `The canonical package changed. Re-review the hosted variant, update the pin AND the ` +
        `expected rewrite counts in the same edit, then regenerate. Do not update the pin alone: ` +
        `the counts are the only check that the rules still match what they used to match.`,
    )
  }

  // A `native-hosted` package is written FOR managed Supabase; it is the
  // artefact, not a source for one. Passing it through the rules would be
  // actively wrong, not merely redundant: the bootstrap's own body contains
  // `SELECT auth.uid()` — that IS the shim — and rewriting it would produce a
  // function that calls itself. It still gets the SHA check, because a drifting
  // bootstrap is exactly as dangerous as a drifting package.
  if (entry.hostedCompatibility === 'native-hosted') {
    const passthrough = canonicalSql.replace(/\r\n?/g, '\n')
    return {
      name: entry.name,
      sql: passthrough,
      counts: { ...entry.expectedRewrites },
      generatedSha256: sha256OfSql(passthrough),
    }
  }

  const { sql, counts } = rewriteForManagedSupabase(entry.name, canonicalSql)

  const disagreements = HOSTED_REWRITE_RULES.map((rule) => ({
    id: rule.id,
    expected: entry.expectedRewrites[rule.id],
    actual: counts[rule.id],
  })).filter((d) => d.expected !== d.actual)

  if (disagreements.length > 0) {
    throw new Error(
      `HOSTED_REWRITE_COUNT_MISMATCH: ${entry.name} rewrote a different number of sites than the ` +
        `manifest expects, over a source whose SHA-256 is unchanged. That means a RULE moved, not ` +
        `the package.\n` +
        disagreements
          .map((d) => `  ${d.id}: expected ${d.expected}, fired ${d.actual}`)
          .join('\n'),
    )
  }

  const artefact = header(entry, counts) + sql
  return {
    name: entry.name,
    sql: artefact,
    counts,
    generatedSha256: sha256OfSql(artefact),
  }
}

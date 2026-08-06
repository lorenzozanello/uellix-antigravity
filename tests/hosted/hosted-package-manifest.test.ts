// tests/hosted/hosted-package-manifest.test.ts
// TRAIN 5B — the manifest is the contract between the canonical sources and the
// generated hosted artefacts. These tests are what make it a contract rather
// than a comment.
//
// The property that matters most: a canonical package cannot be edited without
// the generation refusing. Phase 10 states it as "el artefacto generado debe
// fallar si el hash del paquete fuente cambia", and the negative controls below
// drive that refusal rather than asserting the happy path around it.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  HOSTED_CHAIN,
  HOSTED_PACKAGE_MANIFEST,
  hostedManifestEntry,
  sha256OfSql,
} from '@/db/hosted/hosted-package-manifest'
import { generateHostedPackage } from '@/db/hosted/generate-hosted-package'
import { STELLA_TICKET_PACKAGE_CHAIN } from '@/db/prepared-package-order'

const REPO_ROOT = process.cwd()

function readCanonical(fileName: string): string {
  return readFileSync(path.join(REPO_ROOT, 'db', 'prepared', fileName), 'utf8').replace(
    /\r\n?/g,
    '\n',
  )
}

describe('HOSTED_CHAIN — shape', () => {
  it('is bootstrap first, then grounding, then the six ticket packages', () => {
    expect(HOSTED_CHAIN).toEqual([
      'stella_hosted_0001_managed_role_bootstrap',
      'grounding_0002_document_versions',
      'grounding_0003_evidence_chunks',
      'grounding_0004_runtime_attestation',
      'stella_0013_grounded_query_quota',
      'stella_0014_operation_tickets',
      'stella_0015_project_bound_operation_tickets',
      'stella_0016_reserved_quota_semantics',
      'stella_0017_governed_stella_consumption',
      'stella_0018_category_bound_operation_tickets',
    ])
  })

  it('agrees with STELLA_TICKET_PACKAGE_CHAIN — two registries, one order', () => {
    const ticketPart = HOSTED_CHAIN.filter((n) => n.startsWith('stella_00'))
    expect(ticketPart).toEqual([...STELLA_TICKET_PACKAGE_CHAIN])
  })

  it('never contains stella_0004 — the local role bootstrap is superseded on hosted, not reused', () => {
    expect(HOSTED_CHAIN).not.toContain('stella_0004_role_separation')
  })

  it('has one manifest entry per chain member, and no orphan entries', () => {
    expect(HOSTED_PACKAGE_MANIFEST.map((e) => e.name)).toEqual([...HOSTED_CHAIN])
  })
})

describe('HOSTED_PACKAGE_MANIFEST — pinned source identity', () => {
  it('pins the SHA-256 of every canonical source, and every pin matches the tree', () => {
    for (const entry of HOSTED_PACKAGE_MANIFEST) {
      const actual = sha256OfSql(readCanonical(entry.sourceFile))
      expect(`${entry.name}:${actual}`).toBe(`${entry.name}:${entry.sourceSha256}`)
    }
  })

  it('declares expected objects, owners and grants for every entry', () => {
    for (const entry of HOSTED_PACKAGE_MANIFEST) {
      expect(entry.expectedObjects.length).toBeGreaterThan(0)
      expect(entry.expectedOwners.length).toBeGreaterThan(0)
      expect(entry.rollbackPolicy.length).toBeGreaterThan(20)
      expect(entry.reapplyPolicy.length).toBeGreaterThan(20)
    }
  })

  it('declares a hosted compatibility status from the closed vocabulary', () => {
    for (const entry of HOSTED_PACKAGE_MANIFEST) {
      expect([
        'native-hosted',
        'derived-precondition-only',
        'derived-precondition-and-auth',
      ]).toContain(entry.hostedCompatibility)
    }
  })

  it('marks ONLY the bootstrap as native-hosted — the nine others are derived', () => {
    const native = HOSTED_PACKAGE_MANIFEST.filter((e) => e.hostedCompatibility === 'native-hosted')
    expect(native.map((e) => e.name)).toEqual(['stella_hosted_0001_managed_role_bootstrap'])
  })

  it('states each derived package dependencies in chain order', () => {
    for (const entry of HOSTED_PACKAGE_MANIFEST) {
      for (const dep of entry.dependsOn) {
        expect(HOSTED_CHAIN.indexOf(dep)).toBeLessThan(HOSTED_CHAIN.indexOf(entry.name))
      }
    }
  })
})

describe('generateHostedPackage — a native-hosted package is passed through, never rewritten', () => {
  const entry = hostedManifestEntry('stella_hosted_0001_managed_role_bootstrap')

  it('returns the bootstrap byte-identical — it IS the artefact, not a source for one', () => {
    const source = readCanonical(entry.sourceFile)
    const { sql, counts } = generateHostedPackage(entry, source)

    expect(sql).toBe(source)
    expect(Object.values(counts).every((c) => c === 0)).toBe(true)
  })

  it('keeps the shim body intact — rewriting `SELECT auth.uid()` would make the shim call itself', () => {
    const { sql } = generateHostedPackage(entry, readCanonical(entry.sourceFile))

    expect(sql).toContain('AS $$ SELECT auth.uid() $$')
    expect(sql).not.toContain('SELECT public.uellix_auth_uid()')
  })

  it('still refuses when the bootstrap itself drifts from its pin', () => {
    expect(() => generateHostedPackage(entry, '-- edited\n')).toThrow(/HOSTED_SOURCE_SHA_MISMATCH/)
  })
})

describe('generateHostedPackage — refuses drift', () => {
  const entry = hostedManifestEntry('stella_0013_grounded_query_quota')

  it('generates from the pinned source', () => {
    const generated = generateHostedPackage(entry, readCanonical(entry.sourceFile))
    expect(generated.sql.length).toBeGreaterThan(1000)
  })

  it('THROWS when the source changed — one added comment line is enough', () => {
    const drifted = `-- an innocuous edit nobody told the manifest about\n${readCanonical(entry.sourceFile)}`

    expect(() => generateHostedPackage(entry, drifted)).toThrow(/HOSTED_SOURCE_SHA_MISMATCH/)
  })

  it('names both hashes in the refusal, so the operator can see what moved', () => {
    const drifted = `${readCanonical(entry.sourceFile)}\n-- trailing edit\n`
    let message = ''
    try {
      generateHostedPackage(entry, drifted)
    } catch (e) {
      message = (e as Error).message
    }

    expect(message).toContain(entry.sourceSha256)
    expect(message).toContain(sha256OfSql(drifted))
  })

  it('THROWS when a rule fires a different number of times than the manifest expects', () => {
    const tampered = { ...entry, expectedRewrites: { ...entry.expectedRewrites, 'auth-uid-call': 99 } }

    expect(() => generateHostedPackage(tampered, readCanonical(entry.sourceFile))).toThrow(
      /HOSTED_REWRITE_COUNT_MISMATCH/,
    )
  })
})

describe('generateHostedPackage — what the artefact must and must not contain', () => {
  const derived = HOSTED_PACKAGE_MANIFEST.filter((e) => e.hostedCompatibility !== 'native-hosted')

  it.each(derived.map((e) => [e.name] as const))(
    '%s carries no superuser guard after generation',
    (name) => {
      const entry = hostedManifestEntry(name)
      const { sql } = generateHostedPackage(entry, readCanonical(entry.sourceFile))

      expect(sql).not.toContain('IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)')
      expect(sql).toContain(`PERFORM uellix_bootstrap.assert_hosted_capabilities('${name}')`)
    },
  )

  it.each(derived.map((e) => [e.name] as const))(
    '%s keeps the postconditions that assert a capability role is NOT superuser',
    (name) => {
      const entry = hostedManifestEntry(name)
      const canonical = readCanonical(entry.sourceFile)
      const { sql } = generateHostedPackage(entry, canonical)

      // Every surviving `rolsuper` in the canonical source that is NOT the
      // guard is an assertion about a role we created. Removing one would drop
      // a check, which is the failure mode this whole train is written against.
      const survivorsBefore = canonical
        .split('\n')
        .filter((l) => l.includes('rolsuper') && !l.includes('WHERE rolname = current_user')).length
      const survivorsAfter = sql
        .split('\n')
        .filter((l) => l.includes('rolsuper')).length

      expect(survivorsAfter).toBe(survivorsBefore)
    },
  )

  it.each(derived.map((e) => [e.name] as const))(
    '%s has no unrewritten executable auth.uid() left',
    (name) => {
      const entry = hostedManifestEntry(name)
      const { sql } = generateHostedPackage(entry, readCanonical(entry.sourceFile))

      // INDEPENDENT of the rule's own heuristic. Adversarial review B pointed
      // out that the first version of this check reimplemented the same
      // "line contains a quote" exclusion the rule used, so a call the rule
      // skipped for that reason would also be invisible here — the test and the
      // code shared a blind spot.
      //
      // This instead STRIPS comments and string literals with a small scanner
      // written for the test, and then asks whether any `auth.uid()` survives in
      // executable text. Different method, same question.
      const leftovers: string[] = []
      for (const line of sql.split('\n')) {
        let executable = ''
        let inLiteral = false
        for (let i = 0; i < line.length; i += 1) {
          const ch = line[i]
          if (ch === "'") {
            inLiteral = !inLiteral
            continue
          }
          if (!inLiteral && ch === '-' && line[i + 1] === '-') break
          if (!inLiteral) executable += ch
        }
        const stripped = executable.replaceAll('public.uellix_auth_uid()', '')
        if (stripped.includes('auth.uid()')) leftovers.push(line)
      }

      expect(leftovers).toEqual([])
    },
  )

  it('stamps a header naming the source, its SHA and the rules applied', () => {
    const entry = hostedManifestEntry('stella_0014_operation_tickets')
    const { sql } = generateHostedPackage(entry, readCanonical(entry.sourceFile))

    expect(sql).toContain('GENERATED — DO NOT EDIT')
    expect(sql).toContain(entry.sourceFile)
    expect(sql).toContain(entry.sourceSha256)
    expect(sql).toContain('superuser-precondition')
  })

  it('is deterministic — generating twice yields byte-identical output', () => {
    const entry = hostedManifestEntry('stella_0016_reserved_quota_semantics')
    const source = readCanonical(entry.sourceFile)

    expect(generateHostedPackage(entry, source).sql).toBe(generateHostedPackage(entry, source).sql)
  })

  it('emits LF only', () => {
    for (const entry of derived) {
      const { sql } = generateHostedPackage(entry, readCanonical(entry.sourceFile))
      expect(sql.includes('\r')).toBe(false)
    }
  })
})

describe('the bootstrap ROLLBACK is pinned too', () => {
  // Adversarial review A, MINOR: the manifest anchored every forward package and
  // nothing anchored the rollback — the one file that drops five roles and the
  // shim could drift in silence while its forward could not.
  const ROLLBACK_SHA = 'ec5a026dd225af0bfdd1988a8a9b7918e029974f5f9ea1129407e16ab762b4ae'

  it('has a SHA that a reviewer signed off — a drift here is a drift in the destructive half', () => {
    const actual = sha256OfSql(readCanonical('stella_hosted_0001_rollback.sql'))
    expect(actual).toBe(ROLLBACK_SHA)
  })
})

describe('sha256OfSql', () => {
  it('normalizes CRLF before hashing — a Windows checkout must not change the pin', () => {
    expect(sha256OfSql('a\r\nb\r\n')).toBe(sha256OfSql('a\nb\n'))
  })

  it('is a real SHA-256 of the normalized bytes', () => {
    const expected = createHash('sha256').update('a\nb\n', 'utf8').digest('hex')
    expect(sha256OfSql('a\r\nb\r\n')).toBe(expected)
  })
})

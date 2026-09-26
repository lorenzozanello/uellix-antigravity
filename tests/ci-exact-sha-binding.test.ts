// tests/ci-exact-sha-binding.test.ts — FIS-01a exact-SHA CI binding.
//
// Two kinds of assertion, mirroring tests/ods/ci-authority-integration.test.ts:
//
//   1. Direct unit tests against the pure functions in
//      scripts/ci-exact-sha-evidence.ts (the resolver and the evidence
//      builder), using a fake git runner — no real git process, no real
//      GitHub Actions run required.
//
//   2. Static, semantic (never YAML-formatting) checks against the checked-in
//      .github/workflows/ci.yml text, for properties that can only exist at
//      the workflow level (trigger branches, step ordering, absence of
//      `if: always()` / `continue-on-error` on the evidence step) — this
//      project has no YAML parser dependency, and simple text checks are
//      sufficient for these properties, same rationale as the sibling file.
//
// Each `describe` block heading below is annotated with the NC (negative
// control) identifiers from the FIS-01a mission it covers.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  resolveExpectedSha,
  deriveTree,
  assertCleanTree,
  checkMergeRefNotTested,
  buildEvidence,
  evidenceArtifactName,
  APPROVED_PUSH_REFS,
  type GitRunner,
} from '../scripts/ci-exact-sha-evidence'

const CI_YAML_PATH = path.resolve(__dirname, '..', '.github', 'workflows', 'ci.yml')

function readCiYaml(): string {
  return readFileSync(CI_YAML_PATH, 'utf8')
}

/** Slices one step's own block (from its "- name:" line to the next one). */
function stepBlock(ci: string, needle: string): string {
  const idx = ci.indexOf(needle)
  expect(idx).toBeGreaterThan(-1)
  const blockStart = ci.lastIndexOf('- name:', idx)
  const blockEnd = ci.indexOf('- name:', idx + 1)
  return ci.slice(blockStart, blockEnd === -1 ? undefined : blockEnd)
}

// A fake git that resolves a fixed script of responses per subcommand, so
// tests never spawn a real git process.
function fakeGit(responses: Record<string, string>): GitRunner {
  return (args: string[]) => {
    const key = args.join(' ')
    if (!(key in responses)) {
      throw new Error(`fakeGit: unscripted command "git ${key}"`)
    }
    return responses[key]
  }
}

// A fake git that throws for a given subcommand (models a real non-zero exit,
// e.g. `git diff --quiet` on a dirty tree).
function throwingGit(failingKey: string, message = 'git command failed'): GitRunner {
  return (args: string[]) => {
    if (args.join(' ') === failingKey) throw new Error(message)
    throw new Error(`throwingGit: unscripted command "git ${args.join(' ')}"`)
  }
}

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const TREE_A = 't'.repeat(40)

describe('resolveExpectedSha — the closed event-SHA resolver', () => {
  it('pull_request: resolves to pull_request.head.sha', () => {
    const result = resolveExpectedSha({ eventName: 'pull_request', ref: 'refs/pull/1/merge', prHeadSha: SHA_A, githubSha: SHA_B })
    expect(result.sha).toBe(SHA_A)
    expect(result.source).toBe('pull_request.head.sha')
  })

  // NC6: pull_request head SHA missing -> FAIL.
  it('NC6: pull_request with no head SHA throws', () => {
    expect(() => resolveExpectedSha({ eventName: 'pull_request', ref: 'refs/pull/1/merge', prHeadSha: undefined, githubSha: SHA_B })).toThrow(
      /missing github\.event\.pull_request\.head\.sha/,
    )
    expect(() => resolveExpectedSha({ eventName: 'pull_request', ref: 'refs/pull/1/merge', prHeadSha: '', githubSha: SHA_B })).toThrow()
  })

  // NC7: pull_request must never fall back to github.sha, even if provided.
  it('NC7: pull_request never resolves to github.sha, even when both are present and differ', () => {
    const result = resolveExpectedSha({ eventName: 'pull_request', ref: 'refs/pull/1/merge', prHeadSha: SHA_A, githubSha: SHA_B })
    expect(result.sha).toBe(SHA_A)
    expect(result.sha).not.toBe(SHA_B)
  })

  it('push: resolves to github.sha on main', () => {
    const result = resolveExpectedSha({ eventName: 'push', ref: 'refs/heads/main', prHeadSha: undefined, githubSha: SHA_B })
    expect(result.sha).toBe(SHA_B)
    expect(result.source).toMatch(/^github\.sha/)
  })

  it('push: resolves to github.sha on integration/commercial-v1', () => {
    const result = resolveExpectedSha({ eventName: 'push', ref: 'refs/heads/integration/commercial-v1', prHeadSha: undefined, githubSha: SHA_B })
    expect(result.sha).toBe(SHA_B)
  })

  // NC3: main removed from the approved set would make this throw — this
  // asserts the CURRENT correct behavior; the ci.yml-level absence of main
  // is a workflow-trigger property, covered separately below.
  it('NC3 (function-level): main is in the approved push ref set', () => {
    expect(APPROVED_PUSH_REFS).toContain('refs/heads/main')
  })

  // NC2 (function-level): integration/commercial-v1 is in the approved set.
  it('NC2 (function-level): integration/commercial-v1 is in the approved push ref set', () => {
    expect(APPROVED_PUSH_REFS).toContain('refs/heads/integration/commercial-v1')
  })

  // NC8: push on any other ref -> FAIL.
  it('NC8: push on an unapproved ref throws', () => {
    expect(() => resolveExpectedSha({ eventName: 'push', ref: 'refs/heads/feature/whatever', prHeadSha: undefined, githubSha: SHA_B })).toThrow(
      /unapproved ref/,
    )
  })

  it('workflow_dispatch: resolves to github.sha unconditionally', () => {
    const result = resolveExpectedSha({ eventName: 'workflow_dispatch', ref: 'refs/heads/anything', prHeadSha: undefined, githubSha: SHA_B })
    expect(result.sha).toBe(SHA_B)
  })

  it('any other event throws — the resolver is closed, not open-ended', () => {
    expect(() => resolveExpectedSha({ eventName: 'schedule', ref: 'refs/heads/main', prHeadSha: undefined, githubSha: SHA_B })).toThrow(
      /unsupported event/,
    )
  })
})

describe('deriveTree — TREE is bound to EVIDENCE_SHA, never a free-floating HEAD', () => {
  // NC5: tree != SHA^{tree} — this proves the implementation asks git for
  // exactly `<sha>^{tree}`, not `HEAD^{tree}` computed as a separate call
  // that could have moved between invocations.
  it('NC5: requests "<sha>^{tree}" scoped to the given SHA, not a bare HEAD^{tree}', () => {
    const git = fakeGit({ [`rev-parse ${SHA_A}^{tree}`]: `${TREE_A}\n` })
    expect(deriveTree(git, SHA_A)).toBe(TREE_A)
  })

  it('NC5: a git runner that only knows HEAD^{tree} (not the SHA-scoped form) is unscripted and fails', () => {
    const git = fakeGit({ 'rev-parse HEAD^{tree}': `${TREE_A}\n` })
    expect(() => deriveTree(git, SHA_A)).toThrow(/unscripted command/)
  })
})

describe('assertCleanTree — the pre-evidence git diff --quiet gate', () => {
  it('passes silently when git reports no diff', () => {
    const git = fakeGit({ 'diff --quiet HEAD --': '' })
    expect(() => assertCleanTree(git)).not.toThrow()
  })

  it('throws when the tree is dirty (git diff --quiet exits non-zero)', () => {
    const git = throwingGit('diff --quiet HEAD --')
    expect(() => assertCleanTree(git)).toThrow()
  })
})

describe('checkMergeRefNotTested — the PR synthetic merge-ref defense', () => {
  it('non-pull_request events are not_applicable', () => {
    expect(checkMergeRefNotTested('push', SHA_A, undefined)).toEqual({ status: 'not_applicable', mergeRefSha: null })
  })

  it('pull_request with no merge ref reported is "absent"', () => {
    expect(checkMergeRefNotTested('pull_request', SHA_A, undefined)).toEqual({ status: 'absent', mergeRefSha: null })
  })

  it('pull_request with a distinct merge ref is "not_tested" and states the merge-ref SHA', () => {
    expect(checkMergeRefNotTested('pull_request', SHA_A, SHA_B)).toEqual({ status: 'not_tested', mergeRefSha: SHA_B })
  })

  // NC14: tested HEAD == merge-ref SHA -> FAIL.
  it('NC14: pull_request where the merge-ref SHA equals the tested SHA throws', () => {
    expect(() => checkMergeRefNotTested('pull_request', SHA_A, SHA_A)).toThrow(/equals the synthetic PR merge-ref SHA/)
  })
})

describe('buildEvidence — the final assembled record', () => {
  function git(): GitRunner {
    return fakeGit({
      'rev-parse HEAD': `${SHA_A}\n`,
      [`rev-parse ${SHA_A}^{tree}`]: `${TREE_A}\n`,
      'diff --quiet HEAD --': '',
    })
  }

  const baseEnv = {
    eventName: 'push',
    ref: 'refs/heads/main',
    expectedSha: SHA_A,
    expectedSource: 'github.sha (push:refs/heads/main)',
    mergeRefSha: undefined,
    runId: '123',
    runAttempt: '1',
    workflowRef: 'org/repo/.github/workflows/ci.yml@refs/heads/main',
  }

  // NC10: artifact content must repeat the SHA and tree.
  it('NC10: the evidence record repeats EVIDENCE_SHA and TREE', () => {
    const evidence = buildEvidence(git(), baseEnv)
    expect(evidence.EVIDENCE_SHA).toBe(SHA_A)
    expect(evidence.TREE).toBe(TREE_A)
  })

  it('states the merge ref was not tested for a pull_request event', () => {
    const evidence = buildEvidence(git(), {
      ...baseEnv,
      eventName: 'pull_request',
      ref: 'refs/pull/7/merge',
      expectedSource: 'pull_request.head.sha',
      mergeRefSha: SHA_B,
    })
    expect(evidence.MERGE_REF_SHA_NOT_TESTED).toBe(SHA_B)
  })

  // NC4 / NC15: evidence SHA (git rev-parse HEAD) must equal the resolved
  // EXPECTED_SHA the workflow reported; a mismatch (whichever side is
  // "wrong") must fail closed rather than silently emit evidence for the
  // wrong tree.
  it('NC4/NC15: throws when the checked-out HEAD does not match the resolved EXPECTED_SHA', () => {
    expect(() => buildEvidence(git(), { ...baseEnv, expectedSha: SHA_B })).toThrow(/does not match resolved EXPECTED_SHA/)
  })

  it('throws when the working tree is dirty at evidence time', () => {
    const dirtyGit = fakeGit({
      'rev-parse HEAD': `${SHA_A}\n`,
    })
    // diff --quiet is unscripted here, so it throws exactly as a real dirty
    // tree would.
    expect(() => buildEvidence(dirtyGit, baseEnv)).toThrow()
  })

  // NC14 via the full assembly path, not just the isolated helper.
  it('NC14 (assembled): throws when the merge-ref SHA equals EVIDENCE_SHA', () => {
    expect(() =>
      buildEvidence(git(), {
        ...baseEnv,
        eventName: 'pull_request',
        ref: 'refs/pull/7/merge',
        expectedSource: 'pull_request.head.sha',
        mergeRefSha: SHA_A,
      }),
    ).toThrow(/equals the synthetic PR merge-ref SHA/)
  })
})

describe('evidenceArtifactName', () => {
  // NC9: artifact name must contain the SHA.
  it('NC9: the artifact name embeds the exact SHA', () => {
    expect(evidenceArtifactName(SHA_A)).toBe(`exact-sha-evidence-${SHA_A}`)
    expect(evidenceArtifactName(SHA_A)).toContain(SHA_A)
  })
})

describe('ci.yml — workflow-level trigger and step-ordering properties', () => {
  it('NC2/NC3: push triggers on both main and integration/commercial-v1', () => {
    const ci = readCiYaml()
    const onBlock = ci.slice(ci.indexOf('\non:'), ci.indexOf('\njobs:'))
    expect(onBlock).toMatch(/branches:\s*\[main,\s*integration\/commercial-v1\]/)
  })

  // NC1: checkout must use the resolved SHA, not the default trigger ref.
  it('NC1: the Checkout step uses the resolved SHA as its ref', () => {
    const block = stepBlock(readCiYaml(), '- name: Checkout')
    expect(block).toMatch(/ref:\s*\$\{\{\s*steps\.resolve_sha\.outputs\.sha\s*\}\}/)
    expect(block).toMatch(/fetch-depth:\s*0\b/)
  })

  it('the resolver step never writes a naive `a || b` fallback expression', () => {
    const ci = readCiYaml()
    expect(ci).not.toMatch(/pull_request\.head\.sha\s*\|\|\s*github\.sha/)
  })

  it('the resolver`s pull_request branch never reads PUSH_OR_DISPATCH_SHA', () => {
    const ci = readCiYaml()
    const resolveBlock = stepBlock(ci, '- name: Resolve exact event SHA')
    const prBranch = resolveBlock.slice(resolveBlock.indexOf('pull_request)'), resolveBlock.indexOf(';;'))
    expect(prBranch).not.toMatch(/PUSH_OR_DISPATCH_SHA/)
  })

  it('a guard step exists for the PR synthetic merge ref', () => {
    const block = stepBlock(readCiYaml(), '- name: Guard against testing the PR synthetic merge ref')
    expect(block).toMatch(/merge_commit_sha/)
    expect(block).toMatch(/exit 1/)
  })

  // NC9 at the workflow level: the artifact name must be templated with the SHA.
  it('NC9: the upload-artifact step names the artifact with the resolved SHA', () => {
    const block = stepBlock(readCiYaml(), '- name: Upload exact-SHA evidence artifact')
    expect(block).toMatch(/name:\s*exact-sha-evidence-\$\{\{\s*steps\.resolve_sha\.outputs\.sha\s*\}\}/)
  })

  // NC11: no `if: always()` on the evidence emission step.
  it('NC11: the evidence emission step has no if: always()', () => {
    const block = stepBlock(readCiYaml(), '- name: Emit exact-SHA CI evidence')
    expect(block).not.toMatch(/if:\s*always\(\)/)
  })

  // NC12: no continue-on-error on the evidence emission step.
  it('NC12: the evidence emission step has no continue-on-error', () => {
    const block = stepBlock(readCiYaml(), '- name: Emit exact-SHA CI evidence')
    expect(block).not.toMatch(/continue-on-error:\s*true/)
  })

  // NC13: evidence must be emitted only after Test and Build.
  it('NC13: evidence emission runs after both Test and Build', () => {
    const ci = readCiYaml()
    const testIndex = ci.indexOf('run: pnpm test:unit')
    const buildIndex = ci.indexOf('run: pnpm build')
    const evidenceIndex = ci.indexOf('- name: Emit exact-SHA CI evidence')
    expect(testIndex).toBeGreaterThan(-1)
    expect(buildIndex).toBeGreaterThan(-1)
    expect(evidenceIndex).toBeGreaterThan(testIndex)
    expect(evidenceIndex).toBeGreaterThan(buildIndex)
  })

  it('the artifact upload step is the last step in the job', () => {
    const ci = readCiYaml()
    const uploadIndex = ci.indexOf('- name: Upload exact-SHA evidence artifact')
    expect(uploadIndex).toBeGreaterThan(-1)
    // No further "- name:" step follows it.
    expect(ci.indexOf('- name:', uploadIndex + 1)).toBe(-1)
  })

  it('the evidence emission step invokes scripts/ci-exact-sha-evidence.ts', () => {
    const block = stepBlock(readCiYaml(), '- name: Emit exact-SHA CI evidence')
    expect(block).toMatch(/scripts\/ci-exact-sha-evidence\.ts/)
  })
})

describe('mutation self-test — the NC1 check actually detects a real survivor', () => {
  // Proves the checkout-ref regex check above is not vacuous: it fails when
  // the very thing it is supposed to catch (a checkout without the resolved
  // ref) is reintroduced. Mutates an in-memory copy of the real ci.yml text
  // only — the checked-in file is never touched.
  function assertCheckoutUsesResolvedRef(ciYamlText: string): void {
    const idx = ciYamlText.indexOf('- name: Checkout')
    if (idx === -1) throw new Error('no Checkout step found')
    const blockStart = ciYamlText.lastIndexOf('- name:', idx)
    const blockEnd = ciYamlText.indexOf('- name:', idx + 1)
    const block = ciYamlText.slice(blockStart, blockEnd === -1 ? undefined : blockEnd)
    if (!/ref:\s*\$\{\{\s*steps\.resolve_sha\.outputs\.sha\s*\}\}/.test(block)) {
      throw new Error('Checkout step does not pin ref to the resolved SHA')
    }
  }

  it('passes on the real, unmutated ci.yml', () => {
    expect(() => assertCheckoutUsesResolvedRef(readCiYaml())).not.toThrow()
  })

  it('fails on a mutant with the resolved ref stripped from the Checkout step', () => {
    const real = readCiYaml()
    const mutated = real.replace('ref: ${{ steps.resolve_sha.outputs.sha }}\n          ', '')
    // Sanity: the mutation actually removed something (the mutant differs).
    expect(mutated).not.toBe(real)
    expect(() => assertCheckoutUsesResolvedRef(mutated)).toThrow(/does not pin ref/)
  })
})

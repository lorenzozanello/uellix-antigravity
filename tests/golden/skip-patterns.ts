// tests/golden/skip-patterns.ts
//
// THE BYPASS PATTERNS, HELD AWAY FROM THE FILE THAT ENFORCES THEM.
//
// ===========================================================================
// WHY THIS IS A SEPARATE MODULE
// ===========================================================================
// The meta guard scans every collected Golden file for skip markers. It must
// scan ITSELF — a policing file exempt from its own policy is precisely where
// a bypass would be parked, and "the checker is excluded from the check" is
// not a property anyone can rely on.
//
// But if the pattern literals lived inside the guard, the guard's own source
// would contain the strings it searches for, and it would flag itself on every
// run. The usual escape is to exclude the file, which reintroduces the hole.
//
// Holding the literals here removes the conflict instead of trading one defect
// for the other: the guard's source contains no marker, so it can be scanned
// like any other file, and this module contains markers but is collected by no
// runner — `playwright.config.ts` matches only `*.journey.ts` and `*.guard.ts`,
// and Vitest's default glob matches neither of those nor this. A skip marker
// written into this file would be inert text.
//
// ===========================================================================
// WHY THE PATTERNS REQUIRE CALL POSITION
// ===========================================================================
// Every pattern demands an opening parenthesis. `test.skip(` is a bypass;
// the substring `.skip` inside a comment, a string, or a regular expression is
// not. Matching the bare substring would make prose about skipping
// indistinguishable from skipping, and a guard that cannot tell those apart
// gets switched off by the first false positive.

/** One recognised bypass form. */
export interface BypassPattern {
  readonly id: string
  readonly pattern: RegExp
  readonly why: string
}

/**
 * The forms that remove a test from a run without failing it.
 *
 * `only` is included even though it adds rather than removes: it reduces the
 * battery to whatever it marks while still exiting zero, which is the same
 * observable outcome as skipping everything else. `playwright.config.ts` also
 * sets `forbidOnly`, so this is the second of two independent controls on it.
 */
export const BYPASS_PATTERNS: readonly BypassPattern[] = [
  {
    id: 'test-skip',
    pattern: /\btest\s*\.\s*skip\s*\(/,
    why: 'removes the test from the run without failing it',
  },
  {
    id: 'test-fixme',
    pattern: /\btest\s*\.\s*fixme\s*\(/,
    why: 'marks the test as expected-broken and does not run it',
  },
  {
    id: 'test-only',
    pattern: /\btest\s*\.\s*only\s*\(/,
    why: 'reduces the battery to this test alone while still exiting zero',
  },
  {
    id: 'describe-skip',
    pattern: /\bdescribe\s*\.\s*skip\s*\(/,
    why: 'removes an entire group from the run',
  },
  {
    id: 'describe-fixme',
    pattern: /\bdescribe\s*\.\s*fixme\s*\(/,
    why: 'marks an entire group as expected-broken',
  },
  {
    id: 'describe-only',
    pattern: /\bdescribe\s*\.\s*only\s*\(/,
    why: 'reduces the battery to one group',
  },
  {
    id: 'bare-skip-call',
    pattern: /(?:^|[^.\w])skip\s*\(\s*\)/m,
    why: 'a bare skip() inside a test body abandons it mid-flight and still reports success',
  },
  {
    id: 'test-info-skip',
    pattern: /testInfo\s*\.\s*skip\s*\(/,
    why: 'a runtime skip driven from test info, invisible in the source as a marker',
  },
]

export interface BypassFinding {
  readonly file: string
  readonly patternId: string
  readonly why: string
  /** The matched text, so a failure names what was found rather than only that something was. */
  readonly matched: string
}

/**
 * Scan (path, content) pairs for bypass markers.
 *
 * Pure, and takes its input rather than reading the filesystem, so the meta
 * guard can drive it with a fixture known to contain markers and prove it
 * actually reports them. A scanner whose only input is a tree that happens to
 * be clean has never been shown capable of returning a finding, and is
 * indistinguishable from one that returns the empty list unconditionally.
 *
 * Content is matched as ONE STRING, never line by line: a call split across
 * lines by a formatter is still a bypass, and a line-oriented scan would miss
 * it while reporting the reassuring answer.
 */
export function scanForBypasses(
  files: ReadonlyArray<readonly [string, string]>,
): readonly BypassFinding[] {
  const findings: BypassFinding[] = []
  for (const [file, content] of files) {
    for (const { id, pattern, why } of BYPASS_PATTERNS) {
      const match = pattern.exec(content)
      if (match) findings.push({ file, patternId: id, why, matched: match[0] })
    }
  }
  return findings
}

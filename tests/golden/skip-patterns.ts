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

/**
 * Blank out comments AND string-literal text so only EXECUTABLE code is scanned.
 *
 * ===========================================================================
 * WHY THIS IS NECESSARY, AND WHY IT DOES NOT WEAKEN THE SCAN
 * ===========================================================================
 * Widening the scan from Playwright's collected files to every `.ts` under
 * `tests/golden/` immediately produced three findings, all of them PROSE: this
 * module's own documentation quotes `test.skip(` and `skip()` while explaining
 * what they are, and the meta guard quotes `test.skip(` while explaining the
 * hole it closes.
 *
 * Requiring call position — an opening parenthesis — was enough to separate a
 * bypass from a bare mention of `.skip`, but it cannot separate a bypass from a
 * faithful QUOTATION of one. The missing predicate is not "looks like a call",
 * it is "is code".
 *
 * String literals need the same treatment and for the same reason: a second
 * pass found two markers held in strings — this module's own `why` text, and
 * the meta guard's positive-control test DATA, which necessarily contains a
 * real-looking bypass. Neither executes.
 *
 * This makes the scan strictly MORE accurate, not more permissive: a marker
 * inside a comment or a string cannot remove a test from a run. There is no
 * bypass that this hides — and the meta guard proves it by scanning a source
 * whose bypass sits after a `https://` string and inside a `${…}`.
 *
 * ===========================================================================
 * WHY A CHARACTER SCANNER AND NOT A REGULAR EXPRESSION
 * ===========================================================================
 * The naive `replace(/\/\/.*$/gm, '')` is wrong in a way that would silently
 * delete real code: a string containing `https://` would be truncated at the
 * `//`, taking the rest of the line — potentially including a real bypass —
 * out of the scan. So string literals are tracked, in all three quotings, with
 * escape handling, and only a `/` found OUTSIDE a string can open a comment.
 *
 * Comments are replaced by spaces rather than removed, so byte offsets — and
 * therefore any future line reporting — stay aligned with the original file.
 */
export function stripNonExecutableForScan(source: string): string {
  const out = source.split('')

  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' '
    }
  }

  let index = 0
  while (index < source.length) {
    const char = source[index]

    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      blank(index, stop)
      index = stop
      continue
    }

    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }

    if (char === "'" || char === '"') {
      // Blank the INTERIOR, keep the quotes, so the surrounding expression
      // still parses as the same shape to a later reader.
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (source[cursor] === char || source[cursor] === '\n') break
        cursor += 1
      }
      blank(index + 1, cursor)
      index = cursor + 1
      continue
    }

    if (char === '`') {
      // Template literal. The literal CHUNKS are blanked, but every `${…}`
      // interpolation is left intact, because it is real executable code and
      // blanking it could hide a genuine bypass written inside one.
      let cursor = index + 1
      let chunkStart = cursor
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (source[cursor] === '`') break
        if (source[cursor] === '$' && source[cursor + 1] === '{') {
          blank(chunkStart, cursor)
          let depth = 1
          cursor += 2
          while (cursor < source.length && depth > 0) {
            if (source[cursor] === '{') depth += 1
            else if (source[cursor] === '}') depth -= 1
            cursor += 1
          }
          chunkStart = cursor
          continue
        }
        cursor += 1
      }
      blank(chunkStart, cursor)
      index = cursor + 1
      continue
    }

    index += 1
  }

  return out.join('')
}

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
    // Comments blanked FIRST. See `stripNonExecutableForScan` for why a quoted
    // marker in documentation is not a bypass and must not be reported as one.
    const executable = stripNonExecutableForScan(content)
    for (const { id, pattern, why } of BYPASS_PATTERNS) {
      const match = pattern.exec(executable)
      if (match) findings.push({ file, patternId: id, why, matched: match[0] })
    }
  }
  return findings
}

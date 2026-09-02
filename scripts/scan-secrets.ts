// scripts/scan-secrets.ts
//
// CI gate: refuse a tree (or a staged delta) that carries a real credential.
//
// It exists because one did. On 2026-07-06 the audit report committed in
// `782ac5f` quoted the contents of `.env` verbatim, which put the PostgreSQL
// password of the Production project into the repository — where it stayed for
// six weeks, across 595 commits, until the 2026-08-15 rotation. Nothing in the
// repository was watching, so nothing objected.
//
// TWO PROPERTIES MATTER MORE THAN COVERAGE.
//
// 1. It never prints a secret. A scanner that echoes the offending line to make
//    the failure actionable copies the secret into CI logs, PR checks and
//    terminal scrollback — it spreads what it was hired to contain. This one
//    prints the file, the line, the kind, and a 12-hex-char SHA-256 prefix.
//    That prefix is enough to prove "this is the same value as that one" and far
//    too little to reconstruct it.
//
// 2. It parses structure, it does not match substrings. `scripts/
//    ci-assert-local-targets.ts` records why: a `grep -E "127.0.0.1|localhost"`
//    accepts `localhost.attacker.example`. A DSN is therefore split into user,
//    password and host, and each component is judged as what it is.
//
// ---------------------------------------------------------------------------
// WHAT DECIDES, AND WHAT ONLY DESCRIBES
// ---------------------------------------------------------------------------
// The first version of this gate decided on the HOST: a DSN aimed at
// `db.x.supabase.co` was waved through whatever its password was. Independent
// review closed that, because it had the polarity backwards — it let the
// PUBLIC half of a credential vouch for the SECRET half. Sanitising the
// hostname of a leaked DSN while keeping the password is a one-line edit no
// reviewer would question, and this gate would have applauded it.
//
// So the verdict is taken on the CREDENTIAL COMPONENT ITSELF. A password, a
// token or a key is ignored only when
//
//   (a) the value announces itself as a fixture — `[YOUR-PASSWORD]`, an
//       unexpanded `${...}`, or a body carrying a marker such as
//       `not-a-real`, `placeholder`, `example`, `fake`, `synthetic`; or
//   (b) the line carries an explicit `secret-scan-ok: <reason>`.
//
// The host is still parsed, and `isSyntheticHost` still exists — but only to
// LABEL a finding ("this host cannot resolve"), never to excuse one. Triage
// context, not a verdict.
//
// ---------------------------------------------------------------------------
// PARITY WITH GITHUB PUSH PROTECTION
// ---------------------------------------------------------------------------
// On 2026-08-15 a push of this branch was rejected with GH013: GitHub Push
// Protection classified `sbp_`-prefixed literals in
// `tests/hosted/target-identity.test.ts` as Supabase Personal Access Tokens.
// This gate had no such detector — a remote check caught what the local one
// did not, which is the wrong way round for a gate whose job is to fail before
// the push. `SUPABASE_PERSONAL_ACCESS_TOKEN` closes the gap, and deliberately
// at a lower threshold than GitHub's own 40-hex shape, so a truncated or
// re-encoded token is still a finding.
//
// Usage:
//   pnpm secrets:scan            scan every tracked file
//   pnpm secrets:scan:staged     scan the staged delta only (pre-commit)

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
} from '../db/hosted/target-identity'

/** A finding kind. Stable — the runbook and the tests cite these by name. */
export type SecretFindingKind =
  | 'PG_DSN_EMBEDDED_PASSWORD'
  | 'JWT_LIKE'
  | 'GOOGLE_API_KEY'
  | 'SUPABASE_SECRET_KEY'
  | 'SUPABASE_PERSONAL_ACCESS_TOKEN'
  | 'OPENAI_STYLE_KEY'
  | 'PRIVATE_KEY_BLOCK'

export interface SecretFinding {
  readonly file: string
  readonly line: number
  readonly kind: SecretFindingKind
  /** SHA-256 of the secret, truncated to 12 hex chars. NEVER the value. */
  readonly fingerprint: string
  /** Length and character classes. Not invertible. */
  readonly shape: string
  /** Non-secret context, e.g. the parsed user and host of a DSN. */
  readonly context: string
}

/**
 * Supabase project refs that appear in fixtures and cannot address anything.
 *
 * These NO LONGER suppress a finding — see "what decides, and what only
 * describes" above. They survive because a finding that says "this host cannot
 * resolve" is faster to triage than one that does not, and because
 * `assertAllowlistIsSynthetic` uses the same list as a tripwire.
 */
const SYNTHETIC_SUPABASE_REFS: readonly string[] = [
  'x',
  'abc',
  'projectref123',
  'abcdefghijklmnopqrst',
  'ejemplo-remoto',
]

/** RFC 2606 / RFC 6761 names reserved so they can never resolve to real infrastructure. */
const RESERVED_SUFFIXES: readonly string[] = [
  '.example',
  '.example.com',
  '.example.org',
  '.example.net',
  '.test',
  '.invalid',
  '.localhost',
]

const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal)$/i

/**
 * A whole value that is a placeholder rather than a credential: the forms a
 * template, a runbook or a docker-compose file legitimately carries.
 */
const PLACEHOLDER_LITERAL =
  /^(\[?YOUR[-_ ]?PASSWORD\]?|<[^>]*>|\{\{?[^}]*\}?\}|password|postgres|pass|secret|changeme|dev|local|test|example|x+|xxx+|\*+|\.\.\.|…|REDACTED.*|\$\{[^}]*\}|%[A-Z_]+%)$/i

/**
 * A marker INSIDE the value that announces it as fixture material.
 *
 * This is the ergonomic half of the gate: a suite that needs a credential-
 * SHAPED literal can have one, provided the literal says so in its own body.
 * The words are chosen to be ones a high-entropy issued credential cannot
 * plausibly contain — `fake` and `placeholder` are not hexadecimal, and the
 * odds of any of them falling out of a random base62 run are ~10⁻⁶.
 *
 * Unlike the hostname rule it replaces, this reads the SECRET half of the
 * credential. A leaked password does not acquire the word `synthetic`.
 */
const FIXTURE_MARKER =
  /(not[-_ ]?a[-_ ]?real|placeholder|example|sample|fake|synthetic|dummy|fixture|redacted)/i

/** True when the credential component itself is unambiguously non-secret. */
export function isUnmistakablePlaceholder(value: string): boolean {
  return PLACEHOLDER_LITERAL.test(value) || FIXTURE_MARKER.test(value)
}

/**
 * The escape hatch, for a literal that is a fixture but cannot say so in its
 * own body — a token whose exact bytes the assertion depends on, say.
 *
 *   // secret-scan-ok: synthetic key, this suite feeds it to the redactor
 *
 * A REASON IS REQUIRED. A bare marker would let a suppression be added as
 * reflexively as it is read past; making the author write the sentence is the
 * only part of this that a reviewer can actually disagree with. It applies to
 * the line it sits on and to the line below it, and to nothing else — a
 * file-wide switch is how a gate quietly stops covering the file.
 */
const ALLOW_ANNOTATION = /secret-scan-ok:\s*\S+/

/**
 * Paths not scanned.
 *
 * This list used to hold this script and its suite. Both were removed: a
 * file-wide switch is the thing the annotation above is designed to avoid, and
 * exempting the gate's own test file is how a gate stops noticing that its
 * fixtures drifted into real shapes. They are scanned like everything else, and
 * the two lines that genuinely need a credential-shaped literal carry an
 * annotation. What remains is a generated lockfile whose integrity hashes are
 * base64 runs that no detector should be asked to reason about.
 */
const EXEMPT_PATHS: readonly RegExp[] = [/^pnpm-lock\.yaml$/]

/** Git's -z separator, and the byte that marks a blob as binary. */
const NUL = '\u0000'

const fingerprint = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)

const shapeOf = (value: string): string => {
  const classes: string[] = []
  if (/[a-z]/.test(value)) classes.push('a-z')
  if (/[A-Z]/.test(value)) classes.push('A-Z')
  if (/[0-9]/.test(value)) classes.push('0-9')
  if (/[^A-Za-z0-9]/.test(value)) classes.push('sym')
  return `len=${value.length} [${classes.join(',')}]`
}

/** Strip the port and any trailing comma-separated failover hosts. */
const bareHost = (host: string): string => (host.split(',')[0] ?? '').split(':')[0] ?? ''

/**
 * True when this host demonstrably cannot address real infrastructure.
 *
 * CONTEXT ONLY. Nothing in this file suppresses a finding because of what this
 * returns; it decorates the finding so a reviewer can tell "fixture pointed at
 * nowhere" from "credential pointed at Production" at a glance. It is exported
 * because `assertAllowlistIsSynthetic` and the suite both interrogate it.
 */
export function isSyntheticHost(host: string): boolean {
  if (host.includes('${') || host.includes('{{') || host.includes('%')) return true
  const bare = bareHost(host)
  if (bare === '') return false
  if (LOOPBACK.test(bare)) return true
  if (RESERVED_SUFFIXES.some((s) => bare === s.slice(1) || bare.endsWith(s))) return true

  const supabase = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(bare)
  if (supabase) return SYNTHETIC_SUPABASE_REFS.includes(supabase[1]!.toLowerCase())

  // A single label with no dot is a stub like `h` in an error-formatting test.
  if (!bare.includes('.')) return true

  return false
}

/**
 * Refuse to run if the fixture allowlist has drifted onto something real.
 *
 * Less load-bearing than it was — the allowlist no longer excuses anything —
 * but kept, and kept fatal, for two reasons. A finding labelled "this host
 * cannot resolve" while pointing at Production would misdirect the very triage
 * the label exists to speed up; and if a future edit ever reconnects the
 * hostname to the verdict, this is the tripwire that was already armed.
 */
export function assertAllowlistIsSynthetic(): void {
  const real = new Set<string>([
    ...KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.map((r) => r.toLowerCase()),
    KNOWN_STAGING_PROJECT_REF.toLowerCase(),
  ])
  const collisions = SYNTHETIC_SUPABASE_REFS.filter((r) => real.has(r.toLowerCase()))
  if (collisions.length > 0) {
    throw new Error(
      `SYNTHETIC_SUPABASE_REFS names ${collisions.length} real project ref(s). ` +
        'Remove them: an allowlist that covers a real target is worse than no gate at all.'
    )
  }
  const realHosts = KNOWN_PRODUCTION_IDENTIFIERS.hosts.map((h) => h.toLowerCase())
  const hostCollisions = realHosts.filter((h) => isSyntheticHost(h))
  if (hostCollisions.length > 0) {
    throw new Error(
      `isSyntheticHost() accepts known production host(s): ${hostCollisions.join(', ')}.`
    )
  }
}

interface Detector {
  readonly kind: SecretFindingKind
  readonly pattern: RegExp
  /** Returns the secret value plus non-secret context, or null to ignore. */
  readonly extract: (m: RegExpExecArray) => { value: string; context: string } | null
}

/** A token detector: the whole match is the secret, and only its own body can excuse it. */
const token = (kind: SecretFindingKind, pattern: RegExp): Detector => ({
  kind,
  pattern,
  extract: (m) => (isUnmistakablePlaceholder(m[0]) ? null : { value: m[0], context: '' }),
})

const DETECTORS: readonly Detector[] = [
  {
    kind: 'PG_DSN_EMBEDDED_PASSWORD',
    pattern: /postgres(?:ql)?:\/\/([^\s:@/'"`]+):([^\s@/'"`]+)@([^\s/'"`?]+)/g,
    extract: (m) => {
      const [, user, password, host] = m as unknown as [string, string, string, string]
      // THE VERDICT IS THE PASSWORD'S. The host follows it into the report; it
      // never decides whether there is one.
      if (isUnmistakablePlaceholder(password)) return null
      if (password.length < 6) return null
      const unreachable = isSyntheticHost(host) ? ' (host cannot resolve)' : ''
      return { value: password, context: `user=${user} host=${bareHost(host)}${unreachable}` }
    },
  },
  token('JWT_LIKE', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g),
  token('GOOGLE_API_KEY', /\bAIza[0-9A-Za-z_-]{35}\b/g),
  token('SUPABASE_SECRET_KEY', /\bsb_secret_[A-Za-z0-9_-]{20,}/g),
  // The legacy Supabase Personal Access Token: `sbp_` + 40 lowercase hex.
  // Matched at 20+ of any token character rather than exactly 40 hex, so a
  // truncated, re-cased or separator-broken copy is still a finding — the
  // evasions that would satisfy GitHub's stricter pattern while leaving the
  // token perfectly recoverable.
  token('SUPABASE_PERSONAL_ACCESS_TOKEN', /\bsbp_[A-Za-z0-9_-]{20,}/g),
  token('OPENAI_STYLE_KEY', /\bsk-[A-Za-z0-9_-]{20,}/g),
  {
    kind: 'PRIVATE_KEY_BLOCK',
    // No placeholder path: a PEM header is never fixture material by virtue of
    // its own contents, so this one is annotation-gated or nothing.
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    extract: (m) => ({ value: m[0], context: '' }),
  },
]

/** Scan one blob of text. Pure — the tests drive this directly. */
export function scanText(text: string, file: string): SecretFinding[] {
  if (text.includes(NUL)) return []
  const findings: SecretFinding[] = []
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const allowed =
      ALLOW_ANNOTATION.test(line) || ALLOW_ANNOTATION.test(lines[i - 1] ?? '')
    if (allowed) continue
    for (const detector of DETECTORS) {
      detector.pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = detector.pattern.exec(line)) !== null) {
        const hit = detector.extract(match)
        if (hit === null) continue
        findings.push({
          file,
          line: i + 1,
          kind: detector.kind,
          fingerprint: fingerprint(hit.value),
          shape: shapeOf(hit.value),
          context: hit.context,
        })
      }
    }
  }
  return findings
}

const git = (args: readonly string[]): string =>
  execFileSync('git', [...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

function scanTrackedTree(): SecretFinding[] {
  const files = git(['ls-files', '-z']).split(NUL).filter(Boolean)
  const findings: SecretFinding[] = []
  for (const file of files) {
    if (EXEMPT_PATHS.some((r) => r.test(file))) continue
    let text: string
    try {
      const buffer = readFileSync(file)
      if (buffer.length > 2 * 1024 * 1024) continue
      text = buffer.toString('utf8')
    } catch {
      continue
    }
    findings.push(...scanText(text, file))
  }
  return findings
}

function scanStagedDelta(): SecretFinding[] {
  const names = git(['diff', '--cached', '--name-only', '-z']).split(NUL).filter(Boolean)
  const findings: SecretFinding[] = []
  for (const file of names) {
    if (EXEMPT_PATHS.some((r) => r.test(file))) continue
    let blob: string
    try {
      blob = git(['show', `:${file}`])
    } catch {
      continue // deleted in the index
    }
    findings.push(...scanText(blob, file))
  }
  return findings
}

function main(): void {
  assertAllowlistIsSynthetic()

  const staged = process.argv.includes('--staged')
  const scope = staged ? 'STAGED_DELTA' : 'CURRENT_TREE'
  const findings = staged ? scanStagedDelta() : scanTrackedTree()

  if (findings.length === 0) {
    console.log(`✅ ${scope}: no credential material found.`)
    return
  }

  console.error(`🚨 ${scope}: ${findings.length} finding(s). Values withheld by design.\n`)
  for (const f of findings) {
    console.error(
      `  ${f.file}:${f.line}  ${f.kind}  sha256:12=${f.fingerprint}  ${f.shape}` +
        (f.context ? `  ${f.context}` : '')
    )
  }
  console.error(
    '\nIf it is real: rotate it FIRST, then redact — redacting first leaves the credential ' +
      'live in history and destroys the only record of what needed rotating.\n' +
      'If it is a fixture, change the CREDENTIAL, not the hostname: a value carrying ' +
      '`not-a-real`, `placeholder`, `fake` or an unexpanded `${...}` is recognised as one. ' +
      'Where the exact bytes are load-bearing, annotate the line with a reason. ' +
      'A synthetic-looking host no longer excuses a real-looking secret. ' +
      'See docs/ops/CREDENTIAL_HYGIENE.md.'
  )
  process.exit(1)
}

// Only when run as a script. `tests/scan-secrets.test.ts` imports the pure
// functions above, and a bare `main()` would scan the whole tree — and possibly
// call process.exit — in the middle of the suite. Compared against argv rather
// than `import.meta.url` because this package is CommonJS and the scripts run
// under tsx, where `import.meta` is not reliably present.
const invokedDirectly = (process.argv[1] ?? '')
  .replace(/\\/g, '/')
  .endsWith('scripts/scan-secrets.ts')

if (invokedDirectly) main()

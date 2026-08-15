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
//    password and host, and the verdict is taken on the parsed host.
//
// THE FIXTURE PROBLEM. This repository is full of DSNs on purpose — the safety
// classifier suites feed it hostile ones. A gate that cannot tell
// `db.x.supabase.co` from `db.ctaxtgujyyprgynmnvtq.supabase.co` is a gate that
// gets switched off in a week. Fixtures are recognised by their HOST, through
// rules that a real target cannot satisfy by accident: loopback, the RFC 2606
// reserved names, an unexpanded `${...}` template, or an explicit entry in
// SYNTHETIC_SUPABASE_REFS. And because an allowlist is only ever one careless
// edit from naming something real, `assertAllowlistIsSynthetic` refuses to run
// at all if any entry collides with `KNOWN_PRODUCTION_IDENTIFIERS` or with
// `KNOWN_STAGING_PROJECT_REF`.
//
// Usage:
//   pnpm scan:secrets            scan every tracked file
//   pnpm scan:secrets --staged   scan the staged delta only (pre-commit)

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
 * A real ref is twenty lowercase letters, and so are several of these, so the
 * shape alone cannot separate them — the list is explicit on purpose, and
 * `assertAllowlistIsSynthetic` is what keeps it honest.
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
 * Passwords that carry no secret: placeholders, and the short literals the
 * ephemeral docker containers in `scripts/` use.
 */
const PLACEHOLDER_PASSWORD =
  /^(\[?YOUR[-_ ]?PASSWORD\]?|<[^>]*>|\{\{?[^}]*\}?\}|password|postgres|pass|secret|changeme|dev|local|test|example|x+|xxx+|\*+|\.\.\.|…|REDACTED.*|\$\{[^}]*\}|%[A-Z_]+%)$/i

/**
 * The escape hatch, for a literal that is a fixture but cannot be recognised as
 * one by its shape — a fake API key fed to the redactor, say, where there is no
 * host to reason about.
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

/** Paths whose whole purpose is to describe the incident, or to test this scanner. */
const EXEMPT_PATHS: readonly RegExp[] = [
  /^scripts\/scan-secrets\.ts$/,
  /^tests\/scan-secrets\.test\.ts$/,
  /^pnpm-lock\.yaml$/,
]

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
 * Deliberately positive: an unrecognised host is a finding, not a pass. A gate
 * that fails open on the unfamiliar would have said nothing about
 * `db.ctaxtgujyyprgynmnvtq.supabase.co` on 2026-07-06.
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
 * The allowlist is the one part of this gate that weakens it, and it weakens it
 * silently: appending the wrong twenty letters would make the next leak of the
 * Production ref invisible. So the collision is checked, every run, against the
 * repository's own record of which refs are real.
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

const DETECTORS: readonly Detector[] = [
  {
    kind: 'PG_DSN_EMBEDDED_PASSWORD',
    pattern: /postgres(?:ql)?:\/\/([^\s:@/'"`]+):([^\s@/'"`]+)@([^\s/'"`?]+)/g,
    extract: (m) => {
      const [, user, password, host] = m as unknown as [string, string, string, string]
      if (PLACEHOLDER_PASSWORD.test(password)) return null
      if (password.length < 6) return null
      if (isSyntheticHost(host)) return null
      return { value: password, context: `user=${user} host=${bareHost(host)}` }
    },
  },
  {
    kind: 'JWT_LIKE',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    extract: (m) => ({ value: m[0], context: '' }),
  },
  {
    kind: 'GOOGLE_API_KEY',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    extract: (m) => ({ value: m[0], context: '' }),
  },
  {
    kind: 'SUPABASE_SECRET_KEY',
    pattern: /\bsb_secret_[A-Za-z0-9_-]{20,}/g,
    extract: (m) => ({ value: m[0], context: '' }),
  },
  {
    kind: 'OPENAI_STYLE_KEY',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/g,
    extract: (m) => ({ value: m[0], context: '' }),
  },
  {
    kind: 'PRIVATE_KEY_BLOCK',
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
    '\nIf this is a fixture, give it a host that cannot resolve — a loopback address, ' +
      'an RFC 2606 name such as `db.example.com`, or a ref listed in SYNTHETIC_SUPABASE_REFS. ' +
      'If it is real: rotate it FIRST, then redact. See docs/ops/CREDENTIAL_HYGIENE.md.'
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

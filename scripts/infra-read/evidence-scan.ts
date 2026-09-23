// scripts/infra-read/evidence-scan.ts
//
// SUPPLEMENTAL secret scan for control-plane read evidence. ADDITIVE to
// `pnpm secrets:scan`, which it does not replace or weaken.
//
// Why it exists: scripts/scan-secrets.ts has seven detector families
// (PG DSN password, JWT-like, Google key, Supabase secret/PAT, OpenAI-style,
// private key block). It has nothing for the credential classes this read
// authority actually handles: GitHub OAuth/PAT token families, Vercel session
// tokens, Vercel deploy-hook URLs, Authorization/Cookie material, or an
// environment variable VALUE. A green `secrets:scan` is therefore not evidence
// of absence for any of them.
//
// Findings report a detector id and an offset, NEVER the matched text: a scanner
// that echoes what it found is itself a leak.
//
// Deliberately NOT done: exact-match comparison against the host's live
// credential values. That would require reading the token into this process,
// which the owner's DF11 ratification forbids ("MUST NEVER observe").

import { readFileSync } from 'node:fs'

export interface Detector { readonly id: string; readonly re: RegExp }

export const DETECTORS: readonly Detector[] = [
  { id: 'GITHUB_TOKEN_FAMILY', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  // v1.0.5. MEASURED in the installed Vercel CLI 54.14.2 bundle: `vcp_` is the only
  // token-prefix literal it carries. Prefix-anchored, so it is discriminating.
  { id: 'VERCEL_VCP_TOKEN', re: /\bvcp_[A-Za-z0-9]{16,}/ },
  { id: 'VERCEL_DEPLOY_HOOK_URL', re: /api\.vercel\.com\/v[0-9]+\/integrations\/deploy\//i },
  // An optional scheme word (token / Bearer / Basic) precedes the value; GitHub's own form is `Authorization: token <x>`.
  { id: 'AUTHORIZATION_HEADER', re: /\b(?:proxy-)?authorization\b["']?\s*[:=]\s*["']?(?:[A-Za-z]+\s+)?\S{6,}/i },
  { id: 'BEARER_OR_BASIC_CREDENTIAL', re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i },
  { id: 'COOKIE_MATERIAL', re: /\b(?:set-cookie|cookie)\b["']?\s*[:=]/i },
  { id: 'SECRET_KEYED_FIELD', re: /"(?:token|accessToken|access_token|refreshToken|refresh_token|secret|clientSecret|client_secret|password|privateKey|private_key)"\s*:\s*"[^"]{6,}"/i },
  // A non-empty "value" is what an environment row carries when decrypted or plain.
  { id: 'ENV_VALUE_FIELD', re: /"value"\s*:\s*"[^"]+"/ },
  // v1.0.5: ANY userinfo, not only user:password. `https://<token>@host` and
  // `https://x-access-token:<token>@host` both carry the credential; a
  // colon-less userinfo was invisible to the v1.0.4 form.
  { id: 'URL_USERINFO', re: /[a-z][a-z0-9+.-]*:\/\/[^/\s@"'<>]+@/i },
  // v1.0.5: a credential-NAMED variable assigned a literal. Shell / .env / cmd form
  // (`NAME=value`, no spaces, as a leaked environment dump prints it) and the
  // PowerShell form (`$env:NAME = "value"`). Names are matched case-insensitively
  // (Windows: Gh_Token IS GH_TOKEN). A value starting with $ or % is a reference,
  // not a secret, and is not reported. Source code (`X = 'y'`, with spaces) is
  // deliberately outside the shell form.
  { id: 'ENV_ASSIGNMENT_SECRET', re: /(?:\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSW(?:OR)?D?|API_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE|AUTH)[A-Za-z0-9_]*=["']?(?![$%])[A-Za-z0-9._~+/:@-]{8,}|\$env:[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSW(?:OR)?D?|API_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE|AUTH)[A-Za-z0-9_]*\s*=\s*["']?(?![$%])[A-Za-z0-9._~+/:@-]{8,})/i },
  // v1.0.5: classic (unprefixed, 24-char) Vercel tokens are shape-identical to
  // Vercel uids (MEASURED: a member uid is 24 mixed alphanumerics). They are
  // detectable only by the credential KEYWORD next to them, in any key:value /
  // key=value form (YAML, logs, query strings), not by shape alone.
  { id: 'KEYWORD_ADJACENT_OPAQUE', re: /\b(?:token|secret|credential|password|api[_-]?key)\b["']?\s*[:=]\s*["']?[A-Za-z0-9]{24,}\b/i },
  // Opaque high-entropy strings >= 40 chars carrying at least FOUR each of
  // upper, lower and digit. Pure lowercase hex (git SHAs, 40/64) never matches.
  // The "four of each" floor was set after this scanner, run over its own
  // lane's write set, flagged artifact identifiers such as
  // CV1_INFRA_CONTROL_PLANE_READ_EFFECTIVE_AUTHORITY_IC_v1 (one lowercase,
  // two digits); a random 40-char token carries roughly a dozen of each.
  { id: 'OPAQUE_HIGH_ENTROPY', re: /(?:^|[^A-Za-z0-9_-])(?=[A-Za-z0-9_-]{40,})(?=(?:[A-Za-z0-9_-]*?[A-Z]){4})(?=(?:[A-Za-z0-9_-]*?[a-z]){4})(?=(?:[A-Za-z0-9_-]*?[0-9]){4})[A-Za-z0-9_-]{40,}/ },
]

export interface Finding { readonly detector: string; readonly offset: number }

export function scanText(text: string, detectors: readonly Detector[] = DETECTORS): Finding[] {
  const findings: Finding[] = []
  for (const d of detectors) {
    const g = new RegExp(d.re.source, d.re.flags.includes('g') ? d.re.flags : `${d.re.flags}g`)
    let m: RegExpExecArray | null
    while ((m = g.exec(text)) !== null) {
      findings.push({ detector: d.id, offset: m.index })
      if (m[0].length === 0) g.lastIndex++
    }
  }
  return findings
}

// ------------------------------------------------------------- write-set classification (v1.0.5, SEN-D2)
//
// The v1.0.4 claim that the lane's write set scanned clean was FALSE under the
// full detector set (MEASURED: 3 findings, all in tests/infra-read). A positive
// fixture is SUPPOSED to trip a detector, so the honest semantics are three
// classes, never a global suppression:
//   CLEAN                 — production code and evidence: zero findings;
//   EXPECTED_DETECTIONS   — a file DESIGNATED in the manifest, whose per-detector
//                           counts equal the manifest EXACTLY (an extra detection
//                           is a leak; a missing one is a detector regression);
//   FAIL                  — anything else.

export type WriteSetClass = 'CLEAN' | 'EXPECTED_DETECTIONS' | 'FAIL'
export type ExpectedDetections = Readonly<Record<string, Readonly<Record<string, number>>>>

export function countByDetector(findings: readonly Finding[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const f of findings) c[f.detector] = (c[f.detector] ?? 0) + 1
  return c
}

function sameCounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

/** `designatedFixture` is the manifest entry for the file, if it is a designated positive fixture. */
export function classifyFile(findings: readonly Finding[], designatedFixture: Readonly<Record<string, number>> | undefined): WriteSetClass {
  if (designatedFixture === undefined) return findings.length === 0 ? 'CLEAN' : 'FAIL'
  if (Object.keys(designatedFixture).length === 0) return 'FAIL' // a designation must expect something
  return sameCounts(countByDetector(findings), designatedFixture) ? 'EXPECTED_DETECTIONS' : 'FAIL'
}

export interface WriteSetReport { readonly files: readonly { file: string; cls: WriteSetClass; counts: Record<string, number> }[]; readonly pass: boolean }

export function classifyWriteSet(files: readonly string[], expected: ExpectedDetections, read: (f: string) => string = (f) => readFileSync(f, 'utf8')): WriteSetReport {
  if (files.length === 0) throw new Error('STOP_EVIDENCE_SCAN_EMPTY_SET: no files to classify')
  const norm = (p: string) => p.replace(/\\/g, '/')
  for (const k of Object.keys(expected)) {
    if (!files.map(norm).includes(norm(k))) throw new Error(`STOP_EXPECTED_DETECTIONS_STALE: ${k} is designated but not in the write set`)
  }
  const out = files.map((file) => {
    const findings = scanText(read(file))
    const cls = classifyFile(findings, expected[norm(file)])
    return { file, cls, counts: countByDetector(findings) }
  })
  return { files: out, pass: out.every((r) => r.cls !== 'FAIL') }
}

export interface ScanReport { readonly filesScanned: number; readonly findings: readonly (Finding & { file: string })[] }

/**
 * Scan a SET of evidence files. An empty set is a FAILURE, not a pass: a
 * control that sweeps a set passes vacuously on the empty set.
 */
export function scanFiles(files: readonly string[]): ScanReport {
  if (files.length === 0) throw new Error('STOP_EVIDENCE_SCAN_EMPTY_SET: no files to scan')
  const findings: (Finding & { file: string })[] = []
  for (const file of files) {
    for (const f of scanText(readFileSync(file, 'utf8'))) findings.push({ ...f, file })
  }
  return { filesScanned: files.length, findings }
}

function mainWriteSet(manifest: string, files: string[]): number {
  let report: WriteSetReport
  try {
    const expected = JSON.parse(readFileSync(manifest, 'utf8')).designated_positive_fixtures as ExpectedDetections
    report = classifyWriteSet(files, expected)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  for (const r of report.files) console.log(`  ${r.cls.padEnd(19)} ${r.file} ${JSON.stringify(r.counts)}`)
  const n = (c: WriteSetClass) => report.files.filter((r) => r.cls === c).length
  console.log(`WRITE_SET_FILES=${report.files.length} CLEAN=${n('CLEAN')} EXPECTED_DETECTIONS=${n('EXPECTED_DETECTIONS')} FAIL=${n('FAIL')}`)
  console.log(`WRITE_SET_SCAN=${report.pass ? 'PASS' : 'FAIL'}`)
  return report.pass ? 0 : 1
}

function main(argv: string[]): number {
  if (argv[0] === '--write-set-manifest') return mainWriteSet(argv[1], argv.slice(2))
  let report: ScanReport
  try {
    report = scanFiles(argv)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  console.log(`EVIDENCE_SCAN_FILES=${report.filesScanned}`)
  console.log(`EVIDENCE_SCAN_FINDINGS=${report.findings.length}`)
  for (const f of report.findings) console.log(`  ${f.detector} at ${f.file}:${f.offset}`)
  console.log(`EVIDENCE_SCAN=${report.findings.length === 0 ? 'PASS' : 'FAIL'}`)
  return report.findings.length === 0 ? 0 : 1
}

const invokedDirectly = typeof process !== 'undefined' && process.argv[1] !== undefined && /evidence-scan\.[cm]?[jt]s$/.test(process.argv[1])
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))

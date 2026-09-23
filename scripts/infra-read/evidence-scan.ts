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
  { id: 'VERCEL_DEPLOY_HOOK_URL', re: /api\.vercel\.com\/v[0-9]+\/integrations\/deploy\//i },
  // An optional scheme word (token / Bearer / Basic) precedes the value; GitHub's own form is `Authorization: token <x>`.
  { id: 'AUTHORIZATION_HEADER', re: /\b(?:proxy-)?authorization\b["']?\s*[:=]\s*["']?(?:[A-Za-z]+\s+)?\S{6,}/i },
  { id: 'BEARER_OR_BASIC_CREDENTIAL', re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i },
  { id: 'COOKIE_MATERIAL', re: /\b(?:set-cookie|cookie)\b["']?\s*[:=]/i },
  { id: 'SECRET_KEYED_FIELD', re: /"(?:token|accessToken|access_token|refreshToken|refresh_token|secret|clientSecret|client_secret|password|privateKey|private_key)"\s*:\s*"[^"]{6,}"/i },
  // A non-empty "value" is what an environment row carries when decrypted or plain.
  { id: 'ENV_VALUE_FIELD', re: /"value"\s*:\s*"[^"]+"/ },
  { id: 'URL_USERINFO', re: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@"]+:[^/\s@"]+@/i },
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

function main(argv: string[]): number {
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

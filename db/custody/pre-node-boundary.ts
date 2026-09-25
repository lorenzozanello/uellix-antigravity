// db/custody/pre-node-boundary.ts
//
// THE PRE-NODE BOUNDARY OF THE OPERATOR CHANNEL (owner decision R4, NB-1).
//
// The final recertification of b4ca05ac measured that NODE_OPTIONS=--require=
// <preload> in the owner's console runs code inside the launcher's Node process
// BEFORE any launcher line executes, and that code captured the operator
// credential. A Node process cannot be its own first boundary against that.
//
// The governed entry is therefore this script, run by the operator's shell
// BEFORE any Node process exists:
//
//   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <channel-dir>\d1-pre-node-boundary.ps1 -Plan <plan>
//
// It (1) refuses, naming the variables, when any runtime or trust input that
// steers Node, its module loader or its TLS stack is present (NODE_*,
// OPENSSL_*, SSL_CERT_FILE/DIR, LD_*/DYLD_* preload variables, or an ambient
// operator value); (2) refuses unless the node binary's sha256 is the plan's
// pin; (3) starts node with NO flags and an environment built from the
// allowlist only, plus the boundary's mark (the sha256 of this script), so no
// inherited variable reaches the secret-bearing process even by omission.
//
// The launcher refuses to prompt unless it carries that mark, has no execArgv
// and sees no NODE_* variable (OC-15). That check runs AFTER Node started and
// is defence in depth against a direct invocation, NOT the boundary: a preload
// that already ran is excluded only because the boundary never let it start.
//
// What it cannot defend: the shell that runs it (a hostile profile is avoided
// with -NoProfile; LD_PRELOAD on the shell itself precedes the script). The
// script is fixed text with no interpolation, written by the gate and pinned.

import { createHash } from 'node:crypto'

/** The environment variable the boundary sets to its own sha256 for the launcher to check. */
export const PRE_NODE_BOUNDARY_ENV = 'UELLIX_D1_PRE_NODE_BOUNDARY'
/** The script's file name in the channel directory. */
export const PRE_NODE_BOUNDARY_FILE = 'd1-pre-node-boundary.ps1'
/** Exit code of every refusal of the boundary. */
export const PRE_NODE_REFUSAL_EXIT = 64

/**
 * The runtime and trust inputs the boundary refuses (case-insensitive). NODE_* covers NODE_OPTIONS
 * (--require, -r, --import, --loader), NODE_PATH, NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED
 * and every other Node runtime variable; the two UELLIX variables would make a run prove nothing.
 */
export const PRE_NODE_HOSTILE_SOURCE =
  '^(NODE_.*|OPENSSL_.*|SSL_CERT_FILE|SSL_CERT_DIR|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_.*|UELLIX_D1_MINT_OPERATOR_DATABASE_URL|UELLIX_D1_PRE_NODE_BOUNDARY)$'

/** The only variables node receives from the boundary (plus the mark). */
export const PRE_NODE_ENV_ALLOWLIST = ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP'] as const

/**
 * The boundary program. Fixed and uninterpolated: free of backticks and of the
 * dollar-brace sequence, so the template literal holding it cannot alter a byte.
 * The hostile pattern and the allowlist are spelled out here AND exported above;
 * a test pins them equal.
 */
export const PRE_NODE_BOUNDARY_PS1 = String.raw`param([Parameter(Mandatory = $true)][string]$Plan)
$ErrorActionPreference = 'Stop'
function Out-Line($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
function Refuse($code, $names) { Out-Line @{ boundary = 'REFUSED'; code = $code; names = @($names) }; exit 64 }

# (1) Before any Node process exists: nothing that steers Node, its loader or its TLS stack.
$hostile = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(NODE_.*|OPENSSL_.*|SSL_CERT_FILE|SSL_CERT_DIR|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_.*|UELLIX_D1_MINT_OPERATOR_DATABASE_URL|UELLIX_D1_PRE_NODE_BOUNDARY)$' } | ForEach-Object { $_.Name } | Sort-Object)
if ($hostile.Count -gt 0) { Refuse 'PRE_NODE_AMBIENT_RUNTIME' $hostile }

# (2) The plan names the node binary by path and sha256; the launcher lies next to this script.
if (-not (Test-Path -LiteralPath $Plan -PathType Leaf)) { Refuse 'PRE_NODE_PLAN_MISSING' @() }
$p = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
$node = [string]$p.nodeExecutable.path
$nodePin = [string]$p.nodeExecutable.sha256
if ($node -eq '' -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { Refuse 'PRE_NODE_NODE_MISSING' @() }
$nodeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $node).Hash.ToLowerInvariant()
if ($nodeHash -ne $nodePin) { Refuse 'PRE_NODE_NODE_NOT_PINNED' @() }
$launcher = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot 'launcher') 'scripts') 'custody') 'd1-mint-operator-launcher.js'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { Refuse 'PRE_NODE_LAUNCHER_MISSING' @() }
if ($launcher.Contains('"') -or $Plan.Contains('"')) { Refuse 'PRE_NODE_PATH_QUOTE' @() }
$self = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash.ToLowerInvariant()

# (3) Node starts with no flags and an environment built from the allowlist only, plus the mark.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = '"' + $launcher + '" "--plan=' + $Plan + '"'
$psi.UseShellExecute = $false
$psi.EnvironmentVariables.Clear()
foreach ($k in @('SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP')) {
  $v = [Environment]::GetEnvironmentVariable($k)
  if ($null -ne $v -and -not $psi.EnvironmentVariables.ContainsKey($k)) { $psi.EnvironmentVariables[$k] = $v }
}
$psi.EnvironmentVariables['UELLIX_D1_PRE_NODE_BOUNDARY'] = $self
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.WaitForExit()
exit $proc.ExitCode
`

export const preNodeBoundarySha256 = (): string => createHash('sha256').update(PRE_NODE_BOUNDARY_PS1, 'utf8').digest('hex')

/** The one authorized operator command (the gate prints it; nothing else is the channel). */
export function preNodeBoundaryCommand(scriptPath: string, planPath: string, platform: NodeJS.Platform = process.platform): string {
  const shell = platform === 'win32' ? 'powershell.exe' : 'pwsh'
  return `${shell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" -Plan "${planPath}"`
}

/**
 * OC-15, inside the already-started launcher (defence in depth, NOT the boundary): it carries the
 * boundary's mark for the pinned script, was started with no execArgv, and sees no NODE_* variable.
 */
export function launchedThroughBoundaryReasons(env: Readonly<Record<string, string | undefined>>, execArgv: readonly string[], pinnedBoundarySha256: string): string[] {
  const r: string[] = []
  if (env[PRE_NODE_BOUNDARY_ENV] !== pinnedBoundarySha256) r.push('not started through the pinned pre-node boundary')
  if (execArgv.length > 0) r.push('node was started with runtime flags')
  const nodeVars = Object.keys(env).filter((k) => /^NODE_/i.test(k))
  if (nodeVars.length > 0) r.push(`Node runtime variables reached the launcher: ${nodeVars.sort().join(', ')}`)
  return r
}

/**
 * Step (3) of the boundary in TypeScript: the environment node receives (the allowlist, first
 * spelling wins as on a case-insensitive Windows block, plus the mark). For the PEB demonstration,
 * which measures the launcher -> tool containment behind the boundary; a test pins it to the script.
 */
export function boundaryEnvironment(base: Readonly<Record<string, string | undefined>>, markSha256: string): Record<string, string> {
  const env: Record<string, string> = {}
  const seen = new Set<string>()
  for (const k of PRE_NODE_ENV_ALLOWLIST) {
    const v = base[k]
    const key = process.platform === 'win32' ? k.toUpperCase() : k
    if (v !== undefined && !seen.has(key)) {
      env[k] = v
      seen.add(key)
    }
  }
  env[PRE_NODE_BOUNDARY_ENV] = markSha256
  return env
}

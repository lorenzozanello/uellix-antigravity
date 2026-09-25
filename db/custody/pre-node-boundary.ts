// db/custody/pre-node-boundary.ts
//
// THE PRE-NODE BOUNDARY OF THE OPERATOR CHANNEL (owner R4 NB-1; owner R5 A).
//
// The final recertification of b4ca05ac measured that NODE_OPTIONS=--require=
// <preload> in the owner's console runs code inside the launcher's Node process
// BEFORE any launcher line executes. The focused recert then measured that the
// PowerShell boundary itself can be compromised BEFORE its security-sensitive
// cmdlets execute: an attacker-controlled PSModulePath can shadow a cmdlet, and
// a CLR profiler / startup hook (COR_*, CORECLR_*, DOTNET_STARTUP_HOOKS,
// DOTNET_ADDITIONAL_DEPS) injects managed code into the PowerShell process at
// CLR start. A check performed inside an already-compromised process is not
// sufficient.
//
// The governed entry is therefore an OUTER boundary built from trusted OS
// primitives, run by the operator's shell, that sanitizes the startup-injection
// inputs BEFORE any PowerShell (a CLR process) starts:
//
//   C:\Windows\System32\cmd.exe /d /c "<channel-dir>\d1-pre-node-outer-boundary.cmd" "<plan>"
//
// cmd.exe is native (not a CLR process), /d disables AutoRun, the child paths
// are absolute (no PATH resolution), and the .cmd clears PSModulePath and every
// CLR-profiler / startup-hook variable, then launches the pinned PowerShell
// script by absolute path. The INNER PowerShell script then, before any
// autoloadable cmdlet runs, reads the environment with a .NET API and refuses
// every Node/OpenSSL/loader variable and every CLR-profiler / startup-hook input
// that survived; it makes all trust decisions with .NET APIs and language
// primitives (never an autoloadable cmdlet), and clears PSModulePath, so a
// poisoned module path cannot inject code through command autoloading. Finally
// it starts node with no flags and an allowlisted environment plus the boundary
// mark. The launcher's OC-15 check (mark, no execArgv, no NODE_* variable) runs
// after node started and is defence in depth against a direct invocation, not
// the boundary.
//
// What it cannot defend: LD_PRELOAD on cmd.exe itself, or a compromised OS. The
// two boundary programs are fixed, uninterpolated text, written by the gate and
// pinned by sha256 in the execution authority.

import { createHash } from 'node:crypto'

/** The environment variable the boundary sets to the inner script's own sha256 for the launcher to check. */
export const PRE_NODE_BOUNDARY_ENV = 'UELLIX_D1_PRE_NODE_BOUNDARY'
/** The inner PowerShell script's file name in the channel directory. */
export const PRE_NODE_BOUNDARY_FILE = 'd1-pre-node-boundary.ps1'
/** The outer cmd boundary's file name in the channel directory. */
export const PRE_NODE_OUTER_BOUNDARY_FILE = 'd1-pre-node-outer-boundary.cmd'
/** Exit code of every refusal of the boundary. */
export const PRE_NODE_REFUSAL_EXIT = 64

/**
 * Runtime and trust inputs the inner script refuses (case-insensitive). NODE_* covers NODE_OPTIONS
 * (--require, -r, --import, --loader), NODE_PATH, NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED
 * and every other Node runtime variable; the two UELLIX variables would make a run prove nothing.
 */
export const PRE_NODE_HOSTILE_SOURCE =
  '^(NODE_.*|OPENSSL_.*|SSL_CERT_FILE|SSL_CERT_DIR|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_.*|UELLIX_D1_MINT_OPERATOR_DATABASE_URL|UELLIX_D1_PRE_NODE_BOUNDARY)$'

/**
 * Windows/.NET startup-injection inputs the inner script refuses if PRESENT (they are not
 * auto-populated, so presence at the CLR process means it may be profiled or hooked). PSModulePath
 * is NOT here: PowerShell always populates it, so it is sanitized by the outer boundary and neutralized
 * by using only .NET APIs for trust, never refused on mere presence.
 */
export const PRE_NODE_INJECTION_SOURCE =
  '^(COR_ENABLE_PROFILING|COR_PROFILER|COR_PROFILER_PATH(_32|_64)?|CORECLR_ENABLE_PROFILING|CORECLR_PROFILER|CORECLR_PROFILER_PATH(_32|_64)?|DOTNET_STARTUP_HOOKS|DOTNET_ADDITIONAL_DEPS)$'

/** Everything the OUTER cmd boundary clears before PowerShell starts: PSModulePath and every injection input. */
export const PRE_NODE_OUTER_SANITIZED = [
  'PSModulePath',
  'COR_ENABLE_PROFILING',
  'COR_PROFILER',
  'COR_PROFILER_PATH',
  'COR_PROFILER_PATH_32',
  'COR_PROFILER_PATH_64',
  'CORECLR_ENABLE_PROFILING',
  'CORECLR_PROFILER',
  'CORECLR_PROFILER_PATH',
  'CORECLR_PROFILER_PATH_32',
  'CORECLR_PROFILER_PATH_64',
  'DOTNET_STARTUP_HOOKS',
  'DOTNET_ADDITIONAL_DEPS',
] as const

/** The only variables node receives from the boundary (plus the mark). */
export const PRE_NODE_ENV_ALLOWLIST = ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP'] as const

/**
 * The OUTER boundary. Fixed, uninterpolated cmd (native, not a CLR process): /d disables AutoRun,
 * it clears PSModulePath and every CLR-profiler / startup-hook variable in a localized scope, then
 * launches the pinned PowerShell script and node's launcher by ABSOLUTE paths (SystemRoot expansion
 * for powershell.exe, %~dp0 for the script beside it), never through PATH resolution.
 */
export const PRE_NODE_OUTER_BOUNDARY_CMD = [
  '@echo off',
  'setlocal',
  ...PRE_NODE_OUTER_SANITIZED.map((k) => `set "${k}="`),
  `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0${PRE_NODE_BOUNDARY_FILE}" -Plan %1`,
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n')

/**
 * The INNER boundary. Fixed and uninterpolated: free of backticks and of the dollar-brace sequence,
 * so the template literal holding it cannot alter a byte. It makes every trust decision with .NET
 * APIs and language primitives (no autoloadable cmdlet), reads the environment with a .NET API before
 * anything could autoload, refuses the hostile and injection inputs, and clears PSModulePath.
 */
export const PRE_NODE_BOUNDARY_PS1 = String.raw`param([Parameter(Mandatory = $true)][string]$Plan)
$ErrorActionPreference = 'Stop'
function Refuse($code, $names) {
  $q = @()
  foreach ($n in $names) { $q += '"' + $n + '"' }
  [Console]::Out.WriteLine('{"boundary":"REFUSED","code":"' + $code + '","names":[' + ($q -join ',') + ']}')
  exit 64
}
function Sha256OfFile($path) {
  $d = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($d.ComputeHash([System.IO.File]::ReadAllBytes($path))).Replace('-', '').ToLowerInvariant() } finally { $d.Dispose() }
}

# (0) Before any autoloadable cmdlet runs: read the environment with a .NET API and refuse every
#     Node/OpenSSL/loader variable and every surviving CLR-profiler / startup-hook input. Only .NET
#     and language operators are used here, so a poisoned PSModulePath cannot autoload a shadow first.
$hostile = '^(NODE_.*|OPENSSL_.*|SSL_CERT_FILE|SSL_CERT_DIR|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_.*|UELLIX_D1_MINT_OPERATOR_DATABASE_URL|UELLIX_D1_PRE_NODE_BOUNDARY)$'
$injection = '^(COR_ENABLE_PROFILING|COR_PROFILER|COR_PROFILER_PATH(_32|_64)?|CORECLR_ENABLE_PROFILING|CORECLR_PROFILER|CORECLR_PROFILER_PATH(_32|_64)?|DOTNET_STARTUP_HOOKS|DOTNET_ADDITIONAL_DEPS)$'
$present = @()
$table = [System.Environment]::GetEnvironmentVariables()
foreach ($k in $table.Keys) { $n = [string]$k; if ($n -match $hostile -or $n -match $injection) { $present += $n } }
if ($present.Count -gt 0) { [System.Array]::Sort($present); Refuse 'PRE_NODE_AMBIENT_RUNTIME' $present }

# No hostile input survived. Clear PSModulePath so no command autoloading can occur, and make every
# remaining trust decision with .NET APIs.
$env:PSModulePath = ''

if (-not [System.IO.File]::Exists($Plan)) { Refuse 'PRE_NODE_PLAN_MISSING' @() }
$p = Microsoft.PowerShell.Utility\ConvertFrom-Json ([System.IO.File]::ReadAllText($Plan))
$node = [string]$p.nodeExecutable.path
$nodePin = ([string]$p.nodeExecutable.sha256).ToLowerInvariant()
if ($node -eq '' -or -not [System.IO.File]::Exists($node)) { Refuse 'PRE_NODE_NODE_MISSING' @() }
if ((Sha256OfFile $node) -ne $nodePin) { Refuse 'PRE_NODE_NODE_NOT_PINNED' @() }
$launcher = $PSScriptRoot + '\launcher\scripts\custody\d1-mint-operator-launcher.js'
if (-not [System.IO.File]::Exists($launcher)) { Refuse 'PRE_NODE_LAUNCHER_MISSING' @() }
if ($launcher.Contains('"') -or $Plan.Contains('"')) { Refuse 'PRE_NODE_PATH_QUOTE' @() }
$self = Sha256OfFile $PSCommandPath

# (3) Node starts with no flags and an environment built from the allowlist only, plus the mark.
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $node
$psi.Arguments = '"' + $launcher + '" "--plan=' + $Plan + '"'
$psi.UseShellExecute = $false
$psi.EnvironmentVariables.Clear()
foreach ($k in @('SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP')) {
  $v = [System.Environment]::GetEnvironmentVariable($k)
  if ($null -ne $v -and -not $psi.EnvironmentVariables.ContainsKey($k)) { $psi.EnvironmentVariables[$k] = $v }
}
$psi.EnvironmentVariables['UELLIX_D1_PRE_NODE_BOUNDARY'] = $self
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.WaitForExit()
exit $proc.ExitCode
`

export const preNodeBoundarySha256 = (): string => createHash('sha256').update(PRE_NODE_BOUNDARY_PS1, 'utf8').digest('hex')
export const preNodeOuterBoundarySha256 = (): string => createHash('sha256').update(PRE_NODE_OUTER_BOUNDARY_CMD, 'utf8').digest('hex')

/** The one authorized operator command (the gate prints it; nothing else is the channel). */
export function preNodeBoundaryCommand(outerPath: string, planPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    return `${systemRoot}\\System32\\cmd.exe /d /c "${outerPath}" "${planPath}"`
  }
  // Non-Windows has no cmd.exe; the inner script (pwsh) is the boundary for a dev fallback only.
  const innerPath = outerPath.replace(new RegExp(`${PRE_NODE_OUTER_BOUNDARY_FILE.replace(/[.]/g, '\\$&')}$`), PRE_NODE_BOUNDARY_FILE)
  return `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${innerPath}" -Plan "${planPath}"`
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

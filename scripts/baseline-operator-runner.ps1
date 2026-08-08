<#
.SYNOPSIS
  Runs PHASE_BASELINE units 001-050 against Uellix STAGING, one governed unit at
  a time, from the OPERATOR PowerShell.

.DESCRIPTION
  This wrapper is deliberately thin. It resolves psql.exe fail-closed, confirms
  the connection variables are PRESENT (never reading or printing their values),
  and hands over to the Node driver, which owns every decision.

  It does not accept a password, a DSN or a connection string, and it has no
  parameter that could carry one. The connection comes from the libpq variables
  already loaded in this shell, which child processes inherit.

.PARAMETER PsqlPath
  Full path to psql.exe. REQUIRED. This runner never resolves psql from PATH:
  the operator shell deliberately has none, and silently finding some other
  client would mean running an unknown version against a hosted database.

.PARAMETER ExpectedHead
  The 40-character commit sha this run is authorized against. REQUIRED. An
  "authorized commit" that defaults to whatever is checked out authorizes
  nothing.

.PARAMETER DryRun
  Verify identity, corpus, ledger and position, print the next unit, and stop
  before applying anything.

.EXAMPLE
  .\scripts\baseline-operator-runner.ps1 -PsqlPath "C:\Program Files\PostgreSQL\17\bin\psql.exe" -ExpectedHead <sha>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $PsqlPath,
  [Parameter(Mandatory = $true)][string] $ExpectedHead,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

function Stop-Interrupted([string] $Reason) {
  Write-Host ''
  Write-Host 'PHASE_BASELINE_INTERRUPTED'
  Write-Host '  lastCommittedUnit:    (nothing was attempted)'
  Write-Host '  expectedOrFailedUnit: (preflight)'
  Write-Host '  journalCount:         (not read)'
  Write-Host "  reason:               $Reason"
  Write-Host '  recovery posture:     STOP. Nothing connected and nothing was applied. Fix the shell and re-run.'
  exit 1
}

# --- psql, resolved fail-closed --------------------------------------------
if (-not (Test-Path -LiteralPath $PsqlPath -PathType Leaf)) {
  Stop-Interrupted "OPERATOR_ARGS_INVALID - psql.exe not found at the supplied -PsqlPath"
}

# --- the connection variables: PRESENCE only, never values ------------------
# Printing a value here would defeat the redaction the driver applies to every
# line it emits, so this loop reports names and nothing else.
$required = @('UELLIX_STAGING_REF', 'PGUSER', 'PGHOST', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGPASSWORD')
$missing = @()
foreach ($name in $required) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) { $missing += $name }
}
if ($missing.Count -gt 0) {
  Stop-Interrupted "OPERATOR_ENV_INCOMPLETE - not set in this shell: $($missing -join ', ')"
}

$rootCert = [Environment]::GetEnvironmentVariable('PGSSLROOTCERT')
if (-not (Test-Path -LiteralPath $rootCert -PathType Leaf)) {
  Stop-Interrupted 'OPERATOR_ENV_SSLROOTCERT_MISSING - PGSSLROOTCERT does not point at a file, so verify-full has no root of trust'
}

# --- hand over --------------------------------------------------------------
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  $runnerArgs = @(
    'tsx', 'scripts/baseline-operator-runner.ts',
    '--psql', $PsqlPath,
    '--head', $ExpectedHead
  )
  if ($DryRun) { $runnerArgs += '--dry-run' }

  & pnpm @runnerArgs
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}

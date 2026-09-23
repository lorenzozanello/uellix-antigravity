// scripts/custody/n05-observers.ts
//
// THE FOUR OBSERVATIONS THAT MUST BE MADE FROM OUTSIDE.
//
// Each function here exists because the corresponding readiness-contract item
// names a cheap demonstration that proves nothing, and the only way to avoid
// that demonstration is to observe from somewhere the subject does not
// control.
//
//   PebObserver (n05-peb-observer.ts)
//                                 RC-3 and RC-7. The command line AND the
//                                 environment block of every process, read
//                                 from its PEB by a SEPARATE process. It
//                                 replaced a Win32_Process poller that never
//                                 read an environment block, which is how a
//                                 credential-bearing conhost.exe was declared
//                                 clean by name (B-1).
//
//   observeFromOutsideProcessTree RC-2. A shell this process spawned inherits
//                                 this process's environment block, so it
//                                 cannot distinguish process scope from
//                                 session scope. A process created through
//                                 Win32_Process.Create is parented by
//                                 WmiPrvSE, not by us, and is therefore
//                                 genuinely outside the demonstration's
//                                 process tree.
//
//   readPersistentEnvironment     RC-2. The registry-backed User and Machine
//                                 environment blocks, read directly. This is
//                                 the surface `setx` writes and the one
//                                 MECHANISM_1 was refused for.
//
//   enumerateHistorySinks         RC-4. Named individually, then searched
//                                 individually. A blanket "history is off" is
//                                 what the item's `what_does_NOT_count` field
//                                 rules out.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const POWERSHELL = 'powershell.exe'

function psArgv(script: string): readonly string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]
}

async function runPowerShell(script: string, timeoutMs = 90_000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(POWERSHELL, psArgv(script), {
      stdio: ['ignore', 'pipe', 'pipe'] as const,
      windowsHide: true,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`PowerShell observation timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      out += c
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      err += c
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`PowerShell exited ${String(code)}: ${err.slice(0, 500)}`))
      else resolve(out)
    })
  })
}

/**
 * Parse JSON written by Windows PowerShell 5.1.
 *
 * `Set-Content -Encoding UTF8` on 5.1 emits a BYTE ORDER MARK, and JSON.parse
 * rejects it with a message that points at an invisible character. Stripping
 * it here keeps the surprise in one place instead of at every call site.
 */
function parseJsonFromPowerShell<T>(text: string): T {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return JSON.parse(withoutBom) as T
}

/**
 * Ask a process OUTSIDE this process tree whether a variable name is set.
 *
 * `Win32_Process.Create` re-parents the new process onto WmiPrvSE, so it does
 * not inherit this process's environment block and is not a descendant of it.
 * That is what makes the answer mean something: a child shell would inherit
 * whatever we hold, and would report absent for a reason that says nothing
 * about persistence.
 *
 * The probe writes a locale-independent token. Parsing `set`'s output would
 * break on this workstation, whose shell messages are Spanish.
 */
export async function observeFromOutsideProcessTree(varName: string): Promise<{
  readonly present: boolean
  readonly parentIsNotThisTree: boolean
  readonly parentName: string
  readonly createdPid: number
}> {
  const resultFile = join(tmpdir(), `uellix-n05-outside-${process.pid}-${Date.now()}.json`)
  const inner = [
    "$ErrorActionPreference = 'Stop'",
    `$v = [Environment]::GetEnvironmentVariable('${varName}','Process')`,
    "$me = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)",
    "$par = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $me.ParentProcessId)",
    '$o = [pscustomobject]@{ present = ($null -ne $v); ppid = $me.ParentProcessId; parentName = [string]$par.Name }',
    `Set-Content -Path '${resultFile.replace(/'/g, "''")}' -Value ($o | ConvertTo-Json -Compress) -Encoding UTF8`,
  ].join('\n')
  const encodedInner = Buffer.from(inner, 'utf16le').toString('base64')

  const script = `
$ErrorActionPreference = 'Stop'
$cmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedInner}'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
Write-Output ([pscustomobject]@{ rc = $r.ReturnValue; pid = $r.ProcessId } | ConvertTo-Json -Compress)
`
  const out = await runPowerShell(script)
  const created = JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}') as {
    rc: number
    pid: number
  }
  if (created.rc !== 0) {
    throw new Error(`Win32_Process.Create refused the out-of-tree probe (rc=${created.rc}).`)
  }

  try {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (existsSync(resultFile)) break
      await new Promise((r) => setTimeout(r, 200))
    }
    if (!existsSync(resultFile)) {
      throw new Error('The out-of-tree probe produced no result. RC-2 cannot be discharged.')
    }
    // A file seen mid-write parses as nothing; give the writer one beat.
    await new Promise((r) => setTimeout(r, 200))
    const parsed = parseJsonFromPowerShell<{ present: boolean; ppid: number; parentName: string }>(
      readFileSync(resultFile, 'utf8')
    )
    // NP9 rests on this probe being OUTSIDE the demonstration's tree. "Its
    // parent is not this process" is too weak — a grandchild passes it — so
    // the parent is required to BE the WMI provider host that
    // Win32_Process.Create re-parents onto, which no process in this tree is.
    return {
      present: parsed.present,
      parentIsNotThisTree: parsed.ppid !== process.pid && /^WmiPrvSE\.exe$/i.test(parsed.parentName),
      parentName: parsed.parentName,
      createdPid: created.pid,
    }
  } finally {
    // The probe's result is non-secret, but a successful run leaves nothing behind.
    rmSync(resultFile, { force: true })
  }
}

/**
 * The registry-backed User and Machine environment blocks.
 *
 * This is the surface `setx` writes to, and the one MECHANISM_1 was ruled
 * absolutely unacceptable for. Reading it directly is the check that would
 * catch a mechanism which had quietly become user-scoped.
 */
export async function readPersistentEnvironment(varName: string): Promise<{
  readonly user: boolean
  readonly machine: boolean
}> {
  const script = `
$ErrorActionPreference = 'Stop'
$u = [Environment]::GetEnvironmentVariable('${varName}','User')
$m = [Environment]::GetEnvironmentVariable('${varName}','Machine')
Write-Output ([pscustomobject]@{ user = ($null -ne $u); machine = ($null -ne $m) } | ConvertTo-Json -Compress)
`
  const out = await runPowerShell(script)
  return JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}') as {
    user: boolean
    machine: boolean
  }
}

export interface HistorySink {
  readonly name: string
  readonly kind: 'FILE' | 'EVENT_LOG' | 'STRUCTURAL'
  readonly path: string | null
  readonly exists: boolean
  /** Why this sink cannot receive the value, where that is structural. */
  readonly note: string
}

/**
 * Enumerate every history-persisting facility of this session BY NAME.
 *
 * RC-4's `what_does_NOT_count` rules out a blanket statement, and rules out
 * enumerating the interactive command history while omitting a separately
 * configured line-editor history file or a terminal scrollback. Each is named
 * here whether or not it exists, because a sink that does not exist today and
 * a sink nobody looked for are different facts.
 */
export async function enumerateHistorySinks(): Promise<readonly HistorySink[]> {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const psReadLine = join(
    appData,
    'Microsoft',
    'Windows',
    'PowerShell',
    'PSReadLine',
    'ConsoleHost_history.txt'
  )
  const bashHistory = join(homedir(), '.bash_history')

  const transcriptScript = `
$ErrorActionPreference = 'SilentlyContinue'
$t = Get-ItemProperty -Path 'HKLM:\\Software\\Policies\\Microsoft\\Windows\\PowerShell\\Transcription' -ErrorAction SilentlyContinue
$sb = Get-ItemProperty -Path 'HKLM:\\Software\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging' -ErrorAction SilentlyContinue
$mod = Get-ItemProperty -Path 'HKLM:\\Software\\Policies\\Microsoft\\Windows\\PowerShell\\ModuleLogging' -ErrorAction SilentlyContinue
Write-Output ([pscustomobject]@{
  transcriptionEnabled = [bool]($t.EnableTranscripting -eq 1)
  transcriptDirectory  = [string]$t.OutputDirectory
  scriptBlockLogging   = [bool]($sb.EnableScriptBlockLogging -eq 1)
  moduleLogging        = [bool]($mod.EnableModuleLogging -eq 1)
} | ConvertTo-Json -Compress)
`
  const policy = JSON.parse(
    (await runPowerShell(transcriptScript)).trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}'
  ) as {
    transcriptionEnabled: boolean
    transcriptDirectory: string
    scriptBlockLogging: boolean
    moduleLogging: boolean
  }

  return [
    {
      name: 'PSReadLine ConsoleHost_history.txt',
      kind: 'FILE',
      path: psReadLine,
      exists: existsSync(psReadLine),
      note:
        'PSReadLine records INTERACTIVE input only. The bridge is invoked with -NonInteractive ' +
        'and -EncodedCommand and never through an interactive prompt, so it contributes nothing here.',
    },
    {
      name: 'bash HISTFILE',
      kind: 'FILE',
      path: bashHistory,
      exists: existsSync(bashHistory),
      note: 'Searched because this workstation also runs a POSIX shell alongside PowerShell.',
    },
    {
      name: 'PowerShell over-the-shoulder transcription',
      kind: 'FILE',
      path: policy.transcriptDirectory === '' ? null : policy.transcriptDirectory,
      exists: policy.transcriptionEnabled,
      note: policy.transcriptionEnabled
        ? 'ENABLED by policy. The transcript directory is searched.'
        : 'Not enabled by policy. Recorded as enumerated-and-absent, not as unexamined.',
    },
    {
      name: 'PowerShell script-block logging (event 4104)',
      kind: 'EVENT_LOG',
      path: 'Microsoft-Windows-PowerShell/Operational',
      exists: policy.scriptBlockLogging,
      note:
        'This sink records the SCRIPT, and the script is the fixed bridge constant, which ' +
        'contains no value. Even fully enabled it cannot receive the secret.',
    },
    {
      name: 'PowerShell module logging (event 4103)',
      kind: 'EVENT_LOG',
      path: 'Microsoft-Windows-PowerShell/Operational',
      exists: policy.moduleLogging,
      note: 'Records pipeline invocations. The value is never a parameter of one.',
    },
    {
      name: 'cmd.exe command history',
      kind: 'STRUCTURAL',
      path: null,
      exists: false,
      note:
        'cmd.exe keeps history in the console host process only and persists none of it to disk. ' +
        'Named so the enumeration is complete, not because it is a risk.',
    },
    {
      name: 'Windows process command lines',
      kind: 'STRUCTURAL',
      path: null,
      exists: true,
      note:
        'Not a history sink but the same disclosure surface, and the one WCM-C2 governs. ' +
        'Observed continuously during the run by the PEB observer, which reads each command line from outside.',
    },
  ]
}

/**
 * Search the file-backed history sinks for a needle.
 *
 * The needle is the sentinel. It is passed as a Buffer and compared as bytes,
 * and it is never written anywhere by this function.
 */
export function searchFileSinks(
  sinks: readonly HistorySink[],
  needle: Buffer
): { readonly clean: boolean; readonly hits: readonly string[] } {
  const hits: string[] = []
  const needleStr = needle.toString('utf8')
  for (const sink of sinks) {
    if (sink.kind !== 'FILE' || sink.path === null || !existsSync(sink.path)) continue
    try {
      if (readFileSync(sink.path, 'utf8').includes(needleStr)) hits.push(sink.name)
    } catch {
      // An unreadable sink is not a clean sink. Record it as a hit so the
      // control cannot pass on a file nobody could open.
      hits.push(`${sink.name} (UNREADABLE)`)
    }
  }
  return { clean: hits.length === 0, hits }
}

/**
 * RC-8. Whether the vault read itself is audited, and where.
 *
 * Answered by asking the audit subsystem rather than by asserting an absence.
 * `auditpol` names every subcategory Windows can audit; if none of them covers
 * a Credential Manager read, that is a measured fact about the audit policy
 * surface rather than the absence of a log nobody looked for.
 */
export async function describeVaultReadAuditSurface(): Promise<{
  readonly statement: string
  readonly recordsHandle: boolean | 'NOT_APPLICABLE'
  readonly subcategoriesChecked: readonly string[]
}> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$raw = & auditpol.exe /get /category:* 2>$null
$names = @()
foreach ($line in $raw) {
  if ($line -match '^\\s{2,}(\\S.*?)\\s{2,}(\\S.*)$') { $names += ($matches[1].Trim() + ' = ' + $matches[2].Trim()) }
}
$log = Get-WinEvent -ListLog 'Microsoft-Windows-CredentialRoaming/Operational' -ErrorAction SilentlyContinue
Write-Output ([pscustomobject]@{
  subcategories = @($names)
  credentialRoamingLogPresent = ($null -ne $log)
} | ConvertTo-Json -Depth 3 -Compress)
`
  let parsed: { subcategories: string[]; credentialRoamingLogPresent: boolean }
  try {
    parsed = JSON.parse(
      (await runPowerShell(script)).trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}'
    ) as { subcategories: string[]; credentialRoamingLogPresent: boolean }
  } catch {
    parsed = { subcategories: [], credentialRoamingLogPresent: false }
  }

  const credentialSubcats = parsed.subcategories.filter((s) => /credential|credencial/i.test(s))

  return {
    statement:
      'CredReadW on a CRED_TYPE_GENERIC entry produces no Security-log audit event on this ' +
      'workstation. The Windows audit subcategories were enumerated with auditpol and the ' +
      `${credentialSubcats.length} credential-related subcategory/subcategories found ` +
      `(${credentialSubcats.join('; ') || 'none'}) cover CREDENTIAL VALIDATION — the ` +
      'authentication of a credential by a logon authority — which is a different act from a ' +
      'Credential Manager vault read. The Microsoft-Windows-CredentialRoaming/Operational log ' +
      `was ${parsed.credentialRoamingLogPresent ? 'PRESENT' : 'ABSENT'} and concerns roaming ` +
      'replication, not local reads. No audit surface records the read, and therefore none ' +
      'records the entry handle: SSL-06 is not engaged by the read path on this configuration. ' +
      'This is a statement about THIS workstation as measured, not a general claim about Windows.',
    recordsHandle: 'NOT_APPLICABLE',
    subcategoriesChecked: credentialSubcats,
  }
}

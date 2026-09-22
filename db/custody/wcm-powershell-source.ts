// db/custody/wcm-powershell-source.ts
//
// THE WINDOWS CREDENTIAL MANAGER BRIDGE, AS SOURCE.
//
// This file holds CODE and nothing else. It contains no credential, no
// sentinel, no connection string, no userinfo, no entry key and no lookup
// token, and a control in tests/custody asserts that it never acquires one.
// Publishing the reader is not publishing the secret: N29's authority permits
// an auditable in-repository mechanism precisely because a reader whose source
// nobody can read is a reader nobody can check.
//
// ---------------------------------------------------------------------------
// WHY POWERSHELL AND P/INVOKE, AND NOT THE OBVIOUS ALTERNATIVES
// ---------------------------------------------------------------------------
// The ratified custody store is Windows Credential Manager, a DPAPI-backed OS
// vault (OD-2.sub_decisions[0]). Four ways to reach it were considered and
// three were refused on the authority's own constraints:
//
//   cmdkey.exe            REFUSED. `cmdkey /generic:X /pass:Y` places the
//                         value in argv, which N29's first absolute constraint
//                         prohibits outright. It also cannot read a password
//                         back, so it could not serve the reader at all.
//
//   a native Node addon   REFUSED as disproportionate. It adds a compiler
//                         toolchain and a build step to a mechanism whose
//                         whole job is four Win32 entry points.
//
//   an FFI package        REFUSED. A new runtime dependency in the lockfile is
//                         a supply-chain surface added to the one code path in
//                         this repository that handles a hosted credential.
//
//   powershell + P/Invoke SELECTED. Windows PowerShell 5.1 ships with the OS,
//                         `Add-Type` compiles the C# below against the .NET
//                         Framework already present, and the entry points it
//                         needs are the documented Credential Management API.
//                         No new dependency, no build step, and the whole
//                         mechanism is one auditable file.
//
// ---------------------------------------------------------------------------
// THE SECRET NEVER TOUCHES A COMMAND LINE
// ---------------------------------------------------------------------------
// This program is a FIXED CONSTANT. Nothing is interpolated into it, so there
// is no injection surface and no path by which a caller-supplied value could
// become part of the script text. Every input arrives on STDIN:
//
//   line 1   base64 of a compact JSON request. NON-SECRET: an op name, an
//            entry target, a username, a prefix.
//   line 2   base64 of the secret. Present for `deposit` only.
//
// and every output leaves on STDOUT:
//
//   line 1   base64 of a compact JSON response. Carries `blobBase64` for
//            `retrieve` and nothing secret for any other op.
//
// Both are anonymous pipes held by the parent. Neither is a console, a file or
// a log. The base64 is FRAMING, not protection: it exists so a value
// containing a newline or a non-UTF8 byte cannot desynchronise the protocol,
// and it is never claimed to conceal anything.
//
// ---------------------------------------------------------------------------
// WHY THIS SATISFIES WCM-C3 STRUCTURALLY RATHER THAN BY CONFIGURATION
// ---------------------------------------------------------------------------
// WCM-C3 asks that shell history be disabled or the session be non-persisting.
// RC-4's structural note observes that no mechanism can satisfy that
// intrinsically, and asks instead for an invocation contract that is ENFORCED
// at every invocation rather than held once.
//
// The contract here is stronger than disabling history: the value never enters
// anything a history sink can record. PSReadLine records INTERACTIVE input and
// this program is never invoked interactively; script-block logging records
// the SCRIPT, and the script is this constant, which contains no secret; the
// process table records argv, and argv carries only `-NoProfile
// -NonInteractive -EncodedCommand <this constant>`. A session that logs
// everything it can log still logs no secret.
//
// The enforcement lives in `db/custody/wcm-credential-store.ts`, which builds
// the argv itself and accepts none from a caller.

/**
 * The bridge program. Fixed, uninterpolated, and asserted secret-free by
 * `tests/custody/wcm-custody-mechanism.test.ts`.
 *
 * Deliberately free of backticks and of the `$`+`{` sequence, so that
 * embedding it in a TypeScript template literal cannot alter a byte of it.
 * Both properties are asserted by a control rather than left to care.
 */
export const WCM_BRIDGE_POWERSHELL_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class UellixCredBridge {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CredWriteW")]
  public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CredReadW")]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CredDeleteW")]
  public static extern bool CredDelete(string target, uint type, uint flags);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CredEnumerateW")]
  public static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr credentials);

  [DllImport("advapi32.dll", EntryPoint = "CredFree")]
  public static extern void CredFree(IntPtr buffer);
}
'@

# CRED_TYPE_GENERIC. The only type this bridge reads or writes; a domain or
# certificate credential is a different custody question and is out of scope.
$CRED_TYPE_GENERIC = 1
# CRED_PERSIST_LOCAL_MACHINE. The entry must outlive the depositing session,
# because the depositor (N30) and the reader (N23) are different runs. This is
# also why abrupt termination CANNOT orphan a process-scoped variable but CAN
# orphan a vault entry, which is the honest answer RC-5's derived gap asks for.
$CRED_PERSIST_LOCAL_MACHINE = 2
# ERROR_NOT_FOUND. The clean, specific absence signal. Any other failure code
# is reported as a failed check and never as an absence.
$ERROR_NOT_FOUND = 1168

function Read-B64Line {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { return $null }
  $line = $line.Trim()
  if ($line.Length -eq 0) { return $null }
  return $line
}

function Write-Response($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  [Console]::Out.WriteLine($b64)
  [Console]::Out.Flush()
}

function Invoke-Deposit($target, $username, $secretBytes) {
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($secretBytes.Length)
  $targetPtr = [IntPtr]::Zero
  $userPtr = [IntPtr]::Zero
  try {
    [Runtime.InteropServices.Marshal]::Copy($secretBytes, 0, $blob, $secretBytes.Length)
    $targetPtr = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($target)
    $userPtr = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($username)

    $cred = New-Object UellixCredBridge+CREDENTIAL
    $cred.Type = $CRED_TYPE_GENERIC
    $cred.TargetName = $targetPtr
    $cred.UserName = $userPtr
    $cred.CredentialBlob = $blob
    $cred.CredentialBlobSize = $secretBytes.Length
    $cred.Persist = $CRED_PERSIST_LOCAL_MACHINE

    $ok = [UellixCredBridge]::CredWrite([ref]$cred, 0)
    $err = 0
    if (-not $ok) { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
    return @{ ok = $ok; win32 = $err }
  }
  finally {
    # Zero the unmanaged copy before releasing it. A freed-but-unzeroed page is
    # readable by whatever allocates it next.
    if ($blob -ne [IntPtr]::Zero) {
      $zeros = New-Object byte[] $secretBytes.Length
      [Runtime.InteropServices.Marshal]::Copy($zeros, 0, $blob, $secretBytes.Length)
      [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
    }
    if ($targetPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($targetPtr) }
    if ($userPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($userPtr) }
  }
}

function Invoke-Retrieve($target) {
  $ptr = [IntPtr]::Zero
  $ok = [UellixCredBridge]::CredRead($target, $CRED_TYPE_GENERIC, 0, [ref]$ptr)
  if (-not $ok) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    return @{ ok = $false; present = $false; win32 = $err }
  }
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type]([UellixCredBridge+CREDENTIAL]))
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    if ($cred.CredentialBlobSize -gt 0) {
      [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
    }
    $b64 = [Convert]::ToBase64String($bytes)
    [Array]::Clear($bytes, 0, $bytes.Length)
    return @{ ok = $true; present = $true; win32 = 0; blobBase64 = $b64 }
  }
  finally {
    if ($ptr -ne [IntPtr]::Zero) { [UellixCredBridge]::CredFree($ptr) }
  }
}

function Invoke-Probe($target) {
  # THE ABSENCE CHECK. It reads the SAME scope a deposit writes — the current
  # user's generic credential set — so an absent result means the entry is gone
  # and never that the check looked somewhere else. It reports PRESENT when the
  # entry is there, which is what makes it capable of returning false and
  # therefore worth anything at all (RC-6).
  $ptr = [IntPtr]::Zero
  $ok = [UellixCredBridge]::CredRead($target, $CRED_TYPE_GENERIC, 0, [ref]$ptr)
  if ($ok) {
    if ($ptr -ne [IntPtr]::Zero) { [UellixCredBridge]::CredFree($ptr) }
    return @{ ok = $true; present = $true; win32 = 0 }
  }
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($err -eq $ERROR_NOT_FOUND) { return @{ ok = $true; present = $false; win32 = $err } }
  # Any other code is a FAILED CHECK, not an absence. Reporting it as absence
  # is the false pass RC-6 names as the most dangerous one available here.
  return @{ ok = $false; present = $null; win32 = $err }
}

function Invoke-Remove($target) {
  $ok = [UellixCredBridge]::CredDelete($target, $CRED_TYPE_GENERIC, 0)
  if ($ok) { return @{ ok = $true; deleted = $true; win32 = 0 } }
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  # Already absent is a SUCCESSFUL removal. Idempotence is what makes the
  # sweeper safe to run before and after every demonstration.
  if ($err -eq $ERROR_NOT_FOUND) { return @{ ok = $true; deleted = $false; win32 = $err } }
  return @{ ok = $false; deleted = $false; win32 = $err }
}

function Invoke-Sweep($prefix) {
  # Enumerate every generic entry under a reserved prefix and report their
  # target names. Target names are NON-SECRET by construction: the reserved
  # prefix is a literal in this repository and names nothing but the sentinel.
  $count = 0
  $arr = [IntPtr]::Zero
  $ok = [UellixCredBridge]::CredEnumerate($prefix + '*', 0, [ref]$count, [ref]$arr)
  if (-not $ok) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq $ERROR_NOT_FOUND) { return @{ ok = $true; targets = @(); win32 = $err } }
    return @{ ok = $false; targets = @(); win32 = $err }
  }
  try {
    $targets = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $count; $i++) {
      $p = [Runtime.InteropServices.Marshal]::ReadIntPtr($arr, $i * [IntPtr]::Size)
      $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [Type]([UellixCredBridge+CREDENTIAL]))
      $null = $targets.Add([Runtime.InteropServices.Marshal]::PtrToStringUni($c.TargetName))
    }
    return @{ ok = $true; targets = @($targets.ToArray()); win32 = 0 }
  }
  finally {
    if ($arr -ne [IntPtr]::Zero) { [UellixCredBridge]::CredFree($arr) }
  }
}

$secretBytes = $null
try {
  $reqLine = Read-B64Line
  if ($null -eq $reqLine) { Write-Response @{ ok = $false; error = 'NO_REQUEST_ON_STDIN' }; exit 2 }
  $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($reqLine)) | ConvertFrom-Json

  switch ($req.op) {
    'deposit' {
      $secretLine = Read-B64Line
      if ($null -eq $secretLine) { Write-Response @{ ok = $false; error = 'NO_SECRET_ON_STDIN' }; exit 2 }
      $secretBytes = [Convert]::FromBase64String($secretLine)
      if ($secretBytes.Length -eq 0) { Write-Response @{ ok = $false; error = 'EMPTY_SECRET' }; exit 2 }
      Write-Response (Invoke-Deposit $req.target $req.username $secretBytes)
    }
    'retrieve' { Write-Response (Invoke-Retrieve $req.target) }
    'probe'    { Write-Response (Invoke-Probe $req.target) }
    'remove'   { Write-Response (Invoke-Remove $req.target) }
    'sweep'    { Write-Response (Invoke-Sweep $req.prefix) }
    default    { Write-Response @{ ok = $false; error = 'UNKNOWN_OP' }; exit 2 }
  }
  exit 0
}
catch {
  # The exception TYPE only, never the message. A .NET message is not expected
  # to carry the value, and this bridge declines to rely on that expectation.
  Write-Response @{ ok = $false; error = 'BRIDGE_EXCEPTION'; exceptionType = $_.Exception.GetType().Name }
  exit 3
}
finally {
  if ($null -ne $secretBytes) { [Array]::Clear($secretBytes, 0, $secretBytes.Length) }
}
`

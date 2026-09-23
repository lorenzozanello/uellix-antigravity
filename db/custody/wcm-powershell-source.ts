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
//   powershell + P/Invoke SELECTED. Windows PowerShell 5.1 ships with the OS
//                         and the entry points it needs are the documented
//                         Credential Management API. No new dependency, no
//                         build step, and the whole mechanism is one file.
//
// ---------------------------------------------------------------------------
// WHY THE SIGNATURES ARE EMITTED IN-PROCESS AND NOT COMPILED BY Add-Type
// ---------------------------------------------------------------------------
// The first version declared the P/Invoke signatures in C# and compiled them
// with `Add-Type`. In Windows PowerShell 5.1 that starts csc.exe, which starts
// cvtres.exe, on EVERY bridge invocation: two extra processes in the custody
// process tree per call, living a few milliseconds each. The remediation of
// the independent certification made every process in that tree subject to an
// external environment-block and command-line read, with no exemption by name,
// and those compiler processes routinely exited before any observer could read
// them. A process nobody can observe is a process nobody can vouch for.
//
// The signatures are therefore defined with System.Reflection.Emit — the same
// P/Invoke declarations, bound in this process, with no compiler and no child
// process at all. The CREDENTIALW structure is read and written by field
// OFFSET on unmanaged memory rather than through a managed struct, which is
// why the bridge refuses to run as anything but a 64-bit process.
//
// ---------------------------------------------------------------------------
// THE SECRET NEVER TOUCHES A COMMAND LINE
// ---------------------------------------------------------------------------
// This program is a FIXED CONSTANT. Nothing is interpolated into it, so there
// is no injection surface and no path by which a caller-supplied value could
// become part of the script text. Every input arrives on STDIN:
//
//   line 1   base64 of a compact JSON request. NON-SECRET: an op name, an
//            entry target, a username, a prefix, a process id.
//   line 2   base64 of the secret. Present for `deposit` only.
//
// and every output leaves on STDOUT:
//
//   line 1   base64 of a compact JSON response. NON-SECRET for every op.
//   line 2   base64 of the stored blob. Present for a successful `retrieve`
//            only, and on its own line so the reader can decode it from
//            bytes without ever holding it as a JavaScript string (see
//            db/custody/base64-bytes.ts and OF-CUST-1).
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
# ERROR_INVALID_HANDLE. What AttachConsole reports for a process that has no
# console. Any other failure is a failed check, never a 'no console' answer.
$ERROR_INVALID_HANDLE = 6

# CREDENTIALW field offsets for a 64-bit process.
$OFF_TYPE = 4
$OFF_TARGET_NAME = 8
$OFF_BLOB_SIZE = 32
$OFF_BLOB = 40
$OFF_PERSIST = 48
$OFF_USER_NAME = 72
$CREDENTIAL_SIZE = 80

function Get-NativeBridge {
  # The P/Invoke signatures, emitted in this process. No csc.exe, no child.
  $asmName = New-Object Reflection.AssemblyName('UellixCredBridge')
  $asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly($asmName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $mod = $asm.DefineDynamicModule('UellixCredBridge')
  $tb = $mod.DefineType('UellixCredBridge', [Reflection.TypeAttributes]'Public,Class,Abstract,Sealed')
  $dllImport = [Runtime.InteropServices.DllImportAttribute]
  $ctor = $dllImport.GetConstructor([Type[]]@([string]))
  $fields = [Reflection.FieldInfo[]]@($dllImport.GetField('SetLastError'), $dllImport.GetField('EntryPoint'), $dllImport.GetField('CharSet'))
  $byRefPtr = [IntPtr].MakeByRefType()
  $byRefU32 = [uint32].MakeByRefType()
  $imports = @(
    @{ Name = 'CredWrite'; Dll = 'advapi32.dll'; Entry = 'CredWriteW'; Ret = [bool]; Args = [Type[]]@([IntPtr], [uint32]) },
    @{ Name = 'CredRead'; Dll = 'advapi32.dll'; Entry = 'CredReadW'; Ret = [bool]; Args = [Type[]]@([string], [uint32], [uint32], $byRefPtr) },
    @{ Name = 'CredDelete'; Dll = 'advapi32.dll'; Entry = 'CredDeleteW'; Ret = [bool]; Args = [Type[]]@([string], [uint32], [uint32]) },
    @{ Name = 'CredEnumerate'; Dll = 'advapi32.dll'; Entry = 'CredEnumerateW'; Ret = [bool]; Args = [Type[]]@([string], [uint32], $byRefU32, $byRefPtr) },
    @{ Name = 'CredFree'; Dll = 'advapi32.dll'; Entry = 'CredFree'; Ret = [void]; Args = [Type[]]@([IntPtr]) },
    @{ Name = 'FreeConsole'; Dll = 'kernel32.dll'; Entry = 'FreeConsole'; Ret = [bool]; Args = [Type[]]@() },
    @{ Name = 'AttachConsole'; Dll = 'kernel32.dll'; Entry = 'AttachConsole'; Ret = [bool]; Args = [Type[]]@([int]) }
  )
  foreach ($imp in $imports) {
    $m = $tb.DefineMethod($imp.Name, [Reflection.MethodAttributes]'Public,Static,PinvokeImpl', $imp.Ret, $imp.Args)
    for ($i = 0; $i -lt $imp.Args.Length; $i++) {
      if ($imp.Args[$i].IsByRef) { [void]$m.DefineParameter($i + 1, [Reflection.ParameterAttributes]::Out, $null) }
    }
    $attr = New-Object Reflection.Emit.CustomAttributeBuilder($ctor, [object[]]@($imp.Dll), $fields, [object[]]@($true, $imp.Entry, [Runtime.InteropServices.CharSet]::Unicode))
    $m.SetCustomAttribute($attr)
  }
  return $tb.CreateType()
}

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

function Clear-Unmanaged($ptr, $length) {
  if ($ptr -ne [IntPtr]::Zero -and $length -gt 0) {
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $length), 0, $ptr, $length)
  }
}

function Invoke-Deposit($target, $username, $secretBytes) {
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($secretBytes.Length)
  $cred = [Runtime.InteropServices.Marshal]::AllocHGlobal($CREDENTIAL_SIZE)
  $targetPtr = [IntPtr]::Zero
  $userPtr = [IntPtr]::Zero
  try {
    Clear-Unmanaged $cred $CREDENTIAL_SIZE
    [Runtime.InteropServices.Marshal]::Copy($secretBytes, 0, $blob, $secretBytes.Length)
    $targetPtr = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($target)
    $userPtr = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($username)
    [Runtime.InteropServices.Marshal]::WriteInt32($cred, $OFF_TYPE, $CRED_TYPE_GENERIC)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($cred, $OFF_TARGET_NAME, $targetPtr)
    [Runtime.InteropServices.Marshal]::WriteInt32($cred, $OFF_BLOB_SIZE, $secretBytes.Length)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($cred, $OFF_BLOB, $blob)
    [Runtime.InteropServices.Marshal]::WriteInt32($cred, $OFF_PERSIST, $CRED_PERSIST_LOCAL_MACHINE)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($cred, $OFF_USER_NAME, $userPtr)
    $ok = $Native::CredWrite($cred, 0)
    $err = 0
    if (-not $ok) { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
    return @{ ok = $ok; win32 = $err }
  }
  finally {
    # Zero the unmanaged copies before releasing them. A freed-but-unzeroed
    # page is readable by whatever allocates it next.
    Clear-Unmanaged $blob $secretBytes.Length
    [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
    Clear-Unmanaged $cred $CREDENTIAL_SIZE
    [Runtime.InteropServices.Marshal]::FreeHGlobal($cred)
    if ($targetPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($targetPtr) }
    if ($userPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($userPtr) }
  }
}

function Invoke-Retrieve($target) {
  $ptr = [IntPtr]::Zero
  $ok = $Native::CredRead($target, $CRED_TYPE_GENERIC, 0, [ref]$ptr)
  if (-not $ok) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    return @{ ok = $false; present = $false; win32 = $err }
  }
  try {
    $size = [Runtime.InteropServices.Marshal]::ReadInt32($ptr, $OFF_BLOB_SIZE)
    $blobPtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $OFF_BLOB)
    $bytes = New-Object byte[] $size
    if ($size -gt 0) { [Runtime.InteropServices.Marshal]::Copy($blobPtr, $bytes, 0, $size) }
    $b64 = [Convert]::ToBase64String($bytes)
    [Array]::Clear($bytes, 0, $bytes.Length)
    # The response line carries no value. The blob follows on its OWN line.
    Write-Response @{ ok = $true; present = $true; win32 = 0; blobFollows = $true }
    [Console]::Out.WriteLine($b64)
    [Console]::Out.Flush()
    $b64 = $null
    return $null
  }
  finally {
    if ($ptr -ne [IntPtr]::Zero) { $Native::CredFree($ptr) }
  }
}

function Invoke-Probe($target) {
  # THE ABSENCE CHECK. It reads the SAME scope a deposit writes — the current
  # user's generic credential set — so an absent result means the entry is gone
  # and never that the check looked somewhere else. It reports PRESENT when the
  # entry is there, which is what makes it capable of returning false and
  # therefore worth anything at all (RC-6).
  $ptr = [IntPtr]::Zero
  $ok = $Native::CredRead($target, $CRED_TYPE_GENERIC, 0, [ref]$ptr)
  if ($ok) {
    if ($ptr -ne [IntPtr]::Zero) { $Native::CredFree($ptr) }
    return @{ ok = $true; present = $true; win32 = 0 }
  }
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($err -eq $ERROR_NOT_FOUND) { return @{ ok = $true; present = $false; win32 = $err } }
  # Any other code is a FAILED CHECK, not an absence. Reporting it as absence
  # is the false pass RC-6 names as the most dangerous one available here.
  return @{ ok = $false; present = $null; win32 = $err }
}

function Invoke-Remove($target) {
  $ok = $Native::CredDelete($target, $CRED_TYPE_GENERIC, 0)
  if ($ok) { return @{ ok = $true; deleted = $true; win32 = 0 } }
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  # Already absent is a SUCCESSFUL removal. Idempotence is what makes the
  # sweeper safe to run before and after every demonstration.
  if ($err -eq $ERROR_NOT_FOUND) { return @{ ok = $true; deleted = $false; win32 = $err } }
  return @{ ok = $false; deleted = $false; win32 = $err }
}

function Invoke-ConsoleProbe($targetPid) {
  # DOES THE GIVEN PROCESS HAVE A CONSOLE? Process delivery needs the answer
  # for its launcher: a consumer started without CREATE_NO_WINDOW shares its
  # parent's console, but a parent with NO console makes Windows create a new
  # conhost.exe for the consumer, and that conhost inherits the consumer's
  # whole environment block — the measured blocker B-1. This bridge has its
  # own console, so it detaches from it and tries to attach to the target's.
  [void]$Native::FreeConsole()
  $ok = $Native::AttachConsole([int]$targetPid)
  $err = 0
  if (-not $ok) { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  [void]$Native::FreeConsole()
  if ($ok) { return @{ ok = $true; attached = $true; win32 = 0 } }
  if ($err -eq $ERROR_INVALID_HANDLE) { return @{ ok = $true; attached = $false; win32 = $err } }
  return @{ ok = $false; attached = $null; win32 = $err }
}

function Invoke-Sweep($prefix) {
  # Enumerate every generic entry under a prefix and report their target
  # names. Target names are NON-SECRET by construction, and the caller bounds
  # the prefix to the reserved sentinel namespace.
  [uint32]$count = 0
  $arr = [IntPtr]::Zero
  $ok = $Native::CredEnumerate($prefix + '*', 0, [ref]$count, [ref]$arr)
  if (-not $ok) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq $ERROR_NOT_FOUND) { return @{ ok = $true; targets = @(); win32 = $err } }
    return @{ ok = $false; targets = @(); win32 = $err }
  }
  try {
    $targets = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $count; $i++) {
      $p = [Runtime.InteropServices.Marshal]::ReadIntPtr($arr, $i * 8)
      $namePtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($p, $OFF_TARGET_NAME)
      $null = $targets.Add([Runtime.InteropServices.Marshal]::PtrToStringUni($namePtr))
    }
    return @{ ok = $true; targets = @($targets.ToArray()); win32 = 0 }
  }
  finally {
    if ($arr -ne [IntPtr]::Zero) { $Native::CredFree($arr) }
  }
}

$secretBytes = $null
try {
  if ([IntPtr]::Size -ne 8) { Write-Response @{ ok = $false; error = 'NOT_A_64_BIT_PROCESS' }; exit 2 }
  $Native = Get-NativeBridge

  $reqLine = Read-B64Line
  if ($null -eq $reqLine) { Write-Response @{ ok = $false; error = 'NO_REQUEST_ON_STDIN' }; exit 2 }
  $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($reqLine)) | ConvertFrom-Json

  switch ($req.op) {
    'deposit' {
      $secretLine = Read-B64Line
      if ($null -eq $secretLine) { Write-Response @{ ok = $false; error = 'NO_SECRET_ON_STDIN' }; exit 2 }
      $secretBytes = [Convert]::FromBase64String($secretLine)
      $secretLine = $null
      if ($secretBytes.Length -eq 0) { Write-Response @{ ok = $false; error = 'EMPTY_SECRET' }; exit 2 }
      Write-Response (Invoke-Deposit $req.target $req.username $secretBytes)
    }
    'retrieve' { $r = Invoke-Retrieve $req.target; if ($null -ne $r) { Write-Response $r } }
    'probe'    { Write-Response (Invoke-Probe $req.target) }
    'remove'   { Write-Response (Invoke-Remove $req.target) }
    'sweep'    { Write-Response (Invoke-Sweep $req.prefix) }
    'console'  { Write-Response (Invoke-ConsoleProbe $req.pid) }
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

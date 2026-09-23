// scripts/custody/n05-peb-observer.ts
//
// THE EXTERNAL PROCESS OBSERVER, READING EACH PROCESS'S OWN PEB.
//
// The first version of this demonstration observed command lines through
// Win32_Process and never read an environment block at all. It therefore
// could not see that a conhost.exe child of the consumer carried the delivered
// value, and it declared conhost clean BY NAME. The independent certification
// found the value there by reading the block directly. This observer does what
// the certifier did, as a deterministic part of the demonstration:
//
//   - it runs as a SEPARATE process, so no subject reports on itself;
//   - it polls every ~15ms, reading, for every process created after it
//     started (plus the launcher and every explorer.exe), the command line
//     and the environment block straight out of the process's PEB with
//     ReadProcessMemory;
//   - it searches both for the governed representations of the value and for
//     the variable NAME, and reports only BOOLEANS and bit masks — never a
//     command line, never an environment entry, never a needle.
//
// The needles arrive on stdin, never on its argv, and its own environment is a
// four-variable allowlist. It is demonstration scaffolding, not production
// code, which is why it lives under scripts/custody/.

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * The observer program. Fixed and uninterpolated, like the bridge; free of
 * backticks and of the dollar-brace sequence so the template literal holding it
 * cannot alter a byte.
 */
export const PEB_OBSERVER_POWERSHELL_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class UellixPebObserver {
  [StructLayout(LayoutKind.Sequential)]
  struct PBI { public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; }

  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
  [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess")] static extern int NtQueryWow(IntPtr h, int cls, out IntPtr val, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);

  class Rec { public int pid; public int ppid = -1; public string name; public bool cmdReadable; public bool envReadable; public bool envVar; public int govCmd; public int govEnv; public int fixCmd; public int fixEnv; public int classes; public int reads; public bool alive; public string first; }

  static byte[] varName;
  static List<byte[]> gov = new List<byte[]>();
  static List<byte[]> fix = new List<byte[]>();
  static List<byte[]> cls = new List<byte[]>();
  static Dictionary<int, Rec> recs = new Dictionary<int, Rec>();
  static HashSet<int> baseline = new HashSet<int>();
  static HashSet<int> watch = new HashSet<int>();
  static object gate = new object();
  static volatile bool stop = false;
  static volatile string label = "start";
  static int polls = 0;

  static IntPtr Open(int pid) {
    IntPtr h = OpenProcess(0x0400 | 0x0010, false, pid);
    if (h == IntPtr.Zero) h = OpenProcess(0x1000 | 0x0010, false, pid);
    return h;
  }
  static byte[] Read(IntPtr h, IntPtr a, int n) {
    if (n <= 0 || n > 16 * 1024 * 1024) return null;
    byte[] b = new byte[n]; IntPtr r;
    if (!ReadProcessMemory(h, a, b, (IntPtr)n, out r)) return null;
    return b;
  }
  static IntPtr ReadPtr(IntPtr h, IntPtr a) { byte[] b = Read(h, a, 8); return b == null ? IntPtr.Zero : (IntPtr)BitConverter.ToInt64(b, 0); }

  static int Peb(IntPtr h, out byte[] cmd, out byte[] env) {
    cmd = null; env = null;
    PBI p = new PBI(); int ret;
    if (NtQueryInformationProcess(h, 0, ref p, Marshal.SizeOf(typeof(PBI)), out ret) != 0) return -1;
    int ppid = (int)(long)p.InheritedFromUniqueProcessId;
    IntPtr wow; int r2;
    if (NtQueryWow(h, 26, out wow, IntPtr.Size, out r2) == 0 && wow != IntPtr.Zero) return ppid;
    IntPtr pp = ReadPtr(h, p.PebBaseAddress + 0x20);
    if (pp == IntPtr.Zero) return ppid;
    byte[] us = Read(h, pp + 0x70, 16);
    if (us != null) {
      int len = BitConverter.ToUInt16(us, 0);
      IntPtr buf = (IntPtr)BitConverter.ToInt64(us, 8);
      if (len > 0 && buf != IntPtr.Zero) cmd = Read(h, buf, len);
    }
    IntPtr envp = ReadPtr(h, pp + 0x80);
    byte[] sz = Read(h, pp + 0x3F0, 8);
    if (envp != IntPtr.Zero && sz != null) {
      long n = BitConverter.ToInt64(sz, 0);
      if (n > 0 && n < 4 * 1024 * 1024) env = Read(h, envp, (int)n);
    }
    return ppid;
  }

  static bool Has(byte[] hay, byte[] nd) {
    if (hay == null || nd == null || nd.Length == 0) return false;
    int last = hay.Length - nd.Length; byte f = nd[0];
    for (int i = 0; i <= last; i++) {
      if (hay[i] != f) continue;
      int j = 1; while (j < nd.Length && hay[i + j] == nd[j]) j++;
      if (j == nd.Length) return true;
    }
    return false;
  }
  static int Mask(byte[] hay, List<byte[]> nds) { int m = 0; for (int i = 0; i < nds.Count; i++) if (Has(hay, nds[i])) m |= (1 << i); return m; }

  static void Inspect(int pid, string name) {
    Rec r;
    lock (gate) { if (!recs.TryGetValue(pid, out r)) { r = new Rec(); r.pid = pid; r.name = name; r.first = label; recs[pid] = r; } r.alive = true; }
    IntPtr h = Open(pid);
    if (h == IntPtr.Zero) return;
    try {
      byte[] cmd, env; int ppid = Peb(h, out cmd, out env);
      lock (gate) {
        if (ppid >= 0) r.ppid = ppid;
        r.reads++;
        if (cmd != null) { r.cmdReadable = true; r.govCmd |= Mask(cmd, gov); r.fixCmd |= Mask(cmd, fix); r.classes |= Mask(cmd, cls); }
        if (env != null) { r.envReadable = true; if (Has(env, varName)) r.envVar = true; r.govEnv |= Mask(env, gov); r.fixEnv |= Mask(env, fix); }
      }
    } finally { CloseHandle(h); }
  }

  static void Loop() {
    while (!stop) {
      HashSet<int> seen = new HashSet<int>();
      foreach (Process pr in Process.GetProcesses()) {
        seen.Add(pr.Id);
        if (baseline.Contains(pr.Id) && !watch.Contains(pr.Id)) continue;
        string nm = "?"; try { nm = pr.ProcessName; } catch { }
        try { Inspect(pr.Id, nm); } catch { }
      }
      lock (gate) { foreach (Rec r in recs.Values) if (!seen.Contains(r.pid)) r.alive = false; }
      Interlocked.Increment(ref polls);
      Thread.Sleep(15);
    }
  }

  static string Dump() {
    StringBuilder sb = new StringBuilder();
    sb.Append("{\"kind\":\"DUMP\",\"polls\":").Append(polls).Append(",\"processes\":[");
    bool first = true;
    lock (gate) {
      foreach (Rec r in recs.Values) {
        if (!first) sb.Append(","); first = false;
        sb.Append("{\"pid\":").Append(r.pid).Append(",\"ppid\":").Append(r.ppid)
          .Append(",\"name\":\"").Append((r.name ?? "?").Replace("\"", "")).Append("\"")
          .Append(",\"cmdReadable\":").Append(r.cmdReadable ? "true" : "false")
          .Append(",\"envReadable\":").Append(r.envReadable ? "true" : "false")
          .Append(",\"envVar\":").Append(r.envVar ? "true" : "false")
          .Append(",\"govCmd\":").Append(r.govCmd).Append(",\"govEnv\":").Append(r.govEnv)
          .Append(",\"fixCmd\":").Append(r.fixCmd).Append(",\"fixEnv\":").Append(r.fixEnv)
          .Append(",\"classes\":").Append(r.classes).Append(",\"reads\":").Append(r.reads)
          .Append(",\"alive\":").Append(r.alive ? "true" : "false")
          .Append(",\"firstSeenAt\":\"").Append(r.first).Append("\"}");
      }
    }
    return sb.Append("]}").ToString();
  }

  public static void Run(int root, string varB64, string[] govB64, string[] fixB64, string[] clsB64) {
    varName = Convert.FromBase64String(varB64);
    foreach (string s in govB64) gov.Add(Convert.FromBase64String(s));
    foreach (string s in fixB64) fix.Add(Convert.FromBase64String(s));
    foreach (string s in clsB64) cls.Add(Convert.FromBase64String(s));
    foreach (Process p in Process.GetProcesses()) baseline.Add(p.Id);
    watch.Add(root);
    foreach (Process p in Process.GetProcessesByName("explorer")) watch.Add(p.Id);
    Thread t = new Thread(Loop); t.IsBackground = true; t.Start();
    while (polls < 2) Thread.Sleep(5);
    Console.Out.WriteLine("{\"kind\":\"READY\"}"); Console.Out.Flush();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line.StartsWith("MARK ")) { label = line.Substring(5); Console.Out.WriteLine("{\"kind\":\"MARK\"}"); }
      else if (line == "DUMP") { int p0 = polls; while (polls < p0 + 2) Thread.Sleep(5); Console.Out.WriteLine(Dump()); }
      else if (line == "STOP") { int p0 = polls; while (polls < p0 + 2) Thread.Sleep(5); stop = true; Console.Out.WriteLine(Dump()); Console.Out.Flush(); break; }
      Console.Out.Flush();
    }
  }
}
'@
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())) | ConvertFrom-Json
[UellixPebObserver]::Run([int]$cfg.root, [string]$cfg.varName, [string[]]@($cfg.governed), [string[]]@($cfg.fixture), [string[]]@($cfg.classes))
`

/** One observed process. Booleans and masks only — never content. */
export interface PebObservedProcess {
  readonly pid: number
  readonly ppid: number
  readonly name: string
  readonly cmdReadable: boolean
  readonly envReadable: boolean
  /** The delivery variable NAME was present in its environment block. */
  readonly envVar: boolean
  /** Bit i set: governed representation i was found in the command line. */
  readonly govCmd: number
  /** Bit i set: governed representation i was found in the environment block. */
  readonly govEnv: number
  readonly fixCmd: number
  readonly fixEnv: number
  /** Bit i set: classifier marker i was found in the command line. */
  readonly classes: number
  readonly reads: number
  /** Seen in the most recent poll before the dump. */
  readonly alive: boolean
  readonly firstSeenAt: string
}

export interface PebDump {
  readonly polls: number
  readonly processes: readonly PebObservedProcess[]
}

/** UTF-16LE, which is how Windows stores both the command line and the environment block. */
function utf16(bytes: Buffer): string {
  return Buffer.from(bytes.toString('latin1'), 'utf16le').toString('base64')
}

export interface PebObserverConfig {
  /** The launcher. Watched even though it predates the observer. */
  readonly rootPid: number
  readonly envVarName: string
  /** Governed representations of the value, as the bytes the mechanism creates. Stdin only. */
  readonly governed: readonly Buffer[]
  /** Positive-control fixture representations. NOT the value. */
  readonly fixture: readonly Buffer[]
  /** Non-secret command-line markers that classify a process (bridge, consumer). */
  readonly classes: readonly string[]
}

/**
 * A running observer. `dump()` waits for two fresh polls so the answer
 * reflects the present, and `stop()` returns the final record.
 */
export class PebObserver {
  private readonly child: ChildProcess
  private readonly lines: string[] = []
  private readonly waiters: Array<(l: string) => void> = []

  private constructor(child: ChildProcess) {
    this.child = child
    createInterface({ input: child.stdout! }).on('line', (l) => {
      const w = this.waiters.shift()
      if (w) w(l)
      else this.lines.push(l)
    })
  }

  static async start(config: PebObserverConfig): Promise<PebObserver> {
    const argv = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(PEB_OBSERVER_POWERSHELL_SOURCE, 'utf16le').toString('base64'),
    ]
    const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV }
    for (const k of ['SystemRoot', 'TEMP', 'TMP', 'PATH'] as const) {
      if (process.env[k] !== undefined) env[k] = process.env[k]
    }
    const child = spawn('powershell.exe', argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
    const obs = new PebObserver(child)
    const cfg = {
      root: config.rootPid,
      varName: utf16(Buffer.from(`${config.envVarName}=`, 'latin1')),
      governed: config.governed.map(utf16),
      fixture: config.fixture.map(utf16),
      classes: config.classes.map((c) => utf16(Buffer.from(c, 'latin1'))),
    }
    const line = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64')
    child.stdin!.write(`${line}\n`)
    const ready = JSON.parse(await obs.next()) as { kind: string }
    if (ready.kind !== 'READY') throw new Error('The PEB observer did not start.')
    return obs
  }

  private next(): Promise<string> {
    return new Promise((res) => {
      const l = this.lines.shift()
      if (l !== undefined) res(l)
      else this.waiters.push(res)
    })
  }

  async mark(label: string): Promise<void> {
    this.child.stdin!.write(`MARK ${label.replace(/[^A-Za-z0-9_]/g, '_')}\n`)
    await this.next()
  }

  async dump(): Promise<PebDump> {
    this.child.stdin!.write('DUMP\n')
    return JSON.parse(await this.next()) as PebDump
  }

  async stop(): Promise<PebDump> {
    this.child.stdin!.write('STOP\n')
    const d = JSON.parse(await this.next()) as PebDump
    this.child.stdin!.end()
    return d
  }
}

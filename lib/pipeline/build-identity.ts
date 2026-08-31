// lib/pipeline/build-identity.ts
// FIBIU-02 (FIBC-001) — the deployed build's identity, one third of the run
// version identity triple. System-resolved, no human boundary: Vercel stamps
// VERCEL_GIT_COMMIT_SHA on every build automatically
// (https://vercel.com/docs/environment-variables/system-environment-variables),
// so production and preview deployments need no configuration. BUILD_IDENTITY
// is the explicit override for environments Vercel doesn't stamp (local dev,
// self-hosted, CI) — never a fabricated fallback: if neither is set, the
// build has no identity to report, and resolveBuildIdentity says so.

export function resolveBuildIdentity(
  env: Record<string, string | undefined> = process.env
): string | null {
  return env.VERCEL_GIT_COMMIT_SHA || env.BUILD_IDENTITY || null
}

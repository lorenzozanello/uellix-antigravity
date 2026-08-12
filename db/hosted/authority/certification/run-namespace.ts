// db/hosted/authority/certification/run-namespace.ts
// F-4 — two certifications on one machine, neither deleting the other's work.
//
// ---------------------------------------------------------------------------
// THE COLLISION
// ---------------------------------------------------------------------------
// Both certification harnesses named their Docker resources from a FIXED
// prefix: `uellix-pg176-cert-primary`, `uellix-pg176-cert-snapshot:bootstrap`.
// A container name is unique per daemon and an image tag is unique per
// repository, so a second run did not fail — it took them. `startContainer`
// begins with `docker rm -f <name>`, which removed the first run's live
// container; `docker commit` overwrote its snapshot; and teardown then removed
// the image the first run was still injecting failures into. The first run
// reported whatever that wreckage measured.
//
// So resources are namespaced per RUN. The pre-emptive `rm -f` and the
// `startsWith` cleanup guard both survive unchanged and become strictly
// narrower: a run can only ever name, and only ever remove, its own.
//
// ---------------------------------------------------------------------------
// AND WHY THE TOKEN MUST NOT REACH THE ARTEFACT
// ---------------------------------------------------------------------------
// `artifacts/pg176-certification/latest.json` is TRACKED. It is the record of
// what the engine did, and its content has to be a function of the chain and
// the engine alone — otherwise every run produces a diff, reviewers learn that
// the diff is noise, and the one run whose CONTENT changed goes unread.
//
// A pid is not a fact about the database. `assertRunNamespaceAbsent` is called
// on the way to disk so that this is enforced rather than intended.

/**
 * A token unique to one run of one certification harness.
 *
 * pid AND start time: pid alone repeats after a reboot or a wrap, which would
 * let a stale container from an earlier run be adopted — and adopted is worse
 * than colliding, because the run would then certify a database it did not
 * provision. Separated by `-` so the pair is recoverable and two different
 * pairs cannot concatenate to the same token.
 *
 * Lowercase base36: a Docker image REPOSITORY may not carry uppercase, and the
 * same token names both containers and repositories.
 */
export function certificationRunNamespace(pid: number, startedAtMs: number): string {
  return `r${pid.toString(36)}-${startedAtMs.toString(36)}`
}

/** `uellix-pg176-cert` + this run's token. Every resource name derives from it. */
export function namespacedPrefix(base: string, namespace: string): string {
  return `${base}-${namespace}`
}

/**
 * Whether a Docker resource belongs to the run that owns `prefix`.
 *
 * `-` for containers (`<prefix>-primary`), `:` for snapshot images
 * (`<prefix>:bootstrap`). Anything else — including the un-namespaced names a
 * pre-F-4 run left behind — is somebody else's, and this run does not remove
 * it. Cleaning up an abandoned container is a person's decision, not a side
 * effect of running a certification.
 */
export function ownsResource(prefix: string, candidate: string): boolean {
  return candidate.startsWith(`${prefix}-`) || candidate.startsWith(`${prefix}:`)
}

/**
 * Refuses to record evidence that carries this run's token.
 *
 * Serialises the whole structure rather than checking known fields: the leak
 * that matters is the one nobody predicted — a container name inside a
 * diagnostic string, a docker error captured into a probe result. Checking the
 * fields we thought of would miss exactly those.
 */
export function assertRunNamespaceAbsent(evidence: unknown, namespace: string): void {
  const serialised = JSON.stringify(evidence) ?? ''
  if (serialised.includes(namespace)) {
    throw new Error(
      `CERT_RUN_NAMESPACE_LEAKED: the run token ${namespace} appears in the certification ` +
        `evidence. That artefact is versioned and its content must be a function of the chain ` +
        `and the engine, not of which process happened to run it. Find the field carrying a ` +
        `container or image name and record the resource's ROLE instead.`,
    )
  }
}

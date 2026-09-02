---
name: uellix-focused-reaudit
description: "Review a bounded remediation only, not the whole historical batch: consumes an audit:batch packet, the authority artifact, the candidate parent/head, a test manifest, and any prior audit disposition. Spends semantic tokens on new runtime semantics, atomicity/security, authority conformance, mutation-control strength, and new gaps only — never recomputes a machine-proven deterministic fact unless explicitly challenging it. Outputs PASS/FAIL/BLOCKED/INSUFFICIENT_EVIDENCE. Use for a remediation re-audit after a batch was previously audited and only a bounded delta needs review."
---

# Uellix Focused Reaudit

Reviews **the bounded remediation**, not the whole historical batch. See
`docs/ops/ods/UELLIX_DEV_OS_OPERATING_MODEL_v1.0.0.md` for the shared
rules this skill inherits, especially section 4 (fact vs. adjudication) —
this skill is the one place in the layer that MAY reach a semantic
verdict, and even then only `PASS`/`FAIL`/`BLOCKED`/`INSUFFICIENT_EVIDENCE`.

```status_vocabulary
PASS
FAIL
BLOCKED
INSUFFICIENT_EVIDENCE
```

## When to use

- A batch/node was previously audited (accepted, remediated, or found
  deficient), and a bounded remediation now needs review — not a fresh
  full audit of everything since the original baseline.
- The remediation's scope is small enough that `pnpm audit:batch` can
  characterize it in one packet.

## Skip

- A genuinely first-time, full-batch audit with no prior disposition to
  bound against — that needs a broader review, not this focused skill.

## Required inputs

1. An `audit:batch` packet for the remediation's own base/head/target-branch
   (`pnpm audit:batch -- --base <ref> --head <ref> --target-branch <branch> [--authority <id>] --json`).
2. The frozen authority artifact the remediation claims to satisfy.
3. The candidate parent/head refs (already in the packet's
   `baseRef`/`headRef`/`targetRef`).
4. The node/batch's `uellix-test-manifest`.
5. The prior audit's disposition (what was previously found, and what this
   remediation claims to have fixed).

If any of these five is missing or unreadable, stop and report
`INSUFFICIENT_EVIDENCE` — do not proceed on partial inputs by filling the
gap with assumption.

## What NOT to recompute

Everything the `audit:batch` packet already reports as a measured fact —
`CHANGED_FILE_COUNT`, `PROTECTED_FILE_COUNT`,
`PROTECTED_AUTHORITY_DISPOSITION`, `SEMANTIC_REVIEW_REQUIRED_FILES`,
`BASE_RAW_FAILURES`/`HEAD_RAW_FAILURES`, `KNOWN_SAME_CONDITION_COUNT`,
`NEW_FAILURE_COUNT`, `TYPECHECK`/`SECRETS_SCAN`/`AUTHORITY_SEAL_VERIFY`,
`ODS_SCOPE`, `ODS_POSTSTATE_RAW` — is read from the packet, not
re-derived. Re-run the underlying tool again only when the audit is
EXPLICITLY challenging that specific machine fact (e.g. suspecting the
packet was generated against a stale ref) — and say so out loud when doing
it, rather than silently redoing work the machine layer already did.

## Where semantic tokens go instead

- **New runtime semantics** the remediation introduces beyond what the
  authority already specified.
- **Atomicity/security** — does the remediation's mutation sequence hold
  its invariants under a partial failure, and does it avoid a new
  injection/secret-exposure surface?
- **Authority conformance** — does the remediation actually satisfy the
  cited authority clause, not merely pass CI?
- **Mutation-control strength** — for each `mutation_controls` entry in
  the test manifest, would removing the guarantee it targets actually be
  caught by the test suite, or does the test only exercise the happy path?
- **New gaps** the remediation itself introduces, not gaps already
  disclosed and dispositioned in the prior audit (re-relitigating a
  disclosed, accepted gap is out of scope for a FOCUSED reaudit).

## Output

```
PASS      — every machine gate the packet reports is clean for this
            remediation's own diff, no new semantic gap found, and the
            remediation's authority-conformance claim holds.
FAIL      — a measured fact (NEW_FAILURE_COUNT>0, a protected violation,
            a raw gate FAIL not explained by a KNOWN_SAME_CONDITION) or a
            newly-found semantic gap blocks acceptance.
BLOCKED   — the finding requires an HPO/human decision this skill cannot
            make (e.g. the authority itself is ambiguous about the
            remediation's approach).
INSUFFICIENT_EVIDENCE — a required input (see above) is missing or
            unreadable.
```

## Never

- Never invent closure authority — this skill's `PASS` means "the
  remediation's own bounded diff is sound," never `B2_CLOSED`,
  `AUTHORITY_ACCEPTED`, or any other product/HPO-level acceptance token.
  That decision belongs to the human product owner, recorded in its own
  frozen closure artifact — not to this skill.
- Never treat a raw gate FAIL as PASS because it maps to a
  `KNOWN_SAME_CONDITION` — report both facts; `KNOWN_SAME_CONDITION_COUNT`
  explains WHY a raw failure is not NEW, it does not make the raw failure
  disappear.
- Never re-litigate a gap the prior audit already disclosed and
  dispositioned as accepted/deferred, unless the remediation itself
  reopens that exact surface.

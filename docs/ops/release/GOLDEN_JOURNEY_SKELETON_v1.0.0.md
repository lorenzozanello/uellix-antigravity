# Golden Journey skeleton v1.0.0

Companion prose for `GOLDEN_JOURNEY_SKELETON_v1.0.0.json`. The JSON is the
machine artifact; this file explains the decisions behind it.

This artifact **consumes** `HPO-G-03`. It does not redefine `PILOT_READY`, the
release stages, RC semantics, or the three journeys — those belong to
`STAGING_RELEASE_PRODUCTION_AUTHORITY_v1.0.0.json` and
`RELEASE_GATE_LEDGER_v1.0.0.json` and are unchanged by this lane.

---

## 1. What changed

`STAGING_RELEASE_PRODUCTION_AUTHORITY_v1.0.0.json` records the runner status at
its base as *"NOT PRESENT in the repository. No browser automation dependency of
any kind exists."* That is now false: `@playwright/test` is installed,
`playwright.config.ts` collects `tests/golden/**`, and all 23 frozen steps are
expressed as executable contracts.

**M9, J1, J2 and J3 remain `ABSENT`.** Nothing in this lane advances them. M9
requires the three journeys green against a Preview deployment satisfying S4;
S4 is not satisfied, so no tier available here can be cited as M9 evidence.
`m9DisqualificationReason` in `tests/golden/target.ts` is the single place that
judgement is made, and it refuses every tier this lane can reach.

---

## 2. The step set is derived, then pinned

The frozen authority states each journey's path as a comma-separated English
sentence. The obvious implementation is to copy the 13 J1 steps into an array.
That array would agree with the authority exactly once — at the moment it was
typed — after which the authority could gain, lose or rename a step while the
harness kept reporting green against a set that no longer exists.

So the steps are **derived** at runtime by parsing
`GOLDEN_JOURNEY_RUNNER.journeys[].path`, and the derived set is compared
against a **pinned** set in the JSON artifact.

Parsing prose is itself a hazard, and it is contained by two things:

1. the parser is fail-closed — a path that splits into fewer than two steps
   raises rather than returning a short list, because a silently-short list is
   exactly how a required step count drops unnoticed;
2. derivation and pin must agree — a change to *either* side is a loud,
   locatable failure rather than a quiet disagreement.

Derived: **J1 = 13, J2 = 8, J3 = 2, total 23.**

---

## 3. What a blocked contract has to do to be worth anything

A blocked contract that restates a frozen blocker sentence asserts nothing. The
sentence is true because it is written down, and it stays true after the
blocker is fixed, because nothing re-reads the world.

A blocked contract earns its place only if some change to this repository makes
it **fail**. That is the mechanism's entire purpose: when the blocker is
remediated, the contract turns RED and forces its step to be converted into a
positive journey assertion.

Four posture probes measure a current property of the source and are asserted
live on every run, including in the default no-target tier. They back **three**
steps and one negative control — probe count and posture-backed step count are
different numbers and must not be conflated:

| Probe | Surface | Turns RED when |
|---|---|---|
| `J1-EVALUATE-RUNTIME-ABSENT` | `app/**`, `lib/evaluate` | an evaluation runtime appears |
| `J2-PLATFORM-PRINCIPAL-AMBIGUOUS` | `db/schema.ts` | flag and tenant role stop sharing `super_admin` |
| `J3-PUBLIC-VERIFICATION-NOT-LIVE` | CAP-02 descriptor + the verifier read path | CAP-02 is enabled **and** the verifier calls it |
| `J3-NO-RATE-LIMIT` | `app/(public)/verify/**` **and** `proxy.ts` | a limiter governs `/verify` |

Each was verified to flip by mutating the real working tree, not only by an
in-memory fixture.

### Coverage honesty

**20 of the 23 steps are blocked by target absence alone.** They carry no
substantive assertion about the product — they are *recorded*, not *proven*.
Only 3 steps are backed by a falsifiable posture probe. The registry marks this
distinction, the test titles carry it (`[posture-asserted]` vs
`[target-absence only]`), and the JSON pins both counts.

Presenting 23 green rows as 23 controls would be a worse defect than having
fewer of them.

---

## 4. J3's positive leg and its negative control are indistinguishable

`lib/reports/public-verify.ts` documents that after the runtime cutover an
anonymous caller matches no member-scoped SELECT policy, so the query returns
zero rows and the page calls `notFound()`. **A locator that exists and a
locator that does not both render 404.**

So the obvious negative control — request a bogus locator, assert 404 — passes
today, would have passed before the cutover, and would keep passing if the
refusal were removed entirely and replaced by a blanket 404. It discriminates
nothing.

What is asserted instead: the bogus locator is refused **and** the response
carries none of the verified page's own markers, plus an explicit assertion
that the indistinguishability still holds — which turns RED when CAP-02 goes
live.

### What "goes live" actually means (rebuilt in R2)

R1 watched `lib/reports/public-verify.ts` for a `service_role` escape and called
that "the anonymous read is fail-closed". Review was right to reject it: the
repository's design **forbids** such an escape — CAP-02 exists precisely to
avoid one — so the trigger was a change nobody intends to make. A detector whose
trigger is a prohibited change will never fire.

`docs/ops/capabilities/CAP_02_PUBLIC_VERIFICATION.md` states the real
transition: *"Estado: DISEÑO. No aplicado. No habilitado."* Becoming live
requires **both**:

1. the capability is wired — `PUBLIC_VERIFICATION_CAPABILITY.enabled` in
   `lib/capabilities/contracts.ts` (read as a *value* via import, not scraped
   from source text);
2. the verifier calls it — `uellix_capability.verify_report` on the read path.

**Design presence is not remediation.** The 58KB prepared package
`db/prepared/stella_0007_public_verification_capability.sql` is already in the
tree. A probe keyed on file presence would report public verification
remediated while nothing was enabled and nothing was wired. The flag is
recorded, deliberately does **not** vote, and a dedicated control drives exactly
that combination to prove it changes nothing. The two intermediate rollout
states — enabled-but-unwired and wired-but-disabled — must also still report
blocked, and both are asserted.

---

## 5. Why the deterministic tier serves nothing

A local boot was attempted and measured, not assumed:

- `next build` exits **0** with placeholder environment values;
- `next start` then returns **HTTP 500 on every route probed** — `/login`,
  `/signup`, `/admin`, `/admin/logs`, `/app/dashboard`, `/verify/<locator>` and
  its PDF route;
- cause: `proxy.ts` matches every non-asset route and calls `updateSession`,
  which cannot reach a Supabase instance. The failure precedes all page logic,
  which is why even `/login` returns 500.

A 500 from absent infrastructure is **not a governed refusal**. Asserting it
would encode a temporary blocker as desired behaviour, which is precisely what
this lane is forbidden to do. `LOCAL_APP` is therefore supported but not
exercised by the deterministic workflow.

---

## 6. The network boundary is new, not inherited

`vitest.setup.network-guard.ts` closes a real incident in which concurrent
dynamic imports defeated a module mock and reached the live model endpoint. It
is installed through Vitest `setupFiles`.

**Playwright loads no Vitest setup file.** Every protection that guard provides
is absent in this runner by construction — not weakened, absent. So the harness
carries its own, in two layers, because they cover different traffic:

- **Node layer** — wraps `globalThis.fetch` in the **worker** process, throwing
  synchronously so an existing `.catch()` cannot convert a hard stop into a
  retry loop;
- **Browser layer** — `context.route('**')` aborts anything outside the
  allowlist. Browser traffic never passes through Node's `fetch`, so the Node
  layer alone would be entirely silent about the journey's own requests.

The shape is an **allowlist** (declared target origin plus loopback), not a
denylist: a denylist is always one new vendor out of date. Blocked requests are
**aborted, never stubbed** — a stub would be a development-only workaround
inserted into the journey path, which the frozen authority forbids.

### Where R1 got this wrong, and why `globalSetup` would not have fixed it

R1 **defined** `installNodeEgressGuard` and never called it. Review found zero
call sites. A declared control with no call site answers "is egress guarded?"
with a file.

The obvious repair — a `globalSetup` that installs the guard once — would have
been wrong in a way that still looked green. Playwright runs `globalSetup` in
the **runner** process and test files in **worker** processes: different OS
processes, different module registries, different `globalThis`. Measured on this
tree, the config loaded in pid `27256` (runner) and pid `33160` (worker); the
guard records `installedInPid = 33160`, the process that actually runs test
code. A runner-side installation would have wrapped the wrong `fetch`.

So the guard is installed by a **worker-scoped auto fixture** in
`tests/golden/harness.ts`, every Golden file imports `test` from there, and the
meta guard fails on any file that imports it from `@playwright/test` directly —
because such a file would run outside the fixture, and therefore outside the
guard.

Five proofs, none of which emits a live request (the forbidden host is under
`.invalid`, and delegation is observed through a spy rather than a socket):

1. unguarded, the call reaches the transport spy — establishing the boundary;
2. guarded, it throws **synchronously** and leaves the spy **uncalled**;
3. allowed loopback traffic still delegates;
4. the guard is active in *this* pid — the permanent control, verified RED when
   the fixture is removed;
5. no model-provider host is in the allowlist under the declared target.

---

## 7. Two naming decisions forced by the write-set ceiling

Both are consequences of surfaces this lane does not own. Neither was taken
silently.

**`no-silent-skip.guard.ts`, not `.test.ts`.** `vitest.config.ts` sets no
`include`, so Vitest's default `**/*.{test,spec}.*` glob would collect a
`.test.ts` under `tests/golden/` and fail on the `@playwright/test` import —
breaking `pnpm test`, a gate every other lane depends on. The natural fix is a
`tests/golden/**` entry in `vitest.shared.ts`, which is outside this lane's
authorised write-set. The collision is avoided from the authorised side
instead.

**Playwright output outside the repository** (`os.tmpdir()/uellix-golden-journey`,
overridable via `GOLDEN_JOURNEY_OUTPUT_DIR`). `artifacts/` is the repository's
conventional home for run records and is on this lane's forbidden list;
Playwright's default `test-results/` is neither tracked nor ignored.

R1 routed output to `tests/golden/.playwright-output/`, inside the authorised
write-set. That passed the scope gate **for the wrong reason**: authorised bytes
are still ordinary untracked repository files, and an allow-list cannot
distinguish a generated trace from a source file someone forgot to commit.
Writing outside the checkout removes the ambiguity at the source instead of
asking a gate to adjudicate it — and needs no `.gitignore` entry, which this
lane could not add anyway.

### Declared follow-up

A lane authorised for `vitest.shared.ts` should add `tests/golden/**` to it,
after which the guard may be renamed to `no-silent-skip.test.ts`. Not required
for this skeleton to function.

---

## 8. What the meta guard proves, and what proves the meta guard

`tests/golden/meta/no-silent-skip.guard.ts` asserts zero `.skip`, `.fixme`,
`.only`, bare `skip()` and `testInfo.skip()` across every collected Golden
file — **including itself**. The bypass patterns live in a separate module so
the guard's own source contains no marker literal and can therefore be scanned
by its own scan; holding them inline would force either a self-match on every
run or an exemption, and an exempt policing file is exactly where a bypass
would be parked.

Every check is paired with a control that must make it RED. This repository has
shipped a duplicate-key checker built on a `JSON.parse` reviver that passed on
input containing duplicates, and a `grep -c` that returned the expected count by
matching a commented-out line. Both were green and both were vacuous.

Verified RED by mutating the real tree:

| Mutation | Result |
|---|---|
| `test.skip(` injected into a journey file | RED — names file and pattern |
| a pinned step removed from the JSON | RED — derived/pinned count mismatch |
| a rate limiter wired onto the verify surface | RED — `J3-NO-RATE-LIMIT` no longer holds |

The bypass scanner is additionally pointed at a fixture containing all eight
forms and must report the **exact** id set — not merely a non-zero count, which
a silently-broken pattern would still satisfy.

### A hole this caught in itself

The first implementation of `disposeStep` returned early when no target was
declared, leaving the posture reading undefined. That made the entire posture
layer **inert in the default deterministic tier** — the one tier where it is
the only substantive assertion available. All three posture-backed steps would
have collapsed into the same "no target" record as the other twenty, and the
remediation signal would never have fired in CI. The contract suite failed on
it immediately.

---

## 9. The run record, not the exit code

Playwright exits 0 when everything it *collected* passed — and also when it
collected nothing. For a battery whose purpose is to prove 23 steps are each
expressed, that is the one failure mode that must not be survivable.

`tests/golden/reconcile-run.ts` therefore reconciles the executed set against
the frozen step set and is what the workflow trusts. It fails on: zero executed
tests, any frozen step with no executed test, any skipped or non-terminal
status, and any SHA mismatch. An unreadable run record is a failure, never a
pass-by-absence.

---

## 10. Pilot fixture: definitions only

`tests/golden/fixtures/pilot-fixture.ts` defines one organisation, three
projects at three completion states, five roles, representative evidence and
results, an exception case, portfolio variation, an evaluation placeholder, and
a foreign principal for the cross-tenant control.

It **writes nothing** — no database client, no seeding function, no migration,
no environment read. This lane's write-set excludes `db/**`, and a
self-provisioning fixture would have to reach either a canonical environment
(forbidden) or an invented local one (out of scope, and certain to drift from
the real schema). Materialisation belongs to the lane that also owns the target.

Every identifier carries the `golden-pilot` prefix and every address uses
`golden-pilot.invalid` (RFC 2606 reserved, can never resolve), so a fixture row
found in any environment is legible as an incident rather than as an ambiguous
unfamiliar row.

**No canonical environment was read, written or contacted by this lane.**

---

## 11. R2 — what independent review found, and what changed

Review returned `FAIL`, `BLOCKING=2`. Both blockers were real and both are
closed. The two were different in kind, and the difference is worth naming.

**B-1 was an omission.** The guard was written, documented, and never wired.
That is caught by grepping for call sites, which is exactly how review found it.
The repair is a worker-scoped auto fixture plus a permanent control that goes
RED if the installation is ever removed again — so the same omission cannot
recur silently. See §6.

**B-2 was a wrong model.** The probe ran, passed, and watched the wrong thing:
it waited for a `service_role` bypass that repository design forbids. Nothing
would have surfaced that — it was green, it was falsifiable in principle, and
its trigger was a change nobody will ever make. Only reading the actual
governed activation surface fixes it. See §4.

A control that is absent is found by looking for it. A control that is present
but aimed at the wrong signal looks identical to a working one from the outside.

### Non-blocking findings, all inside the original write-set

| # | Finding | Resolution |
|---|---|---|
| F-3 | `contract-suite.ts` could carry a bypass outside the scanner | scan widened to every `.ts` under `tests/golden/**`; cross-control mutation verified RED in both the meta guard and the reconciler |
| F-4 | prose said 19 / four where measured truth is 20 / 3 | prose corrected to the measured values; **no machine classification was changed to suit prose** |
| F-5 | rate-limit probe blind to the proxy | expanded to `proxy.ts`, with route evidence required so a limiter gated to `/api/` is not credited |
| F-6 | generated output sat in the repo as ordinary untracked bytes | moved outside the checkout entirely |
| F-7 | unrelated whitespace reindent in `package.json` | reverted; delta is 3 Golden scripts + the Playwright devDependency |

Widening the scan for F-3 immediately produced findings that were all
**non-executable** — documentation quoting `test.skip(`, and this guard's own
positive-control test *data*, which necessarily contains a real-looking bypass.
Call position separates a bypass from a bare mention of `.skip` but cannot
separate it from a faithful quotation. Comments and string interiors are now
blanked before matching; `${…}` interpolations are preserved, because they are
real code and blanking them would be the one way the reduction could hide a
genuine bypass. A control asserts exactly that, and another asserts that a
bypass sharing a line with a `https://` string is still found — which the naive
line-comment regex would have swallowed.

### Preserved unchanged

23 frozen steps (J1=13, J2=8, J3=2) · M9/J1/J2/J3 `ABSENT` · coverage honesty
(20 target-absence-only, 3 posture-backed) · zero silent skips · Playwright and
Vitest separation · the J3 404 non-proof principle · Playwright-only semantic
package delta · workflow fail-closed semantics · no production target · no live
Stella · no CE-3 overlap.

---

## 12. Next authorized action

`COMMERCIAL_PILOT_GOLDEN_JOURNEY_R2_FOCUSED_INDEPENDENT_REVIEW`

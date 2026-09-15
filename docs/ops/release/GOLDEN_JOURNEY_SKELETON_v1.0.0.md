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
live on every run, including in the default no-target tier:

| Probe | Surface | Turns RED when |
|---|---|---|
| `J1-EVALUATE-RUNTIME-ABSENT` | `app/**`, `lib/evaluate` | an evaluation runtime appears |
| `J2-PLATFORM-PRINCIPAL-AMBIGUOUS` | `db/schema.ts` | flag and tenant role stop sharing `super_admin` |
| `J3-ANON-READ-BLOCKED` | `lib/reports/public-verify.ts` | an anonymous SELECT policy lands |
| `J3-NO-RATE-LIMIT` | `app/(public)/verify/**` | a limiter is wired up |

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
that the indistinguishability still holds — which turns RED when an anonymous
SELECT policy lands.

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

- **Node layer** — wraps `globalThis.fetch` in the runner process, throwing
  synchronously so an existing `.catch()` cannot convert a hard stop into a
  retry loop;
- **Browser layer** — `context.route('**')` aborts anything outside the
  allowlist. Browser traffic never passes through Node's `fetch`, so the Node
  layer alone would be entirely silent about the journey's own requests.

The shape is an **allowlist** (declared target origin plus loopback), not a
denylist: a denylist is always one new vendor out of date. Blocked requests are
**aborted, never stubbed** — a stub would be a development-only workaround
inserted into the journey path, which the frozen authority forbids.

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

**Playwright output under `tests/golden/.playwright-output/`.** `artifacts/` is
the repository's conventional home for run records and is on this lane's
forbidden list; Playwright's default `test-results/` is neither tracked nor
ignored. Both would surface in the scope gate. The correct long-term fix is two
`.gitignore` entries, and `.gitignore` is not in this lane's write-set.

### Declared follow-up

A lane authorised for those files should add:

- `tests/golden/**` to `vitest.shared.ts`, after which the guard may be renamed
  to `no-silent-skip.test.ts`;
- `tests/golden/.playwright-output/` and `test-results/` to `.gitignore`.

Neither is required for this skeleton to function.

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

## 11. Next authorized action

`COMMERCIAL_PILOT_GOLDEN_JOURNEY_FOCUSED_INDEPENDENT_REVIEW`

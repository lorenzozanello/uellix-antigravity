# Secret-scanning alert #1 (`google_api_key`) — incident adjudication R1

**Adjudication id** `SECRET_SCANNING_ALERT_1_ADJUDICATION_v1.0.0`
**Lane** CV1-SECURITY-SECRET-ALERT1-ADJUDICATION-R1 · **Tier** A (security incident) · **Mode** DOCS_ONLY
**Base** `537487ac7b102d51f553fcb8f5cfe19614e113d8` · **Tree** `7228f833c57bfd37fe025546d939ecd46336159c`
**Status** DRAFT_ADJUDICATION_PENDING_INDEPENDENT_CERTIFICATION

The machine-readable adjudication is
[`SECRET_SCANNING_ALERT_1_ADJUDICATION_v1.0.0.json`](SECRET_SCANNING_ALERT_1_ADJUDICATION_v1.0.0.json).
It is controlling; this file is guidance alongside it, never a substitute.

The related standing authority is [`../CREDENTIAL_HYGIENE.md`](../CREDENTIAL_HYGIENE.md).
This artifact does not amend it. It records that one of its conclusions does not
reach as far as a reader might assume — see §4.

---

## 1. How this was measured without ever handling the secret

No secret value appears in this artifact, in the diff that introduced it, or in
the terminal output that produced it.

- GitHub reads used an explicit **field allowlist** (`--jq`). The API returns a
  `secret` field; it was never selected into view.
- Tree detection used **blob identity** and a format-pattern scan emitting
  **paths and counts only** — `grep -l`, never `grep -n`.
- Value identity was established by piping values **directly into `sha256sum`**,
  so only digests were ever rendered.

The credential is referenced solely by the repository's own fingerprint
convention, `sha256:12`, defined at `scripts/scan-secrets.ts:181` and printed by
that gate in CI. A 48-bit truncation of SHA-256 over a ~208-bit credential is
not invertible, yet it is enough to prove value-identity later — which is
exactly what a rotation needs in order to assert *"the key I revoked is the key
that leaked."*

**Alert #1 is `sha256:12=388060d8572b`.**

The credential was never authenticated with, probed, or presented to Google.

## 2. What the alert is

| | |
| --- | --- |
| Alert | #1, **open**, unresolved, `publicly_leaked=true` |
| Type | `google_api_key` — a **Gemini / Generative Language** API key used by Stella |
| Exposed by | `782ac5f3` (2026-07-06), `docs/AUDIT_2026-07-06.md:144` |
| Blob | `ce7bc990` |
| Repository | **public** |
| Validity | **unknown** |

The provider was derived from the authored text *around* the exposure site — the
document's own heading reads `[CRITICAL] Gemini API Key Exposed` and it
prescribes revoking the key in Google Cloud Console — never from the value.

The exposure has a grim symmetry worth stating plainly: **the leak happened
inside an audit report that was reporting this very leak.** The document quoted
`.env` verbatim in order to describe it.

## 3. The four predicates, kept apart

These are routinely collapsed, and collapsing them is how incidents get either
overstated or waved through. They are answered separately:

| Predicate | Verdict | Why |
| --- | --- | --- |
| **EXPOSED** | **TRUE** | Measured. Public repo, GitHub-attested, commit reachable from the default branch and contained in **181** remote branches. |
| **VALID** | **UNKNOWN** | Validity checks are *disabled* on this repository — that is the measured cause of `validity=unknown`, not an inference. |
| **USED** | **NOT_DETERMINED** | Provider logs were not consulted; doing so is outside this lane. |
| **COMPROMISED** | **NOT_ESTABLISHED** | Compromise requires evidence of unauthorized use. None was sought, none was found. That is absence of evidence, recorded as such. |

A note on `publicly_leaked=true`: it asserts the **value is public**. It does
not assert validity and does not assert use. This repository supplies its own
counterexample — alerts #2, #3 and #4 all carry `publicly_leaked=true` while
matching **inert test fixtures**.

## 4. The finding: an unremediated residue of an already-closed incident

`scripts/scan-secrets.ts` records that commit `782ac5f` quoted `.env` verbatim.
That one dump carried **more than one secret**.

`CREDENTIAL_HYGIENE.md` §4's disposition table closes the incident thoroughly —
rotation, Vercel update, redeploy, smoke, tree redaction, regression gate. Every
row concerns the **PostgreSQL password**.

There is no row for the Gemini key. Its policy line in §2 reads *"Rotar y
redactar."* Reading the evidence:

- **Redaction — done.** `a0fdfcd` (2026-07-16) removed it from the document.
  §4 says so outright: *"`a0fdfcd` redactó la clave de Gemini del mismo
  documento pero **no** el DSN."*
- **Rotation — unevidenced.** Nothing in this repository attests it, and the
  alert has stayed open for roughly **2.5 months**.

### Why §5's residual-risk acceptance does not cover this key

§5 sets `HISTORY_REWRITE_RECOMMENDED=false` and classifies the historical
presence as `ACCEPTED_RESIDUAL_RISK`. That conclusion rests explicitly on a
premise it states in its own words:

> *"La contención efectiva fue la rotación, no el borrado."*

That premise is **established for the PostgreSQL password and unestablished for
the Gemini key.** Extending the acceptance to alert #1 would be a silent
authority expansion across two different credentials, and it is refused here.

To be precise about what is and is not being reopened: §5's *four operational
objections to a rewrite* — the production SHA sits inside the rewrite radius,
governed-evidence anchors would dangle, a rewrite cannot reach forks and caches,
and the coordination cost spans every branch and linked worktree — stand on
their own and are untouched by this adjudication.

**Declining the rewrite remains defensible. Declining the rotation is not.**

## 5. Current tree — clean, and that is not remediation

The value is **absent from tree `7228f833`**, proven rather than assumed. Three
files match the key format; their digests are `158f07bd88ff` (×2) and
`d426d8a7acc9`. Alert #1 is `388060d8572b` and matches neither. `pnpm
secrets:scan` independently reports a clean tree.

Tree absence removes one copy. It does not revoke anything, and it has no effect
on the public historical copy or on any third-party mirror.

## 6. Three distinct keys, and the wrong closure precedent

Alerts #1, #3 and #4 are **three different values** — pairwise distinct digests.

Alerts #3 and #4 digest-match values living in the declared synthetic fixture
set, whose header states: *"Every value here is inert. None of them can
authenticate against anything."* Alert #1 matches none of them, and its
provenance is a real `.env` dump.

Alert #2 was closed `used_in_tests` on 2026-08-15 — correct for a fixture.
**That route is closed to alert #1.** Its only correct resolution is `revoked`,
and only once revocation evidence exists.

Alerts #3 and #4 are recorded as scope-adjacent under **OD-4** and are *not*
adjudicated here.

## 7. Severity — HIGH, with the reasoning exposed

Not CRITICAL: this credential class cannot read the tenant database or mutate
application state, and compromise is not established. Inflating the finding
would be its own failure.

Not lower: the exposure is public, permanent and unrefuted; the value must be
presumed harvested under this repository's own standing posture; and the
rotation that would have contained it is unevidenced after 2.5 months.

Escalates to **CRITICAL** if the key is found live (OD-1) or usage is anomalous
(OD-3). Drops to **LOW** once revocation is evidenced.

## 8. Visibility

**Making the repository private does NOT undo a public historical exposure.**

The value was public from 2026-07-06 in a public repository. A visibility change
is prospective only — it cannot reach an existing clone, fork, mirror or cached
reference. §5 already reached this conclusion for the sibling credential.

A measured collateral hazard also applies: on a personal account, changing
visibility can remove branch protection.

Visibility is a **separate** owner decision (OD-7). It is neither a prerequisite
for, nor a substitute for, rotation.

## 9. What must happen next — none of it done here

Evidence capture comes **before** revocation, because revoking first can
foreclose the logs that would establish whether the key was used.

1. Identify the key in Google Cloud Console; confirm by computing `sha256:12`
   locally against `388060d8572b`.
2. Record its state, creation date and restrictions *(answers U-01, U-02)*.
3. Pull Cloud Logging / API metrics for 2026-07-06 → present *(answers U-03;
   retention may truncate the earliest window, so deferral is lossy)*.
4. Revoke the key.
5. Create a replacement **restricted** to the Generative Language API.
6. Update dependent config **by name** — never commit a value; push protection
   is enabled and must not be bypassed.
7. Redeploy and smoke the Stella grounded-query path.
8. Adjudicate `NEXT_PUBLIC_GEMINI_API_KEY` (OD-5).
9. Re-scan tree and alert set.

**Verification.** Revocation is accepted on **provider-side attestation**, never
on an authentication attempt with the leaked value — the same refusal §4 already
made, for the same reason. The asymmetry is recorded, not hidden: revocation is
attested by the operator, not measured by this repository.

**Closure.** Alert #1 may be closed **only** after that evidence exists, only as
`revoked`, and only by the owner. Selecting `revoked` beforehand would enter a
false attestation into the security record and silence the last monitor still
pointed at this credential.

## 10. The surface worth a second look

`NEXT_PUBLIC_GEMINI_API_KEY` appears in this tree. The `NEXT_PUBLIC_` prefix
causes Next.js to inline the value into the **client bundle**, readable by every
visitor. If that name is ever bound to a live Gemini key, it is a standing
public exposure that rotation alone does not remediate.

This is flagged, not adjudicated (**OD-5**).

## 11. Owner decisions

| | Question | Status |
| --- | --- | --- |
| **OD-1** | Has the key been revoked, and when? **Dispositive.** | OPEN |
| **OD-2** | Enable validity checks? *(Not neutral — GitHub would present the key to Google.)* | OPEN |
| **OD-3** | Pull Google Cloud logs for the window? | OPEN |
| **OD-4** | Disposition of alerts #3/#4 | OPEN, out of scope |
| **OD-5** | Should `NEXT_PUBLIC_GEMINI_API_KEY` exist? | OPEN |
| **OD-6** | Notification/audit obligations *(conditional on OD-3; requires counsel — no legal conclusion is offered here)* | OPEN |
| **OD-7** | Repository visibility | OPEN, independent |

## 12. What this lane did not do

No credential rotated, revoked or created. No alert closed, commented or
altered. No visibility change. No mutation of Vercel, Supabase or Google Cloud.
No authentication or validity probe with the leaked credential. No history
rewrite. No application code, workflow or CI change. No secret value written to
any file, artifact, log or terminal.

**External mutations: NONE. Secrets exposed: NONE.**

---

**Next gate** — `READY_FOR_INDEPENDENT_CERTIFICATION__THEN_OWNER_RATIFICATION_OF_OD_1_THROUGH_OD_7`

# F-GB — Model and telemetry redaction boundary

Closes **F-GB-01** (personal data at the model boundary) and **F-GB-02**
(credentials and telemetry). Written against `codex/fgb-safety`.

This document exists because the two boundaries below are easy to weaken by
accident and hard to notice once weakened. Both failures were silent in
exactly that way: one was a builder that did not call a helper, the other was a
hook that was never registered.

---

## 1. What was actually wrong

### F-GB-01 — redaction was a property of individual builders

Four legacy builders (validator, reviewer, composer, legacy advisor) passed
each field through `sanitizeFreeText` by hand. The contextual advisor did not:
`buildAdvisorContextualUserMessage` inlined its own envelope as

```ts
`UNTRUSTED_PROJECT_DATA\n${JSON.stringify(payload)}`
```

so it never reached `wrapUntrustedData` — and `wrapUntrustedData` did no
redaction either. Of the whole contextual slice only `narrativeSummary` was
scrubbed, and only incidentally, because `sanitizeNarrative` happens to call
`redactPii` upstream.

Everything else went to the provider verbatim. Reproduced in
`lib/stella/security/__tests__/model-boundary-redaction.test.ts`; the pre-fix
payload contained, among others:

```
"projectName":"Integración — key AIza…"
"title":"Taller con juan.perez@…"
"description":"Authorization: Bearer …"
```

### F-GB-02 — telemetry truncated but did not redact, and one hook was missing

`sanitizeErrorForSentry` truncated messages to 200 characters. A Gemini API key
is 39 characters, so a key in `Gemini 403: API key AIza… is blocked` sat at
offset 20 and travelled intact. Truncation defends against an echoed request
body; it does nothing about a short message that simply contains a credential.

Separately, **no `beforeSend` existed on any runtime**, while
`instrumentation.ts` exports `onRequestError = Sentry.captureRequestError` —
so every uncaught Server Action or route-handler error reached Sentry having
passed through no application code at all, with the request's headers attached.

`buildGeminiErrorLog` had a third hole: `apiKey ? split(apiKey) : rawMessage`
forwarded the raw message whenever the key was unset — i.e. in every test
configuration and in any already-misconfigured deployment.

---

## 2. The architecture now

```
   raw application context (may legitimately contain personal data)
            │
            ├─► internal audit record ─────────────► Postgres  [NOT redacted — §4]
            │
   context assembly / prompt builders
            │
            ├─► wrapUntrustedData ──► deep redaction of the STRUCTURE   [defense in depth]
            │
   StellaGeminiAdapter.generate()
            │
            ├─► redactProviderRequest ──► THE GOVERNED BOUNDARY          [authoritative]
            │
            ├──────────────► mockProvider   (tests observe the same bytes)
            └──────────────► @google/genai  (network)
```

```
   any error, any capture path
            │
            ├─► reportStellaFailure ──► redact, then truncate            [defense in depth]
            ├─► Sentry.captureRequestError (uncaught)  ─┐
            ├─► Sentry.addBreadcrumb                    │
            │                                           ▼
            └───────────────────► beforeSend ──► sanitizeSentryEvent     [authoritative]
                                                        │
                                                        ▼
                                                     Sentry
```

**The adapter is the model boundary because it is the only place every caller
already passes through.** Five call sites reach the provider — the four Stella
server actions and the contextual advisor pipeline, plus the offline eval
harness — and all of them construct a `StellaGeminiAdapter`. Redaction sits
inside `generate()`, *ahead of the `mockProvider` branch*, so a test provider
observes exactly the bytes Google would. That ordering is load-bearing and is
pinned by a dedicated test: move redaction below the branch and every
mock-based assertion in the suite goes quietly vacuous while the live path
leaks.

**`beforeSend` is the telemetry boundary for the same reason** — it is the
SDK's own egress hook, and no capture path can route around it. All three
runtimes (`sentry.server.config.ts`, `sentry.edge.config.ts`,
`instrumentation-client.ts`) register the *same* function,
`sentryBeforeSend`, for both `beforeSend` and `beforeSendTransaction`.

### Files

| File | Role |
| --- | --- |
| `lib/security/redact-secrets.ts` | Pure credential redaction. Zero imports (edge-safe). |
| `lib/security/deep-redact.ts` | Structure-preserving walk. Cycles, depth cap, fail-closed. |
| `lib/security/sanitize-sentry-event.ts` | Telemetry final scrub + `sentryBeforeSend`. |
| `lib/stella/security/redact-model-bound.ts` | `redactProviderRequest` — the model boundary. |
| `lib/stella/security/redact-pii.ts` | Pre-existing PII rules; url-credentials rule made quote-bounded. |

---

## 3. Two invariants the boundaries depend on

**Idempotency.** Two layers redact, and telemetry re-redacts text the adapter
already scrubbed. Every replacement token is bracketed and `[` is excluded from
every value character class, so redacting twice equals redacting once. This is
tested directly — it was violated once already, by the `query-secret` rule,
which re-consumed its own token and emitted a doubled bracket.

**Quote-boundedness.** No rule may run past a quote. This is what makes the
rules safe to compose over serialized JSON, and the failure it prevents is
silent rather than loud. The pre-existing `url-credentials` rule was bounded
only by whitespace (`[^\s]+`); redacting

```json
{"a":"https://u:pw@h.test/x","b":"siguiente valor","c":42}
```

produced `{"a":"[REDACTED:url-credentials] valor","c":42}` — **still valid
JSON, with key `b` deleted**. At the model boundary that reshapes the payload
out from under the request-local citation catalog, silently re-pointing every
`sourceRefIndex` the model returns at the wrong field. The rule was fixed at
source rather than worked around.

Related: the deep walk transforms **string leaves only**. Keys, array lengths,
numbers and booleans are preserved exactly, because
`collectCanonicalSourceFieldPaths` builds the citation catalog from keys and
indexes.

---

## 4. What is deliberately NOT redacted, and why

**The internal audit record.** `stella_interactions.response_json` holds the
parsed, schema-validated model output, and the ticket trail holds ids, hashes
and scalars. This is an *authoritative internal record*, not egress, and
redacting it would destroy the evidence the governance model exists to
produce. Note what is already true of it: the prompt and the context are never
persisted — only `context_hash` is. Credentials are never *intentionally*
persisted as an audit payload; if one arrives inside project content it is
subject to the same ingest rules as the rest of that content, not to this
boundary.

**`contextHash`.** Computed upstream over the *unredacted* context, and passed
through the boundary untouched. It is the audit identity of the request;
rewriting it would break the link between what was logged and what was sent.

**Hostnames in DSNs.** The `dsn-password` rule redacts the password and keeps
the host, following the doctrine already written into
`scripts/scan-secrets.ts`: the verdict belongs to the credential component, and
the host is triage context. An error that says only `[REDACTED]` is an error
nobody can act on.

**Public origins.** `NEXT_PUBLIC_SITE_URL=https://app.example` survives the
env-assignment rule, which requires the variable NAME to announce a credential.

**Numbers.** Beneficiary counts, investment amounts, SROI ratios and years are
preserved — they carry the meaning the model is reasoning about. `redactPii`
deliberately does not treat a bare digit run as an identifier without a
context word.

**A bare 10-digit Colombian mobile with no separators or context word.** A
pre-existing, documented tradeoff in `redact-pii.ts`: indistinguishable from an
amount. Unchanged by this work.

**A bare opaque credential with no prefix, no key name and no context.** The
credential analogue of the same limit, and the honest scope of F-GB-02. A rule
fires on one of three signals: a recognisable PREFIX (`AIza`, `sbp_`, `eyJ`…),
a KEY NAME that marks the value (`authorization`, `cookie`, `x-api-key`), or
SURROUNDING CONTEXT (`Bearer …`, `password=…`, `?key=…`). A high-entropy string
carrying none of the three is indistinguishable from a build id, a request id
or a release name, and redacting every such string would shred the telemetry
this boundary exists to keep readable. Two things narrow the gap: the
`knownSecrets` parameter, which the adapter uses to pass the configured API key
as an exact value; and key-name stripping, which catches an opaque session
token because of the header it arrives in rather than its shape.

**`JSON.parse` error messages.** These quote a few characters around the syntax
error. Bounded, and scrubbed again by `reportStellaFailure` and `beforeSend`
before they can leave.

---

## 5. Prompt injection — explicitly out of scope, recorded as debt

This work does **not** solve prompt injection. What it does guarantee is that
credential-shaped sequences arriving inside *evidence text or retrieved
content* (`Authorization:`, `API_KEY=`, `DATABASE_URL=`, `Bearer …`) are
redacted like any other content — a secret does not earn passage to the
provider by having come from an upload.

Remaining, unchanged by this work:

- the prompt-injection corpus in `lib/stella/context/__tests__/prompt-injection.test.ts`
  covers the four legacy builders, not the contextual one;
- grounding chunks reach retrieval verbatim, and the untrusted-data envelope
  that the ingest scanner names as "the real defense" is not applied on the
  retrieval side. This becomes blocking the day `AnswerDraftProvider` is
  connected to a generative provider.

---

## 6. What must still happen before the first real Gemini call

Nothing in this repository. The remaining gate is operational:

1. `GEMINI_API_KEY` present in the staging environment;
2. `STELLA_ENABLED` and `STELLA_ADVISOR_ENABLED` on;
3. the calling organization's monthly quota above zero;
4. the preconditions already recorded for SYS-02/SYS-03 (`UELLIX_APP_ENV`
   and the Supabase project variables set in Vercel).

// lib/stella/security/redact-model-bound.ts
//
// F-GB-01. The governed redaction boundary for everything that crosses into a
// model provider.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS CLOSES
// ---------------------------------------------------------------------------
// Redaction used to be a PROPERTY OF INDIVIDUAL BUILDERS. The four legacy
// builders passed each field through `sanitizeFreeText` by hand; the contextual
// advisor did not, and `buildAdvisorContextualUserMessage` serialized its whole
// per-step slice with a bare `JSON.stringify`. Of the whole contextual context
// only `narrativeSummary` was ever redacted — because `sanitizeNarrative`
// happened to call `redactPii` — so a project TITLE, a stakeholder NAME, an
// outcome description or an evidence title carrying an email, a phone or a
// cédula went to the provider verbatim. That asymmetry is reproduced, and now
// pinned, in `__tests__/model-boundary-redaction.test.ts`.
//
// Per-caller redaction is a convention, and a convention is one forgetful
// `adapter.generate()` away from a leak. This module is applied inside
// `StellaGeminiAdapter.generate()` instead — the one place all five call sites
// and the eval harness already funnel through, ahead of the mockProvider
// branch so a test provider observes exactly the bytes Google would.
//
// ---------------------------------------------------------------------------
// ORDER: SECRETS, THEN PERSONAL DATA
// ---------------------------------------------------------------------------
// Credential rules are the more specific of the two — a DSN's password is also
// a plausible `[^\s/@]+` for the PII url-credentials rule — so running them
// first keeps the resulting token honest about WHAT was removed. Both passes
// are idempotent, so the composition is too, and running this over text that
// upstream already sanitized is a no-op rather than a double-mangling.

import { redactSecrets } from '@/lib/security/redact-secrets'
import { deepRedact } from '@/lib/security/deep-redact'
import { redactPii } from './redact-pii'
import type { StellaRequest } from '../adapter/types'

/**
 * Scrub one string of everything that must not reach a model provider.
 *
 * Safe to run over serialized JSON: every rule in both passes is bounded by
 * quote characters as well as whitespace, so a match cannot run past the end
 * of the string value it started in. That property is not incidental — it is
 * asserted directly in the suites, because the failure it prevents is silent
 * (a payload that still parses, with a key deleted).
 */
export function redactTextForModel(text: string): string {
  if (!text) return ''
  return redactPii(redactSecrets(text)).text
}

/**
 * Deep-redact a still-STRUCTURED payload, preserving its shape exactly.
 *
 * Used by `wrapUntrustedData` (defense in depth, upstream of the adapter)
 * where the payload is still an object. Keys, array lengths, numbers and
 * booleans survive untouched, which is what keeps the request-local citation
 * catalog — built from keys and indexes by `collectCanonicalSourceFieldPaths`
 * — byte-identical to the one the system prompt advertises.
 */
export function redactModelBoundPayload<T>(payload: T): T {
  return deepRedact(payload, { transform: redactTextForModel })
}

/**
 * THE PROVIDER BOUNDARY.
 *
 * Returns a new request whose provider-bound text carries no personal data and
 * no credential material. Everything the transport and the audit trail depend
 * on — role, contextHash, responseJsonSchema — is passed through untouched:
 * the contextHash is computed upstream over the UNREDACTED context and is the
 * audit identity of the request, so rewriting it here would break the link
 * between what was logged and what was sent.
 *
 * The caller's object is never mutated. Upstream code may still hold the raw
 * context legitimately (see the persistence boundary note in
 * `docs/ops/FGB_MODEL_BOUNDARY.md`); this is a transform at egress, not a
 * scrub of the application's own state.
 */
export function redactProviderRequest(request: StellaRequest): StellaRequest {
  return {
    ...request,
    systemPrompt: redactTextForModel(request.systemPrompt),
    userMessage: redactTextForModel(request.userMessage),
  }
}

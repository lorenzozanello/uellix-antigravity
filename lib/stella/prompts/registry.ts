// lib/stella/prompts/registry.ts
// Etapa A1 (STL-A1-002) — single source of truth for prompt template
// identity and version.
//
// Before this file, no part of the codebase had any notion of "which version
// of a prompt produced this interaction." If a prompt's wording changed, an
// old and a new interaction were indistinguishable in `stella_interactions`.
//
// This registry does NOT change any prompt's text (buildXSystemPrompt /
// buildXUserMessage are untouched). It only assigns a stable identifier and a
// version number to each role's prompt, so the 4 server actions can record
// what was actually used. When a prompt's text changes, bump the `version`
// here — this is the ONLY place a Stella prompt version is declared. Nothing
// else should hardcode a version number.
//
// Etapa A1.5 (STL-A15-008): `version` alone was still just a number a
// developer had to remember to bump — nothing verified it matched the actual
// prompt text. `expectedContentHash` is a literal SHA-256 snapshot computed
// via lib/stella/prompts/prompt-content-hash.ts, using fixed canonical
// inputs — never runtime data. prompt-content-hash.test.ts recomputes the
// live hash and fails if it no longer matches this snapshot. When you
// deliberately change a prompt's wording: bump `version` AND replace
// `expectedContentHash` with the new value the test reports — do this in the
// same commit, never bump one without the other.
//
// Etapa A1.6 (STL-A16-003) correction: `expectedContentHash` originally
// snapshotted ONLY the system prompt text. It now snapshots the FULL prompt
// contract per role — system prompt + the fixed TASK/RESPONSE_REQUIREMENTS
// text each buildXUserMessage embeds + the runtime message template's
// structural constants + the untrusted-data delimiters/warning prose + which
// field names get sent as data + CONTEXT_SCHEMA_VERSION (see
// prompt-content-hash.ts's header comment for the full rationale). The 6
// values below were recomputed for this broader contract on 2026-07-25; this
// is a change to what the CONTROL measures, not to what any prompt says, so
// `version` was NOT bumped for this update.

import type { StellaRole } from '../adapter/types'

export interface PromptTemplateRecord {
  /** Stable identifier. Never reused for a different template. */
  templateId: string
  /** Increments whenever the template's text changes. */
  version: number
  /** SHA-256 (hex) snapshot of the prompt text as of this `version`. See prompt-content-hash.ts. */
  expectedContentHash: string
}

export const PROMPT_TEMPLATES: Readonly<Record<StellaRole, PromptTemplateRecord>> = {
  advisor: {
    templateId: 'stella.advisor.system',
    version: 1,
    expectedContentHash: '046b3097a11f7a4a9926540494d4e609617fcbefadd4938706bed33f40fb5c51',
  },
  validator: {
    templateId: 'stella.validator.system',
    version: 1,
    expectedContentHash: 'c23b04f37e0d66f9b6d4efd2cd24fe734442a7377fd2c1830146a906fdcc7be7',
  },
  composer: {
    templateId: 'stella.composer.system',
    version: 1,
    expectedContentHash: 'fc73fda7370d225894ee13fdda3532e18c0321789be3d3aacf36e4df98e4904e',
  },
  proxy_reviewer: {
    templateId: 'stella.reviewer.proxy_reviewer.system',
    version: 1,
    expectedContentHash: '766ab24eb4666170d356aec40cd09c3d70b961bc9c48545defcbf65c1be16cf3',
  },
  evidence_reviewer: {
    templateId: 'stella.reviewer.evidence_reviewer.system',
    version: 1,
    expectedContentHash: 'f09c46b84eff13e99e32a9eb7abca3996d7a2b73eb700f5c5ebf465bcf9f3e8b',
  },
  audit_assistant: {
    templateId: 'stella.reviewer.audit_assistant.system',
    version: 1,
    expectedContentHash: '9def9ee2c3b773fcb5cca135ff453149ade23fb996353bba08eeed2bbb3c27bd',
  },
}

/** Throws if a role is somehow missing from the registry (should never happen — see the test). */
export function getPromptTemplate(role: StellaRole): PromptTemplateRecord {
  const record = PROMPT_TEMPLATES[role]
  if (!record) {
    throw new Error(`No prompt template registered for Stella role "${role}"`)
  }
  return record
}

// lib/stella/prompts/prompt-content-hash.ts
// Etapa A1.5 (STL-A15-008) — deterministic control for prompt-version
// integrity. Etapa A1.6 (STL-A16-003) broadened its coverage — see the
// "Etapa A1.6" note below for why and what changed.
//
// Before A1.5, PROMPT_TEMPLATES's `version` field (registry.ts) was purely a
// number a developer had to remember to bump by hand whenever a system
// prompt's wording changed — nothing verified that the recorded version
// still matched the prompt's actual text.
//
// Etapa A1.6 correction (verified against code, 2026-07-25): the original
// A1.5 implementation of computePromptContentHash() hashed ONLY the system
// prompt text (buildXSystemPrompt's output). It did NOT cover: the fixed
// "task" sentence each buildXUserMessage embeds in the TASK section, the
// fixed "responseRequirements" text in the RESPONSE_REQUIREMENTS section, the
// runtime message template itself (lib/stella/prompts/build-runtime-message.ts
// — section headings), the untrusted-data delimiters/warning prose
// (lib/stella/context/build-untrusted-payload.ts), or which top-level fields
// end up in UNTRUSTED_PROJECT_DATA for each role. A developer could have
// edited any of those — the actual "prompt contract" the model receives —
// without the hash changing, without bumping `version`, and without any test
// failing. This file closes that gap: computePromptContentHash() now hashes
// the FULL contract (see buildPromptContract below). The exported function
// name and the `prompt_content_hash` column/field name are kept unchanged —
// only their documented semantics are broadened — because a hex-string
// column is equally valid for either hash and a rename would need a migration
// this task doesn't justify (STELLA_A2_PREPARATION-adjacent decision,
// documented here rather than acted on elsewhere).
//
// Everything hashed here is either a fixed developer-authored string, a
// structural constant, a FIELD NAME (never a value), or a version integer —
// never runtime project data, IDs, narratives, or timestamps. The canonical
// context fixture below uses fixed placeholder strings for required fields,
// never real data.

import { createHash } from 'crypto'
import { buildAdvisorSystemPrompt, buildAdvisorUserMessage } from './advisor-system'
import { buildValidatorSystemPrompt, buildValidatorUserMessage } from './validator-system'
import { buildComposerSystemPrompt, buildComposerUserMessage } from './composer-system'
import { buildReviewerSystemPrompt, buildReviewerUserMessage } from './reviewer-system'
import { RUNTIME_MESSAGE_SECTIONS } from './build-runtime-message'
import { UNTRUSTED_DATA_MARKERS } from '../context/build-untrusted-payload'
import { CONTEXT_SCHEMA_VERSION } from '../context/schema-version'
import type { StellaRole } from '../adapter/types'
import type { StellaProjectContext } from '../context/types'

/** Fixed, non-runtime inputs — exist only to make each prompt's output deterministic for hashing. */
const CANONICAL_STEP = '__canonical_step_for_hash__'
const CANONICAL_SECTION = '__canonical_section_for_hash__'

/** A minimal, fully-synthetic context — no real project data, IDs, narrative, or timestamps. */
function canonicalContext(overrides: Partial<StellaProjectContext> = {}): StellaProjectContext {
  return {
    projectId: '__canonical_project_id__',
    organizationId: '__canonical_org_id__',
    narrativeSummary: '',
    outcomesSnapshot: [],
    indicatorsSnapshot: [],
    stakeholderCount: 0,
    evidenceMetadata: [],
    evidenceTotal: 0,
    proxySummary: [],
    filterSetsSummary: [],
    calculationSnapshot: null,
    reportSections: [],
    projectCreatedAt: '1970-01-01T00:00:00Z',
    lastUpdatedAt: '1970-01-01T00:00:00Z',
    ...overrides,
  }
}

const CANONICAL_SYSTEM_PROMPT_BUILDERS: Record<StellaRole, () => string> = {
  advisor: () => buildAdvisorSystemPrompt(CANONICAL_STEP),
  validator: () => buildValidatorSystemPrompt(),
  composer: () => buildComposerSystemPrompt(CANONICAL_SECTION),
  proxy_reviewer: () => buildReviewerSystemPrompt('proxy_reviewer'),
  evidence_reviewer: () => buildReviewerSystemPrompt('evidence_reviewer'),
  audit_assistant: () => buildReviewerSystemPrompt('audit_assistant'),
}

/**
 * One or more "variants" of the runtime user-message per role. Most roles
 * have exactly one (their task/response-requirements text never changes).
 * composer is the exception: its RESPONSE_REQUIREMENTS gains a 4-point
 * guidance block specifically for sectionType === 'funder_breakdown' — a
 * variant driven by a controlled parameter (section type), not by user data,
 * so it is included as a second, equally-canonical variant. The empty
 * `fundersBreakdown: []` array is enough to trigger that code path (it is
 * truthy) without needing any real funder data.
 */
const CANONICAL_USER_MESSAGE_VARIANTS: Record<StellaRole, () => { label: string; message: string }[]> = {
  advisor: () => [{ label: 'default', message: buildAdvisorUserMessage(CANONICAL_STEP, canonicalContext()) }],
  validator: () => [{ label: 'default', message: buildValidatorUserMessage(canonicalContext()) }],
  composer: () => [
    { label: 'default_section', message: buildComposerUserMessage(CANONICAL_SECTION, canonicalContext()) },
    {
      label: 'funder_breakdown_section',
      message: buildComposerUserMessage(
        'funder_breakdown',
        canonicalContext({
          calculationSnapshot: {
            totalInvestment: 0,
            grossSocialValue: 0,
            netSocialValue: 0,
            sroiRatio: 0,
            currency: 'USD',
            lineItemCount: 0,
            version: 1,
            fundersBreakdown: [],
          },
        }),
      ),
    },
  ],
  proxy_reviewer: () => [{ label: 'default', message: buildReviewerUserMessage('proxy_reviewer', canonicalContext()) }],
  evidence_reviewer: () => [{ label: 'default', message: buildReviewerUserMessage('evidence_reviewer', canonicalContext()) }],
  audit_assistant: () => [{ label: 'default', message: buildReviewerUserMessage('audit_assistant', canonicalContext()) }],
}

interface RuntimeMessageContract {
  task: string
  responseRequirements: string
  /** Fixed warning prose between the UNTRUSTED_PROJECT_DATA heading and the JSON delimiters. */
  untrustedDataPrefix: string
  /** Sorted top-level field NAMES sent as untrusted data — never values. */
  untrustedDataFieldKeys: string[]
}

/** Splits a buildStellaUserMessage() output back into its fixed/structural parts, for hashing. */
function extractRuntimeMessageContract(message: string): RuntimeMessageContract {
  const dataHeadingIdx = message.indexOf(RUNTIME_MESSAGE_SECTIONS.untrustedData)
  const reqHeadingIdx = message.indexOf(RUNTIME_MESSAGE_SECTIONS.responseRequirements)
  const jsonStart = message.indexOf(UNTRUSTED_DATA_MARKERS.begin)
  const jsonEnd = message.lastIndexOf(UNTRUSTED_DATA_MARKERS.end)

  const task = message.slice(RUNTIME_MESSAGE_SECTIONS.task.length, dataHeadingIdx).trim()
  const responseRequirements = message.slice(reqHeadingIdx + RUNTIME_MESSAGE_SECTIONS.responseRequirements.length).trim()
  const untrustedDataPrefix = message.slice(dataHeadingIdx + RUNTIME_MESSAGE_SECTIONS.untrustedData.length, jsonStart).trim()

  const jsonBody = message.slice(jsonStart + UNTRUSTED_DATA_MARKERS.begin.length, jsonEnd).trim()
  const untrustedDataFieldKeys = Object.keys(JSON.parse(jsonBody) as Record<string, unknown>).sort()

  return { task, responseRequirements, untrustedDataPrefix, untrustedDataFieldKeys }
}

/**
 * Live SHA-256 (hex) of the given role's FULL prompt contract: system
 * prompt + task template(s) + response requirements(s) + the runtime message
 * template's structural constants + the untrusted-data delimiter/warning
 * text + which field names get sent + the active context schema version.
 * Deterministic; contains no runtime project data.
 */
export function computePromptContentHash(role: StellaRole): string {
  const systemPrompt = CANONICAL_SYSTEM_PROMPT_BUILDERS[role]()
  const variants = CANONICAL_USER_MESSAGE_VARIANTS[role]().map(({ label, message }) => ({
    label,
    ...extractRuntimeMessageContract(message),
  }))

  const contract = {
    systemPrompt,
    runtimeMessageStructure: {
      sections: RUNTIME_MESSAGE_SECTIONS,
      dataMarkers: UNTRUSTED_DATA_MARKERS,
    },
    variants,
    contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
  }

  return createHash('sha256').update(JSON.stringify(contract)).digest('hex')
}

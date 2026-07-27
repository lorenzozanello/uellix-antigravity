// lib/stella/context/context-guardrails.ts
// Etapa A1 (STL-A1-007) — deterministic, code-level verification of invariants
// that today only exist as comments in the context builders (e.g.
// "// Financial values excluded" in build-composer-context.ts:216). A comment
// is not a control: nothing stops a future edit from silently reintroducing a
// value there. This turns those invariants into an executable check that
// runs BEFORE the prompt is built, and fails closed.
//
// This is explicitly a control that does NOT rely on the model's behavior —
// see "Control determinista" in STELLA_REVISED_MASTER_PLAN.md §2. It checks
// the CONTEXT OBJECT the app itself built, not anything the model returns.
//
// Etapa A2.3.1 (STL-A231-013/014, DR-002/DR-003): this function is now ASYNC
// — closing an aggregate-mention with a verified declaration requires one DB
// read, scoped to the EXACT entity (organizationId/projectId/entityType/
// entityId) the mention came from, never the whole project. All 4 Stella
// actions now `await` this call (previously synchronous).
//
// Etapa A2.3.2 (STL-A232-008/009): the sensitive-population check below now
// runs in two passes instead of one DB call per qualifying entry — see the
// comment above that block for the exact reasoning (no behavior change for
// individual/narrative/reidentification blocks, only fewer queries for the
// aggregate-mention case).

import { hasForbiddenPattern } from './sanitize'
import { detectHighRiskPii } from './pii-detection'
import { assessSensitiveData } from './sensitive-population'
import { findValidSensitiveAggregationDeclarations, canonicalDeclarationKey } from '../aggregation/declaration-query'
import { isAllowedSensitiveEntityType } from '../aggregation/policy'
import type { SensitiveEntityType } from '../aggregation/policy'
import type { DeclarationSensitiveCategory } from '../aggregation/types'
import { StellaContextGuardrailError } from '../errors'
import type { StellaProjectContext } from './types'

export { StellaContextGuardrailError }

/** Ceiling enforced by sanitizeNarrative() — kept in sync deliberately, not imported,
 *  so a change to sanitize.ts's truncation length is forced to also touch this
 *  file's expectation (a silent widening would otherwise slip through). */
const MAX_NARRATIVE_LENGTH_WITH_ELLIPSIS = 2000 + '...'.length

/** Full SHA-256 is 64 hex chars; the app must only ever send a truncated prefix. */
const MAX_TRUNCATED_HASH_LENGTH = 8

/**
 * One scannable string from the context, tagged with the real entity it came
 * from. `entityType` is a plain string (not narrowed to
 * SensitiveEntityType) because some sources — e.g. financial proxies — are
 * deliberately outside the declarable allowlist; isAllowedSensitiveEntityType()
 * decides at call time whether a declaration lookup is even possible for it.
 */
export interface ContextStringEntry {
  entityType: string
  entityId: string
  value: string
}

/**
 * Throws StellaContextGuardrailError if the context violates a known,
 * hardcoded safety invariant. Resolves normally otherwise.
 *
 * Deliberately scoped to what today's context builders already guarantee by
 * convention — this makes that convention enforceable, it does not attempt to
 * broaden or narrow what is currently sent (that is Etapa B's job).
 */
export async function assertContextHasNoForbiddenData(context: StellaProjectContext): Promise<void> {
  for (const proxy of context.proxySummary) {
    if (proxy.value !== '' || proxy.currency !== '') {
      throw new StellaContextGuardrailError(
        `Proxy "${proxy.id}" carries a financial value/currency; Stella context must never include proxy financial values.`,
      )
    }
  }

  if (context.narrativeSummary.length > MAX_NARRATIVE_LENGTH_WITH_ELLIPSIS) {
    throw new StellaContextGuardrailError(
      'narrativeSummary exceeds the sanitization ceiling — sanitizeNarrative() may not have run.',
    )
  }

  for (const evidence of context.evidenceMetadata) {
    if (evidence.contentHashTruncated && evidence.contentHashTruncated.length > MAX_TRUNCATED_HASH_LENGTH) {
      throw new StellaContextGuardrailError(
        `Evidence "${evidence.id}" carries a hash longer than the truncation ceiling — the full hash may have leaked.`,
      )
    }
  }

  const scanEntries = collectContextEntityStrings(context)

  for (const entry of scanEntries) {
    if (hasForbiddenPattern(entry.value)) {
      throw new StellaContextGuardrailError(
        'Context contains a forbidden pattern (secret-like string) that per-field sanitization did not catch.',
      )
    }
  }

  // Etapa A2 (STL-A2-008, DR-001 approved 2026-07-25): high-risk PII blocks
  // fail-closed, before the context can reach a prompt. The message names
  // only the CATEGORY — never the matched text — so the guardrail itself
  // cannot become a new leakage path for the very data it is blocking.
  //
  // 'minorIdentifiable' and 'individualHealth' are excluded here (STL-A23-006,
  // DR-002/DR-003): those two categories are now the sensitive-population
  // check's domain below, which reuses this same detector internally but
  // throws with a distinct, typed reason code instead of the generic message
  // — a caller needs to tell "a minor was individually identifiable" apart
  // from "a credential/government ID leaked".
  for (const entry of scanEntries) {
    const highRiskMatches = detectHighRiskPii(entry.value).filter(
      (m) => m.category !== 'minorIdentifiable' && m.category !== 'individualHealth',
    )
    if (highRiskMatches.length > 0) {
      throw new StellaContextGuardrailError(
        `Context contains high-risk PII (category: ${highRiskMatches[0].category}) that must not be sent to the model.`,
      )
    }
  }

  // Etapa A2.3.1/A2.3.2 (STL-A231-013, STL-A232-008/009, DR-002/DR-003 —
  // closes the gap documented in
  // STELLA_A2_DR002_DR003_IMPLEMENTATION_REPORT.md#8): datos de menores/salud
  // solo se permiten agregados, con un tamano de grupo VERIFICADO. Orden
  // exacto (encargo original A2.3.1 seccion 19): una senal INDIVIDUAL o de
  // reidentificacion bloquea de inmediato, sin consultar ninguna
  // declaracion.
  //
  // Batch, sin N+1 (STL-A232-008): primero se clasifica CADA entrada de
  // forma sincrona (sin tocar la base de datos, un solo recorrido). Si
  // alguna es individual/narrativa/reidentificacion, se lanza de inmediato,
  // en el mismo orden que antes de esta etapa. Solo si ninguna de esas
  // senales aparece, se agrupan TODAS las menciones agregadas pendientes de
  // veredicto (aggregate_unknown_size) y se resuelven con UNA sola consulta
  // (findValidSensitiveAggregationDeclarations) en vez de una consulta por
  // entrada — antes N consultas (una por mencion agregada), ahora 1,
  // acotada a esta organizacion+proyecto, nunca a toda la organizacion.
  const preliminary = scanEntries.map((entry) => ({ entry, assessment: assessSensitiveData(entry.value) }))

  for (const { assessment } of preliminary) {
    if (assessment.allowed) continue
    if (assessment.aggregationStatus !== 'aggregate_unknown_size') {
      throw new StellaContextGuardrailError(
        `Context contains sensitive population data (category: ${assessment.category}, status: ${assessment.aggregationStatus}) that must not be sent to the model.`,
        assessment.reasonCode,
      )
    }
  }

  const pendingAggregate = preliminary.filter(
    (p) => !p.assessment.allowed && p.assessment.aggregationStatus === 'aggregate_unknown_size',
  )

  if (pendingAggregate.length > 0) {
    const declarationsByKey = await findValidSensitiveAggregationDeclarations({
      organizationId: context.organizationId,
      projectId: context.projectId,
      refs: pendingAggregate
        .filter((p) => isAllowedSensitiveEntityType(p.entry.entityType))
        .map((p) => ({
          entityType: p.entry.entityType as SensitiveEntityType,
          entityId: p.entry.entityId,
          sensitiveCategory: p.assessment.category as DeclarationSensitiveCategory,
        })),
    })

    for (const { entry, assessment } of pendingAggregate) {
      const declaration = isAllowedSensitiveEntityType(entry.entityType)
        ? declarationsByKey.get(
            canonicalDeclarationKey({ entityType: entry.entityType, entityId: entry.entityId, sensitiveCategory: assessment.category as DeclarationSensitiveCategory }),
          )
        : null

      const reassessed = assessSensitiveData(entry.value, declaration ?? undefined)
      if (!reassessed.allowed) {
        throw new StellaContextGuardrailError(
          `Context contains sensitive population data (category: ${reassessed.category}, status: ${reassessed.aggregationStatus}) that must not be sent to the model.`,
          reassessed.reasonCode,
        )
      }
    }
  }
}

/**
 * Walks the context's known string fields, tagging each with the real
 * entity it came from — lets the sensitive-population check above resolve a
 * declaration scoped to that EXACT entity, never the whole project.
 *
 * `narrativeSummary` maps to entityType 'project' (it is built from
 * project-level narrative fields, not any single outcome/indicator row —
 * see build-advisor-context.ts). Proxies map to 'financial_proxy', which is
 * deliberately NOT in ALLOWED_SENSITIVE_ENTITY_TYPES (a proxy is a valuation
 * reference, not a population entity) — any sensitive mention hidden in a
 * proxy name/source is still classified and blocked exactly as before, it
 * simply can never be un-blocked by a declaration.
 *
 * STL-A231-013 fix: report section titles (`context.reportSections[].title`)
 * are now included — this field existed in StellaProjectContext already but
 * was never scanned by this function before this stage (a gap discovered
 * during the entity audit this stage's spec requires, not a new field).
 */
export function collectContextEntityStrings(context: StellaProjectContext): ContextStringEntry[] {
  const entries: ContextStringEntry[] = [
    { entityType: 'project', entityId: context.projectId, value: context.narrativeSummary },
  ]
  for (const o of context.outcomesSnapshot) {
    entries.push({ entityType: 'outcome', entityId: o.id, value: o.name })
    entries.push({ entityType: 'outcome', entityId: o.id, value: o.description })
  }
  for (const i of context.indicatorsSnapshot) {
    entries.push({ entityType: 'indicator', entityId: i.id, value: i.name })
    entries.push({ entityType: 'indicator', entityId: i.id, value: i.unit })
  }
  for (const e of context.evidenceMetadata) {
    entries.push({ entityType: 'evidence', entityId: e.id, value: e.title })
  }
  for (const p of context.proxySummary) {
    entries.push({ entityType: 'financial_proxy', entityId: p.id, value: p.name })
    entries.push({ entityType: 'financial_proxy', entityId: p.id, value: p.source })
  }
  for (const s of context.reportSections) {
    entries.push({ entityType: 'report_section', entityId: s.id, value: s.title })
  }
  return entries
}

/** Backward-compatible plain-string view — used by build-context-manifest.ts's PII-flag scan, which doesn't need entity attribution. */
export function collectContextStrings(context: StellaProjectContext): string[] {
  return collectContextEntityStrings(context).map((entry) => entry.value)
}

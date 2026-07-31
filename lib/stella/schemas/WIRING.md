# Composer numeric guard — wiring note (WS4 U4, for the coordinator)

`composer-numeric-guard.ts` is **pure and unwired** by design: WS4 owns the
guard, the coordinator owns `app/actions/stella/composer.ts`.

## Exact integration point

In `app/actions/stella/composer.ts`, inside `getStellaComposer`, immediately
after `parseResponse` succeeds (line ~107) and **before** the
`stella_interactions` audit insert:

```ts
import {
  validateComposerNumbers,
  validateComposerReferences,
  authorizedNumbersFromSnapshot,
} from '@/lib/stella/schemas/composer-numeric-guard'

// after: const data = await adapter.parseResponse(response.rawOutput, ComposerOutputSchema)

const referenceCheck = validateComposerReferences(data, context)
const numberCheck = context.calculationSnapshot
  ? validateComposerNumbers(
      data,
      authorizedNumbersFromSnapshot(context.calculationSnapshot, [
        // everything numeric the context exposed to the model:
        ...context.filterSetsSummary.flatMap(f => [
          f.deadweightPct, f.attributionPct, f.displacementPct,
          f.dropoffPct, f.durationYears,
        ]).filter((v): v is number => v !== undefined),
        context.stakeholderCount,
        context.evidenceTotal,
        ...(context.readinessScore !== undefined ? [context.readinessScore] : []),
      ]),
    )
  : { ok: true as const, violations: [] }

if (!referenceCheck.ok || !numberCheck.ok) {
  // Suggested: reuse PARSE_ERROR or add a dedicated 'INTEGRITY_ERROR' code.
  // Log the violation lists server-side ([stella] prefix); do NOT echo raw
  // model text to the client.
  return { ok: false, error: 'PARSE_ERROR', message: 'Stella produced unverifiable figures. Please retry.' }
}
```

## Contract notes

- `validateComposerReferences(data, context)` accepts `StellaProjectContext`
  directly (it only reads `evidenceMetadata[].id` and `proxySummary[].id`).
- `validateComposerNumbers` flags any numeric token in the free-text fields
  (`draft_title`, `draft_content`, `assumptions[]`, `limitations[]`,
  reference `title`/`name`/`context`) not traceable to the authorized set.
  Formatting tolerance and the allowlist (years 1900–2100, ordinals ≤ 20,
  section numbers, identifier fragments) are documented at the top of
  `composer-numeric-guard.ts`. Post-audit tightening: NONE of the
  year/ordinal/section exemptions apply inside a value-claiming context —
  a token near a ratio/value keyword (SROI, ratio, razón, retorno, valor,
  total, inversión), a currency word/symbol (USD, COP, EUR, $, €, £), a
  value marker (":1", "x", "veces", "dólares", "pesos", "millones",
  "adicionales") or a '%' is always validated against the authorized set
  ("el SROI es 7", "$2050", "2019 adicionales" get flagged unless the value
  is authorized).
- **The guard is only as strong as the `additional` array**: pass every
  numeric value the context legitimately exposed, or legit drafts will be
  rejected. If the context gains new numeric fields, extend the array.
- If no `calculationSnapshot` exists, there are no authorized run numbers;
  decide whether to skip the numeric check (as sketched above) or require an
  entirely number-free draft (call with an authorized set of only
  `additional` context values).
- Recommended: record `numberCheck.violations` / `referenceCheck.violations`
  in the `stella_interactions` audit row (additive JSON key) when rejecting.

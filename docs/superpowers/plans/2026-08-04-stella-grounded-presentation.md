# Stella Grounded Presentation Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Stella PRODUCT line a typed presentation model for grounded responses (support level, citations, contradiction, availability, decision status) built entirely on real existing signals (`AdvisorContextualOutput`, `StellaPanelErrorCode`, `SuggestionDecisionAction`), plus components that render it and wire the grounding badge into the real contextual advisor panel.

**Architecture:** Pure, client-safe TypeScript module (`components/stella/grounding-model.ts`) that classifies existing data into a typed union of presentation states — no new server calls, no new schema. Three new presentational components consume it. The existing `StellaContextualAdvisorPanel` gets an additive (non-breaking) badge per finding/suggestion. A contract request to GROUNDING is filed for the one gap that cannot be modeled from real data today (chunk-level citation + contradiction signal).

**Tech Stack:** Next.js 15 / React / TypeScript, Zod (existing schemas only, not modified), Vitest + @testing-library/react (jsdom), Tailwind utility classes matching existing Stella components, lucide-react icons.

## Global Constraints

- PRODUCT workstream may touch only `components/**` (except `components/marketing/Navbar.tsx`, `components/layout/MobileNav.tsx`) and `lib/stella/advisor/**` presentation code — never `db/**`, `supabase/**`, `db/prepared/**`, SQL, migrations, or `app/layout.tsx`. (docs/ops/STELLA_PARALLEL_WORKSTREAMS.md §5)
- No client-side SROI/business calculation. No certifying results. No hiding lack of evidence.
- No simulated/mock data as a *runtime* default — controlled fixtures are for tests only.
- Never declare a capability available when its backend flag is off.
- Max 2 commits total for this unit. No `git push`. No heavy gates (full suite / build) — focused tests only (`pnpm test:unit -- <path>` or vitest direct file run).
- Update only `docs/ops/workstreams/PRODUCT.md` among the governance docs; new contract files go under `docs/ops/contracts/` (a genuinely new path, not INTEGRATION-OWNED, per §8).
- Follow existing conventions: Spanish user-facing copy, `'use client'` pragma on interactive components, co-located `__tests__/` with `// @vitest-environment jsdom` pragma, `cn()` from `@/lib/utils` for class merging, callback-prop pattern for anything DOM-adjacent (never touch the DOM directly from a shared panel).

---

## Task 1: Grounding presentation model (pure types + mappers)

**Files:**
- Create: `components/stella/grounding-model.ts`
- Test: `components/stella/__tests__/grounding-model.test.ts`
- Modify: `components/stella/index.ts` (add exports)

**Interfaces:**
- Consumes: `AdvisorContextualOutput['findings'][number]` and `['suggestions'][number]` (`lib/stella/schemas/advisor-contextual-output.ts`), `StellaPanelErrorCode` (`components/stella/error-messages.ts`), `SuggestionDecisionAction` (`components/stella/decision-types.ts`), `sourceFieldLabel` + nothing else from `source-field-label.ts`, `EMPTY_COLLECTION_SENTINEL_SEGMENT`/`isCanonicalSourceFieldPath` from `@/lib/stella/context/canonical-source-field-paths`.
- Produces (consumed by Task 2 & 3): `EvidenceSupportLevel`, `EvidenceReference`, `GroundedClaim`, `StellaAvailabilityState`, `StellaDecisionStatus`, `classifyFindingSupport(finding)`, `classifySuggestionSupport(suggestion)`, `buildEvidenceReferences(sourceFields: readonly string[])`, `classifyAvailability(code: StellaPanelErrorCode) => StellaAvailabilityState`, `decisionStatusFromAction(action: SuggestionDecisionAction | null) => StellaDecisionStatus`.

- [ ] **Step 1: Write the failing test file**

```typescript
// components/stella/__tests__/grounding-model.test.ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  classifyFindingSupport,
  classifySuggestionSupport,
  buildEvidenceReferences,
  classifyAvailability,
  decisionStatusFromAction,
} from '../grounding-model'
import type { ContextualFinding, ContextualSuggestion } from '../StellaContextualAdvisorPanel'

function finding(overrides: Partial<ContextualFinding> = {}): ContextualFinding {
  return {
    id: 'f1',
    severity: 'info',
    title: 'Título',
    explanation: 'Explicación',
    sourceFields: [],
    ...overrides,
  }
}

function suggestion(overrides: Partial<ContextualSuggestion> = {}): ContextualSuggestion {
  return {
    id: 's1',
    proposedText: 'Texto propuesto',
    rationale: 'Motivo',
    missingInformation: [],
    sourceFields: [],
    ...overrides,
  }
}

describe('classifyFindingSupport', () => {
  it('is grounded when sourceFields cites real (non-.empty) paths', () => {
    expect(classifyFindingSupport(finding({ sourceFields: ['outcomesSnapshot[0].name'] }))).toBe('grounded')
  })

  it('is insufficient_evidence when sourceFields is empty', () => {
    expect(classifyFindingSupport(finding({ sourceFields: [] }))).toBe('insufficient_evidence')
  })

  it('is insufficient_evidence when every sourceField is an .empty sentinel', () => {
    expect(classifyFindingSupport(finding({ sourceFields: ['outcomesSnapshot.empty'] }))).toBe('insufficient_evidence')
  })

  it('is partially_grounded when sourceFields mixes real paths and .empty sentinels', () => {
    expect(
      classifyFindingSupport(finding({ sourceFields: ['outcomesSnapshot[0].name', 'indicatorsSnapshot.empty'] }))
    ).toBe('partially_grounded')
  })
})

describe('classifySuggestionSupport', () => {
  it('is insufficient_evidence (abstention) when proposedText is null, regardless of other fields', () => {
    expect(
      classifySuggestionSupport(suggestion({ proposedText: null, missingInformation: ['falta narrativa'] }))
    ).toBe('insufficient_evidence')
  })

  it('is grounded when proposedText exists, has real sourceFields, and no missingInformation', () => {
    expect(
      classifySuggestionSupport(suggestion({ sourceFields: ['narrativeSummary'], missingInformation: [] }))
    ).toBe('grounded')
  })

  it('is partially_grounded when proposedText exists with real sourceFields but missingInformation is non-empty', () => {
    expect(
      classifySuggestionSupport(
        suggestion({ sourceFields: ['narrativeSummary'], missingInformation: ['falta un indicador'] })
      )
    ).toBe('partially_grounded')
  })

  it('is partially_grounded (never grounded) when proposedText exists but sourceFields is empty and there are gaps', () => {
    expect(
      classifySuggestionSupport(suggestion({ sourceFields: [], missingInformation: ['falta contexto'] }))
    ).toBe('partially_grounded')
  })

  it('is insufficient_evidence when proposedText exists but sourceFields is empty and there are no gaps either', () => {
    expect(classifySuggestionSupport(suggestion({ sourceFields: [], missingInformation: [] }))).toBe(
      'insufficient_evidence'
    )
  })
})

describe('buildEvidenceReferences', () => {
  it('labels a known canonical path via sourceFieldLabel', () => {
    const refs = buildEvidenceReferences(['outcomesSnapshot[0].name'])
    expect(refs).toEqual([{ sourceField: 'outcomesSnapshot[0].name', label: 'Resultados › n.º 1 › nombre' }])
  })

  it('falls back to the raw path for a malformed / nonexistent citation without throwing', () => {
    const refs = buildEvidenceReferences(['not a canonical path!!'])
    expect(refs).toEqual([{ sourceField: 'not a canonical path!!', label: 'not a canonical path!!' }])
  })

  it('returns an empty array for an empty input', () => {
    expect(buildEvidenceReferences([])).toEqual([])
  })
})

describe('classifyAvailability', () => {
  it('maps DISABLED to unavailable', () => {
    expect(classifyAvailability('DISABLED')).toBe('unavailable')
  })
  it('maps UNAUTHORIZED to permission_denied', () => {
    expect(classifyAvailability('UNAUTHORIZED')).toBe('permission_denied')
  })
  it('maps QUOTA_EXCEEDED to quota_reached', () => {
    expect(classifyAvailability('QUOTA_EXCEEDED')).toBe('quota_reached')
  })
  it.each(['GEMINI_ERROR', 'TIMEOUT', 'PARSE_ERROR'] as const)('maps %s to provider_failure', (code) => {
    expect(classifyAvailability(code)).toBe('provider_failure')
  })
  it.each(['UNSUPPORTED_STEP', 'RATE_LIMITED', 'RATE_LIMIT_UNAVAILABLE', 'PAYLOAD_TOO_LARGE', 'AUDIT_ERROR', 'UNKNOWN_ERROR'] as const)(
    'maps %s to provider_failure (no dedicated bucket — surfaced via the existing error taxonomy)',
    (code) => {
      expect(classifyAvailability(code)).toBe('provider_failure')
    }
  )
})

describe('decisionStatusFromAction', () => {
  it('defaults to user_approval_required when no action has happened yet', () => {
    expect(decisionStatusFromAction(null)).toBe('user_approval_required')
  })
  it.each(['accepted', 'accepted_edited', 'rejected', 'undone'] as const)('maps %s 1:1', (action) => {
    expect(decisionStatusFromAction(action)).toBe(action)
  })
  it("maps 'copied' back to user_approval_required (clipboard is not a decision)", () => {
    expect(decisionStatusFromAction('copied')).toBe('user_approval_required')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run components/stella/__tests__/grounding-model.test.ts`
Expected: FAIL — `../grounding-model` module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// components/stella/grounding-model.ts
// PRODUCT TRAIN 1 — typed presentation model for grounded Stella responses.
//
// Every state here is derived from data this codebase already produces
// (AdvisorContextualOutput's sourceFields/missingInformation/proposedText,
// the StellaPanelErrorCode taxonomy, SuggestionDecisionAction). Nothing here
// invents a new backend capability or does business calculation — it only
// re-labels existing signals for richer, more honest rendering.
//
// `contradictory_evidence` is the one exception: today's advisor contract has
// no way to represent "two evidence items disagree" (GROUNDING has not
// published a retrieval/provenance contract yet — see
// docs/ops/contracts/PRODUCT-001_grounded-citation-provenance.md). The type
// models it and StellaGroundingBadge can render it, but no mapper in this
// file ever produces it — it stays reachable only via an explicit
// GroundedClaim built by a future caller (or a test fixture), never as a
// silent default.

import { sourceFieldLabel } from './source-field-label'
import { EMPTY_COLLECTION_SENTINEL_SEGMENT } from '@/lib/stella/context/canonical-source-field-paths'
import type { ContextualFinding, ContextualSuggestion } from './StellaContextualAdvisorPanel'
import type { StellaPanelErrorCode } from './error-messages'
import type { SuggestionDecisionAction } from './decision-types'

/** How well a single claim (finding or suggestion) is backed by cited context. */
export type EvidenceSupportLevel =
  | 'grounded'
  | 'partially_grounded'
  | 'insufficient_evidence'
  | 'contradictory_evidence'

/** One citation: a canonical source-field path plus its precomputed Spanish label. */
export interface EvidenceReference {
  sourceField: string
  label: string
}

/** Why a response cannot be rendered at all — one bucket per real error class. */
export type StellaAvailabilityState = 'unavailable' | 'permission_denied' | 'quota_reached' | 'provider_failure'

/** Where a claim sits in the human decision workflow. Mirrors SuggestionDecisionAction 1:1 minus 'copied'. */
export type StellaDecisionStatus = 'user_approval_required' | 'accepted' | 'accepted_edited' | 'rejected' | 'undone'

function isEmptySentinel(path: string): boolean {
  return path === EMPTY_COLLECTION_SENTINEL_SEGMENT || path.endsWith(`.${EMPTY_COLLECTION_SENTINEL_SEGMENT}`)
}

function classifySupport(opts: {
  hasContent: boolean
  sourceFields: readonly string[]
  hasGaps: boolean
}): EvidenceSupportLevel {
  if (!opts.hasContent) return 'insufficient_evidence'
  const realSources = opts.sourceFields.filter((f) => !isEmptySentinel(f))
  if (opts.sourceFields.length > 0 && realSources.length === 0) return 'insufficient_evidence'
  if (realSources.length === 0) return opts.hasGaps ? 'partially_grounded' : 'insufficient_evidence'
  return opts.hasGaps ? 'partially_grounded' : 'grounded'
}

/** Findings always have content (explanation text) and never carry a gaps list. */
export function classifyFindingSupport(finding: ContextualFinding): EvidenceSupportLevel {
  return classifySupport({ hasContent: true, sourceFields: finding.sourceFields, hasGaps: false })
}

/** Suggestions abstain via `proposedText: null` and can flag partial gaps via `missingInformation`. */
export function classifySuggestionSupport(suggestion: ContextualSuggestion): EvidenceSupportLevel {
  return classifySupport({
    hasContent: suggestion.proposedText !== null,
    sourceFields: suggestion.sourceFields,
    hasGaps: suggestion.missingInformation.length > 0,
  })
}

/** Maps raw canonical source-field paths to labeled, navigable-ready citation refs. */
export function buildEvidenceReferences(sourceFields: readonly string[]): EvidenceReference[] {
  return sourceFields.map((sourceField) => ({ sourceField, label: sourceFieldLabel(sourceField) }))
}

/**
 * Narrows the 12-code server error taxonomy down to the 4 availability
 * buckets the presentation layer needs to branch on. The full title/
 * description copy still comes from stellaErrorPresentation() — this
 * function only decides which typed bucket a code belongs to.
 */
export function classifyAvailability(code: StellaPanelErrorCode): StellaAvailabilityState {
  switch (code) {
    case 'DISABLED':
      return 'unavailable'
    case 'UNAUTHORIZED':
      return 'permission_denied'
    case 'QUOTA_EXCEEDED':
      return 'quota_reached'
    default:
      return 'provider_failure'
  }
}

/** `null` = no decision made yet. 'copied' is a clipboard side-action, not a decision. */
export function decisionStatusFromAction(action: SuggestionDecisionAction | null): StellaDecisionStatus {
  if (action === null || action === 'copied') return 'user_approval_required'
  return action
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run components/stella/__tests__/grounding-model.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Export the new public API**

In `components/stella/index.ts`, append:

```typescript
export {
  classifyFindingSupport,
  classifySuggestionSupport,
  buildEvidenceReferences,
  classifyAvailability,
  decisionStatusFromAction,
} from './grounding-model'
export type {
  EvidenceSupportLevel,
  EvidenceReference,
  StellaAvailabilityState,
  StellaDecisionStatus,
} from './grounding-model'
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no new errors.

- [ ] **Step 7: File the GROUNDING contract request**

Create `docs/ops/contracts/CONTRACT_LEDGER.md`:

```markdown
# Contract Ledger

One row per contract. See docs/ops/STELLA_PARALLEL_WORKSTREAMS.md §8 for the protocol.

| ID | Requesting line | Owning line | Status | Date | Doc |
|---|---|---|---|---|---|
| PRODUCT-001 | PRODUCT | GROUNDING | solicitado | 2026-08-04 | [PRODUCT-001_grounded-citation-provenance.md](PRODUCT-001_grounded-citation-provenance.md) |
```

Create `docs/ops/contracts/PRODUCT-001_grounded-citation-provenance.md`:

```markdown
# PRODUCT-001 — Grounded citation & contradiction provenance

**Requesting line:** PRODUCT
**Owning line:** GROUNDING
**Status:** solicitado (2026-08-04)

## Why

`components/stella/grounding-model.ts` (PRODUCT) models `EvidenceSupportLevel`
including `'contradictory_evidence'`, and `EvidenceReference` as a labeled
citation. Today's only real evidentiary signal is
`AdvisorContextualOutput.findings[].sourceFields` /
`.suggestions[].sourceFields` — canonical dotted paths into the *context
object PRODUCT already sent*, not references to retrieved documents/passages.
There is no way, from real data, to represent "this claim disagrees with that
other claim" — GROUNDING's retrieval/ranking/provenance pipeline
(docs/ops/workstreams/GROUNDING.md) has not published a contract yet.

Because of this, `classifyFindingSupport`/`classifySuggestionSupport` never
produce `'contradictory_evidence'` — it exists in the type and
`StellaGroundingBadge` can render it, but no mapper manufactures it. That is
intentional: PRODUCT will not declare a capability available when its
backend does not exist yet.

## Requested shape (TypeScript, for PRODUCT to consume)

```typescript
interface GroundingCitation {
  /** Stable id of the retrieved evidence/proxy document, NOT a context path. */
  documentId: string
  /** Short excerpt (already truncated/redacted server-side) shown as the citation body. */
  excerpt: string
  /** Where in the source document this excerpt came from (page, offset, section — GROUNDING's choice). */
  location: string
  /** GROUNDING's own confidence in the retrieval match, if it has one. */
  relevance?: 'high' | 'medium' | 'low'
}

interface GroundingContradiction {
  claimId: string
  conflictingCitations: [GroundingCitation, GroundingCitation]
  description: string
}
```

## Decision

_(integration fills this in when it resolves the request)_
```

- [ ] **Step 8: Commit**

```bash
git add components/stella/grounding-model.ts components/stella/__tests__/grounding-model.test.ts components/stella/index.ts docs/ops/contracts/CONTRACT_LEDGER.md "docs/ops/contracts/PRODUCT-001_grounded-citation-provenance.md"
git commit -m "feat(stella): model grounded response states"
```

---

## Task 2: Grounding badge, evidence panel, availability notice components

**Files:**
- Create: `components/stella/StellaGroundingBadge.tsx`
- Create: `components/stella/StellaEvidencePanel.tsx`
- Create: `components/stella/StellaAvailabilityNotice.tsx`
- Test: `components/stella/__tests__/StellaGroundingBadge.test.tsx`
- Test: `components/stella/__tests__/StellaEvidencePanel.test.tsx`
- Test: `components/stella/__tests__/StellaAvailabilityNotice.test.tsx`
- Modify: `components/stella/index.ts` (add exports)

**Interfaces:**
- Consumes: `EvidenceSupportLevel`, `EvidenceReference`, `StellaAvailabilityState` (Task 1), `stellaErrorPresentation`/`StellaPanelErrorCode` (`./error-messages`), `cn` (`@/lib/utils`).
- Produces (consumed by Task 3): `<StellaGroundingBadge level={EvidenceSupportLevel} />`, `<StellaEvidencePanel references={EvidenceReference[]} emptyLabel?: string onNavigate?: (ref: EvidenceReference) => void />`, `<StellaAvailabilityNotice state={StellaAvailabilityState} message={string} onRetry?: () => void />`.

- [ ] **Step 1: Write failing tests for `StellaGroundingBadge`**

```typescript
// components/stella/__tests__/StellaGroundingBadge.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { StellaGroundingBadge } from '../StellaGroundingBadge'

describe('StellaGroundingBadge', () => {
  it('renders the Spanish label for grounded', () => {
    render(<StellaGroundingBadge level="grounded" />)
    expect(screen.getByText('Fundamentado')).toBeInTheDocument()
  })

  it('renders the Spanish label for partially_grounded', () => {
    render(<StellaGroundingBadge level="partially_grounded" />)
    expect(screen.getByText('Parcialmente fundamentado')).toBeInTheDocument()
  })

  it('renders the Spanish label for insufficient_evidence', () => {
    render(<StellaGroundingBadge level="insufficient_evidence" />)
    expect(screen.getByText('Evidencia insuficiente')).toBeInTheDocument()
  })

  it('renders the Spanish label for contradictory_evidence', () => {
    render(<StellaGroundingBadge level="contradictory_evidence" />)
    expect(screen.getByText('Evidencia contradictoria')).toBeInTheDocument()
  })

  it('exposes the level as a data attribute for styling/testing hooks', () => {
    render(<StellaGroundingBadge level="grounded" />)
    expect(screen.getByTestId('stella-grounding-badge')).toHaveAttribute('data-support-level', 'grounded')
  })
})
```

- [ ] **Step 2: Run — verify fail**

Run: `pnpm exec vitest run components/stella/__tests__/StellaGroundingBadge.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `StellaGroundingBadge`**

```typescript
// components/stella/StellaGroundingBadge.tsx
// PRODUCT TRAIN 1 — visual badge for one claim's EvidenceSupportLevel.
'use client'

import { CheckCircle2, AlertTriangle, HelpCircle, GitCompareArrows } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { EvidenceSupportLevel } from './grounding-model'

const SUPPORT_META: Record<
  EvidenceSupportLevel,
  { label: string; badgeClass: string; Icon: typeof CheckCircle2 }
> = {
  grounded: {
    label: 'Fundamentado',
    badgeClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    Icon: CheckCircle2,
  },
  partially_grounded: {
    label: 'Parcialmente fundamentado',
    badgeClass: 'bg-uellix-orange/10 text-uellix-orange-strong',
    Icon: AlertTriangle,
  },
  insufficient_evidence: {
    label: 'Evidencia insuficiente',
    badgeClass: 'bg-muted text-muted-foreground',
    Icon: HelpCircle,
  },
  contradictory_evidence: {
    label: 'Evidencia contradictoria',
    badgeClass: 'bg-danger-light text-danger',
    Icon: GitCompareArrows,
  },
}

export interface StellaGroundingBadgeProps {
  level: EvidenceSupportLevel
  className?: string
}

export function StellaGroundingBadge({ level, className }: StellaGroundingBadgeProps) {
  const meta = SUPPORT_META[level]
  return (
    <span
      data-testid="stella-grounding-badge"
      data-support-level={level}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        meta.badgeClass,
        className
      )}
    >
      <meta.Icon className="h-3 w-3" aria-hidden="true" />
      {meta.label}
    </span>
  )
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm exec vitest run components/stella/__tests__/StellaGroundingBadge.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write failing tests for `StellaEvidencePanel`**

```typescript
// components/stella/__tests__/StellaEvidencePanel.test.tsx
// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StellaEvidencePanel } from '../StellaEvidencePanel'

describe('StellaEvidencePanel', () => {
  it('renders one item per reference with its label', () => {
    render(
      <StellaEvidencePanel
        references={[
          { sourceField: 'outcomesSnapshot[0].name', label: 'Resultados › n.º 1 › nombre' },
          { sourceField: 'narrativeSummary', label: 'Resumen narrativo' },
        ]}
      />
    )
    expect(screen.getByText('Resultados › n.º 1 › nombre')).toBeInTheDocument()
    expect(screen.getByText('Resumen narrativo')).toBeInTheDocument()
  })

  it('renders a graceful empty state instead of an empty list when there are no references', () => {
    render(<StellaEvidencePanel references={[]} />)
    expect(screen.getByTestId('stella-evidence-panel-empty')).toBeInTheDocument()
  })

  it('renders plain (non-interactive) chips when onNavigate is not provided', () => {
    render(<StellaEvidencePanel references={[{ sourceField: 'narrativeSummary', label: 'Resumen narrativo' }]} />)
    expect(screen.queryByRole('button', { name: /Resumen narrativo/ })).not.toBeInTheDocument()
  })

  it('renders navigable buttons and calls onNavigate with the clicked reference when onNavigate is provided', () => {
    const onNavigate = vi.fn()
    const ref = { sourceField: 'narrativeSummary', label: 'Resumen narrativo' }
    render(<StellaEvidencePanel references={[ref]} onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole('button', { name: /Resumen narrativo/ }))
    expect(onNavigate).toHaveBeenCalledWith(ref)
  })

  it('renders a malformed/nonexistent citation path gracefully without crashing', () => {
    render(<StellaEvidencePanel references={[{ sourceField: 'not.a.real.path!!', label: 'not.a.real.path!!' }]} />)
    expect(screen.getByText('not.a.real.path!!')).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Run — verify fail**

Run: `pnpm exec vitest run components/stella/__tests__/StellaEvidencePanel.test.tsx`
Expected: FAIL.

- [ ] **Step 7: Implement `StellaEvidencePanel`**

```typescript
// components/stella/StellaEvidencePanel.tsx
// PRODUCT TRAIN 1 — renders a claim's citations. Purely presentational: the
// panel never scrolls/highlights anything itself. When the caller supplies
// onNavigate, chips become buttons and the caller (the page, which knows the
// DOM layout) decides what "navigate to this source" means.
'use client'

import { cn } from '@/lib/utils'
import type { EvidenceReference } from './grounding-model'

export interface StellaEvidencePanelProps {
  references: readonly EvidenceReference[]
  /** Shown when references is empty. Defaults to a neutral Spanish message. */
  emptyLabel?: string
  /** When provided, each chip becomes a button that calls this with the clicked reference. */
  onNavigate?: (reference: EvidenceReference) => void
  className?: string
}

export function StellaEvidencePanel({ references, emptyLabel, onNavigate, className }: StellaEvidencePanelProps) {
  if (references.length === 0) {
    return (
      <p data-testid="stella-evidence-panel-empty" className={cn('text-xs text-muted-foreground italic', className)}>
        {emptyLabel ?? 'Stella no citó ninguna fuente para esta afirmación.'}
      </p>
    )
  }

  const chipClass =
    'inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground'

  return (
    <ul aria-label="Fuentes" className={cn('flex flex-wrap gap-1', className)}>
      {references.map((reference, i) => (
        <li key={`${reference.sourceField}-${i}`}>
          {onNavigate ? (
            <button
              type="button"
              title={reference.sourceField}
              className={cn(chipClass, 'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
              onClick={() => onNavigate(reference)}
            >
              {reference.label}
            </button>
          ) : (
            <span title={reference.sourceField} className={chipClass}>
              {reference.label}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 8: Run — verify pass**

Run: `pnpm exec vitest run components/stella/__tests__/StellaEvidencePanel.test.tsx`
Expected: PASS.

- [ ] **Step 9: Write failing tests for `StellaAvailabilityNotice`**

```typescript
// components/stella/__tests__/StellaAvailabilityNotice.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StellaAvailabilityNotice } from '../StellaAvailabilityNotice'

describe('StellaAvailabilityNotice', () => {
  it('renders the DISABLED presentation for unavailable', () => {
    render(<StellaAvailabilityNotice state="unavailable" message="" />)
    expect(screen.getByText('Stella no está habilitada')).toBeInTheDocument()
  })

  it('renders the UNAUTHORIZED presentation for permission_denied', () => {
    render(<StellaAvailabilityNotice state="permission_denied" message="Tu rol no tiene permiso para usar Stella." />)
    expect(screen.getByText('Sin permiso para usar Stella')).toBeInTheDocument()
  })

  it('renders the QUOTA_EXCEEDED presentation verbatim for quota_reached', () => {
    render(<StellaAvailabilityNotice state="quota_reached" message="Alcanzaste el límite mensual de 50 consultas." />)
    expect(screen.getByText('Alcanzaste el límite mensual de 50 consultas.')).toBeInTheDocument()
  })

  it('renders the GEMINI_ERROR presentation for provider_failure and offers retry', () => {
    const onRetry = vi.fn()
    render(<StellaAvailabilityNotice state="provider_failure" message="" onRetry={onRetry} />)
    expect(screen.getByText('Error del servicio de IA')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reintentar/ })).toBeInTheDocument()
  })

  it('exposes role="alert" for basic accessibility', () => {
    render(<StellaAvailabilityNotice state="unavailable" message="" />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
```

- [ ] **Step 10: Run — verify fail**

Run: `pnpm exec vitest run components/stella/__tests__/StellaAvailabilityNotice.test.tsx`
Expected: FAIL.

- [ ] **Step 11: Implement `StellaAvailabilityNotice`**

```typescript
// components/stella/StellaAvailabilityNotice.tsx
// PRODUCT TRAIN 1 — thin StellaAvailabilityState wrapper around the existing
// StellaErrorNotice/error-messages taxonomy, for reuse outside the big
// contextual advisor panel (future evidence/proxy review UIs). Copy is never
// duplicated: this maps the narrow 4-state union back to one representative
// StellaPanelErrorCode and delegates rendering to StellaErrorNotice.
'use client'

import { StellaErrorNotice } from './StellaErrorNotice'
import type { StellaAvailabilityState } from './grounding-model'
import type { StellaPanelErrorCode } from './error-messages'

const REPRESENTATIVE_CODE: Record<StellaAvailabilityState, StellaPanelErrorCode> = {
  unavailable: 'DISABLED',
  permission_denied: 'UNAUTHORIZED',
  quota_reached: 'QUOTA_EXCEEDED',
  provider_failure: 'GEMINI_ERROR',
}

export interface StellaAvailabilityNoticeProps {
  state: StellaAvailabilityState
  /** Server message, when there is one (verbatim for quota_reached). */
  message: string
  onRetry?: () => void
  className?: string
}

export function StellaAvailabilityNotice({ state, message, onRetry, className }: StellaAvailabilityNoticeProps) {
  return (
    <StellaErrorNotice code={REPRESENTATIVE_CODE[state]} message={message} onRetry={onRetry} className={className} />
  )
}
```

- [ ] **Step 12: Run — verify pass**

Run: `pnpm exec vitest run components/stella/__tests__/StellaAvailabilityNotice.test.tsx`
Expected: PASS.

- [ ] **Step 13: Export new components**

In `components/stella/index.ts`, append:

```typescript
export { StellaGroundingBadge } from './StellaGroundingBadge'
export { StellaEvidencePanel } from './StellaEvidencePanel'
export { StellaAvailabilityNotice } from './StellaAvailabilityNotice'
```

- [ ] **Step 14: Typecheck**

Run: `pnpm typecheck`
Expected: no new errors.

---

## Task 3: Wire the grounding badge into the real contextual advisor panel

**Files:**
- Modify: `components/stella/StellaContextualAdvisorPanel.tsx`
- Modify: `components/stella/__tests__/StellaContextualAdvisorPanel.test.tsx` (add cases; do not remove/alter existing ones)

**Interfaces:**
- Consumes: `classifyFindingSupport`, `classifySuggestionSupport` (Task 1), `StellaGroundingBadge` (Task 2).
- Produces: no new exports — the panel's public props (`StellaContextualAdvisorPanelProps`) are unchanged. Existing `data-testid`s are preserved.

- [ ] **Step 1: Add two failing test cases to the existing suite**

Read `components/stella/__tests__/StellaContextualAdvisorPanel.test.tsx` first to match its existing fixture helper names exactly (it already has a `success()`-style mock builder — reuse it, do not redefine). Append to the `describe` block:

```typescript
  it('renders a grounded badge on a finding whose sourceFields cite real context paths', async () => {
    success({
      findings: [
        {
          id: 'f1',
          severity: 'info',
          title: 'Título',
          explanation: 'Explicación',
          sourceFields: ['outcomesSnapshot[0].name'],
        },
      ],
      suggestions: [],
    })
    render(<StellaContextualAdvisorPanel projectId={PROJECT_ID} step="narrative" />)
    fireEvent.click(screen.getByRole('button', { name: /Consultar a Stella/ }))
    await waitFor(() => screen.getByTestId('stella-contextual-result'))
    const badge = screen.getByTestId('stella-grounding-badge')
    expect(badge).toHaveAttribute('data-support-level', 'grounded')
  })

  it('renders an insufficient_evidence badge on a suggestion with proposedText: null (abstention)', async () => {
    success({
      findings: [],
      suggestions: [
        {
          id: 's1',
          proposedText: null,
          rationale: 'Motivo',
          missingInformation: ['falta narrativa'],
          sourceFields: [],
        },
      ],
    })
    render(<StellaContextualAdvisorPanel projectId={PROJECT_ID} step="narrative" />)
    fireEvent.click(screen.getByRole('button', { name: /Consultar a Stella/ }))
    await waitFor(() => screen.getByTestId('stella-contextual-result'))
    const badge = screen.getByTestId('stella-grounding-badge')
    expect(badge).toHaveAttribute('data-support-level', 'insufficient_evidence')
  })
```

Adjust the two snippets above to match whatever the file's real mock-builder signature and `PROJECT_ID`/imports already are — read the file first (Step 0 below) since this plan cannot see its exact current mock shape.

- [ ] **Step 0 (do first): Read the current test file**

Run a read of `components/stella/__tests__/StellaContextualAdvisorPanel.test.tsx` in full before writing Step 1's cases, to match its fixture helper (likely a `success(overrides)` function wrapping `mockGetStellaContextualAdvisor.mockResolvedValue`), its `PROJECT_ID`/`step` constants, and its import list. Use its existing house style exactly — do not introduce a second mocking convention in the same file.

- [ ] **Step 2: Run to verify the two new cases fail**

Run: `pnpm exec vitest run components/stella/__tests__/StellaContextualAdvisorPanel.test.tsx`
Expected: the two new tests FAIL (no `stella-grounding-badge` rendered yet); all pre-existing tests in the file still PASS.

- [ ] **Step 3: Wire the badge into the panel**

In `components/stella/StellaContextualAdvisorPanel.tsx`:

Add to the import block (after the `sourceFieldLabel` import):

```typescript
import { classifyFindingSupport, classifySuggestionSupport } from './grounding-model'
import { StellaGroundingBadge } from './StellaGroundingBadge'
```

In the findings list, inside the `<div className="min-w-0">` that currently renders the title/explanation/`SourceChips` (around what is currently line ~396-410), add the badge right after the title paragraph and before `<SourceChips ... />`:

```tsx
                            <div className="min-w-0">
                              <p className="font-medium text-foreground">
                                <span
                                  className={cn(
                                    'mr-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                    SEVERITY_META[finding.severity].badgeClass
                                  )}
                                >
                                  {SEVERITY_META[finding.severity].label}
                                </span>
                                {finding.title}
                              </p>
                              <p className="mt-1 text-muted-foreground">{finding.explanation}</p>
                              <div className="mt-1 flex items-center gap-1.5">
                                <StellaGroundingBadge level={classifyFindingSupport(finding)} />
                              </div>
                              <SourceChips sourceFields={finding.sourceFields} />
                            </div>
```

In the suggestions list, right before the existing `<SourceChips sourceFields={suggestion.sourceFields} />` call (currently around line 472), add:

```tsx
                        <div className="mt-2 flex items-center gap-1.5">
                          <StellaGroundingBadge level={classifySuggestionSupport(suggestion)} />
                        </div>
                        <SourceChips sourceFields={suggestion.sourceFields} />
```

Do not touch anything else in the file — the lifecycle logic (accept/edit/reject/undo, error/disabled states, focus management) is unmodified.

- [ ] **Step 4: Run to verify all tests pass, old and new**

Run: `pnpm exec vitest run components/stella/__tests__/StellaContextualAdvisorPanel.test.tsx`
Expected: PASS — every pre-existing test still green, plus the two new grounding-badge cases.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no new errors.

- [ ] **Step 6: Run the full focused Stella component suite once (resource discipline — one focused run, not the full battery)**

Run: `pnpm exec vitest run components/stella`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/stella/StellaGroundingBadge.tsx components/stella/StellaEvidencePanel.tsx components/stella/StellaAvailabilityNotice.tsx components/stella/StellaContextualAdvisorPanel.tsx components/stella/index.ts components/stella/__tests__/StellaGroundingBadge.test.tsx components/stella/__tests__/StellaEvidencePanel.test.tsx components/stella/__tests__/StellaAvailabilityNotice.test.tsx components/stella/__tests__/StellaContextualAdvisorPanel.test.tsx
git commit -m "feat(stella): render evidence and human decision workflow"
```

---

## Task 4: Update PRODUCT.md and write the delivery report

**Files:**
- Modify: `docs/ops/workstreams/PRODUCT.md`

- [ ] **Step 1: Update the living-status sections**

Fill in "Propietario" (leave "sin asignar" — no name was given), "Unidad actual" (describe this unit: grounded-response presentation model + evidence/decision UI), "Contratos requeridos" (reference PRODUCT-001), "Últimos commits" (the two SHAs once made), "Pruebas ejecutadas" (list the vitest commands actually run and their result), "Riesgos" (note the `contradictory_evidence` dormant-state contract dependency; note `StellaContextualAdvisorPanel.tsx` was modified additively — flag for integration to re-run the full suite once all four lines merge, per §10), "Estado de entrega a integración" (ready, tree clean, no push).

- [ ] **Step 2: Do NOT commit this file with Task 1 or Task 3's commits**

Governance §9 requires one coherent technical unit per commit group and this doc update is a separate concern from the code. Options: fold it into the Task 3 commit (acceptable — it directly documents that commit's delivery) OR make it a third commit. **Constraint says max 2 commits total** — so fold the PRODUCT.md update into the Task 3 commit (Step 7 above): add `docs/ops/workstreams/PRODUCT.md` to that `git add` and reword the commit message body (not the subject line, which must stay exactly `feat(stella): render evidence and human decision workflow`) to note the doc update in the body.

- [ ] **Step 3: Final report to the user**

Produce the structured delivery report specified by the task prompt: Initial HEAD, Final HEAD, Components, Presentation states, Citation behavior, Abstention behavior, Decision workflow, Contract requests, Tests, Database changes (none), Result (`STELLA_PRODUCT_TRAIN_1_READY_FOR_INTEGRATION`).

---

## Self-Review Notes

- **Spec coverage:** grounded/partially_grounded/insufficient_evidence/contradictory_evidence/unavailable/permission_denied/quota_reached/provider_failure/user_approval_required — all 9 states named and typed (Task 1); contradictory_evidence intentionally dormant with a filed contract request (Task 1 Step 7); citations navigable via `onNavigate` (Task 2); abstention visible via existing null-proposedText path + new badge (Task 3); decisions already had a full accept/edit/reject/undo UI (pre-existing, unmodified) plus the new `decisionStatusFromAction` typed mapping (Task 1); disabled/quota/error states covered by `StellaAvailabilityNotice` (Task 2) reusing the existing taxonomy; no client SROI math anywhere in new code; no DB/SQL touched; max 2 commits; no push.
- **Placeholder scan:** none — every step has real code, real file paths, real function signatures.
- **Type consistency:** `EvidenceSupportLevel`/`EvidenceReference`/`StellaAvailabilityState`/`StellaDecisionStatus` are defined once in Task 1 and imported verbatim (never redeclared) in Tasks 2 and 3.

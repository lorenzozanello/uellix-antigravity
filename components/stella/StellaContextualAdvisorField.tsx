'use client'
// components/stella/StellaContextualAdvisorField.tsx
// WS2 (Moonshot) U3 — client wrapper that owns ONE controlled textarea and
// wires it as the apply target of the contextual advisor panel.
//
// Server pages cannot pass function props to client components, so any page
// with an obvious editable target (e.g. the narrative textarea) mounts this
// wrapper INSIDE its server-action <form>: the textarea keeps its `name`,
// the form keeps submitting through the existing server action, and the
// panel's `onApply` simply updates local state. Nothing is auto-submitted.

import { useState } from 'react'
import { StellaContextualAdvisorPanel } from './StellaContextualAdvisorPanel'
import type { SuggestionDecisionRecord } from './decision-types'
import type { AdvisorPipelineStep } from '@/lib/stella/advisor/steps'

const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y'

interface StellaContextualAdvisorFieldProps {
  projectId: string
  step: AdvisorPipelineStep
  /** Server-passed Stella Advisor availability (lib/stella/config). */
  enabled?: boolean
  /** Form field name (submitted through the surrounding server form). */
  fieldName: string
  /** Field id, kept so the page's label semantics survive. */
  fieldId: string
  /** Visible Spanish label for the field (also shown in the diff preview). */
  fieldLabel: string
  initialValue: string
  rows?: number
  panelTitle?: string
  /** Heading level for the panel title (page outline dependent). */
  headingLevel?: 2 | 3 | 4
  /** Decision persistence hook forwarded to the panel (default no-op). */
  onDecision?: (record: SuggestionDecisionRecord) => void
}

export function StellaContextualAdvisorField({
  projectId,
  step,
  enabled = true,
  fieldName,
  fieldId,
  fieldLabel,
  initialValue,
  rows = 4,
  panelTitle,
  headingLevel = 2,
  onDecision,
}: StellaContextualAdvisorFieldProps) {
  const [value, setValue] = useState(initialValue)

  return (
    <div>
      <label htmlFor={fieldId} className="block text-sm font-medium text-foreground">
        {fieldLabel}
      </label>
      <textarea
        id={fieldId}
        name={fieldName}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className={TEXTAREA_CLASS}
        rows={rows}
      />
      <StellaContextualAdvisorPanel
        projectId={projectId}
        step={step}
        enabled={enabled}
        title={panelTitle}
        headingLevel={headingLevel}
        targetValue={value}
        targetLabel={fieldLabel}
        onApply={(_suggestion, text) => setValue(text)}
        onDecision={onDecision}
        className="my-2"
      />
    </div>
  )
}

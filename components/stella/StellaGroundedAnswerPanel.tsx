'use client'
// components/stella/StellaGroundedAnswerPanel.tsx
// PRODUCT TRAIN 2 -- renders one GroundedAnswerView (INTEGRATION-001).
//
// Everything on screen here comes from the adapter. The component computes no
// support level, infers no contradiction, and does no SROI arithmetic: it is a
// renderer for a value that was already derived from GROUNDING's canonical
// contracts by a pure function.
//
// The states it must be able to say out loud, because each one leads a
// reviewer somewhere different:
//
//   grounded / partially grounded / insufficient / contradictory  (badge)
//   passage loaded vs. source unavailable                         (per citation)
//   abstention, with GROUNDING's own reason code and explanation  (section)
//   human approval still required                                 (always)

import { AlertTriangle, GitCompareArrows, Info, ShieldQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StellaGroundingBadge } from './StellaGroundingBadge'
import { StellaEvidencePanel } from './StellaEvidencePanel'
import type { GroundedAnswerView, GroundedCitationView, GroundedClaimView } from './grounding-adapter'
import type { GroundingAssertionKind, GroundingAnswerStatus } from '@/lib/grounding/contracts'
import type { StellaDecisionStatus } from './grounding-model'

const STATUS_LABELS: Record<GroundingAnswerStatus, string> = {
  grounded: 'Respuesta fundamentada',
  partially_grounded: 'Respuesta parcialmente fundamentada',
  abstained: 'Stella se abstuvo de responder',
}

const KIND_LABELS: Record<GroundingAssertionKind, string> = {
  evidence: 'Evidencia',
  inference: 'Inferencia',
  recommendation: 'Recomendación',
  absence: 'Ausencia de evidencia',
}

const DECISION_LABELS: Record<StellaDecisionStatus, string> = {
  user_approval_required: 'Requiere aprobación humana',
  accepted: 'Aceptada',
  accepted_edited: 'Aceptada con ediciones',
  rejected: 'Rechazada',
  undone: 'Deshecha',
}

export interface StellaGroundedAnswerPanelProps {
  answer: GroundedAnswerView
  /**
   * Navigation hook. The panel never scrolls or highlights anything itself --
   * the caller knows where the cited document is rendered.
   */
  onNavigateCitation?: (citation: GroundedCitationView) => void
  /** Heading level of the panel title; subsections use level + 1. */
  headingLevel?: 2 | 3 | 4
  title?: string
  className?: string
}

export function StellaGroundedAnswerPanel({
  answer,
  onNavigateCitation,
  headingLevel = 3,
  title,
  className,
}: StellaGroundedAnswerPanelProps) {
  const HeadingTag = `h${headingLevel}` as 'h2' | 'h3' | 'h4'
  const SubheadingTag = `h${Math.min(headingLevel + 1, 6)}` as 'h3' | 'h4' | 'h5'
  const panelTitle = title ?? 'Respuesta fundamentada de Stella'

  return (
    <section
      aria-label={panelTitle}
      data-testid="stella-grounded-answer-panel"
      data-status={answer.status}
      className={cn('rounded-lg border border-border bg-background p-3 text-sm', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <HeadingTag className="text-sm font-semibold text-foreground">{panelTitle}</HeadingTag>
        <div className="flex flex-wrap items-center gap-1.5">
          <StellaGroundingBadge level={answer.answerSupport} />
          <span
            data-testid="stella-grounded-answer-decision"
            className="inline-flex items-center rounded bg-uellix-orange/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-uellix-orange-strong"
          >
            {DECISION_LABELS[answer.decisionStatus]}
          </span>
        </div>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">{STATUS_LABELS[answer.status]}</p>

      {answer.unresolvedCitationCount > 0 && (
        <p
          role="note"
          data-testid="stella-grounded-answer-unresolved"
          className="mt-2 rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground"
        >
          {answer.unresolvedCitationCount === 1
            ? 'Una cita no pudo mostrar su pasaje porque la fuente no está cargada.'
            : `${answer.unresolvedCitationCount} citas no pudieron mostrar su pasaje porque la fuente no está cargada.`}
        </p>
      )}

      {answer.claims.length > 0 && (
        <ol className="mt-3 space-y-3" aria-label="Afirmaciones">
          {answer.claims.map((claim) => (
            <li key={claim.key}>
              <ClaimBlock
                claim={claim}
                onNavigateCitation={onNavigateCitation}
                SubheadingTag={SubheadingTag}
              />
            </li>
          ))}
        </ol>
      )}

      {answer.contradictions.length > 0 && (
        <div className="mt-3" data-testid="stella-grounded-answer-contradictions">
          <SubheadingTag className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground">
            <GitCompareArrows className="h-3.5 w-3.5 text-danger" aria-hidden="true" />
            Evidencia en conflicto
          </SubheadingTag>
          <ul className="space-y-2">
            {answer.contradictions.map((contradiction) => (
              <li
                key={contradiction.id}
                data-testid={`stella-contradiction-${contradiction.id}`}
                data-severity={contradiction.severity}
                className="rounded-md border border-danger/40 bg-danger-light/40 p-2.5"
              >
                <p className="text-xs font-medium text-foreground">{contradiction.summary}</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Lado A
                    </p>
                    <StellaEvidencePanel
                      citations={contradiction.sideA}
                      onNavigateCitation={onNavigateCitation}
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Lado B
                    </p>
                    <StellaEvidencePanel
                      citations={contradiction.sideB}
                      onNavigateCitation={onNavigateCitation}
                    />
                  </div>
                </div>
                {/* The contract admits exactly one resolution. Stella does not
                    average the two figures, prefer the newer document, or drop
                    the inconvenient side -- it reports both and stops. */}
                <p className="mt-2 text-xs text-muted-foreground">
                  Stella no resuelve este conflicto. Requiere resolución humana.
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {answer.abstention !== null && (
        <div
          role="note"
          data-testid="stella-grounded-answer-abstention"
          data-abstention-code={answer.abstention.code}
          className="mt-3 rounded-md border border-border bg-muted/30 p-2.5"
        >
          <SubheadingTag className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground">
            <ShieldQuestion className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            {answer.abstention.title}
          </SubheadingTag>
          <p className="mt-1 text-xs text-muted-foreground">{answer.abstention.explanation}</p>
          <p className="mt-1 text-[10px] text-muted-foreground/80">
            Candidatos inspeccionados: {answer.abstention.inspected.total} · bajo el umbral:{' '}
            {answer.abstention.inspected.belowThreshold} · retenidos:{' '}
            {answer.abstention.inspected.quarantined}
          </p>
        </div>
      )}

      <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground/70">
        Stella brinda orientación consultiva únicamente. Se requiere revisión humana antes de su uso
        externo.
      </p>
    </section>
  )
}

function ClaimBlock({
  claim,
  onNavigateCitation,
  SubheadingTag,
}: {
  claim: GroundedClaimView
  onNavigateCitation?: (citation: GroundedCitationView) => void
  SubheadingTag: 'h3' | 'h4' | 'h5'
}) {
  return (
    <div
      data-testid={`stella-grounded-claim-${claim.key}`}
      data-claim-kind={claim.kind}
      className="rounded-md border border-border p-2.5"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {KIND_LABELS[claim.kind]}
        </span>
        <StellaGroundingBadge level={claim.support} />
      </div>

      <p className="mt-1.5 text-foreground">{claim.statement}</p>

      {claim.inferenceBasis !== null && (
        <p
          data-testid={`stella-claim-inference-basis-${claim.key}`}
          className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium">Paso de razonamiento: </span>
            {claim.inferenceBasis}
          </span>
        </p>
      )}

      {claim.abstention !== null && (
        <p
          data-testid={`stella-claim-abstention-${claim.key}`}
          data-abstention-code={claim.abstention.code}
          className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-uellix-orange-strong" aria-hidden="true" />
          <span>
            <span className="font-medium">{claim.abstention.title}: </span>
            {claim.abstention.explanation}
          </span>
        </p>
      )}

      <div className="mt-2">
        <SubheadingTag className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Citas
        </SubheadingTag>
        <StellaEvidencePanel
          citations={claim.citations}
          onNavigateCitation={onNavigateCitation}
          emptyLabel="Esta afirmación no cita ningún pasaje."
        />
      </div>
    </div>
  )
}

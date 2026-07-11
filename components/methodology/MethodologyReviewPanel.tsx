'use client'
// components/methodology/MethodologyReviewPanel.tsx
// Fase 2 — reusable methodology review panel, dropped into any pipeline step.
// Merges the step's fixed checklist template with saved items (by itemKey) so
// the reviewer always sees the full methodology checklist; a row is only written
// to the DB once a status is assigned (opt-in, upsert-on-first-touch).

import { useEffect, useState, useTransition } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import {
  getMethodologyReviewAction,
  upsertMethodologyReviewItemAction,
} from '@/app/actions/methodology-review'
import type {
  PipelineReviewStep,
  ReviewItemStatus,
  ReviewItemSeverity,
} from '@/lib/pipeline/methodology-review'

type Row = {
  itemKey: string
  label: string
  severity: ReviewItemSeverity
  status: ReviewItemStatus | 'unreviewed'
  isCustom: boolean
}

const STATUS_LABELS: Record<ReviewItemStatus | 'unreviewed', string> = {
  unreviewed: '— sin revisar —',
  pass: 'Cumple',
  warning: 'Advertencia',
  fail: 'No cumple',
  not_applicable: 'No aplica',
}

const SEVERITY_LABELS: Record<ReviewItemSeverity, string> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
}

function scoreBadgeVariant(score: number | null) {
  if (score === null) return 'neutral' as const
  if (score >= 80) return 'success' as const
  if (score >= 50) return 'warning' as const
  return 'danger' as const
}

function statusBadgeVariant(status: Row['status']) {
  if (status === 'pass') return 'success' as const
  if (status === 'warning') return 'warning' as const
  if (status === 'fail') return 'danger' as const
  return 'neutral' as const
}

interface MethodologyReviewPanelProps {
  projectId: string
  step: PipelineReviewStep
  title?: string
  className?: string
}

export function MethodologyReviewPanel({
  projectId,
  step,
  title,
  className,
}: MethodologyReviewPanelProps) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [score, setScore] = useState<number | null>(null)
  const [error, setError] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [savingKey, setSavingKey] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getMethodologyReviewAction(projectId, step)
      .then((data) => {
        if (!active) return
        // The action returns the template plus any saved matrix + items. When
        // nothing has been reviewed yet (null), fall back to the template alone —
        // but the action always includes the template, so derive rows from a
        // fresh template fetch shape.
        loadRows(data)
      })
      .catch(() => active && setError(true))
    return () => {
      active = false
    }
  }, [projectId, step])

  function loadRows(
    data: Awaited<ReturnType<typeof getMethodologyReviewAction>>
  ) {
    // getMethodologyReview always returns the template; matrix/items are empty
    // until the first item is saved (opt-in).
    const savedByKey = new Map(data.items.map((i) => [i.itemKey, i]))
    const templateRows: Row[] = data.template.map((t) => {
      const saved = savedByKey.get(t.itemKey)
      return {
        itemKey: t.itemKey,
        label: t.label,
        severity: (saved?.severity as ReviewItemSeverity) ?? t.defaultSeverity,
        status: (saved?.status as ReviewItemStatus) ?? 'unreviewed',
        isCustom: false,
      }
    })
    // Custom saved items not in the template appear after the template rows.
    const customRows: Row[] = data.items
      .filter((i) => i.isCustom && !data.template.some((t) => t.itemKey === i.itemKey))
      .map((i) => ({
        itemKey: i.itemKey,
        label: i.label,
        severity: i.severity as ReviewItemSeverity,
        status: i.status as ReviewItemStatus,
        isCustom: true,
      }))
    setRows([...templateRows, ...customRows])
    setScore(data.matrix?.readinessScore ?? null)
  }

  function handleStatusChange(row: Row, nextStatus: ReviewItemStatus) {
    setSavingKey(row.itemKey)
    startTransition(async () => {
      try {
        await upsertMethodologyReviewItemAction(projectId, step, {
          itemKey: row.itemKey,
          label: row.label,
          status: nextStatus,
          severity: row.severity,
          isCustom: row.isCustom,
        })
        // Reload to get the recomputed matrix score and canonical rows.
        const fresh = await getMethodologyReviewAction(projectId, step)
        loadRows(fresh)
      } catch {
        setError(true)
      } finally {
        setSavingKey(null)
      }
    })
  }

  return (
    <section
      className={cn('rounded-lg border border-border bg-muted/20 p-4 my-4 text-sm', className)}
      aria-label={title ?? 'Revisión metodológica'}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{title ?? 'Revisión metodológica'}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Checklist metodológico de este paso. El puntaje de preparación se calcula
            automáticamente a partir de los ítems evaluados.
          </p>
        </div>
        <Badge variant={scoreBadgeVariant(score)} className="shrink-0">
          {score === null ? 'Sin evaluar' : `Preparación ${score}%`}
        </Badge>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-muted-foreground">
          No se pudo cargar la revisión. Los datos de tu pipeline no se ven afectados.
        </p>
      )}

      {rows && rows.length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {rows.map((row) => (
            <li key={row.itemKey} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-foreground">{row.label}</p>
                <p className="text-xs text-muted-foreground">
                  Severidad: {SEVERITY_LABELS[row.severity]}
                  {row.isCustom && ' · personalizado'}
                </p>
              </div>
              <Badge variant={statusBadgeVariant(row.status)} className="shrink-0">
                {STATUS_LABELS[row.status]}
              </Badge>
              <div className="w-40 shrink-0">
                <Select
                  aria-label={`Estado de: ${row.label}`}
                  value={row.status}
                  disabled={isPending && savingKey === row.itemKey}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === 'unreviewed') return
                    handleStatusChange(row, v as ReviewItemStatus)
                  }}
                >
                  {row.status === 'unreviewed' && (
                    <option value="unreviewed">{STATUS_LABELS.unreviewed}</option>
                  )}
                  <option value="pass">{STATUS_LABELS.pass}</option>
                  <option value="warning">{STATUS_LABELS.warning}</option>
                  <option value="fail">{STATUS_LABELS.fail}</option>
                  <option value="not_applicable">{STATUS_LABELS.not_applicable}</option>
                </Select>
              </div>
            </li>
          ))}
        </ul>
      )}

      {rows === null && !error && (
        <p className="mt-3 text-muted-foreground" aria-busy="true">
          Cargando checklist…
        </p>
      )}
    </section>
  )
}

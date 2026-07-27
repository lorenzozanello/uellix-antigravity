'use client'
// components/retention/StellaRetentionPanel.tsx
// Etapa A2.4 (DR-004 aprobado) — the operative UI for Stella's response
// retention policy: effective policy display, dry-run, confirm-apply,
// active holds, and recent-run history. Mirrors
// OutcomeSensitiveAggregationPanel.tsx's pattern (Etapa A2.3.2):
// useState/useTransition, typed server actions called directly, no
// FormData.
//
// Never renders: response content (nothing here ever fetches
// response_json), unnecessary IDs, deleted text, or any sensitive value —
// only counts, dates, and fixed vocabulary (hold type/reason code).

import { useState, useTransition } from 'react'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import {
  updateRetentionSettingsAction,
  previewRetentionSettingsImpactAction,
  createRetentionHoldAction,
  releaseRetentionHoldAction,
  previewStellaRetentionPurgeAction,
  executeStellaRetentionPurgeAction,
  type RetentionOverview,
  type RetentionHoldListItem,
  type RecentPurgeRunItem,
} from '@/app/actions/stella/retention'
import { ALLOWED_HOLD_TYPES, ALLOWED_HOLD_REASON_CODES } from '@/lib/stella/retention/policy'
import type { PurgeRunSummary } from '@/lib/stella/retention/purge-service'

const HOLD_TYPE_LABEL: Record<string, string> = {
  legal_hold: 'Retención legal',
  audit_investigation: 'Investigación de auditoría',
  dispute: 'Disputa',
  contractual_obligation: 'Obligación contractual',
  authorized_preservation: 'Preservación autorizada',
}

const HOLD_REASON_LABEL: Record<string, string> = {
  pending_legal_review: 'Revisión legal pendiente',
  regulatory_request: 'Solicitud regulatoria',
  active_dispute: 'Disputa activa',
  incident_investigation: 'Investigación de incidente',
  contractual_requirement: 'Requisito contractual',
}

const STATUS_LABEL: Record<string, { label: string; variant: 'warning' | 'success' | 'neutral' | 'danger' }> = {
  pending: { label: 'Pendiente', variant: 'neutral' },
  running: { label: 'En curso', variant: 'warning' },
  completed: { label: 'Completada', variant: 'success' },
  completed_with_errors: { label: 'Completada con errores', variant: 'warning' },
  failed: { label: 'Fallida', variant: 'danger' },
  cancelled: { label: 'Cancelada', variant: 'neutral' },
}

interface Props {
  overview: RetentionOverview
  initialHolds: RetentionHoldListItem[]
  initialRuns: RecentPurgeRunItem[]
  canManage: boolean
}

export function StellaRetentionPanel({ overview, initialHolds, initialRuns, canManage }: Props) {
  const [months, setMonths] = useState(String(overview.organizationResponseRetentionMonths))
  const [impactPreview, setImpactPreview] = useState<number | null>(null)
  const [holds, setHolds] = useState(initialHolds)
  const [runs, setRuns] = useState(initialRuns)
  const [dryRunResult, setDryRunResult] = useState<PurgeRunSummary | null>(null)
  const [applyResult, setApplyResult] = useState<PurgeRunSummary | null>(null)
  const [confirmingApply, setConfirmingApply] = useState(false)
  const [showHoldForm, setShowHoldForm] = useState(false)
  const [holdType, setHoldType] = useState(ALLOWED_HOLD_TYPES[0])
  const [holdReason, setHoldReason] = useState(ALLOWED_HOLD_REASON_CODES[0])
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const activeHolds = holds.filter((h) => h.status === 'active')

  async function refreshRuns() {
    const { listRecentStellaRetentionPurgeRunsAction } = await import('@/app/actions/stella/retention')
    const result = await listRecentStellaRetentionPurgeRunsAction(5)
    if (result.ok) setRuns(result.items)
  }

  async function refreshHolds() {
    const { listRetentionHoldsAction } = await import('@/app/actions/stella/retention')
    const result = await listRetentionHoldsAction()
    if (result.ok) setHolds(result.items)
  }

  function handlePreviewImpact() {
    const value = Number(months)
    if (!Number.isInteger(value)) return
    setError(null)
    startTransition(async () => {
      const result = await previewRetentionSettingsImpactAction(value)
      if (!result.ok) return
      setImpactPreview(result.newlyEligibleCount)
    })
  }

  function handleSaveSettings() {
    const value = Number(months)
    if (!Number.isInteger(value)) {
      setError('El valor debe ser un entero.')
      return
    }
    setError(null)
    startTransition(async () => {
      const result = await updateRetentionSettingsAction(value)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setImpactPreview(null)
    })
  }

  function handleDryRun() {
    setError(null)
    setApplyResult(null)
    startTransition(async () => {
      const result = await previewStellaRetentionPurgeAction()
      if (!result.ok) {
        setError(result.message)
        return
      }
      setDryRunResult(result.run)
      await refreshRuns()
    })
  }

  function handleConfirmApply() {
    if (!dryRunResult) return
    setError(null)
    startTransition(async () => {
      const result = await executeStellaRetentionPurgeAction(dryRunResult.id)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setApplyResult(result.run)
      setDryRunResult(null)
      setConfirmingApply(false)
      await refreshRuns()
    })
  }

  function handleCreateHold() {
    setError(null)
    startTransition(async () => {
      const result = await createRetentionHoldAction({ holdType, reasonCode: holdReason })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setShowHoldForm(false)
      await refreshHolds()
    })
  }

  function handleReleaseHold(holdId: string) {
    setError(null)
    startTransition(async () => {
      const result = await releaseRetentionHoldAction(holdId)
      if (!result.ok) {
        setError(result.message)
        return
      }
      await refreshHolds()
    })
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Retención de datos de Stella</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Política técnica inicial (versión {overview.policyVersion}) — pendiente de revisión legal y contractual (Etapa A3). No constituye una garantía jurídica de cumplimiento.
        </p>
      </div>

      <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
        <p className="text-foreground">
          Retención de respuestas de Stella: <strong>{overview.organizationResponseRetentionMonths} meses</strong>
          {overview.isDefaultSetting ? ' (valor por defecto)' : ' (configurado por tu organización)'}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Al vencer, se elimina el contenido de la respuesta (response_json) — los metadatos de auditoría, el manifiesto estructural y el historial de la interacción se conservan siempre.
        </p>
      </div>

      {activeHolds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {activeHolds.map((h) => (
            <Badge key={h.id} variant="warning" title={`${HOLD_TYPE_LABEL[h.holdType] ?? h.holdType} · ${HOLD_REASON_LABEL[h.reasonCode] ?? h.reasonCode}`}>
              Preservación activa · {HOLD_TYPE_LABEL[h.holdType] ?? h.holdType}
            </Badge>
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div>
          <p className="text-xs font-medium text-foreground">Última ejecución</p>
          <div className="mt-1 space-y-1">
            {runs.slice(0, 3).map((r) => {
              const status = STATUS_LABEL[r.status] ?? { label: r.status, variant: 'neutral' as const }
              return (
                <div key={r.id} className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <Badge variant={status.variant}>{status.label}</Badge>
                  <span>{r.mode === 'dry_run' ? 'Simulación' : 'Aplicación'}</span>
                  <span>{new Date(r.createdAt).toLocaleString()}</span>
                  <span>escaneadas: {r.recordsScanned}</span>
                  <span>elegibles: {r.recordsEligible}</span>
                  <span>purgadas: {r.recordsPurged}</span>
                  {r.recordsSkippedHold > 0 && <span>bloqueadas por hold: {r.recordsSkippedHold}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {canManage && (
        <div className="space-y-3 border-t border-border/60 pt-3">
          <div>
            <p className="text-xs font-medium text-foreground">Simulación y aplicación de purga</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleDryRun}
                disabled={isPending}
                className="h-8 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                Ejecutar dry-run
              </button>
            </div>

            {dryRunResult && (
              <div className="mt-2 rounded-md border border-border/60 bg-muted/20 p-2 text-[11px] text-muted-foreground">
                <p>
                  Simulación completada: {dryRunResult.recordsEligible} elegible(s) de {dryRunResult.recordsScanned} escaneada(s)
                  {dryRunResult.recordsSkippedHold > 0 ? `, ${dryRunResult.recordsSkippedHold} bloqueada(s) por preservación` : ''}.
                </p>
                {dryRunResult.recordsEligible > 0 && (
                  confirmingApply ? (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-danger">¿Confirmar la purga de {dryRunResult.recordsEligible} respuesta(s)? Esta acción no puede deshacerse.</span>
                      <button
                        type="button"
                        onClick={handleConfirmApply}
                        disabled={isPending}
                        className="h-7 rounded border border-danger bg-background px-2 text-foreground hover:bg-danger/10 disabled:opacity-50"
                      >
                        Confirmar purga
                      </button>
                      <button type="button" onClick={() => setConfirmingApply(false)} className="text-muted-foreground underline">
                        Cancelar
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingApply(true)}
                      disabled={isPending}
                      className="mt-2 h-7 rounded border border-border bg-background px-2 text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      Aplicar purga
                    </button>
                  )
                )}
              </div>
            )}

            {applyResult && (
              <div className="mt-2 rounded-md border border-border/60 bg-muted/20 p-2 text-[11px] text-muted-foreground">
                Purga aplicada: {applyResult.recordsPurged} respuesta(s) redactada(s).
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-foreground">Cambiar retención de respuestas</p>
            <div className="mt-1 flex flex-wrap items-end gap-2">
              <div className="w-28">
                <label className="block text-[11px] text-muted-foreground">Meses</label>
                <input
                  type="number"
                  min={overview.minResponseRetentionMonths}
                  max={overview.maxResponseRetentionMonths}
                  value={months}
                  onChange={(e) => { setMonths(e.target.value); setImpactPreview(null) }}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                />
              </div>
              <button
                type="button"
                onClick={handlePreviewImpact}
                disabled={isPending}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground hover:bg-muted disabled:opacity-50"
              >
                Ver impacto
              </button>
              <button
                type="button"
                onClick={handleSaveSettings}
                disabled={isPending}
                className="h-8 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Guardar
              </button>
            </div>
            {impactPreview !== null && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Con este valor, {impactPreview} respuesta(s) actualmente retenida(s) pasarían a ser elegibles para purga en la próxima ejecución.
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-foreground">Preservaciones (holds)</p>
              {!showHoldForm && (
                <button type="button" onClick={() => setShowHoldForm(true)} className="text-[11px] text-muted-foreground underline hover:opacity-70">
                  Nueva preservación
                </button>
              )}
            </div>

            {showHoldForm && (
              <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-border/60 bg-background p-2">
                <div className="w-44">
                  <label className="block text-[11px] text-muted-foreground">Tipo</label>
                  <Select value={holdType} onChange={(e) => setHoldType(e.target.value as typeof holdType)} className="h-8 text-xs">
                    {ALLOWED_HOLD_TYPES.map((t) => (
                      <option key={t} value={t}>{HOLD_TYPE_LABEL[t]}</option>
                    ))}
                  </Select>
                </div>
                <div className="w-44">
                  <label className="block text-[11px] text-muted-foreground">Motivo</label>
                  <Select value={holdReason} onChange={(e) => setHoldReason(e.target.value as typeof holdReason)} className="h-8 text-xs">
                    {ALLOWED_HOLD_REASON_CODES.map((r) => (
                      <option key={r} value={r}>{HOLD_REASON_LABEL[r]}</option>
                    ))}
                  </Select>
                </div>
                <button type="button" onClick={handleCreateHold} disabled={isPending} className="h-8 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  Crear
                </button>
                <button type="button" onClick={() => setShowHoldForm(false)} disabled={isPending} className="h-8 rounded-md border border-border bg-background px-3 text-xs text-foreground hover:bg-muted disabled:opacity-50">
                  Cancelar
                </button>
              </div>
            )}

            {activeHolds.length === 0 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">Sin preservaciones activas.</p>
            ) : (
              <div className="mt-1 space-y-1">
                {activeHolds.map((h) => (
                  <div key={h.id} className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{HOLD_TYPE_LABEL[h.holdType] ?? h.holdType}</span>
                    <span>{HOLD_REASON_LABEL[h.reasonCode] ?? h.reasonCode}</span>
                    <span>{h.interactionId ? 'alcance: interacción' : h.projectId ? 'alcance: proyecto' : 'alcance: organización'}</span>
                    <button
                      type="button"
                      onClick={() => handleReleaseHold(h.id)}
                      disabled={isPending}
                      className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      Liberar
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}

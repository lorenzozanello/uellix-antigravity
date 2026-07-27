'use client'
// components/aggregation/OutcomeSensitiveAggregationPanel.tsx
// Etapa A2.3.2 (STL-A232-010 a 015, DR-002/DR-003) — the operative UI for
// sensitive-aggregation declarations, closing reserve #1 from
// STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md. Mirrors
// OutcomeTaxonomyMapper.tsx's pattern (useState/useTransition, calls typed
// server actions directly, no FormData).
//
// Deliberate UI restrictions (per the Etapa A2.3.2 spec — "la UI no debe
// permitir"): no field to override the minimum group size or any other
// policy constant (both are fixed server-side); no actor-selection field
// (declaredBy/verifiedBy/revokedBy always resolve from the session); no way
// to create a declaration as already-"verified" (create always yields
// 'pending', verification is a separate, admin-only action); no "edit" on a
// verified declaration (superseding it is the only path — creates a new row,
// never mutates the old one); no free-text field invites sensitive content —
// countSourceNote is capped short and explicitly labeled as structural-only;
// no cross-org/cross-project selector (both are fixed by the page context).

import { useState, useTransition } from 'react'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import {
  createAggregationDeclaration,
  verifyAggregationDeclaration,
  revokeAggregationDeclaration,
  supersedeAggregationDeclaration,
  listEntityAggregationDeclarations,
  type EntityDeclarationHistoryItem,
} from '@/app/actions/stella/aggregation-declarations'
import {
  ALLOWED_AGGREGATION_DIMENSIONS,
  ALLOWED_COUNT_SOURCE_TYPES,
  MAX_AGGREGATION_DIMENSIONS,
  MINIMUM_SENSITIVE_GROUP_SIZE,
  type AggregationDimension,
  type CountSourceType,
} from '@/lib/stella/aggregation/policy'
import type { DeclarationSensitiveCategory } from '@/lib/stella/aggregation/types'

const CATEGORY_LABEL: Record<DeclarationSensitiveCategory, string> = {
  minors: 'Menores',
  health: 'Salud',
  minors_and_health: 'Menores y salud',
}

const STATUS_BADGE: Record<
  EntityDeclarationHistoryItem['verificationStatus'],
  { label: string; variant: 'warning' | 'success' | 'neutral' }
> = {
  pending: { label: 'Pendiente de verificación', variant: 'warning' },
  verified: { label: 'Verificada', variant: 'success' },
  revoked: { label: 'Revocada', variant: 'neutral' },
  superseded: { label: 'Sustituida', variant: 'neutral' },
}

const DIMENSION_LABEL: Record<AggregationDimension, string> = {
  age_band: 'Rango etario',
  gender: 'Género',
  territory_level: 'Nivel territorial',
  program_period: 'Período del programa',
  education_level_band: 'Nivel educativo',
  condition_category: 'Categoría de condición',
}

const COUNT_SOURCE_LABEL: Record<CountSourceType, string> = {
  project_record: 'Registro del proyecto',
  indicator_measurement: 'Medición de indicador',
  stakeholder_record: 'Registro de grupo de interés',
  verified_external_evidence: 'Evidencia externa verificada',
  manual_verified_declaration: 'Declaración manual verificada',
}

interface FormState {
  sensitiveCategory: DeclarationSensitiveCategory
  groupSize: string
  dimensions: AggregationDimension[]
  countSourceType: CountSourceType
  countSourceId: string
  countSourceNote: string
}

const EMPTY_FORM: FormState = {
  sensitiveCategory: 'minors',
  groupSize: '',
  dimensions: [],
  countSourceType: 'indicator_measurement',
  countSourceId: '',
  countSourceNote: '',
}

interface Props {
  projectId: string
  outcomeId: string
  initialItems: EntityDeclarationHistoryItem[]
  canCreateOrSupersede: boolean
  canVerifyOrRevoke: boolean
}

function hasActorFields(
  item: EntityDeclarationHistoryItem,
): item is Extract<EntityDeclarationHistoryItem, { declaredBy: string }> {
  return 'declaredBy' in item
}

export function OutcomeSensitiveAggregationPanel({
  projectId,
  outcomeId,
  initialItems,
  canCreateOrSupersede,
  canVerifyOrRevoke,
}: Props) {
  const [items, setItems] = useState(initialItems)
  const [showHistory, setShowHistory] = useState(false)
  const [formMode, setFormMode] = useState<{ kind: 'create' } | { kind: 'supersede'; previousId: string } | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const [isPending, startTransition] = useTransition()

  const activeItems = items.filter((i) => i.verificationStatus === 'pending' || i.verificationStatus === 'verified')

  async function refresh() {
    const result = await listEntityAggregationDeclarations(projectId, 'outcome', outcomeId)
    if (result.ok) setItems(result.items)
  }

  function toggleDimension(dim: AggregationDimension) {
    setForm((f) => {
      const already = f.dimensions.includes(dim)
      if (already) return { ...f, dimensions: f.dimensions.filter((d) => d !== dim) }
      if (f.dimensions.length >= MAX_AGGREGATION_DIMENSIONS) return f
      return { ...f, dimensions: [...f.dimensions, dim] }
    })
  }

  function handleSubmitForm() {
    const groupSize = Number(form.groupSize)
    if (!Number.isInteger(groupSize) || groupSize <= 0) {
      setError('El tamaño de grupo debe ser un entero positivo.')
      return
    }
    setError(null)
    const input = {
      projectId,
      entityType: 'outcome' as const,
      entityId: outcomeId,
      sensitiveCategory: form.sensitiveCategory,
      groupSize,
      dimensions: form.dimensions,
      countSourceType: form.countSourceType,
      countSourceId: form.countSourceId.trim() || undefined,
      countSourceNote: form.countSourceNote.trim() || undefined,
    }
    const mode = formMode
    startTransition(async () => {
      const result =
        mode?.kind === 'supersede'
          ? await supersedeAggregationDeclaration(mode.previousId, input)
          : await createAggregationDeclaration(input)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setFormMode(null)
      setForm(EMPTY_FORM)
      await refresh()
    })
  }

  function handleVerify(id: string) {
    setError(null)
    startTransition(async () => {
      const result = await verifyAggregationDeclaration(id)
      if (!result.ok) {
        setError(result.message)
        return
      }
      await refresh()
    })
  }

  function handleRevoke(id: string) {
    setError(null)
    startTransition(async () => {
      const result = await revokeAggregationDeclaration(id, revokeReason.trim() || undefined)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setConfirmingRevokeId(null)
      setRevokeReason('')
      await refresh()
    })
  }

  function openCreateForm() {
    setForm(EMPTY_FORM)
    setError(null)
    setFormMode({ kind: 'create' })
  }

  function openSupersedeForm(item: EntityDeclarationHistoryItem) {
    setForm({
      sensitiveCategory: item.sensitiveCategory,
      groupSize: String(item.groupSize),
      dimensions: item.dimensions as AggregationDimension[],
      countSourceType: item.countSourceType,
      countSourceId: item.countSourceId ?? '',
      countSourceNote: '',
    })
    setError(null)
    setFormMode({ kind: 'supersede', previousId: item.id })
  }

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-muted/20 p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground">Declaraciones de agregación sensible (menores / salud)</p>
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="text-[11px] text-muted-foreground underline hover:opacity-70"
        >
          {showHistory ? 'Ocultar historial' : 'Ver historial'}
        </button>
      </div>

      {activeItems.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {activeItems.map((item) => {
            const badge = STATUS_BADGE[item.verificationStatus]
            return (
              <Badge key={item.id} variant={badge.variant} title={`${CATEGORY_LABEL[item.sensitiveCategory]} · grupo: ${item.groupSize}`}>
                {CATEGORY_LABEL[item.sensitiveCategory]} · {badge.label} · n={item.groupSize}
              </Badge>
            )
          })}
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          Sin declaración vigente. Cualquier mención de datos de menores o de salud en este resultado se bloquea para Stella hasta que un
          administrador la declare y verifique como agregado (mínimo {MINIMUM_SENSITIVE_GROUP_SIZE} personas).
        </p>
      )}

      {showHistory && (
        <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
          {items.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">Sin historial.</p>
          ) : (
            items.map((item) => {
              const badge = STATUS_BADGE[item.verificationStatus]
              return (
                <div key={item.id} className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                  <span>{CATEGORY_LABEL[item.sensitiveCategory]}</span>
                  <span>n={item.groupSize} ({item.groupSizeBucket})</span>
                  {item.dimensions.length > 0 && (
                    <span>dims: {item.dimensions.map((d) => DIMENSION_LABEL[d as AggregationDimension] ?? d).join(', ')}</span>
                  )}
                  {hasActorFields(item) && (
                    <span>
                      declarada {new Date(item.createdAt).toLocaleDateString()}
                      {item.verifiedAt ? ` · verificada ${new Date(item.verifiedAt).toLocaleDateString()}` : ''}
                      {item.revokedAt ? ` · revocada ${new Date(item.revokedAt).toLocaleDateString()}` : ''}
                    </span>
                  )}

                  {canVerifyOrRevoke && item.verificationStatus === 'pending' && (
                    <button
                      type="button"
                      onClick={() => handleVerify(item.id)}
                      disabled={isPending}
                      className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      Verificar
                    </button>
                  )}
                  {canVerifyOrRevoke && (item.verificationStatus === 'pending' || item.verificationStatus === 'verified') && (
                    confirmingRevokeId === item.id ? (
                      <span className="flex items-center gap-1">
                        <input
                          value={revokeReason}
                          onChange={(e) => setRevokeReason(e.target.value)}
                          placeholder="Motivo (estructural, sin datos sensibles)"
                          maxLength={140}
                          className="h-6 w-48 rounded border border-input bg-background px-1 text-[11px]"
                        />
                        <button
                          type="button"
                          onClick={() => handleRevoke(item.id)}
                          disabled={isPending}
                          className="rounded border border-danger bg-background px-1.5 py-0.5 text-danger hover:bg-danger/10 disabled:opacity-50"
                        >
                          Confirmar revocación
                        </button>
                        <button
                          type="button"
                          onClick={() => { setConfirmingRevokeId(null); setRevokeReason('') }}
                          className="text-muted-foreground underline"
                        >
                          Cancelar
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingRevokeId(item.id)}
                        disabled={isPending}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground hover:bg-muted disabled:opacity-50"
                      >
                        Revocar
                      </button>
                    )
                  )}
                  {canCreateOrSupersede && item.verificationStatus === 'verified' && (
                    <button
                      type="button"
                      onClick={() => openSupersedeForm(item)}
                      disabled={isPending}
                      className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      Sustituir
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {canCreateOrSupersede && !formMode && (
        <button
          type="button"
          onClick={openCreateForm}
          className="mt-2 h-7 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground hover:bg-muted"
        >
          Declarar agregado
        </button>
      )}

      {formMode && (
        <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-background p-2">
          <p className="text-[11px] font-medium text-foreground">
            {formMode.kind === 'supersede' ? 'Sustituir declaración' : 'Nueva declaración'}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-32">
              <label className="block text-[11px] text-muted-foreground">Categoría</label>
              <Select
                aria-label="Categoría sensible"
                value={form.sensitiveCategory}
                onChange={(e) => setForm((f) => ({ ...f, sensitiveCategory: e.target.value as DeclarationSensitiveCategory }))}
                className="h-8 text-xs"
              >
                {(Object.keys(CATEGORY_LABEL) as DeclarationSensitiveCategory[]).map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
                ))}
              </Select>
            </div>
            <div className="w-28">
              <label className="block text-[11px] text-muted-foreground">Tamaño de grupo</label>
              <input
                type="number"
                min={1}
                value={form.groupSize}
                onChange={(e) => setForm((f) => ({ ...f, groupSize: e.target.value }))}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                placeholder={`mín. ${MINIMUM_SENSITIVE_GROUP_SIZE}`}
              />
            </div>
            <div className="w-44">
              <label className="block text-[11px] text-muted-foreground">Fuente del conteo</label>
              <Select
                aria-label="Fuente del conteo"
                value={form.countSourceType}
                onChange={(e) => setForm((f) => ({ ...f, countSourceType: e.target.value as CountSourceType }))}
                className="h-8 text-xs"
              >
                {ALLOWED_COUNT_SOURCE_TYPES.map((s) => (
                  <option key={s} value={s}>{COUNT_SOURCE_LABEL[s]}</option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <p className="text-[11px] text-muted-foreground">
              Dimensiones (máx. {MAX_AGGREGATION_DIMENSIONS}) — describe la ESTRUCTURA del agregado, nunca un valor real
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              {ALLOWED_AGGREGATION_DIMENSIONS.map((dim) => (
                <label key={dim} className="flex items-center gap-1 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    checked={form.dimensions.includes(dim)}
                    onChange={() => toggleDimension(dim)}
                    disabled={!form.dimensions.includes(dim) && form.dimensions.length >= MAX_AGGREGATION_DIMENSIONS}
                  />
                  {DIMENSION_LABEL[dim]}
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <div className="w-48">
              <label className="block text-[11px] text-muted-foreground">Referencia estructural (opcional, ej. ID de indicador)</label>
              <input
                value={form.countSourceId}
                onChange={(e) => setForm((f) => ({ ...f, countSourceId: e.target.value }))}
                maxLength={100}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              />
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-[11px] text-muted-foreground">
                Nota estructural (opcional, sin nombres, edades, diagnósticos ni testimonios)
              </label>
              <input
                value={form.countSourceNote}
                onChange={(e) => setForm((f) => ({ ...f, countSourceNote: e.target.value }))}
                maxLength={140}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSubmitForm}
              disabled={isPending || !form.groupSize}
              className="h-8 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {formMode.kind === 'supersede' ? 'Sustituir' : 'Declarar'}
            </button>
            <button
              type="button"
              onClick={() => { setFormMode(null); setError(null) }}
              disabled={isPending}
              className="h-8 rounded-md border border-border bg-background px-3 text-xs text-foreground hover:bg-muted disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  )
}

'use client'
// components/taxonomy/OutcomeTaxonomyMapper.tsx
// Fase 3 — per-outcome crosswalk editor. Shows the outcome's mapped standard
// codes (grouped by catalog) and, for editors, a control to add/remove mappings.
// A mapping is a comparability reference, never a certification of equivalence.

import { useState, useTransition } from 'react'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { X } from 'lucide-react'
import {
  createOutcomeMappingAction,
  deleteOutcomeMappingAction,
} from '@/app/actions/taxonomy'
import type { CatalogWithCodes, OutcomeMappingView } from '@/lib/taxonomies/service'

const CONFIDENCE_LABEL: Record<string, string> = { low: 'Baja', medium: 'Media', high: 'Alta' }

interface Props {
  projectId: string
  outcomeId: string
  catalogs: CatalogWithCodes[]
  mappings: OutcomeMappingView[]
  canEdit: boolean
}

export function OutcomeTaxonomyMapper({ projectId, outcomeId, catalogs, mappings, canEdit }: Props) {
  const [catalogId, setCatalogId] = useState('')
  const [codeId, setCodeId] = useState('')
  const [confidence, setConfidence] = useState<'low' | 'medium' | 'high'>('medium')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const selectedCatalog = catalogs.find((c) => c.id === catalogId)

  function handleAdd() {
    if (!codeId) return
    setError(null)
    startTransition(async () => {
      try {
        await createOutcomeMappingAction(projectId, {
          outcomeId,
          taxonomyCodeId: codeId,
          mappingConfidence: confidence,
        })
        setCatalogId('')
        setCodeId('')
        setConfidence('medium')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo crear el mapeo.')
      }
    })
  }

  function handleRemove(mappingId: string) {
    setError(null)
    startTransition(async () => {
      try {
        await deleteOutcomeMappingAction(projectId, mappingId)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo eliminar el mapeo.')
      }
    })
  }

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-muted/20 p-2">
      <p className="text-xs font-medium text-foreground">Estándares de referencia</p>

      {mappings.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {mappings.map((m) => (
            <Badge
              key={m.id}
              variant="info"
              className="flex items-center gap-1"
              title={`${m.catalogName} · Confianza del mapeo: ${CONFIDENCE_LABEL[m.mappingConfidence]}`}
            >
              <span>{m.code}</span>
              <span className="text-[10px] opacity-70">{m.label}</span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => handleRemove(m.id)}
                  disabled={isPending}
                  aria-label={`Quitar ${m.code}`}
                  className="ml-0.5 rounded hover:opacity-70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          Sin mapeos. El mapeo es una referencia de comparabilidad, no una certificación.
        </p>
      )}

      {canEdit && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="w-32">
            <label className="block text-[11px] text-muted-foreground">Catálogo</label>
            <Select
              aria-label="Catálogo"
              value={catalogId}
              onChange={(e) => {
                setCatalogId(e.target.value)
                setCodeId('')
              }}
              className="h-8 text-xs"
            >
              <option value="">—</option>
              {catalogs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-48">
            <label className="block text-[11px] text-muted-foreground">Código</label>
            <Select
              aria-label="Código estándar"
              value={codeId}
              onChange={(e) => setCodeId(e.target.value)}
              disabled={!selectedCatalog}
              className="h-8 text-xs"
            >
              <option value="">—</option>
              {selectedCatalog?.codes.map((code) => (
                <option key={code.id} value={code.id}>
                  {code.code} — {code.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-24">
            <label className="block text-[11px] text-muted-foreground">Confianza</label>
            <Select
              aria-label="Confianza del mapeo"
              value={confidence}
              onChange={(e) => setConfidence(e.target.value as 'low' | 'medium' | 'high')}
              className="h-8 text-xs"
            >
              <option value="low">Baja</option>
              <option value="medium">Media</option>
              <option value="high">Alta</option>
            </Select>
          </div>
          <button
            type="button"
            onClick={handleAdd}
            disabled={isPending || !codeId}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            Mapear
          </button>
        </div>
      )}

      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  )
}

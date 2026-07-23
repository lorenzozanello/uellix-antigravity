import React from 'react'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { listProjectsForCurrentOrganization } from '@/lib/projects/service'
import { listEvidenceForOrganizationWithProject } from '@/lib/pipeline/evidence'
import Link from 'next/link'
import { Filter, ShieldCheck } from 'lucide-react'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/states/EmptyState'

const EVIDENCE_STATUS: Record<
  string,
  { variant: 'neutral' | 'warning' | 'info' | 'success' | 'danger'; label: string }
> = {
  draft: { variant: 'neutral', label: 'Borrador' },
  under_review: { variant: 'info', label: 'En revisión' },
  approved: { variant: 'success', label: 'Aprobado' },
  rejected: { variant: 'danger', label: 'Rechazado' },
  archived: { variant: 'neutral', label: 'Archivado' },
}

const EVIDENCE_TYPE: Record<
  string,
  { variant: 'neutral' | 'info'; label: string }
> = {
  file: { variant: 'neutral', label: 'Archivo' },
  url: { variant: 'info', label: 'URL' },
  text: { variant: 'neutral', label: 'Texto' },
}

export default async function TrustCenterPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string; projectId?: string }>
}) {
  const { organization } = await requireOrganizationAccess()
  const resolvedSearchParams = await searchParams

  const orgProjects = await listProjectsForCurrentOrganization()

  const evidences = await listEvidenceForOrganizationWithProject()

  const statusFilter = resolvedSearchParams.status || ''
  const typeFilter = resolvedSearchParams.type || ''
  const projectFilter = resolvedSearchParams.projectId || ''

  const filteredEvidences = evidences.filter((ev) => {
    if (statusFilter && ev.status !== statusFilter) return false
    if (typeFilter && ev.type !== typeFilter) return false
    if (projectFilter && ev.projectId !== projectFilter) return false
    return true
  })

  const activeFilterCount = [statusFilter, typeFilter, projectFilter].filter(Boolean).length

  return (
    <div className="space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#fc4c0d]/10 text-[#fc4c0d]"
          aria-hidden="true"
        >
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Centro de confianza</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Repositorio de evidencia lista para auditoría de{' '}
            <span className="font-medium text-foreground">{organization.name}</span>. Cada
            elemento de evidencia lleva un hash de contenido SHA-256 y requiere revisión humana
            antes de usarse en reportes externos.
          </p>
        </div>
      </div>

      {/* Methodology notice */}
      <div
        role="note"
        className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      >
        <span className="font-medium text-foreground">Aviso de auditoría: </span>
        La evidencia registrada aquí no constituye certificación automática ni aprobación de
        auditoría. Cada elemento provee una{' '}
        <span className="font-medium text-foreground">base de evidencia trazable</span> para
        revisión metodológica y requiere validación humana antes de su uso externo.
      </div>

      {/* Filters */}
      <form
        method="GET"
        action="/app/trust-center"
        className="rounded-lg border border-border bg-muted/30 p-4"
        aria-label="Filtrar evidencia"
      >
        <div className="mb-3 flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Filtros
          </span>
          {activeFilterCount > 0 && (
            <span
              className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#fc4c0d] text-[10px] font-bold text-white"
              aria-label={`${activeFilterCount} filtro${activeFilterCount !== 1 ? 's' : ''} activo${activeFilterCount !== 1 ? 's' : ''}`}
            >
              {activeFilterCount}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
          <div>
            <label htmlFor="projectId" className="block text-xs font-medium text-foreground">
              Proyecto
            </label>
            <Select
              id="projectId"
              name="projectId"
              defaultValue={projectFilter}
              className="mt-1"
            >
              <option value="">Todos los proyectos</option>
              {orgProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label htmlFor="status" className="block text-xs font-medium text-foreground">
              Estado de revisión
            </label>
            <Select
              id="status"
              name="status"
              defaultValue={statusFilter}
              className="mt-1"
            >
              <option value="">Todos los estados</option>
              <option value="draft">Borrador</option>
              <option value="under_review">En revisión</option>
              <option value="approved">Aprobado</option>
              <option value="rejected">Rechazado</option>
              <option value="archived">Archivado</option>
            </Select>
          </div>

          <div>
            <label htmlFor="type" className="block text-xs font-medium text-foreground">
              Tipo de evidencia
            </label>
            <Select
              id="type"
              name="type"
              defaultValue={typeFilter}
              className="mt-1"
            >
              <option value="">Todos los tipos</option>
              <option value="file">Archivo</option>
              <option value="url">URL</option>
              <option value="text">Texto / Declaración</option>
            </Select>
          </div>

          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="inline-flex items-center rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
            >
              Aplicar
            </button>
            <Link
              href="/app/trust-center"
              className="inline-flex items-center rounded-md border border-border bg-background px-4 py-1.5 text-sm font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Limpiar
            </Link>
          </div>
        </div>
      </form>

      {/* Result count */}
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {filteredEvidences.length === evidences.length
          ? `${evidences.length} elemento${evidences.length !== 1 ? 's' : ''} de evidencia`
          : `${filteredEvidences.length} de ${evidences.length} elementos de evidencia`}
        {activeFilterCount > 0 ? ' coinciden con los filtros actuales' : ''}
      </p>

      {/* Evidence table */}
      {filteredEvidences.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-6 w-6 text-neutral-500" />}
          title="No se encontró evidencia"
          description={
            activeFilterCount > 0
              ? 'Ningún elemento coincide con los filtros seleccionados. Ajusta o limpia los filtros para ver toda la evidencia.'
              : 'Aún no se ha registrado evidencia trazable para esta organización.'
          }
        />
      ) : (
        <section aria-labelledby="evidence-table-heading">
          <h2 id="evidence-table-heading" className="sr-only">
            Elementos de evidencia
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Proyecto</TableHead>
                <TableHead>Título de evidencia</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Hash SHA-256</TableHead>
                <TableHead>Estado de revisión</TableHead>
                <TableHead>Registrado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEvidences.map((ev) => {
                const statusConfig =
                  EVIDENCE_STATUS[ev.status] ?? {
                    variant: 'neutral' as const,
                    label: ev.status,
                  }
                const typeConfig =
                  EVIDENCE_TYPE[ev.type] ?? { variant: 'neutral' as const, label: ev.type }
                return (
                  <TableRow key={ev.id}>
                    <TableCell className="font-medium text-foreground max-w-[140px]">
                      <span className="line-clamp-1">{ev.projectName}</span>
                    </TableCell>
                    <TableCell className="max-w-[200px]">
                      <span className="line-clamp-2 text-sm">{ev.title}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={typeConfig.variant}>{typeConfig.label}</Badge>
                    </TableCell>
                    <TableCell>
                      {ev.contentHash ? (
                        <code
                          className="text-xs text-muted-foreground tabular-nums"
                          style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
                          title={ev.contentHash}
                          aria-label={`Hash SHA-256: ${ev.contentHash.slice(0, 12)} (truncado)`}
                        >
                          {ev.contentHash.slice(0, 12)}…
                        </code>
                      ) : (
                        <span className="text-xs text-muted-foreground/60" aria-label="Sin hash">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(ev.createdAt).toLocaleDateString('es-MX', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  )
}

// components/portfolios/ComparisonTable.tsx
// PORTFOLIO_PF3_EXECUTION_AUTHORITY_v1.0.0.json — props-only presentational
// component. COMPONENTS_ENTRYPOINT_DISCIPLINE: no db/client reach, no 'use
// server', no server-side data fetch. All reads live in
// lib/portfolios/read-model.ts and are passed in by the shared page.
//
// Type-only imports from lib/portfolios/read-model and lib/portfolios/analytics
// are permitted (tests/fixtures/entrypoint-mutants/app/components/CleanWidget.tsx
// establishes the precedent) — they never constitute a runtime reach.

import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { ProjectRunSummary } from '@/lib/portfolios/analytics'
import type { PortfolioComparisonPage } from '@/lib/portfolios/read-model'

const usdFormatter = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const EXCLUSION_LABEL: Record<string, string> = {
  no_calculated_run: 'sin cálculo SROI',
  no_approved_run: 'sin revisión aprobada',
}

function selectionCell(row: ProjectRunSummary) {
  if (row.selection === 'approved' && row.run) {
    return {
      ratio: row.run.sroiRatio === null ? '—' : `${row.run.sroiRatio.toFixed(2)}×`,
      investment: row.run.totalInvestment === null ? '—' : usdFormatter.format(row.run.totalInvestment),
      net: usdFormatter.format(row.run.netSocialValue),
      badge: null as string | null,
    }
  }
  return {
    ratio: '—',
    investment: '—',
    net: '—',
    badge: EXCLUSION_LABEL[row.selection] ?? row.selection,
  }
}

function buildPageHref(basePath: string, page: number): string {
  return page <= 1 ? basePath : `${basePath}?page=${page}`
}

export function ComparisonTable({
  basePath,
  comparisonPage,
}: {
  /** The portfolio detail page's own path, used to build page-link hrefs. */
  basePath: string
  comparisonPage: PortfolioComparisonPage
}) {
  const { rows, page, totalPages, totalMembers, pageSize } = comparisonPage

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Comparación de proyectos</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Mostrando {rows.length === 0 ? 0 : (page - 1) * pageSize + 1}–{(page - 1) * pageSize + rows.length} de{' '}
          {totalMembers} proyecto{totalMembers === 1 ? '' : 's'}. El agregado del portafolio siempre cubre la
          totalidad de los miembros, no solo esta página.
        </p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Este portafolio no tiene proyectos que comparar.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                  <th className="py-2 pr-3">Proyecto</th>
                  <th className="py-2 pr-3">SROI</th>
                  <th className="py-2 pr-3">Valor social neto</th>
                  <th className="py-2 pr-3">Inversión</th>
                  <th className="py-2 pr-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const cell = selectionCell(row)
                  return (
                    <tr key={row.projectId} className="border-b border-border/60 last:border-0">
                      <td className="py-2 pr-3 font-medium text-foreground">{row.projectName}</td>
                      <td className="py-2 pr-3 tabular-nums">{cell.ratio}</td>
                      <td className="py-2 pr-3 tabular-nums">{cell.net}</td>
                      <td className="py-2 pr-3 tabular-nums">{cell.investment}</td>
                      <td className="py-2 pr-3">
                        {cell.badge ? <Badge variant="neutral">{cell.badge}</Badge> : <Badge variant="success">incluido</Badge>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <nav className="mt-3 flex items-center justify-between text-xs text-muted-foreground" aria-label="Paginación de comparación">
            <span>
              Página {page} de {totalPages}
            </span>
            <div className="flex gap-2">
              {page > 1 && (
                <Link
                  href={buildPageHref(basePath, page - 1)}
                  className="rounded border border-border px-2 py-1 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Anterior
                </Link>
              )}
              {page < totalPages && (
                <Link
                  href={buildPageHref(basePath, page + 1)}
                  className="rounded border border-border px-2 py-1 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Siguiente
                </Link>
              )}
            </div>
          </nav>
        )}
      </CardContent>
    </Card>
  )
}

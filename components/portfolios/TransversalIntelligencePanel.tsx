// components/portfolios/TransversalIntelligencePanel.tsx
// PORTFOLIO_PF3_EXECUTION_AUTHORITY_v1.0.0.json — props-only presentational
// component rendering TI-1..TI-8. TI-3's dispersion statistics are rendered
// under their own labels, never as — and never near — the consolidated
// portfolio SROI ratio (POS_AGG_5_RESTATED). Type-only imports only.

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { PortfolioTransversalIntelligence } from '@/lib/portfolios/intelligence'

function formatRatio(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}×`
}

export function TransversalIntelligencePanel({
  intelligence,
}: {
  intelligence: PortfolioTransversalIntelligence
}) {
  const { ti1, ti2, ti3, ti4, ti5, ti6, ti7, ti8 } = intelligence

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Inteligencia transversal</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Ocho hechos deterministas derivados de filas persistidas. Ninguno es generado, ajustado o clasificado
          por Stella — Stella puede explicarlos, no producirlos.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <dt className="text-xs font-medium text-muted-foreground">TI-1 · Sin corrida aprobada</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{ti1.projectIds.length}</dd>
          </div>
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <dt className="text-xs font-medium text-muted-foreground">TI-2 · Aprobada sin reporte</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{ti2.projectIds.length}</dd>
          </div>
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <dt className="text-xs font-medium text-muted-foreground">TI-8 · Evidencia posterior a la corrida</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{ti8.projectIds.length}</dd>
          </div>
        </dl>

        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <dt className="text-xs font-medium text-muted-foreground">
            TI-3 · Dispersión de ratios individuales (nunca el ratio consolidado del portafolio)
          </dt>
          <dd className="mt-1 flex gap-4 text-sm tabular-nums text-foreground">
            <span>mín {formatRatio(ti3.minimum)}</span>
            <span>mediana {formatRatio(ti3.median)}</span>
            <span>máx {formatRatio(ti3.maximum)}</span>
          </dd>
          <dd className="mt-1 text-[11px] text-muted-foreground">sobre {ti3.ratioCount} proyectos incluidos</dd>
        </div>

        {Object.keys(ti4.byReason).length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-foreground">TI-4 · Motivos de exclusión</h4>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {Object.entries(ti4.byReason).map(([reason, count]) => (
                <li key={reason}>
                  {reason}: {count}
                </li>
              ))}
            </ul>
          </div>
        )}

        {ti5.byProject.some((p) => p.uncoveredOutcomeIds.length > 0) && (
          <div>
            <h4 className="text-sm font-medium text-foreground">TI-5 · Resultados sin evidencia aprobada</h4>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {ti5.byProject
                .filter((p) => p.uncoveredOutcomeIds.length > 0)
                .map((p) => (
                  <li key={p.projectId}>
                    {p.projectName} — {p.uncoveredOutcomeIds.length} resultado{p.uncoveredOutcomeIds.length === 1 ? '' : 's'} sin cubrir
                  </li>
                ))}
            </ul>
          </div>
        )}

        {ti6.sharedVersions.length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-foreground">TI-6 · Versiones de proxy compartidas</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {ti6.sharedVersions.length} versión{ti6.sharedVersions.length === 1 ? '' : 'es'} de proxy usada
              {ti6.sharedVersions.length === 1 ? '' : 's'} por más de un proyecto del portafolio.
            </p>
          </div>
        )}

        {Object.keys(ti7.byReason).length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-foreground">TI-7 · No monetizados por motivo</h4>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {Object.entries(ti7.byReason)
                .filter(([, count]) => count > 0)
                .map(([reason, count]) => (
                  <li key={reason}>
                    {reason}: {count}
                  </li>
                ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

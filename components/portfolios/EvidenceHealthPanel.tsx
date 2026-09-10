// components/portfolios/EvidenceHealthPanel.tsx
// PORTFOLIO_PF3_EXECUTION_AUTHORITY_v1.0.0.json — props-only presentational
// component rendering EH-1..EH-6. Every ratio shown carries its numerator and
// denominator in the same view — no bare percentage, no composite score (see
// EVIDENCE_HEALTH.prohibitions). Type-only imports only — see
// COMPONENTS_ENTRYPOINT_DISCIPLINE.

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { PortfolioEvidenceHealth } from '@/lib/portfolios/evidence-health'

function ratioLabel(numerator: number, denominator: number): string {
  return denominator === 0 ? 'sin datos' : `${numerator} de ${denominator}`
}

export function EvidenceHealthPanel({ evidenceHealth }: { evidenceHealth: PortfolioEvidenceHealth }) {
  const { eh1, eh2, eh3, eh4, eh5, eh6 } = evidenceHealth

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Salud de evidencia</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Seis indicadores independientes, cada uno con su propio numerador y denominador. No se calcula ni
          muestra un puntaje único de salud.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h4 className="text-sm font-medium text-foreground">EH-1 · Evidencia por estado y proyecto</h4>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {eh1.byProject.map((p) => (
              <li key={p.projectId}>
                <a href={p.drillUrl} className="text-foreground hover:underline">
                  {p.projectName}
                </a>{' '}
                — {p.denominator} evidencia{p.denominator === 1 ? '' : 's'}: {p.counts.approved} aprobada
                {p.counts.approved === 1 ? '' : 's'}, {p.counts.under_review} en revisión, {p.counts.draft}{' '}
                borrador{p.counts.draft === 1 ? '' : 'es'}, {p.counts.rejected} rechazada
                {p.counts.rejected === 1 ? '' : 's'}, {p.counts.archived} archivada{p.counts.archived === 1 ? '' : 's'}.
              </li>
            ))}
            {eh1.byProject.length === 0 && <li>Sin proyectos.</li>}
          </ul>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <dt className="text-xs font-medium text-muted-foreground">EH-2 · Resultados con evidencia aprobada</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {ratioLabel(eh2.numerator, eh2.denominator)}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <dt className="text-xs font-medium text-muted-foreground">EH-3 · Determinaciones de suficiencia</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5 text-xs">
              <Badge variant="success">{eh3.sufficient} suficiente{eh3.sufficient === 1 ? '' : 's'}</Badge>
              <Badge variant="danger">{eh3.insufficient} insuficiente{eh3.insufficient === 1 ? '' : 's'}</Badge>
              <Badge variant="neutral">{eh3.undetermined} sin determinar</Badge>
            </dd>
            <dd className="mt-1 text-[11px] text-muted-foreground">sobre {eh3.denominator} resultados activos</dd>
          </div>
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <dt className="text-xs font-medium text-muted-foreground">EH-4 · Disposiciones de monetización</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {eh4.monetized} monetizada{eh4.monetized === 1 ? '' : 's'} / {eh4.notMonetized} no monetizada
              {eh4.notMonetized === 1 ? '' : 's'}
            </dd>
            <dd className="mt-1 text-[11px] text-muted-foreground">sobre {eh4.denominator} disposiciones registradas</dd>
          </div>
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <dt className="text-xs font-medium text-muted-foreground">EH-5 · Versiones de proxy aprobadas</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {ratioLabel(eh5.numerator, eh5.denominator)}
            </dd>
            {eh5.unbound > 0 && (
              <dd className="mt-1 text-[11px] text-yellow-700 dark:text-yellow-500">
                +{eh5.unbound} asignación{eh5.unbound === 1 ? '' : 'es'} sin versión vinculada (fuera del
                denominador)
              </dd>
            )}
          </div>
        </div>

        <div>
          <h4 className="text-sm font-medium text-foreground">EH-6 · Evidencia posterior a la corrida seleccionada</h4>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {eh6.byProject
              .filter((p) => p.count > 0)
              .map((p) => (
                <li key={p.projectId}>
                  {p.projectName} — {p.count} de {p.denominator} evidencias actualizadas después del cálculo
                </li>
              ))}
            {eh6.byProject.every((p) => p.count === 0) && <li>Ningún proyecto tiene evidencia posterior a su corrida.</li>}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}

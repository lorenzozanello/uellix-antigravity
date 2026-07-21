import { notFound } from 'next/navigation';
import { getPublicVerifiedReport } from '@/lib/reports/public-verify';
import { ShieldCheck, Download, FileText, Calendar, Building2, BarChart4 } from 'lucide-react';

export default async function PublicVerificationPage({
  params
}: {
  params: Promise<{ hash: string }>
}) {
  const { hash } = await params;
  const data = await getPublicVerifiedReport(hash);

  if (!data) {
    notFound();
  }

  const { report, project, organization, run } = data;
  const lockedAt = report.lockedAt ? new Date(report.lockedAt).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

  return (
    <div className="flex-1 bg-slate-50 py-12">
      <div className="max-w-3xl mx-auto px-6">
        {/* Verification Header */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-6">
          <div className="bg-green-600 px-6 py-8 text-center">
            <ShieldCheck className="w-16 h-16 text-white mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white mb-2">Reporte Audit-Ready Verificado</h1>
            <p className="text-green-100 text-sm">
              Este reporte está registrado y bloqueado en la plataforma Uellix para revisión externa.
            </p>
          </div>

          <div className="p-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1.5"><FileText className="w-3.5 h-3.5"/> Título del Reporte</p>
                <p className="font-semibold text-slate-900">{report.title}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5"/> Organización Emisora</p>
                <p className="font-semibold text-slate-900">{organization.name}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1.5"><BarChart4 className="w-3.5 h-3.5"/> Proyecto Analizado</p>
                <p className="font-semibold text-slate-900">{project.name}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5"/> Fecha de Emisión</p>
                <p className="font-semibold text-slate-900">{lockedAt}</p>
              </div>
            </div>

            <div className="bg-slate-50 rounded-xl p-6 border border-slate-100 mb-8">
              <h3 className="text-sm font-bold text-slate-900 mb-4">Métricas Principales</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-slate-500 mb-1">Inversión Total</p>
                  <p className="font-semibold text-slate-900">{parseFloat(run.totalInvestment || '0').toLocaleString('es-CO')} {run.currency || 'USD'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">Valor Bruto</p>
                  <p className="font-semibold text-slate-900">{parseFloat(run.grossSocialValue || '0').toLocaleString('es-CO')} {run.currency || 'USD'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">Valor Neto</p>
                  <p className="font-semibold text-green-700">{parseFloat(run.netSocialValue || '0').toLocaleString('es-CO')} {run.currency || 'USD'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">Ratio SROI</p>
                  <p className="font-bold text-indigo-700">{run.sroiRatio}:1</p>
                </div>
              </div>
            </div>

            <div className="text-center">
              <a
                href={`/verify/${hash}/pdf`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-[#FF6A00] hover:bg-[#E65C00] text-white font-semibold rounded-lg shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#FF6A00]"
              >
                <Download className="w-5 h-5" />
                Descargar Reporte PDF
              </a>
              <p className="text-xs text-slate-500 mt-3">
                El PDF contiene el rastro metodológico completo, evidencias y anexos auditables.
              </p>
            </div>
          </div>
        </div>

        {/* Audit Details */}
        <div className="text-center">
          <p className="text-xs text-slate-400">
            Verificación: <span className="font-mono">{hash}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

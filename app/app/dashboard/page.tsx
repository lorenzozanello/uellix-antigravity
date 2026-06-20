import React from "react";

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Panel Organizacional</h1>
        <p className="text-slate-400 mt-2">Resumen consolidado del impacto social y preparación de evidencias.</p>
      </div>

      {/* Grid of Stats */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <div className="bg-slate-900 border border-slate-800 overflow-hidden rounded-lg p-5">
          <div className="text-sm font-medium text-slate-400 truncate">Proyectos Activos</div>
          <div className="mt-1 text-3xl font-semibold text-white">3</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 overflow-hidden rounded-lg p-5">
          <div className="text-sm font-medium text-slate-400 truncate">Evidencias Hasheadas</div>
          <div className="mt-1 text-3xl font-semibold text-teal-400">12</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 overflow-hidden rounded-lg p-5">
          <div className="text-sm font-medium text-slate-400 truncate">Readiness Score Promedio</div>
          <div className="mt-1 text-3xl font-semibold text-cyan-400">74%</div>
        </div>
      </div>

      {/* Main Sections */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-6">
        <h3 className="text-lg font-medium text-white mb-4">Actividad metodológica reciente</h3>
        <div className="space-y-4">
          <div className="flex justify-between items-center py-3 border-b border-slate-800">
            <div>
              <p className="text-sm font-medium text-white">Proyecto Educativo Territorial</p>
              <p className="text-xs text-slate-400">Nueva evidencia de asistencia cargada por Analyst</p>
            </div>
            <span className="text-xs text-slate-500">Hace 2 horas</span>
          </div>
          <div className="flex justify-between items-center py-3 border-b border-slate-800">
            <div>
              <p className="text-sm font-medium text-white">Inclusión de Jóvenes en Tecnología</p>
              <p className="text-xs text-slate-400">Proxy &quot;Costo de Capacitación Técnica&quot; aprobado por OrgAdmin</p>
            </div>
            <span className="text-xs text-slate-500">Hace 1 día</span>
          </div>
        </div>
      </div>
    </div>
  );
}

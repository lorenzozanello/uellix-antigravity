import React from "react";
import Link from "next/link";
import { getAdminStats } from "@/lib/admin/stats";

export default async function AdminPage() {
  const stats = await getAdminStats();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Consola del Sistema</h1>
        <p className="text-slate-400 mt-2">Gestión y control de arrendatarios, configuraciones y auditoría global.</p>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
          <div className="text-sm font-medium text-slate-400 truncate">Total Organizaciones</div>
          <div className="mt-1 text-3xl font-semibold text-white">{stats.totalOrganizations}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
          <div className="text-sm font-medium text-slate-400 truncate">Total Usuarios</div>
          <div className="mt-1 text-3xl font-semibold text-white">{stats.totalUsers}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
          <div className="text-sm font-medium text-slate-400 truncate">Proxies Globales</div>
          <div className="mt-1 text-3xl font-semibold text-white">{stats.totalGlobalProxies}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
          <div className="text-sm font-medium text-slate-400 truncate">Logs de Auditoría</div>
          <div className="mt-1 text-3xl font-semibold text-white">{stats.totalAuditLogs.toLocaleString('es-MX')}</div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-6">
        <h3 className="text-lg font-medium text-white mb-4">Control del Sistema</h3>
        <p className="text-sm text-slate-400 mb-4">Funciones de mantenimiento, carga de proxies globales oficiales y auditoría de accesos SuperAdmin.</p>
        <div className="flex gap-4">
          <Link
            href="/admin/logs"
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 transition-colors"
          >
            Ver Logs Globales
          </Link>
          <Link
            href="/admin/proxies"
            className="rounded-md bg-slate-800 border border-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 transition-colors"
          >
            Gestionar Proxies Globales
          </Link>
        </div>
      </div>
    </div>
  );
}

import React from "react";

export default function ProjectsPage() {
  const projects = [
    {
      id: "proj-1",
      name: "Proyecto Educativo Territorial",
      status: "In Progress",
      readiness: 65,
      outcomes: 3,
    },
    {
      id: "proj-2",
      name: "Inclusión de Jóvenes en Tecnología",
      status: "Stella Review",
      readiness: 82,
      outcomes: 5,
    },
    {
      id: "proj-3",
      name: "Sostenibilidad de Micro-Emprendimientos",
      status: "Audit-Ready",
      readiness: 94,
      outcomes: 4,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Proyectos de Impacto</h1>
          <p className="text-slate-400 mt-2">Gestiona, evalúa y estructura tus análisis SROI.</p>
        </div>
        <button className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-teal-400 transition-colors">
          Nuevo proyecto
        </button>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-slate-800">
          <thead className="bg-slate-900/50">
            <tr>
              <th scope="col" className="px-6 py-3.5 text-left text-sm font-semibold text-slate-200">
                Nombre del proyecto
              </th>
              <th scope="col" className="px-6 py-3.5 text-left text-sm font-semibold text-slate-200">
                Estado
              </th>
              <th scope="col" className="px-6 py-3.5 text-left text-sm font-semibold text-slate-200">
                Outcomes
              </th>
              <th scope="col" className="px-6 py-3.5 text-left text-sm font-semibold text-slate-200">
                SROI Readiness
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 bg-slate-900/10">
            {projects.map((project) => (
              <tr key={project.id}>
                <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-white">
                  {project.name}
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-slate-400">
                  <span className="inline-flex items-center rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
                    {project.status}
                  </span>
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-slate-400">
                  {project.outcomes}
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm">
                  <span
                    className={`font-semibold ${
                      project.readiness >= 90
                        ? "text-teal-400"
                        : project.readiness >= 70
                        ? "text-cyan-400"
                        : "text-amber-400"
                    }`}
                  >
                    {project.readiness}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

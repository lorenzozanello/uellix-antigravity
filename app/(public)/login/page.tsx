import React from "react";
import Link from "next/link";

export default function LoginPage() {
  return (
    <div className="flex-1 flex flex-col justify-center items-center px-4 py-16 bg-slate-950">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-lg p-8 shadow-2xl">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold tracking-tight text-white">Ingresar a Uellix</h2>
          <p className="mt-2 text-sm text-slate-400">
            Estructura y defiende tu impacto social
          </p>
        </div>
        <div className="space-y-6">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-300">
              Correo electrónico
            </label>
            <div className="mt-1">
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="block w-full rounded-md border-0 bg-slate-800 py-2 text-white shadow-sm ring-1 ring-inset ring-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-inset focus:ring-teal-500 sm:text-sm sm:leading-6 px-3"
                placeholder="nombre@organizacion.com"
              />
            </div>
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-300">
              Contraseña
            </label>
            <div className="mt-1">
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="block w-full rounded-md border-0 bg-slate-800 py-2 text-white shadow-sm ring-1 ring-inset ring-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-inset focus:ring-teal-500 sm:text-sm sm:leading-6 px-3"
                placeholder="••••••••"
              />
            </div>
          </div>
          <div>
            <Link
              href="/app/dashboard"
              className="flex w-full justify-center rounded-md bg-teal-500 px-3 py-2 text-sm font-semibold leading-6 text-slate-950 shadow-sm hover:bg-teal-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-500 transition-colors text-center"
            >
              Iniciar sesión (Demo)
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

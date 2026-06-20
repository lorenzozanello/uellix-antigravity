import React from "react";
import Link from "next/link";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-white selection:bg-teal-500 selection:text-slate-950">
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-8">
              <Link href="/" className="text-xl font-bold tracking-tight text-teal-400">
                Uellix
              </Link>
            </div>
            <div className="flex items-center gap-4">
              <Link
                href="/login"
                className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
              >
                Iniciar sesión
              </Link>
              <Link
                href="/login"
                className="rounded-md bg-teal-500 px-3.5 py-1.5 text-sm font-semibold text-slate-950 shadow-sm hover:bg-teal-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-500 transition-all"
              >
                Comenzar gratis
              </Link>
            </div>
          </div>
        </div>
      </header>
      <main className="flex-1 flex flex-col">{children}</main>
      <footer className="border-t border-slate-900 bg-slate-950 py-8 text-center text-sm text-slate-500">
        <p>&copy; {new Date().getFullYear()} Uellix. Todos los derechos reservados.</p>
      </footer>
    </div>
  );
}

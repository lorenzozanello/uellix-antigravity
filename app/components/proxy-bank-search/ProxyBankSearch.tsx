'use client'

import { useState } from 'react'
import { Search } from 'lucide-react'

export function ProxyBankSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query || query.length < 3) return

    setIsSearching(true)
    setHasSearched(true)
    try {
      const res = await fetch(`/api/proxies/search?q=${encodeURIComponent(query)}`)
      if (res.ok) {
        const data = await res.json()
        setResults(data.results || [])
      }
    } catch (err) {
      console.error('Error searching proxies:', err)
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 mb-6">
      <h3 className="text-sm font-semibold text-white mb-2">Buscador de Banco Global de Proxies</h3>
      <p className="text-xs text-slate-400 mb-4">
        Encuentra proxies validados por la comunidad. Los proxies globales aparecerán automáticamente en el selector de asignación de resultados.
      </p>
      
      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
            <Search className="h-4 w-4 text-slate-500" />
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nombre, temática, descripción..."
            className="block w-full rounded-md border border-slate-700 bg-slate-950 py-2 pl-10 pr-3 text-sm text-white placeholder:text-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <button
          type="submit"
          disabled={isSearching || query.length < 3}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {isSearching ? 'Buscando...' : 'Buscar'}
        </button>
      </form>

      {hasSearched && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-slate-300 mb-3 uppercase tracking-wider">Resultados ({results.length})</h4>
          {results.length === 0 ? (
            <p className="text-sm text-slate-500 italic">No se encontraron proxies que coincidan con la búsqueda.</p>
          ) : (
            <div className="space-y-3">
              {results.map((p) => (
                <div key={p.id} className="rounded border border-slate-800 bg-slate-950 p-3">
                  <div className="flex justify-between items-start mb-1">
                    <h5 className="text-sm font-medium text-white">{p.name}</h5>
                    <div className="text-xs font-mono bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded border border-blue-900/50">
                      {p.value} {p.currency}
                    </div>
                  </div>
                  <p className="text-xs text-slate-400 line-clamp-2 mb-2">{p.description}</p>
                  <div className="flex gap-3 text-[10px] text-slate-500">
                    <span>Unidad: <strong className="text-slate-300">{p.unit}</strong></span>
                    <span>Año: <strong className="text-slate-300">{p.referenceYear}</strong></span>
                    {p.thematicArea && <span>Temática: <strong className="text-slate-300">{p.thematicArea}</strong></span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

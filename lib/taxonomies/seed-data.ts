// lib/taxonomies/seed-data.ts
// Fase 3 — seed reference data for interoperability catalogs. Deliberately
// conservative: ODS at the official 17-goal level and IRIS+ at its stable
// impact-category level. We do NOT invent specific IRIS+ metric IDs we can't
// verify — a wrong reference code would be worse than none (false equivalence).
// Adding GRI/ESG/TNFD later is pure data: append a catalog here + re-seed.

export type TaxonomySeedCode = {
  code: string
  label: string
  description?: string
}

export type TaxonomySeedCatalog = {
  code: string
  name: string
  version: string
  sourceUrl?: string
  codes: TaxonomySeedCode[]
}

// Official UN Sustainable Development Goals (Objetivos de Desarrollo Sostenible).
const ODS_GOALS: TaxonomySeedCode[] = [
  { code: 'ODS-1', label: 'Fin de la pobreza' },
  { code: 'ODS-2', label: 'Hambre cero' },
  { code: 'ODS-3', label: 'Salud y bienestar' },
  { code: 'ODS-4', label: 'Educación de calidad' },
  { code: 'ODS-5', label: 'Igualdad de género' },
  { code: 'ODS-6', label: 'Agua limpia y saneamiento' },
  { code: 'ODS-7', label: 'Energía asequible y no contaminante' },
  { code: 'ODS-8', label: 'Trabajo decente y crecimiento económico' },
  { code: 'ODS-9', label: 'Industria, innovación e infraestructura' },
  { code: 'ODS-10', label: 'Reducción de las desigualdades' },
  { code: 'ODS-11', label: 'Ciudades y comunidades sostenibles' },
  { code: 'ODS-12', label: 'Producción y consumo responsables' },
  { code: 'ODS-13', label: 'Acción por el clima' },
  { code: 'ODS-14', label: 'Vida submarina' },
  { code: 'ODS-15', label: 'Vida de ecosistemas terrestres' },
  { code: 'ODS-16', label: 'Paz, justicia e instituciones sólidas' },
  { code: 'ODS-17', label: 'Alianzas para lograr los objetivos' },
]

// IRIS+ impact categories (GIIN). Stable, thematic — used for comparability at
// the category level, not as specific metric assertions.
const IRIS_CATEGORIES: TaxonomySeedCode[] = [
  { code: 'IRIS-AGRICULTURE', label: 'Agricultura' },
  { code: 'IRIS-AIR', label: 'Aire' },
  { code: 'IRIS-BIODIVERSITY', label: 'Biodiversidad y ecosistemas' },
  { code: 'IRIS-CLIMATE', label: 'Clima' },
  { code: 'IRIS-DIVERSITY', label: 'Diversidad e inclusión' },
  { code: 'IRIS-EDUCATION', label: 'Educación' },
  { code: 'IRIS-EMPLOYMENT', label: 'Empleo' },
  { code: 'IRIS-ENERGY', label: 'Energía' },
  { code: 'IRIS-FINANCIAL', label: 'Servicios financieros' },
  { code: 'IRIS-HEALTH', label: 'Salud' },
  { code: 'IRIS-INFRASTRUCTURE', label: 'Infraestructura' },
  { code: 'IRIS-LAND', label: 'Tierra' },
  { code: 'IRIS-OCEANS', label: 'Océanos y zonas costeras' },
  { code: 'IRIS-POLLUTION', label: 'Contaminación' },
  { code: 'IRIS-REALESTATE', label: 'Bienes raíces' },
  { code: 'IRIS-WASTE', label: 'Residuos' },
  { code: 'IRIS-WATER', label: 'Agua' },
]

export const TAXONOMY_SEED: TaxonomySeedCatalog[] = [
  {
    code: 'ODS',
    name: 'Objetivos de Desarrollo Sostenible (ONU)',
    version: '2015',
    sourceUrl: 'https://www.un.org/sustainabledevelopment/es/',
    codes: ODS_GOALS,
  },
  {
    code: 'IRIS+',
    name: 'IRIS+ Categorías de Impacto (GIIN)',
    version: '5.3',
    sourceUrl: 'https://iris.thegiin.org/',
    codes: IRIS_CATEGORIES,
  },
]

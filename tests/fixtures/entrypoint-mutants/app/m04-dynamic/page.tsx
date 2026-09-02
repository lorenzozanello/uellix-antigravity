// FORM 4 — dynamic import: no static import statement carries the taint.
export default async function Page() {
  const service = await import('../../lib/service')
  const rows = await service.listThings()
  return <p>{rows.length}</p>
}

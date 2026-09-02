'use server'

import { redirect } from 'next/navigation'
import { AuthContextError } from '@/lib/auth/database-context'
import { rethrowNextControlFlow } from '@/lib/errors/next-control-flow'
import { revalidatePath } from 'next/cache'
import { createGlobalProxySource, createGlobalFinancialProxy, updateGlobalProxyReviewStatus, setGlobalProxyManualFxRate } from '@/lib/admin/proxies'
import { requireAdminAccess } from '@/lib/auth/session'
import { withSuperAdminDatabaseContext } from '@/lib/auth/database-context'

const PROXIES_PATH = '/admin/proxies'

function errorToSlug(message: string): string {
  const known: Record<string, string> = {
    'Not a global proxy — manage it from the owning organization': 'not_global',
    'Cannot approve without value': 'missing_fields',
    'Cannot approve without currency': 'missing_fields',
    'Cannot approve without unit': 'missing_fields',
    'Cannot approve without referenceYear': 'missing_fields',
    'Invalid status': 'invalid_status',
    'Proxy not found': 'not_found',
    'Cannot set an FX rate without value and currency': 'missing_fields',
    'USD proxies do not need an FX rate': 'fx_not_needed',
    'La tasa debe ser un número mayor a 0': 'invalid_rate',
    'Cannot approve a non-USD/COP proxy without a manual USD conversion': 'fx_rate_missing',
    'Cannot approve: COP→USD rate unavailable for the reference year': 'fx_rate_missing',
    // FIBIU-08 (FIBC-010) — the recoverable-reference EXIT_GATE.
    'Cannot approve without a recoverable reference (URL/DOI/dataset id/linked document)': 'missing_recoverable_reference',
    'Cannot approve: proxy has no version to approve': 'missing_recoverable_reference',
  }
  return known[message] ?? 'unknown_error'
}

export async function createGlobalProxySourceAction(formData: FormData) {
  const name = (formData.get('name') as string | null)?.trim()
  const description = (formData.get('description') as string | null)?.trim() || undefined
  const url = (formData.get('url') as string | null)?.trim() || undefined

  if (!name) redirect(`${PROXIES_PATH}?error=invalid_input`)

  await requireAdminAccess()

  try {
    await withSuperAdminDatabaseContext(() =>
      createGlobalProxySource({ name, description, url })
    )
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${PROXIES_PATH}?error=not_authorized`)
    redirect(`${PROXIES_PATH}?error=invalid_input`)
  }

  revalidatePath(PROXIES_PATH)
  redirect(`${PROXIES_PATH}?success=source_created`)
}

export async function createGlobalFinancialProxyAction(formData: FormData) {
  const sourceId = formData.get('sourceId') as string | null
  const name = (formData.get('name') as string | null)?.trim()
  const currency = (formData.get('currency') as string | null)?.trim()
  const value = (formData.get('value') as string | null)?.trim()
  const unit = (formData.get('unit') as string | null)?.trim()
  const referenceYearRaw = formData.get('referenceYear') as string | null
  // FIBIU-08 (FIBC-010) — full-provenance form fields. Optional at creation
  // (only recoverableReference is a hard gate, and only at approval time).
  const recoverableReference = (formData.get('recoverableReference') as string | null)?.trim() || undefined
  const geographicContextualScope = (formData.get('geographicContextualScope') as string | null)?.trim() || undefined
  const linkedOutcomeContext = (formData.get('linkedOutcomeContext') as string | null)?.trim() || undefined
  const relevanceJustification = (formData.get('relevanceJustification') as string | null)?.trim() || undefined
  const documentedTransformations = (formData.get('documentedTransformations') as string | null)?.trim() || undefined

  if (!sourceId || !name || !currency || !value || !unit || !referenceYearRaw) {
    redirect(`${PROXIES_PATH}?error=invalid_input`)
  }

  await requireAdminAccess()

  try {
    await withSuperAdminDatabaseContext(() =>
      createGlobalFinancialProxy({
        sourceId,
        name,
        currency,
        value,
        unit,
        referenceYear: Number(referenceYearRaw),
        recoverableReference,
        geographicContextualScope,
        linkedOutcomeContext,
        relevanceJustification,
        documentedTransformations,
      })
    )
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${PROXIES_PATH}?error=not_authorized`)
    redirect(`${PROXIES_PATH}?error=invalid_input`)
  }

  revalidatePath(PROXIES_PATH)
  redirect(`${PROXIES_PATH}?success=proxy_created`)
}

export async function updateGlobalProxyReviewStatusAction(formData: FormData) {
  const proxyId = formData.get('proxyId') as string | null
  const status = formData.get('status') as string | null
  const expectedApprovalState = formData.get('expectedApprovalState') as string | null

  if (!proxyId || !status || (status === 'approved' && !expectedApprovalState)) redirect(`${PROXIES_PATH}?error=invalid_input`)

  await requireAdminAccess()

  try {
    await withSuperAdminDatabaseContext(() =>
      updateGlobalProxyReviewStatus(proxyId, status, expectedApprovalState ?? undefined)
    )
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${PROXIES_PATH}?error=not_authorized`)
    const message = err instanceof Error ? err.message : 'unknown_error'
    redirect(`${PROXIES_PATH}?error=${errorToSlug(message)}`)
  }

  revalidatePath(PROXIES_PATH)
  redirect(`${PROXIES_PATH}?success=status_updated`)
}

export async function setGlobalProxyManualFxRateAction(formData: FormData) {
  const proxyId = formData.get('proxyId') as string | null
  const rateToUsd = (formData.get('rateToUsd') as string | null)?.trim()
  const source = (formData.get('source') as string | null)?.trim()
  const expectedApprovalState = formData.get('expectedApprovalState') as string | null

  if (!proxyId || !rateToUsd || !source || !expectedApprovalState) redirect(`${PROXIES_PATH}?error=invalid_input`)

  await requireAdminAccess()

  try {
    await withSuperAdminDatabaseContext(() =>
      setGlobalProxyManualFxRate(proxyId, { rateToUsd, source }, expectedApprovalState)
    )
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${PROXIES_PATH}?error=not_authorized`)
    const message = err instanceof Error ? err.message : 'unknown_error'
    redirect(`${PROXIES_PATH}?error=${errorToSlug(message)}`)
  }

  revalidatePath(PROXIES_PATH)
  redirect(`${PROXIES_PATH}?success=fx_rate_set`)
}

export async function promoteProxyToGlobalAction(formData: FormData) {
  const proxyId = formData.get('proxyId') as string | null
  const expectedApprovalState = formData.get('expectedApprovalState') as string | null

  if (!proxyId || !expectedApprovalState) redirect(`${PROXIES_PATH}?error=invalid_input`)

  await requireAdminAccess()

  try {
    const { promoteProxyToGlobal } = await import('@/lib/admin/proxies')
    await withSuperAdminDatabaseContext(() => promoteProxyToGlobal(proxyId, expectedApprovalState))
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${PROXIES_PATH}?error=not_authorized`)
    const message = err instanceof Error ? err.message : 'unknown_error'
    redirect(`${PROXIES_PATH}?error=${errorToSlug(message)}`)
  }

  revalidatePath(PROXIES_PATH)
  redirect(`${PROXIES_PATH}?success=proxy_promoted`)
}

'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createGlobalProxySource, createGlobalFinancialProxy, updateGlobalProxyReviewStatus, setGlobalProxyManualFxRate } from '@/lib/admin/proxies'

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
  }
  return known[message] ?? 'unknown_error'
}

export async function createGlobalProxySourceAction(formData: FormData) {
  const name = (formData.get('name') as string | null)?.trim()
  const description = (formData.get('description') as string | null)?.trim() || undefined
  const url = (formData.get('url') as string | null)?.trim() || undefined

  if (!name) redirect(`${PROXIES_PATH}?error=invalid_input`)

  try {
    await createGlobalProxySource({ name, description, url })
  } catch {
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

  if (!sourceId || !name || !currency || !value || !unit || !referenceYearRaw) {
    redirect(`${PROXIES_PATH}?error=invalid_input`)
  }

  try {
    await createGlobalFinancialProxy({
      sourceId,
      name,
      currency,
      value,
      unit,
      referenceYear: Number(referenceYearRaw),
    })
  } catch {
    redirect(`${PROXIES_PATH}?error=invalid_input`)
  }

  revalidatePath(PROXIES_PATH)
  redirect(`${PROXIES_PATH}?success=proxy_created`)
}

export async function updateGlobalProxyReviewStatusAction(formData: FormData) {
  const proxyId = formData.get('proxyId') as string | null
  const status = formData.get('status') as string | null

  if (!proxyId || !status) redirect(`${PROXIES_PATH}?error=invalid_input`)

  try {
    await updateGlobalProxyReviewStatus(proxyId, status)
  } catch (err) {
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

  if (!proxyId || !rateToUsd || !source) redirect(`${PROXIES_PATH}?error=invalid_input`)

  try {
    await setGlobalProxyManualFxRate(proxyId, { rateToUsd, source })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error'
    redirect(`${PROXIES_PATH}?error=${errorToSlug(message)}`)
  }

  revalidatePath(PROXIES_PATH)
  redirect(`${PROXIES_PATH}?success=fx_rate_set`)
}

export async function promoteProxyToGlobalAction(formData: FormData) {
  const proxyId = formData.get('proxyId') as string | null

  if (!proxyId) redirect(`${PROXIES_PATH}?error=invalid_input`)

  try {
    const { promoteProxyToGlobal } = await import('@/lib/admin/proxies')
    await promoteProxyToGlobal(proxyId)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error'
    redirect(`${PROXIES_PATH}?error=${errorToSlug(message)}`)
  }

  revalidatePath(PROXIES_PATH)
  redirect(`${PROXIES_PATH}?success=proxy_promoted`)
}

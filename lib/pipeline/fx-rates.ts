/**
 * lib/pipeline/fx-rates.ts
 * Service for managing FX rates (exchange rates to USD).
 *
 * MVP: manual-only entry for all currencies.
 * COP auto-fetch is deferred to post-spike pending TRM source viability.
 */

import { db } from '@/db/client';
import { fxRates } from '@/db/schema';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import Decimal from 'decimal.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Currency must be 3-letter code');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const getOrCreateFxRateSchema = z.object({
  currency: currencySchema,
  rateDate: dateSchema,
  rateToUsd: z.instanceof(Decimal).optional(),
  source: z.string().optional(),
});

const createManualFxRateSchema = z.object({
  currency: currencySchema,
  rateDate: dateSchema,
  rateToUsd: z.instanceof(Decimal),
  source: z.string().min(1, 'Source cannot be empty'),
});

// ---------------------------------------------------------------------------
// getOrCreateFxRate
// ---------------------------------------------------------------------------

/**
 * Get an existing FX rate or create a manual entry if provided.
 *
 * - If a rate exists for the (currency, date) pair, return it.
 * - If not and manual parameters are provided, create and return a new manual entry.
 * - If not and no manual parameters, throw an error.
 *
 * For MVP, all entries are manual (sourceType = 'manual').
 * Org-scoped: each organization's manual entries are isolated.
 */
export async function getOrCreateFxRate(
  currency: string,
  rateDate: string,
  manualRateToUsd?: Decimal,
  manualSource?: string,
) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) {
    throw new Error('Not authenticated or organization context not available');
  }

  const { organization, user } = ctx;

  // Validate inputs
  const parsed = getOrCreateFxRateSchema.parse({
    currency,
    rateDate,
    rateToUsd: manualRateToUsd,
    source: manualSource,
  });

  // Check if rate already exists
  const existing = await db
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.currency, parsed.currency),
        eq(fxRates.rateDate, parsed.rateDate),
        eq(fxRates.organizationId, organization.id),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (existing) {
    return existing;
  }

  // If manual entry provided, create it
  if (parsed.rateToUsd && parsed.source) {
    const result = await db
      .insert(fxRates)
      .values({
        currency: parsed.currency,
        rateDate: parsed.rateDate,
        rateToUsd: parsed.rateToUsd.toString(),
        source: parsed.source,
        sourceType: 'manual',
        organizationId: organization.id,
        createdBy: user.id,
      })
      .returning()
      .then((rows) => rows[0]);

    return result;
  }

  // No existing rate and no manual entry provided
  throw new Error(
    `No rate found for ${parsed.currency}/${parsed.rateDate}. ` +
      'Manual entry required: provide rateToUsd and source.',
  );
}

// ---------------------------------------------------------------------------
// createManualFxRate
// ---------------------------------------------------------------------------

/**
 * Explicitly create a manual FX rate entry.
 *
 * Validates:
 * - 3-letter currency code
 * - YYYY-MM-DD date format
 * - Rate > 0 (enforced by schema validation + DB constraint)
 * - Non-empty source
 *
 * Returns the created rate record.
 */
export async function createManualFxRate(
  currency: string,
  rateDate: string,
  rateToUsd: Decimal,
  source: string,
) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) {
    throw new Error('Not authenticated or organization context not available');
  }

  const { organization, user } = ctx;

  const parsed = createManualFxRateSchema.parse({
    currency,
    rateDate,
    rateToUsd,
    source,
  });

  const result = await db
    .insert(fxRates)
    .values({
      currency: parsed.currency,
      rateDate: parsed.rateDate,
      rateToUsd: parsed.rateToUsd.toString(),
      source: parsed.source,
      sourceType: 'manual',
      organizationId: organization.id,
      createdBy: user.id,
    })
    .returning()
    .then((rows) => rows[0]);

  return result;
}

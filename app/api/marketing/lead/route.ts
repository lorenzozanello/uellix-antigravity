import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { marketingLeads } from '@/db/schema';
import { z } from 'zod';

const LeadSchema = z.object({
  email: z.string().trim().email().max(255),
  companyName: z.string().trim().max(255).optional(),
  sroiResult: z.string().trim().max(50).optional(),
  source: z.string().trim().max(100).default('sroi_calculator'),
});

export async function POST(request: Request) {
  let body: unknown

  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid request' },
      { status: 400 }
    )
  }

  const parsed = LeadSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request' },
      { status: 400 }
    )
  }

  try {
    const data = parsed.data
    await db.insert(marketingLeads).values({
      email: data.email,
      companyName: data.companyName,
      sroiResult: data.sroiResult,
      source: data.source,
    });

    return NextResponse.json({ success: true, message: 'Lead saved successfully' });
  } catch (error: unknown) {
    console.error('Error saving marketing lead:', error);
    return NextResponse.json(
      { success: false, error: 'Unable to save lead' },
      { status: 500 }
    );
  }
}

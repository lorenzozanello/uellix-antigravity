// app/app/projects/[projectId]/pipeline/calculation/upsertProjectInvestment.action.ts

'use server';

import { z } from 'zod';
import { upsertProjectInvestment } from '../../../../../../lib/pipeline/sroi-calculation';

const InvestmentSchema = z.object({
  amount: z.string().min(1),
  currency: z.string().min(1),
  year: z.number().int().optional(),
  description: z.string().optional(),
});

export async function upsertProjectInvestmentAction(formData: FormData) {
  const raw: Record<string, unknown> = {
    amount: formData.get('amount'),
    currency: formData.get('currency'),
    year: formData.get('year') ? Number(formData.get('year')) : undefined,
    description: (formData.get('description') as string | null) || undefined,
  };

  const parsed = InvestmentSchema.parse(raw);

  const projectId = formData.get('projectId') as string;
  if (!projectId) throw new Error('projectId missing');

  const result = await upsertProjectInvestment(projectId, parsed);
  return result;
}

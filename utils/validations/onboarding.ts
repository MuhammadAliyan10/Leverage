import { z } from 'zod';
import { parseMinorUnits } from '../../src/finance/ledger.ts';

export const accountTypeValues = ['cash', 'bank', 'savings', 'wallet', 'investment', 'other'] as const;

export const onboardingSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Give this account a name with at least 2 characters.')
    .max(80, 'Account names can be up to 80 characters.'),
  type: z.enum(accountTypeValues, { message: 'Choose an account type.' }),
  currency: z.enum(['PKR', 'USD', 'GBP', 'EUR', 'AED', 'SAR'], { message: 'Choose a supported currency.' }),
  balance: z.string().refine((value) => {
    const normalized = value.trim();
    if (!normalized || /^0+(?:\.0+)?$/.test(normalized)) return true;
    try {
      parseMinorUnits(normalized);
      return true;
    } catch {
      return false;
    }
  }, 'Enter a non-negative amount with no more than 2 decimal places.'),
});

export type OnboardingFormData = z.infer<typeof onboardingSchema>;

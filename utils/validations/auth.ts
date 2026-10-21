// utils/validations/auth.ts
import { z } from 'zod';

export const signInSchema = z.object({
  email: z
    .string()
    .min(1, 'Email is required')
    .email('Enter a valid email address')
    .transform((v) => v.trim().toLowerCase()),
  password: z
    .string()
    .min(1, 'Password is required')
    .min(6, 'Password must be at least 6 characters'),
});

export const signUpSchema = z
  .object({
    fullName: z
      .string()
      .min(1, 'Full name is required')
      .min(2, 'Full name must be at least 2 characters')
      .max(60, 'Full name is too long')
      .transform((v) => v.trim()),
    email: z
      .string()
      .min(1, 'Email is required')
      .email('Enter a valid email address')
      .transform((v) => v.trim().toLowerCase()),
    password: z
      .string()
      .min(1, 'Password is required')
      .min(10, 'Password must be at least 10 characters')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number'),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export type SignInFormData = z.infer<typeof signInSchema>;
export type SignUpFormData = z.infer<typeof signUpSchema>;

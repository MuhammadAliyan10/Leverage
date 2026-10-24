import { z } from 'zod';

export const profileNameSchema = z.object({
  fullName: z.string().trim().min(2, 'Name must be at least 2 characters.').max(60, 'Name must be 60 characters or less.'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.').max(1024, 'Password is too long.'),
  newPassword: z.string().min(12, 'Use at least 12 characters.').max(1024, 'Password is too long.')
    .regex(/[A-Z]/, 'Add at least one uppercase letter.').regex(/[0-9]/, 'Add at least one number.'),
  confirmPassword: z.string().min(1, 'Confirm your new password.').max(1024, 'Password is too long.'),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: 'Passwords do not match.', path: ['confirmPassword'],
}).refine((data) => data.newPassword !== data.currentPassword, {
  message: 'Choose a password different from your current one.', path: ['newPassword'],
});

export type ProfileNameForm = z.infer<typeof profileNameSchema>;
export type ChangePasswordForm = z.infer<typeof changePasswordSchema>;

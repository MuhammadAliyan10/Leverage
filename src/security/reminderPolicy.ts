export interface ReminderIdentity {
  ownerId?: unknown;
  billId?: unknown;
  url?: unknown;
}

export function readReminderIdentity(value: unknown): ReminderIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const result: ReminderIdentity = {};
  if ('ownerId' in value) result.ownerId = value.ownerId;
  if ('billId' in value) result.billId = value.billId;
  if ('url' in value) result.url = value.url;
  return result;
}

export function belongsToProfile(identity: ReminderIdentity | null, ownerId: string, legacyIds: ReadonlySet<string>, notificationId: string): boolean {
  return identity?.ownerId === ownerId || legacyIds.has(notificationId);
}

export function mayOpenReminder(input: { identity: ReminderIdentity | null; activeProfileId: string | null; remindersEnabled: boolean }): boolean {
  return input.remindersEnabled && input.activeProfileId !== null && input.identity?.ownerId === input.activeProfileId && input.identity.url === '/obligations' && typeof input.identity.billId === 'string';
}

export async function scheduleWithCompensation(input: {
  schedule: () => Promise<string>;
  persist: (notificationId: string) => Promise<void>;
  cancel: (notificationId: string) => Promise<void>;
  previousId: string | null;
}): Promise<string> {
  const notificationId = await input.schedule();
  try {
    await input.persist(notificationId);
  } catch (error) {
    try { await input.cancel(notificationId); }
    catch { throw new Error('Reminder ID could not be saved and the new notification could not be cancelled; open Settings to reconcile reminders.', { cause: error }); }
    throw error;
  }
  if (input.previousId && input.previousId !== notificationId) {
    try { await input.cancel(input.previousId); }
    catch (error) { throw new Error('The new reminder is saved, but the previous reminder could not be cancelled; open Settings to reconcile reminders.', { cause: error }); }
  }
  return notificationId;
}

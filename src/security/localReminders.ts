import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { localDb } from '../db/local/client';
import { belongsToProfile, readReminderIdentity, scheduleWithCompensation } from './reminderPolicy';

function notificationBelongsToOwner(value: { identifier: string; content: { data?: unknown } }, ownerId: string, legacyIds: ReadonlySet<string>): boolean {
  return belongsToProfile(readReminderIdentity(value.content.data), ownerId, legacyIds, value.identifier);
}

function dueDateAtReminderTime(dueDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  if (!match) throw new Error('Bill due date is invalid.');
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 9, 0, 0, 0);
}

function isBillReminderEligible(bill: { amountMinor: number; paidMinor: number; dueDate: string; status: string }): boolean {
  if (bill.status === 'paid' || bill.status === 'cancelled' || bill.status === 'skipped' || bill.amountMinor <= bill.paidMinor) return false;
  try { return dueDateAtReminderTime(bill.dueDate).getTime() > Date.now(); }
  catch { return false; }
}

const inFlight = new Set<string>();

async function scheduleForBill(ownerId: string, bill: {
  id: string; name: string; amountMinor: number; paidMinor: number; currency: string;
  dueDate: string; status: string; reminderId: string | null;
}): Promise<void> {
  if (Platform.OS === 'web') throw new Error('Local reminders require the installed mobile app.');
  const permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted) throw new Error('Allow notifications in device settings to schedule bill reminders.');
  if (bill.status === 'paid' || bill.status === 'cancelled' || bill.status === 'skipped' || bill.amountMinor <= bill.paidMinor) return;

  const triggerDate = dueDateAtReminderTime(bill.dueDate);
  if (triggerDate.getTime() <= Date.now()) return;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('bill-reminders', {
      name: 'Bill reminders', importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  await scheduleWithCompensation({
    schedule: () => Notifications.scheduleNotificationAsync({
      content: {
        title: 'Leverage bill reminder',
        body: 'A bill you chose to track is due today. Open Leverage to review it.',
        data: { url: '/obligations', ownerId, billId: bill.id },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: triggerDate },
    }),
    persist: (notificationId) => localDb.obligations.setBillReminder(ownerId, bill.id, notificationId),
    cancel: (notificationId) => Notifications.cancelScheduledNotificationAsync(notificationId),
    previousId: bill.reminderId,
  });
}

export async function scheduleBillReminder(ownerId: string, billId: string): Promise<void> {
  const key = `${ownerId}:${billId}`;
  if (inFlight.has(key)) throw new Error('This reminder is already being updated.');
  inFlight.add(key);
  try {
    const bill = (await localDb.obligations.bills.reminderRows(ownerId)).find((row) => row.id === billId);
    if (!bill) throw new Error('Bill was not found in this profile.');
    await scheduleForBill(ownerId, bill);
  } finally {
    inFlight.delete(key);
  }
}

export async function cancelProfileReminders(ownerId: string): Promise<void> {
  if (!ownerId.trim() || Platform.OS === 'web') return;
  const rows = await localDb.obligations.bills.reminderRows(ownerId);
  const legacyIds = new Set(rows.flatMap((row) => row.reminderId ? [row.reminderId] : []));
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const presented = await Notifications.getPresentedNotificationsAsync();
  const failures: string[] = [];

  for (const notification of scheduled) {
    if (!notificationBelongsToOwner(notification, ownerId, legacyIds)) continue;
    try { await Notifications.cancelScheduledNotificationAsync(notification.identifier); }
    catch { failures.push(notification.identifier); }
  }
  for (const notification of presented) {
    if (!notificationBelongsToOwner(notification.request, ownerId, legacyIds)) continue;
    try { await Notifications.dismissNotificationAsync(notification.request.identifier); }
    catch { failures.push(notification.request.identifier); }
  }
  if (failures.length) throw new Error('Some reminders could not be removed from this device. Their content is generic and does not include bill names or amounts.');
}

export async function cancelBillReminder(ownerId: string, billId: string, notificationId: string | null): Promise<void> {
  if (!ownerId.trim() || !billId.trim() || Platform.OS === 'web') return;
  const matches = (value: { identifier: string; content: { data?: unknown } }) => {
    const data = readReminderIdentity(value.content.data);
    return (notificationId !== null && value.identifier === notificationId) || (data?.ownerId === ownerId && data.billId === billId);
  };
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const presented = await Notifications.getPresentedNotificationsAsync();
  const failures: string[] = [];
  for (const notification of scheduled) {
    if (!matches(notification)) continue;
    try { await Notifications.cancelScheduledNotificationAsync(notification.identifier); }
    catch { failures.push(notification.identifier); }
  }
  for (const notification of presented) {
    if (!matches(notification.request)) continue;
    try { await Notifications.dismissNotificationAsync(notification.request.identifier); }
    catch { failures.push(notification.request.identifier); }
  }
  if (failures.length) throw new Error('The bill was updated, but its device reminder could not be fully removed. Open Settings to reconcile reminders.');
}

export async function reconcileProfileReminders(ownerId: string, enabled: boolean): Promise<void> {
  if (Platform.OS === 'web') return;
  const rows = await localDb.obligations.bills.reminderRows(ownerId);
  const optedIn = rows.filter((row) => row.reminderId !== null);
  const ids = new Set(optedIn.flatMap((row) => row.reminderId ? [row.reminderId] : []));
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const scheduledById = new Map(scheduled.map((notification) => [notification.identifier, notification]));
  const activeBills = new Map(optedIn.map((row) => [row.id, row]));

  for (const notification of scheduled) {
    const data = readReminderIdentity(notification.content.data);
    const ownedByProfile = data?.ownerId === ownerId || ids.has(notification.identifier);
    if (!ownedByProfile) continue;
    const bill = typeof data?.billId === 'string' ? activeBills.get(data.billId) : undefined;
    const isCurrent = enabled && bill && isBillReminderEligible(bill) && bill.reminderId === notification.identifier && data?.ownerId === ownerId;
    if (!isCurrent) await Notifications.cancelScheduledNotificationAsync(notification.identifier);
  }

  if (!enabled) return;
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;

  for (const bill of optedIn) {
    if (!isBillReminderEligible(bill)) continue;
    const current = bill.reminderId ? scheduledById.get(bill.reminderId) : undefined;
    const data = current ? readReminderIdentity(current.content.data) : null;
    if (current && data?.ownerId === ownerId && data?.billId === bill.id) continue;
    await scheduleForBill(ownerId, bill);
  }
}

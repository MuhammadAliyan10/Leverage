import test from 'node:test';
import assert from 'node:assert/strict';
import { belongsToProfile, mayOpenReminder, readReminderIdentity, scheduleWithCompensation } from '../../src/security/reminderPolicy.ts';

test('notification taps open bills only for the owning signed-in profile with reminders enabled', () => {
  const identity = readReminderIdentity({ ownerId: 'profile-a', billId: 'bill-a', url: '/obligations' });
  assert.equal(mayOpenReminder({ identity, activeProfileId: 'profile-a', remindersEnabled: true }), true);
  assert.equal(mayOpenReminder({ identity, activeProfileId: 'profile-b', remindersEnabled: true }), false);
  assert.equal(mayOpenReminder({ identity, activeProfileId: null, remindersEnabled: true }), false);
  assert.equal(mayOpenReminder({ identity, activeProfileId: 'profile-a', remindersEnabled: false }), false);
  assert.equal(mayOpenReminder({ identity: readReminderIdentity({ ownerId: 'profile-a', billId: 'bill-a' }), activeProfileId: 'profile-a', remindersEnabled: true }), false);
});

test('profile cleanup targets only owned reminders and identified legacy reminder IDs', () => {
  const legacyIds = new Set(['legacy-profile-a-notification']);
  assert.equal(belongsToProfile(readReminderIdentity({ ownerId: 'profile-a' }), 'profile-a', legacyIds, 'new-id'), true);
  assert.equal(belongsToProfile(readReminderIdentity({ ownerId: 'profile-b' }), 'profile-a', legacyIds, 'new-id'), false);
  assert.equal(belongsToProfile(null, 'profile-a', legacyIds, 'legacy-profile-a-notification'), true);
  assert.equal(belongsToProfile(null, 'profile-a', legacyIds, 'unrelated'), false);
});

test('failed reminder ID persistence compensates by cancelling the newly scheduled reminder', async () => {
  const cancelled = [];
  await assert.rejects(scheduleWithCompensation({
    schedule: async () => 'new-id',
    persist: async () => { throw new Error('synthetic storage failure'); },
    cancel: async (id) => { cancelled.push(id); },
    previousId: 'old-id',
  }), /synthetic storage failure/);
  assert.deepEqual(cancelled, ['new-id']);
});

test('failed compensation is reported instead of hiding an orphan reminder', async () => {
  await assert.rejects(scheduleWithCompensation({
    schedule: async () => 'new-id',
    persist: async () => { throw new Error('synthetic storage failure'); },
    cancel: async () => { throw new Error('synthetic cancellation failure'); },
    previousId: null,
  }), /could not be cancelled/);
});

test('successful reschedule persists the replacement before cancelling the old reminder', async () => {
  const actions = [];
  const id = await scheduleWithCompensation({
    schedule: async () => { actions.push('schedule'); return 'new-id'; },
    persist: async (value) => { actions.push(`persist:${value}`); },
    cancel: async (value) => { actions.push(`cancel:${value}`); },
    previousId: 'old-id',
  });
  assert.equal(id, 'new-id');
  assert.deepEqual(actions, ['schedule', 'persist:new-id', 'cancel:old-id']);
});

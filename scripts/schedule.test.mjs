import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { addDays, currentWeek, pacificClock, readSessions, reservationStatus } from '../dist/assets/schedule.mjs';

test('the checked-in schedule is valid', async () => {
  const data = JSON.parse(await readFile(new URL('../dist/schedule.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => readSessions(data));
});

test('the visible week starts on Tuesday, including when today is Monday or a weekend', () => {
  assert.deepEqual(currentWeek('2026-11-23'), { first: '2026-11-24', selected: '2026-11-24' });
  assert.deepEqual(currentWeek('2026-11-27'), { first: '2026-11-24', selected: '2026-11-27' });
  assert.deepEqual(currentWeek('2026-11-28'), { first: '2026-12-01', selected: '2026-12-01' });
  assert.deepEqual(currentWeek('2026-11-29'), { first: '2026-12-01', selected: '2026-12-01' });
});

test('the reservation check uses Pacific calendar days through daylight-saving transitions', () => {
  assert.equal(addDays('2026-11-03', -3), '2026-10-31');
  assert.deepEqual(pacificClock(new Date('2026-11-02T04:00:00Z')), { date: '2026-11-01', hour: 20 });
  assert.deepEqual(pacificClock(new Date('2026-11-02T08:00:00Z')), { date: '2026-11-02', hour: 0 });
  assert.deepEqual(pacificClock(new Date('2026-11-01T04:00:00Z')), { date: '2026-10-31', hour: 21 });
});

test('invalid records cannot imply a session is booked', () => {
  for (const date of ['2026-11-21', '2026-11-22', '2026-11-23']) {
    assert.throws(() => readSessions([{ date, status: 'pending' }]), /Tuesday–Friday/);
  }
  assert.throws(() => readSessions([{ date: '2026-02-30', status: 'pending' }]), /Invalid session date/);
  assert.throws(() => readSessions([{ date: '2026-11-24', status: 'confirmed' }]), /reserved court/);
  const session = { date: '2026-11-24', status: 'pending' };
  assert.throws(() => readSessions([session, session]), /Duplicate/);
});

test('unconfirmed sessions expire at 8 PM Pacific without changing confirmed or cancelled sessions', () => {
  const session = { date: '2026-11-24', status: 'pending' };
  assert.equal(reservationStatus(session, { date: session.date, hour: 19 }).label, 'Pending');
  const clock = { date: session.date, hour: 20 };
  assert.equal(reservationStatus(session, clock).label, 'Not confirmed');
  assert.equal(reservationStatus({ ...session, status: 'confirmed' }, clock).label, 'Confirmed');
  assert.equal(reservationStatus({ ...session, status: 'cancelled' }, clock).label, 'Cancelled');
});

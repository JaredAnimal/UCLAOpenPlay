import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, currentWeek, isSessionDate, isTennisDate, pacificClock, readSessions, reservationStatus } from '../public/assets/schedule.mjs';

test('the visible week starts on Monday and selects today, including on weekends', () => {
  for (const selected of ['2026-11-23', '2026-11-27', '2026-11-28', '2026-11-29']) {
    assert.deepEqual(currentWeek(selected), { first: '2026-11-23', selected });
  }
  assert.deepEqual(currentWeek('2026-01-01'), { first: '2025-12-29', selected: '2026-01-01' });
});

test('Monday, Wednesday, and Saturday are reserved and Sunday has no open play', () => {
  const dates = Array.from({ length: 7 }, (_, offset) => addDays('2026-11-23', offset));
  assert.deepEqual(dates.filter(isTennisDate), ['2026-11-23', '2026-11-25', '2026-11-28']);
  assert.deepEqual(dates.filter(isSessionDate), ['2026-11-24', '2026-11-26', '2026-11-27']);
  const sessions = readSessions([{ date: '2026-11-24', status: 'pending' }, { date: '2026-11-25', status: 'pending' }]);
  assert.deepEqual([...sessions.keys()], ['2026-11-24']);
});

test('the reservation check uses Pacific calendar days through daylight-saving transitions', () => {
  assert.equal(addDays('2026-11-03', -3), '2026-10-31');
  assert.deepEqual(pacificClock(new Date('2026-11-02T04:00:00Z')), { date: '2026-11-01', hour: 20 });
  assert.deepEqual(pacificClock(new Date('2026-11-02T08:00:00Z')), { date: '2026-11-02', hour: 0 });
  assert.deepEqual(pacificClock(new Date('2026-11-01T04:00:00Z')), { date: '2026-10-31', hour: 21 });
});

test('invalid records cannot imply a session is booked', () => {
  for (const date of ['2026-11-21', '2026-11-22', '2026-11-23']) {
    assert.throws(() => readSessions([{ date, status: 'pending' }]), /Tuesdays, Thursdays, and Fridays/);
  }
  assert.throws(() => readSessions([{ date: '2026-02-30', status: 'pending' }]), /Invalid session date/);
  assert.throws(() => readSessions([{ date: '2026-11-24', status: 'confirmed' }]), /reserved court/);
  const session = { date: '2026-11-24', status: 'pending' };
  assert.throws(() => readSessions([session, session]), /Duplicate/);
});

test('unconfirmed sessions expire at 8 PM Pacific without changing confirmed or cancelled sessions', () => {
  const session = { date: '2026-11-24', status: 'pending' };
  assert.equal(reservationStatus(session, { date: session.date, hour: 19 }).label, 'Tentative');
  const clock = { date: session.date, hour: 20 };
  assert.equal(reservationStatus(session, clock).label, 'Not confirmed');
  assert.equal(reservationStatus({ ...session, status: 'confirmed' }, clock).label, 'Confirmed');
  assert.equal(reservationStatus({ ...session, status: 'cancelled' }, clock).label, 'Cancelled');
});

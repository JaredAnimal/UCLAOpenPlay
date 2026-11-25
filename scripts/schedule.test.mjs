import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_COURT, addDays, calendarStatus, cleanName, currentWeek, displayName, hourText, isSessionDate, pacificClock, readSessions, sessionTime, validHours } from '../public/assets/schedule.mjs';

test('hours are whole numbers from 8 AM to midnight with the end after the start', () => {
  assert.equal(DEFAULT_COURT, 'Sunset Rec Tennis Court 2');
  assert.equal(validHours(18, 20), true);
  assert.equal(validHours(8, 24), true);
  for (const [start, end] of [[7, 9], [18, 18], [20, 18], [18, 25], ['18', 20], [18, null], [18.5, 20], [undefined, 20]]) {
    assert.equal(validHours(start, end), false, `${start}-${end}`);
  }
  assert.deepEqual([8, 12, 18, 24].map(hourText), ['8 AM', '12 PM', '6 PM', '12 AM']);
});

test('a pending night keeps the hours an admin is sent, and drops anything that is not a number', () => {
  const sessions = readSessions([
    { date: '2026-11-25', status: 'pending', startHour: 19, endHour: 21, location: 'Court 5' },
    { date: '2026-11-26', status: 'pending', startHour: '19' },
  ]);
  const proposed = sessions.get('2026-11-25');
  assert.deepEqual([proposed.startHour, proposed.endHour, proposed.location], [19, 21, 'Court 5']);
  assert.deepEqual([sessions.get('2026-11-26').startHour, sessions.get('2026-11-26').endHour], [undefined, undefined]);
});

test('a typed name is tidied, or refused when it is empty, too long, or has hidden or markup characters', () => {
  assert.equal(cleanName('  Maya   Lopez '), 'Maya Lopez');
  assert.equal(cleanName('José Ñúñez'), 'José Ñúñez');
  assert.equal(cleanName("O'Neil-Smith Jr."), "O'Neil-Smith Jr.");
  for (const bad of ['', '   ', 'A', '🎾🎾', 'a'.repeat(61), 'Maya​Lopez', '<b>Maya', 'Maya>', 42, null, undefined]) {
    assert.equal(cleanName(bad), null, String(bad));
  }
  assert.equal(cleanName('a'.repeat(60)), 'a'.repeat(60));
});

test('a last name shortens to a whole character, even an emoji', () => {
  assert.equal(displayName('Maya 🎾', 'maya@ucla.edu'), 'Maya 🎾.');
});

test('hours and names read the way the calendar shows them', () => {
  assert.equal(sessionTime(18, 20), '6–8 PM');
  assert.equal(sessionTime(18, 19), '6–7 PM');
  assert.equal(sessionTime(11, 13), '11 AM–1 PM');
  assert.equal(sessionTime(null, null), '6–8 PM');
  assert.equal(displayName('Maya Lopez', 'maya@ucla.edu'), 'Maya L.');
  assert.equal(displayName('Maya', 'maya@ucla.edu'), 'Maya');
  assert.equal(displayName(null, 'player@ucla.edu'), 'player');
});

test('the visible week starts on Monday and selects today, including on weekends', () => {
  for (const selected of ['2026-11-23', '2026-11-27', '2026-11-28', '2026-11-29']) {
    assert.deepEqual(currentWeek(selected), { first: '2026-11-23', selected });
  }
  assert.deepEqual(currentWeek('2026-01-01'), { first: '2025-12-29', selected: '2026-01-01' });
});

test('any day of the week can hold a session', () => {
  const dates = Array.from({ length: 7 }, (_, offset) => addDays('2026-11-23', offset));
  assert.deepEqual(dates.filter(isSessionDate), dates);
  assert.equal(isSessionDate('2026-02-30'), false);
  const sessions = readSessions(dates.map(date => ({ date, status: 'pending' })));
  assert.deepEqual([...sessions.keys()], dates);
});

test('dates without a session have no status', () => {
  const today = { date: '2026-11-20', hour: 12 };
  for (const date of ['2026-11-20', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-28', '2026-11-29']) {
    assert.equal(calendarStatus(date, undefined, today), null);
  }
  const tuesday = '2026-11-24';
  assert.equal(calendarStatus(tuesday, { date: tuesday, status: 'cancelled' }, today).label, 'Cancelled');
  assert.equal(calendarStatus(tuesday, { date: tuesday, status: 'confirmed' }, today).label, 'Confirmed');
});

test('sessions keep their hours and sign-up names, with defaults', () => {
  const sessions = readSessions([
    { date: '2026-11-25', status: 'confirmed', location: 'X', time: '6–7 PM', players: ['A'] },
    { date: '2026-11-28', status: 'pending' },
  ]);
  const wednesday = sessions.get('2026-11-25');
  assert.equal(wednesday.time, '6–7 PM');
  assert.deepEqual(wednesday.players, ['A']);
  const saturday = sessions.get('2026-11-28');
  assert.equal(saturday.time, '6–8 PM');
  assert.deepEqual(saturday.players, []);
});

test('the reservation check uses Pacific calendar days through daylight-saving transitions', () => {
  assert.equal(addDays('2026-11-03', -3), '2026-10-31');
  assert.deepEqual(pacificClock(new Date('2026-11-02T04:00:00Z')), { date: '2026-11-01' });
  assert.deepEqual(pacificClock(new Date('2026-11-02T08:00:00Z')), { date: '2026-11-02' });
  assert.deepEqual(pacificClock(new Date('2026-11-01T04:00:00Z')), { date: '2026-10-31' });
});

test('invalid records cannot imply a session is booked', () => {
  assert.throws(() => readSessions([{ date: '2026-02-30', status: 'pending' }]), /Invalid session date/);
  assert.throws(() => readSessions([{ date: '2026-11-24', status: 'confirmed' }]), /reserved court/);
  const session = { date: '2026-11-24', status: 'pending' };
  assert.throws(() => readSessions([session, session]), /Duplicate/);
});

test('unconfirmed sessions expire when their Pacific day is over, without changing confirmed or cancelled sessions', () => {
  const session = { date: '2026-11-24', status: 'pending' };
  assert.equal(calendarStatus(session.date, session, { date: session.date }).label, 'Tentative');
  const clock = { date: '2026-11-25' };
  assert.equal(calendarStatus(session.date, session, clock).label, 'Not confirmed');
  assert.equal(calendarStatus(session.date, { ...session, status: 'confirmed' }, clock).label, 'Confirmed');
  assert.equal(calendarStatus(session.date, { ...session, status: 'cancelled' }, clock).label, 'Cancelled');
});

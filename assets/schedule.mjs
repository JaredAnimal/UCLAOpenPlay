const TIME_ZONE = 'America/Los_Angeles';
const MONDAY = 1;
const TUESDAY = 2;
const WEDNESDAY = 3;
const THURSDAY = 4;
const FRIDAY = 5;
const SATURDAY = 6;
export const DAYS_PER_WEEK = 7;
export const RESERVATION_LEAD_DAYS = 3;
export const SESSION_TIME = '6–8 PM Pacific';
const TENNIS_RESERVATION = { label: 'Reserved for tennis', style: 'tennis' };
const TENTATIVE_RESERVATION = { label: 'Tentative', style: 'pending' };

const localClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});
const validStatuses = new Set(['pending', 'confirmed', 'cancelled']);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function pacificClock(now = new Date()) {
  const { year, month, day, hour } = Object.fromEntries(
    localClock.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  return { date: `${year}-${month}-${day}`, hour: Number(hour) };
}

export function civilDate(date) {
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date, offset) {
  const result = civilDate(date);
  result.setUTCDate(result.getUTCDate() + offset);
  return result.toISOString().slice(0, 10);
}

function isOpenPlayDay(weekday) {
  return weekday === TUESDAY || weekday === THURSDAY;
}

export function isCalendarDate(date) {
  if (typeof date !== 'string' || !datePattern.test(date)) return false;
  const parsed = civilDate(date);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === date;
}

export function isSessionDate(date) {
  return isCalendarDate(date) && isOpenPlayDay(civilDate(date).getUTCDay());
}

export function isTennisDate(date) {
  const weekday = civilDate(date).getUTCDay();
  return weekday === MONDAY || weekday === WEDNESDAY || weekday === FRIDAY || weekday === SATURDAY;
}

export function sessionEnded(date, clock) {
  return date < clock.date || (date === clock.date && clock.hour >= 20);
}

export function currentWeek(date) {
  const weekday = civilDate(date).getUTCDay();
  const daysSinceMonday = (weekday - MONDAY + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  return { first: addDays(date, -daysSinceMonday), selected: date };
}

export function readSessions(data) {
  if (!Array.isArray(data)) throw new Error('The schedule must be an array of sessions.');

  const sessions = new Map();
  for (const row of data) {
    const { date, status, location, note, signupCount, signedUp } = row ?? {};
    if (!isCalendarDate(date)) {
      throw new Error(`Invalid session date: ${date ?? '(missing)'}`);
    }
    const weekday = civilDate(date).getUTCDay();
    if (weekday === WEDNESDAY || weekday === FRIDAY) continue; // Older schedules could include these days.
    if (!isOpenPlayDay(weekday)) throw new Error(`Open play is on Tuesdays and Thursdays: ${date}.`);
    if (sessions.has(date)) throw new Error(`Duplicate session date: ${date}`);
    if (!validStatuses.has(status)) throw new Error(`Invalid reservation status for ${date}.`);
    if (location !== undefined && (typeof location !== 'string' || !location.trim())) {
      throw new Error(`Enter a valid court location for ${date}.`);
    }
    if (status === 'confirmed' && !location) throw new Error(`Enter the reserved court for ${date}.`);
    if (note !== undefined && typeof note !== 'string') throw new Error(`Invalid session note for ${date}.`);
    sessions.set(date, { date, status, location: location?.trim(), note: note?.trim(), signupCount: signupCount ?? 0, signedUp: signedUp === true });
  }
  return sessions;
}

export function calendarStatus(date, session, clock) {
  if (isTennisDate(date)) return TENNIS_RESERVATION;
  if (!session) {
    const beyondReservationWindow = date > addDays(clock.date, RESERVATION_LEAD_DAYS);
    return isSessionDate(date) && beyondReservationWindow ? TENTATIVE_RESERVATION : null;
  }
  if (session.status === 'confirmed') return { label: 'Confirmed', style: 'confirmed' };
  if (session.status === 'cancelled') return { label: 'Cancelled', style: 'cancelled' };
  if (sessionEnded(session.date, clock)) {
    return { label: 'Not confirmed', style: 'cancelled', note: 'A reservation was never posted for this session.' };
  }
  return TENTATIVE_RESERVATION;
}

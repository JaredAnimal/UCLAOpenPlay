const TIME_ZONE = 'America/Los_Angeles';
const MONDAY = 1;
export const DAYS_PER_WEEK = 7;
export const RESERVATION_LEAD_DAYS = 3;
export const SESSION_TIME = '6–8 PM';
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

export function isCalendarDate(date) {
  if (typeof date !== 'string' || !datePattern.test(date)) return false;
  const parsed = civilDate(date);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === date;
}

// Any day can hold a session: the bot posts the days it books, and people can propose any night.
export const isSessionDate = isCalendarDate;

export function sessionEnded(date, clock) {
  return date < clock.date || (date === clock.date && clock.hour >= 20);
}

function hourLabel(hour) {
  return { hour: hour % 12 || 12, meridiem: hour % 24 < 12 ? 'AM' : 'PM' };
}

export function sessionTime(startHour, endHour) {
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return SESSION_TIME;
  const start = hourLabel(startHour);
  const end = hourLabel(endHour);
  return start.meridiem === end.meridiem
    ? `${start.hour}–${end.hour} ${end.meridiem}`
    : `${start.hour} ${start.meridiem}–${end.hour} ${end.meridiem}`;
}

// Other members see "Maya L."; without a name, the part of the email before the @.
export function displayName(name, email) {
  const words = typeof name === 'string' ? name.trim().split(/\s+/).filter(Boolean) : [];
  if (!words.length) return email.split('@')[0];
  return words.length === 1 ? words[0] : `${words[0]} ${words.at(-1)[0]}.`;
}

// A typed name with spaces collapsed, or null unless it has a letter, 2-60 characters, and no hidden characters or < >.
export function cleanName(input) {
  if (typeof input !== 'string') return null;
  const name = input.trim().replace(/\s+/g, ' ');
  const length = [...name].length;
  return length >= 2 && length <= 60 && /\p{L}/u.test(name) && !/[\p{C}<>]/u.test(name) ? name : null;
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
    const { date, status, location, note, signupCount, signedUp, time, players } = row ?? {};
    if (!isCalendarDate(date)) {
      throw new Error(`Invalid session date: ${date ?? '(missing)'}`);
    }
    if (sessions.has(date)) throw new Error(`Duplicate session date: ${date}`);
    if (!validStatuses.has(status)) throw new Error(`Invalid reservation status for ${date}.`);
    if (location !== undefined && (typeof location !== 'string' || !location.trim())) {
      throw new Error(`Enter a valid court location for ${date}.`);
    }
    if (status === 'confirmed' && !location) throw new Error(`Enter the reserved court for ${date}.`);
    if (note !== undefined && typeof note !== 'string') throw new Error(`Invalid session note for ${date}.`);
    sessions.set(date, { date, status, location: location?.trim(), note: note?.trim(), signupCount: signupCount ?? 0, signedUp: signedUp === true,
      time: typeof time === 'string' && time.trim() ? time.trim() : SESSION_TIME,
      players: Array.isArray(players) ? players.filter(name => typeof name === 'string') : [] });
  }
  return sessions;
}

export function calendarStatus(date, session, clock) {
  if (!session) return null;
  if (session.status === 'confirmed') return { label: 'Confirmed', style: 'confirmed' };
  if (session.status === 'cancelled') return { label: 'Cancelled', style: 'cancelled' };
  if (sessionEnded(session.date, clock)) {
    return { label: 'Not confirmed', style: 'cancelled', note: 'A reservation was never posted for this session.' };
  }
  return TENTATIVE_RESERVATION;
}

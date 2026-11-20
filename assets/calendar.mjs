import {
  DAYS_PER_WEEK, RESERVATION_LEAD_DAYS, SESSION_TIME, TENNIS_RESERVATION,
  pacificClock, civilDate, addDays, currentWeek, isCalendarDate, isTennisDate, readSessions, reservationStatus, sessionEnded,
} from './schedule.mjs';
import { bindAccountLink, fetchSchedule, updateSchedule } from './schedule-api.mjs';

const calendar = document.querySelector('#days');
const rangeTitle = document.querySelector('#range');
const detailDate = document.querySelector('#detail-date');
const detail = document.querySelector('#detail-content');
const previous = document.querySelector('#previous');
const next = document.querySelector('#next');
const today = document.querySelector('#today');
const accountLink = document.querySelector('#account-link');
const feedback = document.querySelector('#schedule-feedback');
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayTitle = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

let clock = pacificClock();
let { first: firstDate, selected: selectedDate } = currentWeek(clock.date);
const requestedDate = new URL(window.location.href).searchParams.get('date');
if (isCalendarDate(requestedDate)) {
  firstDate = currentWeek(requestedDate).first;
  selectedDate = requestedDate;
}
let loadState = 'loading';
let sessions = new Map();
let viewer = { signedIn: false, member: false, admins: null };
let activeRefresh;

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderDays() {
  const endDate = addDays(firstDate, DAYS_PER_WEEK - 1);
  rangeTitle.textContent = shortDate.formatRange(civilDate(firstDate), civilDate(endDate));

  const days = [];
  for (let offset = 0; offset < DAYS_PER_WEEK; offset += 1) {
    const date = addDays(firstDate, offset);
    const tennis = isTennisDate(date);
    const status = tennis ? TENNIS_RESERVATION : reservationStatus(sessions.get(date), clock);
    const button = element('button', '', tennis ? 'day tennis-day' : 'day');
    button.type = 'button';
    button.dataset.date = date;
    button.setAttribute('aria-label', `${fullDate.format(civilDate(date))}${status ? `, ${status.label}` : ''}`);
    button.setAttribute('aria-pressed', String(date === selectedDate));
    if (date === clock.date) button.setAttribute('aria-current', 'date');
    button.append(
      element('span', weekday.format(civilDate(date)), 'day-name'),
      element('span', String(civilDate(date).getUTCDate()), 'day-number'),
    );
    if (status) button.append(element('span', status.label, `day-status ${status.style}`));
    days.push(button);
  }
  const focusedDate = calendar.contains(document.activeElement) ? document.activeElement.dataset.date : '';
  calendar.replaceChildren(...days);
  if (focusedDate) calendar.querySelector(`[data-date="${focusedDate}"]`)?.focus({ preventScroll: true });
}

function renderDetail() {
  const sameYear = selectedDate.slice(0, 4) === clock.date.slice(0, 4);
  detailDate.textContent = (sameYear ? dayTitle : fullDate).format(civilDate(selectedDate));
  detail.replaceChildren();

  if (isTennisDate(selectedDate)) {
    detail.append(element('span', TENNIS_RESERVATION.label, `status-pill ${TENNIS_RESERVATION.style}`));
    return;
  }
  if (loadState === 'loading') {
    detail.append(element('p', 'Loading schedule…'));
    return;
  }
  if (loadState === 'error') {
    detail.append(element('p', 'The schedule couldn’t load.'));
    const retry = element('button', 'Try again', 'retry');
    retry.type = 'button';
    retry.addEventListener('click', refresh, { once: true });
    detail.append(retry);
    return;
  }

  const session = sessions.get(selectedDate);
  const status = reservationStatus(session, clock);
  if (!status) {
    detail.append(element('p', 'No session scheduled.'));
    return;
  }

  detail.append(element('span', status.label, `status-pill ${status.style}`));
  if (session.status === 'confirmed') {
    const location = element('p', session.location);
    const time = element('strong', SESSION_TIME);
    detail.append(time, location);
    renderSignup(session);
  } else if (status.note) {
    detail.append(element('p', status.note));
  } else if (session.status === 'pending') {
    const checkDate = addDays(selectedDate, -RESERVATION_LEAD_DAYS);
    const time = element('strong', SESSION_TIME);
    const message = checkDate > clock.date
      ? `Check back ${shortDate.format(civilDate(checkDate))} for the reservation status.`
      : 'We’re waiting for an admin to approve this session.';
    detail.append(time, element('p', message));
  }
  if (session.note) detail.append(element('p', session.note));
}

function renderSignup(session) {
  const people = session.signupCount === 1 ? '1 player signed up' : `${session.signupCount} players signed up`;
  detail.append(element('p', people));
  if (sessionEnded(session.date, clock)) return;
  if (!viewer.member) {
    const link = element('a', viewer.signedIn ? 'Switch to a UCLA account to sign up' : 'Log in with UCLA email to sign up', 'signup-login');
    bindAccountLink(link, viewer, session.date);
    detail.append(link);
    return;
  }

  const button = element('button', session.signedUp ? 'Cancel sign-up' : 'Sign up', 'rules-button signup-button');
  button.type = 'button';
  if (session.signedUp) detail.append(element('strong', 'You’re signed up.'));
  button.addEventListener('click', async () => {
    button.disabled = true;
    feedback.textContent = '';
    try {
      await updateSchedule({ date: session.date, action: session.signedUp ? 'leave' : 'join' });
      await refresh({ afterCurrent: true });
      feedback.textContent = session.signedUp ? 'Sign-up cancelled.' : 'You’re signed up.';
      if (selectedDate === session.date) detail.querySelector('.signup-button')?.focus({ preventScroll: true });
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  detail.append(button);
}

function render() {
  renderDays();
  renderDetail();
}

function moveWindow(offset) {
  firstDate = addDays(firstDate, offset);
  selectedDate = addDays(selectedDate, offset);
  render();
}

function updateClock() {
  const nextClock = pacificClock();
  if (nextClock.date === clock.date && nextClock.hour === clock.hour) return;
  const initialWeek = currentWeek(clock.date);
  if (firstDate === initialWeek.first && selectedDate === initialWeek.selected) {
    ({ first: firstDate, selected: selectedDate } = currentWeek(nextClock.date));
  }
  clock = nextClock;
  render();
}

async function loadSchedule() {
  if (loadState === 'error') {
    loadState = 'loading';
    renderDetail();
  }
  try {
    const data = await fetchSchedule();
    sessions = readSessions(data.sessions);
    viewer = data.viewer;
    accountLink.textContent = viewer.signedIn ? 'Sign out' : 'Log in';
    bindAccountLink(accountLink, viewer);
    accountLink.setAttribute('aria-label', viewer.signedIn ? 'Sign out' : 'Log in with a UCLA email');
    window.dispatchEvent(new CustomEvent('openplay-schedule', { detail: { viewer, sessions } }));
    loadState = 'ready';
  } catch (error) {
    console.error(error);
    sessions = new Map();
    loadState = 'error';
  } finally {
    render();
  }
}

export function refresh({ afterCurrent = false } = {}) {
  if (activeRefresh) return afterCurrent ? activeRefresh.then(() => refresh()) : activeRefresh;
  activeRefresh = loadSchedule().finally(() => { activeRefresh = null; });
  return activeRefresh;
}

export function showDate(date) {
  firstDate = currentWeek(date).first;
  selectedDate = date;
  render();
}

export function getSelectedDate() {
  return selectedDate;
}

previous.addEventListener('click', () => moveWindow(-DAYS_PER_WEEK));
next.addEventListener('click', () => moveWindow(DAYS_PER_WEEK));
today.addEventListener('click', () => {
  clock = pacificClock();
  ({ first: firstDate, selected: selectedDate } = currentWeek(clock.date));
  render();
});
calendar.addEventListener('click', event => {
  const button = event.target.closest('button[data-date]');
  if (!button || selectedDate === button.dataset.date) return;
  calendar.querySelector('[aria-pressed="true"]').setAttribute('aria-pressed', 'false');
  selectedDate = button.dataset.date;
  button.setAttribute('aria-pressed', 'true');
  renderDetail();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    updateClock();
    refresh();
  }
});
window.setInterval(updateClock, 60_000);
bindAccountLink(accountLink, viewer);
render();
refresh();

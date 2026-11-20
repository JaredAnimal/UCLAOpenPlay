import {
  DAYS_PER_WEEK, OPEN_PLAY_DAYS, RESERVATION_LEAD_DAYS, SESSION_TIME,
  pacificClock, civilDate, addDays, currentWeek, readSessions, reservationStatus,
} from './schedule.mjs';

const calendar = document.querySelector('#days');
const rangeTitle = document.querySelector('#range');
const detailDate = document.querySelector('#detail-date');
const detail = document.querySelector('#detail-content');
const previous = document.querySelector('#previous');
const next = document.querySelector('#next');
const today = document.querySelector('#today');
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayTitle = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const scheduleURL = new URL('../schedule.json', import.meta.url);

let clock = pacificClock();
let { first: firstDate, selected: selectedDate } = currentWeek(clock.date);
let loadState = 'loading';
let sessions = new Map();
let requestInFlight = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderDays() {
  const endDate = addDays(firstDate, OPEN_PLAY_DAYS - 1);
  rangeTitle.textContent = shortDate.formatRange(civilDate(firstDate), civilDate(endDate));

  const days = [];
  for (let offset = 0; offset < OPEN_PLAY_DAYS; offset += 1) {
    const date = addDays(firstDate, offset);
    const status = reservationStatus(sessions.get(date), clock);
    const button = element('button', '', 'day');
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
  } else if (status.note) {
    detail.append(element('p', status.note));
  } else if (session.status === 'pending') {
    const checkDate = addDays(selectedDate, -RESERVATION_LEAD_DAYS);
    const time = element('strong', SESSION_TIME);
    const message = checkDate > clock.date
      ? `Check back ${shortDate.format(civilDate(checkDate))} for the reservation status.`
      : 'We’re waiting for the court reservation to be confirmed.';
    detail.append(time, element('p', message));
  }
  if (session.note) detail.append(element('p', session.note));
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

async function refresh() {
  if (requestInFlight) return;
  requestInFlight = true;
  if (loadState === 'error') {
    loadState = 'loading';
    renderDetail();
  }
  try {
    const response = await fetch(scheduleURL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Schedule request failed (${response.status}).`);
    sessions = readSessions(await response.json());
    loadState = 'ready';
  } catch (error) {
    console.error(error);
    sessions = new Map();
    loadState = 'error';
  } finally {
    requestInFlight = false;
    render();
  }
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
render();
refresh();

import { getSelectedDate, refresh, showDate } from './calendar.mjs';
import { askName, hasName } from './account.mjs';
import { addAdmin, updateSchedule } from './schedule-api.mjs';
import { DEFAULT_COURT, civilDate, hourText, isSessionDate, pacificClock, sessionEnded } from './schedule.mjs';

const propose = document.querySelector('#propose');
const proposal = document.querySelector('#proposal');
const proposalTitle = document.querySelector('#proposal-title');
const proposalForm = document.querySelector('#proposal-form');
const { date: proposalDate, startHour: proposalStart, endHour: proposalEnd, location: proposalCourt } = proposalForm.elements;
const proposalHint = document.querySelector('#proposal-hint');
const proposalSubmit = proposalForm.querySelector('button');
const proposalFeedback = document.querySelector('#proposal-feedback');
const scheduleFeedback = document.querySelector('#schedule-feedback');
const approval = document.querySelector('#approval');
const approvalList = document.querySelector('#approval-list');
const approvalFeedback = document.querySelector('#approval-feedback');
const admins = document.querySelector('#admins');
const adminForm = document.querySelector('#admin-form');
const adminFeedback = document.querySelector('#admin-feedback');
const dateLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
let displayedProposals;
let posting = false;
let nights = new Map();

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function field(text, control) {
  const label = element('label', text);
  label.append(control);
  return label;
}

function hourOptions(from, to) {
  return Array.from({ length: to - from + 1 }, (_, index) => {
    const option = element('option', hourText(from + index));
    option.value = from + index;
    return option;
  });
}

// Fills a Start and an End select; End only offers hours after Start. Returns a function that sets both.
function hourPair(start, end) {
  start.replaceChildren(...hourOptions(8, 23));
  const set = (startHour, endHour) => {
    start.value = startHour;
    end.replaceChildren(...hourOptions(startHour + 1, 24));
    end.value = endHour;
  };
  start.addEventListener('change', () => set(Number(start.value), Math.max(Number(end.value), Number(start.value) + 1)));
  return set;
}

const setProposalHours = hourPair(proposalStart, proposalEnd);

function reviewForm({ date, startHour = 18, endHour = 20, location: court = '' }) {
  const form = document.createElement('form');
  const heading = element('h4', dateLabel.format(civilDate(date)));
  const start = document.createElement('select');
  const end = document.createElement('select');
  hourPair(start, end)(startHour, endHour);
  const hours = document.createElement('div');
  hours.className = 'hours';
  hours.append(field('Start', start), field('End', end));
  const location = document.createElement('input');
  location.required = true;
  location.maxLength = 160;
  location.value = court;
  const locationLabel = field('Reserved facility and court', location);
  const approve = element('button', 'Approve');
  approve.type = 'submit';
  approve.value = 'approve';
  approve.className = 'rules-button';
  const decline = element('button', 'Decline');
  decline.type = 'submit';
  decline.formNoValidate = true;
  decline.value = 'decline';
  decline.className = 'rules-close';
  const actions = document.createElement('div');
  actions.className = 'review-actions';
  actions.append(approve, decline);
  form.append(heading, hours, locationLabel, actions);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const action = event.submitter?.value ?? 'approve';
    approve.disabled = decline.disabled = true;
    approvalFeedback.textContent = '';
    try {
      await updateSchedule({ date, action, startHour: Number(start.value), endHour: Number(end.value), location: location.value });
      await refresh({ afterCurrent: true });
      approvalFeedback.textContent = action === 'approve' ? 'Session approved. Sign-ups are open.' : 'Proposal declined.';
    } catch (error) {
      approvalFeedback.textContent = error.message;
    } finally {
      approve.disabled = decline.disabled = false;
    }
  });
  return form;
}

// An admin who posts over a student's proposal starts from its hours and court.
function fillFromProposal() {
  const night = nights.get(proposalDate.value);
  if (night?.status !== 'pending') return;
  setProposalHours(night.startHour ?? 18, night.endHour ?? 20);
  proposalCourt.value = night.location || DEFAULT_COURT;
}

proposalDate.addEventListener('change', fillFromProposal);

propose.addEventListener('click', async () => {
  if (!hasName() && !await askName()) return;
  const date = getSelectedDate();
  const clock = pacificClock();
  proposalDate.min = clock.date;
  proposalDate.value = isSessionDate(date) && !sessionEnded(date, clock) ? date : '';
  setProposalHours(18, 20);
  proposalCourt.value = DEFAULT_COURT;
  fillFromProposal();
  proposalFeedback.textContent = '';
  proposal.showModal();
});

proposalForm.addEventListener('submit', async event => {
  event.preventDefault();
  const date = proposalDate.value;
  if (!isSessionDate(date)) {
    proposalFeedback.textContent = 'Choose a date.';
    return;
  }
  proposalSubmit.disabled = true;
  proposalFeedback.textContent = '';
  try {
    await updateSchedule({ date, action: 'propose', startHour: Number(proposalStart.value), endHour: Number(proposalEnd.value), location: proposalCourt.value });
    proposal.close();
    await refresh({ afterCurrent: true });
    showDate(date);
    scheduleFeedback.textContent = posting ? 'Night posted. It shows as confirmed.' : 'Proposal submitted. This night is tentative until approved.';
  } catch (error) {
    proposalFeedback.textContent = error.message;
  } finally {
    proposalSubmit.disabled = false;
  }
});

adminForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = adminForm.querySelector('button');
  button.disabled = true;
  adminFeedback.textContent = '';
  try {
    const { email } = await addAdmin(adminForm.elements.email.value);
    adminForm.reset();
    await refresh({ afterCurrent: true });
    adminFeedback.textContent = `${email} has admin access.`;
  } catch (error) {
    adminFeedback.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

window.addEventListener('openplay-schedule', ({ detail: { viewer, sessions } }) => {
  nights = sessions;
  propose.hidden = !viewer.member;
  posting = Boolean(viewer.admins);
  propose.textContent = proposalTitle.textContent = posting ? 'Post a night' : 'Propose a night';
  proposalSubmit.textContent = posting ? 'Post night' : 'Submit proposal';
  proposalHint.textContent = posting ? 'Choose a date. The night shows as confirmed right away.' : 'Choose a date. The session will show as tentative until approved.';
  approval.hidden = !viewer.admins;
  if (!viewer.admins) return;
  admins.replaceChildren(...viewer.admins.map(email => element('li', email)));

  // A background refresh with the same data must not rebuild the forms an admin is typing in.
  const clock = pacificClock();
  const pending = [...sessions.values()].filter(session => session.status === 'pending' && !sessionEnded(session.date, clock));
  const next = JSON.stringify(pending.map(({ date, startHour, endHour, location }) => [date, startHour, endHour, location]));
  if (displayedProposals === next) return;
  displayedProposals = next;
  approvalList.replaceChildren(...(pending.length ? pending.map(reviewForm) : [element('p', 'No proposals to review.')]));
});

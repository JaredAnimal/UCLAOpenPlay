import { getSelectedDate, refresh, showDate } from './calendar.mjs';
import { updateSchedule } from './schedule-api.mjs';
import { civilDate, isSessionDate, pacificClock, sessionEnded } from './schedule.mjs';

const propose = document.querySelector('#propose');
const proposal = document.querySelector('#proposal');
const proposalForm = document.querySelector('#proposal-form');
const proposalDate = proposalForm.elements.date;
const proposalFeedback = document.querySelector('#proposal-feedback');
const scheduleFeedback = document.querySelector('#schedule-feedback');
const approval = document.querySelector('#approval');
const approvalList = document.querySelector('#approval-list');
const approvalFeedback = document.querySelector('#approval-feedback');
const admins = document.querySelector('#admins');
const dateLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
let displayedDates;

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function reviewForm(date) {
  const form = document.createElement('form');
  const heading = element('h4', dateLabel.format(civilDate(date)));
  const locationLabel = element('label', 'Reserved facility and court');
  const location = document.createElement('input');
  location.required = true;
  location.maxLength = 160;
  locationLabel.append(location);
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
  form.append(heading, locationLabel, actions);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const action = event.submitter?.value ?? 'approve';
    approve.disabled = decline.disabled = true;
    approvalFeedback.textContent = '';
    try {
      await updateSchedule({ date, action, location: location.value });
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

propose.addEventListener('click', () => {
  const date = getSelectedDate();
  const clock = pacificClock();
  proposalDate.min = clock.date;
  proposalDate.value = sessionEnded(date, clock) ? '' : date;
  proposalFeedback.textContent = '';
  proposal.showModal();
});

proposalForm.addEventListener('submit', async event => {
  event.preventDefault();
  const date = proposalDate.value;
  if (!isSessionDate(date)) {
    proposalFeedback.textContent = 'Choose a Tuesday–Friday date.';
    return;
  }
  const button = proposalForm.querySelector('button');
  button.disabled = true;
  proposalFeedback.textContent = '';
  try {
    await updateSchedule({ date, action: 'propose' });
    proposal.close();
    await refresh({ afterCurrent: true });
    showDate(date);
    scheduleFeedback.textContent = 'Proposal submitted. This night is tentative until approved.';
  } catch (error) {
    proposalFeedback.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

window.addEventListener('openplay-schedule', ({ detail: { viewer, sessions } }) => {
  propose.hidden = !viewer.member;
  approval.hidden = !viewer.admins;
  if (!viewer.admins) return;
  admins.replaceChildren(...viewer.admins.map(email => element('li', email)));

  const clock = pacificClock();
  const dates = [...sessions.values()].filter(session => session.status === 'pending' && !sessionEnded(session.date, clock)).map(session => session.date);
  const nextDisplay = dates.join(',');
  if (displayedDates === nextDisplay) return;
  displayedDates = nextDisplay;
  approvalList.replaceChildren(...(dates.length ? dates.map(reviewForm) : [element('p', 'No proposals to review.')]));
});

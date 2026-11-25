import { saveName } from './schedule-api.mjs';
import { cleanName, displayName } from './schedule.mjs';

const dialog = document.querySelector('#name-dialog');
const form = document.querySelector('#name-form');
const input = form.elements.name;
const feedback = document.querySelector('#name-feedback');
const nameButton = document.querySelector('#name-button');
const scheduleFeedback = document.querySelector('#schedule-feedback');
let viewer = {};
let prompted = false;
let saved = false;

// Opens the name dialog; resolves true once a name is saved, false if it is closed without saving.
export function askName() {
  saved = false;
  input.value = viewer.name ?? viewer.suggestedName ?? '';
  feedback.textContent = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(saved), { once: true }));
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const name = cleanName(input.value);
  if (!name) {
    feedback.textContent = 'Enter your name: 2 to 60 characters, with at least one letter.';
    return;
  }
  const submit = form.querySelector('button');
  submit.disabled = true;
  feedback.textContent = '';
  try {
    await saveName(name);
    saved = true;
    dialog.close();
    scheduleFeedback.textContent = 'Name saved.';
    window.dispatchEvent(new Event('openplay-name-saved'));
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

nameButton.addEventListener('click', askName);

window.addEventListener('openplay-schedule', event => {
  viewer = event.detail.viewer;
  nameButton.hidden = !viewer.name;
  nameButton.textContent = viewer.name ? displayName(viewer.name, '') : '';
  if (viewer.member && !viewer.name && !prompted) {
    prompted = true;
    askName();
  }
});

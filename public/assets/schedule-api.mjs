import { backendUrl, pagesUrl } from './hosting.mjs';

const pages = location.origin === new URL(pagesUrl).origin;
const apiOrigin = pages ? backendUrl : location.origin;
const tokenKey = 'ucla-open-play:session';
const verifierKey = 'ucla-open-play:verifier';
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
let pagesLogin;

function request(path, { token, body } = {}) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body) headers.set('Content-Type', 'application/json');
  return fetch(new URL(path, apiOrigin), {
    method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body),
    credentials: pages ? 'omit' : 'same-origin', cache: 'no-store',
  });
}

async function json(response) {
  const body = await response.json().catch(() => null);
  if (response.ok && body) return body;
  throw new Error(body?.error ?? 'Couldn’t connect to Open Play. Try again.');
}

async function finishPagesLogin() {
  const code = new URLSearchParams(location.hash.slice(1)).get('code');
  if (!code) return;
  history.replaceState(null, '', `${location.pathname}${location.search}#schedule`);
  const verifier = sessionStorage.getItem(verifierKey);
  sessionStorage.removeItem(verifierKey);
  try {
    const { token } = await json(await request('/api/pages/session', { body: { code, verifier } }));
    sessionStorage.setItem(tokenKey, token);
  } catch (error) {
    document.querySelector('#schedule-feedback').textContent = error.message;
  }
}

function returnTo(date) {
  return date ? `/?date=${encodeURIComponent(date)}#schedule` : '/';
}

export function bindAccountLink(link, { signedIn }, date) {
  const action = signedIn ? 'signout' : 'signin';
  link.href = pages ? '#schedule' : `/${action}-with-chatgpt?return_to=${encodeURIComponent(returnTo(date))}`;
  link.target = pages ? '_self' : '_top';
  if (!pages) return;
  link.onclick = async event => {
    event.preventDefault();
    if (signedIn) {
      const token = sessionStorage.getItem(tokenKey);
      sessionStorage.removeItem(tokenKey);
      try {
        if (token) await json(await request('/api/pages/logout', { token, body: {} }));
      } catch {
        // The browser session is already cleared. An unreachable API session expires on its own.
      }
      location.reload();
      return;
    }
    try {
      const verifier = hex(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      sessionStorage.setItem(verifierKey, verifier);
      const url = new URL('/pages/login', backendUrl);
      url.searchParams.set('challenge', challenge);
      if (date) url.searchParams.set('date', date);
      location.assign(url);
    } catch {
      document.querySelector('#schedule-feedback').textContent = 'Couldn’t start sign-in. Try again.';
    }
  };
}

export async function fetchSchedule() {
  if (pages) {
    pagesLogin ??= finishPagesLogin();
    await pagesLogin;
  }
  const data = await json(await request('/api/schedule', { token: pages ? sessionStorage.getItem(tokenKey) : null }));
  if (pages && !data.viewer.signedIn) sessionStorage.removeItem(tokenKey);
  return data;
}

export async function updateSchedule(body) {
  return json(await request('/api/schedule', { token: pages ? sessionStorage.getItem(tokenKey) : null, body }));
}

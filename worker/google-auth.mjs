import { createRemoteJWKSet, jwtVerify } from 'jose';
import { backendUrl, pagesUrl } from '../public/assets/hosting.mjs';
import { isSessionDate } from '../public/assets/schedule.mjs';
import { credentialPattern, digest, randomCredential, sessionLifetime, timestamp, uclaAddress } from './auth-primitives.mjs';
import { redirectToPages } from './pages-auth.mjs';

export const googleClientId = '264230090060-4pbjhvns204gd8ajtklt7kd0820s5jav.apps.googleusercontent.com';
const authorizeUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const stateCookie = '__Host-open-play-state';
const sessionCookie = '__Host-open-play-session';
const stateLifetime = 10 * 60;
const maxBody = 10000;
// state.nonce.challenge.date, with the last two parts empty when absent.
const statePattern = /^([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{64})?\.(\d{4}-\d{2}-\d{2})?$/;

function readCookie(request, name) {
  return (request.headers.get('Cookie') ?? '').split(';').map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function sessionCredential(request) {
  const value = readCookie(request, sessionCookie);
  return credentialPattern.test(value) ? value : null;
}

function loginState(request) {
  const [, state, nonce, challenge = '', date = ''] = statePattern.exec(readCookie(request, stateCookie) ?? '') ?? [];
  return state ? { state, nonce, challenge, date } : null;
}

// Google posts the ID token back from another site, so only the state cookie needs SameSite=None.
function setCookie(name, value, lifetime, sameSite = 'Lax') {
  return `${name}=${value}; Path=/; Max-Age=${lifetime}; HttpOnly; Secure; SameSite=${sameSite}`;
}

const clearState = setCookie(stateCookie, '', 0, 'None');

function siteBase(url) {
  return url.hostname === 'localhost' ? url.origin : backendUrl;
}

function redirect(url, cookies, status = 303) {
  const headers = new Headers({ Location: String(url), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  cookies.forEach(cookie => headers.append('Set-Cookie', cookie));
  return new Response(null, { status, headers });
}

function calendarUrl(login, url, loginError) {
  const calendar = new URL(login?.challenge ? pagesUrl : siteBase(url));
  if (isSessionDate(login?.date)) {
    calendar.searchParams.set('date', login.date);
    calendar.hash = 'schedule';
  }
  if (loginError) calendar.searchParams.set('login_error', loginError);
  return calendar;
}

export function startGoogleLogin(url) {
  const challenge = url.searchParams.get('challenge') ?? '';
  if (challenge && !credentialPattern.test(challenge)) {
    return new Response('Start sign-in from the Open Play calendar.', { status: 400 });
  }
  const date = url.searchParams.get('date');
  const state = randomCredential();
  const nonce = randomCredential();
  const destination = new URL(authorizeUrl);
  destination.search = new URLSearchParams({
    client_id: googleClientId, redirect_uri: `${siteBase(url)}/auth/google/callback`, response_type: 'id_token',
    response_mode: 'form_post', scope: 'openid email profile', prompt: 'select_account', state, nonce,
  });
  return redirect(destination, [setCookie(stateCookie, `${state}.${nonce}.${challenge}.${isSessionDate(date) ? date : ''}`, stateLifetime, 'None')], 302);
}

export async function finishGoogleLogin(request, url, env) {
  const login = loginState(request);
  const reject = reason => redirect(calendarUrl(login, url, reason), [clearState]);

  let identity;
  try {
    if (request.method !== 'POST' || !request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return reject('google');
    const body = await request.text();
    const form = new URLSearchParams(body.length > maxBody ? '' : body);
    const idToken = form.get('id_token');
    if (!login || form.get('state') !== login.state || !idToken) return reject('google');
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: googleClientId,
      algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'nonce', 'email', 'email_verified'],
    });
    if (payload.nonce !== login.nonce) return reject('google');
    const member = payload.email_verified === true ? uclaAddress(payload.email) : null;
    if (!member) return reject('ucla');
    identity = { id: `google:${payload.sub}`, member, name: typeof payload.name === 'string' ? payload.name : null };
  } catch {
    return reject('google');
  }

  if (login.challenge) {
    const response = await redirectToPages(env.DB, login.challenge, identity, login.date);
    response.headers.append('Set-Cookie', clearState);
    return response;
  }
  const session = randomCredential();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pages_sessions WHERE expires_at <= ?').bind(timestamp()),
    env.DB.prepare(`INSERT INTO pages_sessions (credential_hash, user_id, member, name, expires_at, channel)
      VALUES (?, ?, ?, ?, ?, 'site')`).bind(await digest(session), identity.id, identity.member, identity.name, timestamp() + sessionLifetime),
  ]);
  return redirect(calendarUrl(login, url), [setCookie(sessionCookie, session, sessionLifetime), clearState]);
}

export async function googleIdentity(request, db) {
  const session = sessionCredential(request);
  if (!session) return null;
  return db.prepare(`SELECT user_id AS id, member, name FROM pages_sessions
    WHERE credential_hash = ? AND channel = 'site' AND expires_at > ?`).bind(await digest(session), timestamp()).first();
}

export async function finishGoogleLogout(request, db) {
  const session = sessionCredential(request);
  if (session) await db.prepare("DELETE FROM pages_sessions WHERE credential_hash = ? AND channel = 'site'").bind(await digest(session)).run();
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': setCookie(sessionCookie, '', 0), 'Cache-Control': 'no-store' } });
}

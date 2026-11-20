import { createRemoteJWKSet, jwtVerify } from 'jose';
import { backendUrl, pagesUrl } from '../public/assets/hosting.mjs';
import { isSessionDate } from '../public/assets/schedule.mjs';
import { credentialPattern, digest, randomCredential, sha256, timestamp, uclaAddress } from './auth-primitives.mjs';
import { redirectToPages } from './pages-auth.mjs';

const authorizeUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenUrl = 'https://oauth2.googleapis.com/token';
const redirectUri = `${backendUrl}/auth/google/callback`;
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const stateCookie = '__Host-open-play-state';
const sessionCookie = '__Host-open-play-session';
const stateLifetime = 10 * 60;
const sessionLifetime = 8 * 60 * 60;

export function googleEnabled(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function credentialCookie(request, name) {
  const value = (request.headers.get('Cookie') ?? '').split(';').map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && credentialPattern.test(value) ? value : null;
}

function setCookie(name, value, lifetime) {
  return `${name}=${value}; Path=/; Max-Age=${lifetime}; HttpOnly; Secure; SameSite=Lax`;
}

function calendarUrl(attempt, loginError) {
  const url = new URL(attempt?.pages_challenge ? pagesUrl : backendUrl);
  if (isSessionDate(attempt?.date)) {
    url.searchParams.set('date', attempt.date);
    url.hash = 'schedule';
  }
  if (loginError) url.searchParams.set('login_error', loginError);
  return url;
}

function redirectWithCookie(url, name, value, lifetime) {
  return new Response(null, { status: 302, headers: {
    Location: String(url), 'Set-Cookie': setCookie(name, value, lifetime),
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
}

export async function startGoogleLogin(url, env) {
  const pagesChallenge = url.searchParams.get('challenge');
  if (pagesChallenge !== null && !credentialPattern.test(pagesChallenge)) {
    return new Response('Start sign-in from the Open Play calendar.', { status: 400 });
  }
  const date = url.searchParams.get('date');
  const state = randomCredential();
  const nonce = randomCredential();
  const verifier = randomCredential();
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await sha256(verifier)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM google_login_attempts WHERE expires_at <= ?').bind(timestamp()),
    env.DB.prepare(`INSERT INTO google_login_attempts (state_hash, nonce, verifier, pages_challenge, date, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(await digest(state), nonce, verifier, pagesChallenge, isSessionDate(date) ? date : null, timestamp() + stateLifetime),
  ]);
  const destination = new URL(authorizeUrl);
  destination.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
    scope: 'openid email', prompt: 'select_account', state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  return redirectWithCookie(destination, stateCookie, state, stateLifetime);
}

export async function finishGoogleLogin(request, url, env) {
  const state = url.searchParams.get('state');
  const reject = (attempt, reason = 'google') => redirectWithCookie(calendarUrl(attempt, reason), stateCookie, '', 0);
  if (!state || credentialCookie(request, stateCookie) !== state) return reject(null);
  const attempt = await env.DB.prepare(`DELETE FROM google_login_attempts WHERE state_hash = ? AND expires_at > ?
    RETURNING nonce, verifier, pages_challenge, date`).bind(await digest(state), timestamp()).first();
  const code = url.searchParams.get('code');
  if (!attempt || !code) return reject(attempt);

  let identity;
  try {
    const token = await fetch(tokenUrl, {
      method: 'POST', redirect: 'error',
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: attempt.verifier,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!token.ok) return reject(attempt);
    const { id_token: idToken } = await token.json();
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env.GOOGLE_CLIENT_ID,
      algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'nonce', 'email', 'email_verified'],
    });
    if (payload.nonce !== attempt.nonce) return reject(attempt);
    const member = payload.email_verified === true ? uclaAddress(payload.email) : null;
    if (!member) return reject(attempt, 'ucla');
    identity = { id: `google:${payload.sub}`, member };
  } catch {
    return reject(attempt);
  }

  if (attempt.pages_challenge) {
    const response = await redirectToPages(env.DB, attempt.pages_challenge, identity, attempt.date);
    response.headers.append('Set-Cookie', setCookie(stateCookie, '', 0));
    return response;
  }
  const session = randomCredential();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pages_sessions WHERE expires_at <= ?').bind(timestamp()),
    env.DB.prepare(`INSERT INTO pages_sessions (credential_hash, user_id, member, expires_at, channel)
      VALUES (?, ?, ?, ?, 'site')`).bind(await digest(session), identity.id, identity.member, timestamp() + sessionLifetime),
  ]);
  const response = redirectWithCookie(calendarUrl(attempt), sessionCookie, session, sessionLifetime);
  response.headers.append('Set-Cookie', setCookie(stateCookie, '', 0));
  return response;
}

export async function googleIdentity(request, db) {
  const session = credentialCookie(request, sessionCookie);
  if (!session) return null;
  return db.prepare(`SELECT user_id AS id, member FROM pages_sessions
    WHERE credential_hash = ? AND channel = 'site' AND expires_at > ?`).bind(await digest(session), timestamp()).first();
}

export async function finishGoogleLogout(request, db) {
  const session = credentialCookie(request, sessionCookie);
  if (session) await db.prepare("DELETE FROM pages_sessions WHERE credential_hash = ? AND channel = 'site'").bind(await digest(session)).run();
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': setCookie(sessionCookie, '', 0), 'Cache-Control': 'no-store' } });
}

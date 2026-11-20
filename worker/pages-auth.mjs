import { pagesUrl } from '../public/assets/hosting.mjs';
import { isSessionDate } from '../public/assets/schedule.mjs';

export const pagesOrigin = new URL(pagesUrl).origin;
const credentialPattern = /^[a-f0-9]{64}$/;
const codeLifetime = 5 * 60;
const sessionLifetime = 8 * 60 * 60;
const timestamp = () => Math.floor(Date.now() / 1000);
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const randomCredential = () => hex(crypto.getRandomValues(new Uint8Array(32)));

async function digest(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

function reply(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function pagesCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', pagesOrigin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

async function bearerHash(request) {
  const authorization = request.headers.get('Authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  return credentialPattern.test(token) ? digest(token) : null;
}

export async function pagesIdentity(request, db) {
  const hash = await bearerHash(request);
  if (!hash) return null;
  return db.prepare(`
    SELECT user_id AS id, member FROM pages_sessions
    WHERE credential_hash = ? AND challenge IS NULL AND expires_at > ?
  `).bind(hash, timestamp()).first();
}

export async function beginPagesLogin(url, db, identity) {
  const challenge = url.searchParams.get('challenge') ?? '';
  if (!credentialPattern.test(challenge)) return reply({ error: 'Start sign-in from the Open Play calendar.' }, 400);
  const date = url.searchParams.get('date');
  const returnTo = '/pages/login?' + new URLSearchParams({ challenge, ...(isSessionDate(date) && { date }) });
  if (!identity.id) return Response.redirect(new URL(`/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`, url.origin));

  if (!identity.member) {
    const retry = `/signout-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`;
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UCLA email required</title><main><h1>Log in with a UCLA email</h1><p>Use your @ucla.edu or @g.ucla.edu account to sign up for Open Play.</p><p><a href="${retry}" target="_top">Switch accounts</a></p><p><a href="${pagesUrl}">Back to the calendar</a></p></main></html>`, {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  }

  const code = randomCredential();
  await db.batch([
    db.prepare('DELETE FROM pages_sessions WHERE expires_at <= ?').bind(timestamp()),
    db.prepare('INSERT INTO pages_sessions (credential_hash, challenge, user_id, member, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await digest(code), challenge, identity.id, identity.member, timestamp() + codeLifetime),
  ]);
  const destination = new URL(pagesUrl);
  if (isSessionDate(date)) destination.searchParams.set('date', date);
  destination.hash = new URLSearchParams({ code });
  return new Response(null, { status: 302, headers: { Location: destination.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

export async function handlePagesSession(request, db, logout) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
  if (logout) {
    const hash = await bearerHash(request);
    if (hash) await db.prepare('DELETE FROM pages_sessions WHERE credential_hash = ? AND challenge IS NULL').bind(hash).run();
    return reply({ ok: true });
  }
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply({ error: 'Invalid sign-in request.' }, 400);
  const { code, verifier } = (await request.json().catch(() => null)) ?? {};
  if (typeof code !== 'string' || !credentialPattern.test(code) || typeof verifier !== 'string' || !credentialPattern.test(verifier)) {
    return reply({ error: 'Start sign-in again from the calendar.' }, 400);
  }
  const token = randomCredential();
  const row = await db.prepare(`
    UPDATE pages_sessions SET credential_hash = ?, challenge = NULL, expires_at = ?
    WHERE credential_hash = ? AND challenge = ? AND expires_at > ? RETURNING user_id
  `).bind(await digest(token), timestamp() + sessionLifetime, await digest(code), await digest(verifier), timestamp()).first();
  return row ? reply({ token }) : reply({ error: 'This sign-in has expired. Try logging in again.' }, 401);
}

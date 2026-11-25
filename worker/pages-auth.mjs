import { pagesUrl } from '../public/assets/hosting.mjs';
import { isSessionDate } from '../public/assets/schedule.mjs';
import { credentialPattern, digest, randomCredential, sessionLifetime, timestamp } from './auth-primitives.mjs';

export const pagesOrigin = new URL(pagesUrl).origin;
const codeLifetime = 5 * 60;

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
    SELECT user_id AS id, member, name FROM pages_sessions
    WHERE credential_hash = ? AND channel = 'pages' AND challenge IS NULL AND expires_at > ?
  `).bind(hash, timestamp()).first();
}

export async function redirectToPages(db, challenge, identity, date) {
  const code = randomCredential();
  await db.batch([
    db.prepare('DELETE FROM pages_sessions WHERE expires_at <= ?').bind(timestamp()),
    db.prepare('INSERT INTO pages_sessions (credential_hash, challenge, user_id, member, name, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await digest(code), challenge, identity.id, identity.member, identity.name ?? null, timestamp() + codeLifetime),
  ]);
  const destination = new URL(pagesUrl);
  if (isSessionDate(date)) destination.searchParams.set('date', date);
  destination.hash = new URLSearchParams({ code });
  return new Response(null, { status: 303, headers: { Location: destination.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

export async function handlePagesSession(request, db, logout) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
  if (logout) {
    const hash = await bearerHash(request);
    if (hash) await db.prepare("DELETE FROM pages_sessions WHERE credential_hash = ? AND channel = 'pages' AND challenge IS NULL").bind(hash).run();
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
    WHERE credential_hash = ? AND channel = 'pages' AND challenge = ? AND expires_at > ? RETURNING user_id
  `).bind(await digest(token), timestamp() + sessionLifetime, await digest(code), await digest(verifier), timestamp()).first();
  return row ? reply({ token }) : reply({ error: 'This sign-in has expired. Try logging in again.' }, 401);
}

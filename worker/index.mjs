import assets from 'open-play:assets';
import { isSessionDate, pacificClock, sessionEnded } from '../public/assets/schedule.mjs';
import { beginPagesLogin, handlePagesSession, pagesCors, pagesIdentity, pagesOrigin } from './pages-auth.mjs';

function uclaAddress(email) {
  const match = /^([a-z0-9._+-]+)@(?:g\.)?ucla\.edu$/i.exec(email?.trim() ?? '');
  return match ? `${match[1].toLowerCase()}@ucla.edu` : null;
}

function siteIdentity(request) {
  const id = request.headers.get('oai-authenticated-user-id');
  const member = id ? uclaAddress(request.headers.get('oai-authenticated-user-email')) : null;
  return { id, member };
}

function viewerFor(identity, env) {
  const { id = null, member = null } = identity ?? {};
  const admins = (env.OPEN_PLAY_ADMINS ?? '').split(',').map(uclaAddress).filter(Boolean);
  return { id, member, admins: member && admins.includes(member) ? [...new Set(admins)] : null };
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function error(message, status) {
  return json({ error: message }, status);
}

async function schedule(db, viewer) {
  const { results } = await db.prepare(`
    SELECT date, status, CASE WHEN status = 'confirmed' THEN location END AS location,
      CASE WHEN status = 'confirmed' THEN (SELECT COUNT(*) FROM signups WHERE signups.date = sessions.date) ELSE 0 END AS signupCount,
      status = 'confirmed' AND EXISTS (SELECT 1 FROM signups WHERE signups.date = sessions.date AND member = ?) AS signedUp
    FROM sessions
    ORDER BY date
  `).bind(viewer.member).all();
  const sessions = results.map(({ location, signedUp, ...session }) => ({
    ...session,
    ...(location ? { location } : {}),
    signedUp: Boolean(signedUp),
  }));
  return json({ sessions, viewer: { signedIn: Boolean(viewer.id), member: Boolean(viewer.member), admins: viewer.admins } });
}

async function propose(db, viewer, date) {
  const saved = await db.prepare(`
    INSERT INTO sessions (date, proposed_by) VALUES (?, ?)
    ON CONFLICT(date) DO NOTHING RETURNING date
  `).bind(date, viewer.id).first();
  return saved ? json(saved, 201) : error('This date already has a session.', 409);
}

async function review(db, viewer, date, action, input) {
  if (!viewer.admins) return error('An admin must review this session.', 403);
  const location = typeof input === 'string' ? input.trim() : '';
  const approving = action === 'approve';
  if (approving && (!location || location.length > 160)) return error('Enter the reserved facility and court.', 400);
  const saved = await db.prepare(`
    UPDATE sessions SET status = ?, location = ?, reviewed_by = ?
    WHERE date = ? AND status = 'pending' RETURNING date
  `).bind(approving ? 'confirmed' : 'cancelled', approving ? location : null, viewer.id, date).first();
  return saved ? json(saved) : error('This session has already been reviewed or was removed.', 409);
}

async function signup(db, viewer, date, action) {
  if (action === 'leave') {
    await db.prepare('DELETE FROM signups WHERE date = ? AND member = ?').bind(date, viewer.member).run();
    return json({ date });
  }
  const inserted = await db.prepare(`
    INSERT INTO signups (date, member)
    SELECT date, ? FROM sessions WHERE date = ? AND status = 'confirmed'
    ON CONFLICT(date, member) DO NOTHING RETURNING date
  `).bind(viewer.member, date).first();
  if (inserted) return json(inserted, 201);
  const existing = await db.prepare('SELECT date FROM signups WHERE date = ? AND member = ?').bind(date, viewer.member).first();
  return existing ? json(existing) : error('Sign-ups open after an admin approves this session.', 409);
}

async function handleSchedule(request, env, url, fromPages) {
  const identity = fromPages ? await pagesIdentity(request, env.DB) : siteIdentity(request);
  const viewer = viewerFor(identity, env);
  if (request.method === 'GET') return schedule(env.DB, viewer);
  if (request.method !== 'POST') return error('Method not allowed.', 405);
  if (!viewer.member) return error('Log in with your UCLA email to continue.', viewer.id ? 403 : 401);
  if ((!fromPages && request.headers.get('Origin') !== url.origin) || !request.headers.get('content-type')?.startsWith('application/json')) {
    return error('This request is not allowed.', 403);
  }

  let input;
  try { input = await request.json(); } catch { return error('Enter a valid request.', 400); }
  const { date, action, location } = input ?? {};
  if (!isSessionDate(date)) return error('Choose a Tuesday–Friday date.', 400);
  if (sessionEnded(date, pacificClock())) return error('This date has already passed.', 400);

  switch (action) {
    case 'propose': return propose(env.DB, viewer, date);
    case 'approve':
    case 'decline': return review(env.DB, viewer, date, action, location);
    case 'join':
    case 'leave': return signup(env.DB, viewer, date, action);
    default: return error('Choose a valid schedule action.', 400);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/pages/login' && request.method === 'GET') {
      try { return await beginPagesLogin(url, env.DB, siteIdentity(request)); } catch {
        return error('Sign-in is temporarily unavailable. Try again shortly.', 503);
      }
    }
    const isSchedule = url.pathname === '/api/schedule';
    const isPagesSession = url.pathname === '/api/pages/session' || url.pathname === '/api/pages/logout';
    if (isSchedule || isPagesSession) {
      const fromPages = request.headers.get('Origin') === pagesOrigin;
      if (isPagesSession && !fromPages) return error('This request is not allowed.', 403);
      if (fromPages && request.method === 'OPTIONS') return pagesCors(new Response(null, { status: 204 }));
      let result;
      try {
        result = isSchedule
          ? await handleSchedule(request, env, url, fromPages)
          : await handlePagesSession(request, env.DB, url.pathname === '/api/pages/logout');
      } catch (exception) {
        console.error('Open play request failed:', exception.message);
        result = error('Open Play is temporarily unavailable. Try again shortly.', 503);
      }
      return fromPages ? pagesCors(result) : result;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!Object.hasOwn(assets, path)) return new Response('Not found', { status: 404 });
    const { body, type, binary } = assets[path];
    const data = binary ? Uint8Array.from(atob(body), character => character.charCodeAt(0)) : body;
    return new Response(request.method === 'HEAD' ? null : data, {
      headers: { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
    });
  },
};

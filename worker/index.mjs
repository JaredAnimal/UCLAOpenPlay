import assets from 'open-play:assets';
import { DEFAULT_COURT, cleanName, displayName, isSessionDate, pacificClock, sessionEnded, sessionTime, validHours } from '../public/assets/schedule.mjs';
import { handlePagesSession, pagesCors, pagesIdentity, pagesOrigin } from './pages-auth.mjs';
import { credentialPattern, digest, uclaAddress } from './auth-primitives.mjs';
import { finishGoogleLogin, finishGoogleLogout, googleIdentity, startGoogleLogin } from './google-auth.mjs';

async function viewerFor(identity, env) {
  // `suggestedName` is Google's; `name` is the one saved in `members`. Signed-out viewers get neither suggestion nor name.
  const { id = null, member = null, name: suggestedName } = identity ?? {};
  const viewer = { id, member, name: null, suggestedName, admins: null };
  if (!member) return viewer;
  viewer.name = (await env.DB.prepare('SELECT name FROM members WHERE email = ?').bind(member).first())?.name ?? null;
  const initialAdmins = (env.OPEN_PLAY_ADMINS ?? '').split(',').map(uclaAddress).filter(Boolean);
  const { results } = await env.DB.prepare('SELECT email FROM admins').bind().all();
  const admins = [...new Set([...initialAdmins, ...results.map(row => row.email)])].sort();
  if (admins.includes(member)) viewer.admins = admins;
  return viewer;
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function error(message, status) {
  return json({ error: message }, status);
}

async function schedule(db, viewer) {
  const { results } = await db.prepare(`
    SELECT date, status,
      CASE WHEN status = 'confirmed' OR (?3 AND status = 'pending') THEN location END AS location,
      CASE WHEN status = 'confirmed' THEN (SELECT COUNT(*) FROM signups WHERE signups.date = sessions.date) ELSE 0 END AS signupCount,
      status = 'confirmed' AND EXISTS (SELECT 1 FROM signups WHERE signups.date = sessions.date AND member = ?1) AS signedUp,
      start_hour, end_hour,
      CASE WHEN ?2 AND status = 'confirmed' THEN (SELECT json_group_array(json_array(saved, legacy, member)) FROM (
        SELECT members.name AS saved, signups.name AS legacy, signups.member AS member
        FROM signups LEFT JOIN members ON members.email = signups.member
        WHERE signups.date = sessions.date ORDER BY signups.rowid
      )) END AS players
    FROM sessions
    ORDER BY date
  `).bind(viewer.member, viewer.member ? 1 : 0, viewer.admins ? 1 : 0).all();
  const sessions = results.map(({ location, signedUp, start_hour, end_hour, players, ...session }) => ({
    ...session,
    ...(location ? { location } : {}),
    // Only admins see a pending proposal's hours and court (to review them); everyone sees the `time`.
    ...(viewer.admins && session.status === 'pending' && start_hour ? { startHour: start_hour, endHour: end_hour } : {}),
    signedUp: Boolean(signedUp),
    time: sessionTime(start_hour, end_hour),
    // Old sign-ups kept their short name; a saved name wins, and with neither it is the email's local part.
    ...(players ? { players: JSON.parse(players).map(([saved, legacy, member]) => saved ? displayName(saved, member) : legacy ?? displayName(null, member)) } : {}),
  }));
  const { id, member, admins, name, suggestedName } = viewer;
  return json({ sessions, viewer: { signedIn: Boolean(id), member: Boolean(member), admins, name, suggestedName } });
}

async function saveName(db, viewer, input) {
  const name = cleanName(input);
  if (!name) return error('Enter your name: 2 to 60 characters, with at least one letter.', 400);
  await db.prepare('INSERT INTO members (email, name) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name').bind(viewer.member, name).run();
  return json({ name });
}

async function addAdmin(db, viewer, input) {
  if (!viewer.admins) return error('Only admins can add other admins.', 403);
  const email = uclaAddress(input);
  if (!email) return error('Enter a UCLA email address.', 400);
  if (!viewer.admins.includes(email)) {
    await db.prepare('INSERT INTO admins (email, added_by) VALUES (?, ?) ON CONFLICT(email) DO NOTHING').bind(email, viewer.id).run();
  }
  return json({ email });
}

// Hours and court for a night. A field left out takes its `kept` value; a field that is sent must be valid (null is not "left out").
function nightFields(kept, { startHour = kept.startHour, endHour = kept.endHour, location = kept.location }) {
  const court = typeof location === 'string' ? location.trim() : '';
  if (!validHours(startHour, endHour)) return { problem: 'Choose hours from 8 AM to 12 AM, with the end after the start.' };
  if (!court || court.length > 160) return { problem: 'Enter the reserved facility and court, up to 160 characters.' };
  return { startHour, endHour, court };
}

// A student's post is a pending proposal. An admin's confirms the night at once, unless it is already confirmed.
async function propose(db, viewer, date, input) {
  const night = nightFields({ startHour: 18, endHour: 20, location: DEFAULT_COURT }, input);
  if (night.problem) return error(night.problem, 400);
  const posting = Boolean(viewer.admins);
  const saved = await db.prepare(`
    INSERT INTO sessions (date, status, location, proposed_by, reviewed_by, start_hour, end_hour) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(date) DO UPDATE SET status = excluded.status, location = excluded.location, reviewed_by = excluded.reviewed_by,
      start_hour = excluded.start_hour, end_hour = excluded.end_hour
    WHERE excluded.status = 'confirmed' AND sessions.status <> 'confirmed'
    RETURNING date
  `).bind(date, posting ? 'confirmed' : 'pending', night.court, viewer.id, posting ? viewer.id : null, night.startHour, night.endHour).first();
  return saved ? json(saved, 201) : error('This date already has a session.', 409);
}

async function approve(db, viewer, date, input) {
  const row = await db.prepare('SELECT location, start_hour, end_hour FROM sessions WHERE date = ?').bind(date).first();
  const night = nightFields({ startHour: row?.start_hour ?? 18, endHour: row?.end_hour ?? 20, location: row?.location ?? undefined }, input);
  if (night.problem) return error(night.problem, 400);
  const saved = await db.prepare(`
    UPDATE sessions SET status = 'confirmed', location = ?, start_hour = ?, end_hour = ?, reviewed_by = ?
    WHERE date = ? AND status = 'pending' RETURNING date
  `).bind(night.court, night.startHour, night.endHour, viewer.id, date).first();
  return saved ? json(saved) : error('This session has already been reviewed or was removed.', 409);
}

// Declining a pending proposal and cancelling a confirmed night both end as 'cancelled'; sign-ups are kept.
async function close(db, viewer, date, from) {
  const saved = await db.prepare(`
    UPDATE sessions SET status = 'cancelled', location = NULL, reviewed_by = ?
    WHERE date = ? AND status = ? RETURNING date
  `).bind(viewer.id, date, from).first();
  return saved ? json(saved) : error(from === 'pending' ? 'This session has already been reviewed or was removed.' : 'Only a confirmed night can be cancelled.', 409);
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
  const existing = await db.prepare(`
    SELECT signups.date FROM signups JOIN sessions ON sessions.date = signups.date
    WHERE signups.date = ? AND member = ? AND status = 'confirmed'
  `).bind(date, viewer.member).first();
  return existing ? json(existing) : error('Sign-ups open after an admin approves this session.', 409);
}

// Picklebot (server to server, no Origin) reports a booked court hour; the night becomes confirmed.
async function botSession(request, env) {
  if (request.method !== 'POST') return error('Method not allowed.', 405);
  const sent = (request.headers.get('Authorization') ?? '').match(/^Bearer (.+)$/)?.[1];
  if (!sent || !env.OPEN_PLAY_BOT_TOKEN || await digest(sent) !== await digest(env.OPEN_PLAY_BOT_TOKEN)) {
    return error('Not authorized.', 401);
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) return error('Send JSON.', 400);
  let input;
  try { input = await request.json(); } catch { return error('Enter a valid request.', 400); }
  const { date, hour } = input ?? {};
  if (!isSessionDate(date) || sessionEnded(date, pacificClock())) return error('Choose a date that has not ended.', 400);
  if (!Number.isInteger(hour) || hour < 13 || hour > 23) return error('Choose an hour from 13 to 23.', 400);
  // Hours merge only into an already confirmed night; a proposal's or a cancelled night's hours give way to the bot's.
  // ponytail: min/max merge assumes adjacent hours; non-adjacent bookings would show one wide span.
  const saved = await env.DB.prepare(`
    INSERT INTO sessions (date, status, location, proposed_by, reviewed_by, start_hour, end_hour)
    VALUES (?1, 'confirmed', ?2, 'bot', 'bot', ?3, ?3 + 1)
    ON CONFLICT(date) DO UPDATE SET status = 'confirmed', location = excluded.location, reviewed_by = 'bot',
      start_hour = CASE WHEN sessions.status = 'confirmed' THEN MIN(COALESCE(sessions.start_hour, excluded.start_hour), excluded.start_hour) ELSE excluded.start_hour END,
      end_hour = CASE WHEN sessions.status = 'confirmed' THEN MAX(COALESCE(sessions.end_hour, excluded.end_hour), excluded.end_hour) ELSE excluded.end_hour END
    RETURNING date, start_hour, end_hour
  `).bind(date, DEFAULT_COURT, hour).first();
  return json({ date, time: sessionTime(saved.start_hour, saved.end_hour) });
}

async function handleCalendarApi(request, env, url, fromPages) {
  const viewer = await viewerFor(fromPages ? await pagesIdentity(request, env.DB) : await googleIdentity(request, env.DB), env);
  if (request.method === 'GET' && url.pathname === '/api/schedule') return schedule(env.DB, viewer);
  if (request.method !== 'POST') return error('Method not allowed.', 405);
  if (!viewer.member) return error('Log in with your UCLA email to continue.', 401);
  if ((!fromPages && request.headers.get('Origin') !== url.origin) || !request.headers.get('content-type')?.startsWith('application/json')) {
    return error('This request is not allowed.', 403);
  }

  let input;
  try { input = await request.json(); } catch { return error('Enter a valid request.', 400); }
  if (url.pathname === '/api/admins') return addAdmin(env.DB, viewer, input?.email);
  if (url.pathname === '/api/name') return saveName(env.DB, viewer, input?.name);
  const { date, action } = input ?? {};
  if (!isSessionDate(date)) return error('Choose a date.', 400);
  if (sessionEnded(date, pacificClock())) return error('This date has already passed.', 400);
  if ((action === 'propose' || action === 'join') && !viewer.name) return error('Confirm your name first.', 409);
  if (['approve', 'decline', 'cancel'].includes(action) && !viewer.admins) return error('Only admins can do this.', 403);

  switch (action) {
    case 'propose': return propose(env.DB, viewer, date, input);
    case 'approve': return approve(env.DB, viewer, date, input);
    case 'decline': return close(env.DB, viewer, date, 'pending');
    case 'cancel': return close(env.DB, viewer, date, 'confirmed');
    case 'join':
    case 'leave': return signup(env.DB, viewer, date, action);
    default: return error('Choose a valid schedule action.', 400);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((url.pathname === '/auth/login' || url.pathname === '/pages/login') && request.method === 'GET') {
      if (url.pathname === '/pages/login' && !credentialPattern.test(url.searchParams.get('challenge') ?? '')) {
        return error('Start sign-in from the Open Play calendar.', 400);
      }
      return Response.redirect(new URL(`/auth/google/start${url.search}`, url.origin));
    }
    if (url.pathname.startsWith('/auth/google/')) {
      try {
        if (url.pathname === '/auth/google/start' && request.method === 'GET') return startGoogleLogin(url);
        if (url.pathname === '/auth/google/callback') return await finishGoogleLogin(request, url, env);
        if (url.pathname === '/auth/google/logout' && request.method === 'POST' && request.headers.get('Origin') === url.origin) {
          return await finishGoogleLogout(request, env.DB);
        }
      } catch {
        return error('Google sign-in is temporarily unavailable. Try again shortly.', 503);
      }
      return error('This request is not allowed.', 403);
    }
    if (url.pathname === '/api/bot/session') {
      try { return await botSession(request, env); } catch (exception) {
        console.error('Open play bot request failed:', exception.message);
        return error('Open Play is temporarily unavailable. Try again shortly.', 503);
      }
    }
    const isCalendarApi = ['/api/schedule', '/api/admins', '/api/name'].includes(url.pathname);
    const isPagesSession = url.pathname === '/api/pages/session' || url.pathname === '/api/pages/logout';
    if (isCalendarApi || isPagesSession) {
      const fromPages = request.headers.get('Origin') === pagesOrigin;
      if (isPagesSession && !fromPages) return error('This request is not allowed.', 403);
      if (fromPages && request.method === 'OPTIONS') return pagesCors(new Response(null, { status: 204 }));
      let result;
      try {
        result = isCalendarApi
          ? await handleCalendarApi(request, env, url, fromPages)
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

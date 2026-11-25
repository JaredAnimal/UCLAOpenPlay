import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../dist/server/index.js';
import { currentWeek, pacificClock, addDays } from '../public/assets/schedule.mjs';
import { backendUrl, pagesUrl } from '../public/assets/hosting.mjs';
import { digest, randomCredential, sessionLifetime, timestamp, uclaAddress } from '../worker/auth-primitives.mjs';
import { googleClientId } from '../worker/google-auth.mjs';

const origin = 'https://open-play.test';
const date = addDays(currentWeek(pacificClock().date).first, 8);
const admin = { id: 'organizer', email: 'ADMIN@g.ucla.edu' };
const student = { id: 'student', email: 'player@ucla.edu' };
const outside = { id: 'outsider', email: 'outsider@example.com' };
const migrations = new URL('../migrations/', import.meta.url);
const files = (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort();
const scripts = await Promise.all(files.map(file => readFile(new URL(file, migrations), 'utf8')));
const sql = scripts.join('\n');
const google = 'https://accounts.google.com';
const sessionName = '__Host-open-play-session';
const stateName = '__Host-open-play-state';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const key = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256' };

function setup(t, env = {}) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(sql);
  const fault = {};
  const DB = {
    prepare(query) {
      const statement = sqlite.prepare(query);
      return {
        bind(...args) {
          return { first: () => statement.get(...args), all: () => ({ results: statement.all(...args) }), run: () => statement.run(...args) };
        },
      };
    },
    batch: statements => {
      if (fault.batch) throw new Error('database down');
      return statements.map(statement => statement.run());
    },
  };
  return Object.assign(async (who = {}, data, source = origin, { base = origin, path = '/api/schedule', method = data ? 'POST' : 'GET', token, cookie, form, headers: extra } = {}) => {
    const headers = new Headers(extra);
    const member = uclaAddress(who.email);
    if (who.id && member) {
      const session = randomCredential();
      sqlite.prepare("INSERT INTO pages_sessions (credential_hash, user_id, member, name, expires_at, channel) VALUES (?, ?, ?, ?, ?, 'site')")
        .run(await digest(session), `google:${who.id}`, member, who.name ?? null, timestamp() + sessionLifetime);
      headers.set('Cookie', `${sessionName}=${session}`);
      // A saved name unless the test passes `saved: null`; `name` is only what Google suggests.
      if (who.saved !== null) {
        sqlite.prepare('INSERT OR IGNORE INTO members (email, name) VALUES (?, ?)').run(member, who.saved ?? who.name ?? member.split('@')[0]);
      }
    }
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (cookie) headers.set('Cookie', cookie);
    if (source) headers.set('Origin', source);
    if (data) headers.set('Content-Type', 'application/json');
    if (form) headers.set('Content-Type', 'application/x-www-form-urlencoded');
    const body = form ? new URLSearchParams(form).toString() : data && JSON.stringify(data);
    return worker.fetch(new Request(`${base}${path}`, { method, headers, body }), { DB, OPEN_PLAY_ADMINS: 'admin@ucla.edu', ...env });
  }, { sqlite, fault });
}

// Google's fake side of the sign-in: a signed ID token posted to the callback with the state cookie.
function googleSide(t, request) {
  t.mock.method(globalThis, 'fetch', async input => {
    assert.equal(String(input instanceof Request ? input.url : input), 'https://www.googleapis.com/oauth2/v3/certs');
    return Response.json({ keys: [key] });
  });
  const idToken = (claims, { audience = googleClientId, expires = timestamp() + 120, signer = privateKey, kid = key.kid } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).setIssuer(google).setAudience(audience)
      .setSubject('mock-google-id').setExpirationTime(expires).sign(signer);
  const cookieValue = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
  return {
    cookieValue,
    async start(path = '/auth/google/start', base = origin) {
      const response = await request({}, undefined, origin, { path, base });
      const destination = new URL(response.headers.get('Location'));
      return { response, destination, cookie: cookieValue(response, stateName).split(';')[0], state: destination.searchParams.get('state'), nonce: destination.searchParams.get('nonce') };
    },
    async finish(login, { email = 'Admin@g.ucla.edu', verified = true, name, claims, form, cookie = login.cookie, base = origin, ...options } = {}) {
      const token = await idToken({ nonce: login.nonce, email, email_verified: verified, ...(name && { name }), ...claims }, options);
      return request({}, undefined, google, { path: '/auth/google/callback', method: 'POST', base, cookie, form: { state: login.state, id_token: token, ...form } });
    },
  };
}

test('UCLA proposals stay tentative until an admin approves; approved sessions accept one RSVP per UCLA mailbox', async t => {
  const request = setup(t);
  const proposal = { date, action: 'propose' };
  const approval = { date, action: 'approve', location: 'Sunset Rec · Tennis Court 2' };
  const join = { date, action: 'join' };
  assert.equal((await request(undefined, proposal)).status, 401);
  assert.equal((await request({ email: admin.email }, proposal)).status, 401);
  assert.equal((await request(outside, proposal)).status, 401);
  assert.equal((await request(student, proposal, 'https://other.test')).status, 403);
  assert.equal((await request(student, { ...proposal, date: '2026-02-30' })).status, 400);
  assert.equal((await request(student, proposal)).status, 201);
  assert.equal((await request(student, proposal)).status, 409);
  assert.equal((await request(student, approval)).status, 403);
  assert.equal((await request(admin, { ...approval, location: ' ' })).status, 400);
  assert.equal((await request(admin, join)).status, 409);
  const anonymous = await (await request()).json();
  assert.deepEqual(anonymous.sessions, [{ date, status: 'pending', signupCount: 0, signedUp: false, time: '6–8 PM' }]);
  assert.deepEqual(anonymous.viewer, { signedIn: false, member: false, admins: null, name: null });
  assert.deepEqual((await (await request(admin)).json()).viewer.admins, ['admin@ucla.edu']);
  assert.equal((await request(admin, approval)).status, 200);
  assert.equal((await request(admin, { date, action: 'decline' })).status, 409);
  assert.equal((await request(outside, join)).status, 401);
  assert.equal((await request(student, join)).status, 201);
  assert.equal((await request({ id: 'student-alias', email: 'player@g.ucla.edu' }, join)).status, 200);
  const count = (await (await request()).json()).sessions[0];
  assert.deepEqual(count, { date, status: 'confirmed', location: approval.location, signupCount: 1, signedUp: false, time: '6–8 PM' });
  assert.equal((await (await request(student)).json()).sessions[0].signedUp, true);
  assert.equal((await request(admin, { date, action: 'leave' })).status, 200);
  assert.equal((await (await request(student)).json()).sessions[0].signupCount, 1);
  assert.equal((await request(student, { date, action: 'leave' })).status, 200);
  assert.equal((await (await request(student)).json()).sessions[0].signupCount, 0);
});

test('any weekday can hold a session; only members see who signed up', async t => {
  const request = setup(t);
  const saturday = addDays(currentWeek(pacificClock().date).first, 12);
  assert.equal((await request(student, { date: saturday, action: 'propose' })).status, 201);
  assert.equal((await request(admin, { date: saturday, action: 'approve', location: 'Tennis Court 2' })).status, 200);
  assert.equal((await request(student, { date: saturday, action: 'join' })).status, 201);
  assert.equal((await request(student, { date: 'nope', action: 'join' })).status, 400);
  const member = (await (await request(student)).json()).sessions[0];
  assert.deepEqual(member.players, ['player']);
  assert.equal(member.time, '6–8 PM');
  const visitor = (await (await request()).json()).sessions[0];
  assert.equal('players' in visitor, false);
  assert.equal(visitor.signupCount, 1);
});

test('a name is confirmed once, shown to others as First L., and an edit reaches existing sign-ups', async t => {
  const request = setup(t);
  const nameApi = { path: '/api/name' };
  const saveName = (who, name, source = origin) => request(who, { name }, source, nameApi);
  const members = () => request.sqlite.prepare("SELECT COUNT(*) AS n FROM members WHERE email = 'maya@ucla.edu'").get().n;
  const maya = { id: 'maya', email: 'maya@ucla.edu', name: 'Maya Lopez', saved: null };
  const sam = { id: 'sam', email: 'sam@ucla.edu', saved: null };
  const viewerOf = async who => (await (await request(who)).json()).viewer;

  assert.equal((await saveName(undefined, 'Maya Lopez')).status, 401);
  assert.equal((await saveName(maya, 'Maya Lopez', 'https://other.test')).status, 403);
  for (const bad of ['', '   ', 'A', '🎾🎾', 'x'.repeat(61), 'Maya​Lopez', '<b>Maya', 42, undefined]) {
    assert.equal((await saveName(maya, bad)).status, 400, String(bad));
  }
  assert.equal(members(), 0);
  assert.deepEqual(await viewerOf(maya), { signedIn: true, member: true, admins: null, name: null, suggestedName: 'Maya Lopez' });
  assert.equal((await viewerOf(sam)).suggestedName, null);

  assert.equal((await request(admin, { date, action: 'propose' })).status, 201);
  for (const action of ['join', 'propose']) {
    const refused = await request(maya, { date, action });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: 'Confirm your name first.' });
  }
  assert.equal((await request(maya, { date, action: 'leave' })).status, 200);

  assert.deepEqual(await (await saveName(maya, ' Maya   Lopez ')).json(), { name: 'Maya Lopez' });
  assert.equal(members(), 1);
  assert.deepEqual(await viewerOf(maya), { signedIn: true, member: true, admins: null, name: 'Maya Lopez', suggestedName: 'Maya Lopez' });
  assert.equal((await viewerOf(sam)).name, null);
  assert.equal((await request(maya, { date, action: 'join' })).status, 201);
  assert.equal((await saveName(sam, 'Sam Park')).status, 200);
  assert.equal((await request(sam, { date, action: 'join' })).status, 201);
  request.sqlite.prepare('INSERT INTO signups (date, member, name) VALUES (?, ?, ?)').run(date, 'old@ucla.edu', 'Old P.');
  request.sqlite.prepare('INSERT INTO signups (date, member) VALUES (?, ?)').run(date, 'bare@ucla.edu');
  const players = async who => (await (await request(who)).json()).sessions[0].players;
  assert.deepEqual(await players(maya), ['Maya L.', 'Sam P.', 'Old P.', 'bare']);

  assert.equal((await saveName(maya, 'María José Núñez')).status, 200);
  assert.deepEqual(await players(sam), ['María N.', 'Sam P.', 'Old P.', 'bare']);
  assert.equal((await viewerOf(sam)).name, 'Sam Park');
  assert.equal(request.sqlite.prepare('SELECT COUNT(*) AS n FROM signups WHERE name IS NOT NULL').get().n, 1);
  assert.equal('players' in (await (await request()).json()).sessions[0], false);
});

test('admin actions and the bot never need a saved name', async t => {
  const request = setup(t);
  const bare = { ...admin, saved: null };
  assert.equal((await request(bare, { date, action: 'propose' })).status, 409);
  assert.equal((await request(student, { date, action: 'propose' })).status, 201);
  assert.equal((await request(bare, { date, action: 'approve', location: 'Tennis Court 2' })).status, 200);
  const later = addDays(date, 1);
  assert.equal((await request(student, { date: later, action: 'propose' })).status, 201);
  assert.equal((await request(bare, { date: later, action: 'decline' })).status, 200);
  assert.equal((await request(bare, { email: 'new.admin@ucla.edu' }, origin, { path: '/api/admins' })).status, 200);
  assert.equal(request.sqlite.prepare('SELECT COUNT(*) AS n FROM members WHERE email = ?').get('admin@ucla.edu').n, 0);
});

test('nights carry hours and a court: students propose, admins post, approve and cancel', async t => {
  const request = setup(t);
  const court = 'Sunset Rec Tennis Court 2';
  const other = { id: 'other', email: 'other@ucla.edu' };
  const day = offset => addDays(date, offset);
  const act = (who, offset, body) => request(who, { date: day(offset), ...body });
  const rows = async who => (await (await request(who)).json()).sessions;
  const row = async (who, offset) => (await rows(who)).find(session => session.date === day(offset));
  const stored = offset => request.sqlite.prepare('SELECT * FROM sessions WHERE date = ?').get(day(offset));

  for (const bad of [
    { startHour: 7 }, { startHour: '18' }, { startHour: 18.5 }, { startHour: null }, { endHour: null }, { startHour: 20, endHour: 20 },
    { endHour: 25 }, { startHour: 21 }, { endHour: 18 }, { location: '   ' }, { location: 'x'.repeat(161) }, { location: 5 }, { location: null },
  ]) {
    assert.equal((await act(student, 1, { action: 'propose', ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(await rows(), []);

  assert.equal((await act(student, 1, { action: 'propose', startHour: 19, endHour: 21, location: ' Court 5 ' })).status, 201);
  const pending = { date: day(1), status: 'pending', signupCount: 0, signedUp: false, time: '7–9 PM' };
  assert.deepEqual(await row(undefined, 1), pending);
  assert.deepEqual(await row(other, 1), pending);
  assert.deepEqual(await row(student, 1), pending);
  assert.deepEqual(await row(admin, 1), { ...pending, location: 'Court 5', startHour: 19, endHour: 21 });
  assert.equal((await act(student, 1, { action: 'propose' })).status, 409);

  assert.equal((await act(admin, 1, { action: 'approve', startHour: 21 })).status, 400);
  assert.equal((await act(admin, 1, { action: 'approve', startHour: 18, endHour: 20, location: court })).status, 200);
  assert.deepEqual(await row(undefined, 1), { date: day(1), status: 'confirmed', location: court, signupCount: 0, signedUp: false, time: '6–8 PM' });
  assert.equal((await act(admin, 1, { action: 'propose' })).status, 409);
  assert.equal((await act(student, 1, { action: 'propose' })).status, 409);

  // A request that only names the date and court (the old front end) keeps the proposal's hours.
  assert.equal((await act(student, 2, { action: 'propose', startHour: 19, endHour: 21 })).status, 201);
  assert.equal((await act(admin, 2, { action: 'approve', location: 'Court 2' })).status, 200);
  assert.equal((await row(admin, 2)).time, '7–9 PM');
  assert.equal((await act(student, 3, { action: 'propose' })).status, 201);
  request.sqlite.prepare('UPDATE sessions SET location = NULL WHERE date = ?').run(day(3));
  assert.equal((await act(admin, 3, { action: 'approve' })).status, 400);
  assert.equal((await act(admin, 3, { action: 'approve', location: ' ' })).status, 400);

  // Admins post straight to confirmed, and re-post over a pending or cancelled date.
  assert.equal((await act(admin, 4, { action: 'propose', startHour: 18, endHour: 19, location: 'Court 9' })).status, 201);
  assert.deepEqual(await row(undefined, 4), { date: day(4), status: 'confirmed', location: 'Court 9', signupCount: 0, signedUp: false, time: '6–7 PM' });
  assert.equal(stored(4).reviewed_by, 'google:organizer');
  assert.equal((await act(admin, 4, { action: 'propose' })).status, 409);
  assert.equal((await act(admin, 3, { action: 'propose', startHour: 17, endHour: 19, location: 'Court 3' })).status, 201);
  assert.deepEqual(await row(undefined, 3), { date: day(3), status: 'confirmed', location: 'Court 3', signupCount: 0, signedUp: false, time: '5–7 PM' });
  assert.deepEqual([stored(3).proposed_by, stored(3).reviewed_by], ['google:student', 'google:organizer']);
  assert.equal((await act(admin, 5, { action: 'propose' })).status, 201);
  assert.equal((await act(admin, 5, { action: 'cancel' })).status, 200);
  assert.equal((await act(admin, 5, { action: 'propose', location: 'Court 4' })).status, 201);
  assert.equal((await row(undefined, 5)).location, 'Court 4');

  // Cancelling: admins only, only a confirmed upcoming night; sign-ups stay but stop counting.
  assert.equal((await act(student, 4, { action: 'join' })).status, 201);
  assert.equal((await act(student, 4, { action: 'cancel' })).status, 403);
  assert.equal((await act(undefined, 4, { action: 'cancel' })).status, 401);
  assert.equal((await act(admin, 4, { action: 'cancel' })).status, 200);
  assert.deepEqual(await row(student, 4), { date: day(4), status: 'cancelled', signupCount: 0, signedUp: false, time: '6–7 PM' });
  assert.equal(stored(4).location, null);
  assert.equal(request.sqlite.prepare('SELECT COUNT(*) AS n FROM signups WHERE date = ?').get(day(4)).n, 1);
  assert.equal((await act(admin, 4, { action: 'cancel' })).status, 409);
  assert.equal((await act(student, 4, { action: 'join' })).status, 409);
  assert.equal((await act(admin, 6, { action: 'cancel' })).status, 409);
  assert.equal((await request(admin, { date: '2020-01-01', action: 'cancel' })).status, 400);
});

test('a night that runs until midnight is still open at 8:05 PM on its day', async t => {
  const at = offset => new Date(`${date}T20:05:00${offset}`);
  const evening = [at('-08:00'), at('-07:00')].find(time => time.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }) === '20');
  t.mock.timers.enable({ apis: ['Date'], now: evening });
  assert.equal(pacificClock().date, date);
  const request = setup(t);
  assert.equal((await request(admin, { date, action: 'propose', startHour: 21, endHour: 23 })).status, 201);
  assert.equal((await request(student, { date, action: 'join' })).status, 201);
  assert.equal((await request(admin, { date, action: 'cancel' })).status, 200);
});

test('a session row that is not from a Google sign-in signs nobody in, on the Site cookie or a Pages token', async t => {
  const request = setup(t);
  const pagesOrigin = new URL(pagesUrl).origin;
  const site = randomCredential();
  const pages = randomCredential();
  const insert = request.sqlite.prepare('INSERT INTO pages_sessions (credential_hash, user_id, member, expires_at, channel) VALUES (?, ?, ?, ?, ?)');
  insert.run(await digest(site), 'chatgpt-1', 'admin@ucla.edu', timestamp() + 3600, 'site');
  insert.run(await digest(pages), 'chatgpt-1', 'admin@ucla.edu', timestamp() + 3600, 'pages');
  for (const [label, source, options] of [['site', origin, { cookie: `${sessionName}=${site}` }], ['pages', pagesOrigin, { token: pages }]]) {
    assert.equal((await request({}, { date, action: 'propose' }, source, options)).status, 401, label);
    assert.equal((await (await request({}, undefined, source, options)).json()).viewer.signedIn, false, label);
  }
});

test('the bot takes its own hours unless an admin-confirmed night already has some', async t => {
  const token = 'bot-secret-token';
  const request = setup(t, { OPEN_PLAY_BOT_TOKEN: token });
  const bot = (offset, hour) => request({}, { date: addDays(date, offset), hour }, null, { path: '/api/bot/session', token }).then(response => response.json());
  const act = (who, offset, body) => request(who, { date: addDays(date, offset), ...body });

  await act(student, 0, { action: 'propose', startHour: 18, endHour: 20 });
  assert.equal((await bot(0, 19)).time, '7–8 PM');
  await act(admin, 1, { action: 'propose', startHour: 18, endHour: 20 });
  await act(admin, 1, { action: 'cancel' });
  assert.equal((await bot(1, 18)).time, '6–7 PM');
  await act(admin, 2, { action: 'propose', startHour: 18, endHour: 19 });
  assert.equal((await bot(2, 19)).time, '6–8 PM');
  request.sqlite.prepare("INSERT INTO sessions (date, status, location, proposed_by) VALUES (?, 'confirmed', 'Court 1', 'x')").run(addDays(date, 3));
  assert.equal((await bot(3, 19)).time, '7–8 PM');
  assert.equal((await (await request()).json()).sessions.find(session => session.date === addDays(date, 0)).location, 'Sunset Rec Tennis Court 2');
});

test('GitHub Pages redeems a one-time code from a Google sign-in and uses a separately revocable 90-day API session', async t => {
  const request = setup(t);
  const side = googleSide(t, request);
  const pagesOrigin = new URL(pagesUrl).origin;
  const verifier = '1'.repeat(64);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = Buffer.from(bytes).toString('hex');
  const exchange = { path: '/api/pages/session' };
  const proposal = { date, action: 'propose' };
  assert.equal((await request({}, undefined, origin, { path: '/pages/login' })).status, 400);
  assert.equal((await request({}, undefined, origin, { path: '/pages/login?challenge=nope' })).status, 400);
  const entry = new URL((await request({}, undefined, origin, { path: `/pages/login?challenge=${challenge}&date=${date}` })).headers.get('Location'));
  assert.equal(entry.pathname + entry.search, `/auth/google/start?challenge=${challenge}&date=${date}`);
  assert.equal((await request(student, proposal, pagesOrigin)).status, 401);
  const preflight = await request({}, undefined, pagesOrigin, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), pagesOrigin);
  const redirectBack = await side.finish(await side.start(entry.pathname + entry.search));
  assert.equal(redirectBack.status, 303);
  const destination = new URL(redirectBack.headers.get('Location'));
  assert.equal(destination.href.split('?')[0], pagesUrl);
  assert.equal(destination.searchParams.get('date'), date);
  const code = new URLSearchParams(destination.hash.slice(1)).get('code');
  assert.match(code, /^[a-f0-9]{64}$/);
  assert.equal((await request({}, { code, verifier: '2'.repeat(64) }, pagesOrigin, exchange)).status, 401);
  assert.equal((await request({}, { code, verifier }, 'https://another.example', exchange)).status, 403);
  const accepted = await request({}, { code, verifier }, pagesOrigin, exchange);
  assert.equal(accepted.status, 200);
  const { token } = await accepted.json();
  const { expires_at } = request.sqlite.prepare("SELECT expires_at FROM pages_sessions WHERE channel = 'pages' AND challenge IS NULL").get();
  assert.ok(Math.abs(expires_at - (timestamp() + 90 * 24 * 60 * 60)) <= 5);
  assert.equal((await request({}, { code, verifier }, pagesOrigin, exchange)).status, 401);
  assert.equal((await request({}, proposal, pagesOrigin, { token })).status, 409);
  const named = await request({}, { name: ' Pages  Admin ' }, pagesOrigin, { token, path: '/api/name' });
  assert.deepEqual(await named.json(), { name: 'Pages Admin' });
  assert.equal(named.headers.get('Access-Control-Allow-Origin'), pagesOrigin);
  assert.equal((await request({}, undefined, pagesOrigin, { method: 'OPTIONS', path: '/api/name' })).status, 204);
  assert.equal((await request({}, proposal, pagesOrigin, { token })).status, 201);
  const signedIn = await (await request({}, undefined, pagesOrigin, { token })).json();
  assert.deepEqual(signedIn.viewer.admins, ['admin@ucla.edu']);
  assert.equal((await request({}, { date, action: 'join' }, pagesOrigin, { token })).status, 201);
  assert.equal((await request({}, {}, pagesOrigin, { path: '/api/pages/logout', token })).status, 200);
  assert.equal((await request({}, { date, action: 'leave' }, pagesOrigin, { token })).status, 401);
});

test('declining a tentative night closes it to approvals and RSVPs', async t => {
  const request = setup(t);
  assert.equal((await request(student, { date, action: 'propose' })).status, 201);
  assert.equal((await request(admin, { date, action: 'decline' })).status, 200);
  assert.equal((await request(student, { date, action: 'join' })).status, 409);
  assert.equal((await request(admin, { date, action: 'approve', location: 'Tennis Court 2' })).status, 409);
  assert.equal((await (await request()).json()).sessions[0].status, 'cancelled');
});

test('admins can grant another verified UCLA address access without disclosing the list to members', async t => {
  const request = setup(t);
  const path = { path: '/api/admins' };
  const proposal = { date, action: 'propose' };
  assert.equal((await request(undefined, { email: student.email }, origin, path)).status, 401);
  assert.equal((await request(student, { email: student.email }, origin, path)).status, 403);
  assert.equal((await request(admin, { email: outside.email }, origin, path)).status, 400);
  assert.equal((await request(admin, { email: student.email }, 'https://different.test', path)).status, 403);
  assert.deepEqual(await (await request(admin, { email: 'Player@g.ucla.edu' }, origin, path)).json(), { email: student.email });
  assert.equal((await request(admin, { email: student.email }, origin, path)).status, 200);
  assert.equal((await request(student, proposal)).status, 201);
  assert.equal((await request(student, { date, action: 'cancel' })).status, 200);
  assert.deepEqual((await (await request(student)).json()).viewer.admins, ['admin@ucla.edu', 'player@ucla.edu']);
  const nonAdmin = { id: 'teammate', email: 'teammate@ucla.edu' };
  assert.equal((await (await request(nonAdmin)).json()).viewer.admins, null);
});

test('Google login posts a signed ID token back with no client secret; every failure lands on the calendar', async t => {
  const request = setup(t);
  const side = googleSide(t, request);
  const callback = '/auth/google/callback';
  const sessionOf = response => side.cookieValue(response, sessionName);
  const refused = (response, label, reason = 'google', calendar = backendUrl) => {
    const to = new URL(response.headers.get('Location'));
    assert.equal(response.status, 303, label);
    assert.equal(to.origin + to.pathname, new URL(calendar).href, label);
    assert.equal(to.searchParams.get('login_error'), reason, label);
    assert.equal(sessionOf(response), undefined, label);
    assert.match(side.cookieValue(response, stateName), /^__Host-open-play-state=; .*Max-Age=0/, label);
    return to;
  };
  const loginLink = new URL((await request({}, undefined, origin, { path: `/auth/login?date=${date}` })).headers.get('Location'));
  assert.equal(loginLink.pathname + loginLink.search, `/auth/google/start?date=${date}`);
  assert.equal((await request({}, undefined, origin, { path: '/auth/google/start?challenge=xyz' })).status, 400);

  const login = await side.start(`/auth/google/start?date=${date}`);
  assert.deepEqual(Object.fromEntries(login.destination.searchParams), {
    client_id: googleClientId, redirect_uri: `${backendUrl}/auth/google/callback`, response_type: 'id_token', response_mode: 'form_post',
    scope: 'openid email profile', prompt: 'select_account', state: login.state, nonce: login.nonce,
  });
  assert.equal(login.destination.origin, google);
  assert.match(login.state, /^[a-f0-9]{64}$/);
  assert.match(login.nonce, /^[a-f0-9]{64}$/);
  assert.equal(login.cookie, `${stateName}=${login.state}.${login.nonce}..${date}`);
  assert.match(side.cookieValue(login.response, stateName), /; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=None$/);

  const local = await side.start('/auth/google/start', 'http://localhost:8791');
  assert.equal(local.destination.searchParams.get('redirect_uri'), 'http://localhost:8791/auth/google/callback');
  assert.equal(new URL((await side.finish(local, { base: 'http://localhost:8791' })).headers.get('Location')).origin, 'http://localhost:8791');

  const done = await side.finish(login);
  assert.equal(done.status, 303);
  const home = new URL(done.headers.get('Location'));
  assert.equal(home.origin + home.pathname, new URL(backendUrl).href);
  assert.equal(home.searchParams.get('date'), date);
  assert.equal(home.searchParams.has('login_error'), false);
  assert.match(side.cookieValue(done, stateName), /^__Host-open-play-state=; .*Max-Age=0/);
  assert.match(sessionOf(done), /; Path=\/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax$/);
  const session = { cookie: sessionOf(done).split(';')[0] };
  const viewer = (await (await request({}, undefined, origin, session)).json()).viewer;
  assert.deepEqual(viewer, { signedIn: true, member: true, admins: ['admin@ucla.edu'], name: null, suggestedName: null });
  assert.equal((await request({}, {}, origin, { path: '/auth/google/logout', cookie: session.cookie })).status, 200);
  assert.equal((await (await request({}, undefined, origin, session)).json()).viewer.signedIn, false);

  const refusals = {
    'no cookie': { cookie: null },
    'wrong state': { form: { state: 'f'.repeat(64) } },
    'wrong nonce': { claims: { nonce: 'e'.repeat(64) } },
    'wrong audience': { audience: 'someone-else.apps.googleusercontent.com' },
    expired: { expires: timestamp() - 60 },
    'bad signature': { signer: (await generateKeyPair('RS256')).privateKey },
    'unknown key': { kid: 'other-key' },
    'not a token': { form: { id_token: 'garbage' } },
    'oversize body': { form: { padding: 'x'.repeat(10001) } },
  };
  for (const [label, options] of Object.entries(refusals)) refused(await side.finish(await side.start(), options), label);
  const denied = await side.start();
  refused(await request({}, undefined, google, { path: callback, method: 'POST', cookie: denied.cookie, form: { state: denied.state, error: 'access_denied' } }), 'cancelled at Google');
  const notForm = await side.start();
  refused(await request({}, { state: notForm.state }, google, { path: callback, cookie: notForm.cookie }), 'json body');
  const byGet = await side.start();
  refused(await request({}, undefined, origin, { path: `${callback}?state=${byGet.state}`, cookie: byGet.cookie }), 'GET callback');
  for (const [email, verified] of [['student@example.com', true], ['student@ucla.edu', false]]) {
    refused(await side.finish(await side.start(), { email, verified }), email, 'ucla');
  }

  const viaPages = await side.start(`/auth/google/start?challenge=${'a'.repeat(64)}&date=${date}`);
  assert.equal(viaPages.cookie, `${stateName}=${viaPages.state}.${viaPages.nonce}.${'a'.repeat(64)}.${date}`);
  const back = refused(await side.finish(viaPages, refusals['wrong nonce']), 'pages refusal', 'google', pagesUrl);
  assert.equal(back.searchParams.get('date'), date);

  const forgeries = {
    'short state': value => value.slice(1),
    'uppercase hex': value => value.toUpperCase(),
    'extra segment': value => `${value}.extra`,
  };
  for (const [label, forge] of Object.entries(forgeries)) {
    const attempt = await side.start(`/auth/google/start?date=${date}`);
    refused(await side.finish(attempt, { cookie: `${stateName}=${forge(attempt.cookie.slice(stateName.length + 1))}` }), label);
  }

  const outage = request.fault;
  t.mock.method(console, 'error', () => {});
  const challenge = 'b'.repeat(64);
  const sessionCount = () => request.sqlite.prepare('SELECT COUNT(*) AS n FROM pages_sessions').get().n;
  const before = sessionCount();
  for (const [label, path, calendar] of [['site', `/auth/google/start?date=${date}`, backendUrl], ['pages', `/auth/google/start?challenge=${challenge}&date=${date}`, pagesUrl]]) {
    const attempt = await side.start(path);
    outage.batch = true;
    const failed = refused(await side.finish(attempt), `database down (${label})`, 'google', calendar);
    outage.batch = false;
    assert.equal(failed.searchParams.get('date'), date);
  }
  assert.equal(sessionCount(), before);

  const signIn = async (email, name) => ({ cookie: sessionOf(await side.finish(await side.start(), { email, name })).split(';')[0] });
  const post = (who, body) => request({}, body, origin, who);
  const host = await signIn('admin@ucla.edu');
  const maya = await signIn('maya@ucla.edu', 'Maya Lopez');
  assert.equal((await (await request({}, undefined, origin, maya)).json()).viewer.suggestedName, 'Maya Lopez');
  assert.equal((await post({ ...host, path: '/api/name' }, { name: 'Host Admin' })).status, 200);
  assert.equal((await post({ ...maya, path: '/api/name' }, { name: 'Maya Lopez' })).status, 200);
  assert.equal((await post(host, { date, action: 'propose' })).status, 201);
  assert.equal((await post(maya, { date, action: 'join' })).status, 201);
  assert.deepEqual((await (await request({}, undefined, origin, maya)).json()).sessions[0].players, ['Maya L.']);
});

test('ChatGPT headers and sign-ins from before migration 0004 no longer sign anyone in', async t => {
  const request = setup(t);
  const headers = { 'oai-authenticated-user-id': 'chatgpt-user', 'oai-authenticated-user-email': 'admin@ucla.edu' };
  assert.equal((await request({}, { date, action: 'propose' }, origin, { headers })).status, 401);
  assert.equal((await (await request({}, undefined, origin, { headers })).json()).viewer.signedIn, false);

  assert.equal(files[4], '0004_accounts.sql');
  const old = new DatabaseSync(':memory:');
  t.after(() => old.close());
  old.exec(scripts.slice(0, 4).join('\n'));
  old.prepare("INSERT INTO pages_sessions (credential_hash, user_id, member, expires_at, channel) VALUES ('old', 'chatgpt-user', 'admin@ucla.edu', 9999999999, 'site')").run();
  old.exec(scripts[4]);
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM pages_sessions').get().n, 0);
  old.prepare("INSERT INTO members (email, name) VALUES ('admin@ucla.edu', 'Admin')").run();
  assert.throws(() => old.prepare("INSERT INTO members (email, name) VALUES ('admin@ucla.edu', 'Again')").run());
});

test('the bot endpoint needs its token and confirms a booked tennis court with the hours it holds', async t => {
  const token = 'bot-secret-token';
  const request = setup(t, { OPEN_PLAY_BOT_TOKEN: token });
  const post = (body, options = { token }) => request({}, body, null, { path: '/api/bot/session', ...options });
  const night = async () => (await (await request()).json()).sessions;
  const court = 'Sunset Rec Tennis Court 2';

  assert.equal((await post({ date, hour: 18 }, {})).status, 401);
  assert.equal((await post({ date, hour: 18 }, { token: 'wrong' })).status, 401);
  assert.equal((await setup(t)({}, { date, hour: 18 }, null, { path: '/api/bot/session', token })).status, 401);
  assert.deepEqual(await night(), []);

  assert.equal((await post({ date, hour: 'x' })).status, 400);
  assert.equal((await post({ date, hour: 12 })).status, 400);
  assert.equal((await post({ date, hour: 24 })).status, 400);
  assert.equal((await post({ date: '2026-02-30', hour: 18 })).status, 400);
  assert.equal((await post({ date: '2020-01-01', hour: 18 })).status, 400);
  assert.equal((await post(undefined)).status, 405);
  assert.deepEqual(await night(), []);

  const first = await post({ date, hour: 18 });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { date, time: '6–7 PM' });
  assert.deepEqual(await night(), [{ date, status: 'confirmed', location: court, signupCount: 0, signedUp: false, time: '6–7 PM' }]);
  assert.deepEqual(await (await post({ date, hour: 18 })).json(), { date, time: '6–7 PM' });
  assert.deepEqual(await (await post({ date, hour: 19 })).json(), { date, time: '6–8 PM' });
  assert.equal((await night()).length, 1);

  const later = addDays(date, 1);
  await post({ date: later, hour: 19 });
  assert.deepEqual(await (await post({ date: later, hour: 18 })).json(), { date: later, time: '6–8 PM' });

  const pending = addDays(date, 2);
  const declined = addDays(date, 3);
  await request(student, { date: pending, action: 'propose' });
  await request(student, { date: declined, action: 'propose' });
  await request(admin, { date: declined, action: 'decline' });
  assert.equal((await post({ date: pending, hour: 19 })).status, 200);
  assert.equal((await post({ date: declined, hour: 18 })).status, 200);
  const sessions = await night();
  assert.deepEqual(sessions.slice(2).map(({ date, status, location, time }) => ({ date, status, location, time })), [
    { date: pending, status: 'confirmed', location: court, time: '7–8 PM' },
    { date: declined, status: 'confirmed', location: court, time: '6–7 PM' },
  ]);

  assert.equal((await request(student, { date, action: 'join' })).status, 201);
  await post({ date, hour: 18 });
  assert.equal((await night())[0].signupCount, 1);
});

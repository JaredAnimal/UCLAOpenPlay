import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../dist/server/index.js';
import { currentWeek, pacificClock, addDays } from '../public/assets/schedule.mjs';
import { backendUrl, pagesUrl } from '../public/assets/hosting.mjs';

const origin = 'https://open-play.test';
const date = addDays(currentWeek(pacificClock().date).first, 8);
const admin = { id: 'organizer', email: 'ADMIN@g.ucla.edu' };
const student = { id: 'student', email: 'player@ucla.edu' };
const outside = { id: 'outsider', email: 'outsider@example.com' };
const migrations = new URL('../migrations/', import.meta.url);
const files = (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort();
const sql = (await Promise.all(files.map(file => readFile(new URL(file, migrations), 'utf8')))).join('\n');

function setup(t, env = {}) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(sql);
  const DB = {
    prepare(query) {
      const statement = sqlite.prepare(query);
      return {
        bind(...args) {
          return { first: () => statement.get(...args), all: () => ({ results: statement.all(...args) }), run: () => statement.run(...args) };
        },
      };
    },
    batch: statements => statements.map(statement => statement.run()),
  };
  return (viewer = {}, data, source = origin, { path = '/api/schedule', method = data ? 'POST' : 'GET', token, cookie } = {}) => {
    const headers = new Headers();
    if (viewer.id) headers.set('oai-authenticated-user-id', viewer.id);
    if (viewer.email) headers.set('oai-authenticated-user-email', viewer.email);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (cookie) headers.set('Cookie', cookie);
    if (source) headers.set('Origin', source);
    if (data) {
      headers.set('Content-Type', 'application/json');
    }
    const request = new Request(`${origin}${path}`, { method, headers, body: data && JSON.stringify(data) });
    return worker.fetch(request, { DB, OPEN_PLAY_ADMINS: 'admin@ucla.edu', ...env });
  };
}

test('UCLA proposals stay tentative until an admin approves; approved sessions accept one RSVP per UCLA mailbox', async t => {
  const request = setup(t);
  const proposal = { date, action: 'propose' };
  const approval = { date, action: 'approve', location: 'Sunset Rec · Tennis Court 2' };
  const join = { date, action: 'join' };
  assert.equal((await request(undefined, proposal)).status, 401);
  assert.equal((await request({ email: admin.email }, proposal)).status, 401);
  assert.equal((await request(outside, proposal)).status, 403);
  assert.equal((await request(student, proposal, 'https://other.test')).status, 403);
  assert.equal((await request(student, { ...proposal, date: '2026-02-30' })).status, 400);
  assert.equal((await request(student, proposal)).status, 201);
  assert.equal((await request(student, proposal)).status, 409);
  assert.equal((await request(student, approval)).status, 403);
  assert.equal((await request(admin, { ...approval, location: ' ' })).status, 400);
  assert.equal((await request(admin, join)).status, 409);
  const anonymous = await (await request()).json();
  assert.deepEqual(anonymous.sessions, [{ date, status: 'pending', signupCount: 0, signedUp: false, time: '6–8 PM' }]);
  assert.deepEqual(anonymous.viewer, { signedIn: false, member: false, admins: null, authProvider: 'chatgpt' });
  assert.deepEqual((await (await request(admin)).json()).viewer.admins, ['admin@ucla.edu']);
  assert.equal((await request(admin, approval)).status, 200);
  assert.equal((await request(admin, { date, action: 'decline' })).status, 409);
  assert.equal((await request(outside, join)).status, 403);
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

test('GitHub Pages redeems a one-time sign-in code and uses a separately revocable API session', async t => {
  const request = setup(t);
  const pagesOrigin = new URL(pagesUrl).origin;
  const verifier = '1'.repeat(64);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = Buffer.from(bytes).toString('hex');
  const login = { path: `/pages/login?challenge=${challenge}&date=${date}` };
  const exchange = { path: '/api/pages/session' };
  const proposal = { date, action: 'propose' };
  const redirect = await request({}, undefined, origin, login);
  assert.equal(new URL(redirect.headers.get('Location')).pathname, '/signin-with-chatgpt');
  assert.equal((await request(outside, undefined, origin, login)).status, 403);
  assert.equal((await request(student, proposal, pagesOrigin)).status, 401);
  const preflight = await request({}, undefined, pagesOrigin, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), pagesOrigin);
  const redirectBack = await request(admin, undefined, origin, login);
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
  assert.equal((await request({}, { code, verifier }, pagesOrigin, exchange)).status, 401);
  assert.equal((await request({}, proposal, pagesOrigin, { token })).status, 201);
  const signedIn = await (await request({}, undefined, pagesOrigin, { token })).json();
  assert.deepEqual(signedIn.viewer.admins, ['admin@ucla.edu']);
  assert.equal((await request({}, { date, action: 'approve', location: 'Tennis Court 2' }, pagesOrigin, { token })).status, 200);
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
  assert.equal((await request(student, { date, action: 'approve', location: 'Tennis Court 2' })).status, 200);
  assert.deepEqual((await (await request(student)).json()).viewer.admins, ['admin@ucla.edu', 'player@ucla.edu']);
  const nonAdmin = { id: 'teammate', email: 'teammate@ucla.edu' };
  assert.equal((await (await request(nonAdmin)).json()).viewer.admins, null);
});

test('Google login checks the OAuth state, Google signature, and verified UCLA address on both hosts', async t => {
  const clientId = 'fake-open-play.apps.googleusercontent.com';
  const request = setup(t, { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: 'test-only' });
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256' };
  let googleProfile;
  let tokenCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [key] });
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    tokenCalls++;
    assert.equal(options.body.get('client_id'), clientId);
    assert.equal(options.body.get('redirect_uri'), `${backendUrl}/auth/google/callback`);
    assert.match(options.body.get('code_verifier'), /^[a-f0-9]{64}$/);
    const idToken = await new SignJWT(googleProfile).setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuer('https://accounts.google.com').setAudience(clientId).setSubject('mock-google-id').setExpirationTime('2m').sign(privateKey);
    return Response.json({ id_token: idToken });
  });
  const loginAttempt = async (path, email = 'Admin@g.ucla.edu', verified = true, name) => {
    const start = await request({}, undefined, origin, { path });
    const google = new URL(start.headers.get('Location'));
    assert.equal(google.origin, 'https://accounts.google.com');
    assert.equal(google.searchParams.get('scope'), 'openid email profile');
    assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
    const cookie = start.headers.getSetCookie()[0].split(';')[0];
    assert.match(start.headers.getSetCookie()[0], /HttpOnly; Secure; SameSite=Lax/);
    googleProfile = { nonce: google.searchParams.get('nonce'), email, email_verified: verified, ...(name && { name }) };
    const callback = '/auth/google/callback?' + new URLSearchParams({ state: google.searchParams.get('state'), code: 'google-code' });
    return { path: callback, cookie };
  };
  assert.equal(new URL((await request({}, undefined, origin, { path: '/auth/login' })).headers.get('Location')).pathname, '/auth/google/start');
  assert.deepEqual((await (await request(admin)).json()).viewer, { signedIn: false, member: false, admins: null, authProvider: 'google' });

  const first = await loginAttempt(`/auth/google/start?date=${date}`);
  const withoutCookie = await request({}, undefined, origin, { path: first.path });
  assert.equal(new URL(withoutCookie.headers.get('Location')).searchParams.get('login_error'), 'google');
  assert.equal(tokenCalls, 0);
  const confirmed = await request({}, undefined, origin, first);
  const session = confirmed.headers.getSetCookie().find(value => value.startsWith('__Host-open-play-session=')).split(';')[0];
  assert.equal(new URL(confirmed.headers.get('Location')).searchParams.get('date'), date);
  assert.deepEqual((await (await request({}, undefined, origin, { cookie: session })).json()).viewer.admins, ['admin@ucla.edu']);
  await request({}, undefined, origin, first);
  assert.equal(tokenCalls, 1);
  await request({}, {}, origin, { path: '/auth/google/logout', cookie: session });
  assert.equal((await (await request({}, undefined, origin, { cookie: session })).json()).viewer.signedIn, false);

  for (const [email, verified] of [['student@example.com', true], ['student@ucla.edu', false]]) {
    const attempt = await loginAttempt('/auth/google/start', email, verified);
    const denied = await request({}, undefined, origin, attempt);
    assert.equal(new URL(denied.headers.get('Location')).searchParams.get('login_error'), 'ucla');
  }

  const pagesOrigin = new URL(pagesUrl).origin;
  const verifier = 'a'.repeat(64);
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('hex');
  const startViaPages = await request({}, undefined, origin, { path: `/pages/login?challenge=${challenge}` });
  const googleStart = new URL(startViaPages.headers.get('Location'));
  assert.equal(googleStart.pathname, '/auth/google/start');
  const attempt = await loginAttempt(googleStart.pathname + googleStart.search);
  const callback = await request({}, undefined, origin, attempt);
  const redirect = new URL(callback.headers.get('Location'));
  assert.equal(redirect.origin + redirect.pathname, pagesUrl);
  const code = new URLSearchParams(redirect.hash.slice(1)).get('code');
  const { token } = await (await request({}, { code, verifier }, pagesOrigin, { path: '/api/pages/session' })).json();
  assert.deepEqual((await (await request({}, undefined, pagesOrigin, { token })).json()).viewer.admins, ['admin@ucla.edu']);

  const signIn = async (email, name) => {
    const done = await request({}, undefined, origin, await loginAttempt('/auth/google/start', email, true, name));
    return { cookie: done.headers.getSetCookie().find(value => value.startsWith('__Host-open-play-session=')).split(';')[0] };
  };
  const post = (who, body) => request({}, body, origin, who);
  const host = await signIn('admin@ucla.edu');
  const maya = await signIn('maya@ucla.edu', 'Maya Lopez');
  assert.equal((await post(host, { date, action: 'propose' })).status, 201);
  assert.equal((await post(host, { date, action: 'approve', location: 'Tennis Court 2' })).status, 200);
  assert.equal((await post(maya, { date, action: 'join' })).status, 201);
  assert.deepEqual((await (await request({}, undefined, origin, maya)).json()).sessions[0].players, ['Maya L.']);
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

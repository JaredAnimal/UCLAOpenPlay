import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../dist/server/index.js';
import { currentWeek, pacificClock, addDays } from '../public/assets/schedule.mjs';

const origin = 'https://open-play.test';
const date = addDays(currentWeek(pacificClock().date).first, 7);
const admin = { id: 'organizer', email: 'ADMIN@g.ucla.edu' };
const student = { id: 'student', email: 'player@ucla.edu' };
const outside = { id: 'outsider', email: 'outsider@example.com' };
const sql = await readFile(new URL('../migrations/0000_open_play.sql', import.meta.url), 'utf8');

function setup(t) {
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
  };
  return (viewer = {}, data, source = origin) => {
    const headers = new Headers();
    if (viewer.id) headers.set('oai-authenticated-user-id', viewer.id);
    if (viewer.email) headers.set('oai-authenticated-user-email', viewer.email);
    if (data) {
      headers.set('Origin', source);
      headers.set('Content-Type', 'application/json');
    }
    const request = new Request(`${origin}/api/schedule`, { method: data ? 'POST' : 'GET', headers, body: data && JSON.stringify(data) });
    return worker.fetch(request, { DB, OPEN_PLAY_ADMINS: 'admin@ucla.edu' });
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
  assert.equal((await request(student, { ...proposal, date: addDays(date, -1) })).status, 400);
  assert.equal((await request(student, proposal)).status, 201);
  assert.equal((await request(student, proposal)).status, 409);
  assert.equal((await request(student, approval)).status, 403);
  assert.equal((await request(admin, { ...approval, location: ' ' })).status, 400);
  assert.equal((await request(admin, join)).status, 409);
  const anonymous = await (await request()).json();
  assert.deepEqual(anonymous.sessions, [{ date, status: 'pending', signupCount: 0, signedUp: false }]);
  assert.deepEqual(anonymous.viewer, { signedIn: false, member: false, admins: null });
  assert.deepEqual((await (await request(admin)).json()).viewer.admins, ['admin@ucla.edu']);
  assert.equal((await request(admin, approval)).status, 200);
  assert.equal((await request(admin, { date, action: 'decline' })).status, 409);
  assert.equal((await request(outside, join)).status, 403);
  assert.equal((await request(student, join)).status, 201);
  assert.equal((await request({ id: 'student-alias', email: 'player@g.ucla.edu' }, join)).status, 200);
  const count = (await (await request()).json()).sessions[0];
  assert.deepEqual(count, { date, status: 'confirmed', location: approval.location, signupCount: 1, signedUp: false });
  assert.equal((await (await request(student)).json()).sessions[0].signedUp, true);
  assert.equal((await request(admin, { date, action: 'leave' })).status, 200);
  assert.equal((await (await request(student)).json()).sessions[0].signupCount, 1);
  assert.equal((await request(student, { date, action: 'leave' })).status, 200);
  assert.equal((await (await request(student)).json()).sessions[0].signupCount, 0);
});

test('declining a tentative night closes it to approvals and RSVPs', async t => {
  const request = setup(t);
  assert.equal((await request(student, { date, action: 'propose' })).status, 201);
  assert.equal((await request(admin, { date, action: 'decline' })).status, 200);
  assert.equal((await request(student, { date, action: 'join' })).status, 409);
  assert.equal((await request(admin, { date, action: 'approve', location: 'Tennis Court 2' })).status, 409);
  assert.equal((await (await request()).json()).sessions[0].status, 'cancelled');
});

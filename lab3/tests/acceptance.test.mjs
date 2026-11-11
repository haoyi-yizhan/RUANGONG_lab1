import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketingSystem } from '../src/system.mjs';

const DAY = 86400000;
const PASSWORD = 'Password123';
function setup(t, capacity = 1, filename = ':memory:') {
  let now = Date.parse('2030-01-01T00:00:00Z');
  let system = new TicketingSystem({ filename, clock: () => now });
  t.after(() => system.close());
  let serial = 0;
  function user(role = 'participant', verified = true) {
    const n = ++serial;
    const phone = `138${String(n).padStart(8, '0')}`;
    const registered = system.register({ phone, password: PASSWORD, role: role === 'organizer' ? role : 'participant' });
    const id = registered.user.id;
    if (verified) system.verify(id, { name: `Person${n}`, idNumber: `11010119900101${String(n).padStart(3, '0')}X` });
    if (role === 'admin' || role === 'checker') system.db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
    return { id, phone, ...registered };
  }
  const admin = user('admin');
  const organizer = user('organizer');
  function event() {
    const date = ms => new Date(ms).toISOString();
    const created = system.createEvent(organizer.id, {
      title: 'Acceptance concert', kind: 'performance', speaker: 'Artist', theme: 'Music', publishAt: date(now - 1000),
      sessions: [{ startsAt: date(now + 10 * DAY), endsAt: date(now + 10 * DAY + 7200000), location: 'Hall', saleAt: date(now - 1000), deadline: date(now + 9 * DAY), tiers: [{ name: 'Standard', priceCents: 10000, capacity }] }],
    });
    const reviews = system.listReviews(admin.id);
    const review = reviews.find(r => r.eventId === created.id) ?? reviews.at(-1);
    system.review(admin.id, review.id, { approved: true });
    return created;
  }
  return { get system() { return system; }, restart() { system.close(); system = new TicketingSystem({ filename, clock: () => now }); }, user, admin, organizer, event, get now() { return now; }, set now(value) { now = value; } };
}
function findOrder(system, actor, id) { return system.listOrders(actor).find(order => order.id === id); }

test('registration protects credentials, prevents duplicate identities and supports recovery', t => {
  const x = setup(t);
  const a = x.user('participant', false);
  const b = x.user('participant', false);
  assert.throws(() => x.system.register({ phone: a.phone, password: PASSWORD, role: 'participant' }));
  assert.throws(() => x.system.register({ phone: '13900000000', password: PASSWORD, role: 'admin' }));
  x.system.verify(a.id, { name: 'Alice', idNumber: '11010119900101999X' });
  assert.throws(() => x.system.verify(b.id, { name: 'Bob', idNumber: '11010119900101999X' }));
  const row = x.system.db.prepare('SELECT password_hash FROM users WHERE id=?').get(a.id);
  assert.notEqual(row.password_hash, PASSWORD);
  x.system.resetPassword({ phone: a.phone, recoveryCode: a.recoveryCode, password: 'Replacement123' });
  assert.throws(() => x.system.login({ phone: a.phone, password: PASSWORD }));
  assert.equal(x.system.login({ phone: a.phone, password: 'Replacement123' }).user.id, a.id);
});

test('payment is idempotent and unique real-name purchases are enforced', t => {
  const x = setup(t, 2); const event = x.event(); const buyer = x.user();
  const tierId = event.sessions[0].tiers[0].id;
  const order = x.system.createOrder(buyer.id, { tierId });
  assert.equal(order.state, 'pending');
  assert.throws(() => x.system.createOrder(buyer.id, { tierId }));
  const paid = x.system.pay(buyer.id, order.id, { success: true });
  assert.equal(paid.state, 'issued'); assert.ok(paid.seat); assert.ok(paid.code);
  const repeated = x.system.pay(buyer.id, order.id, { success: true });
  assert.equal(repeated.code, paid.code); assert.equal(repeated.seat, paid.seat);
  assert.equal(repeated.paidCents, paid.paidCents);
});

test('payment expires at 180 seconds and releases inventory', t => {
  const x = setup(t); const event = x.event(); const a = x.user(); const b = x.user();
  const tierId = event.sessions[0].tiers[0].id;
  const order = x.system.createOrder(a.id, { tierId });
  x.now += 180000;
  x.system.maintain();
  assert.equal(findOrder(x.system, a.id, order.id).state, 'closed');
  assert.throws(() => x.system.pay(a.id, order.id, { success: true }));
  assert.equal(x.system.createOrder(b.id, { tierId }).state, 'pending');
});

test('refund advances waitlist in FIFO order and withdrawal returns full prepayment', t => {
  const x = setup(t); const event = x.event(); const a = x.user(); const b = x.user(); const c = x.user();
  const tierId = event.sessions[0].tiers[0].id;
  const first = x.system.createOrder(a.id, { tierId }); x.system.pay(a.id, first.id, { success: true });
  const second = x.system.createOrder(b.id, { tierId, waitlist: true });
  const third = x.system.createOrder(c.id, { tierId, waitlist: true });
  assert.equal(second.state, 'waiting'); assert.equal(third.state, 'waiting');
  const refunded = x.system.refund(a.id, first.id);
  assert.equal(refunded.refundCents, 8000);
  assert.equal(findOrder(x.system, b.id, second.id).state, 'issued');
  assert.equal(findOrder(x.system, c.id, third.id).state, 'waiting');
  const withdrawn = x.system.leaveWaitlist(c.id, third.id);
  assert.equal(withdrawn.state, 'refunded'); assert.equal(withdrawn.refundCents, 10000);
  assert.throws(() => x.system.leaveWaitlist(c.id, third.id));
});

for (const [days, expected] of [[7, 6000], [3, 6000], [3 - 1 / DAY, null]]) {
  test(`refund boundary at ${days} days`, t => {
    const x = setup(t); const event = x.event(); const buyer = x.user();
    const order = x.system.createOrder(buyer.id, { tierId: event.sessions[0].tiers[0].id });
    x.system.pay(buyer.id, order.id, { success: true });
    x.now += (10 - days) * DAY;
    if (expected === null) assert.throws(() => x.system.refund(buyer.id, order.id));
    else assert.equal(x.system.refund(buyer.id, order.id).refundCents, expected);
  });
}

test('review and order access enforce roles; banning blocks login and operations', t => {
  const x = setup(t); const event = x.event(); const a = x.user(); const b = x.user();
  const order = x.system.createOrder(a.id, { tierId: event.sessions[0].tiers[0].id });
  assert.throws(() => x.system.pay(b.id, order.id, { success: true }));
  assert.throws(() => x.system.listReviews(a.id));
  assert.throws(() => x.system.setBanned(a.id, b.id, { banned: true, reason: 'test' }));
  x.system.setBanned(x.admin.id, a.id, { banned: true, reason: 'test' });
  assert.throws(() => x.system.login({ phone: a.phone, password: PASSWORD }));
  assert.throws(() => x.system.pay(a.id, order.id, { success: true }));
  x.system.setBanned(x.admin.id, a.id, { banned: false, reason: 'restored' });
  assert.equal(x.system.login({ phone: a.phone, password: PASSWORD }).user.id, a.id);
});

test('cancellation remains subject to review and refunds paid and waiting orders in full', t => {
  const x = setup(t); const event = x.event(); const a = x.user(); const b = x.user();
  const tierId = event.sessions[0].tiers[0].id;
  const first = x.system.createOrder(a.id, { tierId }); x.system.pay(a.id, first.id, { success: true });
  const second = x.system.createOrder(b.id, { tierId, waitlist: true });
  const review = x.system.requestChange(x.organizer.id, event.id, { kind: 'cancel', reason: 'Venue unavailable' });
  assert.equal(findOrder(x.system, a.id, first.id).state, 'issued');
  assert.throws(() => x.system.review(a.id, review.id, { approved: true }));
  x.system.review(x.admin.id, review.id, { approved: true });
  for (const [user, order] of [[a, first], [b, second]]) {
    const updated = findOrder(x.system, user.id, order.id);
    assert.equal(updated.state, 'refunded'); assert.equal(updated.refundCents, 10000);
  }
  assert.throws(() => x.system.refund(a.id, first.id));
});

test('an interrupted refund rolls back its payment and ticket state together', t => {
  const x = setup(t); const event = x.event(); const buyer = x.user();
  const order = x.system.createOrder(buyer.id, { tierId: event.sessions[0].tiers[0].id });
  x.system.pay(buyer.id, order.id, { success: true });
  x.system.db.exec("CREATE TRIGGER simulate_failure BEFORE UPDATE OF state ON orders WHEN NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
  assert.throws(() => x.system.refund(buyer.id, order.id));
  const unchanged = findOrder(x.system, buyer.id, order.id);
  assert.equal(unchanged.state, 'issued'); assert.equal(unchanged.refundCents, 0);
  assert.equal(x.system.db.prepare('SELECT count(*) AS n FROM refunds WHERE order_id=?').get(order.id).n, 0);
  x.system.db.exec('DROP TRIGGER simulate_failure');
  assert.equal(x.system.refund(buyer.id, order.id).refundCents, 8000);
});

import { createApplication } from '../src/server.mjs';
test('unverified HTTP buyer cannot buy or prepay waitlist even with a name and forged verification', async t => {
  const x = setup(t);
  const event = x.event();
  const buyer = x.user('participant', false);
  x.system.db.prepare('UPDATE users SET name=? WHERE id=?').run('Display name only', buyer.id);
  const server = createApplication({ system: x.system });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: buyer.phone, password: PASSWORD }),
  });
  assert.equal((await login.json()).data.verified, false);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { 'content-type': 'application/json', cookie };
  const tierId = event.sessions[0].tiers[0].id;
  for (const soldOut of [false, true]) {
    if (soldOut) x.system.createOrder(x.user().id, { tierId });
    for (const waitlist of [false, true]) {
      const response = await fetch(`${base}/api/orders`, {
        method: 'POST', headers,
        body: JSON.stringify({ tierId, waitlist, verified: true, name: 'Forged', idNumber: '110101199001010018' }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'IDENTITY_REQUIRED');
    }
  }
  assert.equal(x.system.listOrders(buyer.id).length, 0);
  assert.equal(x.system.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 0);
  assert.equal(x.system.db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n, 0);
  x.system.verify(buyer.id, { name: 'Real viewer', idNumber: '110101199001010018' });
  const response = await fetch(`${base}/api/orders`, {
    method: 'POST', headers, body: JSON.stringify({ tierId, waitlist: true }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.state, 'waiting');
});

test('50 simultaneous HTTP purchases reserve one seat and queue the other 49', async t => {
  const x = setup(t); const event = x.event();
  const users = Array.from({ length: 50 }, () => x.user());
  const server = createApplication({ system: x.system });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = await Promise.all(users.map(async user => {
    const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: user.phone, password: PASSWORD }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie'); assert.ok(cookie);
    return cookie.split(';')[0];
  }));
  const results = await Promise.all(cookies.map(async cookie => {
    const response = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ tierId: event.sessions[0].tiers[0].id, waitlist: true }) });
    assert.ok(response.ok, `HTTP ${response.status}: ${await response.clone().text()}`);
    return (await response.json()).data;
  }));
  assert.equal(results.filter(order => order.state === 'pending').length, 1);
  assert.equal(results.filter(order => order.state === 'waiting').length, 49);
  assert.equal(new Set(results.map(order => order.id)).size, 50);
});

test('approved reschedule updates the session and grants a full refund', t => {
  const x = setup(t); const event = x.event(); const buyer = x.user();
  const session = event.sessions[0];
  const order = x.system.createOrder(buyer.id, { tierId: session.tiers[0].id });
  x.system.pay(buyer.id, order.id, { success: true });
  const startsAt = new Date(x.now + 11 * DAY).toISOString();
  const endsAt = new Date(x.now + 11 * DAY + 7200000).toISOString();
  const review = x.system.requestChange(x.organizer.id, event.id, { kind: 'reschedule', reason: 'Venue change', sessions: [{ id: session.id, startsAt, endsAt, location: 'New Hall' }] });
  assert.equal(x.system.getEvent(null, event.id).sessions[0].location, 'Hall');
  x.system.review(x.admin.id, review.id, { approved: true });
  assert.equal(x.system.getEvent(null, event.id).sessions[0].location, 'New Hall');
  assert.equal(x.system.refund(buyer.id, order.id).refundCents, 10000);
});

test('unverified purchase is rejected; failed payment can retry and timeout promotes the waitlist', t => {
  const x = setup(t); const event = x.event(); const unverified = x.user('participant', false); const a = x.user(); const b = x.user();
  const tierId = event.sessions[0].tiers[0].id;
  assert.throws(() => x.system.createOrder(unverified.id, { tierId }));
  const pending = x.system.createOrder(a.id, { tierId });
  assert.equal(x.system.pay(a.id, pending.id, { success: false }).state, 'pending');
  const waiting = x.system.createOrder(b.id, { tierId, waitlist: true });
  x.now += 180000; x.system.maintain();
  assert.equal(findOrder(x.system, a.id, pending.id).state, 'closed');
  assert.equal(findOrder(x.system, b.id, waiting.id).state, 'issued');
});

test('waitlist deadline refunds prepayment', t => {
  const x = setup(t); const event = x.event(); const a = x.user(); const b = x.user();
  const tierId = event.sessions[0].tiers[0].id;
  const first = x.system.createOrder(a.id, { tierId }); x.system.pay(a.id, first.id, { success: true });
  const second = x.system.createOrder(b.id, { tierId, waitlist: true });
  x.now = Date.parse(event.sessions[0].deadline); x.system.maintain();
  const result = findOrder(x.system, b.id, second.id);
  assert.equal(result.state, 'refunded'); assert.equal(result.refundCents, 10000);
});

test('check-in rejects invalid, closed, wrong identity, cancelled and repeated tickets; completion marks attendance and absence', t => {
  const x = setup(t, 3); const event = x.event(); const a = x.user(); const b = x.user(); const c = x.user(); const checker = x.user('checker');
  const session = event.sessions[0], tierId = session.tiers[0].id;
  const buy = user => { const o = x.system.createOrder(user.id, { tierId }); return x.system.pay(user.id, o.id, { success: true }); };
  const checked = buy(a), absent = buy(b), cancelled = buy(c);
  x.system.refund(c.id, cancelled.id);
  const identity = x.system.db.prepare('SELECT id_number FROM users WHERE id=?').get(a.id).id_number;
  assert.throws(() => x.system.checkin(checker.id, { code: checked.code, idNumber: identity }));
  x.now = Date.parse(session.startsAt) - 3 * 3600000;
  x.system.openCheckin(x.admin.id, session.id);
  assert.throws(() => x.system.checkin(checker.id, { code: 'forged', idNumber: identity }));
  assert.throws(() => x.system.checkin(checker.id, { code: cancelled.code, idNumber: identity }));
  assert.throws(() => x.system.checkin(checker.id, { code: checked.code, idNumber: '11010119900101999X' }));
  assert.equal(x.system.checkin(checker.id, { code: checked.code, idNumber: identity }).admitted, true);
  assert.throws(() => x.system.checkin(checker.id, { code: checked.code, idNumber: identity }));
  x.now = Date.parse(session.endsAt); x.system.maintain();
  assert.equal(findOrder(x.system, a.id, checked.id).state, 'redeemed');
  assert.equal(findOrder(x.system, b.id, absent.id).state, 'absent');
  const stats = x.system.statistics(x.organizer.id, session.id);
  assert.equal(stats.attended, 1); assert.equal(stats.absent, 1);
  assert.throws(() => x.system.refund(b.id, absent.id));
});

test('roster excludes identity numbers, respects ownership, and audit is immutable', t => {
  const x = setup(t); const event = x.event(); const buyer = x.user(); const other = x.user('organizer');
  const order = x.system.createOrder(buyer.id, { tierId: event.sessions[0].tiers[0].id }); x.system.pay(buyer.id, order.id, { success: true });
  const csv = x.system.exportRoster(x.organizer.id, event.id, event.sessions[0].id);
  assert.ok(csv.includes(buyer.phone));
  const identity = x.system.db.prepare('SELECT id_number FROM users WHERE id=?').get(buyer.id).id_number;
  assert.ok(!csv.includes(identity));
  assert.throws(() => x.system.exportRoster(other.id, event.id));
  assert.ok(x.system.listAudit(x.admin.id, {}).some(row => row.action === 'export_roster'));
  assert.throws(() => x.system.db.exec('DELETE FROM audit'));
  assert.throws(() => x.system.db.exec("UPDATE audit SET action='modified'"));
});

test('a refunded attendee can buy again and published events cannot be resubmitted for price changes', t => {
  const x = setup(t); const event = x.event(); const buyer = x.user();
  const tierId = event.sessions[0].tiers[0].id;
  const order = x.system.createOrder(buyer.id, { tierId }); x.system.pay(buyer.id, order.id, { success: true });
  x.system.refund(buyer.id, order.id);
  assert.equal(x.system.createOrder(buyer.id, { tierId }).state, 'pending');
  assert.throws(() => x.system.resubmitEvent(x.organizer.id, event.id, {}));
});

test('scheduled event automatically publishes and same user can purchase different sessions', t => {
  const x = setup(t, 2); const buyer = x.user();
  const iso = ms => new Date(ms).toISOString();
  const session = offset => ({ startsAt: iso(x.now + offset * DAY), endsAt: iso(x.now + offset * DAY + 7200000), location: 'Hall', saleAt: iso(x.now + 1000), deadline: iso(x.now + (offset - 1) * DAY), tiers: [{ name: 'Standard', priceCents: 10000, capacity: 2 }] });
  const event = x.system.createEvent(x.organizer.id, { title: 'Two sessions', kind: 'performance', speaker: 'Artist', theme: 'Music', publishAt: iso(x.now + 1000), sessions: [session(10), session(11)] });
  const review = x.system.listReviews(x.admin.id).find(row => row.eventId === event.id);
  x.system.review(x.admin.id, review.id, { approved: true });
  assert.ok(!x.system.listEvents(null).some(row => row.id === event.id));
  x.now += 1000; x.system.maintain();
  assert.ok(x.system.listEvents(null).some(row => row.id === event.id));
  for (const s of event.sessions) assert.equal(x.system.createOrder(buyer.id, { tierId: s.tiers[0].id }).state, 'pending');
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('process termination rolls back an uncommitted order after reopening the database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ticket-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'test.sqlite');
  let system = new TicketingSystem({ filename });
  const db = system.db;
  db.prepare("INSERT INTO users(id,phone,password_hash,recovery_hash,role,created_at) VALUES ('recovery-user','13800000000','fixture','fixture','participant',0)").run();
  db.prepare("INSERT INTO events(id,organizer_id,title,kind,speaker,theme,status,publish_at,created_at) VALUES ('recovery-event','recovery-user','Recovery','performance','Artist','Music','published',0,0)").run();
  db.prepare("INSERT INTO sessions(id,event_id,starts_at,ends_at,location,sale_at,deadline) VALUES ('recovery-session','recovery-event',2000000000000,2000000001000,'Hall',0,1999999999000)").run();
  db.prepare("INSERT INTO tiers(id,session_id,name,price_cents,capacity) VALUES ('recovery-tier','recovery-session','Standard',10000,1)").run();
  system.close();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./recovery-child.mjs', import.meta.url)), filename], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => String(chunk).includes('READY') ? resolve() : reject(new Error('Child did not start transaction')));
    child.once('error', reject); child.once('exit', code => reject(new Error(`Child exited early: ${code}`)));
  });
  const ended = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL'); await ended;
  system = new TicketingSystem({ filename });
  assert.equal(system.db.prepare("SELECT count(*) AS n FROM orders WHERE id='uncommitted'").get().n, 0);
  assert.equal(system.remaining('recovery-tier'), 1);
  system.close();
});

test('downtime replays pending expiry before waitlist deadline, then marks the promoted ticket absent', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ticket-downtime-'));
  const x = setup(t, 1, join(directory, 'tickets.sqlite')); const event = x.event();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const a = x.user(), b = x.user(); const tierId = event.sessions[0].tiers[0].id;
  const pending = x.system.createOrder(a.id, { tierId });
  const waiting = x.system.createOrder(b.id, { tierId, waitlist: true });
  x.now = Date.parse(event.sessions[0].deadline) + 1;
  x.restart(); x.system.maintain();
  assert.equal(findOrder(x.system, a.id, pending.id).state, 'closed');
  const promoted = findOrder(x.system, b.id, waiting.id);
  assert.equal(promoted.state, 'issued'); assert.equal(promoted.refundCents, 0); assert.ok(promoted.code);
  x.now = Date.parse(event.sessions[0].endsAt); x.system.maintain();
  assert.equal(findOrder(x.system, b.id, waiting.id).state, 'absent');
});

for (const kind of ['reschedule', 'cancel']) {
  test(`approved ${kind} handles tickets already checked in`, t => {
    const x = setup(t, 2); const event = x.event(); const session = event.sessions[0];
    const checker = x.user('checker'); const users = [x.user(), x.user()];
    const tickets = users.map(user => {
      const pending = x.system.createOrder(user.id, { tierId: session.tiers[0].id });
      return x.system.pay(user.id, pending.id, { success: true });
    });
    x.now = Date.parse(session.startsAt) - 3 * 3600000;
    x.system.openCheckin(x.admin.id, session.id);
    const identity = user => x.system.db.prepare('SELECT id_number FROM users WHERE id=?').get(user.id).id_number;
    for (let i = 0; i < users.length; i++) x.system.checkin(checker.id, { code: tickets[i].code, idNumber: identity(users[i]) });
    const newStart = x.now + 4 * DAY;
    const change = { kind, reason: 'Venue change', sessions: [{ id: session.id, startsAt: new Date(newStart).toISOString(), endsAt: new Date(newStart + 7200000).toISOString(), location: 'New Hall' }] };
    const review = x.system.requestChange(x.organizer.id, event.id, change);
    x.system.review(x.admin.id, review.id, { approved: true });
    if (kind === 'cancel') {
      for (let i = 0; i < users.length; i++) {
        const order = findOrder(x.system, users[i].id, tickets[i].id);
        assert.equal(order.state, 'refunded'); assert.equal(order.refundCents, 10000);
      }
      return;
    }
    for (let i = 0; i < users.length; i++) {
      const order = findOrder(x.system, users[i].id, tickets[i].id);
      assert.equal(order.state, 'issued'); assert.equal(order.fullRefund, true);
    }
    assert.throws(() => x.system.checkin(checker.id, { code: tickets[0].code, idNumber: identity(users[0]) }));
    assert.equal(x.system.refund(users[0].id, tickets[0].id).refundCents, 10000);
    x.now = newStart - 3 * 3600000;
    x.system.openCheckin(x.admin.id, session.id);
    assert.equal(x.system.checkin(checker.id, { code: tickets[1].code, idNumber: identity(users[1]) }).admitted, true);
  });
}

test('purchased statistics count distinct attendees with issued tickets, excluding withdrawn waitlist entries', t => {
  const x = setup(t); const event = x.event(); const session = event.sessions[0];
  const a = x.user(), b = x.user(); const tierId = session.tiers[0].id;
  const first = x.system.createOrder(a.id, { tierId }); x.system.pay(a.id, first.id, { success: true });
  const waiting = x.system.createOrder(b.id, { tierId, waitlist: true });
  x.system.leaveWaitlist(b.id, waiting.id);
  assert.equal(x.system.statistics(x.organizer.id, session.id).purchased, 1);
  x.system.refund(a.id, first.id);
  const second = x.system.createOrder(a.id, { tierId }); x.system.pay(a.id, second.id, { success: true });
  assert.equal(x.system.statistics(x.organizer.id, session.id).purchased, 1);
});

test('order presentation includes viewer and session data and live FIFO queue positions', t => {
  const x = setup(t); const event = x.event(); const [a,b,c,d] = Array.from({ length: 4 }, () => x.user());
  const tierId = event.sessions[0].tiers[0].id;
  const first = x.system.createOrder(a.id, { tierId }); x.system.pay(a.id, first.id, { success: true });
  const queued = [b,c,d].map(user => x.system.createOrder(user.id, { tierId, waitlist: true }));
  assert.deepEqual(queued.map(o => o.waitlistPosition), [1,2,3]);
  const view = findOrder(x.system, c.id, queued[1].id);
  assert.equal(view.viewerName, x.system.db.prepare('SELECT name FROM users WHERE id=?').get(c.id).name);
  assert.equal(view.location, 'Hall'); assert.equal(view.registrationDeadline, event.sessions[0].deadline);
  assert.equal(view.waitlistPosition, 2); assert.equal(view.refundPreview.allowed, false);
  assert.deepEqual(x.system.orderView(queued[1].id), view);
  x.system.leaveWaitlist(b.id, queued[0].id);
  assert.equal(findOrder(x.system, c.id, queued[1].id).waitlistPosition, 1);
  assert.equal(findOrder(x.system, d.id, queued[2].id).waitlistPosition, 2);
  x.system.refund(a.id, first.id);
  assert.equal(findOrder(x.system, c.id, queued[1].id).state, 'issued');
  assert.equal(findOrder(x.system, c.id, queued[1].id).waitlistPosition, null);
  assert.equal(findOrder(x.system, d.id, queued[2].id).waitlistPosition, 1);
});

for (const [days, expected] of [[8,8000],[7,6000],[3,6000],[3 - 1 / DAY,null]]) {
  test(`refund preview matches actual refund at ${days} days`, t => {
    const x = setup(t); const event = x.event(); const buyer = x.user();
    const pending = x.system.createOrder(buyer.id, { tierId: event.sessions[0].tiers[0].id });
    x.system.pay(buyer.id, pending.id, { success: true });
    x.now += (10 - days) * DAY;
    const preview = findOrder(x.system, buyer.id, pending.id).refundPreview;
    if (expected === null) { assert.equal(preview.allowed, false); assert.throws(() => x.system.refund(buyer.id, pending.id)); }
    else { assert.equal(preview.allowed, true); assert.equal(preview.refundCents, expected); assert.equal(preview.feeCents, 10000 - expected); assert.equal(x.system.refund(buyer.id, pending.id).refundCents, preview.refundCents); }
  });
}

test('theme and available filters respect matching theme, sale window, deadline and inventory', t => {
  const x = setup(t); const event = x.event(); const buyer = x.user(); const session = event.sessions[0];
  const includes = filters => x.system.listEvents(null, filters).some(row => row.id === event.id);
  assert.equal(includes({ theme: 'usi', available: 'true' }), true);
  assert.equal(includes({ theme: 'theatre', available: 'true' }), false);
  const pending = x.system.createOrder(buyer.id, { tierId: session.tiers[0].id });
  assert.equal(includes({ available: 'true' }), false);
  x.system.pay(buyer.id, pending.id, { success: true }); x.system.refund(buyer.id, pending.id);
  assert.equal(includes({ available: 'true' }), true);
  x.now = Date.parse(session.saleAt) - 1;
  assert.equal(includes({ available: 'true' }), false);
  x.now = Date.parse(session.deadline);
  assert.equal(includes({ available: 'true' }), false);
});

test('checkin status is restricted to staff and contains aggregate window counts only', t => {
  const x = setup(t); const event = x.event(); const checker = x.user('checker'); const buyer = x.user();
  assert.throws(() => x.system.checkinStatus(buyer.id));
  assert.throws(() => x.system.checkinStatus(x.organizer.id));
  assert.deepEqual(x.system.checkinStatus(checker.id), { sessionCount: 0, openCount: 0 });
  x.now = Date.parse(event.sessions[0].startsAt) - 3 * 3600000;
  assert.deepEqual(x.system.checkinStatus(checker.id), { sessionCount: 1, openCount: 0 });
  x.system.openCheckin(x.admin.id, event.sessions[0].id);
  assert.deepEqual(x.system.checkinStatus(checker.id), { sessionCount: 1, openCount: 1 });
  assert.deepEqual(x.system.checkinStatus(x.admin.id), { sessionCount: 1, openCount: 1 });
});

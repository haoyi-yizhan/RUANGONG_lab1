import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('participant','organizer','checker','admin')),
  name TEXT NOT NULL DEFAULT '',
  id_number TEXT UNIQUE,
  banned INTEGER NOT NULL DEFAULT 0 CHECK(banned IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('performance','lecture')),
  speaker TEXT NOT NULL,
  theme TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','rejected','scheduled','published','cancelled','ended')),
  publish_at INTEGER NOT NULL,
  rejection TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  location TEXT NOT NULL,
  sale_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  checkin_open INTEGER NOT NULL DEFAULT 0,
  CHECK(sale_at < deadline AND deadline <= starts_at AND starts_at < ends_at)
);
CREATE TABLE IF NOT EXISTS tiers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK(price_cents > 0),
  capacity INTEGER NOT NULL CHECK(capacity > 0),
  UNIQUE(session_id, name)
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  kind TEXT NOT NULL CHECK(kind IN ('publish','reschedule','cancel')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  payload TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  reviewer_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_review ON reviews(event_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tier_id TEXT NOT NULL REFERENCES tiers(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  state TEXT NOT NULL CHECK(state IN ('pending','waiting','issued','checked_in','redeemed','absent','cancelled','closed','refunded')),
  price_cents INTEGER NOT NULL CHECK(price_cents > 0),
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK(paid_cents >= 0),
  refund_cents INTEGER NOT NULL DEFAULT 0 CHECK(refund_cents >= 0 AND refund_cents <= paid_cents),
  seat INTEGER,
  code TEXT UNIQUE,
  payment_deadline INTEGER NOT NULL,
  full_refund INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  checked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_order ON orders(user_id,session_id)
  WHERE state IN ('pending','waiting','issued','checked_in','redeemed','absent');
CREATE UNIQUE INDEX IF NOT EXISTS one_active_seat ON orders(tier_id,seat)
  WHERE state IN ('issued','checked_in','redeemed','absent');
CREATE INDEX IF NOT EXISTS orders_tier_state ON orders(tier_id,state);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id,created_at);
CREATE INDEX IF NOT EXISTS orders_session ON orders(session_id,state);
CREATE INDEX IF NOT EXISTS sessions_event ON sessions(event_id);
CREATE TABLE IF NOT EXISTS waitlist (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  tier_id TEXT NOT NULL REFERENCES tiers(id),
  joined_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS waitlist_queue ON waitlist(tier_id,sequence);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  amount_cents INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'simulated',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  fee_cents INTEGER NOT NULL CHECK(fee_cents >= 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status='completed'),
  channel TEXT NOT NULL DEFAULT 'simulated',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id),
  checker_id TEXT NOT NULL REFERENCES users(id),
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  before_value TEXT NOT NULL,
  after_value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_object ON audit(object_type,object_id,sequence);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT,'audit is append only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT,'audit is append only'); END;
PRAGMA user_version = 1;
`;

export function openDatabase(filename) {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec(SCHEMA);
  return db;
}

/** A synchronous transaction cannot yield between reservation and order creation. */
export function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

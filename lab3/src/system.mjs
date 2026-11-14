import { randomUUID } from 'node:crypto';
import { openDatabase, transaction } from './database.mjs';
import { authMethods } from './auth.mjs';
import { eventMethods } from './events.mjs';
import { queryMethods } from './queries.mjs';
import { tradingMethods } from './trading.mjs';
import { operationMethods } from './operations.mjs';
import { supportMethods } from './support.mjs';
import { hashSecret, secretToken } from './security.mjs';

/** Application facade. Each module owns its rules; SQLite owns atomic persistence. */
export class TicketingSystem {
  constructor({ filename = ':memory:', clock = Date.now } = {}) {
    this.db = openDatabase(filename);
    this.clock = clock;
  }

  now() {
    return Number(this.clock());
  }

  atomic(operation) {
    return transaction(this.db, operation);
  }

  close() {
    this.db.close();
  }

  bootstrap() {
    const accounts = [
      ['13800000001', 'Admin12345!', 'admin', '平台管理员'],
      ['13800000002', 'Checker123!', 'checker', '检票员'],
      ['13800000003', 'Organizer123!', 'organizer', '校园活动中心'],
      ['13800000004', 'Participant123!', 'participant', '演示观众'],
    ];
    for (const [phone, password, role, name] of accounts) {
      if (!this.db.prepare('SELECT id FROM users WHERE phone=?').get(phone)) {
        const id = randomUUID();
        this.atomic(() => {
          this.db
            .prepare(
              `INSERT INTO users
            (id,phone,password_hash,recovery_hash,role,name,id_number,created_at) VALUES (?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              phone,
              hashSecret(password),
              hashSecret(secretToken()),
              role,
              name,
              role === 'participant' ? '11010119900101001X' : null,
              this.now(),
            );
          this.audit('system', 'seed_account', 'user', id, '', role);
        });
      }
    }
    if (this.db.prepare('SELECT COUNT(*) AS n FROM events').get().n === 0) {
      const organizer = this.db.prepare("SELECT id FROM users WHERE phone='13800000003'").get().id;
      const admin = this.db.prepare("SELECT id FROM users WHERE phone='13800000001'").get().id;
      const now = this.now();
      const iso = (value) => new Date(value).toISOString();
      const day = 86400000;
      const event = this.createEvent(organizer, {
        title: '校园秋日音乐会',
        kind: 'performance',
        speaker: '校园乐队',
        theme: '音乐与青春',
        publishAt: iso(now - 60000),
        sessions: [
          {
            startsAt: iso(now + 10 * day),
            endsAt: iso(now + 10 * day + 7200000),
            saleAt: iso(now - 60000),
            deadline: iso(now + 9 * day),
            location: '大学生活动中心',
            tiers: [
              { name: '普通票', priceCents: 10000, capacity: 30 },
              { name: '前排票', priceCents: 18000, capacity: 10 },
            ],
          },
        ],
      });
      const pending = this.db
        .prepare("SELECT id FROM reviews WHERE event_id=? AND status='pending'")
        .get(event.id);
      this.review(admin, pending.id, { approved: true, reason: '演示数据自动初始化' });
    }
    this.maintain();
  }
}

Object.assign(
  TicketingSystem.prototype,
  supportMethods,
  authMethods,
  eventMethods,
  queryMethods,
  tradingMethods,
  operationMethods,
);

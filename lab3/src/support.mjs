import { randomUUID } from 'node:crypto';
import { ensure } from './errors.mjs';

export const supportMethods = {
  audit(actor, action, type, id, before = '', after = '') {
    this.db.prepare(`INSERT INTO audit
      (actor_id,action,object_type,object_id,before_value,after_value,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(actor || 'system', action, type, id,
      typeof before === 'string' ? before : JSON.stringify(before),
      typeof after === 'string' ? after : JSON.stringify(after), this.now());
  },

  notify(userId, body) {
    this.db.prepare('INSERT INTO messages(id,user_id,body,created_at) VALUES (?,?,?,?)')
      .run(randomUUID(), userId, body, this.now());
  },

  actor(actorId, roles = []) {
    const user = this.db.prepare('SELECT * FROM users WHERE id=?').get(actorId || '');
    ensure(user, 'UNAUTHENTICATED', '请先登录', 401);
    ensure(!user.banned, 'ACCOUNT_BANNED', '账号已被封禁', 403);
    if (roles.length && !roles.includes(user.role)) {
      this.audit(user.id, 'access_denied', 'permission', roles.join(','), user.role, 'denied');
      ensure(false, 'FORBIDDEN', '当前角色没有此操作权限', 403);
    }
    return user;
  },

  ownedEvent(actorId, eventId, roles = ['organizer', 'admin']) {
    const user = this.actor(actorId, roles);
    const event = this.db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
    ensure(event, 'NOT_FOUND', '活动不存在', 404);
    if (user.role !== 'admin' && event.organizer_id !== user.id) {
      this.audit(user.id, 'access_denied', 'event', eventId, '', 'denied');
      ensure(false, 'FORBIDDEN', '只能操作自己的活动', 403);
    }
    return event;
  },

  ownedOrder(actorId, orderId) {
    const user = this.actor(actorId, ['participant']);
    const row = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    ensure(row, 'NOT_FOUND', '订单不存在', 404);
    if (row.user_id !== user.id) {
      this.audit(user.id, 'access_denied', 'order', orderId, '', 'denied');
      ensure(false, 'FORBIDDEN', '只能操作自己的订单', 403);
    }
    return row;
  },

  listMessages(actorId) {
    const user = this.actor(actorId, ['participant', 'organizer', 'admin']);
    return this.db.prepare(`SELECT id,body,created_at FROM messages
      WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500`).all(user.id)
      .map(row => ({ id: row.id, body: row.body, createdAt: new Date(row.created_at).toISOString() }));
  },

  listAudit(actorId, filters = {}) {
    this.actor(actorId, ['admin']);
    const clauses = [];
    const values = [];
    if (filters.objectType) {
      clauses.push('object_type=?');
      values.push(filters.objectType);
    }
    if (filters.objectId) {
      clauses.push('object_id=?');
      values.push(filters.objectId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM audit ${where} ORDER BY sequence DESC LIMIT 1000`)
      .all(...values).map(row => ({
        sequence: row.sequence,
        actorId: row.actor_id,
        action: row.action,
        objectType: row.object_type,
        objectId: row.object_id,
        before: row.before_value,
        after: row.after_value,
        createdAt: new Date(row.created_at).toISOString(),
      }));
  },
};

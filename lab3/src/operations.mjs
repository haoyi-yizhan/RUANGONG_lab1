import { randomUUID } from 'node:crypto';
import { ensure, DomainError } from './errors.mjs';

export const operationMethods = {
  maintain() {
    return this.atomic(() => {
      const now = this.now();
      this.db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now);
      const upcoming = this.db.prepare("SELECT id FROM events WHERE status='scheduled' AND publish_at<=?").all(now);
      for (const event of upcoming) {
        this.db.prepare("UPDATE events SET status='published' WHERE id=?").run(event.id);
        this.audit('system', 'publish_event', 'event', event.id, 'scheduled', 'published');
      }
      // Replay reservation expirations chronologically, including downtime before a deadline.
      const expired = this.db.prepare(`SELECT * FROM orders WHERE state='pending'
        AND payment_deadline<=? ORDER BY payment_deadline,created_at,id`).all(now);
      for (const order of expired) {
        this.transition('system', order, 'closed', 'payment_timeout');
        this.promoteInternal(order.tier_id, order.payment_deadline);
      }
      const waiting = this.db.prepare(`SELECT o.* FROM orders o JOIN sessions s ON s.id=o.session_id
        WHERE o.state='waiting' AND s.deadline<=?`).all(now);
      for (const order of waiting) {
        this.refundInternal('system', order, 0, 'waitlist_expired');
      }
      const finished = this.db.prepare(`SELECT o.* FROM orders o JOIN sessions s ON s.id=o.session_id
        WHERE s.ends_at<=? AND o.state IN ('issued','checked_in')`).all(now);
      for (const order of finished) {
        this.transition('system', order, order.state === 'checked_in' ? 'redeemed' : 'absent', 'session_finished');
      }
      const ended = this.db.prepare(`SELECT e.id FROM events e
        WHERE e.status='published' AND NOT EXISTS
        (SELECT 1 FROM sessions s WHERE s.event_id=e.id AND s.ends_at>?)`).all(now);
      for (const event of ended) {
        this.db.prepare("UPDATE events SET status='ended' WHERE id=?").run(event.id);
        this.audit('system', 'finish_event', 'event', event.id, 'published', 'ended');
      }
      return { expired: expired.length, waitingRefunds: waiting.length, finished: finished.length };
    });
  },

  openCheckin(actorId, sessionId) {
    this.actor(actorId, ['admin']);
    this.maintain();
    return this.atomic(() => {
      const session = this.db.prepare(`SELECT s.*,e.status FROM sessions s
        JOIN events e ON e.id=s.event_id WHERE s.id=?`).get(sessionId);
      ensure(session, 'NOT_FOUND', '场次不存在', 404);
      ensure(session.status === 'published', 'INVALID_STATE', '场次所属活动未发布或已取消');
      ensure(this.now() >= session.starts_at - 3 * 60 * 60 * 1000 && this.now() < session.ends_at,
        'CHECKIN_TIME', '仅可在开演前 3 小时起至演出结束前开启签到');
      this.db.prepare('UPDATE sessions SET checkin_open=1 WHERE id=?').run(sessionId);
      this.audit(actorId, 'open_checkin', 'session', sessionId, Boolean(session.checkin_open), true);
      return { id: sessionId, checkinOpen: true };
    });
  },

  checkin(actorId, { code, idNumber }) {
    this.actor(actorId, ['checker']);
    ensure(typeof code === 'string' && code.length <= 100 && typeof idNumber === 'string',
      'INVALID_INPUT', '请填写票码和身份证号');
    this.maintain();
    const outcome = this.atomic(() => {
      const order = this.db.prepare(`SELECT o.*,u.id_number,s.checkin_open,s.ends_at,e.status AS event_status
        FROM orders o JOIN users u ON u.id=o.user_id JOIN sessions s ON s.id=o.session_id
        JOIN events e ON e.id=s.event_id WHERE o.code=?`).get(code);
      let failure = null;
      if (!order || order.event_status !== 'published') {
        failure = ['INVALID_TICKET', '票码无效、活动已取消或已结束'];
      } else if (['checked_in', 'redeemed'].includes(order.state)) {
        failure = ['ALREADY_CHECKED_IN', '该票已检票，禁止重复入场'];
      } else if (order.state !== 'issued') {
        failure = ['INVALID_TICKET', '票已取消、退款或失效'];
      } else if (!order.checkin_open || this.now() >= order.ends_at) {
        failure = ['CHECKIN_CLOSED', '签到窗口未开启，请暂时等候'];
      } else if (order.id_number !== idNumber) {
        failure = ['IDENTITY_MISMATCH', '身份证号与票面实名不一致'];
      }
      const result = failure ? failure[0] : 'admitted';
      this.db.prepare('INSERT INTO checkins(id,order_id,checker_id,result,created_at) VALUES (?,?,?,?,?)')
        .run(randomUUID(), order?.id || null, actorId, result, this.now());
      if (failure) {
        this.audit(actorId, 'checkin_denied', 'order', order?.id || 'unknown', '', result);
        return { failure };
      }
      this.transition(actorId, order, 'checked_in', 'checkin_success');
      this.db.prepare('UPDATE orders SET checked_at=? WHERE id=?').run(this.now(), order.id);
      // Checkers receive only the decision, never a participant profile or full order.
      return { admitted: true, message: '核验通过，准予入场' };
    });
    if (outcome.failure) {
      throw new DomainError(...outcome.failure);
    }
    return outcome;
  },

  statistics(actorId, sessionId) {
    const session = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    ensure(session, 'NOT_FOUND', '场次不存在', 404);
    this.ownedEvent(actorId, session.event_id);
    const rows = this.db.prepare('SELECT state,COUNT(*) AS n FROM orders WHERE session_id=? GROUP BY state')
      .all(sessionId);
    const counts = Object.fromEntries(rows.map(row => [row.state, row.n]));
    const issued = (counts.issued || 0) + (counts.checked_in || 0)
      + (counts.redeemed || 0) + (counts.absent || 0);
    const attended = (counts.checked_in || 0) + (counts.redeemed || 0);
    const purchased = this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM orders WHERE session_id=? AND code IS NOT NULL')
      .get(sessionId).n;
    return {
      issued, purchased, attended, waiting: counts.waiting || 0,
      refunded: (counts.cancelled || 0) + (counts.refunded || 0),
      absent: counts.absent || 0,
      attendanceRate: issued === 0 ? null : attended / issued,
    };
  },

  exportRoster(actorId, eventId, sessionId = null) {
    this.ownedEvent(actorId, eventId, ['organizer', 'admin']);
    if (sessionId) {
      ensure(this.db.prepare('SELECT id FROM sessions WHERE id=? AND event_id=?').get(sessionId, eventId),
        'INVALID_SESSION', '场次不属于该活动');
    }
    const extra = sessionId ? 'AND s.id=?' : '';
    const values = sessionId ? [eventId, sessionId] : [eventId];
    const rows = this.db.prepare(`SELECT u.name,u.phone,t.name AS tier_name,o.seat FROM orders o
      JOIN users u ON u.id=o.user_id JOIN tiers t ON t.id=o.tier_id JOIN sessions s ON s.id=o.session_id
      WHERE s.event_id=? ${extra} AND o.state IN ('issued','checked_in','redeemed','absent')
      ORDER BY s.starts_at,t.name,o.seat`).all(...values);
    const cell = value => {
      let safe = String(value ?? '');
      // Prevent spreadsheet formula evaluation when a malicious display name is exported.
      if (/^[=+@\-\t\r]/u.test(safe)) {
        safe = `'${safe}`;
      }
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const csv = [['姓名', '联系方式', '座位号'],
      ...rows.map(row => [row.name, row.phone, `${row.tier_name}-${String(row.seat).padStart(4, '0')}`])]
      .map(row => row.map(cell).join(',')).join('\r\n');
    this.audit(actorId, 'export_roster', 'event', eventId, '', { sessionId, records: rows.length });
    return `\uFEFF${csv}\r\n`;
  },
};

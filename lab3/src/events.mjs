import { randomUUID } from 'node:crypto';
import { ensure, integer, text, timestamp } from './errors.mjs';

function sessionInput(input, now) {
  ensure(input && typeof input === 'object', 'INVALID_INPUT', '场次数据缺失');
  const startsAt = timestamp(input.startsAt, '开始时间');
  const endsAt = timestamp(input.endsAt, '结束时间');
  const saleAt = timestamp(input.saleAt, '起售时间');
  const deadline = timestamp(input.deadline, '报名截止时间');
  ensure(saleAt < deadline && deadline <= startsAt && startsAt < endsAt && startsAt > now,
    'INVALID_SCHEDULE', '应满足起售 < 截止 ≤ 开始 < 结束，且演出尚未开始');
  ensure(Array.isArray(input.tiers) && input.tiers.length >= 1 && input.tiers.length <= 20,
    'INVALID_TIERS', '每场次须有 1～20 个票档');
  const names = new Set();
  const tiers = input.tiers.map(tier => {
    const name = text(tier.name, '票档名称', 50);
    ensure(!names.has(name), 'DUPLICATE_TIER', '同一场次票档名称不可重复');
    names.add(name);
    return {
      name,
      priceCents: integer(tier.priceCents, '票价（分）', 1, 100000000),
      capacity: integer(tier.capacity, '票数', 1, 100000),
    };
  });
  return { startsAt, endsAt, saleAt, deadline, location: text(input.location, '地点'), tiers };
}

export const eventMethods = {
  validateEvent(input) {
    ensure(input && typeof input === 'object', 'INVALID_INPUT', '缺少活动数据');
    ensure(['performance', 'lecture'].includes(input.kind), 'INVALID_KIND', '类型应为演出或讲座');
    ensure(Array.isArray(input.sessions) && input.sessions.length >= 1 && input.sessions.length <= 30,
      'INVALID_SESSIONS', '活动须包含 1～30 个场次');
    const publishAt = timestamp(input.publishAt, '上线时间');
    const sessions = input.sessions.map(row => sessionInput(row, this.now()));
    ensure(sessions.every(row => publishAt <= row.saleAt), 'INVALID_SCHEDULE', '上线时间不得晚于起售时间');
    return {
      title: text(input.title, '活动名称', 100), kind: input.kind,
      speaker: text(input.speaker, '主演或主讲', 100), theme: text(input.theme, '主题', 200),
      publishAt, sessions,
    };
  },

  insertSessions(eventId, sessions) {
    for (const session of sessions) {
      const id = randomUUID();
      this.db.prepare(`INSERT INTO sessions
        (id,event_id,starts_at,ends_at,location,sale_at,deadline) VALUES (?,?,?,?,?,?,?)`)
        .run(id, eventId, session.startsAt, session.endsAt, session.location, session.saleAt, session.deadline);
      for (const tier of session.tiers) {
        this.db.prepare('INSERT INTO tiers(id,session_id,name,price_cents,capacity) VALUES (?,?,?,?,?)')
          .run(randomUUID(), id, tier.name, tier.priceCents, tier.capacity);
      }
    }
  },

  createEvent(actorId, input) {
    const actor = this.actor(actorId, ['organizer']);
    const event = this.validateEvent(input);
    const id = randomUUID();
    this.atomic(() => {
      this.db.prepare(`INSERT INTO events
        (id,organizer_id,title,kind,speaker,theme,status,publish_at,created_at)
        VALUES (?,?,?,?,?,?,'pending',?,?)`)
        .run(id, actor.id, event.title, event.kind, event.speaker, event.theme, event.publishAt, this.now());
      this.insertSessions(id, event.sessions);
      this.db.prepare(`INSERT INTO reviews(id,event_id,kind,payload,created_at) VALUES (?,?,'publish',?,?)`)
        .run(randomUUID(), id, JSON.stringify(event), this.now());
      this.audit(actor.id, 'create_event', 'event', id, '', 'pending');
      this.audit(actor.id, 'submit_review', 'event', id, '', 'publish');
    });
    return this.getEvent(actor.id, id);
  },

  resubmitEvent(actorId, eventId, input) {
    const old = this.ownedEvent(actorId, eventId, ['organizer']);
    ensure(old.status === 'rejected', 'INVALID_STATE', '只能修改并重新提交被驳回的申请');
    const event = this.validateEvent(input);
    this.atomic(() => {
      this.db.prepare('DELETE FROM tiers WHERE session_id IN (SELECT id FROM sessions WHERE event_id=?)')
        .run(eventId);
      this.db.prepare('DELETE FROM sessions WHERE event_id=?').run(eventId);
      this.db.prepare(`UPDATE events SET title=?,kind=?,speaker=?,theme=?,publish_at=?,
        status='pending',rejection='' WHERE id=?`)
        .run(event.title, event.kind, event.speaker, event.theme, event.publishAt, eventId);
      this.insertSessions(eventId, event.sessions);
      this.db.prepare(`INSERT INTO reviews(id,event_id,kind,payload,created_at) VALUES (?,?,'publish',?,?)`)
        .run(randomUUID(), eventId, JSON.stringify(event), this.now());
      this.audit(actorId, 'resubmit_review', 'event', eventId, 'rejected', 'pending');
    });
    return this.getEvent(actorId, eventId);
  },

  requestChange(actorId, eventId, input) {
    const event = this.ownedEvent(actorId, eventId, ['organizer']);
    ensure(['published', 'scheduled'].includes(event.status), 'INVALID_STATE', '只能变更已通过审核的活动');
    ensure(input && ['reschedule', 'cancel'].includes(input.kind), 'INVALID_CHANGE', '变更类型无效');
    const reason = text(input.reason, '变更原因', 500);
    const sessions = this.db.prepare('SELECT * FROM sessions WHERE event_id=?').all(eventId);
    ensure(sessions.every(row => row.starts_at > this.now()), 'EVENT_STARTED', '活动已开始，不能再变更');
    let payload = {};
    if (input.kind === 'reschedule') {
      ensure(Array.isArray(input.sessions) && input.sessions.length === sessions.length,
        'INVALID_SESSIONS', '改期须提供全部原有场次');
      const ids = new Set();
      payload = { sessions: input.sessions.map(row => {
        const old = sessions.find(session => session.id === row.id);
        ensure(old && !ids.has(row.id), 'INVALID_SESSION', '场次不存在或重复');
        ids.add(row.id);
        const startsAt = timestamp(row.startsAt, '新开始时间');
        const endsAt = timestamp(row.endsAt, '新结束时间');
        ensure(startsAt > this.now() && startsAt >= old.deadline && endsAt > startsAt,
          'INVALID_SCHEDULE', '新时间须晚于截止和当前时间，且开始早于结束');
        return { id: row.id, startsAt, endsAt, location: text(row.location, '新地点') };
      }) };
    }
    return this.atomic(() => {
      ensure(!this.db.prepare("SELECT id FROM reviews WHERE event_id=? AND status='pending'").get(eventId),
        'PENDING_REVIEW', '该活动已有待审核申请');
      const id = randomUUID();
      this.db.prepare('INSERT INTO reviews(id,event_id,kind,payload,reason,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, eventId, input.kind, JSON.stringify(payload), reason, this.now());
      this.audit(actorId, 'submit_change', 'event', eventId, event.status, { reviewId: id, ...input });
      return { id, eventId, kind: input.kind, status: 'pending' };
    });
  },

  listReviews(actorId) {
    const actor = this.actor(actorId, ['admin', 'organizer']);
    const where = actor.role === 'admin' ? '' : 'WHERE e.organizer_id=?';
    const values = actor.role === 'admin' ? [] : [actor.id];
    return this.db.prepare(`SELECT r.*,e.title FROM reviews r JOIN events e ON e.id=r.event_id
      ${where} ORDER BY r.created_at DESC,r.rowid DESC`).all(...values).map(row => ({
      id: row.id, eventId: row.event_id, eventTitle: row.title, kind: row.kind,
      status: row.status, reason: row.reason, payload: JSON.parse(row.payload),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  },

  review(actorId, reviewId, { approved, reason }) {
    this.actor(actorId, ['admin']);
    ensure(typeof approved === 'boolean', 'INVALID_INPUT', '审核结论须为布尔值');
    const explanation = approved ? String(reason || '').slice(0, 500) : text(reason, '驳回原因', 500);
    this.maintain();
    return this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM reviews WHERE id=?').get(reviewId);
      ensure(row, 'NOT_FOUND', '审核记录不存在', 404);
      ensure(row.status === 'pending', 'INVALID_STATE', '申请已审核，不能重复审核');
      const event = this.db.prepare('SELECT * FROM events WHERE id=?').get(row.event_id);
      const sessions = this.db.prepare('SELECT * FROM sessions WHERE event_id=?').all(event.id);
      if (approved) {
        ensure(sessions.every(session => session.starts_at > this.now()), 'EVENT_STARTED', '场次已开始，不能批准');
      }
      if (row.kind === 'publish') {
        const status = approved ? (event.publish_at <= this.now() ? 'published' : 'scheduled') : 'rejected';
        this.db.prepare('UPDATE events SET status=?,rejection=? WHERE id=?')
          .run(status, approved ? '' : explanation, event.id);
        this.audit(actorId, approved ? 'approve_publish' : 'reject_publish', 'event', event.id, event.status, status);
        if (status === 'published') {
          this.audit(actorId, 'publish_event', 'event', event.id, 'scheduled', 'published');
        }
      } else if (approved && row.kind === 'cancel') {
        this.cancelEventInternal(actorId, event.id);
      } else if (approved && row.kind === 'reschedule') {
        const payload = JSON.parse(row.payload);
        ensure(payload.sessions.every(session => session.startsAt > this.now()),
          'INVALID_SCHEDULE', '申请中的新开始时间已过期，请驳回后重新提交');
        for (const session of payload.sessions) {
          this.db.prepare('UPDATE sessions SET starts_at=?,ends_at=?,location=?,checkin_open=0 WHERE id=?')
            .run(session.startsAt, session.endsAt, session.location, session.id);
        }
        // An approved move invalidates check-in at the old time/location, retaining the same seat.
        const checked = this.db.prepare(`SELECT o.* FROM orders o JOIN sessions s ON s.id=o.session_id
          WHERE s.event_id=? AND o.state='checked_in'`).all(event.id);
        for (const order of checked) {
          this.db.prepare("UPDATE orders SET state='issued',checked_at=NULL WHERE id=?").run(order.id);
          this.audit(actorId, 'reschedule_reset_checkin', 'order', order.id, 'checked_in', 'issued');
        }
        this.db.prepare("UPDATE orders SET full_refund=1 WHERE session_id IN (SELECT id FROM sessions WHERE event_id=?) AND state='issued'")
          .run(event.id);
        this.notifyEventBuyers(event.id, '活动时间或地点已变更，现有已出票订单可选择全额退款。');
        this.audit(actorId, 'reschedule_event', 'event', event.id, sessions, payload.sessions);
      }
      this.db.prepare('UPDATE reviews SET status=?,reason=?,reviewer_id=?,reviewed_at=? WHERE id=?')
        .run(approved ? 'approved' : 'rejected', explanation, actorId, this.now(), reviewId);
      this.audit(actorId, 'review', 'review', reviewId, 'pending', approved ? 'approved' : 'rejected');
      this.notify(event.organizer_id, `活动「${event.title}」申请${approved ? '通过' : `驳回：${explanation}`}。`);
      return { id: reviewId, status: approved ? 'approved' : 'rejected' };
    });
  },

  notifyEventBuyers(eventId, body) {
    const users = this.db.prepare(`SELECT DISTINCT o.user_id FROM orders o
      JOIN sessions s ON s.id=o.session_id WHERE s.event_id=? AND o.paid_cents>0`).all(eventId);
    for (const user of users) {
      this.notify(user.user_id, body);
    }
  },
};

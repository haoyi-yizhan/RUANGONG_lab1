import { ensure, timestamp } from './errors.mjs';

const iso = value => new Date(value).toISOString();

export const queryMethods = {
  remaining(tierId) {
    const tier = this.db.prepare('SELECT capacity FROM tiers WHERE id=?').get(tierId);
    ensure(tier, 'NOT_FOUND', '票档不存在', 404);
    const occupied = this.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE tier_id=?
      AND state IN ('pending','issued','checked_in','redeemed','absent')`).get(tierId).n;
    return tier.capacity - occupied;
  },

  eventView(row) {
    const sessions = this.db.prepare('SELECT * FROM sessions WHERE event_id=? ORDER BY starts_at,id')
      .all(row.id).map(session => ({
        id: session.id, startsAt: iso(session.starts_at), endsAt: iso(session.ends_at),
        location: session.location, saleAt: iso(session.sale_at), deadline: iso(session.deadline),
        checkinOpen: Boolean(session.checkin_open),
        tiers: this.db.prepare('SELECT * FROM tiers WHERE session_id=? ORDER BY price_cents,id')
          .all(session.id).map(tier => ({
            id: tier.id, name: tier.name, priceCents: tier.price_cents,
            capacity: tier.capacity, remaining: this.remaining(tier.id),
          })),
      }));
    return {
      id: row.id, organizerId: row.organizer_id, title: row.title, kind: row.kind,
      speaker: row.speaker, theme: row.theme, status: row.status, publishAt: iso(row.publish_at),
      rejection: row.rejection, sessions,
      rules: '每账号每场次限一张；3分钟内支付；候补预付全款；超过7天退票手续费20%，3～7天40%，不足3天不可退；改期获准的原订单可全额退。',
    };
  },

  listEvents(actorId, filters = {}) {
    const actor = actorId ? this.actor(actorId, ['participant', 'organizer', 'admin']) : null;
    const clauses = [];
    const values = [];
    if (actor?.role === 'organizer') {
      clauses.push('e.organizer_id=?');
      values.push(actor.id);
    } else if (actor?.role !== 'admin') {
      clauses.push("e.status='published'");
    }
    if (filters.id) {
      clauses.push('e.id=?');
      values.push(filters.id);
    }
    for (const [key, column] of [['keyword', 'e.title || e.theme'], ['speaker', 'e.speaker']]) {
      if (filters[key]) {
        clauses.push(`instr(lower(${column}),lower(?))>0`);
        values.push(String(filters[key]).slice(0, 200));
      }
    }
    // All session filters apply to the same session rather than different sessions of an event.
    const sessionClauses = ['s.event_id=e.id'];
    if (filters.location) {
      sessionClauses.push('instr(lower(s.location),lower(?))>0');
      values.push(String(filters.location).slice(0, 200));
    }
    if (filters.from) {
      sessionClauses.push('s.starts_at>=?');
      values.push(timestamp(filters.from, '筛选开始时间'));
    }
    if (filters.to) {
      sessionClauses.push('s.starts_at<=?');
      values.push(timestamp(filters.to, '筛选结束时间'));
    }
    clauses.push(`EXISTS (SELECT 1 FROM sessions s WHERE ${sessionClauses.join(' AND ')})`);
    return this.db.prepare(`SELECT e.* FROM events e WHERE ${clauses.join(' AND ')}
      ORDER BY e.created_at DESC,e.id LIMIT 200`).all(...values).map(row => this.eventView(row));
  },

  getEvent(actorId, eventId) {
    const actor = actorId ? this.actor(actorId, ['participant', 'organizer', 'admin']) : null;
    const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
    ensure(row, 'NOT_FOUND', '活动不存在', 404);
    if (row.status !== 'published' && actor?.role !== 'admin' && row.organizer_id !== actor?.id) {
      if (actor) {
        this.audit(actor.id, 'access_denied', 'event', eventId, '', 'denied');
      }
      ensure(false, 'FORBIDDEN', '该活动尚未公开或已结束', 403);
    }
    return this.eventView(row);
  },

  orderView(orderId) {
    const row = this.db.prepare(`SELECT o.*,e.title,s.starts_at,t.name AS tier_name
      FROM orders o JOIN tiers t ON t.id=o.tier_id JOIN sessions s ON s.id=o.session_id
      JOIN events e ON e.id=s.event_id WHERE o.id=?`).get(orderId);
    ensure(row, 'NOT_FOUND', '订单不存在', 404);
    return this.mapOrder(row);
  },

  mapOrder(row) {
    return {
      id: row.id, userId: row.user_id, tierId: row.tier_id, sessionId: row.session_id,
      eventTitle: row.title, tierName: row.tier_name, startsAt: iso(row.starts_at), state: row.state,
      priceCents: row.price_cents, paidCents: row.paid_cents, refundCents: row.refund_cents,
      seat: row.seat === null ? null : `${row.tier_name}-${String(row.seat).padStart(4, '0')}`,
      code: row.code, paymentDeadline: iso(row.payment_deadline), fullRefund: Boolean(row.full_refund),
      createdAt: iso(row.created_at),
    };
  },

  listOrders(actorId, filters = {}) {
    const actor = this.actor(actorId, ['participant', 'admin']);
    const clauses = [];
    const values = [];
    if (actor.role === 'participant') {
      clauses.push('o.user_id=?');
      values.push(actor.id);
      ensure(!filters.userId || filters.userId === actor.id, 'FORBIDDEN', '只能查询自己的订单', 403);
    } else if (filters.userId) {
      clauses.push('o.user_id=?');
      values.push(filters.userId);
    }
    if (filters.id) {
      clauses.push('o.id=?');
      values.push(filters.id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT o.*,e.title,s.starts_at,t.name AS tier_name
      FROM orders o JOIN tiers t ON t.id=o.tier_id JOIN sessions s ON s.id=o.session_id
      JOIN events e ON e.id=s.event_id ${where} ORDER BY o.created_at DESC,o.rowid DESC LIMIT 500`)
      .all(...values).map(row => this.mapOrder(row));
  },
};

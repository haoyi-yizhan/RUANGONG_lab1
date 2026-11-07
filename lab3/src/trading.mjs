import { randomUUID, randomBytes } from 'node:crypto';
import { ensure } from './errors.mjs';

const DAY = 24 * 60 * 60 * 1000;
const TRANSITIONS = {
  pending: ['issued', 'closed'],
  waiting: ['issued', 'refunded'],
  issued: ['cancelled', 'checked_in', 'absent', 'refunded'],
  checked_in: ['redeemed', 'refunded'],
};

export const tradingMethods = {
  transition(actorId, order, target, action) {
    ensure(TRANSITIONS[order.state]?.includes(target), 'INVALID_STATE', `订单状态 ${order.state} 不允许转为 ${target}`);
    this.db.prepare('UPDATE orders SET state=? WHERE id=?').run(target, order.id);
    this.audit(actorId, action, 'order', order.id, order.state, target);
    order.state = target;
  },

  createOrder(actorId, { tierId, waitlist = false }) {
    const actor = this.actor(actorId, ['participant']);
    ensure(actor.id_number, 'IDENTITY_REQUIRED', '请先完成实名认证');
    ensure(typeof waitlist === 'boolean', 'INVALID_INPUT', '候补选项无效');
    this.maintain();
    const id = randomUUID();
    this.atomic(() => {
      const tier = this.db.prepare(`SELECT t.*,s.event_id,s.starts_at,s.sale_at,s.deadline,e.status
        FROM tiers t JOIN sessions s ON s.id=t.session_id JOIN events e ON e.id=s.event_id
        WHERE t.id=?`).get(tierId || '');
      ensure(tier, 'NOT_FOUND', '票档不存在', 404);
      ensure(tier.status === 'published' && this.now() >= tier.sale_at && this.now() < tier.deadline,
        'SALES_CLOSED', '活动尚未起售、已截止或已取消');
      const duplicate = this.db.prepare(`SELECT id FROM orders WHERE user_id=? AND session_id=?
        AND state IN ('pending','waiting','issued','checked_in','redeemed','absent')`).get(actor.id, tier.session_id);
      ensure(!duplicate, 'PURCHASE_LIMIT', `同一场次限购一张，已有订单 ${duplicate?.id || ''}`, 409);
      const available = this.remaining(tier.id);
      ensure(available > 0 || waitlist, 'SOLD_OUT', '票档售罄，可选择预付候补', 409);
      const state = available > 0 ? 'pending' : 'waiting';
      const paid = state === 'waiting' ? tier.price_cents : 0;
      this.db.prepare(`INSERT INTO orders
        (id,user_id,tier_id,session_id,state,price_cents,paid_cents,payment_deadline,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, actor.id, tier.id, tier.session_id, state, tier.price_cents, paid, this.now() + 180000, this.now());
      if (state === 'waiting') {
        this.db.prepare('INSERT INTO waitlist(order_id,tier_id,joined_at) VALUES (?,?,?)')
          .run(id, tier.id, this.now());
        this.recordPayment(id, paid);
        this.audit(actor.id, 'waitlist_prepaid', 'order', id, '', state);
      } else {
        this.audit(actor.id, 'create_order', 'order', id, '', state);
      }
    });
    return this.orderView(id);
  },

  recordPayment(orderId, amount) {
    this.db.prepare('INSERT INTO payments(id,order_id,amount_cents,created_at) VALUES (?,?,?,?)')
      .run(randomUUID(), orderId, amount, this.now());
  },

  issueInternal(actorId, order, action = 'issue_ticket') {
    const tier = this.db.prepare('SELECT * FROM tiers WHERE id=?').get(order.tier_id);
    const seats = new Set(this.db.prepare(`SELECT seat FROM orders WHERE tier_id=?
      AND state IN ('issued','checked_in','redeemed','absent')`).all(tier.id).map(row => row.seat));
    let seat = 1;
    while (seats.has(seat) && seat <= tier.capacity) {
      seat += 1;
    }
    ensure(seat <= tier.capacity, 'CAPACITY_EXCEEDED', '没有可分配座位', 409);
    const code = randomBytes(18).toString('base64url');
    this.db.prepare('UPDATE orders SET seat=?,code=? WHERE id=?').run(seat, code, order.id);
    this.transition(actorId, order, 'issued', action);
    this.notify(order.user_id, `订单 ${order.id} 已出票，座位 ${tier.name}-${seat}，请在“我的订单”查看票码。`);
  },

  pay(actorId, orderId, { success = true } = {}) {
    this.ownedOrder(actorId, orderId);
    ensure(typeof success === 'boolean', 'INVALID_INPUT', '模拟支付结果无效');
    this.maintain();
    this.atomic(() => {
      const order = this.ownedOrder(actorId, orderId);
      // A successful duplicate callback acknowledges the existing charge without a second write.
      if (order.state === 'issued' && success && this.db.prepare('SELECT id FROM payments WHERE order_id=?').get(orderId)) {
        return;
      }
      ensure(order.state === 'pending', 'INVALID_STATE', `当前订单为 ${order.state}，不可支付`);
      ensure(this.now() < order.payment_deadline, 'PAYMENT_EXPIRED', '支付已超时');
      if (!success) {
        this.audit(actorId, 'payment_failed', 'order', orderId, 'pending', 'pending');
        return;
      }
      this.recordPayment(orderId, order.price_cents);
      this.db.prepare('UPDATE orders SET paid_cents=price_cents WHERE id=?').run(orderId);
      this.audit(actorId, 'payment_success', 'order', orderId, 0, order.price_cents);
      this.issueInternal(actorId, order);
    });
    return this.orderView(orderId);
  },

  refundInternal(actorId, order, feeCents, reason, target = 'refunded') {
    ensure(!this.db.prepare('SELECT id FROM refunds WHERE order_id=?').get(order.id),
      'ALREADY_REFUNDED', '订单已退款');
    const amount = order.paid_cents - feeCents;
    ensure(amount >= 0 && Number.isSafeInteger(amount), 'INVALID_REFUND', '退款金额无效');
    this.db.prepare(`INSERT INTO refunds
      (id,order_id,amount_cents,fee_cents,reason,created_at) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), order.id, amount, feeCents, reason, this.now());
    this.db.prepare('UPDATE orders SET refund_cents=? WHERE id=?').run(amount, order.id);
    this.transition(actorId, order, target, reason);
    this.notify(order.user_id, `订单 ${order.id} 已原路退回模拟支付账户 ${(amount / 100).toFixed(2)} 元。`);
  },

  refund(actorId, orderId) {
    this.ownedOrder(actorId, orderId);
    this.maintain();
    this.atomic(() => {
      const order = this.ownedOrder(actorId, orderId);
      ensure(order.state === 'issued', 'INVALID_STATE', `当前订单为 ${order.state}，不可退票`);
      const session = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(order.session_id);
      if (order.full_refund) {
        this.refundInternal(actorId, order, 0, 'reschedule_refund');
      } else {
        const until = session.starts_at - this.now();
        ensure(until >= 3 * DAY, 'REFUND_WINDOW_CLOSED', '不足三天或已开演，不可退票');
        // Integer cents, round half up. Exactly 7 days belongs to the 40% tier.
        const percent = until > 7 * DAY ? 20 : 40;
        const fee = Math.floor((order.paid_cents * percent + 50) / 100);
        this.refundInternal(actorId, order, fee, 'self_refund', 'cancelled');
      }
      this.promoteInternal(order.tier_id);
    });
    return this.orderView(orderId);
  },

  leaveWaitlist(actorId, orderId) {
    this.ownedOrder(actorId, orderId);
    this.maintain();
    this.atomic(() => {
      const order = this.ownedOrder(actorId, orderId);
      ensure(order.state === 'waiting', 'INVALID_STATE', `当前订单为 ${order.state}，不能退出候补`);
      this.refundInternal(actorId, order, 0, 'leave_waitlist');
    });
    return this.orderView(orderId);
  },

  promoteInternal(tierId, effectiveTime = this.now()) {
    const session = this.db.prepare(`SELECT s.*,e.status FROM tiers t JOIN sessions s ON s.id=t.session_id
      JOIN events e ON e.id=s.event_id WHERE t.id=?`).get(tierId);
    if (session.status !== 'published' || effectiveTime >= session.deadline) {
      return;
    }
    while (this.remaining(tierId) > 0) {
      const order = this.db.prepare(`SELECT o.* FROM waitlist w JOIN orders o ON o.id=w.order_id
        WHERE w.tier_id=? AND o.state='waiting' AND w.joined_at<=?
        ORDER BY w.sequence LIMIT 1`).get(tierId, effectiveTime);
      if (!order) {
        break;
      }
      this.issueInternal('system', order, 'waitlist_promoted');
    }
  },

  cancelEventInternal(actorId, eventId) {
    const event = this.db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
    ensure(['published', 'scheduled'].includes(event.status), 'INVALID_STATE', '活动当前不可取消');
    this.db.prepare("UPDATE events SET status='cancelled' WHERE id=?").run(eventId);
    const orders = this.db.prepare(`SELECT o.* FROM orders o JOIN sessions s ON s.id=o.session_id
      WHERE s.event_id=? AND o.state IN ('pending','waiting','issued','checked_in')`).all(eventId);
    for (const order of orders) {
      if (order.state === 'pending') {
        this.transition(actorId, order, 'closed', 'event_cancel_close');
      } else {
        this.refundInternal(actorId, order, 0, 'event_cancel_refund');
      }
    }
    this.notifyEventBuyers(eventId, '活动已取消，仍有效的已付订单已全额原路退款。');
    this.audit(actorId, 'cancel_event', 'event', eventId, event.status, 'cancelled');
  },
};

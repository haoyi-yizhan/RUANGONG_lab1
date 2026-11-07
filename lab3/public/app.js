'use strict';

const state = { user: null, page: 'events', events: [], orders: [], refresh: null };
const content = document.querySelector('#content');
const navigation = document.querySelector('#navigation');
const dialog = document.querySelector('#dialog');
const dialogContent = document.querySelector('#dialog-content');
const notice = document.querySelector('#notice');
const roles = { participant: '参与者', organizer: '组织者', admin: '管理员', checker: '检票员' };
const labels = {
  scheduled: '待发布', ended: '已结束', pending: '待审核', approved: '已通过', rejected: '已驳回', published: '已发布',
  cancelled: '已取消', canceled: '已取消', draft: '草稿', unpaid: '待支付',
  pending_payment: '待支付', paid: '已支付', refunded: '已退款', waiting: '候补中',
  waitlisted: '候补中', expired: '已过期', checked_in: '已入场', publish: '发布申请',
  reschedule: '变更申请', cancel: '取消申请', performance: '演出', lecture: '讲座'
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value ?? '';
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') node.value = value ?? '';
    else if (key === 'checked') node.checked = value;
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
function button(text, action, variant = '') {
  return el('button', { type: 'button', class: `button ${variant}`, onclick: action }, text);
}
function field(label, name, type = 'text', options = {}) {
  const input = el(type === 'textarea' ? 'textarea' : 'input', { name, type: type === 'textarea' ? null : type, ...options });
  return el('label', {}, label, input);
}
function selectField(label, name, choices, selected) {
  const select = el('select', { name });
  choices.forEach(([value, text]) => select.append(el('option', { value, selected: value === selected }, text)));
  return el('label', {}, label, select);
}
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
function money(cents) { return `¥${(Number(cents || 0) / 100).toFixed(2)}`; }
function time(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '待定'; }
function iso(value) { if (!value) throw new Error('请填写完整的日期和时间'); const date = new Date(value); if (Number.isNaN(date.getTime())) throw new Error('日期或时间格式有误，请检查后重试'); return date.toISOString(); }
function orderLabel(value) { const names = { pending: '待支付', issued: '已出票', checked_in: '已签到', redeemed: '已核销', absent: '已缺席', cancelled: '已取消', closed: '已关闭', refunded: '已退款', waiting: '候补中' }; return names[value] || value || '未知'; }
function localTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function label(value) { return labels[value] || value || '未知'; }
function tag(text, style = '') { return el('span', { class: `tag ${style}` }, text); }
function panel(...children) { return el('div', { class: 'panel' }, ...children); }
function heading(title, description) {
  return el('div', { class: 'section-head' },
    el('div', {},
    el('h2', {}, title), description && el('p', {}, description)));
}
function empty(title, description) { return el('div', { class: 'empty' },
    el('strong', {}, title), description); }
function showNotice(message, error = false) {
  notice.replaceChildren(el('div', { class: `notice ${error ? 'error' : ''}` }, message));
  setTimeout(() => notice.replaceChildren(), 7000);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('服务器响应无法读取'); }
  if (!response.ok || result.error) throw new Error(result.error?.message || '请求失败，请稍后重试');
  return result.data;
}
async function run(action, success) {
  try { await action(); if (success) showNotice(success); }
  catch (error) { showNotice(error.message, true); }
}
function modal(title, ...children) {
  const close = el('button', { class: 'close', type: 'button', 'aria-label': '关闭', onclick: () => dialog.close() }, '×');
  dialogContent.replaceChildren(el('div', { class: 'dialog-inner' },
    el('div', { class: 'dialog-head' },
    el('h2', {}, title), close), ...children));
  if (!dialog.open) dialog.showModal();
}
function submitForm(form, action) {
  form.addEventListener('submit', event => { event.preventDefault(); run(() => action(form)); });
  return form;
}
function loginRequired() {
  if (state.user) return true;
  authDialog('login');
  return false;
}
function setPage(page) { state.refresh = null; state.page = page; render(); }
function nav() {
  const items = state.user?.role === 'checker' ? [] : [['events', '◈', '发现活动'], ...(state.user?.role === 'organizer' ? [] : [['orders', '▤', '我的订单']]), ['messages', '✉', '站内消息']];
  if (state.user?.role === 'organizer') items.push(['organizer', '▧', '活动管理']);
  if (state.user?.role === 'admin') items.push(['reviews', '✓', '审核管理'], ['users', '♙', '用户管理'], ['audit', '≡', '审计记录']);
  if (['admin', 'checker'].includes(state.user?.role)) items.push(['checkin', '⌗', '现场检票']);
  navigation.replaceChildren(...items.map(([id, icon, text]) => el('button', {
    class: `nav-item ${state.page === id ? 'active' : ''}`, onclick: () => setPage(id)
  },
    el('span', { class: 'nav-icon' }, icon), text)));
  document.querySelector('#page-title').textContent = items.find(item => item[0] === state.page)?.[2] || '发现活动';
  document.querySelector('#user-badge').textContent = state.user ? `${state.user.name || state.user.phone} · ${roles[state.user.role] || state.user.role}` : '访客';
  document.querySelector('#account-button').textContent = state.user ? '账户' : '登录 / 注册';
}
function authDialog(mode = 'login') {
  const form = el('form', { class: 'stack' });
  const choices = mode === 'register' ? [['participant', '参与者'], ['organizer', '组织者']] : [];
  form.append(field('手机号', 'phone', 'tel', { required: true, placeholder: '请输入手机号' }));
  if (mode === 'reset') form.append(field('恢复码', 'recoveryCode', 'text', { required: true }));
  form.append(field(mode === 'reset' ? '新密码' : '密码', 'password', 'password', { required: true }));
  if (choices.length) form.append(selectField('注册身份', 'role', choices, 'participant'));
  form.append(el('button', { class: 'button', type: 'submit' }, mode === 'login' ? '登录' : mode === 'register' ? '创建账户' : '重置密码'));
  const switches = el('div', { class: 'actions' });
  if (mode !== 'login') switches.append(button('已有账户，去登录', () => authDialog('login'), 'secondary small'));
  if (mode !== 'register') switches.append(button('注册账户', () => authDialog('register'), 'secondary small'));
  if (mode !== 'reset') switches.append(button('忘记密码', () => authDialog('reset'), 'secondary small'));
  form.append(switches);
  submitForm(form, async f => {
    const credentials = formData(f);
    const result = await api(mode === 'login' ? '/api/login' : mode === 'register' ? '/api/register' : '/api/reset-password', { method: 'POST', body: credentials });
    if (mode === 'register') {
      try { const loggedIn = await api('/api/login', { method: 'POST', body: { phone: credentials.phone, password: credentials.password } }); state.user = loggedIn.user || loggedIn; } catch (error) { state.user = null; showNotice('注册成功，自动登录失败，请手动登录：' + error.message, true); }
      modal('注册成功',
    el('div', { class: 'stack' },
    el('p', {}, '请妥善保存以下恢复码，忘记密码时需要使用。'),
    el('strong', {}, result.recoveryCode),
    button('我已保存', () => { dialog.close(); render(); })));
    } else if (mode === 'reset') { state.user = null; modal('密码已重置', el('div', { class: 'stack' }, el('p', {}, '请保存新的恢复码，原恢复码已失效。'), el('strong', {}, result.recoveryCode), button('我已保存，去登录', () => authDialog('login')))); }
    else { state.user = result.user || result; if (state.user?.role === 'checker') state.page = 'checkin'; dialog.close(); await render(); showNotice('登录成功'); }
  });
  modal(mode === 'login' ? '欢迎回来' : mode === 'register' ? '加入聚场' : '找回密码', form);
}
function accountDialog() {
  if (!state.user) return authDialog();
  const actions = el('div', { class: 'stack' },
    el('p', { class: 'muted' }, `${state.user.phone} · ${roles[state.user.role] || state.user.role}`),
    el('p', {}, `实名信息：${state.user.name || '尚未认证'}`),
    button('实名认证', verifyDialog, 'secondary'),
    button('退出登录', () => run(async () => { await api('/api/logout', { method: 'POST', body: {} }); state.user = null; state.page = 'events'; dialog.close(); await render(); }, '已退出登录'), 'danger')
  );
  modal('我的账户', actions);
}
function verifyDialog() {
  const form = el('form', { class: 'stack' },
    field('真实姓名', 'name', 'text', { required: true }),
    field('身份证号', 'idNumber', 'text', { required: true }),
    el('button', { class: 'button' }, '提交认证'));
  submitForm(form, async f => { await api('/api/verify', { method: 'POST', body: formData(f) }); state.user = await api('/api/me'); dialog.close(); await render(); showNotice('实名认证成功'); });
  modal('实名认证', form);
}
function eventCard(event) {
  const first = event.sessions?.[0];
  const prices = (event.sessions || []).flatMap(s => (s.tiers || []).map(t => Number(t.priceCents)));
  const card = el('article', { class: 'card' },
    el('div', { class: 'card-cover' }, event.kind === 'lecture' ? 'IDEAS & INSPIRATION / 讲座' : 'LIVE & MOMENT / 演出'),
    el('div', { class: 'card-body' }, tag(label(event.kind)),
    el('h3', {}, event.title),
      el('p', {}, `◷  ${time(first?.startsAt)}`),
    el('p', {}, `⌖  ${first?.location || '地点待定'}`),
      el('p', {}, `${event.speaker ? `主讲 / 嘉宾：${event.speaker}` : event.theme || '精彩活动等你参与'}`),
      el('div', { class: 'actions' },
    el('strong', {}, prices.length ? `${money(Math.min(...prices))} 起` : '票价待定'),
    button('查看详情', () => eventDetail(event.id), 'secondary small'))));
  return card;
}
async function eventsPage() {
  const hero = el('div', { class: 'hero' },
    el('span', { class: 'eyebrow' }, 'MAKE EVERY MOMENT COUNT'),
    el('h2', {}, '好时光，值得亲临现场'),
    el('p', {}, '发现感兴趣的演出与讲座，在这里找到下一个值得期待的相聚。'));
  const form = el('form', { class: 'filters' },
    field('关键词', 'keyword', 'search', { placeholder: '活动名称或主题' }),
    field('地点', 'location', 'text', { placeholder: '输入地点' }),
    field('主讲 / 嘉宾', 'speaker', 'text', { placeholder: '输入姓名' }),
    field('开始日期', 'from', 'date'),
    field('结束日期', 'to', 'date'),
    state.user?.role === 'admin' && field('活动 ID', 'eventId', 'search', { placeholder: '输入活动 ID' }),
    el('button', { class: 'button', type: 'submit' }, '搜索活动'));
  const results = el('div');
  const load = async () => {
    const values = formData(form);
    if (values.from && values.to && values.from > values.to) throw new Error('开始日期不能晚于结束日期');
    const params = new URLSearchParams(Object.entries(values).filter(([key, value]) => key !== 'eventId' && value));
    if (values.from) params.set('from', iso(`${values.from}T00:00:00`));
    if (values.to) params.set('to', iso(`${values.to}T23:59:59.999`));
    if (values.eventId?.trim()) params.set('id', values.eventId.trim());
    state.events = await api(`/api/events?${params}`);
    results.replaceChildren(state.events.length ? el('div', { class: 'grid' }, state.events.map(eventCard)) : empty('暂无符合条件的活动', '试试调整筛选条件，发现更多精彩。'));
  };
  submitForm(form, load);
  state.refresh = load;
  content.replaceChildren(hero, heading('探索活动', '选择一场活动，让日程多一份期待。'), panel(form), results);
  await load();
}
async function eventDetail(id) {
  await run(async () => {
    const event = await api(`/api/events/${encodeURIComponent(id)}`);
    const body = el('div', { class: 'stack' },
    el('div', { class: 'row' }, tag(label(event.kind)), tag(label(event.status), 'green')),
    el('p', { class: 'muted' }, event.theme || '暂无活动介绍'), event.speaker && el('p', {}, `主讲 / 嘉宾：${event.speaker}`));
    body.append(el('p', { class: 'muted' }, '活动 ID：' + event.id));
    if (event.rules) body.append(el('p', {}, '报名与退款规则：' + event.rules));
    for (const session of event.sessions || []) {
      const box = el('div', { class: 'session-editor' },
    el('strong', {}, `${time(session.startsAt)} — ${time(session.endsAt)}`),
    el('p', { class: 'muted' }, `场次 ID：${session.id} · 地点：${session.location} · 开售：${time(session.saleAt)} · 截止：${time(session.deadline)}`));
      for (const tier of session.tiers || []) {
        const actions = el('div', { class: 'actions' },
    button('立即报名', () => orderTier(tier.id, false), 'small'),
    button('加入候补', () => orderTier(tier.id, true), 'secondary small'));
        box.append(el('div', { class: 'list-row' },
    el('div', {},
    el('strong', {}, `${tier.name} · ${money(tier.priceCents)}`),
    el('p', { class: 'muted' }, `剩余 ${tier.remaining} / ${tier.capacity}`)), actions));
      }
      body.append(box);
    }
    modal(event.title, body);
  });
}
function orderTier(tierId, waitlist) {
  if (!loginRequired()) return;
  run(async () => { await api('/api/orders', { method: 'POST', body: { tierId, waitlist } }); dialog.close(); setPage('orders'); }, waitlist ? '已提交候补申请' : '订单已创建，请及时支付');
}
async function ordersPage() {
  if (!loginRequired()) { content.replaceChildren(empty('登录后查看订单', '登录账户后可查看报名和候补记录。')); return; }
  const filters = el('form', { class: 'filters' }, field('订单 ID', 'orderId', 'search'), field('用户 ID', 'userId', 'search'), el('button', { class: 'button' }, '查询'));
  const results = el('div');
  const load = async () => {
  const values = formData(filters);
  const params = new URLSearchParams();
  if (state.user.role === 'admin' && values.orderId.trim()) params.set('id', values.orderId.trim());
  if (state.user.role === 'admin' && values.userId.trim()) params.set('userId', values.userId.trim());
  state.orders = await api('/api/orders?' + params.toString());
  const visibleOrders = state.orders.filter(order => (!values.orderId || String(order.id).includes(values.orderId.trim())) && (!values.userId || String(order.userId).includes(values.userId.trim())));
  const list = el('div', { class: 'panel' });
  for (const order of visibleOrders) {
    const info = el('div', {},
    el('div', { class: 'row' },
    el('strong', {}, order.eventTitle), tag(orderLabel(order.state), 'green')),
    el('p', { class: 'muted' }, `${time(order.startsAt)} · ${order.tierName} · ${money(order.priceCents)}`));
    if (state.user.role === 'admin') info.append(el('p', { class: 'muted' }, `订单 ID：${order.id} · 用户 ID：${order.userId}`));
    if (order.seat) info.append(el('p', { class: 'muted' }, `座位：${order.seat}`));
    if (order.code) info.append(el('p', {}, `入场码：${order.code}`));
    if (order.paymentDeadline) info.append(el('p', { class: 'muted' }, `支付截止：${time(order.paymentDeadline)}`));
    if (order.refundCents != null) info.append(el('p', { class: 'muted' }, `退款金额：${money(order.refundCents)}`));
    const actions = el('div', { class: 'actions' });
    if (order.state === 'pending' && state.user.role !== 'admin') {
      actions.append(button('模拟支付', () => orderAction(order.id, 'pay', { success: true }), 'small'));
      actions.append(button('模拟支付失败', () => orderAction(order.id, 'pay', { success: false }), 'secondary small'));
    }
    if (order.state === 'issued' && state.user.role !== 'admin') actions.append(button('申请退款', () => orderAction(order.id, 'refund', {}), 'secondary small'));
    if (order.state === 'waiting' && state.user.role !== 'admin') actions.append(button('退出候补', () => orderAction(order.id, 'leave', {}), 'secondary small'));
    list.append(el('div', { class: 'list-row' }, info, actions));
  }
  results.replaceChildren(visibleOrders.length ? list : empty('没有匹配的订单', '订单记录会显示在这里。'));
  };
  submitForm(filters, load);
  state.refresh = load;
  content.replaceChildren(heading(state.user.role === 'admin' ? '订单管理' : '我的订单', '管理报名、支付与候补。'), state.user.role === 'admin' ? panel(filters) : null, results);
  await load();
}
function orderAction(id, action, body) {
  run(async () => { await api(`/api/orders/${encodeURIComponent(id)}/${action}`, { method: 'POST', body }); await render(); }, action === 'pay' && !body.success ? '已模拟支付失败' : '操作已提交');
}
async function messagesPage() {
  if (!loginRequired()) { content.replaceChildren(empty('登录后查看消息', '活动和订单通知会显示在这里。')); return; }
  const messages = await api('/api/messages');
  const list = el('div', { class: 'panel' });
  messages.forEach(message => list.append(el('div', { class: 'list-row' },
    el('div', {},
    el('strong', {}, message.body),
    el('p', { class: 'muted' }, time(message.createdAt))))));
  content.replaceChildren(heading('站内消息', '及时了解活动与订单动态。'), messages.length ? list : empty('暂无消息', '新的通知会出现在这里。'));
}
function tierEditor(tier = {}) {
  const box = el('div', { class: 'tier-editor' },
    el('strong', {}, '票档'),
    el('div', { class: 'form-grid' },
    field('票档名称', 'tierName', 'text', { required: true, value: tier.name || '' }),
    field('价格（元）', 'tierPrice', 'number', { required: true, min: '0', step: '0.01', value: tier.priceCents != null ? tier.priceCents / 100 : '' }),
    field('数量', 'tierCapacity', 'number', { required: true, min: '1', step: '1', value: tier.capacity || '' })),
    button('移除票档', () => box.remove(), 'secondary small'));
  return box;
}
function sessionEditor(session = {}) {
  const tiers = el('div', { class: 'stack tiers' });
  (session.tiers?.length ? session.tiers : [{}]).forEach(tier => tiers.append(tierEditor(tier)));
  const box = el('div', { class: 'session-editor' },
    el('strong', {}, '场次信息'),
    el('div', { class: 'form-grid' },
    field('开始时间', 'startsAt', 'datetime-local', { required: true, value: localTime(session.startsAt) }),
    field('结束时间', 'endsAt', 'datetime-local', { required: true, value: localTime(session.endsAt) }),
    field('地点', 'location', 'text', { required: true, value: session.location || '' }),
    field('开售时间', 'saleAt', 'datetime-local', { required: true, value: localTime(session.saleAt) }),
    field('报名截止', 'deadline', 'datetime-local', { required: true, value: localTime(session.deadline) })), tiers,
    el('div', { class: 'actions' },
    button('添加票档', () => tiers.append(tierEditor()), 'secondary small'),
    button('移除此场次', () => box.remove(), 'danger small')));
  return box;
}
function editorValue(box, name) { return box.querySelector(`[name="${name}"]`).value; }
function eventEditor(event = {}) {
  const sessions = el('div', { class: 'stack' });
  (event.sessions?.length ? event.sessions : [{}]).forEach(session => sessions.append(sessionEditor(session)));
  const form = el('form', { class: 'stack' },
    el('div', { class: 'form-grid' },
    field('活动名称', 'title', 'text', { required: true, value: event.title || '' }), selectField('活动类型', 'kind', [['performance', '演出'], ['lecture', '讲座']], event.kind || 'performance'),
    field('主讲 / 嘉宾', 'speaker', 'text', { value: event.speaker || '' }),
    field('主题', 'theme', 'text', { value: event.theme || '' }),
    field('计划发布时间', 'publishAt', 'datetime-local', { required: true, value: localTime(event.publishAt) })), sessions,
    button('添加场次', () => sessions.append(sessionEditor()), 'secondary'),
    el('button', { class: 'button', type: 'submit' }, '提交审核'));
  submitForm(form, async f => {
    const values = formData(f);
    const list = [...sessions.children].map(box => ({ startsAt: iso(editorValue(box, 'startsAt')), endsAt: iso(editorValue(box, 'endsAt')), location: editorValue(box, 'location'), saleAt: iso(editorValue(box, 'saleAt')), deadline: iso(editorValue(box, 'deadline')), tiers: [...box.querySelectorAll('.tier-editor')].map(tier => ({ name: editorValue(tier, 'tierName'), priceCents: Math.round(Number(editorValue(tier, 'tierPrice')) * 100), capacity: Number(editorValue(tier, 'tierCapacity')) })) }));
    if (!list.length || list.some(session => !session.tiers.length)) throw new Error('请至少添加一个场次，并为每个场次添加票档');
    await api(event.id ? `/api/events/${encodeURIComponent(event.id)}/resubmit` : '/api/events', { method: 'POST', body: { title: values.title, kind: values.kind, speaker: values.speaker, theme: values.theme, publishAt: iso(values.publishAt), sessions: list } });
    dialog.close(); await render(); showNotice('活动申请已提交');
  });
  modal(event.id ? '修改并重新提交' : '创建活动申请', form);
}
function changeDialog(event) {
  const boxes = (event.sessions || []).map(session => el('div', { class: 'session-editor', 'data-id': session.id },
    el('div', { class: 'form-grid' },
    field('开始时间', 'startsAt', 'datetime-local', { required: true, value: localTime(session.startsAt) }),
    field('结束时间', 'endsAt', 'datetime-local', { required: true, value: localTime(session.endsAt) }),
    field('地点', 'location', 'text', { required: true, value: session.location }))));
  const form = el('form', { class: 'stack' }, selectField('申请类型', 'kind', [['reschedule', '变更时间或地点'], ['cancel', '取消活动']], 'reschedule'),
    field('申请原因', 'reason', 'textarea', { required: true }), ...boxes,
    el('button', { class: 'button' }, '提交变更申请'));
  submitForm(form, async f => { const values = formData(f); await api(`/api/events/${encodeURIComponent(event.id)}/changes`, { method: 'POST', body: { kind: values.kind, reason: values.reason, sessions: boxes.map(box => ({ id: box.dataset.id, startsAt: iso(editorValue(box, 'startsAt')), endsAt: iso(editorValue(box, 'endsAt')), location: editorValue(box, 'location') })) } }); dialog.close(); await render(); showNotice('变更申请已提交'); });
  modal('申请活动变更', form);
}
async function statistics(session, eventId) {
  await run(async () => {
    const data = await api(`/api/sessions/${encodeURIComponent(session.id)}/statistics`);
    const attendance = data.attendanceRate == null ? '不适用' : `${(Number(data.attendanceRate) * 100).toFixed(1)}%`;
    const fields = [['已发放', data.issued], ['已购买', data.purchased], ['已到场', data.attended], ['候补中', data.waiting], ['已退款', data.refunded], ['到场率', attendance]];
    const link = el('a', { class: 'button secondary', href: `/api/events/${encodeURIComponent(eventId)}/export?sessionId=${encodeURIComponent(session.id)}`, download: '' }, '下载 CSV');
    modal('场次统计',
    el('div', { class: 'stack' },
    el('p', { class: 'muted' }, `${time(session.startsAt)} · ${session.location}`),
    el('div', { class: 'metrics' }, fields.map(([name, value]) => el('div', { class: 'metric' }, name,
    el('strong', {}, value)))), link));
  });
}
async function organizerPage() {
  const events = await api('/api/events');
  const own = events.filter(event => String(event.organizerId) === String(state.user.id));
  const reviews = await api('/api/reviews');
  const list = el('div', { class: 'stack' });
  for (const event of own) {
    const actions = el('div', { class: 'actions' },
    button('查看详情', () => eventDetail(event.id), 'secondary small'),
    button('申请变更', () => changeDialog(event), 'secondary small'));
    if (['rejected', 'draft'].includes(event.status)) actions.append(button('修改并重新提交', () => eventEditor(event), 'small'));
    const body = el('div', { class: 'stack' },
    el('div', { class: 'row' },
    el('h3', {}, event.title), tag(label(event.status), event.status === 'rejected' ? 'red' : 'green')),
    el('p', { class: 'muted' }, `计划发布：${time(event.publishAt)}${event.rejection ? ` · 驳回原因：${event.rejection}` : ''}`), actions);
    for (const session of event.sessions || []) body.append(el('div', { class: 'list-row' },
    el('div', {},
    el('strong', {}, time(session.startsAt)),
    el('p', { class: 'muted' }, session.location)),
    button('查看统计 / 导出', () => statistics(session, event.id), 'secondary small')));
    list.append(panel(body));
  }
  content.replaceChildren(el('div', { class: 'section-head' },
    el('div', {},
    el('h2', {}, '活动管理'),
    el('p', {}, '创建活动、跟踪审核并查看场次数据。')),
    button('＋ 创建活动', () => eventEditor())), own.length ? list : empty('还没有活动', '创建活动并提交审核后，在这里跟踪进度。'), heading('审核进度', '查看发布与变更申请的审核历史。'), reviews.length ? panel(...reviews.map(review => el('div', { class: 'list-row' }, el('div', {}, el('strong', {}, review.eventTitle), el('p', { class: 'muted' }, label(review.kind) + ' · ' + label(review.status) + (review.reason ? ' · ' + review.reason : '')))))) : empty('暂无审核记录', ''));
}
async function reviewsPage() {
  const reviews = await api('/api/reviews');
  const list = el('div', { class: 'panel' });
  reviews.forEach(review => {
    const actions = el('div', { class: 'actions' });
    if (review.status === 'pending') actions.append(button('通过', () => reviewAction(review, true), 'small'), button('驳回', () => reviewAction(review, false), 'danger small'));
    list.append(el('div', { class: 'list-row' },
    el('div', {},
    el('div', { class: 'row' },
    el('strong', {}, review.eventTitle), tag(label(review.kind)), tag(label(review.status))),
    el('p', { class: 'muted' }, review.reason || '暂无申请说明'), review.payload && el('p', { class: 'muted' }, typeof review.payload === 'string' ? review.payload : JSON.stringify(review.payload))), actions));
  });
  content.replaceChildren(heading('审核管理', '审核活动发布、变更及取消申请。'), reviews.length ? list : empty('暂无待审核申请', '新的申请会出现在这里。'));
}
function reviewAction(review, approved) {
  const form = el('form', { class: 'stack' },
    field(approved ? '审核意见（可选）' : '驳回原因', 'reason', 'textarea', { required: !approved }),
    el('button', { class: 'button' }, approved ? '确认通过' : '确认驳回'));
  submitForm(form, async f => { await api(`/api/reviews/${encodeURIComponent(review.id)}`, { method: 'POST', body: { approved, reason: formData(f).reason } }); dialog.close(); await render(); showNotice('审核结果已提交'); });
  modal(`${approved ? '通过' : '驳回'} · ${review.eventTitle}`, form);
}
async function usersPage() {
  const users = await api('/api/users');
  const list = el('div', { class: 'panel' });
  users.forEach(user => list.append(el('div', { class: 'list-row' },
    el('div', {},
    el('div', { class: 'row' },
    el('strong', {}, user.name || user.phone), tag(roles[user.role] || user.role), user.banned && tag('已封禁', 'red')),
    el('p', { class: 'muted' }, user.phone)),
    button(user.banned ? '解除封禁' : '封禁账户', () => banDialog(user), 'secondary small'))));
  content.replaceChildren(heading('用户管理', '查看账户状态并管理访问权限。'), users.length ? list : empty('暂无用户', ''));
}
function banDialog(user) {
  const form = el('form', { class: 'stack' },
    field('操作原因', 'reason', 'textarea', { required: true }),
    el('button', { class: 'button' }, '确认提交'));
  submitForm(form, async f => { await api(`/api/users/${encodeURIComponent(user.id)}/ban`, { method: 'POST', body: { banned: !user.banned, reason: formData(f).reason } }); dialog.close(); await render(); showNotice('账户状态已更新'); });
  modal(`${user.banned ? '解除封禁' : '封禁账户'} · ${user.phone}`, form);
}
async function auditPage() {
  const form = el('form', { class: 'filters' },
    field('对象类型', 'objectType', 'text', { placeholder: '例如 event' }),
    field('对象 ID', 'objectId', 'text', { placeholder: '输入 ID' }),
    el('button', { class: 'button' }, '查询'));
  const results = el('div');
  const load = async () => {
    const params = new URLSearchParams(Object.entries(formData(form)).filter(([, value]) => value));
    const logs = await api(`/api/audit?${params}`);
    const list = el('div', { class: 'panel' });
    logs.forEach(log => list.append(el('div', { class: 'list-row' },
    el('div', {},
    el('strong', {}, log.action || '操作记录'),
    el('p', { class: 'muted' }, JSON.stringify(log))))));
    results.replaceChildren(logs.length ? list : empty('暂无审计记录', ''));
  };
  submitForm(form, load);
  content.replaceChildren(heading('审计记录', '按对象查询系统操作记录。'), panel(form), results);
  await load();
}
async function checkinPage() {
  if (state.user.role === 'checker') {
    const form = el('form', { class: 'stack' },
      field('入场码', 'code', 'text', { required: true, placeholder: '输入观众入场码' }),
      field('身份证号', 'idNumber', 'text', { required: true, placeholder: '输入观众身份证号' }),
      el('button', { class: 'button' }, '确认检票'));
    submitForm(form, async f => {
      await api('/api/checkin', { method: 'POST', body: formData(f) });
      f.reset();
      showNotice('检票成功');
    });
    content.replaceChildren(heading('现场检票', '核验入场码与实名信息。'), panel(form));
    return;
  }
  const events = await api('/api/events');
  const choices = events.flatMap(event => (event.sessions || []).map(session =>
    [String(session.id), `${event.title} · ${time(session.startsAt)} · ${session.location} · ${session.id}`]));
  const windowForm = el('form', { class: 'stack' },
    selectField('选择场次', 'sessionId', choices, choices[0]?.[0]),
    el('button', { class: 'button', type: 'submit', disabled: !choices.length }, '开启检票窗口'));
  submitForm(windowForm, async f => {
    await api(`/api/sessions/${encodeURIComponent(formData(f).sessionId)}/checkin-window`, { method: 'POST', body: {} });
    showNotice('检票窗口已开启');
  });
  content.replaceChildren(heading('检票窗口', '为指定场次开启检票。'),
    choices.length ? panel(windowForm) : empty('暂无可选场次', '活动场次会显示在这里。'),
    button('刷新活动状态', () => run(async () => { await api('/api/maintenance', { method: 'POST', body: {} }); }, '活动状态已刷新'), 'secondary'));
}
async function render() {
  state.refresh = null;
  nav();
  try {
    const pages = { events: eventsPage, orders: ordersPage, messages: messagesPage, organizer: organizerPage, reviews: reviewsPage, users: usersPage, audit: auditPage, checkin: checkinPage };
    await (pages[state.page] || eventsPage)();
  } catch (error) { content.replaceChildren(empty('加载失败', error.message)); }
}
document.querySelector('#account-button').addEventListener('click', accountDialog);
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
setInterval(() => { if (!dialog.open && !document.hidden && state.refresh) state.refresh().catch(() => {}); }, 15000);
(async () => {
  try { state.user = await api('/api/me'); if (state.user?.role === 'checker') state.page = 'checkin'; }
  catch (error) { showNotice(error.message, true); }
  await render();
})();

'use strict';

const state = { user: null, page: 'events', events: [], orders: [], refresh: null };
const content = document.querySelector('#content');
const navigation = document.querySelector('#navigation');
const dialog = document.querySelector('#dialog');
const dialogContent = document.querySelector('#dialog-content');
const notice = document.querySelector('#notice');
const roles = { participant: '参与者', organizer: '组织者', admin: '管理员', checker: '检票员' };
const labels = {
  scheduled: '待发布',
  ended: '已结束',
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  published: '已发布',
  cancelled: '已取消',
  canceled: '已取消',
  draft: '草稿',
  unpaid: '待支付',
  pending_payment: '待支付',
  paid: '已支付',
  refunded: '已退款',
  waiting: '候补中',
  waitlisted: '候补中',
  expired: '已过期',
  checked_in: '已入场',
  publish: '发布申请',
  reschedule: '变更申请',
  cancel: '取消申请',
  performance: '演出',
  lecture: '讲座',
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = value ?? '';
    } else if (key.startsWith('on')) {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') {
      node.value = value ?? '';
    } else if (key === 'checked') {
      node.checked = value;
    } else if (value !== false && value != null) {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}
function button(text, action, variant = '') {
  return el('button', { type: 'button', class: `button ${variant}`, onclick: action }, text);
}
function field(label, name, type = 'text', options = {}) {
  const input = el(type === 'textarea' ? 'textarea' : 'input', {
    name,
    type: type === 'textarea' ? null : type,
    ...options,
  });
  return el('label', {}, label, input);
}
function selectField(label, name, choices, selected) {
  const select = el('select', { name });
  choices.forEach(([value, text]) =>
    select.append(el('option', { value, selected: value === selected }, text)),
  );
  return el('label', {}, label, select);
}
function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}
function money(cents) {
  return `¥${(Number(cents || 0) / 100).toFixed(2)}`;
}
function time(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '待定';
}
function iso(value) {
  if (!value) {
    throw new Error('请填写完整的日期和时间');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('日期或时间格式有误，请检查后重试');
  }
  return date.toISOString();
}
function orderLabel(value) {
  const names = {
    pending: '待支付',
    issued: '已出票',
    checked_in: '已签到',
    redeemed: '已核销',
    absent: '已缺席',
    cancelled: '已取消',
    closed: '已关闭',
    refunded: '已退款',
    waiting: '候补中',
  };
  return names[value] || value || '未知';
}
function localTime(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function label(value) {
  return labels[value] || value || '未知';
}
function tag(text, style = '') {
  return el('span', { class: `tag ${style}` }, text);
}
function panel(...children) {
  return el('div', { class: 'panel' }, ...children);
}
function heading(title, description) {
  return el(
    'div',
    { class: 'section-head' },
    el('div', {}, el('h2', {}, title), description && el('p', {}, description)),
  );
}
function empty(title, description) {
  return el('div', { class: 'empty' }, el('strong', {}, title), description);
}
function showNotice(message, error = false) {
  notice.replaceChildren(el('div', { class: `notice ${error ? 'error' : ''}` }, message));
  setTimeout(() => notice.replaceChildren(), 7000);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('服务器响应无法读取');
  }
  if (!response.ok || result.error) {
    throw new Error(result.error?.message || '请求失败，请稍后重试');
  }
  return result.data;
}
async function run(action, success) {
  try {
    await action();
    if (success) {
      showNotice(success);
    }
  } catch (error) {
    showNotice(error.message, true);
  }
}
function modal(title, ...children) {
  const close = el(
    'button',
    { class: 'close', type: 'button', 'aria-label': '关闭', onclick: () => dialog.close() },
    '×',
  );
  dialogContent.replaceChildren(
    el(
      'div',
      { class: 'dialog-inner' },
      el('div', { class: 'dialog-head' }, el('h2', {}, title), close),
      ...children,
    ),
  );
  if (!dialog.open) {
    dialog.showModal();
  }
}
function submitForm(form, action) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run(() => action(form));
  });
  return form;
}

async function messagesPage() {
  if (!loginRequired()) {
    content.replaceChildren(empty('登录后查看消息', '活动和订单通知会显示在这里。'));
    return;
  }
  const messages = await api('/api/messages');
  const list = el('div', { class: 'panel' });
  messages.forEach((message) =>
    list.append(
      el(
        'div',
        { class: 'list-row' },
        el(
          'div',
          {},
          el('strong', {}, message.body),
          el('p', { class: 'muted' }, time(message.createdAt)),
        ),
      ),
    ),
  );
  content.replaceChildren(
    heading('站内消息', '及时了解活动与订单动态。'),
    messages.length ? list : empty('暂无消息', '新的通知会出现在这里。'),
  );
}
function tierEditor(tier = {}) {
  const box = el(
    'div',
    { class: 'tier-editor' },
    el('strong', {}, '票档'),
    el(
      'div',
      { class: 'form-grid' },
      field('票档名称', 'tierName', 'text', { required: true, value: tier.name || '' }),
      field('价格（元）', 'tierPrice', 'number', {
        required: true,
        min: '0',
        step: '0.01',
        value: tier.priceCents != null ? tier.priceCents / 100 : '',
      }),
      field('数量', 'tierCapacity', 'number', {
        required: true,
        min: '1',
        step: '1',
        value: tier.capacity || '',
      }),
    ),
    button('移除票档', () => box.remove(), 'secondary small'),
  );
  return box;
}
function sessionEditor(session = {}) {
  const tiers = el('div', { class: 'stack tiers' });
  (session.tiers?.length ? session.tiers : [{}]).forEach((tier) => tiers.append(tierEditor(tier)));
  const box = el(
    'div',
    { class: 'session-editor' },
    el('strong', {}, '场次信息'),
    el(
      'div',
      { class: 'form-grid' },
      field('开始时间', 'startsAt', 'datetime-local', {
        required: true,
        value: localTime(session.startsAt),
      }),
      field('结束时间', 'endsAt', 'datetime-local', {
        required: true,
        value: localTime(session.endsAt),
      }),
      field('地点', 'location', 'text', { required: true, value: session.location || '' }),
      field('开售时间', 'saleAt', 'datetime-local', {
        required: true,
        value: localTime(session.saleAt),
      }),
      field('报名截止', 'deadline', 'datetime-local', {
        required: true,
        value: localTime(session.deadline),
      }),
    ),
    tiers,
    el(
      'div',
      { class: 'actions' },
      button('添加票档', () => tiers.append(tierEditor()), 'secondary small'),
      button('移除此场次', () => box.remove(), 'danger small'),
    ),
  );
  return box;
}
function editorValue(box, name) {
  return box.querySelector(`[name="${name}"]`).value;
}

function changeDialog(event) {
  const boxes = (event.sessions || []).map((session) =>
    el(
      'div',
      { class: 'session-editor', 'data-id': session.id },
      el(
        'div',
        { class: 'form-grid' },
        field('开始时间', 'startsAt', 'datetime-local', {
          required: true,
          value: localTime(session.startsAt),
        }),
        field('结束时间', 'endsAt', 'datetime-local', {
          required: true,
          value: localTime(session.endsAt),
        }),
        field('地点', 'location', 'text', { required: true, value: session.location }),
      ),
    ),
  );
  const form = el(
    'form',
    { class: 'stack' },
    selectField(
      '申请类型',
      'kind',
      [
        ['reschedule', '变更时间或地点'],
        ['cancel', '取消活动'],
      ],
      'reschedule',
    ),
    field('申请原因', 'reason', 'textarea', { required: true }),
    ...boxes,
    el('button', { class: 'button' }, '提交变更申请'),
  );
  submitForm(form, async (f) => {
    const values = formData(f);
    await api(`/api/events/${encodeURIComponent(event.id)}/changes`, {
      method: 'POST',
      body: {
        kind: values.kind,
        reason: values.reason,
        sessions: boxes.map((box) => ({
          id: box.dataset.id,
          startsAt: iso(editorValue(box, 'startsAt')),
          endsAt: iso(editorValue(box, 'endsAt')),
          location: editorValue(box, 'location'),
        })),
      },
    });
    dialog.close();
    await render();
    showNotice('变更申请已提交');
  });
  modal('申请活动变更', form);
}

async function usersPage() {
  const users = await api('/api/users');
  const list = el('div', { class: 'panel' });
  users.forEach((user) =>
    list.append(
      el(
        'div',
        { class: 'list-row' },
        el(
          'div',
          {},
          el(
            'div',
            { class: 'row' },
            el('strong', {}, user.name || user.phone),
            tag(roles[user.role] || user.role),
            user.banned && tag('已封禁', 'red'),
          ),
          el('p', { class: 'muted' }, user.phone),
        ),
        button(user.banned ? '解除封禁' : '封禁账户', () => banDialog(user), 'secondary small'),
      ),
    ),
  );
  content.replaceChildren(
    heading('用户管理', '查看账户状态并管理访问权限。'),
    users.length ? list : empty('暂无用户', ''),
  );
}
function banDialog(user) {
  const form = el(
    'form',
    { class: 'stack' },
    field('操作原因', 'reason', 'textarea', { required: true }),
    el('button', { class: 'button' }, '确认提交'),
  );
  submitForm(form, async (f) => {
    await api(`/api/users/${encodeURIComponent(user.id)}/ban`, {
      method: 'POST',
      body: { banned: !user.banned, reason: formData(f).reason },
    });
    dialog.close();
    await render();
    showNotice('账户状态已更新');
  });
  modal(`${user.banned ? '解除封禁' : '封禁账户'} · ${user.phone}`, form);
}
async function auditPage() {
  const form = el(
    'form',
    { class: 'filters' },
    field('对象类型', 'objectType', 'text', { placeholder: '例如 event' }),
    field('对象 ID', 'objectId', 'text', { placeholder: '输入 ID' }),
    el('button', { class: 'button' }, '查询'),
  );
  const results = el('div');
  const load = async () => {
    const params = new URLSearchParams(Object.entries(formData(form)).filter(([, value]) => value));
    const logs = await api(`/api/audit?${params}`);
    const list = el('div', { class: 'panel' });
    logs.forEach((log) =>
      list.append(
        el(
          'div',
          { class: 'list-row' },
          el(
            'div',
            {},
            el('strong', {}, log.action || '操作记录'),
            el('p', { class: 'muted' }, JSON.stringify(log)),
          ),
        ),
      ),
    );
    results.replaceChildren(logs.length ? list : empty('暂无审计记录', ''));
  };
  submitForm(form, load);
  content.replaceChildren(heading('审计记录', '按对象查询系统操作记录。'), panel(form), results);
  await load();
}

state.page = 'auth';
state.detailId = null;
state.paymentOrder = null;
state.authMode = 'login';
state.checkins = [];
state.statisticsSession = null;

function nav() {
  let items = [];
  if (state.user?.role === 'participant') {
    items = [
      ['events', '演出'],
      ['orders', '我的订单'],
      ['messages', '站内消息'],
    ];
  }
  if (state.user?.role === 'organizer') {
    items = [
      ['organizer', '演出管理'],
      ['statistics', '数据统计'],
      ['messages', '站内消息'],
      ['events', '演出'],
    ];
  }
  if (state.user?.role === 'admin') {
    items = [
      ['reviews', '演出审核'],
      ['checkin', '签到窗口'],
      ['events', '演出'],
      ['orders', '订单查询'],
      ['audit', '审计记录'],
      ['messages', '站内消息'],
    ];
  }
  if (state.user?.role === 'checker') {
    items = [['checkin', '核销']];
  }
  navigation.replaceChildren(
    ...items.map(([id, title]) =>
      el(
        'button',
        {
          class: `nav-item ${state.page === id ? 'active' : ''}`,
          'data-page': id,
          onclick: () => setPage(id),
        },
        title,
      ),
    ),
  );
  document.querySelector('#user-badge').textContent = state.user
    ? (state.user.name || roles[state.user.role] || '用户').slice(0, 1)
    : '客';
  document.querySelector('#account-button').textContent = state.user ? '账号设置' : '登录 / 注册';
}
function setPage(page) {
  state.refresh = null;
  state.page = page;
  render();
  window.scrollTo(0, 0);
}
function signedInPage() {
  if (!state.user) {
    return 'auth';
  }
  if (!state.user.verified && ['participant', 'organizer'].includes(state.user.role)) {
    return 'verify';
  }
  return (
    { participant: 'events', organizer: 'organizer', admin: 'reviews', checker: 'checkin' }[
      state.user.role
    ] || 'events'
  );
}
function recoveryModal(title, code, next) {
  modal(
    title,
    el(
      'div',
      { class: 'stack' },
      el('p', {}, '请妥善保存恢复码，忘记密码时需要使用。'),
      el('strong', {}, code),
      button('我已保存', () => {
        dialog.close();
        next();
      }),
    ),
  );
}
function authPage() {
  const mode = state.authMode;
  const tabs = el(
    'div',
    { class: 'tabs' },
    button(
      '登录',
      () => {
        state.authMode = 'login';
        render();
      },
      mode === 'login' ? '' : 'secondary',
    ),
    button(
      '注册',
      () => {
        state.authMode = 'register';
        render();
      },
      mode === 'register' ? '' : 'secondary',
    ),
  );
  const form = el(
    'form',
    { class: 'stack' },
    field('手机号（登录账号）', 'phone', 'tel', {
      required: true,
      placeholder: '请输入 11 位手机号',
    }),
  );
  if (mode === 'reset') {
    form.append(field('恢复码', 'recoveryCode', 'text', { required: true }));
  }
  form.append(
    field(mode === 'reset' ? '新密码' : '密码', 'password', 'password', {
      required: true,
      placeholder: '请输入密码',
    }),
  );
  if (mode === 'register') {
    form.append(
      selectField(
        '注册身份',
        'role',
        [
          ['participant', '参与者'],
          ['organizer', '组织者'],
        ],
        'participant',
      ),
    );
  }
  form.append(
    el(
      'button',
      { class: 'button full', type: 'submit' },
      mode === 'register' ? '注册' : mode === 'reset' ? '重置密码' : '登录',
    ),
  );
  form.append(
    button(
      mode === 'reset' ? '返回登录' : '忘记密码？自助重置',
      () => {
        state.authMode = mode === 'reset' ? 'login' : 'reset';
        render();
      },
      'secondary',
    ),
  );
  submitForm(form, async (f) => {
    const values = formData(f);
    const result = await api(
      mode === 'login'
        ? '/api/login'
        : mode === 'register'
          ? '/api/register'
          : '/api/reset-password',
      { method: 'POST', body: values },
    );
    if (mode === 'reset') {
      state.user = null;
      return recoveryModal('密码重置成功', result.recoveryCode, () => {
        state.authMode = 'login';
        render();
      });
    }
    if (mode === 'register') {
      try {
        const logged = await api('/api/login', {
          method: 'POST',
          body: { phone: values.phone, password: values.password },
        });
        state.user = logged.user || logged;
      } catch (error) {
        state.user = null;
        showNotice('注册成功，请保存恢复码后手动登录：' + error.message, true);
      }
      return recoveryModal('注册成功', result.recoveryCode, () => setPage(signedInPage()));
    }
    state.user = result.user || result;
    notice.replaceChildren();
    setPage(signedInPage());
  });
  const roleCards = [
    ['参与者', '查询购票退票候补，凭票码入场'],
    ['组织者', '提交演出申请，查看审核进度与统计'],
    ['检票人员', '签到窗口开启后核销票码'],
    ['平台管理员', '审核演出、开启窗口、封禁账号'],
  ];
  content.replaceChildren(
    heading('欢迎来到校园票务', '参与者购票 · 组织者发布 · 检票员核销 · 管理员治理'),
    el(
      'div',
      { class: 'panel auth-card' },
      tabs,
      form,
      el(
        'div',
        { class: 'actions' },
        button('游客浏览演出', () => setPage('events'), 'secondary'),
      ),
    ),
    el(
      'div',
      { class: 'role-grid' },
      roleCards.map(([name, description]) =>
        panel(el('h3', {}, name), el('p', { class: 'muted' }, description)),
      ),
    ),
  );
}
function verifyPage() {
  const form = el(
    'form',
    { class: 'stack' },
    field('真实姓名', 'name', 'text', { required: true, placeholder: '与身份证一致' }),
    field('身份证号', 'idNumber', 'text', {
      required: true,
      placeholder: '18 位 · 同一身份证仅允许绑定一个账号',
    }),
    el('button', { class: 'button full' }, '提交实名信息'),
  );
  submitForm(form, async (f) => {
    await api('/api/verify', { method: 'POST', body: formData(f) });
    state.user = await api('/api/me');
    setPage(signedInPage());
    showNotice('实名认证成功');
  });
  content.replaceChildren(
    heading('完成实名认证后即可购票', '购票前须完成实名认证；认证信息仅用于购票与入场核验。'),
    el(
      'div',
      { class: 'panel auth-card' },
      el('h2', {}, '实名认证'),
      el('div', { class: 'divider' }),
      form,
    ),
  );
}
function loginRequired() {
  if (state.user) {
    return true;
  }
  setPage('auth');
  showNotice('请先登录');
  return false;
}
function accountDialog() {
  if (!state.user) {
    return setPage('auth');
  }
  modal(
    '账号设置',
    el(
      'div',
      { class: 'stack' },
      el('p', {}, `${state.user.phone} · ${roles[state.user.role] || state.user.role}`),
      el(
        'p',
        {},
        `实名认证：${state.user.verified ? `已认证（${state.user.name}）` : '未认证，不能购票或加入候补'}`,
      ),
      !state.user.verified &&
        ['participant', 'organizer'].includes(state.user.role) &&
        button(
          '实名认证',
          () => {
            dialog.close();
            setPage('verify');
          },
          'secondary',
        ),
      button(
        '退出登录',
        () =>
          run(async () => {
            await api('/api/logout', { method: 'POST', body: {} });
            state.user = null;
            state.checkins = [];
            dialog.close();
            setPage('auth');
          }, '已退出登录'),
        'danger',
      ),
    ),
  );
}
function eventCard(event) {
  const first = event.sessions?.[0];
  const tiers = (event.sessions || []).flatMap((s) => s.tiers || []);
  const available = tiers.some((t) => t.remaining > 0);
  return el(
    'article',
    { class: 'card' },
    el('div', { class: 'card-cover' }, event.kind === 'lecture' ? '🎓 讲座' : '🎭 付费演出'),
    el(
      'div',
      { class: 'card-body' },
      el('h3', {}, event.title),
      el('div', { class: 'row' }, tag(label(event.kind)), event.theme && tag(event.theme)),
      el(
        'p',
        { class: 'muted' },
        `${event.speaker || '嘉宾待定'} · ${time(first?.startsAt)} · ${first?.location || '地点待定'}`,
      ),
      el(
        'div',
        { class: 'list-row' },
        el(
          'strong',
          {},
          tiers.length ? `${money(Math.min(...tiers.map((t) => t.priceCents)))} 起` : '票价待定',
        ),
        button(available ? '查看购票' : '查看候补', () => eventDetail(event.id), 'secondary small'),
      ),
    ),
  );
}
async function eventsPage() {
  const form = el(
    'form',
    { class: 'filters' },
    field('搜索', 'keyword', 'search', { placeholder: '搜索演出、主讲人或主题' }),
    field('开始日期', 'from', 'date'),
    field('结束日期', 'to', 'date'),
    field('地点', 'location', 'text'),
    field('主讲 / 明星', 'speaker', 'text'),
    field('主题', 'theme', 'text'),
    selectField('余票', 'available', [
      ['', '全部'],
      ['true', '仅看有余票'],
    ]),
    el('button', { class: 'button' }, '搜索'),
  );
  if (state.user?.role === 'admin') {
    form.insertBefore(field('活动 ID', 'id', 'text'), form.lastChild);
  }
  const results = el('div');
  const load = async () => {
    const values = formData(form);
    if (values.from && values.to && values.from > values.to) {
      throw new Error('开始日期不能晚于结束日期');
    }
    if (values.from) {
      values.from = iso(`${values.from}T00:00:00`);
    }
    if (values.to) {
      values.to = iso(`${values.to}T23:59:59.999`);
    }
    const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value));
    const events = await api('/api/events?' + params);
    results.replaceChildren(
      events.length
        ? el('div', { class: 'grid' }, events.map(eventCard))
        : empty('暂无符合条件的活动', '试试调整筛选条件。'),
    );
  };
  submitForm(form, load);
  state.refresh = load;
  content.replaceChildren(panel(form), results);
  await load();
}
async function eventDetail(id) {
  state.detailId = id;
  setPage('detail');
}
async function detailPage() {
  const event = await api('/api/events/' + encodeURIComponent(state.detailId));
  const sessions = event.sessions || [];
  let selectedSession = sessions[0];
  let chosen = selectedSession?.tiers?.[0];
  const choices = el('div', { class: 'stack' });
  const total = el('strong');
  const information = el('div', { class: 'stack' });
  const submit = button(
    '提交订单',
    () =>
      run(async () => {
        if (!loginRequired()) {
          return;
        }
        if (state.user.role !== 'participant') {
          return;
        }
        state.user = await api('/api/me');
        if (!loginRequired()) {
          return;
        }
        if (!state.user.verified) {
          setPage('verify');
          showNotice('请先完成实名认证，再购票或加入候补');
          return;
        }
        if (!chosen) {
          throw new Error('请选择票档');
        }
        const order = await api('/api/orders', {
          method: 'POST',
          body: { tierId: chosen.id, waitlist: chosen.remaining <= 0 },
        });
        state.paymentOrder = order;
        setPage('payment');
      }),
    'full',
  );
  function update() {
    total.textContent = chosen ? `合计 ${money(chosen.priceCents)}` : '请选择票档';
    submit.disabled = Boolean(state.user && state.user.role !== 'participant');
    if (!state.user) {
      submit.textContent = '登录后购票';
    } else if (state.user.role !== 'participant') {
      submit.textContent = '仅参与者可购票';
    } else if (!state.user.verified) {
      submit.textContent = '先实名认证';
    } else {
      submit.textContent = chosen?.remaining <= 0 ? '预付全款加入候补' : '提交订单';
    }
    information.replaceChildren(
      el('p', {}, `时间：${time(selectedSession?.startsAt)}`),
      el('p', {}, `地点：${selectedSession?.location || '待定'}`),
      el('p', {}, `主讲 / 主演：${event.speaker || '待定'}`),
      el('p', {}, `票档状态：${chosen?.remaining > 0 ? '有余票' : '售罄可候补'}`),
    );
    if (state.user?.role === 'admin') {
      information.append(
        el(
          'p',
          { class: 'muted' },
          `活动 ID：${event.id} · 场次 ID：${selectedSession?.id || '—'}`,
        ),
      );
    }
  }
  sessions.forEach((session) => {
    choices.append(el('h3', {}, `${time(session.startsAt)} · ${session.location}`));
    (session.tiers || []).forEach((tier) => {
      const radio = el('input', {
        type: 'radio',
        name: 'tier',
        value: tier.id,
        checked: tier === chosen,
        onchange: () => {
          chosen = tier;
          selectedSession = session;
          update();
        },
      });
      choices.append(
        el(
          'label',
          { class: 'choice' },
          radio,
          el('span', {}, tier.name),
          el('span', {}, `余量 ${tier.remaining}　${money(tier.priceCents)}`),
        ),
      );
    });
  });
  update();
  const banner = el(
    'div',
    { class: 'banner' },
    el('span', { class: 'banner-icon' }, event.kind === 'lecture' ? '🎓' : '🎭'),
    el(
      'div',
      {},
      el('h2', {}, event.title),
      el('p', {}, `${label(event.kind)} · ${event.theme || '校园活动'}`),
    ),
  );
  const left = el(
    'div',
    {},
    banner,
    panel(information),
    panel(
      el('h3', {}, '演出简介'),
      el('p', { class: 'muted' }, event.theme || '欢迎参加本场校园活动。'),
    ),
    panel(
      el('h3', {}, '演出须知'),
      el('p', { class: 'muted' }, '一人一票，凭票码及身份证入场；票档售罄后可预付全款加入候补。'),
    ),
  );
  const right = el(
    'div',
    {},
    panel(el('h3', {}, '购票 / 退票规则公示'), el('p', { class: 'muted' }, event.rules)),
    panel(
      el(
        'div',
        { class: 'stack' },
        el('h3', {}, '选择场次与票档'),
        choices,
        el('p', { class: 'muted' }, '每账号每场次限购 1 张'),
        total,
        el(
          'p',
          { class: 'muted' },
          state.user?.verified
            ? `实名观演人：${state.user.name}`
            : '尚未实名认证，不能购票或加入候补',
        ),
        submit,
      ),
    ),
  );
  content.replaceChildren(
    button('← 返回演出', () => setPage('events'), 'secondary small'),
    el('div', { class: 'two-col detail-columns' }, left, right),
  );
}
async function paymentPage() {
  if (!loginRequired()) {
    return;
  }
  if (!state.user.verified) {
    setPage('verify');
    showNotice('请先完成实名认证');
    return;
  }
  let order = state.paymentOrder;
  if (!order) {
    setPage('orders');
    return;
  }
  const countdown = el('div', { class: 'hint orange' });
  const updateCountdown = () => {
    if (order.state !== 'pending') {
      countdown.textContent = `订单状态：${orderLabel(order.state)}`;
      return;
    }
    const seconds = Math.max(0, Math.ceil((new Date(order.paymentDeadline) - Date.now()) / 1000));
    countdown.textContent = `请在 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 内完成支付；超时订单自动关闭，名额退回余票池`;
    if (seconds === 0) {
      content.querySelectorAll('[data-payment-action]').forEach((control) => {
        control.disabled = true;
      });
    }
  };
  updateCountdown();
  const summary = panel(
    el(
      'div',
      { class: 'stack' },
      el('h3', {}, '订单摘要'),
      el('p', {}, `演出：${order.eventTitle}`),
      el('p', {}, `场次 / 票档：${time(order.startsAt)} · ${order.tierName}`),
      el('p', {}, `实名观演人：${order.viewerName || state.user?.name || '已实名用户'}`),
      el('strong', {}, `应付金额：${money(order.priceCents)}`),
    ),
  );
  const result = panel(
    el(
      'div',
      { class: 'stack' },
      el('h3', {}, '出票结果'),
      el(
        'div',
        { class: 'hint green' },
        order.state === 'issued'
          ? '支付成功 · 已出票'
          : order.state === 'waiting'
            ? '已预付 · 候补中'
            : '支付完成后将在此显示出票信息',
      ),
      el('p', {}, `座位号：${order.seat || '待分配'}`),
      el('p', {}, `票码：${order.code || '待出票'}`),
      el('p', { class: 'muted' }, '票码是入场凭证；检票时请同时出示身份证。'),
    ),
  );
  const pay = async (success) => {
    order = await api(`/api/orders/${encodeURIComponent(order.id)}/pay`, {
      method: 'POST',
      body: { success },
    });
    state.paymentOrder = order;
    await render();
    showNotice(success ? '支付操作完成' : '已模拟支付失败');
  };
  const payButton = button('立即支付（模拟）', () => run(() => pay(true)), 'full');
  const failButton = button('模拟支付失败', () => run(() => pay(false)), 'secondary');
  payButton.dataset.paymentAction = 'pay';
  failButton.dataset.paymentAction = 'fail';
  if (order.state === 'pending' && Date.now() >= new Date(order.paymentDeadline).getTime()) {
    payButton.disabled = true;
    failButton.disabled = true;
  }
  const left = el(
    'div',
    {},
    countdown,
    summary,
    panel(
      el('h3', {}, '支付方式'),
      el('p', { class: 'muted' }, '站内模拟支付 · 重复提交仅第一次生效'),
    ),
    order.state === 'pending' && el('div', { class: 'actions' }, payButton, failButton),
  );
  content.replaceChildren(
    el('div', { class: 'two-col' }, left, result),
    button('查看我的订单', () => setPage('orders'), 'secondary'),
  );
  state.refresh = async () => {
    updateCountdown();
    if (order.state === 'pending' && Date.now() >= new Date(order.paymentDeadline).getTime()) {
      const orders = await api('/api/orders');
      state.paymentOrder = orders.find((item) => item.id === order.id) || order;
      await render();
    }
  };
}
async function ordersPage() {
  if (!loginRequired()) {
    return;
  }
  const filters = el(
    'form',
    { class: 'filters' },
    field('订单 ID', 'id', 'search'),
    field('用户 ID', 'userId', 'search'),
    el('button', { class: 'button' }, '查询'),
  );
  const tabs = el('div', { class: 'tabs' });
  const list = el('div', { class: 'stack' });
  let filter = 'all';
  const drawTabs = () =>
    tabs.replaceChildren(
      ...[
        ['all', '全部'],
        ['pending', '待支付'],
        ['waiting', '候补中'],
        ['issued', '已出票'],
        ['refunded', '已退款'],
      ].map(([value, text]) =>
        button(
          text,
          () => {
            filter = value;
            drawTabs();
            draw();
          },
          filter === value ? '' : 'secondary',
        ),
      ),
    );
  const draw = () => {
    const orders = (state.orders || []).filter((o) => filter === 'all' || o.state === filter);
    list.replaceChildren(
      ...(orders.length
        ? orders.map((order) => {
            const info = el(
              'div',
              { class: 'stack' },
              el(
                'div',
                { class: 'row' },
                el('h3', {}, order.eventTitle),
                tag(orderLabel(order.state), order.state === 'waiting' ? 'orange' : 'green'),
              ),
              el(
                'p',
                { class: 'muted' },
                `${time(order.startsAt)} · ${order.location || ''} · ${order.tierName} ${money(order.priceCents)}`,
              ),
            );
            if (order.state === 'waiting') {
              info.append(
                el('p', {}, `已预付全款 · 候补第 ${order.waitlistPosition ?? '—'} 位`),
                el(
                  'p',
                  { class: 'muted' },
                  `报名截止：${time(order.registrationDeadline)}；未递补将自动退款`,
                ),
              );
            }
            if (order.code) {
              info.append(el('p', {}, `座位：${order.seat || '待分配'} · 票码：${order.code}`));
            }
            if (order.refundPreview) {
              const p = order.refundPreview;
              info.append(
                el(
                  'p',
                  { class: 'muted' },
                  p.allowed
                    ? `退票试算：手续费 ${money(p.feeCents)}，预计退回 ${money(p.refundCents)}`
                    : `退票：${p.reason || '当前不可退款'}`,
                ),
              );
            }
            if (state.user.role === 'admin') {
              info.append(
                el('p', { class: 'muted' }, `订单 ID：${order.id} · 用户 ID：${order.userId}`),
              );
            }
            const actions = el('div', { class: 'actions' });
            if (state.user.role === 'participant') {
              if (order.state === 'pending') {
                actions.append(
                  button(
                    '继续支付',
                    () => {
                      state.paymentOrder = order;
                      setPage('payment');
                    },
                    'secondary',
                  ),
                );
              }
              if (order.state === 'issued' && order.refundPreview?.allowed) {
                actions.append(
                  button('申请退票', () => orderAction(order.id, 'refund', {}), 'secondary'),
                );
              }
              if (order.state === 'waiting') {
                actions.append(
                  button('退出候补', () => orderAction(order.id, 'leave', {}), 'secondary'),
                );
              }
            }
            return panel(el('div', { class: 'list-row' }, info, actions));
          })
        : [empty('暂无订单', '订单记录会显示在这里。')]),
    );
  };
  const load = async () => {
    const v = formData(filters);
    const params = new URLSearchParams(Object.entries(v).filter(([, value]) => value));
    state.orders = await api('/api/orders?' + params);
    draw();
  };
  submitForm(filters, load);
  drawTabs();
  state.refresh = load;
  content.replaceChildren(tabs, state.user.role === 'admin' ? panel(filters) : null, list);
  await load();
}
function orderAction(id, action, body) {
  run(async () => {
    await api(`/api/orders/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });
    await render();
  }, '操作已完成');
}
function eventEditor(event = {}) {
  const sessions = el('div', { class: 'stack' });
  (event.sessions?.length ? event.sessions : [{}]).forEach((session) =>
    sessions.append(sessionEditor(session)),
  );
  const form = el(
    'form',
    { class: 'stack' },
    el('h3', {}, event.id ? '修改演出申请' : '新建演出申请'),
    field('演出名称（必填）', 'title', 'text', { required: true, value: event.title || '' }),
    el(
      'div',
      { class: 'form-grid' },
      field('主演 / 主讲人', 'speaker', 'text', { required: true, value: event.speaker || '' }),
      selectField(
        '类型',
        'kind',
        [
          ['performance', '付费演出'],
          ['lecture', '讲座'],
        ],
        event.kind || 'performance',
      ),
      field('主题', 'theme', 'text', { required: true, value: event.theme || '' }),
      field('计划发布时间', 'publishAt', 'datetime-local', {
        required: true,
        value: localTime(event.publishAt),
      }),
    ),
    sessions,
    button('＋ 添加场次', () => sessions.append(sessionEditor()), 'secondary'),
    el('button', { class: 'button full' }, '提交平台管理员审核'),
  );
  submitForm(form, async (f) => {
    const v = formData(f);
    const list = [...sessions.children].map((box) => ({
      startsAt: iso(editorValue(box, 'startsAt')),
      endsAt: iso(editorValue(box, 'endsAt')),
      location: editorValue(box, 'location'),
      saleAt: iso(editorValue(box, 'saleAt')),
      deadline: iso(editorValue(box, 'deadline')),
      tiers: [...box.querySelectorAll('.tier-editor')].map((t) => ({
        name: editorValue(t, 'tierName'),
        priceCents: Math.round(Number(editorValue(t, 'tierPrice')) * 100),
        capacity: Number(editorValue(t, 'tierCapacity')),
      })),
    }));
    if (!list.length || list.some((s) => !s.tiers.length)) {
      throw new Error('请至少添加一个场次和票档');
    }
    await api(event.id ? `/api/events/${encodeURIComponent(event.id)}/resubmit` : '/api/events', {
      method: 'POST',
      body: {
        title: v.title,
        kind: v.kind,
        speaker: v.speaker,
        theme: v.theme,
        publishAt: iso(v.publishAt),
        sessions: list,
      },
    });
    if (dialog.open) {
      dialog.close();
    }
    await render();
    showNotice('活动申请已提交');
  });
  if (event.id) {
    modal('修改并重新提交', form);
  } else {
    return form;
  }
}
async function organizerPage() {
  const events = await api('/api/events');
  const reviews = await api('/api/reviews');
  const mine = el('div', { class: 'stack' }, el('h3', {}, '我的活动'));
  const table = el('table', { class: 'activity-table' });
  table.append(
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...['活动名称', '状态', '场次 / 票档', '操作'].map((title) => el('th', {}, title)),
      ),
    ),
  );
  const rows = el('tbody');
  events.forEach((event) => {
    const actions = el(
      'div',
      { class: 'actions' },
      button('详情', () => eventDetail(event.id), 'secondary small'),
      button('变更', () => changeDialog(event), 'secondary small'),
      ['draft', 'rejected'].includes(event.status) &&
        button('重新提交', () => eventEditor(event), 'secondary small'),
    );
    const tierCount = event.sessions.reduce((count, session) => count + session.tiers.length, 0);
    rows.append(
      el(
        'tr',
        {},
        el('td', {}, event.title),
        el('td', {}, label(event.status)),
        el('td', {}, `${event.sessions.length} / ${tierCount}`),
        el('td', {}, actions),
      ),
    );
  });
  table.append(rows);
  mine.append(table);
  if (!events.length) {
    mine.append(el('p', { class: 'muted' }, '暂无活动'));
  }
  const progress = panel(
    el('h3', {}, '审核进度'),
    reviews.length
      ? reviews.map((r) =>
          el(
            'p',
            { class: 'muted' },
            `${r.eventTitle} · ${label(r.kind)} · ${label(r.status)}${r.reason ? ' · ' + r.reason : ''}`,
          ),
        )
      : el('p', { class: 'muted' }, '提交后审核进度与结论将在此显示。'),
  );
  content.replaceChildren(
    el('div', { class: 'two-col' }, el('div', {}, panel(eventEditor()), progress), panel(mine)),
  );
}
function reviewSummary(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const lines = [];
  if (payload.title) {
    lines.push('活动：' + payload.title);
  }
  if (payload.reason) {
    lines.push('原因：' + payload.reason);
  }
  for (const session of payload.sessions || []) {
    lines.push(
      [time(session.startsAt), time(session.endsAt), session.location].filter(Boolean).join(' · '),
    );
    for (const tier of session.tiers || []) {
      lines.push(tier.name + ' ' + money(tier.priceCents) + ' / ' + tier.capacity + ' 张');
    }
  }
  return lines.join('；');
}
async function reviewsPage() {
  const reviews = await api('/api/reviews');
  const users = await api('/api/users');
  const pending = reviews.filter((r) => r.status === 'pending');
  const left = el('div', { class: 'stack' });
  for (const review of pending) {
    const reason = el('textarea', { placeholder: '请填写驳回原因，将随结论一并提供给组织者' });
    const submit = (approved) =>
      run(async () => {
        if (!approved && !reason.value.trim()) {
          throw new Error('驳回时请填写原因');
        }
        await api(`/api/reviews/${encodeURIComponent(review.id)}`, {
          method: 'POST',
          body: { approved, reason: reason.value },
        });
        await render();
      }, '审核结果已提交');
    left.append(
      panel(
        el(
          'div',
          { class: 'stack' },
          el(
            'div',
            { class: 'row' },
            el('h3', {}, review.eventTitle),
            tag(`待审核 · ${label(review.kind)}`, 'orange'),
          ),
          el(
            'p',
            { class: 'muted' },
            `申请时间：${time(review.createdAt)} · ${review.reason || '暂无申请说明'}`,
          ),
          el('p', { class: 'muted' }, reviewSummary(review.payload)),
          el('label', {}, '驳回原因（驳回时必填）', reason),
          el(
            'div',
            { class: 'actions' },
            button('审核通过', () => submit(true)),
            button('驳回', () => submit(false), 'secondary'),
          ),
        ),
      ),
    );
  }
  if (!pending.length) {
    left.append(empty('暂无待审核申请', '新的申请会出现在这里。'));
  }
  const userSelect = selectField(
    '账号',
    'userId',
    users.map((u) => [String(u.id), `${u.phone} · ${roles[u.role]}${u.banned ? ' · 已封禁' : ''}`]),
  );
  const banReason = field('操作原因', 'reason', 'text', { placeholder: '请输入处理原因' });
  const banForm = el(
    'form',
    { class: 'stack' },
    el('h3', {}, '账号封禁'),
    userSelect,
    banReason,
    el(
      'div',
      { class: 'actions' },
      button('封禁账号', () => ban(true), 'danger'),
      button('解除封禁', () => ban(false), 'secondary'),
    ),
  );
  function ban(banned) {
    run(async () => {
      const v = formData(banForm);
      if (!v.userId || !v.reason.trim()) {
        throw new Error('请选择账号并填写操作原因');
      }
      await api(`/api/users/${encodeURIComponent(v.userId)}/ban`, {
        method: 'POST',
        body: { banned, reason: v.reason },
      });
      await render();
    }, '账号状态已更新');
  }
  left.append(panel(banForm));
  const recent = reviews.filter((r) => r.status !== 'pending').slice(0, 6);
  const right = el(
    'div',
    {},
    panel(
      el('h2', {}, '今日待办'),
      el('p', { class: 'muted' }, `演出审核 ${pending.length} 件待处理`),
      el('p', { class: 'muted' }, '签到窗口开启 · 数据查询 · 违规账号处理'),
    ),
    panel(
      el('h2', {}, '最近处理记录'),
      recent.length
        ? recent.map((r) =>
            el('p', { class: 'muted' }, `${r.eventTitle} · ${label(r.kind)} · ${label(r.status)}`),
          )
        : el('p', { class: 'muted' }, '暂无处理记录'),
    ),
  );
  content.replaceChildren(el('div', { class: 'two-col equal-col' }, left, right));
}
async function checkinPage() {
  if (state.user.role === 'admin') {
    const events = await api('/api/events');
    const choices = events.flatMap((e) =>
      (e.sessions || []).map((s) => [
        String(s.id),
        `${e.title} · ${time(s.startsAt)} · ${s.location}`,
      ]),
    );
    const form = el(
      'form',
      { class: 'stack' },
      selectField('选择场次', 'sessionId', choices, choices[0]?.[0]),
      el('button', { class: 'button', disabled: !choices.length }, '开启检票窗口'),
    );
    submitForm(form, async (f) => {
      await api(`/api/sessions/${encodeURIComponent(formData(f).sessionId)}/checkin-window`, {
        method: 'POST',
        body: {},
      });
      showNotice('检票窗口已开启');
    });
    content.replaceChildren(
      heading('签到窗口', '为指定场次开启检票。'),
      choices.length ? panel(form) : empty('暂无场次', '活动场次会显示在这里。'),
      button(
        '刷新活动状态',
        () =>
          run(async () => {
            await api('/api/maintenance', { method: 'POST', body: {} });
          }, '活动状态已刷新'),
        'secondary',
      ),
    );
    return;
  }
  const status = await api('/api/checkin-status');
  const statusBar = el('div', { class: 'hint' });
  const updateStatus = (current) => {
    statusBar.className = `hint ${current.openCount ? 'green' : 'orange'}`;
    statusBar.textContent = `签到窗口${current.openCount ? '已开启' : '尚未开启'} · 已开启 ${current.openCount} / ${current.sessionCount} 场`;
  };
  updateStatus(status);
  state.refresh = async () => updateStatus(await api('/api/checkin-status'));
  const result = el('div', { class: 'hint' }, '等待核验');
  const records = el('div', { class: 'stack' });
  const draw = () => {
    state.checkins = state.checkins.filter((record) => record.day === new Date().toDateString());
    records.replaceChildren(
      ...(state.checkins.length
        ? state.checkins.map((record) =>
            el('p', { class: 'muted' }, `${record.time}　${record.code}　已签到`),
          )
        : [el('p', { class: 'muted' }, '本次会话暂无核销记录')]),
    );
  };
  draw();
  const form = el(
    'form',
    { class: 'stack' },
    el('h3', {}, '票码核销'),
    el('p', { class: 'muted' }, '输入观众提供的唯一票码，同时核对完整身份证号。'),
    field('观众票码', 'code', 'text', { required: true }),
    field('身份证号', 'idNumber', 'text', { required: true, placeholder: '请输入完整身份证号' }),
    el('button', { class: 'button full' }, '核销并放行'),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const v = formData(form);
    run(async () => {
      try {
        const decision = await api('/api/checkin', { method: 'POST', body: v });
        result.textContent = decision.message || '核验通过，准予入场';
        result.className = 'hint green';
        state.checkins.unshift({
          code: v.code,
          time: new Date().toLocaleTimeString('zh-CN'),
          day: new Date().toDateString(),
        });
        draw();
        form.reset();
      } catch (error) {
        result.textContent = error.message;
        result.className = 'hint orange';
      }
    });
  });
  content.replaceChildren(
    statusBar,
    el(
      'div',
      { class: 'two-col' },
      el('div', {}, panel(form), panel(el('h3', {}, '本次登录 · 今日核销记录'), records)),
      el(
        'div',
        {},
        panel(el('h3', {}, '核验结果'), result),
        panel(
          el('h3', {}, '其他情形的提示'),
          el(
            'p',
            { class: 'muted' },
            '重复核验、无效票码、身份不匹配或窗口未开启时，系统将提示原因。',
          ),
        ),
      ),
    ),
  );
}
async function statisticsPage() {
  const events = await api('/api/events');
  const sessions = events.flatMap((event) =>
    (event.sessions || []).map((session) => ({ event, session })),
  );
  if (!sessions.length) {
    content.replaceChildren(empty('暂无场次', '创建活动后可查看统计。'));
    return;
  }
  let selected =
    sessions.find((x) => String(x.session.id) === String(state.statisticsSession)) || sessions[0];
  const tabs = el('div', { class: 'tabs' });
  const result = el('div');
  const load = async () => {
    state.statisticsSession = selected.session.id;
    tabs.replaceChildren(
      ...sessions.map((item) =>
        button(
          `${time(item.session.startsAt)} ${item.event.title}`,
          () => {
            selected = item;
            run(load);
          },
          item === selected ? '' : 'secondary',
        ),
      ),
    );
    const data = await api(`/api/sessions/${encodeURIComponent(selected.session.id)}/statistics`);
    const fields = [
      [
        '上座率（到场 / 出票）',
        data.attendanceRate == null ? '—' : `${(data.attendanceRate * 100).toFixed(1)}%`,
      ],
      ['购票总人数', data.purchased],
      ['实际到场人数', data.attended],
      ['候补人数', data.waiting],
      ['退票数', data.refunded],
      ['缺席数', data.absent],
    ];
    const link = el(
      'a',
      {
        class: 'button full',
        href: `/api/events/${encodeURIComponent(selected.event.id)}/export?sessionId=${encodeURIComponent(selected.session.id)}`,
        download: '',
      },
      '导出名单（.csv）',
    );
    result.replaceChildren(
      el(
        'div',
        { class: 'metrics' },
        fields.map(([name, value]) =>
          el('div', { class: 'metric' }, el('strong', {}, value), name),
        ),
      ),
      el('div', { class: 'hint' }, '上座率 = 实际到场人数 ÷ 出票数；出票数为 0 时不参与计算。'),
      el(
        'div',
        { class: 'two-col' },
        panel(
          el(
            'div',
            { class: 'stack' },
            el('h3', {}, '导出本场观众名单'),
            el(
              'p',
              { class: 'muted' },
              '字段：姓名、联系方式、座位号；仅限本场次，导出操作记入审计日志。',
            ),
            link,
          ),
        ),
        panel(
          el('h3', {}, '缺席与异常'),
          el('p', { class: 'muted' }, `本场缺席 ${data.absent} 人。`),
        ),
      ),
      panel(
        el('h3', {}, '各票档售票明细'),
        ...(selected.session.tiers || []).map((t) =>
          el(
            'p',
            { class: 'muted' },
            `${t.name} · ${money(t.priceCents)} · 总量 ${t.capacity} · 余 ${t.remaining}`,
          ),
        ),
      ),
    );
  };
  content.replaceChildren(tabs, result);
  await load();
  state.refresh = async () => {
    const fresh = await api('/api/events');
    const event = fresh.find((item) => String(item.id) === String(selected.event.id));
    const session = event?.sessions.find((item) => String(item.id) === String(selected.session.id));
    if (session) {
      selected.session = session;
    }
    await load();
  };
}
async function render() {
  state.refresh = null;
  nav();
  content.dataset.page = state.page;
  try {
    const pages = {
      auth: authPage,
      verify: verifyPage,
      events: eventsPage,
      detail: detailPage,
      payment: paymentPage,
      orders: ordersPage,
      organizer: organizerPage,
      statistics: statisticsPage,
      reviews: reviewsPage,
      checkin: checkinPage,
      messages: messagesPage,
      audit: auditPage,
      users: usersPage,
    };
    await (pages[state.page] || authPage)();
  } catch (error) {
    content.replaceChildren(empty('加载失败', error.message));
  }
}

document.querySelector('#account-button').addEventListener('click', accountDialog);
document.querySelector('#brand').addEventListener('click', (event) => {
  event.preventDefault();
  setPage(state.user ? signedInPage() : 'auth');
});
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) {
    dialog.close();
  }
});
setInterval(() => {
  if (!dialog.open && !document.hidden && state.refresh) {
    state.refresh().catch(() => {});
  }
}, 15000);
setInterval(() => {
  if (state.page === 'payment' && state.refresh && !document.hidden) {
    state.refresh().catch(() => {});
  }
}, 1000);
(async () => {
  try {
    state.user = await api('/api/me');
  } catch (error) {
    showNotice(error.message, true);
  }
  state.page = signedInPage();
  await render();
})();

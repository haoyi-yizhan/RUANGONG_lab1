import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { TicketingSystem } from '../src/system.mjs';
import { createApplication } from '../src/server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const evidence = join(root, 'evidence');
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'ticket-browser-'));
const system = new TicketingSystem();
system.bootstrap();
// All fixtures live in the in-memory database, isolated from the application data.
const participant = system.register({ phone: '13900000001', password: 'Browser123!', role: 'participant' }).user;
const organizer = system.db.prepare("SELECT id FROM users WHERE role='organizer' LIMIT 1").get().id;
const admin = system.db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get().id;
const now = Date.now();
const iso = value => new Date(value).toISOString();
const checkinEvent = system.createEvent(organizer, {
  title: '浏览器检票演示', kind: 'performance', speaker: '校园乐队', theme: '现场演出',
  publishAt: iso(now - 120000), sessions: [{ startsAt: iso(now + 3600000),
    endsAt: iso(now + 7200000), saleAt: iso(now - 120000), deadline: iso(now + 1800000),
    location: '校园礼堂', tiers: [{ name: '普通票', priceCents: 10000, capacity: 10 }] }],
});
const checkinReview = system.db.prepare("SELECT id FROM reviews WHERE event_id=? AND status='pending'").get(checkinEvent.id);
system.review(admin, checkinReview.id, { approved: true });
const server = createApplication({ system });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const browserPath = process.env.CHROME_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync);
assert.ok(browserPath, 'Set CHROME_PATH to a Chromium browser executable');
const browser = spawn(browserPath, [
  '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const errors = [];
try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error('Browser startup timed out')), 20000);
    browser.once('error', reject);
    browser.once('exit', code => reject(new Error(`Browser exited: ${code}`)));
    browser.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
      if (match) {
        clearTimeout(timeout);
        resolveEndpoint(match[1]);
      }
    });
  });
  const remote = new URL(endpoint);
  const targets = await (await fetch(`http://${remote.host}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveSocket, reject) => {
    socket.addEventListener('open', resolveSocket, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.text);
    }
    if (message.id && pending.has(message.id)) {
      const { resolveCall, rejectCall, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) rejectCall(new Error(message.error.message));
      else resolveCall(message.result);
    }
  });
  function cdp(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCall(new Error(`CDP timeout: ${method}`));
      }, 15000);
      pending.set(id, { resolveCall, rejectCall, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(expression) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    throw new Error(`Page condition failed: ${expression}`);
  }
  async function screenshot(filename) {
    const image = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const data = Buffer.from(image.data, 'base64');
    await writeFile(join(artifacts, filename), data);
    await writeFile(join(evidence, filename), data);
  }
  const click = text => evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing button: '+${JSON.stringify(text)});b.click()})()`);
  const fill = (name,value) => evaluate(`(() => {const e=document.querySelector('[name="'+${JSON.stringify(name)}+'"]');if(!e)throw Error('Missing field: '+${JSON.stringify(name)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const submit = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
  const page = name => until(`document.querySelector('#content').dataset.page===${JSON.stringify(name)}`);
  const nav = name => evaluate(`document.querySelector('[data-page="'+${JSON.stringify(name)}+'"]').click()`);
  const login = async (phone,password) => { await page('auth'); await fill('phone',phone); await fill('password',password); await submit('#content form'); };
  const logout = async () => { await click('账号设置'); await click('退出登录'); await page('auth'); };
  const snap = async (name,legacy) => { await screenshot(name); if(legacy) { await copyFile(join(artifacts,name),join(artifacts,legacy)); await copyFile(join(evidence,name),join(evidence,legacy)); } };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:address}); await page('auth');
  await snap('ui-01-login.png');
  await login('13900000001','Browser123!'); await page('verify'); await snap('ui-02-verify.png');
  await fill('name','浏览器观众'); await fill('idNumber','110101199001010018'); await submit('#content form'); await page('events');
  await fill('keyword','校园秋日音乐会'); await submit('#content form');
  await until("document.querySelector('#content').textContent.includes('校园秋日音乐会')"); await snap('ui-03-events.png','browser-home.png');
  await click('查看购票'); await page('detail'); await until("document.querySelector('[name=tier]')");
  await evaluate("document.querySelector('[name=tier]').click()"); await snap('ui-04-detail.png');
  await click('提交订单'); await page('payment'); await until("/\\d+:\\d{2}/.test(document.querySelector('#content').textContent)"); await snap('ui-05-payment.png');
  await click('立即支付（模拟）'); await until("document.querySelector('#content').textContent.includes('支付成功 · 已出票')"); await snap('ui-extra-issued.png','browser-issued.png');
  await click('查看我的订单'); await page('orders'); await until("document.querySelector('#content').textContent.includes('申请退票')");
  await click('已出票'); await snap('ui-06-orders.png'); await click('申请退票');
  await until("document.querySelector('#content').textContent.includes('已取消')");
  assert.equal(system.db.prepare('SELECT refund_cents FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(participant.id).refund_cents,8000);
  const ticket=system.createOrder(participant.id,{tierId:checkinEvent.sessions[0].tiers[0].id});
  const issued=system.pay(participant.id,ticket.id,{success:true});
  await logout(); await login('13800000003','Organizer123!'); await page('organizer');
  await until("document.querySelector('[name=title]')"); await snap('ui-07-organizer.png');
  const local=value=>{const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)};
  for(const [name,value] of Object.entries({title:'浏览器申请演出',speaker:'校园乐队',theme:'测试音乐会',publishAt:local(now+3600000),startsAt:local(now+864000000),endsAt:local(now+871200000),saleAt:local(now+7200000),deadline:local(now+777600000),location:'校园剧场',tierName:'普通票',tierPrice:'100',tierCapacity:'20'})) await fill(name,value);
  await submit('#content form'); await until("document.querySelector('#content').textContent.includes('浏览器申请演出')");
  await logout(); await login('13800000001','Admin12345!'); await page('reviews');
  await until("document.querySelector('#content').textContent.includes('浏览器申请演出')"); await snap('ui-08-admin.png');
  await evaluate("[...document.querySelectorAll('.panel')].find(p=>p.textContent.includes('浏览器申请演出')).querySelector('button').click()");
  await until("document.querySelector('#notice').textContent.includes('审核结果已提交')");
  await nav('checkin'); await page('checkin'); await until("document.querySelector('[name=sessionId]')");
  await fill('sessionId',checkinEvent.sessions[0].id); await submit('#content form');
  await until("document.querySelector('#notice').textContent.includes('检票窗口已开启')");
  await logout(); await login('13800000002','Checker123!'); await page('checkin');
  await until("document.querySelector('#content').textContent.includes('签到窗口已开启')");
  await fill('code',issued.code); await fill('idNumber','110101199001010018'); await submit('#content form');
  await until("document.querySelector('#content').textContent.includes('准予入场')"); await snap('ui-09-checkin.png','browser-checkin.png');
  await logout(); await login('13800000003','Organizer123!'); await page('organizer'); await nav('statistics'); await page('statistics');
  await until("document.querySelectorAll('#content .metric').length===6");
  await evaluate("[...document.querySelectorAll('#content .tabs button')].find(b=>b.textContent.includes('浏览器检票演示')).click()");
  await until("document.querySelector('#content .metric strong').textContent==='100.0%'");
  assert.match(await evaluate("document.querySelector('#content a[download]').getAttribute('href')"),/^\/api\/events\/.+\/export\?sessionId=/u);
  await snap('ui-10-statistics.png');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await until('document.documentElement.scrollWidth <= window.innerWidth'); await screenshot('browser-mobile.png');
  assert.equal(errors.length,0,`Browser errors: ${errors.join(',')}`);
  const results={browser:browserPath.includes('msedge')?'Microsoft Edge headless':'Chrome headless',passed:true,
    screens:['login','verify','events','detail','payment','orders','organizer','admin','checkin','statistics'],
    interactiveChecks:['login','identity verification','event filtering','ticket selection','create order','payment countdown','payment and issuance','order filtering and 80 yuan refund','organizer application','admin approval and checkin window','checker ticket and identity verification','six statistics cards and export link','mobile layout without horizontal overflow'],runtimeErrors:errors,completedAt:new Date().toISOString()};
  await writeFile(join(artifacts,'browser-results.json'),JSON.stringify(results,null,2));
  await copyFile(join(artifacts,'browser-results.json'),join(evidence,'browser-results.json'));
  console.log(JSON.stringify(results,null,2));
} finally {
  socket?.close();
  const ended = new Promise(resolveExit => browser.once('exit', resolveExit));
  if (browser.exitCode === null) {
    browser.kill();
    await ended;
  }
  await new Promise(resolveServer => server.close(resolveServer));
  system.close();
  const absolute = resolve(profile);
  const tempRoot = resolve(tmpdir()) + sep;
  assert.ok(absolute.startsWith(tempRoot) && absolute.includes('ticket-browser-'));
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

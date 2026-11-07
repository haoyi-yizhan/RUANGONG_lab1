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
const profile = await mkdtemp(join(tmpdir(), 'ticket-browser-'));
const system = new TicketingSystem();
system.bootstrap();
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
  const clickText = text => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: address });
  await until("document.body.textContent.includes('校园秋日音乐会')");
  const home = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(artifacts, 'browser-home.png'), Buffer.from(home.data, 'base64'));
  await clickText('登录 / 注册');
  await evaluate(`document.querySelector('[name=phone]').value='13800000004';
    document.querySelector('[name=password]').value='Participant123!';
    document.querySelector('#dialog form').requestSubmit();`);
  await until("document.querySelector('#user-badge').textContent.includes('演示观众') && !document.querySelector('#dialog').open");
  await clickText('查看详情');
  await until("document.querySelector('#dialog').open && document.querySelector('#dialog').textContent.includes('每账号每场次')");
  await clickText('立即报名');
  await until("document.querySelector('#content').textContent.includes('待支付')");
  await clickText('模拟支付');
  await until("document.querySelector('#content').textContent.includes('已出票')");
  const order = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(artifacts, 'browser-issued.png'), Buffer.from(order.data, 'base64'));
  await clickText('申请退款');
  await until("document.querySelector('#content').textContent.includes('已取消')");
  const text = await evaluate("document.querySelector('#content').textContent");
  assert.match(text, /80\.00/u);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await clickText('◈发现活动').catch(async () => {
    await evaluate("document.querySelector('#navigation button').click()");
  });
  await until("document.querySelector('#content').textContent.includes('校园秋日音乐会')");
  const mobile = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(artifacts, 'browser-mobile.png'), Buffer.from(mobile.data, 'base64'));
  assert.equal(errors.length, 0, `Browser errors: ${errors.join(',')}`);
  const results = { browser: browserPath.includes('msedge') ? 'Microsoft Edge headless' : 'Chrome headless', passed: true,
    scenarios: ['home rendering', 'form login', 'rules disclosure', 'create order', 'simulated payment', 'refund 80.00', 'mobile layout'],
    runtimeErrors: errors, completedAt: new Date().toISOString() };
  await writeFile(join(artifacts, 'browser-results.json'), JSON.stringify(results, null, 2));
  await mkdir(join(root, 'evidence'), { recursive: true });
  for (const filename of ['browser-home.png', 'browser-issued.png', 'browser-mobile.png', 'browser-results.json']) {
    await copyFile(join(artifacts, filename), join(root, 'evidence', filename));
  }
  console.log(JSON.stringify(results, null, 2));
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

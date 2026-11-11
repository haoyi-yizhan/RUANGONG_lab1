import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { TicketingSystem } from './system.mjs';
import { DomainError, ensure } from './errors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function cookieToken(request) {
  const cookies = (request.headers.cookie || '').split(';');
  const session = cookies.find(value => value.trim().startsWith('ticket_session='));
  return session ? session.trim().slice('ticket_session='.length) : null;
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    ensure(size <= 256 * 1024, 'BODY_TOO_LARGE', '请求数据过大', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    ensure(value && !Array.isArray(value) && typeof value === 'object',
      'INVALID_JSON', '请求应为 JSON 对象');
    return value;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError('INVALID_JSON', '无法解析 JSON 请求');
  }
}

/** Adapter exposes only explicit application operations, never arbitrary SQL or file paths. */
export function createApplication({ system, publicDirectory = join(root, 'public') } = {}) {
  ensure(system, 'CONFIGURATION', '缺少系统实例');
  const attempts = new Map();
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = request.headers.host || '127.0.0.1';
      const url = new URL(request.url, `http://${host}`);
      const path = url.pathname;
      const method = request.method;
      if (method === 'GET' && staticFiles.has(path)) {
        const [name, type] = staticFiles.get(path);
        const filename = join(publicDirectory, name);
        await stat(filename);
        response.writeHead(200, { 'Content-Type': type });
        const stream = createReadStream(filename);
        stream.on('error', () => response.destroy());
        stream.pipe(response);
        return;
      }
      ensure(path.startsWith('/api/'), 'NOT_FOUND', '页面不存在', 404);
      ensure(['GET', 'POST'].includes(method), 'METHOD_NOT_ALLOWED', '不支持该请求方法', 405);
      if (method === 'POST') {
        const origin = request.headers.origin;
        ensure(!origin || origin === `http://${host}` || origin === `https://${host}`,
          'ORIGIN_DENIED', '请求来源不受信任', 403);
        ensure(!request.headers['sec-fetch-site'] || request.headers['sec-fetch-site'] !== 'cross-site',
          'ORIGIN_DENIED', '不允许跨站请求', 403);
        ensure((request.headers['content-type'] || '').startsWith('application/json'),
          'CONTENT_TYPE', '请发送 JSON 格式请求', 415);
      }
      const body = method === 'POST' ? await readBody(request) : {};
      const token = cookieToken(request);
      const user = system.authenticate(token);
      const actor = user?.id || null;
      const filters = Object.fromEntries(url.searchParams);
      let result;
      let match;
      if (method === 'POST' && ['/api/login', '/api/register', '/api/reset-password'].includes(path)) {
        // Bound expensive password hashing attempts, independently from ticket traffic.
        const key = request.socket.remoteAddress || 'local';
        const now = Date.now();
        const counter = attempts.get(key);
        if (!counter || now - counter.since >= 60000) {
          attempts.set(key, { since: now, count: 1 });
        } else {
          counter.count += 1;
          ensure(counter.count <= 100, 'RATE_LIMIT', '账号请求过于频繁，请一分钟后重试', 429);
        }
        if (attempts.size > 1000) {
          for (const [address, value] of attempts) {
            if (now - value.since >= 60000) attempts.delete(address);
          }
        }
      }
      if (method === 'GET' && path === '/api/me') {
        result = user;
      } else if (method === 'POST' && path === '/api/register') {
        result = system.register(body);
      } else if (method === 'POST' && path === '/api/login') {
        const login = system.login(body);
        response.setHeader('Set-Cookie', `ticket_session=${login.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        result = login.user;
      } else if (method === 'POST' && path === '/api/logout') {
        result = system.logout(token);
        response.setHeader('Set-Cookie', 'ticket_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      } else if (method === 'POST' && path === '/api/reset-password') {
        result = system.resetPassword(body);
      } else if (method === 'POST' && path === '/api/verify') {
        result = system.verify(actor, body);
      } else if (method === 'GET' && path === '/api/events') {
        result = system.listEvents(actor, filters);
      } else if (method === 'POST' && path === '/api/events') {
        result = system.createEvent(actor, body);
      } else if ((match = path.match(/^\/api\/events\/([^/]+)$/u)) && method === 'GET') {
        result = system.getEvent(actor, match[1]);
      } else if ((match = path.match(/^\/api\/events\/([^/]+)\/resubmit$/u)) && method === 'POST') {
        result = system.resubmitEvent(actor, match[1], body);
      } else if ((match = path.match(/^\/api\/events\/([^/]+)\/changes$/u)) && method === 'POST') {
        result = system.requestChange(actor, match[1], body);
      } else if ((match = path.match(/^\/api\/events\/([^/]+)\/export$/u)) && method === 'GET') {
        const csv = system.exportRoster(actor, match[1], filters.sessionId || null);
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="roster.csv"',
        });
        response.end(csv);
        return;
      } else if (method === 'GET' && path === '/api/reviews') {
        result = system.listReviews(actor);
      } else if ((match = path.match(/^\/api\/reviews\/([^/]+)$/u)) && method === 'POST') {
        result = system.review(actor, match[1], body);
      } else if (method === 'POST' && path === '/api/orders') {
        result = system.createOrder(actor, body);
      } else if (method === 'GET' && path === '/api/orders') {
        result = system.listOrders(actor, filters);
      } else if ((match = path.match(/^\/api\/orders\/([^/]+)\/(pay|refund|leave)$/u)) && method === 'POST') {
        const operation = { pay: 'pay', refund: 'refund', leave: 'leaveWaitlist' }[match[2]];
        result = system[operation](actor, match[1], body);
      } else if (method === 'GET' && path === '/api/messages') {
        result = system.listMessages(actor);
      } else if ((match = path.match(/^\/api\/sessions\/([^/]+)\/statistics$/u)) && method === 'GET') {
        result = system.statistics(actor, match[1]);
      } else if ((match = path.match(/^\/api\/sessions\/([^/]+)\/checkin-window$/u)) && method === 'POST') {
        result = system.openCheckin(actor, match[1]);
      } else if (method === 'POST' && path === '/api/checkin') {
        result = system.checkin(actor, body);
      } else if (method === 'GET' && path === '/api/checkin-status') {
        result = system.checkinStatus(actor);
      } else if (method === 'GET' && path === '/api/users') {
        result = system.listUsers(actor);
      } else if ((match = path.match(/^\/api\/users\/([^/]+)\/ban$/u)) && method === 'POST') {
        result = system.setBanned(actor, match[1], body);
      } else if (method === 'GET' && path === '/api/audit') {
        result = system.listAudit(actor, filters);
      } else if (method === 'POST' && path === '/api/maintenance') {
        system.actor(actor, ['admin']);
        result = system.maintain();
      } else {
        throw new DomainError('NOT_FOUND', '接口不存在', 404);
      }
      json(response, 200, { data: result });
    } catch (error) {
      if (error instanceof DomainError) {
        json(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        console.error('Request failed:', error.message);
        const busy = String(error.code).includes('BUSY') || /database is locked/u.test(error.message);
        json(response, busy ? 503 : 500, { error: {
          code: busy ? 'TEMPORARILY_BUSY' : 'INTERNAL_ERROR',
          message: busy ? '系统繁忙，请稍后重试；未完成的操作已回退' : '操作失败，未完成的修改已回退',
        } });
      }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

function start() {
  const filename = process.env.TICKETING_DB || join(root, 'data', 'ticketing.sqlite');
  const system = new TicketingSystem({ filename });
  system.bootstrap();
  const server = createApplication({ system });
  const timer = setInterval(() => {
    try {
      system.maintain();
    } catch (error) {
      console.error('Lifecycle processing will retry:', error.message);
    }
  }, 1000);
  timer.unref();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '127.0.0.1', () => {
    console.log(`活动票务与报名系统已启动：http://127.0.0.1:${port}`);
    console.log(`数据库：${filename}`);
  });
  server.on('error', error => {
    clearInterval(timer);
    system.close();
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  });
  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      system.close();
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  start();
}

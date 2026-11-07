import { mkdtemp, rm } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, platform, release, arch } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { TicketingSystem } from '../src/system.mjs';
import { createApplication } from '../src/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'ticket-benchmark-'));
const root = dirname(dirname(fileURLToPath(import.meta.url)));
let system, server;
try {
  const now = Date.now();
  system = new TicketingSystem({ filename: join(directory, 'benchmark.sqlite'), clock: () => now });
  const db = system.db;
  db.exec('BEGIN');
  try {
    db.prepare("INSERT INTO users(id,phone,password_hash,recovery_hash,role,created_at) VALUES ('bench-user','13800000000','fixture','fixture','participant',?)").run(now);
    db.prepare("INSERT INTO events(id,organizer_id,title,kind,speaker,theme,status,publish_at,created_at) VALUES ('bench-event','bench-user','Benchmark','performance','Artist','Benchmark','published',?,?)").run(now, now);
    db.prepare("INSERT INTO sessions(id,event_id,starts_at,ends_at,location,sale_at,deadline) VALUES ('bench-session','bench-event',?,?, 'Hall',?,?)").run(now + 864000000, now + 864003600, now - 1000, now + 800000000);
    db.prepare("INSERT INTO tiers(id,session_id,name,price_cents,capacity) VALUES ('bench-tier','bench-session','Standard',10000,10000)").run();
    const insert = db.prepare("INSERT INTO orders(id,user_id,tier_id,session_id,state,price_cents,payment_deadline,created_at) VALUES (?,'bench-user','bench-tier','bench-session','closed',10000,?,?)");
    for (let i = 0; i < 10000; i++) insert.run(`bench-order-${i}`, now, now + i);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  server = createApplication({ system });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const token = 'benchmark-session-token';
  const { createHash } = await import('node:crypto');
  db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'bench-user', now + 3600000);
  const url = `http://127.0.0.1:${server.address().port}/api/orders`;
  const results = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= 100) return;
      const started = performance.now();
      try {
        const response = await fetch(url, { headers: { cookie: `ticket_session=${token}` } });
        const body = await response.json();
        results[index] = { ms: performance.now() - started, success: response.ok && Array.isArray(body.data) && body.data.length === 500 };
      } catch { results[index] = { ms: performance.now() - started, success: false }; }
    }
  }
  const start = performance.now();
  await Promise.all(Array.from({ length: 20 }, worker));
  const elapsed = performance.now() - start;
  const times = results.map(result => result.ms).sort((a, b) => a - b);
  const passed = results.filter(result => result.success && result.ms <= 2000).length;
  const summary = { fixtureOrders: 10000, concurrency: 20, queries: 100, passedWithin2Seconds: passed, failed: results.filter(result => !result.success).length, p50Ms: times[49], p95Ms: times[94], maxMs: times[99], elapsedMs: elapsed, meetsRequirement: passed >= 95 };
  const evidence = { timestamp: new Date().toISOString(), environment: { node: process.version, os: platform(), osRelease: release(), architecture: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length }, query: 'Authenticated GET /api/orders for a user with 10,000 closed orders; each response returns at most 500 orders.', summary, results: results.map((result, index) => ({ request: index + 1, ...result })) };
  await mkdir(join(root, 'evidence'), { recursive: true });
  await writeFile(join(root, 'evidence', 'benchmark.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (passed < 95) process.exitCode = 1;
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  system?.close();
  await rm(directory, { recursive: true, force: true });
}

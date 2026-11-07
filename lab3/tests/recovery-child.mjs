import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
db.prepare("INSERT INTO orders(id,user_id,tier_id,session_id,state,price_cents,payment_deadline,created_at) VALUES ('uncommitted','recovery-user','recovery-tier','recovery-session','pending',10000,2000000000000,0)").run();
process.stdout.write('READY\n');
setInterval(() => {}, 1000);

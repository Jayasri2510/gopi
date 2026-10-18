import fs from 'node:fs';
import crypto from 'node:crypto';
import { openDb, get } from './db.js';
import { seedDemo } from './seed.js';
if (process.env.NODE_ENV === 'production') { console.error('Refusing to seed demo data in production.'); process.exit(1); }
fs.mkdirSync('./data', { recursive: true });
const db = openDb(process.env.DATABASE_FILE ?? './data/hotel.db');
if (get(db, 'SELECT 1 FROM users LIMIT 1')) { console.error('Database already has users; seed skipped.'); process.exit(1); }
const pw = process.env.SEED_PASSWORD ?? crypto.randomBytes(9).toString('base64url');
seedDemo(db, pw);
console.log(`Demo users created (*@demo.test: admin, manager, supervisor, reception, housekeeping, tech1, tech2).\nPassword: ${pw}`);

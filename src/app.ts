import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { DB } from './db.js';
import { authedRouter, authenticate, loginHandler } from './auth.js';
import { adminRouter } from './admin.js';
import { ticketRouter } from './tickets.js';
import { errorHandler } from './http.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '..', 'public');

export interface AppConfig { secureCookies: boolean; loginRateLimit: number; reopenWindowDays: number; sessionHours: number }

export function createApp(db: DB, cfg: Partial<AppConfig> = {}) {
  const c: AppConfig = { secureCookies: false, loginRateLimit: 20, reopenWindowDays: 7, sessionHours: 8, ...cfg };
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());                       // no CORS middleware: API is same-origin only by default
  app.use(express.json({ limit: '100kb' }));
  const api = express.Router();
  api.post('/auth/login', rateLimit({ windowMs: 15 * 60_000, limit: c.loginRateLimit, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } } }), loginHandler(db, c));
  api.use(authenticate(db));
  api.use(authedRouter(db, c));
  api.use(adminRouter(db));
  api.use(ticketRouter(db, c));
  api.use((_req, res) => { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }); });
  app.use('/api', api);

  app.use(express.static(publicDir));
  app.get(['/', '/index.html', '/login'], (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(publicDir, 'dashboard.html'));
  });

  app.use(errorHandler);
  return app;
}

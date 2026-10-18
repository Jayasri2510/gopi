import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { audit, get, run, nowIso, type DB } from './db.js';
import { HttpError, wrap, type AuthUser } from './http.js';

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 64).toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string) {
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const exp = Buffer.from(h, 'base64');
  return crypto.timingSafeEqual(exp, crypto.scryptSync(pw, Buffer.from(s, 'base64'), exp.length));
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const passwordSchema = z.string().min(10, 'Password must be at least 10 characters').max(200);
const MAX_FAILS = 5, LOCK_MIN = 15;

export interface AuthConfig { secureCookies: boolean; sessionHours: number }

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
}

export const loginHandler = (db: DB, c: AuthConfig) => wrap((req, res) => {
  const body = z.object({ email: z.string().email().max(200).transform(s => s.toLowerCase()), password: z.string().min(1).max(200) }).strict().parse(req.body);
  const u = get(db, 'SELECT * FROM users WHERE email = ?', body.email);
  if (u?.locked_until && u.locked_until > nowIso()) throw new HttpError(429, 'ACCOUNT_LOCKED', 'Account temporarily locked. Try again later.');
  const ok = verifyPassword(body.password, u?.password_hash ?? DUMMY_HASH); // constant-ish time for unknown users
  if (!u || !ok || !u.is_active) {
    if (u && !ok) {
      const fails = u.failed_logins + 1;
      run(db, 'UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', fails >= MAX_FAILS ? 0 : fails,
        fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null, u.id);
      audit(db, u.id, fails >= MAX_FAILS ? 'AUTH_LOCKOUT' : 'AUTH_LOGIN_FAILED', 'user', u.id);
    }
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  run(db, 'UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', u.id);
  const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + c.sessionHours * 3600000);
  run(db, 'INSERT INTO sessions VALUES (?,?,?,?,?)', sha(token), u.id, csrf, expires.toISOString(), nowIso());
  audit(db, u.id, 'AUTH_LOGIN', 'user', u.id);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure: c.secureCookies, expires, path: '/' });
  res.json({ data: { user: { id: u.id, email: u.email, name: u.name, role: u.role }, csrfToken: csrf } });
});

export const authenticate = (db: DB) => (req: Request, _res: Response, next: NextFunction) => {
  try {
    const token = readCookie(req, 'sid');
    const s = token && get(db, `SELECT s.csrf_token, s.expires_at, u.id, u.email, u.name, u.role, u.is_active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`, sha(token));
    if (!s || s.expires_at <= nowIso() || !s.is_active) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const sent = req.header('x-csrf-token') ?? '';
      if (sent.length !== s.csrf_token.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(s.csrf_token))) throw new HttpError(403, 'CSRF', 'Missing or invalid CSRF token');
    }
    req.user = { id: s.id, email: s.email, name: s.name, role: s.role } as AuthUser;
    req.csrf = s.csrf_token;
    next();
  } catch (e) { next(e); }
};

export function authedRouter(db: DB, c: AuthConfig) {
  const r = Router();
  r.get('/auth/me', wrap((req, res) => { res.json({ data: { user: req.user, csrfToken: req.csrf } }); }));
  r.post('/auth/logout', wrap((req, res) => {
    const token = readCookie(req, 'sid');
    if (token) run(db, 'DELETE FROM sessions WHERE id_hash = ?', sha(token));
    audit(db, req.user!.id, 'AUTH_LOGOUT', 'user', req.user!.id);
    res.clearCookie('sid', { path: '/' }).json({ data: { ok: true } });
  }));
  r.post('/auth/change-password', wrap((req, res) => {
    const b = z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }).strict().parse(req.body);
    const u = get(db, 'SELECT password_hash FROM users WHERE id = ?', req.user!.id)!;
    if (!verifyPassword(b.currentPassword, u.password_hash)) throw new HttpError(403, 'WRONG_PASSWORD', 'Current password is incorrect');
    run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(b.newPassword), req.user!.id);
    const token = readCookie(req, 'sid');
    run(db, 'DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?', req.user!.id, sha(token ?? '')); // revoke other sessions
    audit(db, req.user!.id, 'AUTH_PASSWORD_CHANGED', 'user', req.user!.id);
    res.json({ data: { ok: true } });
  }));
  return r;
}

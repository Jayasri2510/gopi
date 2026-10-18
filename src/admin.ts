import { Router } from 'express';
import { z } from 'zod';
import { all, audit, get, nowIso, run, tx, type DB } from './db.js';
import { passwordSchema, hashPassword } from './auth.js';
import { HttpError, requireRole, wrap } from './http.js';

const ROLES = ['ADMIN', 'MANAGER', 'SUPERVISOR', 'STAFF', 'TECHNICIAN'] as const;
const pid = z.coerce.number().int().positive();

export function adminRouter(db: DB) {
  const r = Router();
  // Reference data (any authenticated user)
  r.get('/locations', wrap((_req, res) => {
    const floors = all(db, 'SELECT id, name, level FROM floors ORDER BY level');
    const locs = all(db, 'SELECT id, floor_id AS floorId, kind, number, name FROM locations ORDER BY number');
    res.json({ data: floors.map(f => ({ ...f, locations: locs.filter(l => l.floorId === f.id) })) });
  }));
  r.get('/assets', wrap((req, res) => {
    const loc = pid.optional().parse(req.query.locationId);
    res.json({ data: all(db, `SELECT id, location_id AS locationId, category, asset_tag AS assetTag, description FROM assets ${loc ? 'WHERE location_id = ?' : ''} ORDER BY asset_tag`, ...(loc ? [loc] : [])) });
  }));

  // Users
  r.get('/users', requireRole('ADMIN', 'MANAGER', 'SUPERVISOR'), wrap((req, res) => {
    const role = z.enum(ROLES).optional().parse(req.query.role);
    res.json({ data: all(db, `SELECT id, email, name, role, is_active AS isActive FROM users ${role ? 'WHERE role = ?' : ''} ORDER BY name`, ...(role ? [role] : [])).map(u => ({ ...u, isActive: !!u.isActive })) });
  }));
  r.post('/users', requireRole('ADMIN'), wrap((req, res) => {
    const b = z.object({ email: z.string().email().max(200).transform(s => s.toLowerCase()), name: z.string().trim().min(1).max(100), role: z.enum(ROLES), password: passwordSchema }).strict().parse(req.body);
    if (get(db, 'SELECT 1 FROM users WHERE email = ?', b.email)) throw new HttpError(409, 'EMAIL_TAKEN', 'A user with this email already exists');
    const uid = tx(db, () => {
      const n = Number(run(db, 'INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?,?,?,?,?)', b.email, b.name, b.role, hashPassword(b.password), nowIso()).lastInsertRowid);
      audit(db, req.user!.id, 'USER_CREATED', 'user', n, { role: b.role }); return n;
    });
    res.status(201).json({ data: { id: uid } });
  }));
  r.patch('/users/:id', requireRole('ADMIN'), wrap((req, res) => {
    const uid = pid.parse(req.params.id);
    const b = z.object({ isActive: z.boolean().optional(), role: z.enum(ROLES).optional() }).strict().parse(req.body);
    if (uid === req.user!.id) throw new HttpError(409, 'SELF_MODIFICATION', 'You cannot change your own role or active state');
    if (!get(db, 'SELECT 1 FROM users WHERE id = ?', uid)) throw new HttpError(404, 'NOT_FOUND', 'User not found');
    tx(db, () => {
      if (b.isActive !== undefined) { run(db, 'UPDATE users SET is_active = ? WHERE id = ?', b.isActive ? 1 : 0, uid); if (!b.isActive) run(db, 'DELETE FROM sessions WHERE user_id = ?', uid); }
      if (b.role) { run(db, 'UPDATE users SET role = ? WHERE id = ?', b.role, uid); run(db, 'DELETE FROM sessions WHERE user_id = ?', uid); }
      audit(db, req.user!.id, 'USER_UPDATED', 'user', uid, b);
    });
    res.json({ data: { ok: true } });
  }));

  // Audit log (read-only API; table is also trigger-protected)
  r.get('/audit', requireRole('ADMIN', 'MANAGER'), wrap((req, res) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50), entity: z.string().max(30).optional(), entityId: z.string().max(30).optional() }).parse(req.query);
    const w: string[] = [], p: string[] = [];
    if (q.entity) { w.push('a.entity = ?'); p.push(q.entity); }
    if (q.entityId) { w.push('a.entity_id = ?'); p.push(q.entityId); }
    const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
    const total = get(db, `SELECT COUNT(*) AS n FROM audit_events a ${where}`, ...p)!.n;
    const rows = all(db, `SELECT a.id, a.action, a.entity, a.entity_id AS entityId, a.detail, a.created_at AS createdAt, u.name AS actorName FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...p, q.pageSize, (q.page - 1) * q.pageSize);
    res.json({ data: rows, meta: { page: q.page, pageSize: q.pageSize, total } });
  }));
  return r;
}

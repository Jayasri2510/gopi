import { Router } from 'express';
import { z } from 'zod';
import { all, audit, get, nowIso, run, tx, type DB } from './db.js';
import { HttpError, requireRole, wrap, type AuthUser } from './http.js';
import { ACTIVE_STATUSES, ASSIGNABLE, STATUSES, TRANSITIONS, computePriority, type Status } from './workflow.js';

export interface TicketConfig { reopenWindowDays: number }
const CATEGORIES = ['AC', 'FAN', 'HEATER', 'ELECTRICAL', 'PLUMBING', 'LIGHTING', 'TV', 'GEYSER', 'FURNITURE', 'HOUSEKEEPING', 'OTHER'] as const;
const LEVEL = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const id = z.coerce.number().int().positive();

const T_SELECT = `SELECT t.id, t.ticket_no AS ticketNo, t.subject, t.description, t.category, t.priority, t.impact, t.urgency, t.status,
  t.reporter_id AS reporterId, ru.name AS reporterName, t.location_id AS locationId, l.name AS locationName, t.asset_id AS assetId,
  a.asset_tag AS assetTag, t.assigned_to AS assignedTo, tu.name AS assignedToName, t.room_out_of_service AS roomOutOfService,
  t.guest_impact AS guestImpact, t.resolution_summary AS resolutionSummary, t.version, t.created_at AS createdAt,
  t.updated_at AS updatedAt, t.resolved_at AS resolvedAt, t.closed_at AS closedAt
  FROM tickets t JOIN users ru ON ru.id = t.reporter_id JOIN locations l ON l.id = t.location_id
  LEFT JOIN assets a ON a.id = t.asset_id LEFT JOIN users tu ON tu.id = t.assigned_to`;
const shape = (r: any) => ({ ...r, roomOutOfService: !!r.roomOutOfService, guestImpact: !!r.guestImpact });

/** Resource-level visibility, enforced in every query and lookup. */
function canView(u: AuthUser, t: { reporter_id: number; assigned_to: number | null }) {
  if (['ADMIN', 'MANAGER', 'SUPERVISOR'].includes(u.role)) return true;
  if (u.role === 'STAFF') return t.reporter_id === u.id;
  return t.assigned_to === u.id; // TECHNICIAN
}
const notFound = () => new HttpError(404, 'NOT_FOUND', 'Ticket not found'); // 404 (not 403) so existence is not leaked

function loadRaw(db: DB, u: AuthUser, ticketId: number) {
  const t = get(db, 'SELECT * FROM tickets WHERE id = ?', ticketId);
  if (!t || !canView(u, t)) throw notFound();
  return t;
}
function record(db: DB, t: any, to: Status, actor: AuthUser, reason?: string | null) {
  run(db, 'INSERT INTO ticket_status_history (ticket_id, from_status, to_status, actor_id, reason, created_at) VALUES (?,?,?,?,?,?)', t.id, t.status, to, actor.id, reason ?? null, nowIso());
}

const createSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(5000),
  category: z.enum(CATEGORIES),
  impact: LEVEL, urgency: LEVEL,
  locationId: z.number().int().positive(),
  assetId: z.number().int().positive().optional(),
  roomOutOfService: z.boolean().default(false),
  guestImpact: z.boolean().default(false),
  confirmDuplicate: z.boolean().default(false),
}).strict(); // status, priority, reporterId etc. are rejected, not ignored

export function createTicket(db: DB, u: AuthUser, raw: unknown) {
  const b = createSchema.parse(raw);
  return tx(db, () => {
    if (!get(db, 'SELECT 1 FROM locations WHERE id = ?', b.locationId)) throw new HttpError(422, 'VALIDATION_ERROR', 'Unknown location');
    if (b.assetId && !get(db, 'SELECT 1 FROM assets WHERE id = ? AND location_id = ?', b.assetId, b.locationId))
      throw new HttpError(422, 'VALIDATION_ERROR', 'Asset does not belong to the selected location');
    if (!b.confirmDuplicate) {
      const marks = ACTIVE_STATUSES.map(() => '?').join(',');
      const dups = all(db, `SELECT id, ticket_no AS ticketNo, subject, status FROM tickets WHERE status IN (${marks}) AND location_id = ? AND (? IS NULL OR asset_id = ?)`,
        ...ACTIVE_STATUSES, b.locationId, b.assetId ?? null, b.assetId ?? null);
      if (dups.length) throw new HttpError(409, 'DUPLICATE_WARNING', 'Similar active tickets exist. Resubmit with confirmDuplicate=true to proceed.', dups);
    }
    const now = nowIso(), year = new Date().getUTCFullYear();
    const n = get(db, 'INSERT INTO ticket_counters (year, last) VALUES (?, 1) ON CONFLICT(year) DO UPDATE SET last = last + 1 RETURNING last', year)!.last;
    const no = `HMT-${year}-${String(n).padStart(6, '0')}`;
    const r = run(db, `INSERT INTO tickets (ticket_no, subject, description, category, impact, urgency, priority, status, reporter_id, location_id, asset_id,
      room_out_of_service, guest_impact, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'OPEN', ?,?,?,?,?,?,?)`,
      no, b.subject, b.description, b.category, b.impact, b.urgency, computePriority(b.impact, b.urgency), u.id, b.locationId, b.assetId ?? null,
      b.roomOutOfService ? 1 : 0, b.guestImpact ? 1 : 0, now, now);
    const tid = Number(r.lastInsertRowid);
    run(db, 'INSERT INTO ticket_status_history (ticket_id, from_status, to_status, actor_id, reason, created_at) VALUES (?,NULL,?,?,?,?)', tid, 'OPEN', u.id, 'Ticket created', now);
    audit(db, u.id, 'TICKET_CREATED', 'ticket', tid, { ticketNo: no });
    return get(db, `${T_SELECT} WHERE t.id = ?`, tid)!;
  });
}

const assignSchema = z.object({ technicianId: z.number().int().positive(), reason: z.string().trim().max(500).optional(), expectedVersion: z.number().int().optional() }).strict();
export function assignTicket(db: DB, u: AuthUser, ticketId: number, raw: unknown) {
  const b = assignSchema.parse(raw);
  return tx(db, () => {
    const t = loadRaw(db, u, ticketId);
    if (b.expectedVersion !== undefined && b.expectedVersion !== t.version) throw new HttpError(409, 'VERSION_CONFLICT', 'Ticket was modified by someone else');
    if (!ASSIGNABLE.includes(t.status)) throw new HttpError(409, 'INVALID_TRANSITION', `Cannot assign a ${t.status} ticket`);
    const tech = get(db, "SELECT id, name FROM users WHERE id = ? AND role = 'TECHNICIAN' AND is_active = 1", b.technicianId);
    if (!tech) throw new HttpError(422, 'VALIDATION_ERROR', 'Assignee must be an active technician');
    const now = nowIso(), reassign = t.assigned_to !== null;
    run(db, 'UPDATE ticket_assignments SET is_active = 0 WHERE ticket_id = ? AND is_active = 1', t.id);
    run(db, 'INSERT INTO ticket_assignments (ticket_id, technician_id, assigned_by, created_at) VALUES (?,?,?,?)', t.id, tech.id, u.id, now);
    run(db, "UPDATE tickets SET assigned_to = ?, status = 'ASSIGNED', hold_previous_status = NULL, version = version + 1, updated_at = ? WHERE id = ?", tech.id, now, t.id);
    record(db, t, 'ASSIGNED', u, `${reassign ? 'Reassigned' : 'Assigned'} to ${tech.name}${b.reason ? `: ${b.reason}` : ''}`);
    audit(db, u.id, reassign ? 'TICKET_REASSIGNED' : 'TICKET_ASSIGNED', 'ticket', t.id, { technicianId: tech.id });
    return get(db, `${T_SELECT} WHERE t.id = ?`, t.id)!;
  });
}

const transitionSchema = z.object({
  to: z.enum(STATUSES), reason: z.string().trim().min(1).max(1000).optional(),
  resolutionSummary: z.string().trim().min(10).max(3000).optional(), expectedVersion: z.number().int().optional(),
}).strict();
export function transitionTicket(db: DB, u: AuthUser, ticketId: number, raw: unknown, cfg: TicketConfig) {
  const b = transitionSchema.parse(raw);
  return tx(db, () => {
    const t = loadRaw(db, u, ticketId);
    if (b.expectedVersion !== undefined && b.expectedVersion !== t.version) throw new HttpError(409, 'VERSION_CONFLICT', 'Ticket was modified by someone else');
    if (b.to === 'ASSIGNED') throw new HttpError(400, 'USE_ASSIGN_ENDPOINT', 'Use the assign endpoint to assign or reassign');
    const rule = TRANSITIONS[t.status as Status]?.[b.to];
    if (!rule) throw new HttpError(409, 'INVALID_TRANSITION', `Cannot move ticket from ${t.status} to ${b.to}`);
    if (!rule.roles.includes(u.role)) throw new HttpError(403, 'FORBIDDEN', 'Your role may not perform this transition');
    if (u.role === 'TECHNICIAN' && t.assigned_to !== u.id) throw new HttpError(403, 'FORBIDDEN', 'Ticket is not assigned to you');
    if (u.role === 'STAFF') {
      if (t.reporter_id !== u.id) throw new HttpError(403, 'FORBIDDEN', 'Only the reporter may do this');
      if (b.to === 'REOPENED' && Date.now() - Date.parse(t.resolved_at) > cfg.reopenWindowDays * 86400000)
        throw new HttpError(403, 'REOPEN_WINDOW_EXPIRED', `Tickets can only be reopened by the reporter within ${cfg.reopenWindowDays} days`);
    }
    if (t.status === 'ON_HOLD' && b.to !== t.hold_previous_status) throw new HttpError(409, 'INVALID_TRANSITION', `Work must resume as ${t.hold_previous_status}`);
    if (rule.reason && !b.reason) throw new HttpError(422, 'VALIDATION_ERROR', 'A reason is required for this transition');
    if (b.to === 'RESOLVED') {
      if (!b.resolutionSummary) throw new HttpError(422, 'VALIDATION_ERROR', 'resolutionSummary is required to resolve a ticket');
      if (!get(db, 'SELECT 1 FROM work_logs WHERE ticket_id = ? AND length(trim(diagnosis)) > 0', t.id))
        throw new HttpError(422, 'VALIDATION_ERROR', 'Record at least one work log with a diagnosis before resolving');
    }
    const now = nowIso();
    run(db, `UPDATE tickets SET status = ?, version = version + 1, updated_at = ?,
      hold_previous_status = ?, resolution_summary = COALESCE(?, resolution_summary),
      resolved_at = CASE WHEN ? = 'RESOLVED' THEN ? WHEN ? = 'REOPENED' THEN NULL ELSE resolved_at END,
      closed_at = CASE WHEN ? = 'CLOSED' THEN ? ELSE closed_at END WHERE id = ?`,
      b.to, now, b.to === 'ON_HOLD' ? t.status : null, b.resolutionSummary ?? null, b.to, now, b.to, b.to, now, t.id);
    record(db, t, b.to, u, b.reason ?? b.resolutionSummary);
    audit(db, u.id, `TICKET_${b.to}`, 'ticket', t.id, { from: t.status });
    return get(db, `${T_SELECT} WHERE t.id = ?`, t.id)!;
  });
}

const SORTS: Record<string, string> = { createdAt: 't.created_at', updatedAt: 't.updated_at', priority: "CASE t.priority WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END", status: 't.status', ticketNo: 't.ticket_no' };
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(STATUSES).optional(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(), category: z.enum(CATEGORIES).optional(),
  locationId: id.optional(), assignedTo: id.optional(), q: z.string().trim().max(100).optional(),
  sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).default('createdAt'), dir: z.enum(['asc', 'desc']).default('desc'),
});
export function listTickets(db: DB, u: AuthUser, query: unknown) {
  const f = listSchema.parse(query);
  const w: string[] = [], p: (string | number)[] = [];
  if (u.role === 'STAFF') { w.push('t.reporter_id = ?'); p.push(u.id); }
  if (u.role === 'TECHNICIAN') { w.push('t.assigned_to = ?'); p.push(u.id); }
  for (const [col, v] of [['t.status', f.status], ['t.priority', f.priority], ['t.category', f.category], ['t.location_id', f.locationId], ['t.assigned_to', f.assignedTo]] as const)
    if (v !== undefined) { w.push(`${col} = ?`); p.push(v); }
  if (f.q) { w.push("(t.subject LIKE ? ESCAPE '\\' OR t.ticket_no LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\')"); const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`; p.push(like, like, like); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const total = get(db, `SELECT COUNT(*) AS n FROM tickets t JOIN locations l ON l.id = t.location_id ${where}`, ...p)!.n;
  const rows = all(db, `${T_SELECT} ${where} ORDER BY ${SORTS[f.sort]} ${f.dir === 'asc' ? 'ASC' : 'DESC'}, t.id DESC LIMIT ? OFFSET ?`, ...p, f.pageSize, (f.page - 1) * f.pageSize);
  return { data: rows.map(shape), meta: { page: f.page, pageSize: f.pageSize, total } };
}

export function ticketRouter(db: DB, cfg: TicketConfig) {
  const r = Router();
  r.get('/tickets', wrap((req, res) => { res.json(listTickets(db, req.user!, req.query)); }));
  r.post('/tickets', requireRole('ADMIN', 'MANAGER', 'SUPERVISOR', 'STAFF'), wrap((req, res) => { res.status(201).json({ data: shape(createTicket(db, req.user!, req.body)) }); }));
  r.get('/tickets/:id', wrap((req, res) => {
    const tid = id.parse(req.params.id); loadRaw(db, req.user!, tid);
    res.json({ data: { ...shape(get(db, `${T_SELECT} WHERE t.id = ?`, tid)!),
      history: all(db, 'SELECT h.id, h.from_status AS fromStatus, h.to_status AS toStatus, h.reason, h.created_at AS createdAt, u.name AS actorName FROM ticket_status_history h JOIN users u ON u.id = h.actor_id WHERE h.ticket_id = ? ORDER BY h.id', tid),
      comments: all(db, 'SELECT c.id, c.body, c.created_at AS createdAt, u.name AS authorName FROM comments c JOIN users u ON u.id = c.author_id WHERE c.ticket_id = ? ORDER BY c.id', tid),
      workLogs: all(db, 'SELECT w.id, w.diagnosis, w.notes, w.minutes_spent AS minutesSpent, w.parts_used AS partsUsed, w.created_at AS createdAt, u.name AS technicianName FROM work_logs w JOIN users u ON u.id = w.technician_id WHERE w.ticket_id = ? ORDER BY w.id', tid) } });
  }));
  r.post('/tickets/:id/assign', requireRole('SUPERVISOR', 'ADMIN'), wrap((req, res) => { res.json({ data: shape(assignTicket(db, req.user!, id.parse(req.params.id), req.body)) }); }));
  r.post('/tickets/:id/transition', wrap((req, res) => { res.json({ data: shape(transitionTicket(db, req.user!, id.parse(req.params.id), req.body, cfg)) }); }));
  r.post('/tickets/:id/comments', wrap((req, res) => {
    const tid = id.parse(req.params.id), b = z.object({ body: z.string().trim().min(1).max(2000) }).strict().parse(req.body);
    const t = loadRaw(db, req.user!, tid);
    if (['CLOSED', 'CANCELLED'].includes(t.status)) throw new HttpError(409, 'TICKET_FINAL', 'Cannot comment on a closed or cancelled ticket');
    tx(db, () => { run(db, 'INSERT INTO comments (ticket_id, author_id, body, created_at) VALUES (?,?,?,?)', tid, req.user!.id, b.body, nowIso()); audit(db, req.user!.id, 'COMMENT_ADDED', 'ticket', tid); });
    res.status(201).json({ data: { ok: true } });
  }));
  r.post('/tickets/:id/work-logs', requireRole('TECHNICIAN'), wrap((req, res) => {
    const tid = id.parse(req.params.id);
    const b = z.object({ diagnosis: z.string().trim().min(3).max(2000), notes: z.string().trim().max(3000).optional(), minutesSpent: z.number().int().min(0).max(1440), partsUsed: z.string().trim().max(1000).optional() }).strict().parse(req.body);
    const t = loadRaw(db, req.user!, tid);
    if (t.status !== 'IN_PROGRESS') throw new HttpError(409, 'INVALID_STATE', 'Work logs can only be added while the ticket is IN_PROGRESS');
    tx(db, () => { run(db, 'INSERT INTO work_logs (ticket_id, technician_id, diagnosis, notes, minutes_spent, parts_used, created_at) VALUES (?,?,?,?,?,?,?)', tid, req.user!.id, b.diagnosis, b.notes ?? null, b.minutesSpent, b.partsUsed ?? null, nowIso()); audit(db, req.user!.id, 'WORKLOG_ADDED', 'ticket', tid); });
    res.status(201).json({ data: { ok: true } });
  }));
  return r;
}

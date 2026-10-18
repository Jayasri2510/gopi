import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';
import { createTicket } from '../src/tickets.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { get, login, post, setup, toResolved, validTicket, PW } from './helpers.js';

describe('ticket creation', () => {
  it('generates unique sequential numbers and computes priority server-side', async () => {
    const { app } = setup();
    const c = await login(app, 'reception');
    const a = await post(c, '/api/tickets', validTicket({ locationId: 2 }));
    const b = await post(c, '/api/tickets', validTicket({ locationId: 3 }));
    expect(a.body.data.ticketNo).toMatch(/^HMT-\d{4}-000001$/);
    expect(b.body.data.ticketNo).toMatch(/^HMT-\d{4}-000002$/);
    expect(a.body.data.priority).toBe('HIGH'); expect(a.body.data.status).toBe('OPEN');
    expect(a.body.data.reporterName).toBe('Demo Reception');
  });
  it('rejects client-supplied protected fields', async () => {
    const { app } = setup();
    const c = await login(app, 'reception');
    for (const extra of [{ status: 'CLOSED' }, { priority: 'LOW' }, { reporterId: 1 }, { ticketNo: 'HMT-1' }]) {
      const r = await post(c, '/api/tickets', validTicket(extra));
      expect(r.status).toBe(422);
    }
  });
  it('validates input and asset/location consistency', async () => {
    const { app } = setup();
    const c = await login(app, 'reception');
    expect((await post(c, '/api/tickets', validTicket({ subject: 'x' }))).status).toBe(422);
    expect((await post(c, '/api/tickets', validTicket({ category: 'NOPE' }))).status).toBe(422);
    expect((await post(c, '/api/tickets', validTicket({ locationId: 9999 }))).status).toBe(422);
    expect((await post(c, '/api/tickets', validTicket({ locationId: 2, assetId: 3 }))).status).toBe(422); // asset 3 is in another room
  });
  it('warns on duplicate active tickets and allows explicit confirmation', async () => {
    const { app } = setup();
    const c = await login(app, 'reception');
    await post(c, '/api/tickets', validTicket());
    const dup = await post(c, '/api/tickets', validTicket());
    expect(dup.status).toBe(409); expect(dup.body.error.code).toBe('DUPLICATE_WARNING'); expect(dup.body.error.details).toHaveLength(1);
    expect((await post(c, '/api/tickets', validTicket({ confirmDuplicate: true }))).status).toBe(201);
  });
  it('technicians cannot create tickets', async () => {
    const { app } = setup();
    expect((await post(await login(app, 'tech1'), '/api/tickets', validTicket())).status).toBe(403);
  });
  it('ticket numbers stay unique across two DB connections to the same file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hmt-')), 't.db');
    const a = openDb(file); seedDemo(a, PW); const b = openDb(file);
    const u = { id: 4, email: 'r', name: 'r', role: 'STAFF' as const };
    const nos = new Set<string>();
    for (let i = 0; i < 10; i++) nos.add(createTicket(i % 2 ? a : b, u, { ...validTicket({ locationId: 2 + (i % 4), confirmDuplicate: true }) }).ticketNo);
    expect(nos.size).toBe(10);
  });
});

describe('full workflow', () => {
  it('reporter → supervisor → technician → verify/close, with complete history and audit', async () => {
    const { app } = setup();
    const { staff, sup, tech, id } = await toResolved(app);
    expect((await post(tech, `/api/tickets/${id}/transition`, { to: 'CLOSED' })).status).toBe(403); // technician cannot close
    expect((await post(staff, `/api/tickets/${id}/transition`, { to: 'CLOSED' })).status).toBe(200);
    const d = (await get(sup, `/api/tickets/${id}`)).body.data;
    expect(d.status).toBe('CLOSED'); expect(d.closedAt).toBeTruthy();
    expect(d.history.map((h: any) => h.toStatus)).toEqual(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
    expect(d.workLogs).toHaveLength(1);
    const admin = await login(app, 'admin');
    const audit = (await get(admin, `/api/audit?entity=ticket&entityId=${id}`)).body.data.map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['TICKET_CREATED', 'TICKET_ASSIGNED', 'TICKET_IN_PROGRESS', 'WORKLOG_ADDED', 'TICKET_RESOLVED', 'TICKET_CLOSED']));
  });
  it('reassignment records history and revokes the previous technician’s access', async () => {
    const { app } = setup();
    const { sup, tech, id } = await toResolved(app);
    // reopen so it is assignable again
    const staff = await login(app, 'reception');
    await post(staff, `/api/tickets/${id}/transition`, { to: 'REOPENED', reason: 'Still warm' });
    const t2 = await login(app, 'tech2');
    expect((await post(sup, `/api/tickets/${id}/assign`, { technicianId: t2.id })).status).toBe(200);
    expect((await get(tech, `/api/tickets/${id}`)).status).toBe(404);
    expect((await get(t2, `/api/tickets/${id}`)).status).toBe(200);
  });
  it('supports hold/resume and reopen with reason', async () => {
    const { app } = setup();
    const { staff, tech, sup, id } = await toResolved(app);
    expect((await post(staff, `/api/tickets/${id}/transition`, { to: 'REOPENED' })).status).toBe(422); // reason required
    expect((await post(staff, `/api/tickets/${id}/transition`, { to: 'REOPENED', reason: 'Warm again' })).status).toBe(200);
    expect((await post(tech, `/api/tickets/${id}/transition`, { to: 'IN_PROGRESS' })).status).toBe(200);
    expect((await post(tech, `/api/tickets/${id}/transition`, { to: 'ON_HOLD' })).status).toBe(422);
    expect((await post(tech, `/api/tickets/${id}/transition`, { to: 'ON_HOLD', reason: 'Waiting for part' })).status).toBe(200);
    expect((await post(tech, `/api/tickets/${id}/transition`, { to: 'RESOLVED', resolutionSummary: 'x'.repeat(12) })).status).toBe(409);
    expect((await post(sup, `/api/tickets/${id}/transition`, { to: 'IN_PROGRESS' })).status).toBe(200);
  });
  it('reporter cannot reopen after the policy window', async () => {
    const { app } = setup({ reopenWindowDays: 0 });
    const { staff, id } = await toResolved(app);
    await new Promise(r => setTimeout(r, 5));
    const r = await post(staff, `/api/tickets/${id}/transition`, { to: 'REOPENED', reason: 'late' });
    expect(r.status).toBe(403); expect(r.body.error.code).toBe('REOPEN_WINDOW_EXPIRED');
  });
});

describe('rejections', () => {
  it('rejects invalid transitions with 409', async () => {
    const { app } = setup();
    const staff = await login(app, 'reception'), sup = await login(app, 'supervisor');
    const t = (await post(staff, '/api/tickets', validTicket())).body.data;
    for (const to of ['RESOLVED', 'CLOSED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED']) expect((await post(sup, `/api/tickets/${t.id}/transition`, { to })).status).toBe(409);
    expect((await post(sup, `/api/tickets/${t.id}/transition`, { to: 'ASSIGNED' })).status).toBe(400);
  });
  it('rejects unauthorized assignment and invalid assignees', async () => {
    const { app } = setup();
    const staff = await login(app, 'reception'), sup = await login(app, 'supervisor'), mgr = await login(app, 'manager'), tech = await login(app, 'tech1');
    const t = (await post(staff, '/api/tickets', validTicket())).body.data;
    for (const c of [staff, mgr, tech]) expect((await post(c, `/api/tickets/${t.id}/assign`, { technicianId: tech.id })).status).toBe(403);
    expect((await post(sup, `/api/tickets/${t.id}/assign`, { technicianId: staff.id })).status).toBe(422); // not a technician
  });
  it('staff cannot see others’ tickets; technicians only see assigned ones', async () => {
    const { app } = setup();
    const a = await login(app, 'reception'), b = await login(app, 'housekeeping'), tech = await login(app, 'tech1');
    const t = (await post(a, '/api/tickets', validTicket())).body.data;
    expect((await get(b, `/api/tickets/${t.id}`)).status).toBe(404);
    expect((await get(b, '/api/tickets')).body.meta.total).toBe(0);
    expect((await get(tech, `/api/tickets/${t.id}`)).status).toBe(404);
    expect((await post(b, `/api/tickets/${t.id}/comments`, { body: 'hi' })).status).toBe(404);
  });
  it('unassigned technicians cannot transition or log work; staff cannot cancel after triage', async () => {
    const { app } = setup();
    const { tech, id } = await toResolved(app);
    const t2 = await login(app, 'tech2');
    expect((await post(t2, `/api/tickets/${id}/transition`, { to: 'CLOSED' })).status).toBe(404);
    expect((await post(tech, `/api/tickets/${id}/work-logs`, { diagnosis: 'late', minutesSpent: 5 })).status).toBe(409);
    const staff = await login(app, 'reception'), sup = await login(app, 'supervisor');
    const t = (await post(staff, '/api/tickets', validTicket({ locationId: 5 }))).body.data;
    await post(sup, `/api/tickets/${t.id}/transition`, { to: 'TRIAGED' });
    expect((await post(staff, `/api/tickets/${t.id}/transition`, { to: 'CANCELLED', reason: 'oops' })).status).toBe(403);
  });
  it('cannot resolve without a work log or resolution summary', async () => {
    const { app } = setup();
    const staff = await login(app, 'reception'), sup = await login(app, 'supervisor'), tech = await login(app, 'tech1');
    const t = (await post(staff, '/api/tickets', validTicket())).body.data;
    await post(sup, `/api/tickets/${t.id}/assign`, { technicianId: tech.id });
    await post(tech, `/api/tickets/${t.id}/transition`, { to: 'IN_PROGRESS' });
    expect((await post(tech, `/api/tickets/${t.id}/transition`, { to: 'RESOLVED' })).status).toBe(422);
    expect((await post(tech, `/api/tickets/${t.id}/transition`, { to: 'RESOLVED', resolutionSummary: 'Fixed it properly.' })).status).toBe(422); // no work log yet
  });
  it('detects stale writes via expectedVersion', async () => {
    const { app } = setup();
    const staff = await login(app, 'reception'), sup = await login(app, 'supervisor');
    const t = (await post(staff, '/api/tickets', validTicket())).body.data;
    expect((await post(sup, `/api/tickets/${t.id}/transition`, { to: 'TRIAGED', expectedVersion: 1 })).status).toBe(200);
    const stale = await post(sup, `/api/tickets/${t.id}/transition`, { to: 'CANCELLED', reason: 'dup', expectedVersion: 1 });
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });
  it('audit and history tables are append-only at the database level', () => {
    const { db } = setup();
    db.exec("INSERT INTO audit_events (action, entity, created_at) VALUES ('X','y','2026-01-01')");
    expect(() => db.exec("UPDATE audit_events SET action = 'Z'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM audit_events')).toThrow(/append-only/);
  });
  it('non-admins cannot manage users or read audit', async () => {
    const { app } = setup();
    const sup = await login(app, 'supervisor');
    expect((await post(sup, '/api/users', { email: 'a@b.co', name: 'A', role: 'ADMIN', password: 'long-enough-pw' })).status).toBe(403);
    expect((await get(sup, '/api/audit')).status).toBe(403);
    expect((await get(await login(app, 'reception'), '/api/users')).status).toBe(403);
  });
});

describe('listing', () => {
  it('paginates, filters, searches and sorts on the server', async () => {
    const { app } = setup();
    const staff = await login(app, 'reception'), sup = await login(app, 'supervisor');
    for (let i = 0; i < 5; i++) await post(staff, '/api/tickets', validTicket({ locationId: 1 + i, subject: i === 3 ? 'Leaking geyser' : `Issue ${i}`, urgency: i === 3 ? 'HIGH' : 'LOW', impact: i === 3 ? 'HIGH' : 'LOW', category: i === 3 ? 'GEYSER' : 'AC' }));
    const p1 = (await get(sup, '/api/tickets?pageSize=2&page=1')).body;
    expect(p1.data).toHaveLength(2); expect(p1.meta.total).toBe(5);
    expect((await get(sup, '/api/tickets?q=geyser')).body.meta.total).toBe(1);
    expect((await get(sup, '/api/tickets?priority=CRITICAL')).body.meta.total).toBe(1);
    expect((await get(sup, '/api/tickets?sort=priority&dir=desc')).body.data[0].priority).toBe('CRITICAL');
    expect((await get(sup, '/api/tickets?q=%25')).body.meta.total).toBe(0); // LIKE wildcards are escaped
    expect((await get(sup, '/api/tickets?sort=password_hash')).status).toBe(422); // sort whitelist
  });
});

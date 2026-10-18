import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { login, post, PW, setup, validTicket } from './helpers.js';

describe('authentication', () => {
  it('rejects unauthenticated access', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/tickets')).status).toBe(401);
  });
  it('rejects bad credentials with a generic message', async () => {
    const { app } = setup();
    const a = await request(app).post('/api/auth/login').send({ email: 'reception@demo.test', password: 'nope' });
    const b = await request(app).post('/api/auth/login').send({ email: 'ghost@demo.test', password: 'nope' });
    expect(a.status).toBe(401); expect(b.status).toBe(401); expect(a.body.error.message).toBe(b.body.error.message);
  });
  it('sets an HttpOnly SameSite=Strict cookie and never returns the hash', async () => {
    const { app } = setup();
    const r = await request(app).post('/api/auth/login').send({ email: 'reception@demo.test', password: PW });
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/SameSite=Strict/);
    expect(JSON.stringify(r.body)).not.toMatch(/scrypt|password_hash/);
  });
  it('requires a CSRF token on mutating requests', async () => {
    const { app } = setup();
    const c = await login(app, 'reception');
    expect((await c.agent.post('/api/tickets').send(validTicket())).status).toBe(403);
    expect((await c.agent.post('/api/tickets').set('X-CSRF-Token', 'wrong').send(validTicket())).status).toBe(403);
    expect((await post(c, '/api/tickets', validTicket())).status).toBe(201);
  });
  it('locks the account after 5 failed attempts', async () => {
    const { app } = setup();
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ email: 'tech2@demo.test', password: 'bad' });
    const r = await request(app).post('/api/auth/login').send({ email: 'tech2@demo.test', password: PW });
    expect(r.status).toBe(429); expect(r.body.error.code).toBe('ACCOUNT_LOCKED');
  });
  it('rate-limits the login endpoint', async () => {
    const { app } = setup({ loginRateLimit: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(app).post('/api/auth/login').send({ email: 'x@demo.test', password: 'x' })).status);
    expect(codes).toContain(429);
  });
  it('deactivated users lose access immediately and cannot log in', async () => {
    const { app } = setup();
    const admin = await login(app, 'admin'), staff = await login(app, 'housekeeping');
    expect((await admin.agent.patch(`/api/users/${staff.id}`).set('X-CSRF-Token', admin.csrf).send({ isActive: false })).status).toBe(200);
    expect((await staff.agent.get('/api/tickets')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'housekeeping@demo.test', password: PW })).status).toBe(401);
  });
  it('logout invalidates the session; password change enforces policy', async () => {
    const { app } = setup();
    const c = await login(app, 'reception');
    expect((await post(c, '/api/auth/change-password', { currentPassword: PW, newPassword: 'short' })).status).toBe(422);
    expect((await post(c, '/api/auth/change-password', { currentPassword: 'wrong-password', newPassword: 'A-New-Password-1' })).status).toBe(403);
    await post(c, '/api/auth/logout', {});
    expect((await c.agent.get('/api/auth/me')).status).toBe(401);
  });
});

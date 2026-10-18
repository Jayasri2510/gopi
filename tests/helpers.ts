import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';

export const PW = 'Test-Password-123';
export function setup(cfg = {}) {
  const db = openDb(':memory:');
  seedDemo(db, PW);
  const app = createApp(db, { loginRateLimit: 1000, ...cfg });
  return { db, app };
}
export type Client = { agent: ReturnType<typeof request.agent>; csrf: string; id: number };
export async function login(app: any, who: string, password = PW): Promise<Client> {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').send({ email: `${who}@demo.test`, password });
  if (r.status !== 200) throw new Error(`login failed for ${who}: ${r.status}`);
  return { agent, csrf: r.body.data.csrfToken, id: r.body.data.user.id };
}
export const post = (c: Client, url: string, body: unknown) => c.agent.post(url).set('X-CSRF-Token', c.csrf).send(body as object);
export const get = (c: Client, url: string) => c.agent.get(url);

export const validTicket = (over: Record<string, unknown> = {}) => ({
  subject: 'AC not cooling', description: 'The AC blows warm air since this morning.', category: 'AC',
  impact: 'MEDIUM', urgency: 'HIGH', locationId: 2, ...over,
});
/** Drive a ticket through the whole happy path up to RESOLVED. */
export async function toResolved(app: any) {
  const staff = await login(app, 'reception'), sup = await login(app, 'supervisor'), tech = await login(app, 'tech1');
  const t = (await post(staff, '/api/tickets', validTicket())).body.data;
  await post(sup, `/api/tickets/${t.id}/assign`, { technicianId: tech.id });
  await post(tech, `/api/tickets/${t.id}/transition`, { to: 'IN_PROGRESS' });
  await post(tech, `/api/tickets/${t.id}/work-logs`, { diagnosis: 'Refrigerant low', minutesSpent: 45, partsUsed: 'Refrigerant 1kg' });
  const r = await post(tech, `/api/tickets/${t.id}/transition`, { to: 'RESOLVED', resolutionSummary: 'Recharged refrigerant, tested cooling.' });
  return { staff, sup, tech, ticket: r.body.data, id: t.id as number };
}

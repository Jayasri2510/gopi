import { describe, expect, it } from 'vitest';
import { TRANSITIONS, computePriority, STATUSES } from '../src/workflow.js';

describe('workflow table', () => {
  it('terminal states have no outgoing transitions', () => {
    expect(TRANSITIONS.CLOSED).toBeUndefined();
    expect(TRANSITIONS.CANCELLED).toBeUndefined();
  });
  it('technicians can never close', () => {
    for (const to of Object.values(TRANSITIONS)) expect(to?.CLOSED?.roles ?? []).not.toContain('TECHNICIAN');
  });
  it('ASSIGNED is never a transition target (assign endpoint only)', () => {
    for (const to of Object.values(TRANSITIONS)) expect(Object.keys(to ?? {})).not.toContain('ASSIGNED');
  });
  it('every status is known', () => {
    for (const [from, tos] of Object.entries(TRANSITIONS)) { expect(STATUSES).toContain(from); for (const t of Object.keys(tos!)) expect(STATUSES).toContain(t); }
  });
});
describe('priority rule', () => {
  it.each([['HIGH', 'HIGH', 'CRITICAL'], ['HIGH', 'MEDIUM', 'HIGH'], ['MEDIUM', 'MEDIUM', 'MEDIUM'], ['LOW', 'LOW', 'LOW'], ['LOW', 'HIGH', 'MEDIUM']] as const)(
    '%s impact + %s urgency = %s', (i, u, p) => expect(computePriority(i, u)).toBe(p));
});

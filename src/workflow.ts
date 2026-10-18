import type { Role } from './http.js';
export const STATUSES = ['OPEN', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'CANCELLED', 'REOPENED'] as const;
export type Status = (typeof STATUSES)[number];
export const ACTIVE_STATUSES: Status[] = ['OPEN', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'];
export const ASSIGNABLE: Status[] = ['OPEN', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'];

interface Rule { roles: Role[]; reason?: boolean }
const SUP: Role[] = ['SUPERVISOR', 'ADMIN'];
const WORK: Role[] = ['TECHNICIAN', 'SUPERVISOR', 'ADMIN'];
const VERIFY: Role[] = ['STAFF', 'SUPERVISOR', 'MANAGER', 'ADMIN']; // technicians are deliberately excluded from closing

/** Explicit transition table. ASSIGNED is only reachable through the assign endpoint. */
export const TRANSITIONS: Partial<Record<Status, Partial<Record<Status, Rule>>>> = {
  OPEN: { TRIAGED: { roles: SUP }, CANCELLED: { roles: ['STAFF', ...SUP], reason: true } },
  TRIAGED: { CANCELLED: { roles: SUP, reason: true } },
  ASSIGNED: { IN_PROGRESS: { roles: WORK } },
  IN_PROGRESS: { ON_HOLD: { roles: WORK, reason: true }, RESOLVED: { roles: WORK } },
  ON_HOLD: { IN_PROGRESS: { roles: WORK } },
  RESOLVED: { CLOSED: { roles: VERIFY }, REOPENED: { roles: VERIFY, reason: true } },
  REOPENED: { IN_PROGRESS: { roles: WORK } },
};

type Level = 'LOW' | 'MEDIUM' | 'HIGH';
const N: Record<Level, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
/** Priority rule from impact + urgency (sum 6 → CRITICAL, 5 → HIGH, 3–4 → MEDIUM, 2 → LOW). */
export function computePriority(impact: Level, urgency: Level) {
  const s = N[impact] + N[urgency];
  return s >= 6 ? 'CRITICAL' : s === 5 ? 'HIGH' : s >= 3 ? 'MEDIUM' : 'LOW';
}

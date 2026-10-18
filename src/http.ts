import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
export type Role = 'ADMIN' | 'MANAGER' | 'SUPERVISOR' | 'STAFF' | 'TECHNICIAN';
export interface AuthUser { id: number; email: string; name: string; role: Role }
declare global { namespace Express { interface Request { user?: AuthUser; csrf?: string } } }

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
/** Wrap synchronous handlers (node:sqlite is synchronous) so thrown errors reach the error middleware. */
export const wrap = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response, next: NextFunction) => {
  try { fn(req, res); } catch (e) { next(e); }
};
export const requireRole = (...roles: Role[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Login required'));
  if (!roles.includes(req.user.role)) return next(new HttpError(403, 'FORBIDDEN', 'You do not have permission for this action'));
  next();
};
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  if (err instanceof ZodError) return void res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) } });
  if ((err as any)?.type === 'entity.parse.failed') return void res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  console.error(err); // server log only; never leak internals to the client
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error' } });
}

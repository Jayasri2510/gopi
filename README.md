# Hotel Maintenance Ticket System: Phase 2/3 vertical slice

Node 22 + TypeScript + Express, SQLite (`node:sqlite`, no native build), Zod validation, scrypt password hashing,
server-side sessions with CSRF tokens. Production target: PostgreSQL (see "Not yet implemented").

## Run
```bash
npm install
SEED_PASSWORD='choose-a-demo-password' npm run seed   # demo data only; refuses NODE_ENV=production
npm run dev                                           # http://localhost:3000/api
npm test && npm run typecheck
```
Env: `PORT`, `DATABASE_FILE` (default `./data/hotel.db`), `REOPEN_WINDOW_DAYS` (default 7), `NODE_ENV=production` (Secure cookies).
Migrations in `migrations/*.sql` apply automatically at startup and are recorded in `schema_migrations`.
Demo logins: `admin|manager|supervisor|reception|housekeeping|tech1|tech2@demo.test`.

## API (all under `/api`, JSON; success `{data}`, error `{error:{code,message,details}}`)
- Auth: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password`.
  Mutating requests need the `X-CSRF-Token` header (value returned by login/me) plus the `sid` cookie.
- Reference: `GET /locations`, `GET /assets?locationId=`
- Users: `GET /users` (admin/manager/supervisor), `POST /users`, `PATCH /users/:id` (admin)
- Tickets: `GET /tickets?page&pageSize&status&priority&category&locationId&assignedTo&q&sort&dir`, `POST /tickets`, `GET /tickets/:id`,
  `POST /tickets/:id/assign`, `POST /tickets/:id/transition`, `POST /tickets/:id/comments`, `POST /tickets/:id/work-logs`
- Audit: `GET /audit` (admin/manager)

## Implemented and tested (36 automated tests)
Login/logout, lockout after 5 failures, login rate limit, CSRF, session revocation on deactivation; RBAC with resource-level checks
(staff see own tickets, technicians see assigned tickets); ticket creation with unique `HMT-YYYY-NNNNNN` numbers, server-computed priority,
duplicate warning, strict payload validation; explicit state machine; assignment/reassignment; hold/resume; reopen window; resolution requires
a work log and summary; technicians cannot close; optimistic locking (`expectedVersion`); append-only history and audit (DB triggers);
server-side pagination, filtering, search, whitelisted sorting.

## NOT yet implemented (later phases); do not assume these exist
Frontend UI; password **reset** flow; attachments/photo upload; SLA policies, deadlines, breach tracking and escalation worker;
notifications; reports/CSV export; department scoping; rooms/assets/floors admin CRUD (read-only now); OpenAPI docs;
Docker/PostgreSQL deployment; parts inventory; priority override at triage.

## Known caveats
- `node:sqlite` is marked experimental by Node. Fine for local/dev; use PostgreSQL for production (schema is portable SQL apart from trigger syntax).
- The "two connections" ticket-number test is sequential, not truly parallel. It shows uniqueness across connections, not behavior under load.
- No CORS middleware: the API is same-origin only. Configure explicitly if the frontend is hosted separately.

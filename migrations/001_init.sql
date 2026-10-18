CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','MANAGER','SUPERVISOR','STAFF','TECHNICIAN')),
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE floors (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, level INTEGER NOT NULL);
CREATE TABLE locations (
  id INTEGER PRIMARY KEY,
  floor_id INTEGER NOT NULL REFERENCES floors(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('ROOM','COMMON_AREA')),
  number TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (floor_id, number)
);
CREATE TABLE assets (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  category TEXT NOT NULL,
  asset_tag TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL
);
CREATE INDEX idx_assets_location ON assets(location_id);

CREATE TABLE ticket_counters (year INTEGER PRIMARY KEY, last INTEGER NOT NULL);
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY,
  ticket_no TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('AC','FAN','HEATER','ELECTRICAL','PLUMBING','LIGHTING','TV','GEYSER','FURNITURE','HOUSEKEEPING','OTHER')),
  impact TEXT NOT NULL CHECK (impact IN ('LOW','MEDIUM','HIGH')),
  urgency TEXT NOT NULL CHECK (urgency IN ('LOW','MEDIUM','HIGH')),
  priority TEXT NOT NULL CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL CHECK (status IN ('OPEN','TRIAGED','ASSIGNED','IN_PROGRESS','ON_HOLD','RESOLVED','CLOSED','CANCELLED','REOPENED')),
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
  assigned_to INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  room_out_of_service INTEGER NOT NULL DEFAULT 0,
  guest_impact INTEGER NOT NULL DEFAULT 0,
  hold_previous_status TEXT,
  resolution_summary TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  closed_at TEXT
);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_priority ON tickets(priority);
CREATE INDEX idx_tickets_assigned ON tickets(assigned_to);
CREATE INDEX idx_tickets_location ON tickets(location_id);
CREATE INDEX idx_tickets_reporter ON tickets(reporter_id);
CREATE INDEX idx_tickets_created ON tickets(created_at);

CREATE TABLE ticket_assignments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  technician_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE ticket_status_history (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_history_ticket ON ticket_status_history(ticket_id);
CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_comments_ticket ON comments(ticket_id);
CREATE TABLE work_logs (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  technician_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  diagnosis TEXT NOT NULL,
  notes TEXT,
  minutes_spent INTEGER NOT NULL DEFAULT 0 CHECK (minutes_spent BETWEEN 0 AND 1440),
  parts_used TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_worklogs_ticket ON work_logs(ticket_id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_events(entity, entity_id);

-- Append-only protection for audit and status history.
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER history_no_update BEFORE UPDATE ON ticket_status_history BEGIN SELECT RAISE(ABORT, 'ticket_status_history is append-only'); END;
CREATE TRIGGER history_no_delete BEFORE DELETE ON ticket_status_history BEGIN SELECT RAISE(ABORT, 'ticket_status_history is append-only'); END;

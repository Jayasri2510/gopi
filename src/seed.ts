import { hashPassword } from './auth.js';
import { run, tx, nowIso, type DB } from './db.js';

/** DEMO DATA ONLY: fictional staff, no guest data. Never run against production. */
export function seedDemo(db: DB, password: string) {
  tx(db, () => {
    const h = hashPassword(password), now = nowIso();
    for (const [email, name, role] of [
      ['admin@demo.test', 'Demo Admin', 'ADMIN'], ['manager@demo.test', 'Demo Manager', 'MANAGER'], ['supervisor@demo.test', 'Demo Supervisor', 'SUPERVISOR'],
      ['reception@demo.test', 'Demo Reception', 'STAFF'], ['housekeeping@demo.test', 'Demo Housekeeping', 'STAFF'],
      ['tech1@demo.test', 'Demo Technician One', 'TECHNICIAN'], ['tech2@demo.test', 'Demo Technician Two', 'TECHNICIAN'],
    ]) run(db, 'INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?,?,?,?,?)', email, name, role, h, now);
    for (const lvl of [0, 1, 2]) {
      const f = Number(run(db, 'INSERT INTO floors (name, level) VALUES (?,?)', lvl === 0 ? 'Ground' : `Floor ${lvl}`, lvl).lastInsertRowid);
      const nums = lvl === 0 ? [['LOBBY', 'Lobby', 'COMMON_AREA']] : [[`${lvl}01`, `Room ${lvl}01`, 'ROOM'], [`${lvl}02`, `Room ${lvl}02`, 'ROOM']];
      for (const [num, name, kind] of nums) {
        const l = Number(run(db, 'INSERT INTO locations (floor_id, kind, number, name) VALUES (?,?,?,?)', f, kind, num, name).lastInsertRowid);
        if (kind === 'ROOM') {
          run(db, 'INSERT INTO assets (location_id, category, asset_tag, description) VALUES (?,?,?,?)', l, 'AC', `AC-${num}`, `Split AC unit, ${name}`);
          run(db, 'INSERT INTO assets (location_id, category, asset_tag, description) VALUES (?,?,?,?)', l, 'GEYSER', `GY-${num}`, `Water heater, ${name}`);
        }
      }
    }
  });
}

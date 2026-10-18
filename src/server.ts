import { createApp } from './app.js';
import { openDb } from './db.js';
const db = openDb(process.env.DATABASE_FILE ?? './data/hotel.db');
const secure = process.env.NODE_ENV === 'production';
const app = createApp(db, { secureCookies: secure, reopenWindowDays: Number(process.env.REOPEN_WINDOW_DAYS ?? 7) });
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`API listening on :${port} (secure cookies: ${secure})`));

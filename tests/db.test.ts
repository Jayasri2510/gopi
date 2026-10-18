import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';

const tempRoot = path.resolve(process.cwd(), '.tmp-db-tests');

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('database initialization', () => {
  it('creates the parent directory before opening a file-backed database', () => {
    const file = path.join(tempRoot, 'nested', 'hotel.db');
    const db = openDb(file);
    expect(fs.existsSync(path.dirname(file))).toBe(true);
    expect(() => db.prepare('SELECT 1').get()).not.toThrow();
    db.close();
  });
});

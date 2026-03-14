/**
 * SQLite adapter: uses better-sqlite3 when available (native, fast),
 * falls back to sql.js (pure JS) when better-sqlite3 fails to build
 * (e.g. on Hostinger due to GLIBC/Python constraints).
 */
import fs from 'fs';
import path from 'path';

let useSqlJs = null; // null = not yet determined (avoids top-level await for CJS/lsnode)
async function checkBackend() {
  if (useSqlJs !== null) return useSqlJs;
  try {
    await import('better-sqlite3');
    useSqlJs = false;
  } catch {
    useSqlJs = true;
  }
  return useSqlJs;
}

export async function createDatabase(dbPath) {
  const useSql = await checkBackend();
  if (!useSql) {
    const Database = (await import('better-sqlite3')).default;
    return new Database(dbPath);
  }
  return createSqlJsDatabase(dbPath);
}

function toSqlJsParams(params) {
  if (!params || Object.keys(params).length === 0) return {};
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    out['@' + k] = v;
  }
  return out;
}

async function createSqlJsDatabase(dbPath) {
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  let data = new Uint8Array(0);
  try {
    if (fs.existsSync(dbPath)) {
      data = new Uint8Array(fs.readFileSync(dbPath));
    }
  } catch {}

  const db = new SQL.Database(data);

  function save() {
    try {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dbPath, Buffer.from(db.export()));
    } catch (e) {
      console.warn('sql.js save failed:', e.message);
    }
  }

  return {
    pragma(sql) {
      const s = sql.replace(/^pragma\s+/i, '').split('=').map(x => x.trim());
      if (s.length === 2) {
        db.run(`PRAGMA ${s[0]} = ${s[1]}`);
      }
      if (sql.toLowerCase().includes('journal_mode')) {
        return [{ journal_mode: 'wal' }];
      }
      if (sql.toLowerCase().includes('table_info')) {
        const m = sql.match(/table_info\s*\(\s*['"]?(\w+)['"]?\s*\)/i);
        const table = m ? m[1] : '';
        const r = db.exec(`PRAGMA table_info(${table})`);
        if (!r.length || !r[0].values) return [];
        const cols = r[0].columns;
        return r[0].values.map(v => {
          const o = {};
          cols.forEach((c, i) => o[c] = v[i]);
          return o;
        });
      }
      return [];
    },
    exec(sql) {
      db.run(sql);
      save();
    },
    prepare(sql) {
      return {
        run(params = {}) {
          const stmt = db.prepare(sql);
          stmt.bind(toSqlJsParams(params));
          stmt.step();
          stmt.free();
          save();
          const r = db.exec('SELECT last_insert_rowid() AS id, changes() AS c');
          const id = r[0]?.values?.[0]?.[0] ?? 0;
          const changes = r[0]?.values?.[0]?.[1] ?? 0;
          return { lastInsertRowid: id, changes };
        },
        get(params = {}) {
          const stmt = db.prepare(sql);
          stmt.bind(toSqlJsParams(params));
          if (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row = {};
            cols.forEach((c, i) => row[c] = vals[i]);
            stmt.free();
            return row;
          }
          stmt.free();
          return undefined;
        },
        all(params = {}) {
          const stmt = db.prepare(sql);
          stmt.bind(toSqlJsParams(params));
          const cols = stmt.getColumnNames();
          const rows = [];
          while (stmt.step()) {
            const vals = stmt.get();
            const row = {};
            cols.forEach((c, i) => row[c] = vals[i]);
            rows.push(row);
          }
          stmt.free();
          return rows;
        },
      };
    },
    transaction(fn) {
      db.run('BEGIN TRANSACTION');
      try {
        fn();
        db.run('COMMIT');
        save();
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      }
    },
  };
}

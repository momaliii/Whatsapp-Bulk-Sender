import Database from 'better-sqlite3';

export class AutoReplyManager {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.initialize();
  }

  initialize() {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      create table if not exists autoreplies (
        id integer primary key autoincrement,
        name text not null,
        session_id text, -- null means any
        match_type text not null, -- contains|equals|regex|startsWith|endsWith
        pattern text not null,
        response text,
        media_path text,
        window_start text, -- HH:MM optional
        window_end text,   -- HH:MM optional
        enabled integer not null default 1,
        hits integer not null default 0,
        created_at text not null default (datetime('now')),
        updated_at text
      );
      create index if not exists idx_ar_session on autoreplies(session_id, enabled);
    `);
    this.stmtList = this.db.prepare(`select * from autoreplies order by id desc`);
    this.stmtInsert = this.db.prepare(`insert into autoreplies (name, session_id, match_type, pattern, response, media_path, window_start, window_end, enabled) values (@name, @session_id, @match_type, @pattern, @response, @media_path, @window_start, @window_end, @enabled)`);
    this.stmtUpdate = this.db.prepare(`update autoreplies set name=@name, session_id=@session_id, match_type=@match_type, pattern=@pattern, response=@response, media_path=@media_path, window_start=@window_start, window_end=@window_end, enabled=@enabled, updated_at=datetime('now') where id=@id`);
    this.stmtDelete = this.db.prepare(`delete from autoreplies where id=@id`);
    this.stmtEnabledFor = this.db.prepare(`select * from autoreplies where enabled=1 and (session_id is null or session_id=@session_id) order by id asc`);
    this.stmtIncHit = this.db.prepare(`update autoreplies set hits=hits+1 where id=@id`);
  }

  list() { return this.stmtList.all(); }
  create(rule) { const info = this.stmtInsert.run(rule); return { id: info.lastInsertRowid }; }
  update(id, rule) { this.stmtUpdate.run({ ...rule, id }); return { ok: true }; }
  delete(id) { this.stmtDelete.run({ id }); return { ok: true }; }
  enabledFor(sessionId) { return this.stmtEnabledFor.all({ session_id: sessionId }); }
  incHit(id) { this.stmtIncHit.run({ id }); }
}



import Database from 'better-sqlite3';

export class QueueManager {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.initialize();
  }

  initialize() {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      create table if not exists jobs (
        id integer primary key autoincrement,
        campaign_id text not null,
        session_id text not null,
        phone text not null,
        message text,
        caption text,
        media_path text,
        delay_ms integer not null default 1000,
        start_time text,
        window_start text,
        window_end text,
        retry_max integer default 0,
        retry_base_ms integer default 1000,
        retry_jitter integer default 0,
        throttle_every integer default 0,
        throttle_sleep_sec integer default 0,
        status text not null default 'pending', -- pending|sent|failed
        error text,
        attempts integer not null default 0,
        created_at text not null default (datetime('now')),
        updated_at text
      );
      create index if not exists idx_jobs_status_session on jobs(status, session_id);
      create index if not exists idx_jobs_campaign on jobs(campaign_id);
      create table if not exists campaigns (
        id text primary key,
        meta text,
        created_at text not null default (datetime('now'))
      );
    `);
    this.stmtInsertJob = this.db.prepare(`insert into jobs (
      campaign_id, session_id, phone, message, caption, media_path, delay_ms, start_time, window_start, window_end,
      retry_max, retry_base_ms, retry_jitter, throttle_every, throttle_sleep_sec
    ) values (@campaign_id, @session_id, @phone, @message, @caption, @media_path, @delay_ms, @start_time, @window_start, @window_end,
      @retry_max, @retry_base_ms, @retry_jitter, @throttle_every, @throttle_sleep_sec)`);
    this.stmtNextJob = this.db.prepare(`select * from jobs where status='pending' and session_id=@session_id order by id asc limit 1`);
    this.stmtMark = this.db.prepare(`update jobs set status=@status, error=@error, attempts=attempts+1, updated_at=datetime('now') where id=@id`);
    this.stmtPendingCount = this.db.prepare(`select count(*) as c from jobs where status='pending' and session_id=@session_id`);
    this.stmtInsertCampaign = this.db.prepare(`insert or ignore into campaigns (id, meta) values (@id, @meta)`);
    this.stmtResultsForCampaign = this.db.prepare(`select * from jobs where campaign_id=@id order by id asc`);
    // Cancellation helpers
    this.stmtCancelPendingByCampaign = this.db.prepare(`update jobs set status='failed', error=@error, updated_at=datetime('now') where campaign_id=@campaign_id and status='pending'`);
    this.stmtCancelPendingBySession = this.db.prepare(`update jobs set status='failed', error=@error, updated_at=datetime('now') where session_id=@session_id and status='pending'`);
    this.stmtSessionStats = this.db.prepare(`
      select status, count(*) as c from jobs where session_id=@session_id group by status
    `);
    this.stmtCampaignTotals = this.db.prepare(`
      select campaign_id as id,
             sum(case when status='pending' then 1 else 0 end) as pending,
             sum(case when status='sent' then 1 else 0 end) as sent,
             sum(case when status='failed' then 1 else 0 end) as failed,
             count(*) as total
      from jobs group by campaign_id order by id desc limit @limit offset @offset
    `);
    this.stmtCampaignCreated = this.db.prepare(`select id, created_at from campaigns where id=@id`);
    // insights
    this.stmtSummary = this.db.prepare(`select status, count(*) as c from jobs group by status`);
    this.stmtPerSession = this.db.prepare(`select session_id, status, count(*) as c from jobs group by session_id, status`);
    this.stmtSeries = this.db.prepare(`
      select strftime('%Y-%m-%d %H:00', coalesce(updated_at, created_at), 'localtime') as bucket,
             status, count(*) as c
      from jobs
      where coalesce(updated_at, created_at) >= datetime('now', @window)
      group by bucket, status
      order by bucket asc
    `);
    this.stmtSummaryBySession = this.db.prepare(`select status, count(*) as c from jobs where session_id=@session_id group by status`);
    this.stmtSeriesBySession = this.db.prepare(`
      select strftime('%Y-%m-%d %H:00', coalesce(updated_at, created_at), 'localtime') as bucket,
             status, count(*) as c
      from jobs
      where session_id=@session_id and coalesce(updated_at, created_at) >= datetime('now', @window)
      group by bucket, status
      order by bucket asc
    `);
    this.stmtRecentErrors = this.db.prepare(`
      select datetime(coalesce(updated_at, created_at), 'localtime') as ts, session_id, phone, error
      from jobs
      where status='failed' and coalesce(updated_at, created_at) >= datetime('now', @window)
      order by coalesce(updated_at, created_at) desc
      limit @limit
    `);
    this.stmtRecentErrorsBySession = this.db.prepare(`
      select datetime(coalesce(updated_at, created_at), 'localtime') as ts, session_id, phone, error
      from jobs
      where session_id=@session_id and status='failed' and coalesce(updated_at, created_at) >= datetime('now', @window)
      order by coalesce(updated_at, created_at) desc
      limit @limit
    `);
    // Auto-suggest templates from successful sends
    this.stmtSuccessfulMessages = this.db.prepare(`
      select message, count(*) as usage_count
      from jobs
      where status='sent' and message is not null and message != ''
      group by message
      order by usage_count desc
      limit @limit
    `);
  }

  enqueueCampaign({ id, itemsBySession, common }) {
    const insertMany = this.db.transaction((rows) => {
      for (const row of rows) this.stmtInsertJob.run(row);
    });
    const rows = [];
    for (const [sessionId, items] of Object.entries(itemsBySession)) {
      for (const it of items) {
        rows.push({
          campaign_id: id,
          session_id: sessionId,
          phone: it.phone,
          message: it.message ?? '',
          caption: it.caption ?? null,
          media_path: it.mediaPath ?? null,
          delay_ms: common.delayMs ?? 1000,
          start_time: common.startTime ?? null,
          window_start: common.window?.start ?? null,
          window_end: common.window?.end ?? null,
          retry_max: common.retries?.maxRetries ?? 0,
          retry_base_ms: common.retries?.baseMs ?? 1000,
          retry_jitter: common.retries?.jitterPct ?? 0,
          throttle_every: common.throttle?.messages ?? 0,
          throttle_sleep_sec: common.throttle?.sleepSec ?? 0,
        });
      }
    }
    this.stmtInsertCampaign.run({ id, meta: JSON.stringify(common || {}) });
    insertMany(rows);
    return { inserted: rows.length };
  }

  nextJob(sessionId) {
    return this.stmtNextJob.get({ session_id: sessionId }) || null;
  }

  markJob(id, status, error = null) {
    this.stmtMark.run({ id, status, error });
  }

  pendingCount(sessionId) {
    const row = this.stmtPendingCount.get({ session_id: sessionId });
    return row?.c || 0;
  }

  sessionStats(sessionId) {
    const rows = this.stmtSessionStats.all({ session_id: sessionId });
    const stats = { pending: 0, sent: 0, failed: 0 };
    for (const r of rows) stats[r.status] = r.c;
    return stats;
  }

  listCampaigns(limit = 20, offset = 0) {
    const rows = this.stmtCampaignTotals.all({ limit, offset });
    return rows.map(r => ({
      id: r.id,
      total: r.total,
      pending: r.pending,
      sent: r.sent,
      failed: r.failed,
    }));
  }

  exportCsv(campaignId) {
    const rows = this.stmtResultsForCampaign.all({ id: campaignId });
    const header = ['id','campaign_id','session_id','phone','status','error','attempts','created_at','updated_at'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.id,
        r.campaign_id,
        r.session_id,
        r.phone,
        r.status,
        r.error ? JSON.stringify(r.error).replaceAll('\n',' ') : '',
        r.attempts,
        r.created_at,
        r.updated_at || ''
      ].join(','));
    }
    return lines.join('\n');
  }

  cancelPendingJobs({ campaignId, sessionId, reason = 'cancelled by user' }) {
    if (campaignId) {
      const info = this.stmtCancelPendingByCampaign.run({ campaign_id: campaignId, error: reason });
      return { cancelled: info.changes };
    }
    if (sessionId) {
      const info = this.stmtCancelPendingBySession.run({ session_id: sessionId, error: reason });
      return { cancelled: info.changes };
    }
    return { cancelled: 0 };
  }

  insights(days = 7, sessionId) {
    const summaryRows = sessionId ? this.stmtSummaryBySession.all({ session_id: sessionId }) : this.stmtSummary.all();
    const perSessionRows = this.stmtPerSession.all();
    const window = `-${Math.max(1, parseInt(days||7,10))} days`;
    const seriesRows = sessionId ? this.stmtSeriesBySession.all({ window, session_id: sessionId }) : this.stmtSeries.all({ window });

    const summary = { sent:0, failed:0, pending:0 };
    for (const r of summaryRows) summary[r.status] = r.c;

    const perSessionMap = new Map();
    for (const r of perSessionRows) {
      if (!perSessionMap.has(r.session_id)) perSessionMap.set(r.session_id, { session_id: r.session_id, sent:0, failed:0, pending:0 });
      perSessionMap.get(r.session_id)[r.status] = r.c;
    }

    const seriesMap = new Map();
    for (const r of seriesRows) {
      if (!seriesMap.has(r.bucket)) seriesMap.set(r.bucket, { ts: r.bucket, sent:0, failed:0, pending:0 });
      seriesMap.get(r.bucket)[r.status] = r.c;
    }

    const series = Array.from(seriesMap.values());
    series.sort((a,b)=>a.ts.localeCompare(b.ts));

    return {
      summary,
      perSession: Array.from(perSessionMap.values()),
      series,
    };
  }

  recentErrors(days = 7, limit = 50, sessionId) {
    const window = `-${Math.max(1, parseInt(days||7,10))} days`;
    const rows = sessionId
      ? this.stmtRecentErrorsBySession.all({ window, limit, session_id: sessionId })
      : this.stmtRecentErrors.all({ window, limit });
    return rows.map(r => ({ ts: r.ts, session_id: r.session_id, phone: r.phone, error: r.error }));
  }

  getSuccessfulTemplates(limit = 20) {
    const rows = this.stmtSuccessfulMessages.all({ limit });
    return rows.map(r => ({ message: r.message, usage_count: r.usage_count }));
  }

  deleteCampaign(campaignId) {
    const stmtDeleteJobs = this.db.prepare(`DELETE FROM jobs WHERE campaign_id = @campaign_id`);
    const stmtDeleteCampaign = this.db.prepare(`DELETE FROM campaigns WHERE id = @id`);
    
    const jobResult = stmtDeleteJobs.run({ campaign_id: campaignId });
    const campaignResult = stmtDeleteCampaign.run({ id: campaignId });
    
    return {
      deletedJobs: jobResult.changes,
      deletedCampaigns: campaignResult.changes
    };
  }
}



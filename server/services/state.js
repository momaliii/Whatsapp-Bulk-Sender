export const sessions = new Map(); // id -> { client, isReady, currentCampaign }
// Human takeover overrides: key => `${sessionId}::${chatId}` -> { until: msEpoch, mode: 'all' | 'aiOnly' }
export const humanOverrides = new Map();

export function overrideKey(sessionId, chatId) { return `${sessionId}::${chatId}`; }

export function setHumanOverride(sessionId, chatId, minutes = 15, mode = 'all') {
  try {
    if (!sessionId || !chatId) return;
    const until = Date.now() + Math.max(1, Number(minutes)) * 60 * 1000;
    humanOverrides.set(overrideKey(sessionId, chatId), { until, mode });
  } catch {}
}

export function clearHumanOverride(sessionId, chatId) {
  try { humanOverrides.delete(overrideKey(sessionId, chatId)); } catch {}
}

export function getHumanOverride(sessionId, chatId) {
  try {
    const k = overrideKey(sessionId, chatId);
    const v = humanOverrides.get(k);
    if (!v) return null;
    if (Date.now() > v.until) { humanOverrides.delete(k); return null; }
    return v;
  } catch { return null; }
}

export const workers = new Map(); // id -> { running, paused, messagesSinceThrottle, consecutiveFailures }
export const disconnectRetryCounts = new Map(); // sessionId -> number (for auto-reconnect)
export const extractResults = new Map(); // id -> { createdAt, sessionId, rows: Array<{phone, type, source, chat_title, chat_id, name}>, unique: number }

export const savedFlows = new Map();
export const userTags = new Map(); // phone -> Set of tags
export const flowAnalytics = new Map(); // Track flow execution stats
export const cronJobs = new Map(); // Track cron jobs for flows

export const waitingFlows = new Map(); // phone -> flowState


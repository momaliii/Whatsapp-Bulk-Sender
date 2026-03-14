import express from 'express';
import { queue, autoReply } from '../services/managers.js';
import { sessions, workers } from '../services/state.js';
import { upload } from '../middleware/upload.js';
import { parseCsvFile } from '../utils/csv.js';
import path from 'path';
import { UPLOAD_DIR } from '../config/index.js';
import { sendItem } from '../services/messaging.js';

const router = express.Router();

// List campaigns
router.get('/api/campaigns', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 10));
  const page = Math.max(0, Number(req.query.page) || 0);
  const offset = page * limit;
  const { campaigns, totalCampaigns } = queue.listCampaigns(limit, offset);
  res.json({ campaigns, totalCampaigns, page, limit });
});

// Export campaign results
router.get('/api/campaign/:id/export', (req, res) => {
  const campaignId = req.params.id;
  const csv = queue.exportCsv(campaignId);
  const lines = csv.trim().split('\n');
  if (lines.length <= 1) return res.status(404).json({ error: 'Campaign not found' });
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="${campaignId}.csv"`);
  res.send(csv);
});

// Cancel campaign (pending jobs for session or specific campaign)
router.post('/api/campaign/cancel', (req, res) => {
  const { sessionId, campaignId } = req.body || {};
  if (!sessionId && !campaignId) return res.status(400).json({ error: 'sessionId or campaignId required' });
  const result = queue.cancelPendingJobs({
    sessionId: sessionId || undefined,
    campaignId: campaignId || undefined,
    reason: 'cancelled by user'
  });
  if (sessionId) {
    const state = sessions.get(sessionId);
    if (state) state.currentCampaign = null;
  }
  res.json({ ok: true, cancelled: result.cancelled });
});

// Delete campaign
router.delete('/api/campaign/:id', (req, res) => {
  queue.deleteCampaign(req.params.id);
  res.json({ ok: true });
});

// Start campaign (Upload CSV)
router.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  return res.json({ filename: req.file.filename, url: `/uploads/${req.file.filename}` });
});

// Start Campaign Action
router.post('/api/campaign/start', async (req, res) => {
  try {
    const { sessionId, fileUrl, message, caption, delayMs, startTime, window, retries, throttle, validateNumbers } = req.body;
    
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    if (!fileUrl) return res.status(400).json({ error: 'File URL required' });

    const filePath = path.join(UPLOAD_DIR, path.basename(fileUrl.replace(/^\//, '')));
    
    let records;
    try {
        records = await parseCsvFile(filePath);
    } catch (parseError) {
        return res.status(400).json({ error: 'Failed to parse CSV file: ' + parseError.message });
    }

    if (!records || records.length === 0) {
        return res.status(400).json({ error: 'CSV file is empty or invalid' });
    }

    // Normalize phone numbers
    // Looking for columns like 'phone', 'mobile', 'number'
    const phoneKey = Object.keys(records[0]).find(k => ['phone', 'mobile', 'number', 'whatsapp'].includes(k.toLowerCase()));
    
    if (!phoneKey) {
        return res.status(400).json({ error: 'CSV must contain a phone number column (phone, mobile, number)' });
    }

    const items = records.map(row => ({
        phone: String(row[phoneKey]).replace(/[^0-9]/g, ''),
        ...row // Include other columns for variable replacement
    })).filter(item => item.phone.length >= 10); // Basic length check

    if (items.length === 0) {
        return res.status(400).json({ error: 'No valid phone numbers found in CSV' });
    }

    // Validate numbers if requested
    if (validateNumbers) {
        // This will happen asynchronously in the worker, but we can do a quick check if session is ready
        const state = sessions.get(sessionId);
        if (!state || !state.isReady) {
             return res.status(400).json({ error: 'Session not ready for validation' });
        }
    }

    const campaignId = `cmp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    // Enqueue campaign
    const common = {
        delayMs: Number(delayMs) || 1000,
        startTime,
        window,
        retries,
        throttle,
        validateNumbers
    };

    const itemsBySession = { [sessionId]: items.map(item => ({
        phone: item.phone,
        message: message, // Template message
        caption: caption,
        // We can inject row data into message variables here or let the worker do it
        // Worker expects 'message' to be the template string, and 'item' to have keys for replacement
        // But wait, the current replacement logic uses replaceSystemVars which only does date/time/rand.
        // We need to enhance it for dynamic CSV variables.
        // For now, let's pass the original message and let the worker replace {name}, etc.
        // We need to update worker to replace dynamic vars from item properties.
        ...item // Pass all CSV columns as item properties
    })) };

    queue.enqueueCampaign({ id: campaignId, itemsBySession, common });
    
    // Set current campaign state (simplified, queue handles persistence)
    const state = sessions.get(sessionId);
    if (state) {
        state.currentCampaign = {
            id: campaignId,
            items: itemsBySession[sessionId],
            ...common
        };
        // Trigger worker if not running
        const w = workers.get(sessionId);
        if (!w || !w.running) {
            // Start worker (imported from service logic, but circular dependency might be tricky)
            // Ideally we emit an event or call a manager method. 
            // For now, the worker loop in index.js checks queue.
        }
    }

    res.json({ ok: true, campaignId, count: items.length });

  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Send single message
router.post('/api/send-message', async (req, res) => {
  try {
    const { sessionId, phone, contactId, message, mediaPath, caption } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const target = phone || contactId;
    if (!target) return res.status(400).json({ error: 'phone or contactId required' });
    if (!message && !mediaPath) return res.status(400).json({ error: 'message or mediaPath required' });

    const state = sessions.get(sessionId);
    if (!state || !state.isReady) return res.status(400).json({ error: 'Session not ready' });

    const item = {
      phone: target,
      message: message || '',
      mediaPath: mediaPath || undefined,
      caption: caption || undefined
    };
    await sendItem(state, item, { simulateTyping: false });
    res.json({ ok: true });
  } catch (e) {
    const msg = String(e?.message || e);
    let status = 500;
    let errorCode = 'UNKNOWN_ERROR';
    if (msg.includes('session') && (msg.includes('not ready') || msg.includes('disconnected') || msg.includes('closed'))) {
      status = 503;
      errorCode = 'SESSION_NOT_READY';
    } else if (msg.includes('not registered') || msg.includes('Number not found')) {
      status = 400;
      errorCode = 'NUMBER_NOT_REGISTERED';
    } else if (msg.includes('Phone or chat ID') || msg.includes('required')) {
      status = 400;
      errorCode = 'VALIDATION_ERROR';
    } else if (msg.includes('Media not found') || msg.includes('not found')) {
      status = 404;
      errorCode = 'MEDIA_NOT_FOUND';
    } else if (msg.includes('Rate limit') || msg.includes('Too many messages')) {
      status = 429;
      errorCode = 'RATE_LIMITED';
    } else if (msg.includes('timed out')) {
      status = 504;
      errorCode = 'TIMEOUT';
    }
    res.status(status).json({ error: msg, errorCode });
  }
});

// Queue controls
router.post('/api/queue/pause', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) {
    const w = workers.get(sessionId);
    if (w) w.paused = true;
  } else {
    for (const [, w] of workers.entries()) w.paused = true;
  }
  res.json({ ok: true });
});

router.post('/api/queue/resume', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) {
    const w = workers.get(sessionId);
    if (w) w.paused = false;
  } else {
    for (const [, w] of workers.entries()) w.paused = false;
  }
  res.json({ ok: true });
});

router.get('/api/queue/stats', (_req, res) => {
  const list = Array.from(sessions.entries()).map(([id, st]) => ({
    id,
    ready: st.isReady,
    pending: queue.pendingCount(id),
    stats: queue.sessionStats(id),
    worker: {
      running: Boolean(workers.get(id)?.running),
      paused: Boolean(workers.get(id)?.paused),
    },
  }));
  res.json({ sessions: list });
});

// Auto-reply routes
router.get('/api/auto-reply', (_req, res) => {
  res.json({ rules: autoReply.list() });
});

router.post('/api/auto-reply', (req, res) => {
  const { sessionId, name, match_type, pattern, response, media_path, window_start, window_end, enabled } = req.body;
  if (!name || !pattern) return res.status(400).json({ error: 'Name and pattern required' });
  const rule = {
    session_id: sessionId || null,
    name,
    match_type: match_type || 'contains',
    pattern,
    response: response || '',
    media_path: media_path || null,
    window_start: window_start || null,
    window_end: window_end || null,
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : 1
  };
  const { id } = autoReply.create(rule);
  res.json({ ok: true, id });
});

router.put('/api/auto-reply/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  const existing = autoReply.list().find(r => r.id === id);
  if (!existing) return res.status(404).json({ error: 'Auto-reply rule not found' });
  const changes = req.body;
  const rule = {
    session_id: changes.sessionId !== undefined ? changes.sessionId : (changes.session_id !== undefined ? changes.session_id : existing.session_id),
    name: changes.name !== undefined ? changes.name : existing.name,
    match_type: changes.match_type !== undefined ? changes.match_type : existing.match_type,
    pattern: changes.pattern !== undefined ? changes.pattern : existing.pattern,
    response: changes.response !== undefined ? changes.response : existing.response,
    media_path: changes.media_path !== undefined ? changes.media_path : existing.media_path,
    window_start: changes.window_start !== undefined ? changes.window_start : existing.window_start,
    window_end: changes.window_end !== undefined ? changes.window_end : existing.window_end,
    enabled: changes.enabled !== undefined ? (changes.enabled ? 1 : 0) : existing.enabled
  };
  autoReply.update(id, rule);
  res.json({ ok: true });
});

router.delete('/api/auto-reply/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  autoReply.delete(id);
  res.json({ ok: true });
});

export default router;


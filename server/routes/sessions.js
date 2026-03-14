import express from 'express';
import { sessions, workers } from '../services/state.js';
import { queue } from '../services/managers.js';
import { createClient, ensureSession, triggerReconnect } from '../services/whatsapp.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// List all sessions
router.get('/api/sessions', (_req, res) => {
  const list = Array.from(sessions.entries()).map(([id, st]) => ({
    id,
    ready: st.isReady,
    info: st.client?.info ? {
      wid: st.client.info.wid,
      pushname: st.client.info.pushname,
      platform: st.client.info.platform
    } : null
  }));
  res.json({ sessions: list });
});

// Create a new session
router.post('/api/sessions', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Session ID required' });
  if (sessions.has(id)) return res.status(400).json({ error: 'Session already exists' });
  
  try {
    await createClient(id);
    res.json({ ok: true, message: 'Session created' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Reconnect session
router.post('/api/sessions/:id/reconnect', async (req, res) => {
  const result = await triggerReconnect(req.params.id);
  if (result.started) {
    res.json({ ok: true, message: 'Reconnection started' });
  } else {
    res.status(400).json({ error: result.error || result.reason || 'Failed to start reconnection' });
  }
});

// Session status
router.get('/api/sessions/:id/status', (req, res) => {
  const state = sessions.get(req.params.id);
  if (!state) return res.status(404).json({ error: 'Session not found' });
  res.json({
    id: req.params.id,
    ready: state.isReady,
    info: state.client?.info || null,
    reconnecting: Boolean(state._reconnecting)
  });
});

// Session health
router.get('/api/sessions/:id/health', async (req, res) => {
  const id = req.params.id;
  const state = sessions.get(id);
  if (!state) return res.status(404).json({ error: 'Session not found' });
  const w = workers.get(id);
  const health = {
    id,
    ready: state.isReady,
    connected: false,
    ping: null,
    battery: null,
    worker: w ? { running: w.running, paused: w.paused, cooldownUntil: w.cooldownUntil || null } : null,
    pendingCount: queue.pendingCount(id)
  };
  if (state.client) {
    try {
      const stateStr = await state.client.getState();
      health.connected = (stateStr === 'CONNECTED');
      try { health.battery = await state.client.getBatteryLevel(); } catch {}
      health.ping = 'ok';
    } catch (e) {
      health.error = String(e);
    }
  }
  res.json(health);
});

// Attempt recovery
router.post('/api/sessions/:id/recover', async (req, res) => {
  const id = req.params.id;
  const state = sessions.get(id);
  if (!state) return res.status(404).json({ error: 'Session not found' });
  
  try {
    logger.warn({ sessionId: id }, 'Attempting session recovery...');
    try { await state.client.destroy(); } catch {}
    const newState = await createClient(id);
    res.json({ ok: true, message: 'Recovery initiated' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Diagnostics
router.get('/api/sessions/:id/diagnostics', async (req, res) => {
  const id = req.params.id;
  const state = sessions.get(id);
  if (!state) return res.status(404).json({ error: 'Session not found' });
  
  const diag = {
    id,
    ready: state.isReady,
    worker: workers.get(id) || null,
    hasClient: !!state.client,
    puppeteerConnected: false,
    browserConnected: false
  };
  
  if (state.client && state.client.pupBrowser) {
    diag.puppeteerConnected = state.client.pupBrowser.isConnected();
    try {
      const pages = await state.client.pupBrowser.pages();
      diag.openPages = pages.length;
    } catch (e) {
      diag.browserError = String(e);
    }
  }
  
  res.json(diag);
});

// Cleanup
router.post('/api/sessions/:id/cleanup', async (req, res) => {
  const id = req.params.id;
  const state = sessions.get(id);
  
  try {
    if (state && state.client) {
      try { await state.client.destroy(); } catch {}
    }
    sessions.delete(id);
    const w = workers.get(id);
    if (w) w.running = false;
    workers.delete(id);

    // Resolve actual auth folder (LocalAuth may use session-session-whats-tool-X)
    const authBase = path.resolve('.wwebjs_auth');
    if (fs.existsSync(authBase)) {
      const entries = fs.readdirSync(authBase, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.includes(`whats-tool-${id}`)) {
          try { fs.rmSync(path.join(authBase, e.name), { recursive: true, force: true }); } catch {}
          break;
        }
      }
    }
    
    res.json({ ok: true, message: 'Session cleaned up' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Delete specific session
router.delete('/api/sessions/:id', async (req, res) => {
  const id = req.params.id;
  const state = sessions.get(id);
  if (state) {
    try { await state.client.destroy(); } catch {}
    sessions.delete(id);
  }
  const w = workers.get(id);
  if (w) w.running = false;
  workers.delete(id);
  res.json({ ok: true });
});

// Delete all sessions
router.delete('/api/sessions', async (req, res) => {
  const count = sessions.size;
  for (const [id, state] of sessions) {
    try { await state.client.destroy(); } catch {}
    sessions.delete(id);
    
    // Stop worker if exists
    if (workers.has(id)) {
      const w = workers.get(id);
      if (w) w.running = false;
      workers.delete(id);
    }
  }
  workers.clear();

  // Remove all auth folders so sessions don't come back on restart
  const authBase = path.resolve('.wwebjs_auth');
  if (fs.existsSync(authBase)) {
    const entries = fs.readdirSync(authBase, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name.includes('whats-tool-')) {
        try {
          fs.rmSync(path.join(authBase, e.name), { recursive: true, force: true });
          logger.info({ folder: e.name }, 'Removed auth folder');
        } catch (err) {
          logger.warn({ folder: e.name, err: String(err) }, 'Failed to remove auth folder');
        }
      }
    }
  }
  
  res.json({ ok: true, deletedCount: count });
});

// System-wide session health
router.get('/api/sessions/health', async (req, res) => {
  const stats = {
    total: sessions.size,
    ready: 0,
    details: []
  };
  for (const [id, state] of sessions) {
    if (state.isReady) stats.ready++;
    const w = workers.get(id);
    stats.details.push({
      id,
      ready: state.isReady,
      workerRunning: Boolean(w?.running),
      workerPaused: Boolean(w?.paused),
      pendingCount: queue.pendingCount(id)
    });
  }
  res.json(stats);
});

export default router;


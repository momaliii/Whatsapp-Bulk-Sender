import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { agentMgr } from '../services/managers.js';
import { setHumanOverride, clearHumanOverride, getHumanOverride } from '../services/state.js';
import { ingestDocumentFile } from '../services/ingest.js';
import { upload } from '../middleware/upload.js';
import { UPLOAD_DIR } from '../config/index.js';
import fs from 'fs';
import { isKBFileName } from '../services/ingest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Agent page
router.get('/agent', (req, res) => {
  res.sendFile(path.join(__dirname, '../../client/public/agent.html'));
});

// Settings
router.get('/api/agent/settings', (_req, res) => {
  res.json(agentMgr.getSettings());
});

router.post('/api/agent/settings', (req, res) => {
  const { enabled, prompt, apiKey } = req.body || {};
  res.json(agentMgr.updateSettings({ enabled: Boolean(enabled), prompt: prompt || '', apiKey }));
});

// KB Quality metrics
router.get('/api/kb/quality', (req, res) => {
  const sessionId = req.query.sessionId || 'default';
  res.json(agentMgr.getKBQuality(sessionId));
});

// Docs
router.get('/api/agent/docs', (req, res) => {
  const { sessionId } = req.query || {};
  res.json({ docs: agentMgr.listDocs(sessionId || 'default') });
});

router.post('/api/agent/docs', (req, res) => {
  const { content, sessionId } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  res.json(agentMgr.addDoc(content, null, sessionId || 'default'));
});

router.delete('/api/agent/docs/:id', (req, res) => {
  agentMgr.deleteDoc(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/api/agent/docs/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { sessionId } = req.body || {};
    const filename = req.file.filename;
    const absPath = path.join(UPLOAD_DIR, filename);
    const out = await ingestDocumentFile(absPath, sessionId || 'default');
    res.json({ ...out, filename });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/api/agent/docs/rescan', async (_req, res) => {
  try {
    let total = 0;
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      const absPath = path.join(UPLOAD_DIR, name);
      try {
        if (fs.statSync(absPath).isFile() && isKBFileName(name)) {
          const { added } = await ingestDocumentFile(absPath, 'default');
          if (added > 0) total += added;
        }
      } catch {}
    }
    res.json({ added: total });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Session Prompts
router.get('/api/agent/session-prompts', (_req, res) => { res.json({ prompts: agentMgr.listSessionPrompts() }); });

router.post('/api/agent/session-prompts', (req, res) => {
  const { sessionId, prompt, enabled } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  res.json(agentMgr.upsertSessionPrompt(sessionId, prompt || '', enabled !== false));
});

router.delete('/api/agent/session-prompts/:sessionId', (req, res) => {
  res.json(agentMgr.deleteSessionPrompt(req.params.sessionId));
});

// Human Takeover
router.post('/api/takeover/start', (req, res) => {
  try {
    const { sessionId, chatId, minutes = 15, mode = 'all' } = req.body || {};
    if (!sessionId || !chatId) return res.status(400).json({ error: 'sessionId and chatId required' });
    setHumanOverride(sessionId, chatId, minutes, mode);
    res.json({ ok: true, until: getHumanOverride(sessionId, chatId)?.until || null, mode });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post('/api/takeover/stop', (req, res) => {
  try {
    const { sessionId, chatId } = req.body || {};
    if (!sessionId || !chatId) return res.status(400).json({ error: 'sessionId and chatId required' });
    clearHumanOverride(sessionId, chatId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.get('/api/takeover/status', (req, res) => {
  try {
    const { sessionId, chatId } = req.query || {};
    if (!sessionId || !chatId) return res.status(400).json({ error: 'sessionId and chatId required' });
    const o = getHumanOverride(String(sessionId), String(chatId));
    res.json({ active: Boolean(o), until: o?.until || null, mode: o?.mode || null });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export default router;


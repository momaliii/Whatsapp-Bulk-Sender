import express from 'express';
import { 
  getSheetsClient, 
  readRange as gsReadRange, 
  appendRows as gsAppendRows, 
  updateRange as gsUpdateRange, 
  listSheets as gsListSheets 
} from '../services/sheets.js';
import { credUpload } from '../middleware/upload.js';
import { DATA_DIR } from '../config/index.js';
import fs from 'fs';
import path from 'path';

const router = express.Router();

router.post('/api/google-sheets/read', async (req, res) => {
  try {
    const { spreadsheetId, range } = req.body;
    const data = await gsReadRange({ spreadsheetId, range });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.post('/api/google-sheets/append', async (req, res) => {
  try {
    const { spreadsheetId, range, rows, valueInputOption } = req.body;
    const result = await gsAppendRows({ spreadsheetId, range, rows, valueInputOption });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.post('/api/google-sheets/update', async (req, res) => {
  try {
    const { spreadsheetId, range, values, valueInputOption } = req.body;
    const result = await gsUpdateRange({ spreadsheetId, range, values, valueInputOption });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.get('/api/google-sheets/sheet-titles', async (req, res) => {
  try {
    const { spreadsheetId } = req.query;
    const titles = await gsListSheets(spreadsheetId);
    res.json({ titles });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.get('/api/google-credentials', (req, res) => {
  const p = path.join(DATA_DIR, 'google_service_account.json');
  if (fs.existsSync(p)) {
    res.json({ exists: true });
  } else {
    res.json({ exists: false });
  }
});

router.post('/api/google-credentials', credUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    return res.json({ ok: true, saved: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.delete('/api/google-credentials', (req, res) => {
  try {
    const p = path.join(DATA_DIR, 'google_service_account.json');
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;


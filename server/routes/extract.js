import express from 'express';
import { sessions, extractResults } from '../services/state.js';

const router = express.Router();

router.get('/api/extract/groups', async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || '');
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const state = sessions.get(sessionId);
    if (!state || !state.isReady) return res.status(400).json({ error: 'session not ready' });
    const client = state.client;
    const chats = await client.getChats();
    const groups = [];
    for (const chat of chats) {
      try {
        if (!chat?.isGroup) continue;
        const jid = chat?.id?._serialized || '';
        if (!jid) continue;
        const parts = chat?.groupMetadata?.participants;
        const participants = (Array.isArray(parts) ? parts : Array.from(parts || [])).length;
        
        groups.push({
          id: jid,
          name: chat.name || 'Unknown Group',
          participants
        });
      } catch {}
    }
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

function normalizePhone(p) { return String(p || '').replace(/[^0-9]/g, ''); }
function addNum(set, p) { const n = normalizePhone(p); if (n && n.length >= 6) set.add(n); }

router.post('/api/extract/scan', async (req, res) => {
  const { sessionId, groupIds, limitPerGroup } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const state = sessions.get(sessionId);
  if (!state || !state.isReady) return res.status(400).json({ error: 'session not ready' });

  const client = state.client;
  const collected = []; // Array<{ phone, type, source, chat_title, chat_id, name }>
  const phonesSeen = new Set();
  const targetGroups = Array.isArray(groupIds) ? groupIds : [];
  
  // If no groups selected, scan all chats
  const scanAll = targetGroups.length === 0;

  try {
    const chats = await client.getChats();
    for (const chat of chats) {
      const chatId = chat?.id?._serialized;
      if (!chatId) continue;

      if (!scanAll) {
        // Filter by selected groups
        if (!targetGroups.includes(chatId)) continue;
      }

      // Extract from participants if group
      if (chat.isGroup) {
        try {
          // Force refresh metadata?
          // chat.groupMetadata might be stale or null if not fetched.
          // There isn't a direct "fetchGroupMetadata" on Chat object in all versions, 
          // but usually accessing participants triggers it or it's already there.
          // WWebJS sometimes requires `chat.fetchMessages` or `client.getChatById` to ensure metadata.
          // We'll rely on what's available.
          const parts = chat.groupMetadata?.participants || [];
          for (const p of parts) {
            const num = p?.id?.user;
            if (!num) continue;
            if (!phonesSeen.has(num)) {
              phonesSeen.add(num);
              collected.push({
                phone: num,
                type: 'group_member',
                source: 'group',
                chat_title: chat.name,
                chat_id: chatId,
                name: '' // we could fetch contact name but expensive
              });
            }
          }
        } catch {}
      } else {
        // 1-on-1 chat
        const num = chat?.id?.user;
        if (!num) continue;
        if (!phonesSeen.has(num)) {
            phonesSeen.add(num);
            collected.push({
                phone: num,
                type: 'chat_contact',
                source: 'direct',
                chat_title: chat.name,
                chat_id: chatId,
                name: chat.name
            });
        }
      }
      
      if (scanAll && collected.length > 10000) break; // Safety limit for scan all
    }

    const id = `ext_${Date.now()}`;
    extractResults.set(id, {
      createdAt: new Date(),
      sessionId,
      rows: collected,
      unique: phonesSeen.size
    });

    res.json({ ok: true, id, count: collected.length, unique: phonesSeen.size });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.get('/api/extract/result/:id', (req, res) => {
  const r = extractResults.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

router.get('/api/extract/export/:id.csv', (req, res) => {
  const r = extractResults.get(req.params.id.replace('.csv',''));
  if (!r) return res.status(404).send('Not found');
  
  const header = ['phone','type','source','chat_title','chat_id','name'];
  const lines = [header.join(',')];
  for (const row of r.rows) {
    lines.push([
      row.phone,
      row.type,
      row.source,
      `"${(row.chat_title||'').replace(/"/g,'""')}"`,
      row.chat_id,
      `"${(row.name||'').replace(/"/g,'""')}"`
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="extract-${req.params.id}"`);
  res.send(lines.join('\n'));
});

export default router;


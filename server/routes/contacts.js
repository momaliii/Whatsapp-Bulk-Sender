import express from 'express';
import { sessions, userTags } from '../services/state.js';
import { queue } from '../services/managers.js';
import { saveUserTagsToFile } from '../services/persistence.js';

const router = express.Router();

// Get sent messages for session (from campaign queue)
router.get('/api/sent-messages/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const limit = Math.min(Number(req.query.limit) || 1000, 5000);
  const state = sessions.get(sessionId);
  if (!state) return res.status(404).json({ error: 'Session not found' });
  const rows = queue.getRecentSentBySession(sessionId, limit);
  const messages = rows.map(r => ({
    id: String(r.id),
    phone: r.phone,
    message: r.message,
    status: r.status,
    sentAt: r.updated_at || r.created_at,
    campaignId: r.campaign_id
  }));
  res.json({ messages });
});

// List contacts (chats)
router.get('/api/contacts/:sessionId', async (req, res) => {
  const state = sessions.get(req.params.sessionId);
  if (!state || !state.isReady) return res.status(404).json({ error: 'Session not ready' });
  try {
    const chats = await state.client.getChats();
    const contacts = chats
      .filter(c => c?.id?._serialized)
      .map(c => ({
        id: c.id._serialized,
        name: c.name,
        isGroup: c.isGroup,
        unreadCount: c.unreadCount,
        timestamp: c.timestamp
      }));
    res.json({ contacts });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get Chats
router.get('/api/chats/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const state = sessions.get(sessionId);
  if (!state || !state.isReady) return res.status(400).json({ error: 'session not ready' });

  try {
    const chats = await state.client.getChats();
    const enriched = chats
      .filter(c => c?.id?._serialized)
      .map(c => {
        const phone = c.id?.user ?? c.id?._serialized ?? '';
        const tags = userTags.has(phone) ? Array.from(userTags.get(phone)) : [];
        return {
          id: c.id._serialized,
          name: c.name || phone,
          isGroup: c.isGroup,
          unreadCount: c.unreadCount,
          timestamp: c.timestamp,
          lastMessage: c.lastMessage ? {
            body: c.lastMessage.body,
            timestamp: c.lastMessage.timestamp,
            fromMe: c.lastMessage.fromMe,
            type: c.lastMessage.type
          } : null,
          tags
        };
      });
    
    // Sort by timestamp desc
    enriched.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    res.json({ chats: enriched });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get messages for a chat
router.get('/api/messages/:sessionId/:contactId', async (req, res) => {
  const { sessionId, contactId } = req.params;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  
  const state = sessions.get(sessionId);
  if (!state || !state.isReady) return res.status(400).json({ error: 'session not ready' });

  try {
    const chat = await state.client.getChatById(contactId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const messages = await chat.fetchMessages({ limit });
    const cleanMessages = messages
      .filter(m => m?.id?._serialized)
      .map(m => ({
        id: m.id._serialized,
        body: m.body,
        fromMe: m.fromMe,
        timestamp: m.timestamp,
        type: m.type,
        hasMedia: m.hasMedia,
        from: m.from,
        to: m.to,
        ack: m.ack
      }));
    res.json({ messages: cleanMessages });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get all user tags
router.get('/api/user-tags', (req, res) => {
  const obj = {};
  for (const [k, v] of userTags) obj[k] = Array.from(v);
  res.json(obj);
});

// Add/Remove tags
router.post('/api/user-tags', (req, res) => {
  const { phone, tags, action } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  
  if (!userTags.has(phone)) userTags.set(phone, new Set());
  const set = userTags.get(phone);
  
  if (Array.isArray(tags)) {
    if (action === 'remove') {
      tags.forEach(t => set.delete(t));
    } else {
      tags.forEach(t => set.add(t));
    }
  }
  
  saveUserTagsToFile();
  res.json({ ok: true, tags: Array.from(set) });
});

export default router;


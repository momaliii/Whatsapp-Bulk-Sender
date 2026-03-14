import wweb from 'whatsapp-web.js';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { CHROME_EXEC_PATH, UPLOAD_DIR, AUTO_RECONNECT_ON_DISCONNECT } from '../config/index.js';
import { sessions, workers, disconnectRetryCounts, setHumanOverride, getHumanOverride } from './state.js';
import { getIO, getRoom } from './socket.js';
import { logger } from '../utils/logger.js';
import { autoReply, agentMgr, queue } from './managers.js';
import { checkFlowTriggers } from './flows.js';
import { startWorker } from './worker.js';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

const { Client, LocalAuth, MessageMedia } = wweb;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const createLocks = new Map();

export async function createClient(sessionId) {
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    if (!existing.client) return existing; // Should not happen normally
    if (existing._authPollInterval) {
      clearInterval(existing._authPollInterval);
      existing._authPollInterval = null;
    }
    try { await existing.client.destroy(); } catch {}
    sessions.delete(sessionId);
  }

  const io = getIO();
  const authPath = path.resolve('./.wwebjs_auth'); // Use project root relative
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `session-whats-tool-${sessionId}`, dataPath: authPath }),
    puppeteer: {
      headless: true,
      executablePath: CHROME_EXEC_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu']
    }
  });

  const state = { client, isReady: false, currentCampaign: null };
  sessions.set(sessionId, state);

  async function markReady(reason) {
    if (state.isReady) return;
    state.isReady = true;
    disconnectRetryCounts.delete(sessionId);
    logger.info({ sessionId, reason }, 'Client marked ready');

    let info = {};
    try {
      info = await getProfileInfo(client);
    } catch (e) {
      logger.warn({ sessionId, err: String(e) }, 'getProfileInfo failed');
    }

    io.to(getRoom(sessionId)).emit('wa_ready', { sessionId, ready: true, ...info });
    io.to(getRoom(sessionId)).emit('wa_profile', { sessionId, ...info });

    // Start worker for this session
    startWorker(sessionId);
  }

  client.on('qr', async (qr) => {
    logger.info({ sessionId }, 'QR code received');
    let qrDataUrl = null;
    try {
      // Generate a PNG data URL so the frontend can render QR without relying on CDN JS.
      qrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 });
    } catch (e) {
      logger.warn({ sessionId, err: String(e) }, 'QR toDataURL failed, frontend will use raw qr');
    }
    io.to(getRoom(sessionId)).emit('wa_qr', { sessionId, qr, qrDataUrl });
  });

  client.on('ready', async () => {
    logger.info({ sessionId }, 'Client is ready');
    await markReady('ready_event');
  });

  client.on('authenticated', () => {
    logger.info({ sessionId }, 'Client authenticated');
    io.to(getRoom(sessionId)).emit('wa_auth', { sessionId, status: 'authenticated' });

    // In some environments, `ready`/change_state` may not fire reliably.
    // After auth, poll for CONNECTED and then mark ready.
    try {
      let attempts = 0;
      const maxAttempts = 20; // ~40s
      const iv = setInterval(async () => {
        attempts += 1;
        if (state.isReady || attempts > maxAttempts) {
          clearInterval(iv);
          state._authPollInterval = null;
          return;
        }
        try {
          if (!client.pupBrowser?.isConnected?.()) return;
          const st = await client.getState();
          if (st === 'CONNECTED') {
            clearInterval(iv);
            state._authPollInterval = null;
            await markReady('post_auth_state_CONNECTED');
          }
        } catch (e) {
          logger.debug({ sessionId, err: String(e) }, 'Auth poll getState failed');
        }
      }, 2000);
      state._authPollInterval = iv;
    } catch {}
  });

  client.on('auth_failure', (msg) => {
    logger.error({ sessionId, msg }, 'Auth failure');
    io.to(getRoom(sessionId)).emit('wa_auth', { sessionId, status: 'failure', message: msg });
  });

  client.on('loading_screen', (percent, message) => {
    io.to(getRoom(sessionId)).emit('wa_loading', { sessionId, percent, message });
  });

  client.on('change_state', async (newState) => {
    io.to(getRoom(sessionId)).emit('wa_state', { sessionId, state: newState });
    // Some environments never emit the `ready` event reliably; treat CONNECTED as ready.
    try {
      const s = String(newState || '').toUpperCase();
      if (s === 'CONNECTED') {
        await markReady('change_state_CONNECTED');
      }
    } catch {}
  });

  client.on('disconnected', async (reason) => {
    state.isReady = false;
    if (state._authPollInterval) {
      clearInterval(state._authPollInterval);
      state._authPollInterval = null;
    }
    logger.warn({ sessionId, reason }, 'Client disconnected');
    io.to(getRoom(sessionId)).emit('wa_disconnected', { sessionId, reason });
    const w = workers.get(sessionId);
    if (w) w.running = false;
    workers.delete(sessionId);
    const retries = (disconnectRetryCounts.get(sessionId) || 0) + 1;
    disconnectRetryCounts.set(sessionId, retries);
    if (AUTO_RECONNECT_ON_DISCONNECT && retries <= 3) {
      logger.info({ sessionId, attempt: retries }, 'Auto-reconnecting after disconnect');
      try { await client.destroy(); } catch {}
      try {
        await triggerReconnect(sessionId);
      } catch (e) {
        logger.error({ sessionId, err: String(e) }, 'Auto-reconnect failed');
        sessions.delete(sessionId);
        disconnectRetryCounts.delete(sessionId);
      }
    } else {
      if (retries > 3) disconnectRetryCounts.delete(sessionId);
      try { await client.destroy(); } catch {}
      sessions.delete(sessionId);
    }
  });

  client.on('message', async (msg) => {
    try {
      if (msg.fromMe) {
        try { setHumanOverride(sessionId, msg.to || msg.from, 15, 'all'); } catch {}
        return;
      }

      const text = (msg.body || '').trim();
      const chatId = msg.from;
      
      try {
        io.to(getRoom(sessionId)).emit('chat_message', {
          sessionId,
          chatId: chatId,
          message: {
            id: msg?.id?._serialized || null,
            body: msg.body || '',
            from: msg.from,
            to: msg.to,
            fromMe: false,
            timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
            type: msg.type,
            hasMedia: !!msg.hasMedia
          }
        });
      } catch {}
      
      // Typing indicator logic
      try { 
          io.to(getRoom(sessionId)).emit('typing', { sessionId, chatId, typing: true }); 
          setTimeout(()=>{ try { io.to(getRoom(sessionId)).emit('typing', { sessionId, chatId, typing: false }); } catch {} }, 2000); 
      } catch {}

      const takeover = getHumanOverride(sessionId, chatId);
      if (takeover && takeover.mode === 'all') {
        logger.info({ sessionId, chatId, mode: takeover.mode }, 'Human takeover active: suppressing automation');
        return;
      }
      
      // Check flow triggers
      const flowHandled = await checkFlowTriggers(msg, sessionId, state);
      if (flowHandled) {
        return;
      }

      // Auto-reply logic
      const rules = autoReply.enabledFor(sessionId);
      const nowMin = new Date().getHours()*60 + new Date().getMinutes();
      let handled = false;

      const parseMin = (t) => {
        if (!t) return null; const [h,m] = String(t).split(':').map(Number); if (Number.isNaN(h)||Number.isNaN(m)) return null; return h*60+m;
      };

      for (const r of rules) {
        const st = parseMin(r.window_start); const en = parseMin(r.window_end);
        if (st!=null && en!=null) {
          const inWin = st<=en ? (nowMin>=st && nowMin<=en) : (nowMin>=st || nowMin<=en);
          if (!inWin) continue;
        }
        let matched = false;
        const pat = r.pattern || '';
        switch (r.match_type) {
          case 'equals': matched = text.toLowerCase() === pat.toLowerCase(); break;
          case 'startsWith': matched = text.toLowerCase().startsWith(pat.toLowerCase()); break;
          case 'endsWith': matched = text.toLowerCase().endsWith(pat.toLowerCase()); break;
          case 'regex':
            try { const re = new RegExp(pat, 'i'); matched = re.test(text); } catch {}
            break;
          default: matched = text.toLowerCase().includes(pat.toLowerCase());
        }
        if (!matched) continue;

        if (r.media_path) {
          const absPath = path.isAbsolute(r.media_path) ? r.media_path : path.join(UPLOAD_DIR, r.media_path);
          if (fs.existsSync(absPath)) {
            const mimeType = mime.lookup(absPath) || 'application/octet-stream';
            const base64 = fs.readFileSync(absPath, { encoding: 'base64' });
            const filename = path.basename(absPath);
            const media = new MessageMedia(mimeType, base64, filename);
            await client.sendMessage(chatId, media, { caption: r.response || undefined });
          } else {
            await client.sendMessage(chatId, r.response || '');
          }
        } else {
          await client.sendMessage(chatId, r.response || '');
        }
        autoReply.incHit(r.id);
        handled = true; break; 
      }

      if (!handled) {
        if (takeover && (takeover.mode === 'aiOnly' || takeover.mode === 'AI' || takeover.mode === 'ai')) {
          return;
        }
        // AI Agent
        let history = [];
        try {
          const chat = await msg.getChat();
          if (chat && typeof chat.fetchMessages === 'function') {
            const msgs = await chat.fetchMessages({ limit: 25 });
            history = msgs
              .filter(m => typeof m.body === 'string' && m.body.trim().length)
              .map(m => ({ fromMe: m.fromMe, body: m.body.trim() }));
          }
        } catch {}
        const reply = await agentMgr.generateReply(text, { sessionId, history });
        if (reply) {
          try { await client.sendMessage(msg.from, reply); } catch {}
        }
      }
    } catch (err) {
      logger.error({ sessionId, err: String(err) }, 'Auto-reply error');
    }
  });

  client.on('message_create', async (msg) => {
    try {
      if (!msg.fromMe) return;
      const chatId = msg.to || msg.from;
      io.to(getRoom(sessionId)).emit('chat_message', {
        sessionId,
        chatId: chatId,
        message: {
          id: msg?.id?._serialized || null,
          body: msg.body || '',
          from: msg.from,
          to: msg.to,
          fromMe: true,
          timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
          type: msg.type,
          hasMedia: !!msg.hasMedia
        }
      });
    } catch (e) {}
  });

  client.on('message_ack', (msg, ack) => {
    try {
      const chatId = msg.to || msg.from;
      
      // Map ACK status
      let status = 'unknown';
      if (ack === 1) status = 'sent';
      else if (ack === 2) status = 'delivered';
      else if (ack === 3) status = 'read';
      
      // Update job status if we have a message ID
      if (msg.id && msg.id._serialized && status !== 'unknown') {
        queue.updateJobStatusByMessageId(msg.id._serialized, status);
      }

      io.to(getRoom(sessionId)).emit('message_ack', {
        sessionId,
        chatId,
        id: msg?.id?._serialized || null,
        ack,
        status
      });
    } catch (e) {}
  });

  const maxInitRetries = 3;
  const isContextDestroyed = (err) => String(err).includes('Execution context was destroyed');
  for (let attempt = 1; attempt <= maxInitRetries; attempt++) {
    try {
      await client.initialize();
      break;
    } catch (e) {
      if (attempt < maxInitRetries && isContextDestroyed(e)) {
        logger.warn({ sessionId, attempt }, 'Init failed (context destroyed), retrying...');
        try { await client.destroy(); } catch {}
        sessions.delete(sessionId);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        return await createClient(sessionId);
      }
      logger.error({ sessionId, error: String(e) }, 'Failed to initialize client');
      sessions.delete(sessionId);
      throw e;
    }
  }

  return state;
}

export async function ensureSession(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  let lock = createLocks.get(sessionId);
  if (!lock) {
    lock = createClient(sessionId);
    createLocks.set(sessionId, lock);
  }
  try {
    const state = await lock;
    return state;
  } finally {
    if (createLocks.get(sessionId) === lock) createLocks.delete(sessionId);
  }
}

export async function triggerReconnect(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) return { started: false, reason: 'no_state' };
  if (state._reconnecting) return { started: false, reason: 'already_reconnecting' };
  state._reconnecting = true;
  try {
    if (state._authPollInterval) {
      clearInterval(state._authPollInterval);
      state._authPollInterval = null;
    }
    try { await state.client.destroy(); } catch {}
    const newState = await createClient(sessionId);
    return { started: true };
  } catch (e) {
    logger.error({ sessionId, error: String(e) }, 'triggerReconnect failed');
    return { started: false, error: String(e) };
  } finally {
    const currentState = sessions.get(sessionId);
    if (currentState) currentState._reconnecting = false;
  }
}

export function safeGetClientNumber(client) {
  try {
    const wid = client?.info?.wid;
    if (!wid) return null;
    if (typeof wid.user === 'string' && wid.user) return wid.user;
    const ser = wid._serialized || '';
    if (ser) return String(ser).replace(/@c\.us$/, '');
  } catch {}
  return null;
}

export async function getProfileInfo(client) {
  const number = safeGetClientNumber(client);
  const pushName = client?.info?.pushname || null;
  let profilePicUrl = null;
  try {
    const wid = client?.info?.wid?._serialized;
    if (wid) profilePicUrl = await client.getProfilePicUrl(wid);
  } catch {}
  return { number, pushName, profilePicUrl };
}


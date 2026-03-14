// Force Cairo timezone for server-side localtime operations
process.env.TZ = 'Africa/Cairo';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
// PDF and Word document parsing (loaded dynamically to avoid startup issues)
let pdfParse = null;
let mammoth = null;
import pino from 'pino';
import pretty from 'pino-pretty';
import mime from 'mime-types';
import qrcode from 'qrcode-terminal';
import wweb from 'whatsapp-web.js';
import { QueueManager } from './queue.js';
import { AutoReplyManager } from './autoreply.js';
import { AgentManager } from './agent.js';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { readRange as gsReadRange, appendRows as gsAppendRows, updateRange as gsUpdateRange, listSheets as gsListSheets, getSavedCredentialsInfo } from './sheets.js';
const { Client, LocalAuth, MessageMedia } = wweb;

// ES module equivalent of __dirname
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino(pretty({ translateTime: 'SYS:standard', ignore: 'pid,hostname' }));

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.resolve('./uploads');
const DATA_DIR = path.resolve('./data');
// Resolve an installed Chrome/Chromium executable for Puppeteer to use
function resolveChromeExecutable() {
  try {
    const fromEnv = process.env.CHROME_PATH;
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  } catch {}
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}
const CHROME_EXEC_PATH = resolveChromeExecutable();
if (CHROME_EXEC_PATH) {
  try { logger.info({ chromePath: CHROME_EXEC_PATH }, 'Using system Chrome for Puppeteer'); } catch {}
} else {
  try { logger.warn('No system Chrome found. Puppeteer will try its bundled Chromium if available.'); } catch {}
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const TPL_FILE = path.join(DATA_DIR, 'templates.json');
if (!fs.existsSync(TPL_FILE)) fs.writeFileSync(TPL_FILE, '[]');
const DB_FILE = path.join(DATA_DIR, 'queue.db');
const queue = new QueueManager(DB_FILE);
const AR_DB = path.join(DATA_DIR, 'autoreply.db');
const autoReply = new AutoReplyManager(AR_DB);
const AGENT_DB = path.join(DATA_DIR, 'agent.db');
const agentMgr = new AgentManager(AGENT_DB);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/public', express.static(path.join(__dirname, '../client/public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// Ensure AI Agent is enabled by default, preserving existing prompt/API key
try {
  const cur = agentMgr.getSettings();
  if (!cur.enabled) agentMgr.updateSettings({ enabled: true, prompt: cur.prompt });
} catch {}

// Admin page route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/admin.html'));
});

// Agent page route
app.get('/agent', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/agent.html'));
});

// KB Quality page route
app.get('/kb-quality', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/kb-quality.html'));
});
// Moderator dashboard route
app.get('/moderator', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/moderator.html'));
});
// Templates store
function loadTemplates() {
  try {
    const raw = fs.readFileSync(TPL_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveTemplates(list) {
  try { fs.writeFileSync(TPL_FILE, JSON.stringify(list, null, 2)); } catch {}
}


// Multer storage
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const name = `${Date.now()}_${base}${ext}`;
    cb(null, name);
  },
});
const upload = multer({ storage });

// Document upload storage for AI prompt analysis
const documentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${timestamp}_${cleanName}`);
  },
});

const documentUpload = multer({ 
  storage: documentStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'text/plain',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only TXT, PDF, DOC, and DOCX files are allowed.'));
    }
  }
});

// Multi-session management
const sessions = new Map(); // id -> { client, isReady, currentCampaign }
// Human takeover overrides: key => `${sessionId}::${chatId}` -> { until: msEpoch, mode: 'all' | 'aiOnly' }
const humanOverrides = new Map();

function overrideKey(sessionId, chatId) { return `${sessionId}::${chatId}`; }
function setHumanOverride(sessionId, chatId, minutes = 15, mode = 'all') {
  try {
    if (!sessionId || !chatId) return;
    const until = Date.now() + Math.max(1, Number(minutes)) * 60 * 1000;
    humanOverrides.set(overrideKey(sessionId, chatId), { until, mode });
  } catch {}
}
function clearHumanOverride(sessionId, chatId) {
  try { humanOverrides.delete(overrideKey(sessionId, chatId)); } catch {}
}
function getHumanOverride(sessionId, chatId) {
  try {
    const k = overrideKey(sessionId, chatId);
    const v = humanOverrides.get(k);
    if (!v) return null;
    if (Date.now() > v.until) { humanOverrides.delete(k); return null; }
    return v;
  } catch { return null; }
}
const workers = new Map(); // id -> { running, paused, messagesSinceThrottle, consecutiveFailures }
const extractResults = new Map(); // id -> { createdAt, sessionId, rows: Array<{phone, type, source, chat_title, chat_id, name}>, unique: number }

function getRoom(sessionId) {
  return `session:${sessionId}`;
}

async function createClient(sessionId) {
  // Clean up any existing lock files before creating the client
  await cleanupSessionFiles(sessionId);
  
  const puppeteerOptions = {
    headless: true,
    timeout: 60000,
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI,site-per-process',
      '--disable-extensions',
      '--password-store=basic',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,800',
      '--remote-debugging-port=0',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
    ],
  };
  if (CHROME_EXEC_PATH) {
    puppeteerOptions.executablePath = CHROME_EXEC_PATH;
  }
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `whats-tool-${sessionId}` }),
    puppeteer: puppeteerOptions,
  });

  const state = { client, isReady: false, currentCampaign: null, lastQr: null, lastQrAt: 0, _reconnecting: false, autoReconnectFailures: 0 };
  sessions.set(sessionId, state);

  client.on('qr', (qr) => {
    logger.info({ sessionId }, 'QR received. Scan to login.');
    try { qrcode.generate(qr, { small: true }); } catch {}
    const now = Date.now();
    // Dedupe/throttle QR emissions to avoid spamming clients
    if (state.lastQr === qr && (now - state.lastQrAt) < 2000) {
      return;
    }
    state.lastQr = qr;
    state.lastQrAt = now;
    io.to(getRoom(sessionId)).emit('wa_qr', { sessionId, qr });
  });

  client.on('ready', async () => {
    state.isReady = true;
    state.lastQr = null;
    state.lastQrAt = 0;
    state.autoReconnectFailures = 0;
    const { number, pushName, profilePicUrl } = await getProfileInfo(client);
    logger.info({ sessionId, number }, 'WhatsApp client is ready.');
    io.to(getRoom(sessionId)).emit('wa_ready', { sessionId, ready: true, number, pushName });
    if (profilePicUrl) io.to(getRoom(sessionId)).emit('wa_profile', { sessionId, profilePicUrl, number, pushName });
  });

  client.on('authenticated', () => {
    logger.info({ sessionId }, 'Authenticated.');
    io.to(getRoom(sessionId)).emit('wa_auth', { sessionId, status: 'authenticated' });
  });

  client.on('auth_failure', (m) => {
    state.isReady = false;
    logger.error({ sessionId, m }, 'Authentication failure');
    io.to(getRoom(sessionId)).emit('wa_auth', { sessionId, status: 'failure', message: String(m || '') });
    // Trigger a controlled reconnect after auth failure
    (async () => {
      if (state._reconnecting) return;
      state._reconnecting = true;
      try {
        try { await state.client.destroy(); } catch {}
        await sleep(300);
        try {
          const lockPath = path.join(__dirname, '.wwebjs_auth', `session-whats-tool-${sessionId}`, 'SingletonLock');
          await fs.promises.unlink(lockPath).catch(() => {});
        } catch {}
        const newState = await createClient(sessionId);
        await newState.client.initialize();
      } catch (e) {
        logger.error({ sessionId, error: String(e) }, 'Auto-reconnect after auth failure failed');
      } finally {
        state._reconnecting = false;
      }
    })();
  });

  // Additional connection lifecycle events for richer client UX
  client.on('loading_screen', (percent, message) => {
    try {
      io.to(getRoom(sessionId)).emit('wa_loading', { sessionId, percent, message });
    } catch {}
  });

  client.on('change_state', (stateStr) => {
    logger.info({ sessionId, state: stateStr }, 'Client state changed');
    try {
      io.to(getRoom(sessionId)).emit('wa_state', { sessionId, state: stateStr });
    } catch {}
  });

  client.on('disconnected', (reason) => {
    state.isReady = false;
    logger.warn({ sessionId, reason }, 'Client disconnected');
    io.to(getRoom(sessionId)).emit('wa_disconnected', { sessionId, reason });
    
    // Stop any running campaigns when disconnected
    if (state.currentCampaign) {
      state.currentCampaign = null;
      io.to(getRoom(sessionId)).emit('campaign_status', { sessionId, status: 'disconnected' });
    }
    
    // Exponential backoff reconnect with singleton lock cleanup
    (async () => {
      let attempt = 0;
      while (!state.isReady && attempt < 5) {
        const delay = Math.min(30000, 2000 * Math.pow(2, attempt));
        await sleep(delay);
        try {
          // Cleanup lock
          try {
            const lockPath = path.join(__dirname, '.wwebjs_auth', `session-whats-tool-${sessionId}`, 'SingletonLock');
            await fs.promises.unlink(lockPath).catch(() => {});
          } catch {}
          logger.info({ sessionId, attempt }, 'Reconnecting client...');
          await client.initialize();
        } catch (err) {
          logger.error({ sessionId, error: String(err), attempt }, 'Reconnect attempt failed');
          // If browser disconnected, recreate fresh client instance
          if (String(err || '').includes('browser has disconnected')) {
            try { await client.destroy(); } catch {}
            const newState = await createClient(sessionId);
            client = newState.client;
          }
        }
        attempt += 1;
      }
    })();
  });

  // Auto-reply on new messages
  client.on('message', async (msg) => {
    try {
      // Ignore own messages
      if (msg.fromMe) {
        // Owner/agent wrote in this chat; activate takeover
        try { setHumanOverride(sessionId, msg.to || msg.from, 15, 'all'); } catch {}
        return;
      }
      const text = (msg.body || '').trim();
      const chatId = msg.from;
      // Emit realtime event for incoming message so moderators can see live chat
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
      // Basic typing indicator: show typing for 2s before message received
      try { io.to(getRoom(sessionId)).emit('typing', { sessionId, chatId, typing: true }); setTimeout(()=>{ try { io.to(getRoom(sessionId)).emit('typing', { sessionId, chatId, typing: false }); } catch {} }, 2000); } catch {}
      const takeover = getHumanOverride(sessionId, chatId);
      if (takeover && takeover.mode === 'all') {
        logger.info({ sessionId, chatId, mode: takeover.mode }, 'Human takeover active: suppressing automation');
        return;
      }
      
      // Check flow triggers first
      logger.info({ 
        sessionId, 
        messageBody: msg.body, 
        messageType: msg.type,
        fromMe: msg.fromMe,
        from: msg.from
      }, 'Processing incoming message');
      const flowHandled = await checkFlowTriggers(msg, sessionId);
      if (flowHandled) {
        logger.info({ sessionId, messageBody: msg.body }, 'Message handled by flow, skipping other handlers');
        return; // Exit early if flow handled the message
      }
      const rules = autoReply.enabledFor(sessionId);
      // Time window helper
      const parseMin = (t) => {
        if (!t) return null; const [h,m] = String(t).split(':').map(Number); if (Number.isNaN(h)||Number.isNaN(m)) return null; return h*60+m;
      };
      const nowMin = new Date().getHours()*60 + new Date().getMinutes();
      let handled = false;
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

        // Send response
        const chatId = msg.from;
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
        handled = true; break; // first match wins
      }
      if (!handled) {
        // If human override is AI-only, skip AI but allow flows/autoreplies
        if (takeover && (takeover.mode === 'aiOnly' || takeover.mode === 'AI' || takeover.mode === 'ai')) {
          logger.info({ sessionId, chatId, mode: takeover.mode }, 'Human takeover (AI only): skipping AI reply');
          return;
        }
        // fallback to AI Agent if enabled; gather last 25 messages for context
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

  // Outgoing messages created by this client (from WhatsApp Web or sendMessage)
  client.on('message_create', async (msg) => {
    try {
      // Only emit for messages sent by us
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
    } catch (e) {
      logger.warn({ sessionId, error: String(e) }, 'Failed to emit message_create socket event');
    }
  });

  // Read receipts (ack) updates for messages
  client.on('message_ack', (msg, ack) => {
    try {
      const chatId = msg.to || msg.from;
      io.to(getRoom(sessionId)).emit('message_ack', {
        sessionId,
        chatId,
        id: msg?.id?._serialized || null,
        ack
      });
    } catch (e) {
      logger.warn({ sessionId, error: String(e) }, 'Failed to emit message_ack');
    }
  });

  return state;
}

async function ensureSession(sessionId) {
  return sessions.get(sessionId) || await createClient(sessionId);
}

// Attempt a controlled reconnect for a given session
async function triggerReconnect(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) return { started: false, reason: 'no_state' };
  if (state._reconnecting) return { started: false, reason: 'already_reconnecting' };
  state._reconnecting = true;
  try {
    try { await state.client.destroy(); } catch {}
    try {
      const lockPath = path.join(__dirname, '.wwebjs_auth', `session-whats-tool-${sessionId}`, 'SingletonLock');
      await fs.promises.unlink(lockPath).catch(() => {});
    } catch {}
    const newState = await createClient(sessionId);
    await newState.client.initialize();
    return { started: true };
  } catch (e) {
    logger.error({ sessionId, error: String(e) }, 'triggerReconnect failed');
    return { started: false, error: String(e) };
  } finally {
    state._reconnecting = false;
  }
}

function safeGetClientNumber(client) {
  try {
    const wid = client?.info?.wid;
    if (!wid) return null;
    if (typeof wid.user === 'string' && wid.user) return wid.user;
    const ser = wid._serialized || '';
    if (ser) return String(ser).replace(/@c\.us$/, '');
  } catch {}
  return null;
}

async function getProfileInfo(client) {
  const number = safeGetClientNumber(client);
  const pushName = client?.info?.pushname || null;
  let profilePicUrl = null;
  try {
    const wid = client?.info?.wid?._serialized;
    if (wid) profilePicUrl = await client.getProfilePicUrl(wid);
  } catch {}
  return { number, pushName, profilePicUrl };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// WhatsApp number validation function
async function validateWhatsAppNumber(state, phone) {
  try {
    const chatId = phone.includes('@c.us') ? phone : `${phone.replace(/[^0-9]/g, '')}@c.us`;
    
    // Check if session is ready
    if (!state.isReady || !state.client || state.client.info === null) {
      return { valid: false, error: 'WhatsApp session not ready' };
    }
    
    // Try to get chat info to validate the number
    try {
      const chat = await state.client.getChatById(chatId);
      if (chat && chat.id) {
        return { valid: true, chatId, chat };
      }
    } catch (chatError) {
      // If chat doesn't exist, try to check if number is registered
      try {
        // Try to get number info
        const numberId = chatId.replace('@c.us', '');
        const numberInfo = await state.client.getNumberId(numberId);
        if (numberInfo) {
          return { valid: true, chatId, numberInfo };
        }
      } catch (numberError) {
        // Number is not registered on WhatsApp
        return { valid: false, error: 'Number not registered on WhatsApp' };
      }
    }
    
    return { valid: false, error: 'Unable to validate number' };
  } catch (error) {
    return { valid: false, error: `Validation error: ${error.message}` };
  }
}

async function sendItem(state, item) {
  const { phone, message, mediaPath, caption } = item; // phone in international format without '+'
  const chatId = phone.includes('@c.us') ? phone : `${phone.replace(/[^0-9]/g, '')}@c.us`;

  // Check if session is still ready before sending
  if (!state.isReady) {
    throw new Error('WhatsApp session is not ready. Please check your connection and try again.');
  }

  // Check if client is still connected
  if (!state.client || state.client.info === null) {
    throw new Error('WhatsApp client is disconnected. Please reconnect your session.');
  }

  try {
    if (mediaPath) {
      const absPath = path.isAbsolute(mediaPath) ? mediaPath : path.join(UPLOAD_DIR, mediaPath);
      const exists = fs.existsSync(absPath);
      if (!exists) throw new Error(`Media not found: ${absPath}`);
      const mimeType = mime.lookup(absPath) || 'application/octet-stream';
      const base64 = fs.readFileSync(absPath, { encoding: 'base64' });
      const filename = path.basename(absPath);
      const media = new MessageMedia(mimeType, base64, filename);
      const usedCaption = typeof caption === 'string' && caption.length ? caption : (message || undefined);
      await state.client.sendMessage(chatId, media, { caption: usedCaption });
    } else {
      await state.client.sendMessage(chatId, message || '');
    }
  } catch (error) {
    const errorMsg = String(error?.message || error);
    
    // Handle specific session closed errors
    if (errorMsg.includes('Session closed') || 
        errorMsg.includes('Protocol error') || 
        errorMsg.includes('Runtime.callFunctionOn') ||
        errorMsg.includes('Target closed') ||
        errorMsg.includes('Connection closed')) {
      
      // Mark session as not ready
      state.isReady = false;
      
      // Try to reinitialize the client
      try {
        logger.warn({ sessionId: state.client.info?.wid?.user }, 'Session closed, attempting to reconnect...');
        await state.client.initialize();
      } catch (reconnectError) {
        logger.error({ sessionId: state.client.info?.wid?.user, error: String(reconnectError) }, 'Failed to reconnect session');
      }
      
      throw new Error('WhatsApp session was closed. Please check your WhatsApp Web connection and try again.');
    }
    
    // Handle other common errors
    if (errorMsg.includes('Number not found') || errorMsg.includes('not registered')) {
      throw new Error('Phone number is not registered on WhatsApp');
    }
    
    if (errorMsg.includes('Rate limit') || errorMsg.includes('Too many messages')) {
      throw new Error('Rate limit exceeded. Please wait before sending more messages.');
    }
    
    // Re-throw the original error if it's not a session issue
    throw error;
  }
}

function parseTimeStringToMinutes(timeStr) {
  if (!timeStr) return null;
  const [h, m] = String(timeStr).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function inWindow(now, startMin, endMin) {
  if (startMin == null || endMin == null) return true; // no window
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (startMin <= endMin) return minutes >= startMin && minutes <= endMin;
  // window wraps past midnight
  return minutes >= startMin || minutes <= endMin;
}

async function waitUntilWindow(now, startMin) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  let waitMinutes = 0;
  if (startMin == null) return;
  if (minutes <= startMin) {
    waitMinutes = startMin - minutes;
  } else {
    waitMinutes = 24 * 60 - minutes + startMin; // next day
  }
  await sleep(waitMinutes * 60 * 1000);
}

function jitteredDelay(baseMs, jitterPct) {
  const pct = Math.max(0, Math.min(100, Number(jitterPct) || 0));
  if (!pct) return baseMs;
  const delta = baseMs * (pct / 100);
  const min = Math.max(0, baseMs - delta);
  const max = baseMs + delta;
  return Math.floor(min + Math.random() * (max - min));
}

function pad2(n) { return String(n).padStart(2, '0'); }
function formatDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function formatTime(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function formatDateTime(d) { return `${formatDate(d)} ${formatTime(d)}`; }
function replaceSystemVars(text) {
  if (!text) return text;
  let out = String(text);
  const now = new Date();
  
  // Basic date/time variables
  out = out.replace(/\{date\}/g, formatDate(now));
  out = out.replace(/\{time\}/g, formatTime(now));
  out = out.replace(/\{datetime\}/g, formatDateTime(now));
  
  // Enhanced date variables with formats
  out = out.replace(/\{date:([^}]+)\}/g, (_m, format) => {
    try {
      switch (format.toLowerCase()) {
        case 'iso': return now.toISOString().split('T')[0];
        case 'us': return now.toLocaleDateString('en-US');
        case 'eu': return now.toLocaleDateString('en-GB');
        case 'short': return now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        case 'long': return now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        case 'ddmmyyyy': return `${pad2(now.getDate())}/${pad2(now.getMonth()+1)}/${now.getFullYear()}`;
        case 'mmddyyyy': return `${pad2(now.getMonth()+1)}/${pad2(now.getDate())}/${now.getFullYear()}`;
        default: return formatDate(now);
      }
    } catch (e) {
      return formatDate(now);
    }
  });
  
  // Enhanced time variables with formats
  out = out.replace(/\{time:([^}]+)\}/g, (_m, format) => {
    try {
      switch (format.toLowerCase()) {
        case '12': return now.toLocaleTimeString('en-US', { hour12: true });
        case '24': return now.toLocaleTimeString('en-US', { hour12: false });
        case 'short': return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        case 'long': return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        case 'hms': return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
        default: return formatTime(now);
      }
    } catch (e) {
      return formatTime(now);
    }
  });
  
  // Enhanced datetime variables
  out = out.replace(/\{datetime:([^}]+)\}/g, (_m, format) => {
    try {
      switch (format.toLowerCase()) {
        case 'iso': return now.toISOString();
        case 'short': return now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        case 'long': return now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        case 'full': return now.toLocaleString();
        default: return formatDateTime(now);
      }
    } catch (e) {
      return formatDateTime(now);
    }
  });
  
  // Individual date components
  out = out.replace(/\{year\}/g, now.getFullYear().toString());
  out = out.replace(/\{month\}/g, (now.getMonth() + 1).toString());
  out = out.replace(/\{day\}/g, now.getDate().toString());
  out = out.replace(/\{hour\}/g, now.getHours().toString());
  out = out.replace(/\{minute\}/g, now.getMinutes().toString());
  out = out.replace(/\{second\}/g, now.getSeconds().toString());
  
  // Day of week
  out = out.replace(/\{weekday\}/g, now.toLocaleDateString('en-US', { weekday: 'long' }));
  out = out.replace(/\{weekday:short\}/g, now.toLocaleDateString('en-US', { weekday: 'short' }));
  
  // Month name
  out = out.replace(/\{monthname\}/g, now.toLocaleDateString('en-US', { month: 'long' }));
  out = out.replace(/\{monthname:short\}/g, now.toLocaleDateString('en-US', { month: 'short' }));
  
  // Random number variables
  out = out.replace(/\{rand(?::(\d+)-(\d+))?\}/g, (_m, a, b) => {
    let min = 100000, max = 999999;
    if (a && b) { min = Number(a); max = Number(b); }
    if (Number.isNaN(min) || Number.isNaN(max) || max < min) { min = 0; max = 999999; }
    return String(Math.floor(min + Math.random() * (max - min + 1)));
  });
  
  return out;
}

async function runCampaignLoop(sessionId) {
  const state = sessions.get(sessionId);
  if (!state || !state.currentCampaign) return;
  const camp = state.currentCampaign;
  const { id, items, delayMs, startTime, window, retries, throttle, validateNumbers } = camp;
  const startMin = parseTimeStringToMinutes(window?.start);
  const endMin = parseTimeStringToMinutes(window?.end);

  io.to(getRoom(sessionId)).emit('campaign_status', { sessionId, id, status: 'running' });
  let success = 0;
  let failure = 0;

  // Wait until start time if specified
  if (startTime) {
    const target = new Date(startTime);
    const now = new Date();
    if (target > now) await sleep(target.getTime() - now.getTime());
  }

  for (let index = 0; index < items.length; index += 1) {
    const latest = sessions.get(sessionId);
    if (!latest || !latest.currentCampaign || latest.currentCampaign.id !== id) break; // cancelled or replaced
    const item = items[index];

    // Ensure we are inside sending window
    while (!inWindow(new Date(), startMin, endMin)) {
      await waitUntilWindow(new Date(), startMin);
    }

    let sent = false;
    let errorMsg = '';
    const maxRetries = Math.max(0, Number(retries?.maxRetries) || 0);
    const baseMs = Math.max(250, Number(retries?.baseMs) || 1000);
    const jitterPct = Number(retries?.jitterPct) || 0;

    // Validate WhatsApp number before sending (if enabled)
    if (validateNumbers !== false) {
      const validation = await validateWhatsAppNumber(state, item.phone);
      if (!validation.valid) {
        failure += 1;
        io.to(getRoom(sessionId)).emit('campaign_progress', {
          sessionId,
          id,
          index,
          phone: item.phone,
          status: 'failed',
          error: `Validation failed: ${validation.error}`,
        });
        continue; // Skip to next number
      }
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const enriched = { ...item };
        if (enriched.message) enriched.message = replaceSystemVars(enriched.message);
        if (enriched.caption) enriched.caption = replaceSystemVars(enriched.caption);
        await sendItem(state, enriched);
        sent = true;
        success += 1;
        io.to(getRoom(sessionId)).emit('campaign_progress', { sessionId, id, index, phone: item.phone, status: 'sent' });
        break;
      } catch (err) {
        errorMsg = String(err?.message || err);
        if (attempt < maxRetries) {
          const backoff = jitteredDelay(baseMs * Math.pow(2, attempt), jitterPct);
          await sleep(backoff);
          continue;
        }
      }
    }

    if (!sent) {
      failure += 1;
      io.to(getRoom(sessionId)).emit('campaign_progress', {
        sessionId,
        id,
        index,
        phone: item.phone,
        status: 'failed',
        error: errorMsg,
      });
    }

    if (index < items.length - 1) {
      // base per-message delay
      await sleep(delayMs);
      // throttle: sleep for X sec after Y messages
      const every = Math.max(0, Number(throttle?.messages) || 0);
      const restSec = Math.max(0, Number(throttle?.sleepSec) || 0);
      if (every > 0 && restSec > 0 && (index + 1) % every === 0) {
        await sleep(restSec * 1000);
      }
    }
  }
  io.to(getRoom(sessionId)).emit('campaign_status', { sessionId, id, status: 'finished' });
  state.currentCampaign = null;
  logger.info({ sessionId, id, success, failure }, 'Campaign finished');
}

// Worker: processes queued jobs per session with guardrails
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const FAILURE_BURST_THRESHOLD = 10; // consecutive failures to trigger cooldown

async function startWorker(sessionId) {
  const existingWorker = workers.get(sessionId);
  if (existingWorker && existingWorker.running) return;
  
  const state = sessions.get(sessionId);
  if (!state) return;
  const worker = { running: true, paused: false, messagesSinceThrottle: 0, consecutiveFailures: 0 };
  workers.set(sessionId, worker);
  logger.info({ sessionId }, 'Worker started');

  const sendFromJob = async (job) => {
    // Build item compatible with sendItem
    const item = { phone: job.phone, message: job.message, caption: job.caption, mediaPath: job.media_path };
    
    // Validate WhatsApp number before sending
    const validation = await validateWhatsAppNumber(state, item.phone);
    if (!validation.valid) {
      io.to(getRoom(sessionId)).emit('campaign_progress', {
        sessionId,
        id: job.campaign_id,
        index: job.id,
        phone: job.phone,
        status: 'failed',
        error: `Validation failed: ${validation.error}`,
      });
      return; // Skip this job
    }
    
    const enriched = { ...item };
    if (enriched.message) enriched.message = replaceSystemVars(enriched.message);
    if (enriched.caption) enriched.caption = replaceSystemVars(enriched.caption);
    await sendItem(state, enriched);
    io.to(getRoom(sessionId)).emit('campaign_progress', { sessionId, id: job.campaign_id, index: job.id, phone: job.phone, status: 'sent' });
  };

  while (worker.running) {
    try {
      const sessionState = sessions.get(sessionId);
      if (!sessionState?.isReady) { 
        logger.debug({ sessionId }, 'Session not ready, waiting...');
        await sleep(1000); 
        continue; 
      }
      
      // Check if client is still connected
      if (!sessionState.client || sessionState.client.info === null) {
        logger.warn({ sessionId }, 'Client connection lost, waiting for reconnect...');
        await sleep(2000);
        continue;
      }
      
      if (worker.paused) { await sleep(500); continue; }

      const job = queue.nextJob(sessionId);
      if (!job) { await sleep(400); continue; }

      // windows and start time
      const startAt = job.start_time ? new Date(job.start_time) : null;
      if (startAt && startAt > new Date()) {
        const wait = startAt.getTime() - Date.now();
        await sleep(wait);
      }
      const stMin = parseTimeStringToMinutes(job.window_start);
      const enMin = parseTimeStringToMinutes(job.window_end);
      while (!inWindow(new Date(), stMin, enMin)) {
        await waitUntilWindow(new Date(), stMin);
      }

      let success = false; let errMsg = '';
      for (let attempt = 0; attempt <= (job.retry_max || 0); attempt += 1) {
        try {
          await sendFromJob(job);
          success = true; break;
        } catch (err) {
          errMsg = String(err?.message || err);
          if (attempt < (job.retry_max || 0)) {
            const backoff = jitteredDelay((job.retry_base_ms || 1000) * Math.pow(2, attempt), job.retry_jitter || 0);
            await sleep(backoff);
          }
        }
      }
      if (success) {
        queue.markJob(job.id, 'sent', null);
        worker.consecutiveFailures = 0;
        worker.messagesSinceThrottle += 1;
      } else {
        queue.markJob(job.id, 'failed', errMsg);
        io.to(getRoom(sessionId)).emit('campaign_progress', { sessionId, id: job.campaign_id, index: job.id, phone: job.phone, status: 'failed', error: errMsg });
        worker.consecutiveFailures += 1;
        if (worker.consecutiveFailures >= FAILURE_BURST_THRESHOLD) {
          logger.warn({ sessionId }, 'Too many failures; cooling down');
          await sleep(FAILURE_COOLDOWN_MS);
          worker.consecutiveFailures = 0;
        }
      }

      // base delay and throttle
      await sleep(Math.max(0, job.delay_ms || 0));
      const every = Math.max(0, job.throttle_every || 0);
      const restSec = Math.max(0, job.throttle_sleep_sec || 0);
      if (every > 0 && restSec > 0 && worker.messagesSinceThrottle % every === 0) {
        await sleep(restSec * 1000);
      }
    } catch (err) {
      logger.error({ sessionId, err: String(err) }, 'Worker error');
      await sleep(1000);
    }
  }
}

// Routes
app.get('/api/sessions', (_req, res) => {
  const data = Array.from(sessions.entries()).map(([id, s]) => ({ 
    id, 
    ready: s.isReady, 
    runningCampaign: Boolean(s.currentCampaign),
    clientConnected: s.client && s.client.info !== null,
    lastSeen: s.lastSeen || null
  }));
  res.json({ sessions: data });
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { id } = req.body || {};
    
    // Validate required field
    if (!id) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    // Validate session ID format
    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'Session ID must be a string' });
    }
    
    // Validate session ID characters
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return res.status(400).json({ error: 'Session ID can only contain letters, numbers, underscores, and hyphens' });
    }
    
    // Validate session ID length
    if (id.length < 2 || id.length > 20) {
      return res.status(400).json({ error: 'Session ID must be between 2 and 20 characters long' });
    }
    
    // Check if session already exists
    const exists = sessions.get(id);
    if (exists) {
      logger.info({ sessionId: id }, 'Session already exists, returning existing session');
      return res.json({ id, ready: exists.isReady, message: 'Session already exists' });
    }
    
    // Create new session
    logger.info({ sessionId: id }, 'Creating new session');
    const state = await ensureSession(id);
    
    // Initialize the session client
    state.client.initialize().catch((e) => {
      try { 
        logger.error({ sessionId: id, error: String(e) }, 'Failed to initialize session'); 
      } catch {}
    });
    
    logger.info({ sessionId: id }, 'Session created successfully');
    res.json({ id, ready: state.isReady, message: 'Session created successfully' });
    
  } catch (error) {
    logger.error({ error: String(error) }, 'Error creating session');
    res.status(500).json({ error: 'Internal server error while creating session' });
  }
});

// Reconnect session endpoint (must be before /status route to avoid conflicts)
app.post('/api/sessions/:id/reconnect', async (req, res) => {
  const sessionId = req.params.id;
  const state = sessions.get(sessionId);
  
  if (!state) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    logger.info({ sessionId }, 'Manual reconnect requested');
    // Prevent concurrent reconnects
    if (state._reconnecting) {
      return res.json({ success: true, message: 'Reconnect already in progress' });
    }
    state._reconnecting = true;

    try {
      // Attempt graceful destroy first
      try { await state.client.destroy(); } catch {}
      try { await sleep(300); } catch {}

      // Remove potential chromium singleton lock for this session
      try {
        const lockPath = path.join(__dirname, '.wwebjs_auth', `session-whats-tool-${sessionId}`, 'SingletonLock');
        await fs.promises.unlink(lockPath).catch(() => {});
      } catch {}

      // Recreate client instance fresh
      const newState = await createClient(sessionId);
      try { await newState.client.initialize(); } catch (e) {
        // If initialize fails, keep old state reference to avoid dangling
        logger.error({ sessionId, error: String(e) }, 'Initialize failed during reconnect');
        throw e;
      }
      res.json({ success: true, message: 'Reconnection initiated. Waiting for readiness.' });
    } finally {
      state._reconnecting = false;
    }
  } catch (error) {
    logger.error({ sessionId, error: String(error) }, 'Failed to reconnect session');
    res.status(500).json({ 
      error: 'Failed to reconnect session', 
      details: String(error) 
    });
  }
});

app.get('/api/sessions/:id/status', (req, res) => {
  const id = req.params.id;
  const state = sessions.get(id);
  if (!state) return res.json({ ready: false, runningCampaign: false, number: null });
  const number = state.isReady ? safeGetClientNumber(state.client) : null;
  const pushName = state?.client?.info?.pushname || null;
  res.json({ ready: state.isReady, runningCampaign: Boolean(state.currentCampaign), number, pushName });
});

// Session health check endpoint
app.get('/api/sessions/:id/health', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const health = await checkSessionHealth(sessionId);
    res.json(health);
  } catch (error) {
    logger.error({ error: String(error), sessionId: req.params.id }, 'Health check failed');
    res.status(500).json({ error: 'Health check failed', details: error.message });
  }
});

// Session recovery endpoint
app.post('/api/sessions/:id/recover', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { reason = 'manual recovery' } = req.body || {};
    
    const result = await recoverSession(sessionId, reason);
    
    if (result.success) {
      res.json({ success: true, message: 'Session recovery initiated successfully' });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error) {
    logger.error({ error: String(error), sessionId: req.params.id }, 'Session recovery failed');
    res.status(500).json({ error: 'Session recovery failed', details: error.message });
  }
});

// Session diagnostics endpoint
app.get('/api/sessions/:id/diagnostics', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const state = sessions.get(sessionId);
    const health = sessionHealth.get(sessionId);
    
    if (!state) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const diagnostics = {
      sessionId,
      exists: !!state,
      isReady: state.isReady,
      hasClient: !!state.client,
      createdAt: state.createdAt,
      uptime: state.createdAt ? Date.now() - new Date(state.createdAt).getTime() : 0,
      health: health || { status: 'unknown', lastCheck: null },
      lockFiles: [],
      sessionFiles: []
    };
    
    // Check for lock files
    try {
      const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-whats-tool-${sessionId}`);
      if (fs.existsSync(sessionPath)) {
        const files = await fs.promises.readdir(sessionPath);
        diagnostics.lockFiles = files.filter(f => 
          f.includes('Singleton') || f.includes('Lock') || f.includes('Socket')
        );
        diagnostics.sessionFiles = files;
      }
    } catch (err) {
      diagnostics.error = `Failed to check session files: ${err.message}`;
    }
    
    res.json(diagnostics);
  } catch (error) {
    logger.error({ error: String(error), sessionId: req.params.id }, 'Diagnostics failed');
    res.status(500).json({ error: 'Diagnostics failed', details: error.message });
  }
});

// Cleanup session files endpoint
app.post('/api/sessions/:id/cleanup', async (req, res) => {
  try {
    const sessionId = req.params.id;
    await cleanupSessionFiles(sessionId);
    res.json({ success: true, message: 'Session files cleaned up successfully' });
  } catch (error) {
    logger.error({ error: String(error), sessionId: req.params.id }, 'Cleanup failed');
    res.status(500).json({ error: 'Cleanup failed', details: error.message });
  }
});

// Get all sessions health status
app.get('/api/sessions/health', async (req, res) => {
  try {
    const allHealth = {};
    
    for (const [sessionId, state] of sessions) {
      try {
        const health = await checkSessionHealth(sessionId);
        allHealth[sessionId] = health;
      } catch (error) {
        allHealth[sessionId] = { 
          status: 'error', 
          error: error.message, 
          lastCheck: new Date().toISOString() 
        };
      }
    }
    
    res.json({ sessions: allHealth, total: sessions.size });
  } catch (error) {
    logger.error({ error: String(error) }, 'Bulk health check failed');
    res.status(500).json({ error: 'Bulk health check failed', details: error.message });
  }
});

// Session watchdog: periodically ensure clients are initialized
setInterval(() => {
  for (const [sid, st] of sessions.entries()) {
    try {
      if (!st.client || st.client.info === null) {
        // If client missing or not connected, try to initialize with backoff
        const backoff = Math.min(60000, 2000 * Math.pow(2, st.autoReconnectFailures || 0));
        st.autoReconnectFailures = (st.autoReconnectFailures || 0) + 1;
        setTimeout(async () => {
          try {
            // Clean lock and re-init
            try {
              const lockPath = path.join(__dirname, '.wwebjs_auth', `session-whats-tool-${sid}`, 'SingletonLock');
              await fs.promises.unlink(lockPath).catch(() => {});
            } catch {}
            await st.client?.initialize();
          } catch (e) {
            logger.error({ sessionId: sid, error: String(e) }, 'Watchdog initialize failed');
          }
        }, backoff);
      } else {
        st.autoReconnectFailures = 0;
      }
    } catch {}
  }
}, 15000);

// Delete session: logout client (if loaded) and remove LocalAuth data
function deleteDirectoryIfExists(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (e) {
    logger.warn({ dirPath, e: String(e) }, 'Failed to remove directory');
  }
}

app.delete('/api/sessions/:id', async (req, res) => {
  const id = req.params.id;
  const state = sessions.get(id);
  if (state) {
    try { if (state.currentCampaign) state.currentCampaign = null; } catch {}
    try { await state.client.logout(); } catch {}
    try { await state.client.destroy(); } catch {}
    sessions.delete(id);
  }
  // Remove auth/cache folders (support both naming conventions)
  const clientId = `whats-tool-${id}`;
  const authBase = path.resolve('.wwebjs_auth');
  const cacheBase = path.resolve('.wwebjs_cache');
  const candidates = [
    path.join(authBase, `session-${clientId}`),
    path.join(authBase, clientId),
    path.join(cacheBase, `session-${clientId}`),
    path.join(cacheBase, clientId),
  ];
  candidates.forEach(deleteDirectoryIfExists);
  res.json({ ok: true });
});

// Delete all sessions endpoint
app.delete('/api/sessions', async (req, res) => {
  try {
    const sessionIds = Array.from(sessions.keys());
    let deletedCount = 0;
    let errors = [];
    
    for (const id of sessionIds) {
      try {
        const state = sessions.get(id);
        if (state) {
          try { if (state.currentCampaign) state.currentCampaign = null; } catch {}
          try { await state.client.logout(); } catch {}
          try { await state.client.destroy(); } catch {}
          sessions.delete(id);
        }
        
        // Remove auth/cache folders (support both naming conventions)
        const clientId = `whats-tool-${id}`;
        const authBase = path.resolve('.wwebjs_auth');
        const cacheBase = path.resolve('.wwebjs_cache');
        const candidates = [
          path.join(authBase, `session-${clientId}`),
          path.join(authBase, clientId),
          path.join(cacheBase, `session-${clientId}`),
          path.join(cacheBase, clientId),
        ];
        candidates.forEach(deleteDirectoryIfExists);
        deletedCount++;
        
        logger.info({ sessionId: id }, 'Session deleted successfully');
      } catch (err) {
        errors.push(`Failed to delete session ${id}: ${String(err)}`);
        logger.error({ sessionId: id, error: String(err) }, 'Failed to delete session');
      }
    }
    
    res.json({ 
      ok: true, 
      deletedCount, 
      totalSessions: sessionIds.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Admin endpoints
app.get('/api/admin/stats', (req, res) => {
  try {
    const stats = {
      sessions: {
        total: sessions.size,
        ready: Array.from(sessions.values()).filter(s => s.isReady).length,
        runningCampaigns: Array.from(sessions.values()).filter(s => s.currentCampaign).length
      },
      flows: {
        total: savedFlows.size,
        active: Array.from(savedFlows.values()).filter(f => f.nodes && f.nodes.length > 0).length
      },
      userTags: {
        total: userTags.size,
        totalTags: Array.from(userTags.values()).reduce((sum, tags) => sum + tags.size, 0)
      },
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: process.version,
        platform: process.platform
      }
    };
    
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Clear all flows endpoint
app.delete('/api/admin/flows', (req, res) => {
  try {
    const flowIds = Array.from(savedFlows.keys());
    savedFlows.clear();
    saveFlowsToFile();
    
    logger.info({ deletedCount: flowIds.length }, 'All flows cleared');
    res.json({ 
      ok: true, 
      deletedCount: flowIds.length,
      message: `Cleared ${flowIds.length} flows`
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Clear all user tags endpoint
app.delete('/api/admin/user-tags', (req, res) => {
  try {
    const userCount = userTags.size;
    userTags.clear();
    saveUserTagsToFile();
    
    logger.info({ deletedCount: userCount }, 'All user tags cleared');
    res.json({ 
      ok: true, 
      deletedCount: userCount,
      message: `Cleared tags for ${userCount} users`
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Clear all queue data endpoint (campaigns and jobs)
app.delete('/api/admin/queue', (req, res) => {
  try {
    // Get counts before deletion
    const jobCount = queue.db.prepare('SELECT COUNT(*) as count FROM jobs').get().count;
    const campaignCount = queue.db.prepare('SELECT COUNT(*) as count FROM campaigns').get().count;
    
    // Clear all data from queue database
    queue.db.exec('DELETE FROM jobs');
    queue.db.exec('DELETE FROM campaigns');
    
    logger.info({ deletedJobs: jobCount, deletedCampaigns: campaignCount }, 'All queue data cleared');
    res.json({ 
      ok: true, 
      deletedCount: jobCount + campaignCount,
      deletedJobs: jobCount,
      deletedCampaigns: campaignCount,
      message: `Cleared ${jobCount} jobs and ${campaignCount} campaigns`
    });
  } catch (e) {
    logger.error({ error: String(e) }, 'Failed to clear queue data');
    res.status(500).json({ error: String(e) });
  }
});

// Document Analysis Helper Functions

async function extractTextFromFile(filePath, mimeType) {
  try {
    let text = '';
    
    if (mimeType === 'text/plain') {
      // Handle TXT files
      text = await fs.promises.readFile(filePath, 'utf-8');
    } else if (mimeType === 'application/pdf') {
      // Handle PDF files - load library dynamically
      if (!pdfParse) {
        const pdfParseModule = await import('pdf-parse');
        pdfParse = pdfParseModule.default;
      }
      const dataBuffer = await fs.promises.readFile(filePath);
      const data = await pdfParse(dataBuffer);
      text = data.text;
    } else if (mimeType === 'application/msword' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      // Handle Word documents - load library dynamically
      if (!mammoth) {
        const mammothModule = await import('mammoth');
        mammoth = mammothModule.default;
      }
      const dataBuffer = await fs.promises.readFile(filePath);
      const result = await mammoth.extractRawText({ buffer: dataBuffer });
      text = result.value;
    }
    
    return text.trim();
  } catch (error) {
    logger.error({ error: String(error), filePath, mimeType }, 'Failed to extract text from file');
    throw new Error(`Failed to extract text from file: ${error.message}`);
  }
}

async function analyzeDocumentForPrompts(text, apiKey) {
  try {
    const analysisPrompt = `Analyze this document and extract key information that would be useful for creating AI customer service prompts:

DOCUMENT CONTENT:
${text.slice(0, 8000)} ${text.length > 8000 ? '...(truncated)' : ''}

Please provide a JSON response with:
{
  "documentType": "Type of document (manual, FAQ, policy, guide, etc.)",
  "industry": "Detected industry or domain",
  "keyTopics": ["topic1", "topic2", "topic3"],
  "tone": "Recommended tone (professional, friendly, technical, etc.)",
  "complexity": "Recommended complexity level (simple, moderate, advanced, expert)",
  "useCase": "Best AI agent use case (customer-support, technical-support, etc.)",
  "keyInformation": "Most important information from the document",
  "suggestedFeatures": ["sentiment", "memory", "personality", "learning"],
  "customRequirements": "Specific requirements based on document content"
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are an expert document analyst specializing in AI prompt engineering. Analyze documents to determine the best AI agent configuration.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to analyze document for prompts');
    throw new Error(`Failed to analyze document: ${error.message}`);
  }
}

// AI Prompt Generator and Optimization Endpoints

// Generate perfect prompts for AI agents
app.post('/api/ai/generate-prompt', async (req, res) => {
  try {
    const { 
      useCase, 
      industry, 
      tone, 
      complexity, 
      features = [], 
      customRequirements = '',
      model = 'gpt-4o-mini'
    } = req.body;

    const apiKey = agentMgr.getApiKey();
    if (!apiKey) {
      return res.status(400).json({ error: 'OpenAI API key not configured' });
    }

    // Build the prompt generation request
    const systemPrompt = `You are an expert AI prompt engineer specializing in WhatsApp customer service chatbots. Your job is to create perfect system and user prompts for AI agents with specific capabilities.

You must generate TWO prompts:
1. SYSTEM PROMPT: Defines the AI's personality, role, and behavior
2. USER PROMPT: Template for processing user inputs with variables

Available Variables:
- {message_text} - User's message
- {sender_name} - User's name  
- {sender_phone} - User's phone
- {sentiment} - Detected emotion (happy/sad/angry/frustrated/excited/neutral/confused)
- {user_profile} - Personality and interaction data
- {user_preferences} - Discovered preferences
- {chat_history} - Recent conversation
- {conversation_summary} - AI-generated context summary
- {conversation_count} - Total interactions
- {last_interaction} - Previous interaction timestamp
- {session_id} - WhatsApp session
- {timestamp} - Current time
- {user_tags} - User tags

Requirements:
- Make prompts specific to the use case and industry
- Include emotional intelligence if sentiment analysis is enabled
- Use memory variables if context awareness is enabled
- Reference personality if personality profiling is enabled
- Be concise but comprehensive
- Include best practices for the specific model

Respond with JSON:
{
  "systemPrompt": "...",
  "userPrompt": "...",
  "explanation": "Why this prompt works well",
  "tips": ["tip1", "tip2", "tip3"]
}`;

    const userPrompt = `Generate perfect prompts for:

USE CASE: ${useCase}
INDUSTRY: ${industry}
TONE: ${tone}
COMPLEXITY: ${complexity}
ENABLED FEATURES: ${features.join(', ') || 'Basic AI only'}
MODEL: ${model}

CUSTOM REQUIREMENTS:
${customRequirements || 'None specified'}

Create prompts that will make this AI agent exceptionally effective for this specific scenario.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 1500,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const generatedPrompts = JSON.parse(data.choices[0].message.content);

    // Add metadata about the generation
    const result = {
      ...generatedPrompts,
      metadata: {
        useCase,
        industry,
        tone,
        complexity,
        features,
        model,
        tokensUsed: data.usage?.total_tokens || 0,
        generatedAt: new Date().toISOString()
      }
    };

    logger.info({
      useCase,
      industry,
      tone,
      features,
      tokensUsed: data.usage?.total_tokens || 0
    }, 'AI prompt generated successfully');

    res.json(result);

  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to generate AI prompt');
    res.status(500).json({ error: 'Failed to generate prompt: ' + error.message });
  }
});

// Get prompt templates for different use cases
app.get('/api/ai/prompt-templates', (req, res) => {
  try {
    const templates = {
      'customer-support': {
        name: 'Customer Support',
        description: 'General customer service and help desk',
        systemPrompt: 'You are a professional customer support representative with deep knowledge of our products and services. You are helpful, patient, and always strive to resolve customer issues quickly and effectively.',
        userPrompt: 'Customer: {sender_name}\nMessage: {message_text}\nSentiment: {sentiment}\n\nProvide helpful support based on their question.',
        features: ['sentiment', 'memory'],
        industries: ['technology', 'ecommerce', 'saas', 'general']
      },
      'sales-assistant': {
        name: 'Sales Assistant',
        description: 'Lead qualification and sales support',
        systemPrompt: 'You are an intelligent sales assistant who helps qualify leads and guide customers through the sales process. You are persuasive but not pushy, focusing on understanding customer needs.',
        userPrompt: 'Lead: {sender_name}\nMessage: {message_text}\nProfile: {user_profile}\nHistory: {chat_history}\n\nEngage this lead professionally to understand their needs and guide them toward a purchase.',
        features: ['sentiment', 'personality', 'memory'],
        industries: ['saas', 'ecommerce', 'real-estate', 'automotive']
      },
      'technical-support': {
        name: 'Technical Support',
        description: 'Technical troubleshooting and IT help',
        systemPrompt: 'You are a technical support specialist with expertise in troubleshooting and problem-solving. You provide clear, step-by-step solutions and can adapt your explanations to the user\'s technical level.',
        userPrompt: 'User: {sender_name}\nTechnical Issue: {message_text}\nUser Level: {user_preferences}\nHistory: {conversation_summary}\n\nProvide technical support tailored to their skill level.',
        features: ['memory', 'personality'],
        industries: ['technology', 'saas', 'telecom', 'software']
      },
      'healthcare-assistant': {
        name: 'Healthcare Assistant',
        description: 'Patient support and health information',
        systemPrompt: 'You are a compassionate healthcare assistant who provides information and support to patients. You are empathetic, professional, and always remind users to consult healthcare professionals for medical advice.',
        userPrompt: 'Patient: {sender_name}\nConcern: {message_text}\nEmotion: {sentiment}\nHistory: {chat_history}\n\nProvide supportive healthcare information while being sensitive to their emotional state.',
        features: ['sentiment', 'memory', 'personality'],
        industries: ['healthcare', 'medical', 'wellness', 'mental-health']
      },
      'educational-tutor': {
        name: 'Educational Tutor',
        description: 'Learning support and educational guidance',
        systemPrompt: 'You are an encouraging educational tutor who helps students learn and understand concepts. You adapt your teaching style to each student\'s learning preferences and pace.',
        userPrompt: 'Student: {sender_name}\nQuestion: {message_text}\nLearning Style: {user_preferences}\nProgress: {conversation_summary}\n\nProvide educational support tailored to their learning style.',
        features: ['personality', 'memory', 'learning'],
        industries: ['education', 'training', 'tutoring', 'online-learning']
      },
      'appointment-scheduler': {
        name: 'Appointment Scheduler',
        description: 'Booking and scheduling assistant',
        systemPrompt: 'You are an efficient appointment scheduling assistant who helps customers book appointments and manage their schedules. You are organized, clear about availability, and helpful with rescheduling.',
        userPrompt: 'Customer: {sender_name}\nRequest: {message_text}\nPreferences: {user_preferences}\nHistory: {chat_history}\n\nHelp them schedule appointments based on their needs and availability.',
        features: ['memory', 'personality'],
        industries: ['healthcare', 'beauty', 'automotive', 'professional-services']
      },
      'order-tracking': {
        name: 'Order Tracking',
        description: 'E-commerce order and shipping support',
        systemPrompt: 'You are an order tracking specialist who helps customers with their purchases, shipping updates, and delivery questions. You are proactive about providing updates and resolving issues.',
        userPrompt: 'Customer: {sender_name}\nOrder Inquiry: {message_text}\nCustomer Profile: {user_profile}\nOrder History: {conversation_summary}\n\nProvide order support and tracking information.',
        features: ['memory', 'personality'],
        industries: ['ecommerce', 'retail', 'logistics', 'food-delivery']
      },
      'financial-advisor': {
        name: 'Financial Advisor',
        description: 'Financial guidance and support',
        systemPrompt: 'You are a knowledgeable financial advisor who helps customers with financial questions and guidance. You are trustworthy, clear about risks, and always recommend consulting professional advisors for major decisions.',
        userPrompt: 'Client: {sender_name}\nFinancial Question: {message_text}\nRisk Profile: {user_preferences}\nRelationship: {conversation_summary}\n\nProvide financial guidance appropriate to their situation.',
        features: ['memory', 'personality', 'sentiment'],
        industries: ['finance', 'banking', 'insurance', 'investment']
      }
    };

    res.json({ templates });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Upload and analyze document for prompt generation
app.post('/api/ai/analyze-document', documentUpload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No document uploaded' });
    }

    const apiKey = agentMgr.getApiKey();
    if (!apiKey) {
      return res.status(400).json({ error: 'OpenAI API key not configured' });
    }

    const filePath = req.file.path;
    const mimeType = req.file.mimetype;
    const originalName = req.file.originalname;

    logger.info({
      filename: originalName,
      size: req.file.size,
      mimeType
    }, 'Document uploaded for analysis');

    // Extract text from the document
    const extractedText = await extractTextFromFile(filePath, mimeType);
    
    if (!extractedText || extractedText.length < 50) {
      throw new Error('Document appears to be empty or could not be read properly');
    }

    // Analyze the document content
    const analysis = await analyzeDocumentForPrompts(extractedText, apiKey);

    // Clean up the uploaded file
    try {
      await fs.promises.unlink(filePath);
    } catch (cleanupError) {
      logger.warn({ error: String(cleanupError), filePath }, 'Failed to cleanup uploaded file');
    }

    // Return analysis results
    res.json({
      success: true,
      filename: originalName,
      documentLength: extractedText.length,
      analysis: {
        ...analysis,
        extractedText: extractedText.slice(0, 1000) + (extractedText.length > 1000 ? '...' : '') // Preview only
      },
      suggestions: {
        useCase: analysis.useCase,
        industry: analysis.industry,
        tone: analysis.tone,
        complexity: analysis.complexity,
        features: analysis.suggestedFeatures,
        customRequirements: analysis.customRequirements
      },
      metadata: {
        uploadedAt: new Date().toISOString(),
        fileSize: req.file.size,
        mimeType
      }
    });

  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to analyze document');
    
    // Clean up file on error
    if (req.file && req.file.path) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (cleanupError) {
        logger.warn({ error: String(cleanupError) }, 'Failed to cleanup file after error');
      }
    }
    
    res.status(500).json({ error: 'Failed to analyze document: ' + error.message });
  }
});

// Generate prompts from document analysis
app.post('/api/ai/generate-prompt-from-document', async (req, res) => {
  try {
    const { 
      documentAnalysis,
      overrides = {},
      model = 'gpt-4o-mini'
    } = req.body;

    if (!documentAnalysis) {
      return res.status(400).json({ error: 'Document analysis required' });
    }

    const apiKey = agentMgr.getApiKey();
    if (!apiKey) {
      return res.status(400).json({ error: 'OpenAI API key not configured' });
    }

    // Use document analysis with any user overrides
    const finalConfig = {
      useCase: overrides.useCase || documentAnalysis.useCase,
      industry: overrides.industry || documentAnalysis.industry,
      tone: overrides.tone || documentAnalysis.tone,
      complexity: overrides.complexity || documentAnalysis.complexity,
      features: overrides.features || documentAnalysis.suggestedFeatures || [],
      customRequirements: overrides.customRequirements || documentAnalysis.customRequirements,
      model
    };

    // Enhanced system prompt that includes document context
    const systemPrompt = `You are an expert AI prompt engineer specializing in WhatsApp customer service chatbots. Create perfect prompts based on the analyzed document content.

DOCUMENT ANALYSIS:
- Type: ${documentAnalysis.documentType}
- Industry: ${documentAnalysis.industry}
- Key Topics: ${documentAnalysis.keyTopics?.join(', ') || 'Not specified'}
- Key Information: ${documentAnalysis.keyInformation}

You must generate TWO prompts that incorporate the document's knowledge:
1. SYSTEM PROMPT: Defines the AI's personality, role, and behavior WITH document knowledge
2. USER PROMPT: Template for processing user inputs with variables

Available Variables:
- {message_text} - User's message
- {sender_name} - User's name  
- {sender_phone} - User's phone
- {sentiment} - Detected emotion (happy/sad/angry/frustrated/excited/neutral/confused)
- {user_profile} - Personality and interaction data
- {user_preferences} - Discovered preferences
- {chat_history} - Recent conversation
- {conversation_summary} - AI-generated context summary
- {conversation_count} - Total interactions
- {last_interaction} - Previous interaction timestamp
- {session_id} - WhatsApp session
- {timestamp} - Current time
- {user_tags} - User tags

Requirements:
- Incorporate the document's knowledge and context
- Make prompts specific to the document's content and industry
- Include emotional intelligence if sentiment analysis is enabled
- Use memory variables if context awareness is enabled
- Reference personality if personality profiling is enabled
- Be knowledgeable about the specific topics in the document
- Include best practices for the specific model

Respond with JSON:
{
  "systemPrompt": "AI personality with document knowledge...",
  "userPrompt": "Template with document context...",
  "explanation": "Why this prompt works well with the document",
  "tips": ["tip1", "tip2", "tip3"],
  "documentIntegration": "How document knowledge is incorporated"
}`;

    const userPrompt = `Generate perfect prompts incorporating this document analysis:

DOCUMENT TYPE: ${documentAnalysis.documentType}
USE CASE: ${finalConfig.useCase}
INDUSTRY: ${finalConfig.industry}
TONE: ${finalConfig.tone}
COMPLEXITY: ${finalConfig.complexity}
ENABLED FEATURES: ${finalConfig.features.join(', ') || 'Basic AI only'}
MODEL: ${model}

KEY DOCUMENT TOPICS: ${documentAnalysis.keyTopics?.join(', ') || 'Not specified'}
DOCUMENT CONTENT SUMMARY: ${documentAnalysis.keyInformation}

CUSTOM REQUIREMENTS:
${finalConfig.customRequirements || 'None specified'}

Create prompts that make this AI agent an expert on the document's content and able to answer questions about the specific topics and information contained within it.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 2000,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const generatedPrompts = JSON.parse(data.choices[0].message.content);

    // Add metadata about the generation
    const result = {
      ...generatedPrompts,
      documentBased: true,
      documentType: documentAnalysis.documentType,
      metadata: {
        ...finalConfig,
        tokensUsed: data.usage?.total_tokens || 0,
        generatedAt: new Date().toISOString(),
        basedOnDocument: true
      }
    };

    logger.info({
      documentType: documentAnalysis.documentType,
      useCase: finalConfig.useCase,
      industry: finalConfig.industry,
      tokensUsed: data.usage?.total_tokens || 0
    }, 'Document-based AI prompt generated successfully');

    res.json(result);

  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to generate prompt from document');
    res.status(500).json({ error: 'Failed to generate prompt from document: ' + error.message });
  }
});

// Optimize existing prompts
app.post('/api/ai/optimize-prompt', async (req, res) => {
  try {
    const { currentPrompt, useCase, issues = [], model = 'gpt-4o-mini' } = req.body;

    const apiKey = agentMgr.getApiKey();
    if (!apiKey) {
      return res.status(400).json({ error: 'OpenAI API key not configured' });
    }

    const systemPrompt = `You are an expert prompt optimization specialist. Analyze the given prompt and improve it based on the issues reported and best practices.

Focus on:
- Clarity and specificity
- Proper use of variables
- Industry best practices
- Model-specific optimizations
- User experience improvements

Respond with JSON:
{
  "optimizedPrompt": "improved version",
  "improvements": ["what was improved"],
  "reasoning": "why these changes help",
  "additionalTips": ["extra suggestions"]
}`;

    const userPrompt = `OPTIMIZE THIS PROMPT:
${currentPrompt}

USE CASE: ${useCase}
TARGET MODEL: ${model}
REPORTED ISSUES: ${issues.join(', ') || 'None specified'}

Improve this prompt to be more effective and address any issues.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const optimization = JSON.parse(data.choices[0].message.content);

    res.json({
      ...optimization,
      metadata: {
        originalLength: currentPrompt.length,
        optimizedLength: optimization.optimizedPrompt.length,
        tokensUsed: data.usage?.total_tokens || 0,
        optimizedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to optimize prompt');
    res.status(500).json({ error: 'Failed to optimize prompt: ' + error.message });
  }
});

// AI Memory and Analytics Endpoints

// Get user memory and profile
app.get('/api/ai/memory/:phone', (req, res) => {
  try {
    const phone = req.params.phone;
    const userProfile = userProfiles.get(phone);
    const conversationHistory = getConversationMemory(phone, 20);
    
    if (!userProfile) {
      return res.status(404).json({ error: 'User profile not found' });
    }
    
    res.json({
      profile: userProfile,
      conversationHistory: conversationHistory,
      memoryStats: {
        totalInteractions: userProfile.totalConversations,
        averageSentiment: userProfile.averageSentiment,
        personalityTraits: userProfile.personality ? userProfile.personality.split(', ') : [],
        preferences: userProfile.preferences,
        lastInteraction: userProfile.lastInteraction
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get all user profiles (admin)
app.get('/api/ai/profiles', (req, res) => {
  try {
    const profiles = Array.from(userProfiles.entries()).map(([phone, profile]) => ({
      phone,
      name: profile.name,
      totalConversations: profile.totalConversations,
      averageSentiment: profile.averageSentiment,
      personality: profile.personality,
      lastInteraction: profile.lastInteraction,
      memorySize: getConversationMemory(phone, 100).length
    }));
    
    res.json({ profiles, total: profiles.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Clear specific user memory
app.delete('/api/ai/memory/:phone', (req, res) => {
  try {
    const phone = req.params.phone;
    conversationMemory.delete(phone);
    userProfiles.delete(phone);
    
    logger.info({ phone }, 'User memory cleared');
    res.json({ success: true, message: 'User memory cleared' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get AI analytics
app.get('/api/ai/analytics', (req, res) => {
  try {
    const totalUsers = userProfiles.size;
    const totalConversations = Array.from(userProfiles.values())
      .reduce((sum, profile) => sum + profile.totalConversations, 0);
    
    // Sentiment distribution
    const sentimentCounts = {};
    userProfiles.forEach(profile => {
      const sentiment = profile.averageSentiment || 'neutral';
      sentimentCounts[sentiment] = (sentimentCounts[sentiment] || 0) + 1;
    });
    
    // Most active users
    const topUsers = Array.from(userProfiles.entries())
      .map(([phone, profile]) => ({
        phone: phone.replace(/\d{5,}/g, '****'), // Privacy mask
        name: profile.name,
        conversations: profile.totalConversations,
        sentiment: profile.averageSentiment
      }))
      .sort((a, b) => b.conversations - a.conversations)
      .slice(0, 10);
    
    res.json({
      overview: {
        totalUsers,
        totalConversations,
        averageConversationsPerUser: totalUsers > 0 ? (totalConversations / totalUsers).toFixed(1) : 0
      },
      sentimentDistribution: sentimentCounts,
      topUsers,
      memoryStats: {
        totalMemoryEntries: Array.from(conversationMemory.values())
          .reduce((sum, history) => sum + history.length, 0),
        averageMemoryPerUser: totalUsers > 0 ? 
          (Array.from(conversationMemory.values()).reduce((sum, history) => sum + history.length, 0) / totalUsers).toFixed(1) : 0
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// COMPREHENSIVE CLEAR ALL DATA ENDPOINT
app.delete('/api/admin/clear-all-data', async (req, res) => {
  try {
    logger.warn('CRITICAL: Clear all data operation initiated');
    
    const clearResults = {
      success: true,
      timestamp: new Date().toISOString(),
      cleared_components: {},
      errors: [],
      total_items_cleared: 0
    };

    // 1. Clear all queue data (campaigns and jobs)
    try {
      const jobCount = queue.db.prepare('SELECT COUNT(*) as count FROM jobs').get().count;
      const campaignCount = queue.db.prepare('SELECT COUNT(*) as count FROM campaigns').get().count;
      
      queue.db.exec('DELETE FROM jobs');
      queue.db.exec('DELETE FROM campaigns');
      
      clearResults.cleared_components.queue_data = {
        jobs: jobCount,
        campaigns: campaignCount,
        status: 'cleared'
      };
      clearResults.total_items_cleared += jobCount + campaignCount;
      
      logger.info({ deletedJobs: jobCount, deletedCampaigns: campaignCount }, 'Queue data cleared');
    } catch (e) {
      clearResults.errors.push(`Queue data: ${e.message}`);
      clearResults.cleared_components.queue_data = { status: 'failed', error: e.message };
    }

    // 2. Clear all auto-reply rules
    try {
      const autoReplyCount = autoReply.db.prepare('SELECT COUNT(*) as count FROM auto_replies').get().count;
      autoReply.db.exec('DELETE FROM auto_replies');
      
      clearResults.cleared_components.auto_replies = {
        count: autoReplyCount,
        status: 'cleared'
      };
      clearResults.total_items_cleared += autoReplyCount;
      
      logger.info({ deletedAutoReplies: autoReplyCount }, 'Auto-reply rules cleared');
    } catch (e) {
      clearResults.errors.push(`Auto-reply rules: ${e.message}`);
      clearResults.cleared_components.auto_replies = { status: 'failed', error: e.message };
    }

    // 3. Clear all AI agent data
    try {
      const agentCount = agent.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
      agent.db.exec('DELETE FROM sessions');
      agent.db.exec('DELETE FROM messages');
      agent.db.exec('DELETE FROM knowledge_base');
      
      clearResults.cleared_components.ai_agent = {
        sessions: agentCount,
        status: 'cleared'
      };
      clearResults.total_items_cleared += agentCount;
      
      logger.info({ deletedAgentSessions: agentCount }, 'AI agent data cleared');
    } catch (e) {
      clearResults.errors.push(`AI agent data: ${e.message}`);
      clearResults.cleared_components.ai_agent = { status: 'failed', error: e.message };
    }

    // 4. Clear all flows
    try {
      const flowCount = savedFlows.size;
      savedFlows.clear();
      
      // Clear flows file
      const flowsFile = path.join(DATA_DIR, 'flows.json');
      if (fs.existsSync(flowsFile)) {
        await fs.promises.writeFile(flowsFile, JSON.stringify({}));
      }
      
      clearResults.cleared_components.flows = {
        count: flowCount,
        status: 'cleared'
      };
      clearResults.total_items_cleared += flowCount;
      
      logger.info({ deletedFlows: flowCount }, 'Flows cleared');
    } catch (e) {
      clearResults.errors.push(`Flows: ${e.message}`);
      clearResults.cleared_components.flows = { status: 'failed', error: e.message };
    }

    // 5. Clear templates
    try {
      const templatesFile = path.join(DATA_DIR, 'templates.json');
      let templateCount = 0;
      
      if (fs.existsSync(templatesFile)) {
        const templates = JSON.parse(await fs.promises.readFile(templatesFile, 'utf8'));
        templateCount = Array.isArray(templates) ? templates.length : Object.keys(templates).length;
        await fs.promises.writeFile(templatesFile, JSON.stringify([]));
      }
      
      clearResults.cleared_components.templates = {
        count: templateCount,
        status: 'cleared'
      };
      clearResults.total_items_cleared += templateCount;
      
      logger.info({ deletedTemplates: templateCount }, 'Templates cleared');
    } catch (e) {
      clearResults.errors.push(`Templates: ${e.message}`);
      clearResults.cleared_components.templates = { status: 'failed', error: e.message };
    }

    // 6. Clear user tags
    try {
      const userTagsFile = path.join(DATA_DIR, 'user_tags.json');
      let tagCount = 0;
      
      if (fs.existsSync(userTagsFile)) {
        const tags = JSON.parse(await fs.promises.readFile(userTagsFile, 'utf8'));
        tagCount = Array.isArray(tags) ? tags.length : Object.keys(tags).length;
        await fs.promises.writeFile(userTagsFile, JSON.stringify({}));
      }
      
      clearResults.cleared_components.user_tags = {
        count: tagCount,
        status: 'cleared'
      };
      clearResults.total_items_cleared += tagCount;
      
      logger.info({ deletedUserTags: tagCount }, 'User tags cleared');
    } catch (e) {
      clearResults.errors.push(`User tags: ${e.message}`);
      clearResults.cleared_components.user_tags = { status: 'failed', error: e.message };
    }

    // 7. Clear leads data
    try {
      const leadsFile = path.join(DATA_DIR, 'leads.json');
      let leadsCount = 0;
      
      if (fs.existsSync(leadsFile)) {
        const leads = JSON.parse(await fs.promises.readFile(leadsFile, 'utf8'));
        leadsCount = Array.isArray(leads) ? leads.length : Object.keys(leads).length;
        await fs.promises.writeFile(leadsFile, JSON.stringify([]));
      }
      
      clearResults.cleared_components.leads = {
        count: leadsCount,
        status: 'cleared'
      };
      clearResults.total_items_cleared += leadsCount;
      
      logger.info({ deletedLeads: leadsCount }, 'Leads data cleared');
    } catch (e) {
      clearResults.errors.push(`Leads: ${e.message}`);
      clearResults.cleared_components.leads = { status: 'failed', error: e.message };
    }

    // 8. Clear uploaded media files (keep only system files)
    try {
      let mediaCount = 0;
      const mediaFiles = await fs.promises.readdir(UPLOAD_DIR);
      
      for (const file of mediaFiles) {
        // Skip system files, backups, and temporary files
        if (!file.startsWith('.') && 
            !file.includes('pre_restore_backup') && 
            !file.startsWith('temp_') &&
            !file.includes('sample_')) {
          try {
            await fs.promises.unlink(path.join(UPLOAD_DIR, file));
            mediaCount++;
          } catch (unlinkErr) {
            logger.warn({ file, error: unlinkErr.message }, 'Could not delete media file');
          }
        }
      }
      
      clearResults.cleared_components.media_files = {
        count: mediaCount,
        status: 'cleared'
      };
      clearResults.total_items_cleared += mediaCount;
      
      logger.info({ deletedMediaFiles: mediaCount }, 'Media files cleared');
    } catch (e) {
      clearResults.errors.push(`Media files: ${e.message}`);
      clearResults.cleared_components.media_files = { status: 'failed', error: e.message };
    }

    // 9. Clear WhatsApp sessions (logout and clear session data)
    try {
      let sessionCount = 0;
      
      // Logout all active sessions
      for (const [sessionId, sessionState] of sessions.entries()) {
        try {
          if (sessionState.client) {
            await sessionState.client.logout();
            await sessionState.client.destroy();
          }
          sessionCount++;
        } catch (logoutErr) {
          logger.warn({ sessionId, error: logoutErr.message }, 'Error logging out session');
        }
      }
      
      // Clear sessions map
      sessions.clear();
      
      // Clear WhatsApp auth directory
      const authDir = path.resolve('.wwebjs_auth');
      if (fs.existsSync(authDir)) {
        await fs.promises.rm(authDir, { recursive: true, force: true });
      }
      
      clearResults.cleared_components.whatsapp_sessions = {
        count: sessionCount,
        status: 'cleared'
      };
      clearResults.total_items_cleared += sessionCount;
      
      logger.info({ deletedSessions: sessionCount }, 'WhatsApp sessions cleared');
    } catch (e) {
      clearResults.errors.push(`WhatsApp sessions: ${e.message}`);
      clearResults.cleared_components.whatsapp_sessions = { status: 'failed', error: e.message };
    }

    // 10. Clear Google Sheets credentials (optional - commented out for safety)
    try {
      const googleCredsFile = path.join(DATA_DIR, 'google_service_account.json');
      if (fs.existsSync(googleCredsFile)) {
        // Create backup before clearing (safety measure)
        await fs.promises.copyFile(googleCredsFile, `${googleCredsFile}.backup`);
        await fs.promises.unlink(googleCredsFile);
        
        clearResults.cleared_components.google_credentials = {
          status: 'cleared',
          backup_created: true
        };
        
        logger.info('Google credentials cleared (backup created)');
      } else {
        clearResults.cleared_components.google_credentials = {
          status: 'not_found'
        };
      }
    } catch (e) {
      clearResults.errors.push(`Google credentials: ${e.message}`);
      clearResults.cleared_components.google_credentials = { status: 'failed', error: e.message };
    }

    // Determine overall success
    clearResults.success = clearResults.errors.length === 0;
    
    if (clearResults.success) {
      logger.warn({ totalCleared: clearResults.total_items_cleared }, 'ALL DATA CLEARED SUCCESSFULLY');
    } else {
      logger.error({ errors: clearResults.errors }, 'Some errors occurred during data clearing');
    }
    
    res.json(clearResults);

  } catch (err) {
    logger.error({ error: err.message }, 'Critical error during clear all data operation');
    res.status(500).json({ 
      success: false,
      error: 'Critical error during data clearing',
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

async function getContactsSafe(state) {
  try {
    return await state.client.getContacts();
  } catch (err) {
    const msg = String(err || '');
    // Workaround for newer WhatsApp builds where getIsMyContact is missing
    if (msg.includes('getIsMyContact is not a function')) {
      logger.warn({ sessionId: state?.client?.options?.authStrategy?._id }, 'Falling back to chats-based contact list');
      try {
        const chats = await state.client.getChats();
        const dedup = new Map();
        for (const chat of chats) {
          try {
            const contact = await chat.getContact();
            const key = contact?.id?._serialized;
            if (key && !dedup.has(key)) {
              dedup.set(key, contact);
            }
          } catch {}
        }
        return Array.from(dedup.values());
      } catch (fallbackErr) {
        logger.error({ error: String(fallbackErr) }, 'Fallback contact load failed');
        throw fallbackErr;
      }
    }
    throw err;
  }
}

// Get contacts for a session
app.get('/api/contacts/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  try {
    const state = sessions.get(sessionId);
    
    if (!state || !state.isReady) {
      return res.status(400).json({ error: 'Session not ready' });
    }
    
    const contacts = await getContactsSafe(state);
    
    // Filter and format contacts
    const formattedContacts = contacts
      .filter(contact => contact.id && contact.id._serialized)
      .map(contact => ({
        id: contact.id,
        name: contact.name,
        pushname: contact.pushname,
        formattedName: contact.formattedName,
        number: contact.number,
        isGroup: contact.isGroup || false,
        isUser: contact.isUser || false,
        isWAContact: contact.isWAContact || false
      }));
    
    res.json(formattedContacts);
  } catch (e) {
    logger.error({ sessionId, error: String(e) }, 'Failed to get contacts');
    res.status(500).json({ error: String(e) });
  }
});

// Get chats for a session with pagination
app.get('/api/chats/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  try {
    const { limit = 100, offset = 0, timeout = 30000 } = req.query;
    
    const state = sessions.get(sessionId);
    
    if (!state || !state.isReady) {
      return res.status(400).json({ error: 'Session not ready' });
    }
    
    // Set up timeout for the entire operation
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout - too many chats to load')), parseInt(timeout));
    });
    
    const loadChatsPromise = (async () => {
      const chats = await state.client.getChats();
      const totalChats = chats.length;
      
      // Apply pagination
      const startIndex = parseInt(offset);
      const endIndex = startIndex + parseInt(limit);
      const paginatedChats = chats.slice(startIndex, endIndex);
      
      // Process chats in smaller batches to avoid memory issues
      const batchSize = 10;
      const formattedChats = [];
      
      for (let i = 0; i < paginatedChats.length; i += batchSize) {
        const batch = paginatedChats.slice(i, i + batchSize);
        
        const batchResults = await Promise.all(batch.map(async (chat) => {
          try {
            const contact = await chat.getContact();
            // Try to fetch the most recent message for preview/time like phone app
            let lastText = '';
            let lastTimestamp = chat.timestamp;
            let profilePicUrl = null;
            try {
              const msgs = await chat.fetchMessages({ limit: 1 });
              const last = Array.isArray(msgs) && msgs.length ? msgs[0] : null;
              if (last) {
                lastText = typeof last.body === 'string' && last.body.trim().length
                  ? last.body.trim()
                  : (last.hasMedia ? '[Media]' : '');
                lastTimestamp = last.timestamp || lastTimestamp;
              }
            } catch {}
            try {
              if (contact && typeof contact.getProfilePicUrl === 'function') {
                profilePicUrl = await contact.getProfilePicUrl();
              }
            } catch {}
            return {
              id: chat.id,
              name: chat.name,
              isGroup: chat.isGroup,
              isReadOnly: chat.isReadOnly,
              unreadCount: chat.unreadCount,
              timestamp: chat.timestamp,
              lastText,
              lastTimestamp,
              profilePicUrl,
              contact: contact ? {
                id: contact.id,
                name: contact.name,
                pushname: contact.pushname,
                formattedName: contact.formattedName,
                number: contact.number,
                isGroup: contact.isGroup || false
              } : null
            };
          } catch (error) {
            logger.warn({ sessionId, chatId: chat.id?._serialized, error: String(error) }, 'Failed to get contact for chat');
            return {
              id: chat.id,
              name: chat.name,
              isGroup: chat.isGroup,
              isReadOnly: chat.isReadOnly,
              unreadCount: chat.unreadCount,
              timestamp: chat.timestamp,
              contact: null
            };
          }
        }));
        
        formattedChats.push(...batchResults);
        
        // Small delay between batches to prevent overwhelming the system
        if (i + batchSize < paginatedChats.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      return {
        chats: formattedChats,
        total: totalChats,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: endIndex < totalChats
      };
    })();
    
    const result = await Promise.race([loadChatsPromise, timeoutPromise]);
    res.json(result);
    
  } catch (e) {
    const msg = String(e || '');
    logger.error({ sessionId, error: msg }, 'Failed to get chats');
    // If chromium page/session is closed, trigger reconnect and inform client
    if (msg.includes('Session closed') || msg.includes('browser has disconnected') || msg.includes('Target closed')) {
      try { await triggerReconnect(sessionId); } catch {}
      return res.status(503).json({ error: 'whatsapp_session_closed', message: 'Session closed. Reconnecting…', reconnecting: true });
    }
    
    // Provide more specific error messages
    if (msg.includes('timeout')) {
      res.status(408).json({ 
        error: 'Request timeout - your contact list is too large. Try using pagination with smaller limits.',
        suggestion: 'Use ?limit=50&offset=0 to load contacts in smaller batches'
      });
    } else if (msg.includes('memory') || msg.includes('heap')) {
      res.status(507).json({ 
        error: 'Insufficient memory to load all chats. Please use pagination.',
        suggestion: 'Use ?limit=25&offset=0 to reduce memory usage'
      });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// Send message to contact
app.post('/api/send-message', async (req, res) => {
  const { sessionId, phone, message, mediaPath, caption } = req.body;
  try {
    
    if (!sessionId || !phone) {
      return res.status(400).json({ error: 'sessionId and phone are required' });
    }
    
    const state = sessions.get(sessionId);
    if (!state || !state.isReady) {
      return res.status(400).json({ error: 'Session not ready' });
    }
    
    // Create item object for sendItem function
    const item = { phone: phone };
    if (mediaPath) { item.mediaPath = mediaPath; if (caption) item.caption = caption; if (message && !caption) item.message = message; }
    else { item.message = message || ''; }
    
    // Send the message
    await sendItem(state, item);
    
    logger.info({ sessionId, phone, messageLength: (message ? message.length : 0) }, 'Message sent successfully');
    // Activate human takeover automatically when owner replies manually
    try {
      const chatId = phone.includes('@c.us') ? phone : `${String(phone).replace(/[^0-9]/g,'')}@c.us`;
      setHumanOverride(sessionId, chatId, 15, 'all');
      logger.info({ sessionId, chatId }, 'Activated human takeover for 15 minutes after manual send');
    } catch {}
    res.json({ 
      success: true, 
      message: 'Message sent successfully',
      phone: phone,
      sessionId: sessionId
    });
    
  } catch (e) {
    logger.error({ sessionId, phone, error: String(e) }, 'Failed to send message');
    res.status(500).json({ error: String(e) });
  }
});

// Get message history for a contact
app.get('/api/messages/:sessionId/:contactId', async (req, res) => {
  const { sessionId, contactId } = req.params;
  try {
    const { limit = 50 } = req.query;
    
    const state = sessions.get(sessionId);
    if (!state || !state.isReady) {
      return res.status(400).json({ error: 'Session not ready' });
    }
    
    try {
      // Get chat by contact ID
      const chat = await state.client.getChatById(contactId);
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }
      
      // Try to fetch messages from the chat
      let messages = [];
      try {
        messages = await chat.fetchMessages({ limit: parseInt(limit) });
      } catch (fetchError) {
        logger.warn({ sessionId, contactId, error: String(fetchError) }, 'Failed to fetch messages, returning empty array');
        // Return empty messages array instead of failing
        return res.json({
          contactId: contactId,
          chatName: chat.name || 'Unknown',
          isGroup: chat.isGroup || false,
          messages: [],
          total: 0,
          warning: 'Unable to load message history. Chat may not exist or be corrupted.'
        });
      }
      
      // Format messages
      const formattedMessages = messages.map(msg => ({
        id: msg.id._serialized,
        body: msg.body,
        from: msg.from,
        to: msg.to,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        type: msg.type,
        hasMedia: msg.hasMedia,
        mediaType: msg.hasMedia ? msg.type : null,
        quotedMsg: msg.quotedMsg ? {
          id: msg.quotedMsg.id._serialized,
          body: msg.quotedMsg.body,
          fromMe: msg.quotedMsg.fromMe
        } : null,
        ack: msg.ack,
        isStatus: msg.isStatus,
        isForwarded: msg.isForwarded
      }));
      
      res.json({
        contactId: contactId,
        chatName: chat.name,
        isGroup: chat.isGroup,
        messages: formattedMessages,
        total: formattedMessages.length
      });
      
    } catch (chatError) {
      // Handle specific WhatsApp Web errors
      if (String(chatError).includes('Lid is missing') || 
          String(chatError).includes('chat table') ||
          String(chatError).includes('Evaluation failed')) {
        
        logger.warn({ sessionId, contactId, error: String(chatError) }, 'WhatsApp Web chat error - chat may not exist');
        
        return res.json({
          contactId: contactId,
          chatName: 'Unknown',
          isGroup: false,
          messages: [],
          total: 0,
          warning: 'Chat not found or corrupted. This contact may not have an active chat history.',
          error: 'Chat table error - contact may need to be contacted first'
        });
      }
      
      throw chatError;
    }
    
  } catch (e) {
    logger.error({ sessionId, contactId, error: String(e) }, 'Failed to get messages');
    res.status(500).json({ error: String(e) });
  }
});

// Get sent messages from queue database
app.get('/api/sent-messages/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  try {
    const { limit = 100, offset = 0 } = req.query;
    
    // Get sent messages from queue database
    const sentMessages = queue.db.prepare(`
      SELECT 
        j.id,
        j.campaign_id,
        j.phone,
        j.message,
        j.caption,
        j.media_path,
        j.status,
        j.created_at,
        j.updated_at,
        c.meta as campaign_meta
      FROM jobs j
      LEFT JOIN campaigns c ON j.campaign_id = c.id
      WHERE j.session_id = ? AND j.status = 'sent'
      ORDER BY j.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(sessionId, parseInt(limit), parseInt(offset));
    
    // Get total count
    const totalCount = queue.db.prepare(`
      SELECT COUNT(*) as count
      FROM jobs
      WHERE session_id = ? AND status = 'sent'
    `).get(sessionId).count;
    
    res.json({
      messages: sentMessages,
      total: totalCount,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    
  } catch (e) {
    logger.error({ sessionId, error: String(e) }, 'Failed to get sent messages');
    res.status(500).json({ error: String(e) });
  }
});

// System health endpoint
app.get('/api/admin/health', (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'healthy',
        sessions: sessions.size >= 0 ? 'healthy' : 'warning',
        flows: savedFlows.size >= 0 ? 'healthy' : 'warning',
        cron: 'healthy'
      },
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        external: Math.round(process.memoryUsage().external / 1024 / 1024)
      },
      uptime: Math.round(process.uptime())
    };
    
    res.json(health);
  } catch (e) {
    res.status(500).json({ 
      status: 'error',
      error: String(e),
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  return res.json({ filename: req.file.filename, url: `/uploads/${req.file.filename}` });
});

// Queue controls and stats
app.post('/api/queue/pause', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) {
    const w = workers.get(sessionId);
    if (w) w.paused = true;
  } else {
    for (const [, w] of workers.entries()) w.paused = true;
  }
  res.json({ ok: true });
});

app.post('/api/queue/resume', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) {
    const w = workers.get(sessionId);
    if (w) w.paused = false;
  } else {
    for (const [, w] of workers.entries()) w.paused = false;
  }
  res.json({ ok: true });
});

app.get('/api/queue/stats', (_req, res) => {
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

app.get('/api/campaign/:id/export', (req, res) => {
  const csv = queue.exportCsv(req.params.id);
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="${req.params.id}.csv"`);
  res.send(csv);
});

app.get('/api/campaigns', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 10));
  const page = Math.max(0, Number(req.query.page) || 0);
  const offset = page * limit;
  res.json({ campaigns: queue.listCampaigns(limit, offset), page, limit });
});

// Simple in-memory flow storage with file persistence
const savedFlows = new Map();
const flowsFile = path.join(process.cwd(), 'data', 'flows.json');
const flowAnalytics = new Map(); // Track flow execution stats
const cronJobs = new Map(); // Track cron jobs for flows
const userTags = new Map(); // Track user tags: phone -> Set of tags
const userTagsFile = path.join(process.cwd(), 'data', 'user_tags.json');

// Load flows from file on startup
try {
  // Ensure data directory exists
  const dataDir = path.dirname(flowsFile);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  if (fs.existsSync(flowsFile)) {
    const data = fs.readFileSync(flowsFile, 'utf8');
    const flows = JSON.parse(data);
    flows.forEach(flow => savedFlows.set(flow.id, flow));
    logger.info({ count: flows.length }, 'Loaded saved flows from file');
  }
} catch (e) {
  logger.error({ error: String(e) }, 'Failed to load flows from file');
}

// Save flows to file
function saveFlowsToFile() {
  try {
    const flows = Array.from(savedFlows.values());
    fs.writeFileSync(flowsFile, JSON.stringify(flows, null, 2));
    logger.info({ count: flows.length }, 'Saved flows to file');
  } catch (e) {
    logger.error({ error: String(e) }, 'Failed to save flows to file');
  }
}

// Load user tags from file
function loadUserTagsFromFile() {
  try {
    if (fs.existsSync(userTagsFile)) {
      const data = JSON.parse(fs.readFileSync(userTagsFile, 'utf8'));
      for (const [phone, tags] of Object.entries(data)) {
        userTags.set(phone, new Set(tags));
      }
      logger.info({ count: userTags.size }, 'Loaded user tags from file');
    }
  } catch (e) {
    logger.error({ error: String(e) }, 'Failed to load user tags from file');
  }
}

// Save user tags to file
function saveUserTagsToFile() {
  try {
    const data = {};
    for (const [phone, tags] of userTags.entries()) {
      data[phone] = Array.from(tags);
    }
    fs.writeFileSync(userTagsFile, JSON.stringify(data, null, 2));
    logger.info({ count: userTags.size }, 'Saved user tags to file');
  } catch (e) {
    logger.error({ error: String(e) }, 'Failed to save user tags to file');
  }
}

// Flow Builder API
app.get('/api/flows', (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    const flows = Array.from(savedFlows.values()).filter(f => !sessionId || f.sessionId === sessionId);
    logger.info({ count: flows.length, sessionId }, 'Retrieved flows');
    res.json({ flows });
  } catch (e) {
    logger.error({ error: String(e) }, 'Failed to retrieve flows');
    res.status(500).json({ error: String(e) });
  }
});

// Test endpoint to check if flows API is working
app.get('/api/flows/test', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Flows API is working',
    flowsCount: savedFlows.size,
    timestamp: new Date().toISOString()
  });
});

// User tags API
app.get('/api/user-tags', (req, res) => {
  try {
    const phone = req.query.phone;
    if (phone) {
      const tags = userTags.get(phone) ? Array.from(userTags.get(phone)) : [];
      res.json({ phone, tags });
    } else {
      const allTags = {};
      for (const [phone, tags] of userTags.entries()) {
        allTags[phone] = Array.from(tags);
      }
      res.json({ userTags: allTags });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/user-tags', (req, res) => {
  try {
    const { phone, tag, action } = req.body || {};
    if (!phone || !tag) return res.status(400).json({ error: 'phone and tag required' });
    
    if (!userTags.has(phone)) {
      userTags.set(phone, new Set());
    }
    
    const userTagSet = userTags.get(phone);
    
    switch (action) {
      case 'add':
        userTagSet.add(tag);
        break;
      case 'remove':
        userTagSet.delete(tag);
        break;
      case 'replace':
        userTags.set(phone, new Set([tag]));
        break;
      default:
        return res.status(400).json({ error: 'action must be add, remove, or replace' });
    }
    
    saveUserTagsToFile();
    res.json({ phone, tags: Array.from(userTagSet) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Debug endpoint for testing conditions
app.post('/api/flows/debug', (req, res) => {
  try {
    const { sessionId, phone, message, trigger } = req.body || {};
    
    // Create test context
    const userData = {
      phone: phone || '201001234567',
      messageCount: 0,
      lastMessage: message || 'test message'
    };
    
    const messageData = {
      messageText: message || 'test message',
      senderName: 'Test User',
      senderPhone: phone || '201001234567',
      chatTitle: 'Test Chat'
    };
    
    const context = { userData, messageData, sessionId: sessionId || '00' };
    
    // Test trigger evaluation if provided
    if (trigger) {
      const wouldTrigger = evaluateTrigger(trigger, message || 'test message', 'test_chat', sessionId || '00');
      res.json({ 
        wouldTrigger,
        trigger,
        context: {
          userData,
          messageData,
          userTags: userTags.has(userData.phone) ? Array.from(userTags.get(userData.phone)) : []
        }
      });
      return;
    }
    
    // Test condition evaluation
    const { conditionType, condition } = req.body;
    if (conditionType && condition) {
      const fullCondition = `${conditionType}:${condition}`;
      const result = evaluateCondition(fullCondition, context);
      res.json({ 
        conditionType,
        condition,
        result,
        context: {
          userData,
          messageData,
          userTags: userTags.has(userData.phone) ? Array.from(userTags.get(userData.phone)) : []
        }
      });
      return;
    }
    
    res.json({ 
      message: 'Debug endpoint - provide trigger or conditionType+condition',
      context: {
        userData,
        messageData,
        userTags: userTags.has(userData.phone) ? Array.from(userTags.get(userData.phone)) : []
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Cron schedule information endpoint
app.get('/api/cron/schedule', (req, res) => {
  try {
    const cronFlows = [];
    
    for (const [flowId, flow] of savedFlows.entries()) {
      const triggerNode = flow.nodes.find(node => node.type === 'trigger');
      if (triggerNode && triggerNode.data.triggerType === 'cron') {
        cronFlows.push({
          flowId,
          flowName: flow.name,
          sessionId: flow.sessionId,
          cronExpression: triggerNode.data.condition,
          cronType: triggerNode.data.cronType || 'advanced',
          description: triggerNode.data.description || '',
          nextExecution: calculateNextCronExecution(triggerNode.data.condition)
        });
      }
    }
    
    res.json({
      cronFlows,
      totalCronFlows: cronFlows.length,
      schedulerStatus: 'running',
      lastCheck: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Helper function to calculate next cron execution
function calculateNextCronExecution(cronExpression) {
  if (!cronExpression) return null;
  
  try {
    const now = new Date();
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    
    const [minute, hour, day, month, weekday] = parts;
    
    // Find next execution time
    let nextRun = new Date(now);
    nextRun.setSeconds(0, 0);
    
    // Simple calculation for common patterns
    if (minute !== '*' && hour !== '*') {
      nextRun.setMinutes(parseInt(minute));
      nextRun.setHours(parseInt(hour));
      
      // If time has passed today, move to next day
      if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1);
      }
      
      // Handle weekday restrictions
      if (weekday !== '*') {
        const targetDays = weekday.split(',').map(d => parseInt(d));
        while (!targetDays.includes(nextRun.getDay())) {
          nextRun.setDate(nextRun.getDate() + 1);
        }
      }
      
      // Handle day of month restrictions
      if (day !== '*') {
        const targetDay = parseInt(day);
        if (nextRun.getDate() !== targetDay) {
          nextRun.setDate(targetDay);
          if (nextRun <= now) {
            nextRun.setMonth(nextRun.getMonth() + 1);
            nextRun.setDate(targetDay);
          }
        }
      }
    }
    
    return nextRun.toISOString();
  } catch (e) {
    return null;
  }
}

app.post('/api/flows', (req, res) => {
  try {
    const { name, sessionId, tags, nodes, edges, enabled = true } = req.body || {};
    logger.info({ name, sessionId, tags, nodeCount: nodes?.length, edgeCount: edges?.length, enabled }, 'Creating new flow');
    
    if (!name) return res.status(400).json({ error: 'name required' });
    
    const flow = {
      id: Date.now().toString(),
      name,
      sessionId,
      tags: tags || [],
      nodes,
      edges,
      enabled: enabled !== false, // Default to enabled
      createdAt: new Date().toISOString()
    };
    
    savedFlows.set(flow.id, flow);
    saveFlowsToFile(); // Persist to file
    logger.info({ flowId: flow.id, name, tags }, 'Flow created successfully');
    res.json(flow);
  } catch (e) {
    logger.error({ error: String(e) }, 'Failed to create flow');
    res.status(500).json({ error: String(e) });
  }
});

// Toggle flow enabled/disabled state
app.patch('/api/flows/:id/toggle', (req, res) => {
  try {
    const { id } = req.params;
    const flow = savedFlows.get(id);
    
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    // Toggle the enabled state
    flow.enabled = !flow.enabled;
    flow.updatedAt = new Date().toISOString();
    
    savedFlows.set(id, flow);
    saveFlowsToFile();
    
    logger.info({ flowId: id, name: flow.name, enabled: flow.enabled }, 'Flow toggled');
    res.json({ 
      id: flow.id, 
      name: flow.name, 
      enabled: flow.enabled,
      message: `Flow ${flow.enabled ? 'enabled' : 'disabled'} successfully`
    });
    
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to toggle flow');
    res.status(500).json({ error: 'Failed to toggle flow' });
  }
});

app.put('/api/flows/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, sessionId, tags, nodes, edges } = req.body || {};
    logger.info({ id, name, sessionId, tags, nodeCount: nodes?.length, edgeCount: edges?.length }, 'Updating flow');
    
    if (!savedFlows.has(id)) {
      logger.warn({ id }, 'Flow not found for update');
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    if (!name) return res.status(400).json({ error: 'name required' });
    
    const existingFlow = savedFlows.get(id);
    const updatedFlow = {
      ...existingFlow,
      name,
      sessionId,
      tags: tags || [],
      nodes,
      edges,
      updatedAt: new Date().toISOString()
    };
    
    savedFlows.set(id, updatedFlow);
    saveFlowsToFile(); // Persist to file
    logger.info({ id, name, tags }, 'Flow updated successfully');
    res.json(updatedFlow);
  } catch (e) {
    logger.error({ id, error: String(e) }, 'Failed to update flow');
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/flows/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (savedFlows.has(id)) {
      savedFlows.delete(id);
      saveFlowsToFile(); // Persist to file
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Flow not found' });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Debug endpoint to test flow triggers
app.post('/api/flows/debug', (req, res) => {
  try {
    const { sessionId, message, phone } = req.body || {};
    if (!sessionId || !message) return res.status(400).json({ error: 'sessionId and message required' });
    
    const flows = Array.from(savedFlows.values()).filter(f => f.sessionId === sessionId);
    const results = [];
    
    for (const flow of flows) {
      const triggerNode = flow.nodes.find(n => n.type === 'trigger');
      if (!triggerNode) {
        results.push({ flowId: flow.id, flowName: flow.name, error: 'No trigger node' });
        continue;
      }
      
      const shouldTrigger = evaluateTrigger(triggerNode, message, phone || 'test', sessionId);
      const analytics = flowAnalytics.get(flow.id) || { executions: 0, successes: 0, failures: 0, lastExecuted: null };
      
      results.push({
        flowId: flow.id,
        flowName: flow.name,
        triggerType: triggerNode.data?.triggerType,
        condition: triggerNode.data?.condition,
        shouldTrigger,
        nodes: flow.nodes.length,
        analytics
      });
    }
    
    res.json({ 
      sessionId, 
      testMessage: message, 
      flowsFound: flows.length, 
      results 
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Flow analytics endpoint
app.get('/api/flows/analytics', (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    const flows = Array.from(savedFlows.values()).filter(f => !sessionId || f.sessionId === sessionId);
    
    const analytics = flows.map(flow => ({
      flowId: flow.id,
      flowName: flow.name,
      sessionId: flow.sessionId,
      nodes: flow.nodes.length,
      edges: flow.edges.length,
      createdAt: flow.createdAt,
      stats: flowAnalytics.get(flow.id) || { executions: 0, successes: 0, failures: 0, lastExecuted: null }
    }));
    
    res.json({ analytics });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Enhanced condition evaluation with branching logic
function evaluateCondition(condition, context) {
  const { userData, systemVars, messageData } = context;
  
  try {
    // Parse condition type and parameters
    const parts = condition.split(':');
    const type = parts[0];
    const params = parts.slice(1);
    
    switch (type) {
      case 'equals':
        return userData[params[0]] === params[1];
      case 'contains':
        return (userData[params[0]] || '').toLowerCase().includes(params[1].toLowerCase());
      case 'greater_than':
        return Number(userData[params[0]] || 0) > Number(params[1]);
      case 'less_than':
        return Number(userData[params[0]] || 0) < Number(params[1]);
      case 'time_between':
        const now = new Date();
        const start = new Date(`${now.toDateString()} ${params[0]}`);
        const end = new Date(`${now.toDateString()} ${params[1]}`);
        return now >= start && now <= end;
      case 'day_of_week':
        const day = now.getDay();
        const targetDays = params[0].split(',').map(d => Number(d));
        return targetDays.includes(day);
      case 'message_count':
        return (userData.messageCount || 0) >= Number(params[0]);
      case 'has_media':
        return messageData.hasMedia || false;
      case 'is_group':
        return messageData.isGroup || false;
      case 'has_tag':
        // Check if user has specific tag
        const phone = userData.phone;
        const tagToCheck = params[0];
        logger.info({ 
          phone, 
          tagToCheck, 
          hasUserTags: userTags.has(phone),
          userTags: userTags.has(phone) ? Array.from(userTags.get(phone)) : []
        }, 'Checking has_tag condition');
        if (phone && userTags.has(phone)) {
          const result = userTags.get(phone).has(tagToCheck);
          logger.info({ phone, tagToCheck, result }, 'has_tag result');
          return result;
        }
        return false;
      case 'has_any_tag':
        // Check if user has any of the specified tags
        const phoneAny = userData.phone;
        const tagsToCheck = params[0].split(',').map(t => t.trim());
        if (phoneAny && userTags.has(phoneAny)) {
          const userTagSet = userTags.get(phoneAny);
          return tagsToCheck.some(tag => userTagSet.has(tag));
        }
        return false;
      case 'has_all_tags':
        // Check if user has all of the specified tags
        const phoneAll = userData.phone;
        const allTagsToCheck = params[0].split(',').map(t => t.trim());
        if (phoneAll && userTags.has(phoneAll)) {
          const userTagSet = userTags.get(phoneAll);
          return allTagsToCheck.every(tag => userTagSet.has(tag));
        }
        return false;
      default:
        return false;
    }
  } catch (e) {
    logger.error({ error: String(e), condition }, 'Error evaluating condition');
    return false;
  }
}

// Dynamic variables system
function replaceDynamicVars(text, context) {
  const { userData, systemVars, messageData } = context;
  
  // Use the enhanced replaceSystemVars function for date/time variables
  text = replaceSystemVars(text);
  
  // Additional context-specific variables
  text = text.replace(/\{session_id\}/g, context.sessionId || '');
  text = text.replace(/\{random_number\}/g, Math.floor(Math.random() * 1000));
  
  // User data variables
  Object.keys(userData).forEach(key => {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    text = text.replace(regex, userData[key] || '');
  });
  
  // Message data variables
  text = text.replace(/\{sender_name\}/g, messageData.senderName || '');
  text = text.replace(/\{sender_phone\}/g, messageData.senderPhone || '');
  text = text.replace(/\{message_text\}/g, messageData.messageText || '');
  text = text.replace(/\{chat_title\}/g, messageData.chatTitle || '');
  
  // User tag variables
  const phone = userData?.phone;
  if (phone && userTags.has(phone)) {
    const tags = Array.from(userTags.get(phone));
    text = text.replace(/\{user_tags\}/g, tags.join(', '));
    text = text.replace(/\{user_tags_count\}/g, tags.length.toString());
    
    // Individual tag access: {user_tags_0}, {user_tags_1}, etc.
    tags.forEach((tag, index) => {
      text = text.replace(new RegExp(`\\{user_tags_${index}\\}`, 'g'), tag);
    });
    
    // Check if user has specific tag: {has_tag_vip}, {has_tag_premium}, etc.
    tags.forEach(tag => {
      text = text.replace(new RegExp(`\\{has_tag_${tag}\\}`, 'g'), 'true');
    });
  } else {
    text = text.replace(/\{user_tags\}/g, '');
    text = text.replace(/\{user_tags_count\}/g, '0');
  }
  
  // Handle has_tag_ variables for tags user doesn't have
  text = text.replace(/\{has_tag_([^}]+)\}/g, 'false');
  
  return text;
}

// Enhanced trigger evaluation with advanced types
function evaluateTrigger(trigger, message, chatId, sessionId) {
  const { triggerType, condition } = trigger.data || {};
  
  logger.info({ 
    triggerType, 
    condition, 
    message, 
    messageLength: message?.length,
    hasCondition: !!condition,
    hasMessage: !!message
  }, 'Evaluating trigger');
  
  try {
    switch (triggerType) {
      case 'keyword':
        if (!condition || !message) {
          logger.warn({ condition, message }, 'Keyword trigger missing condition or message');
          return false;
        }
        const keywords = condition.toLowerCase().split(',').map(k => k.trim());
        const messageLower = message.toLowerCase();
        const matches = keywords.filter(keyword => messageLower.includes(keyword));
        
        logger.info({ 
          keywords, 
          messageLower, 
          matches, 
          willTrigger: matches.length > 0 
        }, 'Keyword matching details');
        
        return matches.length > 0;
        
      case 'time':
        const now = new Date();
        const [startTime, endTime] = condition.split('-');
        const start = new Date(`${now.toDateString()} ${startTime}`);
        const end = new Date(`${now.toDateString()} ${endTime}`);
        return now >= start && now <= end;
        
      case 'message_count':
        // This would need to be tracked per user
        return true; // Placeholder - would need user message count tracking
        
      case 'time_based':
        const [days, hours] = condition.split('|');
        const targetDays = days.split(',').map(d => Number(d));
        const targetHours = hours.split(',').map(h => Number(h));
        const currentDay = now.getDay();
        const currentHour = now.getHours();
        return targetDays.includes(currentDay) && targetHours.includes(currentHour);
        
      case 'user_behavior':
        // This would need user behavior tracking
        return true; // Placeholder - would need user behavior analysis
        
      case 'webhook':
        // This would trigger external webhook
        return true; // Placeholder - would need webhook integration
        
      case 'cron':
        // Cron triggers are handled separately by the cron scheduler
        // This function is for message-based triggers, so cron always returns false here
        return false;
        
      case 'always':
      default:
        return true;
    }
  } catch (e) {
    logger.error({ error: String(e), trigger }, 'Error evaluating trigger');
    return false;
  }
}

// Smart cron scheduler for flow triggers
function startCronScheduler() {
  logger.info('Starting smart cron scheduler for flow triggers');
  
  // Check every minute for cron triggers
  setInterval(() => {
    const now = new Date();
    let executedFlows = 0;
    
    for (const [flowId, flow] of savedFlows.entries()) {
      const triggerNode = flow.nodes.find(node => node.type === 'trigger');
      if (!triggerNode || triggerNode.data.triggerType !== 'cron') continue;
      
      const cronExpression = triggerNode.data.condition;
      if (!cronExpression) continue;
      
      // Check if cron expression matches current time
      if (isCronTimeMatch(cronExpression, now)) {
        logger.info({ 
          flowId, 
          flowName: flow.name, 
          cronExpression,
          cronType: triggerNode.data.cronType || 'advanced',
          time: now.toISOString()
        }, 'Cron trigger matched, executing flow');
        
        // Execute flow for the specified session
        const sessionId = flow.sessionId;
        const state = sessions.get(sessionId);
        
        if (state && state.isReady) {
          // For cron triggers, execute for all users with tags
          let userExecutions = 0;
          
          // Check if this flow has condition nodes that check for tags
          const hasTagConditions = flow.nodes.some(node => 
            node.type === 'condition' && 
            node.data?.conditionType && 
            ['has_tag', 'has_any_tag', 'has_all_tags'].includes(node.data.conditionType)
          );
          
          if (hasTagConditions) {
            // Execute for all users with tags
            for (const [phone, userTagSet] of userTags.entries()) {
              if (userTagSet && userTagSet.size > 0) {
                logger.info({ 
                  flowId, 
                  flowName: flow.name, 
                  phone, 
                  userTags: Array.from(userTagSet) 
                }, 'Executing cron flow for tagged user');
                
                executeFlow(flow, phone, sessionId, {
                  messageText: `Scheduled message from ${flow.name}`,
                  sender_name: 'System Scheduler',
                  sender_phone: 'system',
                  chat_title: 'Scheduled Flow',
                  isCronTrigger: true,
                  triggerTime: now.toISOString()
                }).catch(err => {
                  logger.error({ 
                    flowId, 
                    flowName: flow.name, 
                    phone, 
                    error: String(err) 
                  }, 'Cron flow execution failed for user');
                });
                
                userExecutions++;
              }
            }
          } else {
            // For flows without tag conditions, execute with system context
            executeFlow(flow, 'cron_trigger', sessionId, {
              messageText: `Scheduled message from ${flow.name}`,
              sender_name: 'System Scheduler',
              sender_phone: 'system',
              chat_title: 'Scheduled Flow',
              isCronTrigger: true,
              triggerTime: now.toISOString()
            });
            userExecutions = 1;
          }
          
          executedFlows += userExecutions;
          logger.info({ 
            flowId, 
            flowName: flow.name, 
            sessionId, 
            userExecutions 
          }, 'Cron flow executed successfully');
        } else {
          logger.warn({ 
            flowId, 
            flowName: flow.name, 
            sessionId, 
            isReady: state?.isReady 
          }, 'Cron flow skipped - session not ready');
        }
      }
    }
    
    if (executedFlows > 0) {
      logger.info({ executedFlows, time: now.toISOString() }, 'Cron scheduler completed execution cycle');
    }
  }, 60000); // Check every minute
}

// Simple cron expression matcher
function isCronTimeMatch(cronExpression, date) {
  try {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    
    const [minute, hour, day, month, weekday] = parts;
    
    // Check minute
    if (minute !== '*' && !isTimeMatch(minute, date.getMinutes())) return false;
    
    // Check hour
    if (hour !== '*' && !isTimeMatch(hour, date.getHours())) return false;
    
    // Check day of month
    if (day !== '*' && !isTimeMatch(day, date.getDate())) return false;
    
    // Check month
    if (month !== '*' && !isTimeMatch(month, date.getMonth() + 1)) return false;
    
    // Check weekday (0 = Sunday, 1 = Monday, etc.)
    if (weekday !== '*' && !isTimeMatch(weekday, date.getDay())) return false;
    
    return true;
  } catch (e) {
    logger.error({ cronExpression, error: String(e) }, 'Error parsing cron expression');
    return false;
  }
}

// Helper function to check if a time value matches a cron part
function isTimeMatch(cronPart, timeValue) {
  if (cronPart === '*') return true;
  
  // Handle ranges like "1-5"
  if (cronPart.includes('-')) {
    const [start, end] = cronPart.split('-').map(Number);
    return timeValue >= start && timeValue <= end;
  }
  
  // Handle lists like "1,3,5"
  if (cronPart.includes(',')) {
    const values = cronPart.split(',').map(Number);
    return values.includes(timeValue);
  }
  
  // Handle single value
  return Number(cronPart) === timeValue;
}

// Enhanced conversation memory storage
const conversationMemory = new Map(); // phone -> conversation history
const userProfiles = new Map(); // phone -> user profile data

// Enhanced AI Agent execution with memory and intelligence
async function executeAiAgentNode(node, state, context) {
  try {
    const { userData, systemVars, messageData, sessionId } = context;
    const apiKey = agentMgr.getApiKey();
    
    if (!apiKey) {
      logger.warn({ sessionId, nodeId: node.id }, 'AI Agent node skipped: no OpenAI API key configured');
      return;
    }
    
    // Extract node configuration with advanced defaults
    const model = node.data?.model || 'gpt-4o-mini';
    const temperature = parseFloat(node.data?.temperature) || 0.7;
    const maxTokens = parseInt(node.data?.maxTokens) || 500;
    const systemPrompt = node.data?.systemPrompt || '';
    const userPromptTemplate = node.data?.userPrompt || 'User message: {message_text}';
    const responseMode = node.data?.responseMode || 'send_reply';
    const variableName = node.data?.variableName || 'ai_response';
    
    // Advanced AI configuration
    const memoryLength = parseInt(node.data?.memoryLength) || 10; // Number of exchanges to remember
    const usePersonality = node.data?.usePersonality !== false;
    const useSentimentAnalysis = node.data?.useSentimentAnalysis !== false;
    const useContextAwareness = node.data?.useContextAwareness !== false;
    const learningMode = node.data?.learningMode !== false; // Learn from conversations
    
    const userPhone = userData.phone || messageData?.senderPhone || '';
    const currentMessage = messageData?.messageText || userData.lastMessage || '';
    
    // Get or create user profile
    const userProfile = await getOrCreateUserProfile(userPhone, {
      name: userData.sender_name || messageData?.senderName || 'User',
      phone: userPhone,
      sessionId: sessionId
    });
    
    // Get conversation memory
    const conversationHistory = getConversationMemory(userPhone, memoryLength);
    
    // Add current message to memory
    addToConversationMemory(userPhone, {
      role: 'user',
      content: currentMessage,
      timestamp: new Date().toISOString(),
      sentiment: null // Will be analyzed
    });
    
    // Analyze sentiment if enabled
    let sentimentAnalysis = null;
    if (useSentimentAnalysis && currentMessage) {
      sentimentAnalysis = await analyzeSentiment(currentMessage, apiKey);
      // Update the latest memory entry with sentiment
      updateLatestMemoryWithSentiment(userPhone, sentimentAnalysis);
    }
    
    // Build enhanced context for prompt replacement
    const promptContext = {
      ...userData,
      ...systemVars,
      message_text: currentMessage,
      sender_name: userProfile.name,
      sender_phone: userPhone,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      chat_history: formatConversationHistory(conversationHistory),
      user_profile: formatUserProfile(userProfile),
      conversation_summary: userProfile.conversationSummary || '',
      user_preferences: formatUserPreferences(userProfile.preferences || {}),
      sentiment: sentimentAnalysis ? formatSentiment(sentimentAnalysis) : '',
      conversation_count: conversationHistory.length,
      last_interaction: userProfile.lastInteraction || '',
      user_tags: Array.from(userTags.get(userPhone) || []).join(', ')
    };
    
    // Replace variables in prompts
    const finalUserPrompt = replaceDynamicVars(userPromptTemplate, { userData: promptContext, systemVars, messageData });
    
    // Build enhanced system prompt with personality and context
    let enhancedSystemPrompt = systemPrompt;
    if (usePersonality && userProfile.personality) {
      enhancedSystemPrompt += `\n\nUser Personality Profile: ${userProfile.personality}`;
    }
    if (useContextAwareness && userProfile.conversationSummary) {
      enhancedSystemPrompt += `\n\nConversation Context: ${userProfile.conversationSummary}`;
    }
    if (sentimentAnalysis) {
      enhancedSystemPrompt += `\n\nCurrent User Sentiment: ${sentimentAnalysis.emotion} (${sentimentAnalysis.confidence}% confidence). Adapt your response accordingly.`;
    }
    
    logger.info({ 
      sessionId, 
      nodeId: node.id, 
      model, 
      temperature, 
      maxTokens, 
      responseMode,
      phone: userPhone,
      hasMemory: conversationHistory.length > 0,
      sentiment: sentimentAnalysis?.emotion || 'neutral',
      userProfileComplete: !!(userProfile.personality && userProfile.preferences),
      memoryLength: conversationHistory.length
    }, 'Executing Enhanced AI Agent node');
    
    // Prepare OpenAI messages with conversation history
    const messages = [];
    
    // Add enhanced system prompt
    if (enhancedSystemPrompt) {
      messages.push({ role: 'system', content: enhancedSystemPrompt });
    }
    
    // Add relevant conversation history (excluding current message)
    const relevantHistory = conversationHistory.slice(0, -1); // Exclude current message
    for (const memory of relevantHistory.slice(-6)) { // Last 6 exchanges for context
      messages.push({
        role: memory.role,
        content: memory.content
      });
    }
    
    // Add current user prompt
    messages.push({ role: 'user', content: finalUserPrompt });
    
    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }
    
    const data = await response.json();
    const aiResponse = data.choices?.[0]?.message?.content;
    
    if (!aiResponse) {
      throw new Error('No response from AI model');
    }
    
    logger.info({ 
      sessionId, 
      nodeId: node.id, 
      phone: userPhone, 
      model, 
      responseLength: aiResponse.length,
      tokensUsed: data.usage?.total_tokens || 0,
      conversationTurn: conversationHistory.length
    }, 'Enhanced AI Agent generated response');
    
    // Add AI response to conversation memory
    addToConversationMemory(userPhone, {
      role: 'assistant',
      content: aiResponse,
      timestamp: new Date().toISOString(),
      model: model,
      tokens: data.usage?.total_tokens || 0
    });
    
    // Update user profile with learning
    if (learningMode) {
      await updateUserProfileFromConversation(userPhone, currentMessage, aiResponse, sentimentAnalysis);
    }
    
    // Handle response based on mode
    if (responseMode === 'send_reply' || responseMode === 'both') {
      // Send AI response to user
      try {
        await sendItem(state, {
          phone: userPhone,
          message: aiResponse
        });
        
        // Update user profile with successful interaction
        updateUserInteraction(userPhone, {
          type: 'ai_response_sent',
          timestamp: new Date().toISOString(),
          success: true
        });
        
        logger.info({ sessionId, nodeId: node.id, phone: userPhone }, 'Enhanced AI response sent to user');
      } catch (sendErr) {
        // Update user profile with failed interaction
        updateUserInteraction(userPhone, {
          type: 'ai_response_failed',
          timestamp: new Date().toISOString(),
          success: false,
          error: String(sendErr)
        });
        
        logger.error({ 
          sessionId, 
          nodeId: node.id, 
          phone: userPhone, 
          error: String(sendErr) 
        }, 'Failed to send AI response');
      }
    }
    
    if (responseMode === 'store_variable' || responseMode === 'both') {
      // Store response in variable for later use
      userData[variableName] = aiResponse;
      
      // Also store enhanced metadata
      userData[`${variableName}_metadata`] = {
        model: model,
        tokens: data.usage?.total_tokens || 0,
        sentiment: sentimentAnalysis,
        timestamp: new Date().toISOString(),
        conversationTurn: conversationHistory.length
      };
      
      logger.info({ 
        sessionId, 
        nodeId: node.id, 
        variableName, 
        phone: userPhone 
      }, 'Enhanced AI response stored in variable with metadata');
    }
    
    // Periodic conversation summarization for long conversations
    if (conversationHistory.length > 20 && conversationHistory.length % 10 === 0) {
      await summarizeAndPruneConversation(userPhone, apiKey);
    }
    
  } catch (error) {
    logger.error({ 
      sessionId: context.sessionId, 
      nodeId: node.id, 
      phone: context.userData?.phone,
      error: String(error) 
    }, 'AI Agent node execution failed');
  }
}

// Memory Management Functions

// Get or create user profile
async function getOrCreateUserProfile(phone, initialData = {}) {
  if (!userProfiles.has(phone)) {
    userProfiles.set(phone, {
      phone: phone,
      name: initialData.name || 'User',
      sessionId: initialData.sessionId,
      createdAt: new Date().toISOString(),
      lastInteraction: new Date().toISOString(),
      conversationSummary: '',
      personality: '',
      preferences: {},
      interactionHistory: [],
      sentimentHistory: [],
      totalConversations: 0,
      averageSentiment: 'neutral'
    });
  }
  
  const profile = userProfiles.get(phone);
  profile.lastInteraction = new Date().toISOString();
  return profile;
}

// Get conversation memory
function getConversationMemory(phone, limit = 10) {
  if (!conversationMemory.has(phone)) {
    conversationMemory.set(phone, []);
  }
  const history = conversationMemory.get(phone);
  return history.slice(-limit * 2); // Get last N exchanges (user + assistant pairs)
}

// Add to conversation memory
function addToConversationMemory(phone, entry) {
  if (!conversationMemory.has(phone)) {
    conversationMemory.set(phone, []);
  }
  const history = conversationMemory.get(phone);
  history.push(entry);
  
  // Keep memory manageable (max 100 entries)
  if (history.length > 100) {
    history.splice(0, 20); // Remove oldest 20 entries
  }
  
  conversationMemory.set(phone, history);
}

// Update latest memory with sentiment
function updateLatestMemoryWithSentiment(phone, sentiment) {
  const history = conversationMemory.get(phone);
  if (history && history.length > 0) {
    const latest = history[history.length - 1];
    if (latest.role === 'user') {
      latest.sentiment = sentiment;
    }
  }
}

// Sentiment analysis
async function analyzeSentiment(text, apiKey) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'system',
          content: 'Analyze the sentiment of the following text. Respond with JSON: {"emotion": "happy/sad/angry/frustrated/excited/neutral/confused", "confidence": 0-100, "intensity": "low/medium/high"}'
        }, {
          role: 'user',
          content: text
        }],
        temperature: 0.1,
        max_tokens: 100
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        return JSON.parse(content);
      }
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'Sentiment analysis failed');
  }
  
  return { emotion: 'neutral', confidence: 50, intensity: 'medium' };
}

// Update user profile from conversation
async function updateUserProfileFromConversation(phone, userMessage, aiResponse, sentiment) {
  const profile = userProfiles.get(phone);
  if (!profile) return;
  
  profile.totalConversations++;
  
  // Add to sentiment history
  if (sentiment) {
    profile.sentimentHistory.push({
      emotion: sentiment.emotion,
      confidence: sentiment.confidence,
      timestamp: new Date().toISOString()
    });
    
    // Keep only last 20 sentiment entries
    if (profile.sentimentHistory.length > 20) {
      profile.sentimentHistory = profile.sentimentHistory.slice(-20);
    }
    
    // Calculate average sentiment
    const emotions = profile.sentimentHistory.map(s => s.emotion);
    const mostCommon = emotions.reduce((a, b, i, arr) => 
      arr.filter(v => v === a).length >= arr.filter(v => v === b).length ? a : b
    );
    profile.averageSentiment = mostCommon;
  }
  
  // Extract user preferences and personality traits (simple keyword detection)
  const preferences = extractPreferences(userMessage);
  Object.assign(profile.preferences, preferences);
  
  // Update personality insights
  if (profile.sentimentHistory.length >= 5) {
    profile.personality = buildPersonalityProfile(profile);
  }
}

// Extract preferences from user message
function extractPreferences(message) {
  const preferences = {};
  const lowerMessage = message.toLowerCase();
  
  // Communication style preferences
  if (lowerMessage.includes('quick') || lowerMessage.includes('brief') || lowerMessage.includes('short')) {
    preferences.communicationStyle = 'brief';
  } else if (lowerMessage.includes('detail') || lowerMessage.includes('explain') || lowerMessage.includes('more info')) {
    preferences.communicationStyle = 'detailed';
  }
  
  // Time preferences
  if (lowerMessage.includes('morning') || lowerMessage.includes('early')) {
    preferences.preferredTime = 'morning';
  } else if (lowerMessage.includes('evening') || lowerMessage.includes('night')) {
    preferences.preferredTime = 'evening';
  }
  
  // Support style
  if (lowerMessage.includes('human') || lowerMessage.includes('person') || lowerMessage.includes('agent')) {
    preferences.supportStyle = 'human_preferred';
  }
  
  return preferences;
}

// Build personality profile
function buildPersonalityProfile(profile) {
  const traits = [];
  
  // Analyze sentiment patterns
  const emotions = profile.sentimentHistory.map(s => s.emotion);
  const happyCount = emotions.filter(e => e === 'happy' || e === 'excited').length;
  const sadCount = emotions.filter(e => e === 'sad' || e === 'frustrated').length;
  const neutralCount = emotions.filter(e => e === 'neutral').length;
  
  if (happyCount > emotions.length * 0.6) {
    traits.push('optimistic and positive');
  } else if (sadCount > emotions.length * 0.4) {
    traits.push('tends to be concerned or cautious');
  } else if (neutralCount > emotions.length * 0.7) {
    traits.push('practical and matter-of-fact');
  }
  
  // Communication style
  if (profile.preferences.communicationStyle === 'brief') {
    traits.push('prefers concise communication');
  } else if (profile.preferences.communicationStyle === 'detailed') {
    traits.push('appreciates detailed explanations');
  }
  
  // Interaction frequency
  if (profile.totalConversations > 10) {
    traits.push('frequent user who values the service');
  }
  
  return traits.join(', ');
}

// Update user interaction
function updateUserInteraction(phone, interaction) {
  const profile = userProfiles.get(phone);
  if (profile) {
    profile.interactionHistory.push(interaction);
    if (profile.interactionHistory.length > 50) {
      profile.interactionHistory = profile.interactionHistory.slice(-50);
    }
    profile.lastInteraction = new Date().toISOString();
  }
}

// Summarize and prune conversation
async function summarizeAndPruneConversation(phone, apiKey) {
  try {
    const history = conversationMemory.get(phone);
    if (!history || history.length < 10) return;
    
    // Get conversation text for summarization
    const conversationText = history.slice(0, -10).map(entry => 
      `${entry.role}: ${entry.content}`
    ).join('\n');
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'system',
          content: 'Summarize this conversation in 2-3 sentences, focusing on key topics, user needs, and outcomes.'
        }, {
          role: 'user',
          content: conversationText
        }],
        temperature: 0.3,
        max_tokens: 150
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      const summary = data.choices?.[0]?.message?.content;
      
      if (summary) {
        // Update user profile with summary
        const profile = userProfiles.get(phone);
        if (profile) {
          profile.conversationSummary = summary;
        }
        
        // Keep only recent conversation history
        conversationMemory.set(phone, history.slice(-20));
        
        logger.info({ phone, summaryLength: summary.length }, 'Conversation summarized and pruned');
      }
    }
  } catch (error) {
    logger.warn({ phone, error: String(error) }, 'Failed to summarize conversation');
  }
}

// Formatting functions for prompts
function formatConversationHistory(history) {
  return history.slice(-6).map(entry => 
    `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`
  ).join('\n');
}

function formatUserProfile(profile) {
  return `Name: ${profile.name}, Interactions: ${profile.totalConversations}, Avg Sentiment: ${profile.averageSentiment}`;
}

function formatUserPreferences(preferences) {
  return Object.entries(preferences).map(([key, value]) => `${key}: ${value}`).join(', ') || 'None discovered yet';
}

function formatSentiment(sentiment) {
  return `${sentiment.emotion} (${sentiment.confidence}% confidence, ${sentiment.intensity} intensity)`;
}

// Get recent chat history for AI context
async function getChatHistory(phone, sessionId, limit = 5) {
  try {
    const state = sessions.get(sessionId);
    if (!state || !state.client) return '';
    
    // Try to get recent messages from the chat
    const chat = await state.client.getChatById(phone);
    if (!chat) return '';
    
    const messages = await chat.fetchMessages({ limit });
    if (!messages || messages.length === 0) return '';
    
    // Format messages for AI context
    return messages.reverse().map(msg => {
      const sender = msg.fromMe ? 'Assistant' : 'User';
      const text = msg.body || '';
      return `${sender}: ${text}`;
    }).join('\n');
  } catch (error) {
    logger.warn({ phone, sessionId, error: String(error) }, 'Failed to get chat history');
    return '';
  }
}

// Enhanced message handler with flow triggers
function setupFlowTriggers(sessionId, client) {
  client.on('message', async (message) => {
    try {
      const takeover = getHumanOverride(sessionId, message.from);
      if (takeover && takeover.mode === 'all') {
        logger.info({ sessionId, chatId: message.from }, 'Human takeover active: blocking flow triggers');
        return;
      }
      // Get enabled flows for this session
      const allFlows = Array.from(savedFlows.values());
      const flows = allFlows.filter(f => f.sessionId === sessionId && f.enabled !== false);
      
      for (const flow of flows) {
        const triggerNode = flow.nodes.find(n => n.type === 'trigger');
        if (!triggerNode) continue;
        
        const shouldTrigger = evaluateTrigger(triggerNode, message.body, message.from, sessionId);
        if (shouldTrigger) {
          logger.info({ sessionId, flowId: flow.id, phone: message.from }, 'Flow triggered');
          // Execute flow
          await executeFlow(flow, message.from, sessionId);
        }
      }
    } catch (e) {
      logger.error({ sessionId, error: String(e) }, 'Flow trigger error');
    }
  });
}

// Execute individual node with enhanced context
async function executeNode(node, context, state) {
  const { userData, systemVars, messageData, sessionId } = context;
  
  try {
    if (node.type === 'send') {
      const msg = replaceDynamicVars(String(node.data?.message || ''), context);
      const caption = replaceDynamicVars(String(node.data?.caption || ''), context);
      const mediaPath = node.data?.mediaPath;
      
      logger.info({ sessionId, flowId: context.flowId, nodeId: node.id, message: msg, phone: userData.phone, hasMedia: !!mediaPath }, 'About to send message from flow');
      
      // Validate WhatsApp number before sending
      const validation = await validateWhatsAppNumber(state, userData.phone);
      if (!validation.valid) {
        logger.warn({ sessionId, flowId: context.flowId, nodeId: node.id, phone: userData.phone, error: validation.error }, 'Flow send failed: number validation failed');
        return; // Skip sending
      }
      
      try {
        await sendItem(state, { 
          phone: userData.phone, 
          message: msg, 
          mediaPath: mediaPath,
          caption: caption || msg
        });
        logger.info({ sessionId, flowId: context.flowId, nodeId: node.id, message: msg, phone: userData.phone }, 'Successfully sent message from flow');
      } catch (err) {
        logger.error({ sessionId, flowId: context.flowId, nodeId: node.id, message: msg, phone: userData.phone, error: String(err) }, 'Failed to send message from flow');
      }
    } else if (node.type === 'delay') {
      const sec = Math.max(0, Number(node.data?.seconds || 0));
      await sleep(sec * 1000);
    } else if (node.type === 'webhook') {
      const url = String(node.data?.url || '');
      const method = String(node.data?.method || 'POST');
      if (url) { 
        try { 
          await fetch(url, { method, body: JSON.stringify(context) }); 
        } catch {} 
      }
    } else if (node.type === 'set_variable') {
      // Set custom variables
      const varName = node.data?.variableName || '';
      const varValue = replaceDynamicVars(String(node.data?.variableValue || ''), context);
      if (varName) {
        userData[varName] = varValue;
      }
    } else if (node.type === 'tag_user') {
      // Tag user based on action
      const userTag = node.data?.userTag || '';
      const tagAction = node.data?.tagAction || 'add';
      const phone = userData.phone;
      
      if (userTag && phone) {
        if (!userTags.has(phone)) {
          userTags.set(phone, new Set());
        }
        
        const userTagSet = userTags.get(phone);
        
        switch (tagAction) {
          case 'add':
            userTagSet.add(userTag);
            logger.info({ phone, tag: userTag, action: 'add' }, 'Added tag to user');
            break;
          case 'remove':
            userTagSet.delete(userTag);
            logger.info({ phone, tag: userTag, action: 'remove' }, 'Removed tag from user');
            break;
          case 'replace':
            userTags.set(phone, new Set([userTag]));
            logger.info({ phone, tag: userTag, action: 'replace' }, 'Replaced all tags for user');
            break;
        }
        
        // Save user tags to file
        saveUserTagsToFile();
      }
    } else if (node.type === 'yes_no') {
      // Yes/No question - this would need to be handled by waiting for user response
      // For now, we'll just log the question
      logger.info({ sessionId, flowId: context.flowId, nodeId: node.id, question: node.data?.question }, 'Yes/No question asked');
    } else if (node.type === 'wait_response') {
      // Wait for user response - this would need to be handled by the flow execution system
      // For now, we'll just log the timeout
      const timeout = Math.max(5, Number(node.data?.timeout || 30));
      logger.info({ sessionId, flowId: context.flowId, nodeId: node.id, timeout }, 'Waiting for user response');
      // In a real implementation, this would pause the flow and wait for the next message
    } else if (node.type === 'ai_agent') {
      await executeAiAgentNode(node, state, context);
    } else if (node.type === 'redirect_flow') {
      // Redirect to another flow
      const targetFlowId = node.data?.targetFlow;
      const redirectMessage = node.data?.redirectMessage;
      
      if (targetFlowId) {
        logger.info({ sessionId, flowId: context.flowId, nodeId: node.id, targetFlowId, phone: userData.phone }, 'Redirecting user to different flow');
        
        // Send redirect message if provided
        if (redirectMessage) {
          const msg = replaceDynamicVars(String(redirectMessage), context);
          try {
            await sendItem(state, { 
              phone: userData.phone, 
              message: msg
            });
            logger.info({ sessionId, flowId: context.flowId, nodeId: node.id, message: msg, phone: userData.phone }, 'Sent redirect message');
          } catch (err) {
            logger.error({ sessionId, flowId: context.flowId, nodeId: node.id, message: msg, phone: userData.phone, error: String(err) }, 'Failed to send redirect message');
          }
        }
        
        // Store the redirect information for the flow execution system
        // This would be handled by the flow execution logic to switch to the target flow
        context.redirectToFlow = targetFlowId;
      }
    } else if (node.type === 'sheet_append') {
      // Append a single row to Google Sheet using templates
      try {
        const spreadsheetId = replaceDynamicVars(String(node.data?.spreadsheetId || ''), context);
        const range = replaceDynamicVars(String(node.data?.range || 'Sheet1!A1'), context);
        const colsStr = String(node.data?.columns || '').trim();
        if (spreadsheetId && range && colsStr) {
          const expressions = colsStr.split(',').map(s => s.trim()).filter(Boolean);
          const row = expressions.map(expr => replaceDynamicVars(expr, context));
          await gsAppendRows({ spreadsheetId, range, rows: [row], valueInputOption: 'RAW' });
          const okVar = String(node.data?.assignVarOk || '').trim();
          if (okVar) userData[okVar] = '1';
          logger.info({ sessionId, flowId: context.flowId, nodeId: node.id, spreadsheetId, range }, 'Appended row to sheet');
        } else {
          logger.warn({ sessionId, flowId: context.flowId, nodeId: node.id }, 'sheet_append missing spreadsheetId/range/columns');
        }
      } catch (e) {
        logger.warn({ sessionId, flowId: context.flowId, nodeId: node.id, error: String(e) }, 'sheet_append error');
      }
    } else if (node.type === 'sheet_lookup') {
      // Lookup a value in a sheet range and assign variables
      try {
        const spreadsheetId = replaceDynamicVars(String(node.data?.spreadsheetId || ''), context);
        const range = replaceDynamicVars(String(node.data?.range || 'Sheet1!A1:Z1000'), context);
        const matchColumn = Math.max(1, parseInt(String(node.data?.matchColumn || '1'), 10)) - 1;
        const matchValue = replaceDynamicVars(String(node.data?.matchValue || ''), context);
        const foundVar = String(node.data?.assignVarFound || 'sheet_found');
        const valueVar = String(node.data?.assignVarName || '').trim();
        const valueColIdx = node.data?.assignVarColumnIndex ? Math.max(1, parseInt(String(node.data.assignVarColumnIndex), 10)) - 1 : null;
        if (spreadsheetId && range && matchValue !== '') {
          const values = await gsReadRange({ spreadsheetId, range });
          let foundRow = null;
          for (const row of values || []) {
            if (row && row[matchColumn] !== undefined && String(row[matchColumn]).trim() === String(matchValue).trim()) {
              foundRow = row; break;
            }
          }
          userData[foundVar] = foundRow ? '1' : '0';
          if (foundRow && valueVar && valueColIdx !== null) {
            userData[valueVar] = String(foundRow[valueColIdx] ?? '');
          }
          logger.info({ sessionId, flowId: context.flowId, nodeId: node.id, spreadsheetId, range, matched: Boolean(foundRow) }, 'sheet_lookup completed');
        } else {
          logger.warn({ sessionId, flowId: context.flowId, nodeId: node.id }, 'sheet_lookup missing required fields');
        }
      } catch (e) {
        logger.warn({ sessionId, flowId: context.flowId, nodeId: node.id, error: String(e) }, 'sheet_lookup error');
      }
    }
  } catch (err) {
    logger.warn({ sessionId, err: String(err) }, 'Node execution error');
  }
}

async function executeFlow(flow, phone, sessionId, messageData = {}) {
  const state = await ensureSession(sessionId);
  if (!state || !state.isReady) return;

  // Initialize user data context
  const userData = {
    phone,
    messageCount: 0, // Would be tracked per user
    lastMessage: messageData.messageText || '',
    ...messageData
  };
  
  const systemVars = {
    sessionId,
    timestamp: new Date().toISOString()
  };
  
  const context = { userData, systemVars, messageData, sessionId, flowId: flow.id };

  const byId = new Map();
  for (const n of flow.nodes) byId.set(n.id, n);
  
  const nextOf = (id) => {
    const e = flow.edges.find((x) => x.from === id);
    return e ? byId.get(e.to) : null;
  };

  let cur = flow.nodes.find((n) => n.type === 'trigger');
  if (!cur) return;

  // If no edges defined, execute all non-trigger nodes in sequence
  if (!flow.edges || flow.edges.length === 0) {
    logger.info({ sessionId, flowId: flow.id }, 'No edges found, executing all non-trigger nodes');
    const nonTriggerNodes = flow.nodes.filter(n => n.type !== 'trigger');
    for (const node of nonTriggerNodes) {
      await executeNode(node, context, state);
    }
    return;
  }

  // Execute flow with branching logic
  while (cur) {
    try {
      if (cur.type === 'condition') {
        // Evaluate condition and branch accordingly
        const conditionType = cur.data?.conditionType || 'equals';
        const conditionValue = cur.data?.condition || '';
        const fullCondition = `${conditionType}:${conditionValue}`;
        const conditionResult = evaluateCondition(fullCondition, context);
        
        logger.info({ 
          sessionId, 
          flowId: flow.id, 
          nodeId: cur.id, 
          conditionType, 
          conditionValue, 
          fullCondition,
          result: conditionResult,
          phone: userData.phone,
          userTags: userData.phone && userTags.has(userData.phone) ? Array.from(userTags.get(userData.phone)) : []
        }, 'Evaluating condition node');
        
        const nextNodeId = conditionResult ? cur.data?.trueNode : cur.data?.falseNode;
        cur = nextNodeId ? byId.get(nextNodeId) : null;
      } else if (cur.type === 'yes_no') {
        // Yes/No question - send the question and wait for response
        const question = replaceDynamicVars(String(cur.data?.question || ''), context);
        await sendItem(state, { phone: userData.phone, message: question });
        
        // Store the flow state to resume after user response
        const flowState = {
          flowId: flow.id,
          currentNodeId: cur.id,
          context: context,
          waitingForResponse: true,
          choices: cur.data?.choices || [{ text: 'Yes', nodeId: cur.data?.yesNode }, { text: 'No', nodeId: cur.data?.noNode }],
          timestamp: Date.now()
        };
        
        // Store in a waiting flows map (in production, this would be in a database)
        if (!global.waitingFlows) global.waitingFlows = new Map();
        global.waitingFlows.set(userData.phone, flowState);
        
        logger.info({ sessionId, flowId: flow.id, phone: userData.phone, question, choices: flowState.choices }, 'Flow paused waiting for choice response');
        return; // Exit flow execution, will resume when user responds
      } else if (cur.type === 'wait_response') {
        // Wait for any response
        const timeout = Math.max(5, Number(cur.data?.timeout || 30));
        
        // Store the flow state to resume after user response or timeout
        const flowState = {
          flowId: flow.id,
          currentNodeId: cur.id,
          context: context,
          waitingForResponse: true,
          timeoutNodeId: cur.data?.timeoutNode,
          responseNodeId: cur.data?.responseNode,
          timeout: timeout * 1000, // Convert to milliseconds
          timestamp: Date.now()
        };
        
        if (!global.waitingFlows) global.waitingFlows = new Map();
        global.waitingFlows.set(userData.phone, flowState);
        
        logger.info({ sessionId, flowId: flow.id, phone: userData.phone, timeout }, 'Flow paused waiting for response');
        return; // Exit flow execution, will resume when user responds or timeout
      } else {
        await executeNode(cur, context, state);
        cur = nextOf(cur.id);
      }
    } catch (err) {
      logger.warn({ sessionId, err: String(err) }, 'Flow execution error');
      break;
    }
  }
}

// Continue flow execution from a specific node
async function continueFlowExecution(flow, startNode, context, sessionId) {
  const state = await ensureSession(sessionId);
  if (!state || !state.isReady) return;

  const byId = new Map();
  for (const n of flow.nodes) byId.set(n.id, n);
  
  const nextOf = (id) => {
    const e = flow.edges.find((x) => x.from === id);
    return e ? byId.get(e.to) : null;
  };

  let cur = startNode;
  
  // Execute flow with branching logic from the starting node
  while (cur) {
    try {
      if (cur.type === 'condition') {
        // Evaluate condition and branch accordingly
        const conditionResult = evaluateCondition(cur.data?.condition || '', context);
        const nextNodeId = conditionResult ? cur.data?.trueNode : cur.data?.falseNode;
        cur = nextNodeId ? byId.get(nextNodeId) : null;
      } else if (cur.type === 'yes_no') {
        // Yes/No question - send the question and wait for response
        const question = replaceDynamicVars(String(cur.data?.question || ''), context);
        await sendItem(state, { phone: context.userData.phone, message: question });
        
        // Store the flow state to resume after user response
        const flowState = {
          flowId: flow.id,
          currentNodeId: cur.id,
          context: context,
          waitingForResponse: true,
          choices: cur.data?.choices || [{ text: 'Yes', nodeId: cur.data?.yesNode }, { text: 'No', nodeId: cur.data?.noNode }],
          timestamp: Date.now()
        };
        
        if (!global.waitingFlows) global.waitingFlows = new Map();
        global.waitingFlows.set(context.userData.phone, flowState);
        
        logger.info({ sessionId, flowId: flow.id, phone: context.userData.phone, question, choices: flowState.choices }, 'Flow paused waiting for choice response');
        return; // Exit flow execution, will resume when user responds
      } else if (cur.type === 'wait_response') {
        // Wait for any response
        const timeout = Math.max(5, Number(cur.data?.timeout || 30));
        
        // Store the flow state to resume after user response or timeout
        const flowState = {
          flowId: flow.id,
          currentNodeId: cur.id,
          context: context,
          waitingForResponse: true,
          timeoutNodeId: cur.data?.timeoutNode,
          responseNodeId: cur.data?.responseNode,
          timeout: timeout * 1000, // Convert to milliseconds
          timestamp: Date.now()
        };
        
        if (!global.waitingFlows) global.waitingFlows = new Map();
        global.waitingFlows.set(context.userData.phone, flowState);
        
        logger.info({ sessionId, flowId: flow.id, phone: context.userData.phone, timeout }, 'Flow paused waiting for response');
        return; // Exit flow execution, will resume when user responds or timeout
      } else {
        await executeNode(cur, context, state);
        cur = nextOf(cur.id);
      }
    } catch (err) {
      logger.warn({ sessionId, err: String(err) }, 'Flow execution error');
      break;
    }
  }
}

// Check flow triggers for incoming messages
async function checkFlowTriggers(message, sessionId) {
  try {
    // First, check if there's a waiting flow for this user
    if (global.waitingFlows && global.waitingFlows.has(message.from)) {
      const flowState = global.waitingFlows.get(message.from);
      const flow = savedFlows.get(flowState.flowId);
      
      if (flow) {
        logger.info({ sessionId, phone: message.from, flowId: flow.id }, 'Resuming waiting flow');
        
        // Remove from waiting flows
        global.waitingFlows.delete(message.from);
        
        // Determine next node based on response
        let nextNodeId = null;
        const responseText = (message.body || '').toLowerCase().trim();
        
        if (flowState.choices && flowState.choices.length > 0) {
          // Enhanced choice flow - match response to choices
          for (const choice of flowState.choices) {
            const choiceText = choice.text.toLowerCase();
            if (responseText.includes(choiceText) || 
                (choiceText === 'yes' && (responseText.includes('y') || responseText.includes('1'))) ||
                (choiceText === 'no' && (responseText.includes('n') || responseText.includes('0')))) {
              nextNodeId = choice.nodeId;
              break;
            }
          }
        } else if (flowState.responseNodeId) {
          // Wait response flow
          nextNodeId = flowState.responseNodeId;
        }
        
        if (nextNodeId) {
          // Resume flow execution from the next node
          const byId = new Map();
          for (const n of flow.nodes) byId.set(n.id, n);
          
          const nextNode = byId.get(nextNodeId);
          if (nextNode) {
            // Update context with new message data
            flowState.context.messageData.messageText = message.body || '';
            flowState.context.userData.lastMessage = message.body || '';
            
            // Continue execution from the next node
            await continueFlowExecution(flow, nextNode, flowState.context, sessionId);
            return true; // Flow was handled
          }
        }
      }
    }
    
    // Get saved flows for this session
    const flows = Array.from(savedFlows.values()).filter(f => f.sessionId === sessionId);
    
    logger.info({ 
      sessionId, 
      messageBody: message.body, 
      flowsCount: flows.length,
      totalFlows: savedFlows.size,
      allFlows: Array.from(savedFlows.values()).map(f => ({ id: f.id, name: f.name, sessionId: f.sessionId }))
    }, 'Checking flow triggers');
    
    let anyFlowTriggered = false;
    
    for (const flow of flows) {
      const triggerNode = flow.nodes.find(n => n.type === 'trigger');
      if (!triggerNode) {
        logger.warn({ sessionId, flowId: flow.id }, 'Flow has no trigger node');
        continue;
      }
      
      const shouldTrigger = evaluateTrigger(triggerNode, message.body, message.from, sessionId);
      logger.info({ 
        sessionId, 
        flowId: flow.id, 
        triggerType: triggerNode.data?.triggerType, 
        condition: triggerNode.data?.condition,
        shouldTrigger 
      }, 'Flow trigger evaluation');
      
      if (shouldTrigger) {
        logger.info({ sessionId, flowId: flow.id, phone: message.from }, 'Flow triggered - executing');
        anyFlowTriggered = true;
        
        // Track flow execution
        const analytics = flowAnalytics.get(flow.id) || { executions: 0, successes: 0, failures: 0, lastExecuted: null };
        analytics.executions++;
        analytics.lastExecuted = new Date().toISOString();
        flowAnalytics.set(flow.id, analytics);
        
        // Execute flow asynchronously with message data
        const messageData = {
          messageText: message.body || '',
          senderPhone: message.from || '',
          senderName: message._data?.notifyName || '',
          chatTitle: message._data?.chat?.name || '',
          hasMedia: message.hasMedia || false,
          isGroup: message.from?.includes('@g.us') || false
        };
        
        executeFlow(flow, message.from, sessionId, messageData)
          .then(() => {
            const stats = flowAnalytics.get(flow.id);
            stats.successes++;
            flowAnalytics.set(flow.id, stats);
          })
          .catch(err => {
            logger.error({ sessionId, flowId: flow.id, error: String(err) }, 'Flow execution failed');
            const stats = flowAnalytics.get(flow.id);
            stats.failures++;
            flowAnalytics.set(flow.id, stats);
          });
      }
    }
    
    return anyFlowTriggered;
  } catch (e) {
    logger.error({ sessionId, error: String(e) }, 'Flow trigger check error');
    return false;
  }
}

// Flow runner (execute a simple linear flow built in flows.html)
app.post('/api/flows/run', async (req, res) => {
  try {
    const { sessionId, phone, flow } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!phone) return res.status(400).json({ error: 'phone required' });
    if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) return res.status(400).json({ error: 'flow invalid' });

    const state = await ensureSession(sessionId);
    if (!state || !state.isReady) return res.status(400).json({ error: 'session not ready' });

    const byId = new Map();
    for (const n of flow.nodes) byId.set(n.id, n);
    const nextOf = (id) => {
      const e = flow.edges.find((x) => x.from === id);
      return e ? byId.get(e.to) : null;
    };
    let cur = flow.nodes.find((n) => n.type === 'trigger');
    if (!cur) return res.status(400).json({ error: 'no trigger node' });

    (async () => {
      let guard = 0;
      while (cur && guard < 500) {
        guard += 1;
        try {
          if (cur.type === 'trigger') {
            // Trigger nodes are evaluated but don't execute actions
            const triggerType = cur.data?.triggerType || 'always';
            const condition = cur.data?.condition || '';
            logger.info({ sessionId, phone, triggerType, condition }, 'Flow trigger evaluated');
          } else if (cur.type === 'send') {
            const msg = replaceSystemVars(String(cur.data?.message || ''));
            await sendItem(state, { phone, message: msg });
          } else if (cur.type === 'delay') {
            const sec = Math.max(0, Number(cur.data?.seconds || 0));
            await sleep(sec * 1000);
          } else if (cur.type === 'webhook') {
            const url = String(cur.data?.url || '');
            const method = String(cur.data?.method || 'POST');
            if (url) { try { await fetch(url, { method }); } catch {} }
          } else if (cur.type === 'condition') {
            // For now condition does not branch; evaluate for side effects/logs only
            try { Function('vars', `return (${String(cur.data?.expr || 'true')});`)({}); } catch {}
          } else if (cur.type === 'ai_agent') {
            await executeAiAgentNode(cur, state, { phone, sessionId });
          }
        } catch (err) {
          logger.warn({ sessionId, err: String(err) }, 'Flow step error');
        }
        cur = nextOf(cur.id);
      }
    })();

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Export flows endpoint
app.get('/api/flows/export', (req, res) => {
  try {
    const flows = Array.from(savedFlows.values());
    const exportData = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      flows: flows.map(flow => ({
        id: flow.id,
        name: flow.name,
        description: flow.description || '',
        sessionId: flow.sessionId,
        tags: flow.tags || [],
        nodes: flow.nodes,
        edges: flow.edges,
        createdAt: flow.createdAt || new Date().toISOString(),
        updatedAt: flow.updatedAt || new Date().toISOString()
      })),
      userTags: Object.fromEntries(
        Array.from(userTags.entries()).map(([phone, tags]) => [phone, Array.from(tags)])
      ),
      totalFlows: flows.length,
      totalUsers: userTags.size
    };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="flows-export-${new Date().toISOString().split('T')[0]}.json"`);
    res.json(exportData);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Import flows endpoint
app.post('/api/flows/import', (req, res) => {
  try {
    const { flows, userTags: importedUserTags, overwrite = false } = req.body;
    
    if (!flows || !Array.isArray(flows)) {
      return res.status(400).json({ error: 'Invalid flows data' });
    }
    
    let importedCount = 0;
    let skippedCount = 0;
    let errors = [];
    
    // Import flows
    for (const flowData of flows) {
      try {
        const flowId = flowData.id;
        
        // Check if flow already exists
        if (savedFlows.has(flowId) && !overwrite) {
          skippedCount++;
          continue;
        }
        
        // Validate flow structure
        if (!flowData.name || !flowData.nodes || !Array.isArray(flowData.nodes)) {
          errors.push(`Invalid flow structure for ${flowData.name || 'unnamed flow'}`);
          continue;
        }
        
        // Create flow object
        const flow = {
          id: flowId,
          name: flowData.name,
          description: flowData.description || '',
          sessionId: flowData.sessionId || 'default',
          tags: flowData.tags || [],
          nodes: flowData.nodes,
          edges: flowData.edges || [],
          createdAt: flowData.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        
        // Save flow
        savedFlows.set(flowId, flow);
        importedCount++;
        
        logger.info({ flowId, flowName: flow.name }, 'Flow imported successfully');
      } catch (err) {
        errors.push(`Error importing flow ${flowData.name || 'unnamed'}: ${String(err)}`);
      }
    }
    
    // Import user tags if provided
    let importedTagsCount = 0;
    if (importedUserTags && typeof importedUserTags === 'object') {
      for (const [phone, tags] of Object.entries(importedUserTags)) {
        if (Array.isArray(tags)) {
          if (!userTags.has(phone)) {
            userTags.set(phone, new Set());
          }
          
          const userTagSet = userTags.get(phone);
          tags.forEach(tag => userTagSet.add(tag));
          importedTagsCount++;
        }
      }
      
      // Save user tags to file
      if (importedTagsCount > 0) {
        saveUserTagsToFile();
      }
    }
    
    // Save flows to file
    saveFlowsToFile();
    
    res.json({
      success: true,
      importedFlows: importedCount,
      skippedFlows: skippedCount,
      importedTags: importedTagsCount,
      errors: errors,
      message: `Successfully imported ${importedCount} flows and ${importedTagsCount} user tags`
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// AI Flow generator endpoint
app.post('/api/flows/generate', async (req, res) => {
  try {
    const { idea, sessionId, save = false, name: givenName, model: userModel, temperature: userTemp } = req.body || {};
    if (!idea || typeof idea !== 'string' || idea.trim().length === 0) {
      return res.status(400).json({ error: 'idea required' });
    }

    function coerceArray(value) {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
      return [];
    }

    function layoutNodes(nodes) {
      // Ensure positions if missing; lay out horizontally with spacing
      const withPos = [];
      let x = 120;
      let y = 120;
      const dx = 180;
      const dy = 100;
      let rowCount = 0;
      for (const n of nodes) {
        const nx = Number.isFinite(Number(n.x)) ? Number(n.x) : x;
        const ny = Number.isFinite(Number(n.y)) ? Number(n.y) : y;
        withPos.push({ id: String(n.id), type: String(n.type), x: nx, y: ny, data: n.data || {} });
        x += dx; rowCount += 1; if (rowCount % 4 === 0) { x = 120; y += dy; }
      }
      return withPos;
    }

    function normalizeFlowStruct(raw) {
      const out = { name: String(raw?.name || givenName || 'AI Flow'), sessionId: sessionId || raw?.sessionId || 'default', tags: coerceArray(raw?.tags), nodes: [], edges: [] };
      const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
      const edges = Array.isArray(raw?.edges) ? raw.edges : [];

      // Normalize nodes
      const normalizedNodes = nodes.map((n, idx) => {
        const id = String(n?.id || `node_${idx + 1}`);
        const type = String(n?.type || 'send');
        const data = { ...(n?.data || {}) };
        // Map possible alternative keys from LLM
        if (type === 'trigger') {
          if (!data.triggerType && n?.triggerType) data.triggerType = n.triggerType;
          if (!data.condition && n?.condition) data.condition = n.condition;
          if (!data.description && n?.description) data.description = n.description;
          if (!data.triggerType) data.triggerType = 'always';
        }
        if (type === 'condition') {
          if (!data.conditionType && (n?.conditionType || n?.condition?.type)) data.conditionType = n?.conditionType || n?.condition?.type;
          if (!data.condition && (n?.condition || n?.condition?.value)) data.condition = n?.condition?.value || n?.condition;
          if (!data.trueNode && (n?.trueNode || n?.onTrue)) data.trueNode = n?.trueNode || n?.onTrue;
          if (!data.falseNode && (n?.falseNode || n?.onFalse)) data.falseNode = n?.falseNode || n?.onFalse;
          if (!data.conditionType) data.conditionType = 'equals';
          if (!data.condition) data.condition = 'equals:dummy:true';
        }
        if (type === 'send') {
          if (!data.message && (n?.message || n?.text)) data.message = n?.message || n?.text;
          if (!data.message) data.message = 'Hello!';
        }
        if (type === 'delay') {
          if (data.seconds == null && (n?.seconds != null)) data.seconds = Number(n.seconds) || 1;
          if (data.seconds == null) data.seconds = 1;
        }
        if (type === 'webhook') {
          if (!data.url && n?.url) data.url = n.url;
          if (!data.method && n?.method) data.method = n.method;
          if (!data.method) data.method = 'POST';
        }
        return { id, type, x: n?.x, y: n?.y, data };
      });

      // Guarantee a trigger exists
      if (!normalizedNodes.some(n => n.type === 'trigger')) {
        normalizedNodes.unshift({ id: 'node_1', type: 'trigger', x: 120, y: 120, data: { triggerType: 'always', condition: '' } });
        // Renumber other nodes if id clash
        let i = 2;
        for (let k = 1; k < normalizedNodes.length; k++) {
          if (!normalizedNodes[k].id || normalizedNodes[k].id === 'node_1') normalizedNodes[k].id = `node_${i++}`;
        }
      }

      // Normalize edges
      const normalizedEdges = edges
        .map(e => ({ from: String(e?.from || e?.source || ''), to: String(e?.to || e?.target || '') }))
        .filter(e => e.from && e.to);

      out.nodes = layoutNodes(normalizedNodes);
      out.edges = normalizedEdges;
      return out;
    }

    // If OpenAI key available, attempt LLM generation
    const apiKey = agentMgr.getApiKey();
    let llmFlow = null;
    let modelUsed = null;
    if (apiKey) {
      try {
        const sys = `You generate WhatsApp flow graphs for an internal flow builder. Output MUST be valid JSON with keys name, tags, nodes, edges. Schema:
nodes: Array<{ id: string, type: 'trigger'|'send'|'delay'|'condition'|'set_variable'|'tag_user'|'yes_no'|'wait_response'|'redirect_flow'|'webhook'|'ai_agent', x?: number, y?: number, data: object }>
For trigger: data.triggerType ('keyword'|'always'|'cron'), data.condition (string).
For send: data.message (string).
For delay: data.seconds (number).
For condition: data.conditionType ('equals'|'contains'|'greater_than'|'less_than'|'has_tag'|'has_any_tag'|'has_all_tags'|'time_between'|'day_of_week'|'message_count'|'has_media'|'is_group'), data.condition (string), data.trueNode (node id), data.falseNode (node id).
For ai_agent: data.model ('gpt-4o-mini'|'gpt-4o'|'gpt-3.5-turbo'), data.systemPrompt (string), data.userPrompt (string), data.responseMode ('send_reply'|'store_variable'|'both'), data.variableName (string).
edges: Array<{ from: nodeId, to: nodeId }>. Always include a single trigger node. Keep it simple and robust.`;
        const user = `Build a small flow for this idea:
"""
${idea}
"""
Session: ${sessionId || 'default'}
Return only JSON.`;
        const model = String(userModel || 'gpt-4o-mini');
        const temperature = Math.max(0, Math.min(1, Number(userTemp ?? 0.2)));
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, temperature, messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ], response_format: { type: 'json_object' } })
        });
        if (resp.ok) {
          const data = await resp.json();
          const content = data.choices?.[0]?.message?.content || '{}';
          try { llmFlow = JSON.parse(content); } catch {}
          try { modelUsed = data.model || model; } catch { modelUsed = model; }
        }
      } catch (e) {
        logger.warn({ error: String(e) }, 'LLM flow generation failed');
      }
    }

    let flowStruct = null;
    if (llmFlow) {
      flowStruct = normalizeFlowStruct(llmFlow);
    } else {
      // Fallback deterministic simple flow
      const keywords = idea.toLowerCase().match(/[a-z]{3,}/g)?.slice(0, 5) || [];
      const triggerCond = keywords.length ? keywords.join(',') : '';
      const fallback = {
        name: givenName || 'AI Flow',
        sessionId: sessionId || 'default',
        tags: [],
        nodes: [
          { id: 'node_1', type: 'trigger', data: { triggerType: triggerCond ? 'keyword' : 'always', condition: triggerCond } },
          { id: 'node_2', type: 'send', data: { message: `Hi! This flow was generated from your idea: "${idea.slice(0, 120)}"` } }
        ],
        edges: [ { from: 'node_1', to: 'node_2' } ]
      };
      flowStruct = normalizeFlowStruct(fallback);
    }

    if (save) {
      const flow = {
        id: Date.now().toString(),
        name: flowStruct.name,
        sessionId: flowStruct.sessionId,
        tags: flowStruct.tags,
        nodes: flowStruct.nodes,
        edges: flowStruct.edges,
        createdAt: new Date().toISOString()
      };
      savedFlows.set(flow.id, flow);
      saveFlowsToFile();
      return res.json({ ok: true, saved: true, modelUsed: modelUsed || null, flow });
    }

    res.json({ ok: true, saved: false, modelUsed: modelUsed || null, flow: { name: flowStruct.name, sessionId: flowStruct.sessionId, tags: flowStruct.tags, nodes: flowStruct.nodes, edges: flowStruct.edges } });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// AI: suggest keyword expansions for triggers
app.post('/api/flows/keywords', async (req, res) => {
  try {
    const { seed, max = 20, model: userModel } = req.body || {};
    const base = String(seed || '').trim();
    if (!base) return res.status(400).json({ error: 'seed required (comma-separated keywords)' });
    const apiKey = agentMgr.getApiKey();
    let modelUsed = null;
    if (apiKey) {
      try {
        const model = String(userModel || 'gpt-4o-mini');
        const sys = 'Expand trigger keywords for WhatsApp flows. Return JSON: {"suggestions": ["word1","word2",...]} with unique, lowercase, short tokens (1-2 words), no punctuation.';
        const user = `Seed: ${base}\nLimit: ${max}`;
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, temperature: 0.3, messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ], response_format: { type: 'json_object' } })
        });
        if (resp.ok) {
          const data = await resp.json();
          modelUsed = data.model || model;
          const content = data.choices?.[0]?.message?.content || '{}';
          const json = JSON.parse(content);
          const suggestions = Array.isArray(json?.suggestions) ? json.suggestions : [];
          return res.json({ ok: true, modelUsed, suggestions });
        }
      } catch (e) {
        logger.warn({ error: String(e) }, 'Keyword expansion via LLM failed');
      }
    }
    // Fallback: simple expansions (dedupe + stemming-ish)
    const parts = base.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const extra = new Set();
    for (const p of parts) {
      extra.add(p);
      if (p.endsWith('s')) extra.add(p.slice(0, -1)); else extra.add(p + 's');
    }
    return res.json({ ok: true, modelUsed, suggestions: Array.from(extra).slice(0, Number(max) || 20) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// AI: explain a flow (summary and per-node/path notes)
app.post('/api/flows/explain', async (req, res) => {
  try {
    const { flowId, flow: flowBody, model: userModel } = req.body || {};
    let flow = null;
    if (flowId) flow = savedFlows.get(String(flowId));
    if (!flow && flowBody && Array.isArray(flowBody.nodes) && Array.isArray(flowBody.edges)) flow = flowBody;
    if (!flow) return res.status(400).json({ error: 'flowId or flow required' });

    const apiKey = agentMgr.getApiKey();
    let modelUsed = null;
    if (apiKey) {
      try {
        const model = String(userModel || 'gpt-4o-mini');
        const sys = 'Explain a WhatsApp automation flow clearly and concisely for non-technical users. Return Markdown.';
        const user = `Name: ${flow.name || 'Untitled'}\nSession: ${flow.sessionId || 'default'}\nNodes: ${JSON.stringify(flow.nodes)}\nEdges: ${JSON.stringify(flow.edges)}\nPlease include: 1) one-paragraph summary, 2) node-by-node explanation with IDs and key fields (triggerType/condition, message, seconds, etc.), 3) describe branches from condition nodes, 4) potential risks (missing nodes, dangling edges, multiple triggers).`;
        const resp = await fetch('https://api/openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, temperature: 0.2, messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ] })
        });
        if (resp.ok) {
          const data = await resp.json();
          modelUsed = data.model || model;
          const content = data.choices?.[0]?.message?.content || '';
          return res.json({ ok: true, modelUsed, explanation: content || '' });
        }
      } catch (e) {
        logger.warn({ error: String(e) }, 'Flow explanation via LLM failed');
      }
    }
    // Fallback: generate basic explanation
    const byId = new Map();
    for (const n of (flow.nodes || [])) byId.set(n.id, n);
    const lines = [];
    lines.push(`# ${flow.name || 'Flow'}\n`);
    lines.push(`Session: ${flow.sessionId || 'default'}\n`);
    const triggers = (flow.nodes || []).filter(n => n.type === 'trigger');
    if (triggers.length > 1) lines.push(`Warning: multiple triggers (${triggers.length}).`);
    if (triggers.length === 0) lines.push('Warning: no trigger node.');
    lines.push('## Nodes');
    for (const n of (flow.nodes || [])) {
      lines.push(`- ${n.id} [${n.type}] ${JSON.stringify(n.data || {})}`);
    }
    lines.push('\n## Edges');
    for (const e of (flow.edges || [])) lines.push(`- ${e.from} -> ${e.to}`);
    // Dangling edges
    const missing = (flow.edges || []).filter(e => !byId.has(e.from) || !byId.has(e.to));
    if (missing.length) lines.push(`\nWarning: dangling edges: ${JSON.stringify(missing)}`);
    return res.json({ ok: true, modelUsed, explanation: lines.join('\n') });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Export single flow endpoint
app.get('/api/flows/export/:flowId', (req, res) => {
  try {
    const { flowId } = req.params;
    const flow = savedFlows.get(flowId);
    
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    const exportData = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      flows: [{
        id: flow.id,
        name: flow.name,
        description: flow.description || '',
        sessionId: flow.sessionId,
        tags: flow.tags || [],
        nodes: flow.nodes,
        edges: flow.edges,
        createdAt: flow.createdAt || new Date().toISOString(),
        updatedAt: flow.updatedAt || new Date().toISOString()
      }],
      totalFlows: 1
    };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="flow-${flow.name.replace(/[^a-zA-Z0-9]/g, '_')}-${new Date().toISOString().split('T')[0]}.json"`);
    res.json(exportData);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Debug endpoint to test flow execution
app.post('/api/flows/debug/:flowId', async (req, res) => {
  try {
    const { flowId } = req.params;
    const { phone, sessionId } = req.body;
    
    const flow = savedFlows.get(flowId);
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    
    const state = sessions.get(sessionId);
    if (!state || !state.isReady) {
      return res.status(400).json({ error: 'Session not ready' });
    }
    
    // Initialize user data context
    const userData = {
      phone,
      messageCount: 0,
      lastMessage: '',
    };
    
    const systemVars = {
      sessionId,
      timestamp: new Date().toISOString()
    };
    
    const messageData = {
      messageText: 'Debug test message',
      sender_name: 'Debug User',
      sender_phone: phone,
      chat_title: 'Debug Chat',
      isCronTrigger: false,
      triggerTime: new Date().toISOString()
    };
    
    const context = { userData, systemVars, messageData, sessionId, flowId: flow.id };
    
    // Check user tags
    const userTagsInfo = userTags.has(phone) ? Array.from(userTags.get(phone)) : [];
    
    // Test condition evaluation
    const conditionNodes = flow.nodes.filter(n => n.type === 'condition');
    const conditionResults = conditionNodes.map(node => {
      const conditionType = node.data?.conditionType || 'equals';
      const conditionValue = node.data?.condition || '';
      const fullCondition = `${conditionType}:${conditionValue}`;
      const result = evaluateCondition(fullCondition, context);
      
      return {
        nodeId: node.id,
        conditionType,
        conditionValue,
        fullCondition,
        result,
        trueNode: node.data?.trueNode,
        falseNode: node.data?.falseNode
      };
    });
    
    res.json({
      flowId,
      flowName: flow.name,
      phone,
      userTags: userTagsInfo,
      conditionResults,
      context: {
        userData,
        systemVars,
        messageData
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Auto-suggest templates from successful sends
app.get('/api/templates/suggestions', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const templates = queue.getSuccessfulTemplates(limit);
    res.json({ templates });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Chat analysis endpoints
app.post('/api/chat/analyze', async (req, res) => {
  try {
    const { sessionId, chatId } = req.body || {};
    if (!sessionId || !chatId) return res.status(400).json({ error: 'sessionId and chatId required' });
    
    const state = await ensureSession(sessionId);
    if (!state || !state.isReady) return res.status(400).json({ error: 'session not ready' });
    
    const chat = await state.client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 25 });
    
    const analysis = await agent.analyzeChat(chatId, sessionId, messages);
    res.json({ analysis });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/chat/analysis/:sessionId/:chatId', (req, res) => {
  try {
    const { sessionId, chatId } = req.params;
    const analysis = agent.getChatAnalysis(chatId, sessionId);
    res.json({ analysis });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// KB Quality Dashboard
app.get('/api/kb/quality', (req, res) => {
  try {
    const { sessionId } = req.query || {};
    const quality = agentMgr.getKBQuality(sessionId || 'default');
    res.json(quality);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Templates API
app.get('/api/templates', (_req, res) => {
  res.json({ templates: loadTemplates() });
});

app.post('/api/templates', (req, res) => {
  const { name, message, caption } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const list = loadTemplates();
  const id = `tpl_${Date.now()}`;
  list.push({ id, name, message: message || '', caption: caption || '' });
  saveTemplates(list);
  res.json({ id });
});

app.put('/api/templates/:id', (req, res) => {
  const id = req.params.id;
  const { name, message, caption } = req.body || {};
  const list = loadTemplates();
  const idx = list.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  list[idx] = { ...list[idx], name: name ?? list[idx].name, message: message ?? list[idx].message, caption: caption ?? list[idx].caption };
  saveTemplates(list);
  res.json({ ok: true });
});

app.delete('/api/templates/:id', (req, res) => {
  const id = req.params.id;
  const list = loadTemplates().filter(t => t.id !== id);
  saveTemplates(list);
  res.json({ ok: true });
});

app.post('/api/campaign/start', async (req, res) => {
  const { sessionId, items, delayMs, startTime, window, retries, throttle, autoShard, perSessionCap, validateNumbers } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items required' });

  // Pre-send dedupe and validation
  const normalizePhone = (p) => String(p || '').replace(/[^0-9]/g, '');
  const seen = new Set();
  const valid = [];
  const invalid = [];
  for (const it of items) {
    const phone = normalizePhone(it.phone);
    if (!phone || phone.length < 6) { invalid.push(it); continue; }
    if (seen.has(phone)) continue; // dedupe
    seen.add(phone);
    valid.push({ ...it, phone });
  }
  if (!valid.length) return res.status(400).json({ error: 'no valid phone numbers' });

  const delay = Number(delayMs) || 1000;
  const common = { delayMs: delay, startTime: startTime || null, window: window || {}, retries: retries || {}, throttle: throttle || {}, validateNumbers: validateNumbers !== false };
  const id = `cmp_${Date.now()}`;

  // Shard across sessions or use a single session
  let targets = {};
  if (autoShard) {
    const readySessions = Array.from(sessions.entries()).filter(([, s]) => s.isReady).map(([id]) => id);
    if (!readySessions.length) return res.status(400).json({ error: 'no ready sessions' });
    const cap = Math.max(0, Number(perSessionCap) || 0);
    targets = Object.fromEntries(readySessions.map(id => [id, []]));
    let idx = 0;
    for (const it of valid) {
      let placed = false;
      for (let r = 0; r < readySessions.length; r += 1) {
        const sid = readySessions[(idx + r) % readySessions.length];
        if (cap && targets[sid].length >= cap) continue;
        targets[sid].push(it);
        idx += 1; placed = true; break;
      }
      if (!placed) break; // all caps reached
    }
  } else {
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const state = sessions.get(sessionId);
    if (!state || !state.isReady) return res.status(400).json({ error: 'WhatsApp not ready' });
    targets = { [sessionId]: valid };
  }

  queue.enqueueCampaign({ id, itemsBySession: targets, common });

  res.json({ id, status: 'queued', valid: valid.length, invalid: invalid.length, sessions: Object.keys(targets).length });
});

app.post('/api/campaign/cancel', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.json({ ok: true });
  const state = sessions.get(sessionId);
  if (!state) return res.json({ ok: true });
  // Stop worker loop immediately
  const worker = workers.get(sessionId);
  if (worker) worker.running = false;
  // Cancel pending jobs for this session (and campaign if known)
  let cancelled = 0;
  if (state.currentCampaign?.id) {
    const res1 = queue.cancelPendingJobs({ campaignId: state.currentCampaign.id, reason: 'cancelled by user' });
    cancelled += res1.cancelled;
  }
  const res2 = queue.cancelPendingJobs({ sessionId, reason: 'cancelled by user' });
  cancelled += res2.cancelled;
  const id = state.currentCampaign?.id || 'unknown';
  state.currentCampaign = null;
  io.to(getRoom(sessionId)).emit('campaign_status', { sessionId, id, status: 'cancelled', cancelled });
  return res.json({ ok: true, cancelled });
});

// Delete/clear a specific campaign completely
app.delete('/api/campaign/:id', (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Campaign ID required' });
  
  try {
    const result = queue.deleteCampaign(id);
    logger.info({ campaignId: id, deletedJobs: result.deletedJobs, deletedCampaigns: result.deletedCampaigns }, 'Campaign deleted');
    res.json({ 
      ok: true, 
      campaignId: id,
      deletedJobs: result.deletedJobs,
      deletedCampaigns: result.deletedCampaigns,
      message: `Campaign ${id} deleted: ${result.deletedJobs} jobs and ${result.deletedCampaigns} campaign records removed`
    });
  } catch (error) {
    logger.error({ campaignId: id, error: error.message }, 'Failed to delete campaign');
    res.status(500).json({ error: 'Failed to delete campaign', details: error.message });
  }
});

// Minimal dashboard
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

// Auto-reply CRUD
app.get('/api/auto-reply', (_req, res) => {
  res.json({ rules: autoReply.list() });
});

// AI Agent KB & settings
app.get('/api/agent/settings', (_req, res) => {
  res.json(agentMgr.getSettings());
});
app.post('/api/agent/settings', (req, res) => {
  const { enabled, prompt, apiKey } = req.body || {};
  res.json(agentMgr.updateSettings({ enabled: Boolean(enabled), prompt: prompt || '', apiKey }));
});
app.get('/api/agent/docs', (req, res) => {
  const { sessionId } = req.query || {};
  res.json({ docs: agentMgr.listDocs(sessionId || 'default') });
});
app.post('/api/agent/docs', (req, res) => {
  const { content, sessionId } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  res.json(agentMgr.addDoc(content, null, sessionId || 'default'));
});
app.delete('/api/agent/docs/:id', (req, res) => {
  agentMgr.deleteDoc(Number(req.params.id));
  res.json({ ok: true });
});

// Upload and ingest a file into KB (txt or pdf)
async function ingestDocumentFile(absPath, sessionId = 'default') {
  const m = mime.lookup(absPath) || '';
  let text = '';
  if (String(m).includes('pdf')) {
    const pdf = (await import('pdf-parse')).default;
    const data = await pdf(fs.readFileSync(absPath));
    text = data.text || '';
  } else if (String(m).includes('officedocument') || absPath.endsWith('.docx')) {
    const mammoth = (await import('mammoth')).default;
    const out = await mammoth.extractRawText({ path: absPath });
    text = out.value || '';
  } else if (String(m).includes('markdown') || absPath.endsWith('.md')) {
    text = fs.readFileSync(absPath, 'utf8');
  } else if (absPath.endsWith('.txt')) {
    text = fs.readFileSync(absPath, 'utf8');
  } else {
    // Unsupported type for KB ingestion
    return { added: 0 };
  }
  text = String(text || '').trim();
  if (!text) return { added: 0 };
  // chunk by headings where possible, then by size (~1500 chars)
  const lines = text.split(/\r?\n/);
  const groups = [];
  let buf = '';
  for (const ln of lines) {
    if (/^#{1,6}\s+|^\d+\.\s+|^[A-Z][A-Z\s]{5,}$/.test(ln)) {
      if (buf.trim().length) groups.push(buf.trim());
      buf = ln + '\n';
    } else {
      buf += ln + '\n';
    }
  }
  if (buf.trim().length) groups.push(buf.trim());
  const rawChunks = groups.length ? groups : [text];
  const chunks = [];
  for (const g of rawChunks) {
    if (g.length <= 1600) { chunks.push(g); continue; }
    for (let i=0;i<g.length;i+=1600) chunks.push(g.slice(i, i+1600));
  }
  const apiKey = agentMgr.getApiKey();
  let embeds = [];
  if (apiKey) {
    try {
      const resEmb = await fetch('https://api.openai.com/v1/embeddings', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`}, body: JSON.stringify({ model:'text-embedding-3-small', input: chunks }) });
      if (resEmb.ok) {
        const data = await resEmb.json();
        embeds = data.data?.map(d => d.embedding) || [];
      }
    } catch {}
  }
  let added = 0;
  for (let i=0;i<chunks.length;i++) {
    let embedBuf = null;
    if (embeds[i]) {
      const f32 = new Float32Array(embeds[i]);
      embedBuf = Buffer.from(f32.buffer);
    }
    agentMgr.addDoc(chunks[i], embedBuf, sessionId || 'default');
    added++;
  }
  return { added };
}

app.post('/api/agent/docs/upload', upload.single('file'), async (req, res) => {
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

// Background watcher to auto-ingest future KB docs dropped into uploads/
const processedKB = new Set();
function isKBFileName(name) { return /\.(txt|md|pdf|docx)$/i.test(String(name||'')); }
try {
  fs.watch(UPLOAD_DIR, { persistent: true }, async (eventType, filename) => {
    try {
      if (!filename || !isKBFileName(filename)) return;
      const absPath = path.join(UPLOAD_DIR, filename);
      if (processedKB.has(absPath)) return;
      // Defer a bit to ensure file is fully written
      setTimeout(async () => {
        try {
          if (!fs.existsSync(absPath)) return;
          const { added } = await ingestDocumentFile(absPath, 'default');
          if (added > 0) {
            processedKB.add(absPath);
            try { logger.info({ filename, added }, 'Auto-ingested KB document'); } catch {}
          }
        } catch {}
      }, 500);
    } catch {}
  });
} catch {}

// Manual rescan endpoint to ingest any existing files in uploads/
app.post('/api/agent/docs/rescan', async (_req, res) => {
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

// Session prompt overrides
app.get('/api/agent/session-prompts', (_req, res) => { res.json({ prompts: agentMgr.listSessionPrompts() }); });
app.post('/api/agent/session-prompts', (req, res) => {
  const { sessionId, prompt, enabled } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  res.json(agentMgr.upsertSessionPrompt(sessionId, prompt || '', enabled !== false));
});
app.delete('/api/agent/session-prompts/:sessionId', (req, res) => {
  res.json(agentMgr.deleteSessionPrompt(req.params.sessionId));
});

// Human takeover APIs
app.post('/api/takeover/start', (req, res) => {
  try {
    const { sessionId, chatId, minutes = 15, mode = 'all' } = req.body || {};
    if (!sessionId || !chatId) return res.status(400).json({ error: 'sessionId and chatId required' });
    setHumanOverride(sessionId, chatId, minutes, mode);
    res.json({ ok: true, until: getHumanOverride(sessionId, chatId)?.until || null, mode });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/takeover/stop', (req, res) => {
  try {
    const { sessionId, chatId } = req.body || {};
    if (!sessionId || !chatId) return res.status(400).json({ error: 'sessionId and chatId required' });
    clearHumanOverride(sessionId, chatId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/takeover/status', (req, res) => {
  try {
    const { sessionId, chatId } = req.query || {};
    if (!sessionId || !chatId) return res.status(400).json({ error: 'sessionId and chatId required' });
    const o = getHumanOverride(String(sessionId), String(chatId));
    res.json({ active: Boolean(o), until: o?.until || null, mode: o?.mode || null });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Extractor: scan chats/messages to collect numbers
function normalizePhone(p) { return String(p || '').replace(/[^0-9]/g, ''); }
function addNum(set, p) { const n = normalizePhone(p); if (n && n.length >= 6) set.add(n); }

app.get('/api/extract/groups', async (req, res) => {
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
        const participants = Array.isArray(chat?.groupMetadata?.participants)
          ? chat.groupMetadata.participants.length
          : 0;
        groups.push({
          id: jid,
          title: chat?.name || chat?.formattedTitle || chat?.id?.user || jid,
          participants,
          unreadCount: chat?.unreadCount || 0,
          isArchived: !!chat?.isArchived
        });
      } catch {}
    }
    groups.sort((a, b) => {
      const at = String(a.title || '').toLowerCase();
      const bt = String(b.title || '').toLowerCase();
      return at.localeCompare(bt, undefined, { sensitivity: 'base' });
    });
    res.json({ sessionId, total: groups.length, groups });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/extract/scan', async (req, res) => {
  try {
    const {
      sessionId,
      samplePerChat,
      groupsOnly,
      groupNameFilter,
      groupIds
    } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const state = sessions.get(sessionId);
    if (!state || !state.isReady) return res.status(400).json({ error: 'session not ready' });
    const client = state.client;
    const chats = await client.getChats();
    const rowKeySet = new Set();
    const rows = [];
    const limit = Math.max(0, parseInt(samplePerChat || 30, 10));

    // Normalize group name filters (if any) to lowercase strings
    const normalizedGroupNameFilter = Array.isArray(groupNameFilter)
      ? groupNameFilter
          .map((s) => String(s || '').trim().toLowerCase())
          .filter((s) => s.length > 0)
      : [];
    const normalizedGroupIds = Array.isArray(groupIds)
      ? groupIds
          .map((s) => String(s || '').trim())
          .filter((s) => s.length > 0)
      : [];

    for (const chat of chats) {
      try {
        // chat info
        const jid = chat?.id?._serialized || '';
        const user = chat?.id?.user || '';
        const isGroup = !!chat?.isGroup;
        const chatTitle = chat?.name || chat?.formattedTitle || user || jid;
        const type = isGroup ? 'group' : 'private';

        // If groupsOnly is requested, skip non-group chats
        if (groupsOnly && !isGroup) {
          continue;
        }

        // If specific group IDs are provided, skip all others
        if (isGroup && normalizedGroupIds.length > 0 && !normalizedGroupIds.includes(jid)) {
          continue;
        }

        // If a group name filter is provided, only include groups whose name
        // contains at least one of the given substrings (case-insensitive).
        if (isGroup && normalizedGroupNameFilter.length > 0) {
          const titleLc = String(chatTitle || '').toLowerCase();
          const matchesFilter = normalizedGroupNameFilter.some((needle) =>
            titleLc.includes(needle)
          );
          if (!matchesFilter) {
            continue;
          }
        }

        const displayName = chat?.contact?.name || chat?.contact?.pushname || '';
        // chat JID/peer
        const phoneFromChat = normalizePhone(user || jid);
        if (phoneFromChat && phoneFromChat.length >= 6) {
          const key = `${phoneFromChat}|chat|${chatTitle}`;
          if (!rowKeySet.has(key)) { rowKeySet.add(key); rows.push({ phone: phoneFromChat, type, source: 'chat', chat_title: chatTitle, chat_id: jid, name: displayName }); }
        }
        // group participants
        if (chat.isGroup && chat.groupMetadata && Array.isArray(chat.groupMetadata.participants)) {
          for (const p of chat.groupMetadata.participants) {
            const pn = normalizePhone(p?.id?.user || '');
            if (pn && pn.length >= 6) {
              const key = `${pn}|participant|${chatTitle}`;
              if (!rowKeySet.has(key)) { rowKeySet.add(key); rows.push({ phone: pn, type, source: 'participant', chat_title: chatTitle, chat_id: jid, name: '' }); }
            }
          }
        }
        if (limit > 0 && typeof chat.fetchMessages === 'function') {
          const msgs = await chat.fetchMessages({ limit });
          for (const m of msgs) {
            const body = String(m?.body || '');
            if (!body) continue;
            const matches = body.match(/\+?\d[\d\s\-()]{5,}/g);
            if (Array.isArray(matches)) {
              for (const raw of matches) {
                const pn = normalizePhone(raw);
                if (pn && pn.length >= 6) {
                  const key = `${pn}|message|${chatTitle}`;
                  if (!rowKeySet.has(key)) { rowKeySet.add(key); rows.push({ phone: pn, type, source: 'message', chat_title: chatTitle, chat_id: jid, name: '' }); }
                }
              }
            }
          }
        }
      } catch {}
    }
    const id = `extract_${Date.now()}`;
    const unique = new Set(rows.map(r=>r.phone)).size;
    extractResults.set(id, { createdAt: new Date().toISOString(), sessionId, rows, unique });
    res.json({ id, total: unique });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/extract/result/:id', (req, res) => {
  const r = extractResults.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

app.get('/api/extract/export/:id.csv', (req, res) => {
  const r = extractResults.get(req.params.id);
  if (!r) return res.status(404).send('not found');
  const lines = ['phone,source,type,chat_title,chat_id,name'];
  for (const row of r.rows) {
    const esc = (s)=>`"${String(s||'').replace(/"/g,'""')}"`;
    lines.push([row.phone, row.source, row.type, esc(row.chat_title), esc(row.chat_id), esc(row.name)].join(','));
  }
  const csv = lines.join('\n');
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="${req.params.id}.csv"`);
  res.send(csv);
});

// Google Sheets integration
app.post('/api/google-sheets/read', async (req, res) => {
  try {
    const { spreadsheetId, range, valueRenderOption } = req.body || {};
    if (!spreadsheetId || !range) return res.status(400).json({ error: 'spreadsheetId and range are required' });
    const values = await gsReadRange({ spreadsheetId, range, valueRenderOption });
    res.json({ values });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/google-sheets/append', async (req, res) => {
  try {
    const { spreadsheetId, range, rows, valueInputOption } = req.body || {};
    if (!spreadsheetId || !range || !Array.isArray(rows)) return res.status(400).json({ error: 'spreadsheetId, range and rows[] are required' });
    const result = await gsAppendRows({ spreadsheetId, range, rows, valueInputOption });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/google-sheets/update', async (req, res) => {
  try {
    const { spreadsheetId, range, values, valueInputOption } = req.body || {};
    if (!spreadsheetId || !range || !Array.isArray(values)) return res.status(400).json({ error: 'spreadsheetId, range and values[][] are required' });
    const result = await gsUpdateRange({ spreadsheetId, range, values, valueInputOption });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/google-sheets/sheet-titles', async (req, res) => {
  try {
    const spreadsheetId = String(req.query.spreadsheetId || '');
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });
    const titles = await gsListSheets({ spreadsheetId });
    res.json({ titles });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Google Service Account credentials management
app.get('/api/google-credentials', (req, res) => {
  try {
    const info = getSavedCredentialsInfo();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const credUpload = multer({ storage: multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DATA_DIR),
  filename: (_req, _file, cb) => cb(null, 'google_service_account.json')
})});

app.post('/api/google-credentials', credUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    return res.json({ ok: true, saved: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/google-credentials', (req, res) => {
  try {
    const fp = path.join(DATA_DIR, 'google_service_account.json');
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Insights
app.get('/api/insights', (req, res) => {
  const days = Number(req.query.days) || 7;
  const sessionId = req.query.sessionId || undefined;
  try { res.json(queue.insights(days, sessionId)); } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Recent error logs for insights
app.get('/api/insights/errors', (req, res) => {
  try {
    const days = Number(req.query.days) || 7;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const sessionId = req.query.sessionId || undefined;
    const rows = queue.recentErrors(days, limit, sessionId);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// CSV export for recent errors
app.get('/api/insights/errors.csv', (req, res) => {
  try {
    const days = Number(req.query.days) || 7;
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const sessionId = req.query.sessionId || undefined;
    const rows = queue.recentErrors(days, limit, sessionId);
    const header = ['ts','session_id','phone','error'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const err = (r.error || '').toString().replaceAll('\n',' ').replaceAll('"','""');
      lines.push([r.ts, r.session_id, r.phone, `"${err}"`].join(','));
    }
    const csv = lines.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="error-logs.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Enhanced backup: comprehensive system backup including all data and settings
app.get('/api/backup.zip', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="whatsapp-tool-complete-backup-${timestamp}.zip"`);
    
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { 
      logger.error({ error: err.message }, 'Backup archive error');
      try { res.status(500).end(String(err)); } catch {} 
    });
    
    archive.pipe(res);
    
    // Core data directories
    if (fs.existsSync(DATA_DIR)) {
      logger.info('Adding data directory to backup');
      archive.directory(DATA_DIR, 'data');
    }
    
    if (fs.existsSync(UPLOAD_DIR)) {
      logger.info('Adding uploads directory to backup');
      archive.directory(UPLOAD_DIR, 'uploads');
    }
    
    // WhatsApp sessions (if they exist and user wants them)
    const authDir = path.resolve('.wwebjs_auth');
    if (fs.existsSync(authDir)) {
      logger.info('Adding WhatsApp session data to backup');
      archive.directory(authDir, '.wwebjs_auth');
    }
    
    // Server data directory (if different from main data)
    const serverDataDir = path.resolve('./server/data');
    if (fs.existsSync(serverDataDir) && serverDataDir !== DATA_DIR) {
      logger.info('Adding server data directory to backup');
      archive.directory(serverDataDir, 'server/data');
    }
    
    // Configuration files
    const configFiles = [
      'package.json',
      'nodemon.json',
      '.env'
    ];
    
    for (const configFile of configFiles) {
      const filePath = path.resolve(configFile);
      if (fs.existsSync(filePath)) {
        logger.info(`Adding config file to backup: ${configFile}`);
        archive.file(filePath, { name: configFile });
      }
    }
    
    // Create backup manifest with metadata
    const backupManifest = {
      version: "1.0",
      created: new Date().toISOString(),
      type: "complete_backup",
      tool_version: "whatsapp-bulk-sender",
      includes: {
        databases: true,
        uploads: true,
        whatsapp_sessions: fs.existsSync(authDir),
        flows: true,
        templates: true,
        auto_replies: true,
        agent_settings: true,
        queue_data: true,
        user_tags: true,
        google_credentials: fs.existsSync(path.join(DATA_DIR, 'google_service_account.json')),
        configuration: true
      },
      files_included: [],
      notes: "Complete backup of WhatsApp bulk sender tool including all data, settings, flows, templates, and configurations"
    };
    
    // Add file list to manifest
    const addToManifest = (filePath) => {
      backupManifest.files_included.push({
        path: filePath,
        timestamp: new Date().toISOString()
      });
    };
    
    // Track what we're adding
    if (fs.existsSync(DATA_DIR)) addToManifest('data/');
    if (fs.existsSync(UPLOAD_DIR)) addToManifest('uploads/');
    if (fs.existsSync(authDir)) addToManifest('.wwebjs_auth/');
    
    // Add manifest to backup
    archive.append(JSON.stringify(backupManifest, null, 2), { name: 'backup_manifest.json' });
    
    // Add a README with restore instructions
    const restoreInstructions = `# WhatsApp Tool Backup Restore Instructions

## What's Included in This Backup:
- All databases (SQLite files)
- Uploaded media files
- WhatsApp session data (if any)
- Flow configurations
- Templates and auto-reply rules
- Agent settings and configurations
- Queue data
- User tags
- Google Sheets credentials (if configured)
- Tool configuration files

## How to Restore:
1. Extract this backup to your WhatsApp tool installation directory
2. Make sure the server is stopped
3. The backup will restore all files to their correct locations
4. Restart the server
5. Your sessions, flows, and all data will be restored

## Backup Created: ${new Date().toISOString()}
## Tool Version: WhatsApp Bulk Sender

For support, please check the documentation or contact the administrator.
`;
    
    archive.append(restoreInstructions, { name: 'README_RESTORE.txt' });
    
    logger.info('Finalizing comprehensive backup archive');
    await archive.finalize();
    
  } catch (err) {
    logger.error({ error: err.message }, 'Backup creation failed');
    res.status(500).send(String(err));
  }
});

// Enhanced restore: comprehensive system restore with validation and safety checks
app.post('/api/restore', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No backup file provided' });
    
    const uploadedFile = path.join(UPLOAD_DIR, req.file.filename);
    logger.info(`Starting restore process for file: ${req.file.originalname}`);
    
    // Create a temporary extraction directory
    const tempExtractDir = path.join(UPLOAD_DIR, `temp_restore_${Date.now()}`);
    await fs.promises.mkdir(tempExtractDir, { recursive: true });
    
    try {
      // Extract the backup to temporary directory first
      logger.info('Extracting backup file for validation');
      await fs.createReadStream(uploadedFile)
        .pipe(unzipper.Extract({ path: tempExtractDir }))
        .promise();
      
      // Validate backup structure and read manifest if available
      const manifestPath = path.join(tempExtractDir, 'backup_manifest.json');
      let manifest = null;
      
      if (fs.existsSync(manifestPath)) {
        try {
          const manifestContent = await fs.promises.readFile(manifestPath, 'utf8');
          manifest = JSON.parse(manifestContent);
          logger.info(`Backup manifest found - Type: ${manifest.type}, Created: ${manifest.created}`);
        } catch (err) {
          logger.warn('Could not parse backup manifest, proceeding with restore');
        }
      }
      
      // Validate essential directories exist in backup
      const expectedDirs = ['data'];
      const missingDirs = expectedDirs.filter(dir => !fs.existsSync(path.join(tempExtractDir, dir)));
      
      if (missingDirs.length > 0) {
        throw new Error(`Invalid backup: missing essential directories: ${missingDirs.join(', ')}`);
      }
      
      // Create backup of current data before restore (safety measure)
      const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safetyBackupDir = path.join(UPLOAD_DIR, `pre_restore_backup_${backupTimestamp}`);
      
      logger.info('Creating safety backup of current data');
      await fs.promises.mkdir(safetyBackupDir, { recursive: true });
      
      // Backup current data directory
      if (fs.existsSync(DATA_DIR)) {
        const currentDataBackup = path.join(safetyBackupDir, 'data');
        await fs.promises.cp(DATA_DIR, currentDataBackup, { recursive: true });
      }
      
      // Now perform the actual restore
      logger.info('Starting data restoration');
      
      // Restore data directory
      if (fs.existsSync(path.join(tempExtractDir, 'data'))) {
        if (fs.existsSync(DATA_DIR)) {
          await fs.promises.rm(DATA_DIR, { recursive: true, force: true });
        }
        await fs.promises.cp(path.join(tempExtractDir, 'data'), DATA_DIR, { recursive: true });
        logger.info('Data directory restored');
      }
      
      // Restore uploads directory
      if (fs.existsSync(path.join(tempExtractDir, 'uploads'))) {
        const uploadsBackupDir = path.join(tempExtractDir, 'uploads');
        const files = await fs.promises.readdir(uploadsBackupDir);
        
        // Only restore non-temporary upload files
        for (const file of files) {
          if (!file.startsWith('temp_') && !file.includes('pre_restore_backup')) {
            const srcFile = path.join(uploadsBackupDir, file);
            const destFile = path.join(UPLOAD_DIR, file);
            
            // Don't overwrite if file already exists (safety measure)
            if (!fs.existsSync(destFile)) {
              await fs.promises.copyFile(srcFile, destFile);
            }
          }
        }
        logger.info('Uploads directory restored');
      }
      
      // Restore WhatsApp session data (if included)
      if (fs.existsSync(path.join(tempExtractDir, '.wwebjs_auth'))) {
        const sessionBackupDir = path.join(tempExtractDir, '.wwebjs_auth');
        const targetSessionDir = path.resolve('.wwebjs_auth');
        
        if (fs.existsSync(targetSessionDir)) {
          await fs.promises.rm(targetSessionDir, { recursive: true, force: true });
        }
        await fs.promises.cp(sessionBackupDir, targetSessionDir, { recursive: true });
        logger.info('WhatsApp session data restored');
      }
      
      // Restore server data directory (if exists and different)
      if (fs.existsSync(path.join(tempExtractDir, 'server', 'data'))) {
        const serverDataBackup = path.join(tempExtractDir, 'server', 'data');
        const targetServerData = path.resolve('./server/data');
        
        if (fs.existsSync(targetServerData) && targetServerData !== DATA_DIR) {
          await fs.promises.rm(targetServerData, { recursive: true, force: true });
          await fs.promises.cp(serverDataBackup, targetServerData, { recursive: true });
          logger.info('Server data directory restored');
        }
      }
      
      // Restore configuration files (with caution)
      const configFiles = ['nodemon.json'];
      for (const configFile of configFiles) {
        const configBackupPath = path.join(tempExtractDir, configFile);
        const targetConfigPath = path.resolve(configFile);
        
        if (fs.existsSync(configBackupPath)) {
          // Create backup of current config
          if (fs.existsSync(targetConfigPath)) {
            await fs.promises.copyFile(targetConfigPath, `${targetConfigPath}.pre-restore-backup`);
          }
          await fs.promises.copyFile(configBackupPath, targetConfigPath);
          logger.info(`Configuration file restored: ${configFile}`);
        }
      }
      
      // Clean up temporary extraction directory
      await fs.promises.rm(tempExtractDir, { recursive: true, force: true });
      
      // Clean up uploaded backup file
      await fs.promises.unlink(uploadedFile);
      
      const response = {
        success: true,
        message: 'Backup restored successfully',
        restored_components: {
          databases: fs.existsSync(DATA_DIR),
          uploads: true,
          whatsapp_sessions: fs.existsSync(path.resolve('.wwebjs_auth')),
          server_data: fs.existsSync(path.resolve('./server/data'))
        },
        safety_backup_location: safetyBackupDir,
        manifest: manifest,
        notes: [
          'A safety backup of your previous data was created before restore',
          'Please restart the server to ensure all changes take effect',
          'Check that all your flows, templates, and settings are working correctly'
        ]
      };
      
      logger.info('Restore completed successfully');
      res.json(response);
      
    } catch (extractErr) {
      // Clean up temporary directory if it exists
      if (fs.existsSync(tempExtractDir)) {
        await fs.promises.rm(tempExtractDir, { recursive: true, force: true });
      }
      throw extractErr;
    }
    
  } catch (err) {
    logger.error({ error: err.message }, 'Restore operation failed');
    res.status(500).json({ 
      error: `Restore failed: ${err.message}`,
      details: 'Please check the backup file format and try again'
    });
  }
});
app.post('/api/auto-reply', (req, res) => {
  const { name, sessionId, matchType, pattern, response, mediaPath, windowStart, windowEnd, enabled } = req.body || {};
  if (!name || !matchType || !pattern) return res.status(400).json({ error: 'name, matchType, pattern required' });
  const info = autoReply.create({ name, session_id: sessionId || null, match_type: matchType, pattern, response: response || '', media_path: mediaPath || null, window_start: windowStart || null, window_end: windowEnd || null, enabled: enabled ? 1 : 0 });
  res.json(info);
});
app.put('/api/auto-reply/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const existing = (autoReply.list() || []).find(r => Number(r.id) === id);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    const merged = {
      name: body.name ?? existing.name,
      session_id: body.sessionId ?? existing.session_id ?? null,
      match_type: body.matchType ?? existing.match_type,
      pattern: body.pattern ?? existing.pattern,
      response: body.response ?? existing.response ?? '',
      media_path: body.mediaPath ?? existing.media_path ?? null,
      window_start: body.windowStart ?? existing.window_start ?? null,
      window_end: body.windowEnd ?? existing.window_end ?? null,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
    };
    // Basic validation to avoid NOT NULL failures
    if (!merged.name || !merged.match_type || !merged.pattern) {
      return res.status(400).json({ error: 'name, matchType, pattern are required' });
    }
    autoReply.update(id, merged);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
app.delete('/api/auto-reply/:id', (req, res) => {
  const id = Number(req.params.id);
  autoReply.delete(id);
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  logger.info('Socket connected');
  socket.on('join_session', ({ sessionId }) => {
    if (!sessionId) return;
    socket.join(getRoom(sessionId));
    const state = sessions.get(sessionId);
    socket.emit('wa_ready', { sessionId, ready: Boolean(state?.isReady) });
    // If a fresh QR was recently generated, push it immediately for faster linking
    if (state && state.lastQr && (Date.now() - state.lastQrAt) < 60000) {
      socket.emit('wa_qr', { sessionId, qr: state.lastQr });
    }
  });
  // Serve system variables preview (client may request real-time)
  socket.on('sys_vars_now', () => {
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const fmtDate = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`;
    const fmtTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    socket.emit('sys_vars_now', { date: fmtDate, time: fmtTime, datetime: `${fmtDate} ${fmtTime}` });
  });
});

server.listen(PORT, () => {
  logger.info(`Server listening on http://localhost:${PORT}`);
  
  // Load user tags
  loadUserTagsFromFile();
  
  // Start cron scheduler for flow triggers
  startCronScheduler();
  logger.info('Cron scheduler started for flow triggers');
  
  // Start workers for any session that becomes ready
  setInterval(() => {
    for (const [sid, st] of sessions.entries()) {
      if (st.isReady) {
        const worker = workers.get(sid);
        const pendingCount = queue.pendingCount(sid);
        
        // Start worker if not running and there are pending jobs
        if (pendingCount > 0 && (!worker || !worker.running)) {
          logger.info({ sessionId: sid, pendingCount }, 'Auto-starting worker for pending jobs');
          // Remove existing worker if it exists but is not running
          if (worker && !worker.running) {
            workers.delete(sid);
          }
          startWorker(sid);
        }
      }
    }
  }, 1000);
  
  // Handle timeouts for waiting flows
  setInterval(() => {
    if (!global.waitingFlows) return;
    
    const now = Date.now();
    for (const [phone, flowState] of global.waitingFlows.entries()) {
      if (flowState.timeout && (now - flowState.timestamp) > flowState.timeout) {
        // Timeout reached, continue with timeout node
        const flow = savedFlows.get(flowState.flowId);
        if (flow && flowState.timeoutNodeId) {
          const byId = new Map();
          for (const n of flow.nodes) byId.set(n.id, n);
          const timeoutNode = byId.get(flowState.timeoutNodeId);
          
          if (timeoutNode) {
            logger.info({ phone, flowId: flow.id, timeoutNodeId: flowState.timeoutNodeId }, 'Flow timeout reached, continuing with timeout node');
            continueFlowExecution(flow, timeoutNode, flowState.context, flowState.context.sessionId);
          }
        }
        
        // Remove from waiting flows
        global.waitingFlows.delete(phone);
      }
    }
  }, 5000); // Check every 5 seconds
  // Reinitialize known sessions directories on boot to show in UI
  (async () => {
    try {
      const authBase = path.resolve('.wwebjs_auth');
      if (fs.existsSync(authBase)) {
        // First, clean up all lock files from all sessions
        const entries = fs.readdirSync(authBase, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const name = e.name.replace(/^session-/, '');
          if (name.startsWith('whats-tool-')) {
            const sessionId = name.replace('whats-tool-', '');
            await cleanupSessionFiles(sessionId);
          }
        }
        
        // Wait a moment for cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Now initialize sessions
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const name = e.name.replace(/^session-/, '');
          if (name.startsWith('whats-tool-')) {
            const sessionId = name.replace('whats-tool-', '');
            if (!sessions.has(sessionId)) {
              const st = await ensureSession(sessionId);
              try { 
                await st.client.initialize(); 
              } catch (initErr) {
                logger.warn({ sessionId, error: initErr.message }, 'Session initialization failed during startup');
              }
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'Failed to pre-load sessions');
    }
  })();
});

// Enhanced session cleanup function
async function cleanupSessionFiles(sessionId) {
  try {
    const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-whats-tool-${sessionId}`);
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'];
    
    for (const lockFile of lockFiles) {
      try {
        const lockPath = path.join(sessionPath, lockFile);
        await fs.promises.unlink(lockPath);
        logger.debug({ sessionId, lockFile }, 'Removed lock file');
      } catch (err) {
        // File might not exist, which is fine
        if (err.code !== 'ENOENT') {
          logger.warn({ sessionId, lockFile, error: err.message }, 'Failed to remove lock file');
        }
      }
    }
    
    // Also clean up any Chrome crash dumps and temp files
    try {
      const files = await fs.promises.readdir(sessionPath);
      for (const file of files) {
        if (file.startsWith('Crashpad') || file.endsWith('.dmp') || file.startsWith('chrome_debug.log')) {
          try {
            await fs.promises.unlink(path.join(sessionPath, file));
            logger.debug({ sessionId, file }, 'Removed crash/temp file');
          } catch (err) {
            // Ignore cleanup errors
          }
        }
      }
    } catch (err) {
      // Directory might not exist
    }
  } catch (err) {
    logger.warn({ sessionId, error: err.message }, 'Session cleanup failed');
  }
}

// Enhanced session health monitoring
const sessionHealth = new Map(); // sessionId -> { lastCheck, status, errors, recoveryAttempts }

async function checkSessionHealth(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) {
    return { healthy: false, reason: 'Session not found', lastCheck: new Date().toISOString() };
  }

  const health = {
    lastCheck: new Date().toISOString(),
    status: 'unknown',
    errors: [],
    recoveryAttempts: sessionHealth.get(sessionId)?.recoveryAttempts || 0,
    uptime: state.createdAt ? Date.now() - new Date(state.createdAt).getTime() : 0,
    isReady: state.isReady,
    hasClient: !!state.client
  };

  try {
    // Check if client is responsive
    if (state.client) {
      const info = await state.client.info;
      health.status = 'healthy';
      health.phoneNumber = info?.wid?.user;
      health.pushName = info?.pushname;
    } else {
      health.status = 'unhealthy';
      health.errors.push('No client instance');
    }
  } catch (error) {
    health.status = 'unhealthy';
    health.errors.push(`Client error: ${error.message}`);
    health.recoveryAttempts += 1;
  }

  sessionHealth.set(sessionId, health);
  return health;
}

// Session recovery with exponential backoff
async function recoverSession(sessionId, reason = 'unknown') {
  const health = sessionHealth.get(sessionId) || { recoveryAttempts: 0 };
  const maxAttempts = 5;
  
  if (health.recoveryAttempts >= maxAttempts) {
    logger.error({ sessionId, reason, attempts: health.recoveryAttempts }, 'Max recovery attempts reached');
    return { success: false, error: 'Max recovery attempts reached' };
  }

  logger.info({ sessionId, reason, attempt: health.recoveryAttempts + 1 }, 'Attempting session recovery');
  
  try {
    // Clean up existing session
    const state = sessions.get(sessionId);
    if (state?.client) {
      try { await state.client.destroy(); } catch {}
    }
    
    // Clean up lock files
    await cleanupSessionFiles(sessionId);
    
    // Wait with exponential backoff
    const delay = Math.min(1000 * Math.pow(2, health.recoveryAttempts), 30000);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Create new session
    const newState = await createClient(sessionId);
    await newState.client.initialize();
    
    health.recoveryAttempts = 0; // Reset on success
    sessionHealth.set(sessionId, health);
    
    logger.info({ sessionId }, 'Session recovery successful');
    return { success: true };
  } catch (error) {
    health.recoveryAttempts += 1;
    sessionHealth.set(sessionId, health);
    
    logger.error({ sessionId, error: String(error), attempt: health.recoveryAttempts }, 'Session recovery failed');
    return { success: false, error: error.message };
  }
}

// Global session health monitor
setInterval(async () => {
  for (const [sessionId, state] of sessions) {
    try {
      const health = await checkSessionHealth(sessionId);
      
      // If session is unhealthy, attempt recovery
      if (health.status === 'unhealthy' && health.recoveryAttempts < 5) {
        await recoverSession(sessionId, 'health check failed');
      }
    } catch (error) {
      logger.error({ sessionId, error: String(error) }, 'Health check failed');
    }
  }
}, 30000); // Check every 30 seconds

// Graceful shutdown to avoid profile corruption
async function gracefulShutdown() {
  try {
    logger.info('Shutting down gracefully...');
    
    // Close all sessions properly
    for (const [sid, st] of sessions.entries()) {
      try { 
        logger.info({ sessionId: sid }, 'Closing session');
        await st.client?.logout(); 
      } catch (err) {
        logger.warn({ sessionId: sid, error: err.message }, 'Logout failed');
      }
      
      try { 
        await st.client?.destroy(); 
      } catch (err) {
        logger.warn({ sessionId: sid, error: err.message }, 'Destroy failed');
      }
      
      // Clean up session lock files
      await cleanupSessionFiles(sid);
    }
    
    // Give a moment for cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (err) {
    logger.error({ error: err.message }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (err) => {
  logger.error({ error: err.message }, 'Uncaught exception, shutting down');
  gracefulShutdown();
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason: String(reason) }, 'Unhandled rejection, shutting down');
  gracefulShutdown();
});



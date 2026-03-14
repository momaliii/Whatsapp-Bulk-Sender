import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Config & Logger
import { PORT, UPLOAD_DIR, DATA_DIR } from './config/index.js';
import { logger } from './utils/logger.js';

// Services
import { initSocket } from './services/socket.js';
import { savedFlows, waitingFlows, userTags, sessions, workers, extractResults } from './services/state.js';
import { queue } from './services/managers.js';
import { 
    loadFlows, 
    loadUserTags, 
    saveFlowsToFile, 
    saveUserTagsToFile 
} from './services/persistence.js';
import { continueFlowExecution, checkFlowTriggers } from './services/flows.js';
import { ensureSession, triggerReconnect } from './services/whatsapp.js';
import { startWorker } from './services/worker.js';
import { startWatchdog, stopWatchdog } from './services/watchdog.js';

// Routes
import sessionRoutes from './routes/sessions.js';
import adminRoutes from './routes/admin.js';
import aiRoutes from './routes/ai.js';
import flowRoutes from './routes/flows.js';
import contactRoutes from './routes/contacts.js';
import campaignRoutes from './routes/campaigns.js';
import agentRoutes from './routes/agent.js';
import googleRoutes from './routes/google.js';
import extractRoutes from './routes/extract.js';

// ES Module setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, stack: reason?.stack }, 'Unhandled rejection');
});

// Express setup
const app = express();
const server = http.createServer(app);
const io = initSocket(server);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use('/public', express.static(path.join(__dirname, '../client/public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// Root route
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

// Health check (for load balancers / monitoring)
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), sessions: sessions.size });
});

// API Routes
app.use(sessionRoutes);
app.use(adminRoutes);
app.use(aiRoutes);
app.use(flowRoutes);
app.use(contactRoutes);
app.use(campaignRoutes);
app.use(agentRoutes);
app.use(googleRoutes);
app.use(extractRoutes);

// Global Error Handler (optional but recommended)
app.use((err, req, res, next) => {
  logger.error({ err: String(err), stack: err.stack }, 'Unhandled Error');
  res.status(500).json({ error: 'Internal Server Error' });
});

// Session Cleanup Helper - folderName is the actual dir name (e.g. session-whats-tool-X or session-session-whats-tool-X)
async function cleanupSessionFiles(folderName) {
  try {
    const sessionPath = path.resolve('./.wwebjs_auth', folderName);
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'];
    
    for (const lockFile of lockFiles) {
      try {
        const lockPath = path.join(sessionPath, lockFile);
        await fs.promises.unlink(lockPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {}
      }
    }
    
    // Clean crash dumps
    try {
      if (fs.existsSync(sessionPath)) {
        const files = await fs.promises.readdir(sessionPath);
        for (const file of files) {
            if (file.startsWith('Crashpad') || file.endsWith('.dmp') || file.startsWith('chrome_debug.log')) {
                try { await fs.promises.unlink(path.join(sessionPath, file)); } catch {}
            }
        }
      }
    } catch {}
  } catch (err) {
    logger.warn({ folder: folderName, error: err.message }, 'Session cleanup failed');
  }
}

let workerStartIntervalId = null;
let waitingFlowsIntervalId = null;
let extractEvictIntervalId = null;

// Export app for Hostinger lsnode (which uses require() - see server.cjs wrapper)
export { app };

// Server Start - skip when loaded by lsnode (LiteSpeed)
if (!process.env.LSNODE) {
server.listen(PORT, () => {
  logger.info(`Server listening on http://localhost:${PORT}`);
  
  // Initialize data
  loadUserTags();
  loadFlows();
  
  // Start Watchdog Service
  startWatchdog();
  
  // Start workers for any session that becomes ready
  workerStartIntervalId = setInterval(() => {
    for (const [sid, st] of sessions.entries()) {
      if (st.isReady) {
        const worker = workers.get(sid);
        const pendingCount = queue.pendingCount(sid);
        
        if (pendingCount > 0 && (!worker || !worker.running)) {
          logger.info({ sessionId: sid, pendingCount }, 'Auto-starting worker for pending jobs');
          if (worker && !worker.running) workers.delete(sid);
          startWorker(sid);
        }
      }
    }
  }, 1000);
  
  // Handle timeouts for waiting flows
  waitingFlowsIntervalId = setInterval(async () => {
    if (waitingFlows.size === 0) return;
    
    const now = Date.now();
    for (const [phone, flowState] of waitingFlows.entries()) {
      if (flowState.timeout && (now - flowState.timestamp) > flowState.timeout) {
        // Timeout reached
        const flow = savedFlows.get(flowState.flowId);
        if (flow && flowState.timeoutNodeId) {
          const byId = new Map();
          for (const n of flow.nodes) byId.set(n.id, n);
          const timeoutNode = byId.get(flowState.timeoutNodeId);
          
          if (timeoutNode) {
            logger.info({ phone, flowId: flow.id, timeoutNodeId: flowState.timeoutNodeId }, 'Flow timeout reached');
            try {
              await continueFlowExecution(flow, timeoutNode, flowState.context, flowState.context.sessionId);
            } catch (e) {
              logger.error({ err: String(e), flowId: flow.id }, 'Flow timeout execution failed');
            }
          }
        }
        waitingFlows.delete(phone);
      }
    }
  }, 5000);

  // Evict extractResults older than 1 hour
  extractEvictIntervalId = setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, data] of extractResults.entries()) {
      const ts = data.createdAt instanceof Date ? data.createdAt.getTime() : 0;
      if (ts && ts < cutoff) extractResults.delete(id);
    }
  }, 10 * 60 * 1000);

  // Pre-load sessions
  (async () => {
    try {
      const authBase = path.resolve('./.wwebjs_auth');
      if (fs.existsSync(authBase)) {
        // Cleanup locks
        const entries = fs.readdirSync(authBase, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          // LocalAuth folders often look like:
          // - session-whats-tool-<id>
          // - session-session-whats-tool-<id>
          // Normalize by stripping all leading "session-" prefixes.
          let name = e.name;
          while (name.startsWith('session-')) name = name.slice('session-'.length);
          if (name.startsWith('whats-tool-')) {
            await cleanupSessionFiles(e.name);
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Initialize sessions (one at a time, with stagger to reduce resource contention)
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          let name = e.name;
          while (name.startsWith('session-')) name = name.slice('session-'.length);
          if (name.startsWith('whats-tool-')) {
            const sessionId = name.replace('whats-tool-', '');
            if (!sessions.has(sessionId)) {
              try {
                await ensureSession(sessionId);
              } catch (err) {
                logger.warn({ sessionId, err: String(err) }, 'Failed to pre-load session');
              }
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'Failed to pre-load sessions');
    }
  })();
});
}

// Handle process exit
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  if (workerStartIntervalId) { clearInterval(workerStartIntervalId); workerStartIntervalId = null; }
  if (waitingFlowsIntervalId) { clearInterval(waitingFlowsIntervalId); waitingFlowsIntervalId = null; }
  if (extractEvictIntervalId) { clearInterval(extractEvictIntervalId); extractEvictIntervalId = null; }
  stopWatchdog();
  for (const [id, w] of workers) {
    if (w) w.running = false;
  }
  workers.clear();
  for (const [id, session] of sessions) {
    try {
      if (session?._authPollInterval) {
        clearInterval(session._authPollInterval);
        session._authPollInterval = null;
      }
      if (session?.client && !session.client.destroyed) {
        await session.client.destroy();
      }
    } catch {}
  }
  process.exit(0);
});

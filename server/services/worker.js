import { sessions, workers } from './state.js';
import { getIO, getRoom } from './socket.js';
import { logger } from '../utils/logger.js';
import { queue } from './managers.js';
import { sendItem, validateWhatsAppNumber } from './messaging.js';
import { 
  parseTimeStringToMinutes, 
  inWindow, 
  waitUntilWindow, 
  jitteredDelay, 
  replaceSystemVars, 
  sleep 
} from '../utils/format.js';

export async function runCampaignLoop(sessionId) {
  const state = sessions.get(sessionId);
  if (!state || !state.currentCampaign) return;
  const camp = state.currentCampaign;
  const { id, items, delayMs, startTime, window, retries, throttle, validateNumbers } = camp;
  const startMin = parseTimeStringToMinutes(window?.start);
  const endMin = parseTimeStringToMinutes(window?.end);
  const io = getIO();

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
        
        // Use simulateTyping option
        await sendItem(state, enriched, { simulateTyping: true });
        
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
      // jittered delay for main loop to avoid robotic timing
      const loopDelay = jitteredDelay(delayMs, 20); // 20% jitter
      await sleep(loopDelay);
      
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

const FAILURE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const FAILURE_BURST_THRESHOLD = 10; // consecutive failures to trigger cooldown

export async function startWorker(sessionId) {
  const existingWorker = workers.get(sessionId);
  if (existingWorker && existingWorker.running) return;
  
  const state = sessions.get(sessionId);
  if (!state) return;
  const worker = { running: true, paused: false, messagesSinceThrottle: 0, consecutiveFailures: 0 };
  workers.set(sessionId, worker);
  logger.info({ sessionId }, 'Worker started');
  const io = getIO();

  while (worker.running) {
    try {
      const sessionState = sessions.get(sessionId);
      if (!sessionState?.isReady) { 
        // logger.debug({ sessionId }, 'Session not ready, waiting...');
        await sleep(5000); 
        continue; 
      }
      
      if (worker.paused) {
        await sleep(1000);
        continue;
      }

      // Check for cooldown
      if (worker.cooldownUntil && Date.now() < worker.cooldownUntil) {
        await sleep(5000);
        continue;
      } else if (worker.cooldownUntil) {
        worker.cooldownUntil = null;
        worker.consecutiveFailures = 0;
      }

      const job = queue.getNextJob(sessionId);
      if (!job) {
        await sleep(2000);
        continue;
      }

      // Process job
      try {
         // Validate WhatsApp number before sending
        const item = { phone: job.phone, message: job.message, caption: job.caption, mediaPath: job.media_path };
        const validation = await validateWhatsAppNumber(sessionState, item.phone);
        if (!validation.valid) {
            io.to(getRoom(sessionId)).emit('campaign_progress', {
            sessionId,
            id: job.campaign_id,
            index: job.id,
            phone: job.phone,
            status: 'failed',
            error: `Validation failed: ${validation.error}`,
            });
             queue.failJob(job.id, `Validation failed: ${validation.error}`);
             continue;
        }

        const enriched = { ...item };
        if (enriched.message) enriched.message = replaceSystemVars(enriched.message, enriched);
        if (enriched.caption) enriched.caption = replaceSystemVars(enriched.caption, enriched);
        
        // Send with simulated typing (90s timeout)
        const sendPromise = sendItem(sessionState, enriched, { simulateTyping: true });
        const timeoutPromise = sleep(90000).then(() => { throw new Error('Send operation timed out after 90s'); });
        const sentMsg = await Promise.race([sendPromise, timeoutPromise]);
        
        // Capture and update message ID
        if (sentMsg && sentMsg.id && sentMsg.id._serialized) {
            queue.updateJobMessageId(job.id, sentMsg.id._serialized);
        }
        
        io.to(getRoom(sessionId)).emit('campaign_progress', { sessionId, id: job.campaign_id, index: job.id, phone: job.phone, status: 'sent' });
        queue.completeJob(job.id);
        
        // Success resets failure counter
        worker.consecutiveFailures = 0;

      } catch (err) {
        queue.failJob(job.id, String(err));
        io.to(getRoom(sessionId)).emit('campaign_progress', { sessionId, id: job.campaign_id, index: job.id, phone: job.phone, status: 'failed', error: String(err) });
        
        worker.consecutiveFailures++;
        if (worker.consecutiveFailures >= FAILURE_BURST_THRESHOLD) {
          worker.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
          logger.warn({ sessionId, failures: worker.consecutiveFailures }, 'Worker entered cooldown mode due to burst failures');
        }
      }

      // Delays
      await sleep(job.delay_ms || 1000);

    } catch (e) {
      logger.error({ sessionId, error: String(e) }, 'Worker loop error');
      await sleep(5000);
    }
  }
}


import { sessions, workers } from './state.js';
import { triggerReconnect } from './whatsapp.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/format.js';

const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HEALTH_CHECK_TIMEOUT_MS = 30000; // 30 seconds

let watchdogIntervalId = null;

export function stopWatchdog() {
  if (watchdogIntervalId) {
    clearInterval(watchdogIntervalId);
    watchdogIntervalId = null;
  }
}

export async function startWatchdog() {
  logger.info('Connection Watchdog started');
  
  watchdogIntervalId = setInterval(async () => {
    try {
      for (const [sessionId, state] of sessions.entries()) {
        // skip if already reconnecting
        if (state._reconnecting) continue;
        
        // if supposed to be ready but client is missing/destroyed
        if (state.isReady && (!state.client || state.client.destroyed)) {
          logger.warn({ sessionId }, 'Watchdog: Session marked ready but client is gone. Triggering reconnect.');
          await triggerReconnect(sessionId);
          continue;
        }

        // if we have a client, let's ping it
        if (state.client) {
          try {
            // Race a state check against a timeout
            const statePromise = state.client.getState();
            const timeoutPromise = sleep(HEALTH_CHECK_TIMEOUT_MS).then(() => 'TIMEOUT');
            
            const result = await Promise.race([statePromise, timeoutPromise]);
            
            if (result === 'TIMEOUT') {
              logger.warn({ sessionId }, 'Watchdog: Client state check timed out. Possible zombie process.');
              await triggerReconnect(sessionId);
            } else if (result !== 'CONNECTED') {
              logger.warn({ sessionId, state: result }, 'Watchdog: Client not connected.');
              // triggerReconnect(sessionId); // Optional: Auto-heal non-connected states
            }
          } catch (err) {
            logger.error({ sessionId, err: String(err) }, 'Watchdog: Health check failed');
            // If Puppeteer is disconnected, error usually thrown
            if (String(err).includes('Session closed') || String(err).includes('Protocol error')) {
               await triggerReconnect(sessionId);
            }
          }
        }
      }
    } catch (mainErr) {
      logger.error({ err: String(mainErr) }, 'Watchdog loop error');
    }
  }, WATCHDOG_INTERVAL_MS);
}


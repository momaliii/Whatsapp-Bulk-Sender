import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import wweb from 'whatsapp-web.js';
import { UPLOAD_DIR } from '../config/index.js';
import { logger } from '../utils/logger.js';

const { MessageMedia } = wweb;

// Normalize phone/chatId: preserve @g.us, @lid, etc.; only normalize plain numbers to @c.us
function normalizeChatId(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;
  if (trimmed.includes('@')) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, '');
  return digits ? `${digits}@c.us` : null;
}

// WhatsApp number validation function
export async function validateWhatsAppNumber(state, phone) {
  try {
    const chatId = normalizeChatId(phone);
    if (!chatId) return { valid: false, error: 'Phone or chat ID is required' };

    if (!state.isReady || !state.client || !state.client.info) {
      return { valid: false, error: 'WhatsApp session not ready' };
    }

    // For group IDs, getNumberId is not applicable - use getChatById only
    if (chatId.includes('@g.us')) {
      try {
        const chat = await state.client.getChatById(chatId);
        if (chat && chat.id) return { valid: true, chatId, chat };
      } catch (e) {
        logger.warn({ chatId, err: String(e) }, 'getChatById for group failed');
      }
      return { valid: false, error: 'Group chat not found' };
    }

    try {
      const chat = await state.client.getChatById(chatId);
      if (chat && chat.id) return { valid: true, chatId, chat };
    } catch (chatError) {
      try {
        const numberId = chatId.replace('@c.us', '');
        const numberInfo = await state.client.getNumberId(numberId);
        if (numberInfo) return { valid: true, chatId, numberInfo };
      } catch (numberError) {
        return { valid: false, error: 'Number not registered on WhatsApp' };
      }
    }
    return { valid: false, error: 'Unable to validate number' };
  } catch (error) {
    return { valid: false, error: `Validation error: ${error.message}` };
  }
}

export async function sendItem(state, item, options = {}) {
  const { phone, message, mediaPath, caption } = item;
  const { simulateTyping = false } = options;

  if (!phone || typeof phone !== 'string' || !phone.trim()) {
    throw new Error('Phone or chat ID is required');
  }

  let chatId = normalizeChatId(phone);
  if (!chatId) throw new Error('Phone or chat ID is required');

  if (!state.isReady) {
    throw new Error('WhatsApp session is not ready. Please check your connection and try again.');
  }

  if (!state.client || !state.client.info) {
    throw new Error('WhatsApp client is disconnected. Please reconnect your session.');
  }

  const raw = chatId.includes('@c.us') ? chatId.replace('@c.us', '') : (chatId.includes('@g.us') ? chatId.replace(/@g\.us$/i, '') : chatId.replace(/[^0-9]/g, ''));

  try {
    // getNumberId is for contacts only - skip for groups
    if (!chatId.includes('@g.us')) {
      try {
        const info = await state.client.getNumberId(raw);
        if (info && typeof info === 'object' && info._serialized) {
          chatId = info._serialized;
        }
      } catch {}
    }

    // Warm up chat to avoid WA web internal "lid missing in chat table" issues
    try { await state.client.getChatById(chatId); } catch {}

    // Simulate typing if enabled
    if (simulateTyping) {
        try {
            const chat = await state.client.getChatById(chatId);
            await chat.sendStateTyping();
            
            // Calculate natural delay: ~60ms per char + random variation
            // Min 1s, Max 10s
            const textLen = (message || caption || '').length;
            const baseDelay = Math.min(10000, Math.max(1000, textLen * 60));
            const jitter = Math.floor(Math.random() * 1000); // 0-1000ms jitter
            
            await new Promise(r => setTimeout(r, baseDelay + jitter));
            await chat.clearState();
        } catch (e) {
            // Ignore typing errors (e.g. if chat not found)
        }
    }

    let sentMessage;
    if (mediaPath) {
      const absPath = path.isAbsolute(mediaPath) ? mediaPath : path.join(UPLOAD_DIR, mediaPath);
      const exists = fs.existsSync(absPath);
      if (!exists) throw new Error(`Media not found: ${absPath}`);
      const mimeType = mime.lookup(absPath) || 'application/octet-stream';
      const base64 = fs.readFileSync(absPath, { encoding: 'base64' });
      const filename = path.basename(absPath);
      const media = new MessageMedia(mimeType, base64, filename);
      const usedCaption = typeof caption === 'string' && caption.length ? caption : (message || undefined);
      // Important: WhatsApp Web changes often break `sendSeen` internally.
      // Disable it so message sending doesn't fail on `sendSeen/markedUnread` evaluation errors.
      sentMessage = await state.client.sendMessage(chatId, media, { caption: usedCaption, sendSeen: false });
    } else {
      sentMessage = await state.client.sendMessage(chatId, message || '', { sendSeen: false });
    }
    return sentMessage;
  } catch (error) {
    const errorMsg = String(error?.message || error);

    // Retry once for WA internal chat-table issues by warming chat again
    if (errorMsg.includes('Lid is missing in chat table')) {
      let lastErr = null;

      // 1) Try WPPConnect WA-JS send with createChat=true (text-only)
      try {
        const page = state.client?.pupPage;
        if (page && typeof page.evaluate === 'function' && typeof page.addScriptTag === 'function' && !mediaPath) {
          const hasWpp = await page.evaluate(() => Boolean(window.WPP && window.WPP.chat && window.WPP.chat.sendTextMessage));
          if (!hasWpp) {
            const wppPath = path.resolve('node_modules/@wppconnect/wa-js/dist/wppconnect-wa.js');
            await page.addScriptTag({ path: wppPath });
          }

          const wppSent = await page.evaluate(async (cid, text) => {
            try {
              const info = {
                hasWPP: Boolean(window.WPP),
                hasChat: Boolean(window.WPP?.chat),
                hasSendText: Boolean(window.WPP?.chat?.sendTextMessage),
              };
              if (!info.hasSendText) return { _wpp_debug: info };

              try { if (window.WPP.isReady && typeof window.WPP.isReady.then === 'function') await window.WPP.isReady; } catch {}
              const res = await window.WPP.chat.sendTextMessage(cid, text, { createChat: true });
              return { _wpp_ok: true, _wpp_debug: info, res };
            } catch (e) {
              return { _wpp_error: String(e?.message || e) };
            }
          }, chatId, message || '');

          if (wppSent?._wpp_ok) return wppSent;
          if (wppSent?._wpp_error) throw new Error(`WPP_SEND_FAILED: ${wppSent._wpp_error}`);
          if (wppSent?._wpp_debug) throw new Error(`WPP_NOT_READY: ${JSON.stringify(wppSent._wpp_debug)}`);
        }
      } catch (e) {
        lastErr = e;
      }

      // 2) Try to force-create the chat in WA internal store
      try {
        const page = state.client?.pupPage;
        if (page && typeof page.evaluate === 'function') {
          await page.evaluate(async (cid) => {
            try {
              const wid = window.Store?.WidFactory?.createWid?.(cid);
              if (!wid || !window.Store?.Chat) return false;
              let chat = window.Store.Chat.get(wid);
              if (!chat && typeof window.Store.Chat.find === 'function') {
                try { chat = await window.Store.Chat.find(wid, { createChat: true }); }
                catch { chat = await window.Store.Chat.find(wid); }
              }
              return Boolean(chat);
            } catch {
              return false;
            }
          }, chatId);
        }
      } catch (e) {
        lastErr = lastErr || e;
      }

      try { await state.client.getChatById(chatId); } catch (e) { lastErr = lastErr || e; }

      // 3) If WA is running in LID addressing mode, try sending to the LID jid directly.
      const lidChatId = raw ? `${raw}@lid` : null;
      if (lidChatId) {
        try { await state.client.getChatById(lidChatId); } catch (e) { lastErr = lastErr || e; }
        try {
          if (mediaPath) {
            const absPath = path.isAbsolute(mediaPath) ? mediaPath : path.join(UPLOAD_DIR, mediaPath);
            const mimeType = mime.lookup(absPath) || 'application/octet-stream';
            const base64 = fs.readFileSync(absPath, { encoding: 'base64' });
            const filename = path.basename(absPath);
            const media = new MessageMedia(mimeType, base64, filename);
            const usedCaption = typeof caption === 'string' && caption.length ? caption : (message || undefined);
            return await state.client.sendMessage(lidChatId, media, { caption: usedCaption, sendSeen: false });
          }
          return await state.client.sendMessage(lidChatId, message || '', { sendSeen: false });
        } catch (e) { lastErr = e; }
      }

      // 4) Final retry using the same chatId
      try {
        if (mediaPath) {
          const absPath = path.isAbsolute(mediaPath) ? mediaPath : path.join(UPLOAD_DIR, mediaPath);
          const mimeType = mime.lookup(absPath) || 'application/octet-stream';
          const base64 = fs.readFileSync(absPath, { encoding: 'base64' });
          const filename = path.basename(absPath);
          const media = new MessageMedia(mimeType, base64, filename);
          const usedCaption = typeof caption === 'string' && caption.length ? caption : (message || undefined);
          return await state.client.sendMessage(chatId, media, { caption: usedCaption, sendSeen: false });
        }
        return await state.client.sendMessage(chatId, message || '', { sendSeen: false });
      } catch (e) {
        lastErr = e;
      }

      throw lastErr || error;
    }
    
    // Handle specific session closed errors
    if (errorMsg.includes('Session closed') || 
        errorMsg.includes('Protocol error') || 
        errorMsg.includes('Runtime.callFunctionOn') ||
        errorMsg.includes('Target closed') ||
        errorMsg.includes('Connection closed')) {
      
      // Mark session as not ready
      state.isReady = false;
      
      // Note: reconnection logic is handled in the main loop or manually triggered
      // We just throw here
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


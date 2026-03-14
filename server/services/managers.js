import { QueueManager } from './queue.js';
import { AutoReplyManager } from './autoreply.js';
import { AgentManager } from './agent.js';
import { DB_FILE, AR_DB, AGENT_DB } from '../config/index.js';

export const queue = new QueueManager(DB_FILE);
export const autoReply = new AutoReplyManager(AR_DB);
export const agentMgr = new AgentManager(AGENT_DB);

// Ensure AI Agent is enabled by default, preserving existing prompt/API key
try {
  const cur = agentMgr.getSettings();
  if (!cur.enabled) agentMgr.updateSettings({ enabled: true, prompt: cur.prompt });
} catch {}


import { createDatabase } from '../utils/sqlite-adapter.js';
import { DB_FILE, AR_DB, AGENT_DB } from '../config/index.js';

const qDb = await createDatabase(DB_FILE);
const arDb = await createDatabase(AR_DB);
const agDb = await createDatabase(AGENT_DB);

import { QueueManager } from './queue.js';
import { AutoReplyManager } from './autoreply.js';
import { AgentManager } from './agent.js';

export const queue = new QueueManager(qDb);
export const autoReply = new AutoReplyManager(arDb);
export const agentMgr = new AgentManager(agDb);

// Ensure AI Agent is enabled by default, preserving existing prompt/API key
try {
  const cur = agentMgr.getSettings();
  if (!cur.enabled) agentMgr.updateSettings({ enabled: true, prompt: cur.prompt });
} catch {}

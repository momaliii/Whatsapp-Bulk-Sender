import { logger } from '../utils/logger.js';
import { replaceSystemVars, sleep } from '../utils/format.js';
import { savedFlows, userTags, flowAnalytics, waitingFlows, sessions } from './state.js';
import { agentMgr } from './managers.js';
import { appendRows as gsAppendRows, readRange as gsReadRange } from './sheets.js';
import { sendItem } from './messaging.js';
import { ensureSession } from './whatsapp.js';

function replaceDynamicVars(text, context) {
  const { userData, systemVars, messageData } = context;
  
  // Use the enhanced replaceSystemVars function for date/time variables
  text = replaceSystemVars(text);
  
  // Additional context-specific variables
  text = text.replace(/\{session_id\}/g, context.sessionId || '');
  text = text.replace(/\{random_number\}/g, Math.floor(Math.random() * 1000));
  
  // User data variables
  if (userData) {
    Object.keys(userData).forEach(key => {
      const regex = new RegExp(`\\{${key}\\}`, 'g');
      text = text.replace(regex, userData[key] || '');
    });
  }
  
  // Message data variables
  if (messageData) {
    text = text.replace(/\{sender_name\}/g, messageData.senderName || '');
    text = text.replace(/\{sender_phone\}/g, messageData.senderPhone || '');
    text = text.replace(/\{message_text\}/g, messageData.messageText || '');
    text = text.replace(/\{chat_title\}/g, messageData.chatTitle || '');
  }
  
  // User tag variables
  const phone = userData?.phone;
  if (phone && userTags.has(phone)) {
    const tags = Array.from(userTags.get(phone));
    text = text.replace(/\{user_tags\}/g, tags.join(', '));
    text = text.replace(/\{user_tags_count\}/g, tags.length.toString());
    
    tags.forEach((tag, index) => {
      text = text.replace(new RegExp(`\\{user_tags_${index}\\}`, 'g'), tag);
    });
    
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

function evaluateCondition(condition, context) {
  const { userData } = context;
  
  try {
    const parts = condition.split(':');
    const type = parts[0];
    const params = parts.slice(1);
    
    const now = new Date();

    switch (type) {
      case 'equals':
        return userData[params[0]] === params[1];
      case 'contains':
        return (userData[params[0]] || '').toLowerCase().includes(params[1].toLowerCase());
      case 'greater_than':
        return Number(userData[params[0]] || 0) > Number(params[1]);
      case 'less_than':
        return Number(userData[params[0]] || 0) < Number(params[1]);
      case 'time_between': {
        const start = new Date(`${now.toDateString()} ${params[0]}`);
        const end = new Date(`${now.toDateString()} ${params[1]}`);
        return now >= start && now <= end;
      }
      case 'day_of_week': {
        const day = now.getDay();
        const targetDays = params[0].split(',').map(d => Number(d));
        return targetDays.includes(day);
      }
      case 'message_count':
        return (userData.messageCount || 0) >= Number(params[0]);
      case 'has_tag':
        return userData.phone && userTags.has(userData.phone) && userTags.get(userData.phone).has(params[0]);
      case 'has_any_tag':
        if (!userData.phone || !userTags.has(userData.phone)) return false;
        const userHasTags = userTags.get(userData.phone);
        const targetTags = params[0].split(',');
        return targetTags.some(t => userHasTags.has(t));
      case 'random_percent':
        return Math.random() * 100 < Number(params[0]);
      case 'expression':
        try {
          const expr = replaceDynamicVars(params.join(':'), context);
          return Function('return ' + expr)() === true;
        } catch {
          return false;
        }
      default:
        return false;
    }
  } catch (e) {
    return false;
  }
}

function evaluateTrigger(node, messageBody, senderPhone, sessionId) {
  try {
    const triggerType = node.data?.triggerType || 'exact';
    const condition = node.data?.condition || '';
    const text = (messageBody || '').toLowerCase();
    
    switch (triggerType) {
      case 'exact':
        return text === condition.toLowerCase();
      case 'contains':
        return text.includes(condition.toLowerCase());
      case 'regex':
        try { return new RegExp(condition, 'i').test(text); } catch { return false; }
      case 'starts_with':
        return text.startsWith(condition.toLowerCase());
      case 'always':
        return true;
      case 'no_match':
        // This trigger is special: it only runs if no other flow triggered
        // Logic for this is handled in the caller (checkFlowTriggers)
        return false;
      case 'tag_added':
        // Event-based trigger, handled separately
        return false;
      case 'user_message':
        // Triggers on any message from user
        return true;
      default:
        return false;
    }
  } catch (e) {
    return false;
  }
}

async function executeAiAgentNode(node, state, context) {
  const { userData, messageData, sessionId } = context;
  const prompt = replaceDynamicVars(String(node.data?.prompt || ''), context);
  const variableName = String(node.data?.assignVar || 'ai_response');
  
  try {
    const reply = await agentMgr.generateReply(prompt, { 
      sessionId,
      history: [{ fromMe: false, body: messageData.messageText || '' }]
    });
    
    if (reply) {
      userData[variableName] = reply;
      logger.info({ sessionId, flowId: context.flowId, nodeId: node.id, reply }, 'AI Agent node executed');
      
      // Send if configured
      if (node.data?.sendResponse !== false) {
        await sendItem(state, { phone: userData.phone, message: reply });
      }
    }
  } catch (e) {
    logger.warn({ sessionId, flowId: context.flowId, nodeId: node.id, error: String(e) }, 'AI Agent node error');
  }
}

async function executeNode(node, context, state) {
  const { userData, sessionId } = context;
  
  try {
    if (node.type === 'log') {
      const msg = replaceDynamicVars(String(node.data?.message || ''), context);
      logger.info({ sessionId, flowId: context.flowId, nodeId: node.id, log: msg }, 'Flow Log');
    } else if (node.type === 'send') {
      const msg = replaceDynamicVars(String(node.data?.message || ''), context);
      await sendItem(state, { phone: userData.phone, message: msg });
    } else if (node.type === 'delay') {
      const sec = Math.max(0, Number(node.data?.seconds || 0));
      await sleep(sec * 1000);
    } else if (node.type === 'tag_add') {
      const tag = replaceDynamicVars(String(node.data?.tag || ''), context);
      if (tag && userData.phone) {
        if (!userTags.has(userData.phone)) userTags.set(userData.phone, new Set());
        userTags.get(userData.phone).add(tag);
        // Note: We should probably save tags to file here or periodically
      }
    } else if (node.type === 'tag_remove') {
      const tag = replaceDynamicVars(String(node.data?.tag || ''), context);
      if (tag && userData.phone && userTags.has(userData.phone)) {
        userTags.get(userData.phone).delete(tag);
      }
    } else if (node.type === 'webhook') {
      const url = replaceDynamicVars(String(node.data?.url || ''), context);
      const method = String(node.data?.method || 'POST');
      const bodyStr = node.data?.body ? replaceDynamicVars(String(node.data?.body), context) : null;
      
      if (url) {
        try {
          const opts = { method, headers: { 'Content-Type': 'application/json' } };
          if (bodyStr && method !== 'GET') opts.body = bodyStr;
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 30000);
          opts.signal = ctrl.signal;
          await fetch(url, opts);
          clearTimeout(t);
        } catch (e) {
          logger.warn({ url, err: String(e) }, 'Webhook fetch failed');
        }
      }
    } else if (node.type === 'ai_agent') {
      await executeAiAgentNode(node, state, context);
    } else if (node.type === 'sheet_append') {
       // ... sheet implementation from index.js ...
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
        }
      } catch (e) {
        logger.warn({ sessionId, err: String(e) }, 'sheet_append failed');
      }
    } else if (node.type === 'sheet_lookup') {
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
        }
      } catch (e) {
        logger.warn({ sessionId, err: String(e) }, 'sheet_lookup failed');
      }
    }
  } catch (err) {
    logger.warn({ sessionId, err: String(err) }, 'Node execution error');
  }
}

export async function continueFlowExecution(flow, startNode, context, sessionId) {
  const state = await ensureSession(sessionId);
  if (!state || !state.isReady) return;
  
  const byId = new Map();
  for (const n of flow.nodes) byId.set(n.id, n);
  
  const nextOf = (id) => {
    const e = flow.edges.find((x) => x.from === id);
    return e ? byId.get(e.to) : null;
  };
  
  let cur = startNode;
  
  while (cur) {
    try {
      // Logic for different node types that control flow
      if (cur.type === 'condition') {
        const conditionType = cur.data?.conditionType || 'equals';
        const conditionValue = cur.data?.condition || '';
        const fullCondition = `${conditionType}:${conditionValue}`;
        const conditionResult = evaluateCondition(fullCondition, context);
        const nextNodeId = conditionResult ? cur.data?.trueNode : cur.data?.falseNode;
        cur = nextNodeId ? byId.get(nextNodeId) : null;
      } else if (cur.type === 'yes_no') {
         const question = replaceDynamicVars(String(cur.data?.question || ''), context);
        await sendItem(state, { phone: context.userData.phone, message: question });
        const timeoutMinutes = Math.max(1, Number(cur.data?.timeout || 30));
        const flowState = {
          flowId: flow.id,
          currentNodeId: cur.id,
          context: context,
          waitingForResponse: true,
          choices: cur.data?.choices || [{ text: 'Yes', nodeId: cur.data?.yesNode }, { text: 'No', nodeId: cur.data?.noNode }],
          timeout: timeoutMinutes * 60 * 1000,
          timeoutNodeId: cur.data?.timeoutNode || null,
          timestamp: Date.now()
        };
        waitingFlows.set(context.userData.phone, flowState);
        return; 
      } else if (cur.type === 'wait_response') {
         const timeout = Math.max(5, Number(cur.data?.timeout || 30));
        const flowState = {
          flowId: flow.id,
          currentNodeId: cur.id,
          context: context,
          waitingForResponse: true,
          timeoutNodeId: cur.data?.timeoutNode,
          responseNodeId: cur.data?.responseNode,
          timeout: timeout * 1000, 
          timestamp: Date.now()
        };
        waitingFlows.set(context.userData.phone, flowState);
        return; 
      } else {
        await executeNode(cur, context, state);
        cur = nextOf(cur.id);
      }
    } catch (err) {
      break;
    }
  }
}

export async function executeFlow(flow, phone, sessionId, messageData = {}) {
  const state = await ensureSession(sessionId);
  if (!state || !state.isReady) return;

  const userData = {
    phone,
    messageCount: 0, 
    lastMessage: messageData.messageText || '',
    ...messageData
  };
  
  const systemVars = { sessionId, timestamp: new Date().toISOString() };
  const context = { userData, systemVars, messageData, sessionId, flowId: flow.id };

  const triggerNode = flow.nodes.find(n => n.type === 'trigger');
  if (triggerNode) {
    // Start from the node AFTER trigger
    const byId = new Map();
    for (const n of flow.nodes) byId.set(n.id, n);
    const edge = flow.edges.find(e => e.from === triggerNode.id);
    if (edge) {
        const nextNode = byId.get(edge.to);
        if (nextNode) await continueFlowExecution(flow, nextNode, context, sessionId);
    }
  } else {
      // Execute all if no trigger? Old logic said execute all non-trigger.
      // But continueFlowExecution expects a start node.
      // If no edges, we iterate.
      if (!flow.edges || flow.edges.length === 0) {
           const nonTriggerNodes = flow.nodes.filter(n => n.type !== 'trigger');
            for (const node of nonTriggerNodes) {
              await executeNode(node, context, state);
            }
      }
  }
}

export async function checkFlowTriggers(message, sessionId, state) {
  try {
    // Check waiting flows
    if (waitingFlows.has(message.from)) {
      const flowState = waitingFlows.get(message.from);
      const flow = savedFlows.get(flowState.flowId);
      
      if (flow) {
        waitingFlows.delete(message.from);
        
        let nextNodeId = null;
        const responseText = (message.body || '').toLowerCase().trim();
        
        if (flowState.choices && flowState.choices.length > 0) {
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
          nextNodeId = flowState.responseNodeId;
        }
        
        if (nextNodeId) {
          const byId = new Map();
          for (const n of flow.nodes) byId.set(n.id, n);
          const nextNode = byId.get(nextNodeId);
          if (nextNode) {
            flowState.context.messageData.messageText = message.body || '';
            flowState.context.userData.lastMessage = message.body || '';
            await continueFlowExecution(flow, nextNode, flowState.context, sessionId);
            return true;
          }
        }
      }
    }
    
    const flows = Array.from(savedFlows.values()).filter(f => f.sessionId === sessionId && f.enabled !== false);
    let anyFlowTriggered = false;
    
    for (const flow of flows) {
      const triggerNode = flow.nodes.find(n => n.type === 'trigger');
      if (!triggerNode) continue;
      
      if (evaluateTrigger(triggerNode, message.body, message.from, sessionId)) {
        anyFlowTriggered = true;
        const analytics = flowAnalytics.get(flow.id) || { executions: 0, successes: 0, failures: 0, lastExecuted: null };
        analytics.executions++;
        analytics.lastExecuted = new Date().toISOString();
        flowAnalytics.set(flow.id, analytics);
        
        const messageData = {
          messageText: message.body || '',
          senderPhone: message.from || '',
          senderName: message._data?.notifyName || '',
          chatTitle: message._data?.chat?.name || '',
          hasMedia: message.hasMedia || false,
          isGroup: message.from?.includes('@g.us') || false
        };
        
        await executeFlow(flow, message.from, sessionId, messageData);
      }
    }
    
    return anyFlowTriggered;
  } catch (e) {
    logger.error({ sessionId, error: String(e) }, 'Flow trigger check error');
    return false;
  }
}


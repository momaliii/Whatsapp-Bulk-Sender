import express from 'express';
import { savedFlows, flowAnalytics, userTags } from '../services/state.js';
import { checkFlowTriggers, executeFlow } from '../services/flows.js';
import { saveFlowsToFile, saveUserTagsToFile } from '../services/persistence.js';
import { logger } from '../utils/logger.js';
import { replaceSystemVars, pad2 } from '../utils/format.js';
import { ensureSession } from '../services/whatsapp.js';
import { sendItem } from '../services/messaging.js';
import path from 'path';
import { DATA_DIR } from '../config/index.js';

const router = express.Router();

router.get('/api/flows', (req, res) => {
  const sessionId = req.query.sessionId;
  const flows = Array.from(savedFlows.values())
    .filter(f => !sessionId || f.sessionId === sessionId)
    .map(f => ({ ...f }));
  res.json({ flows });
});

router.post('/api/flows', (req, res) => {
  const { id, name, nodes, edges, sessionId } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'Missing id or name' });
  
  const newFlow = {
    id,
    name,
    sessionId: sessionId || 'default',
    nodes: nodes || [],
    edges: edges || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  savedFlows.set(id, newFlow);
  saveFlowsToFile();
  res.json({ ok: true });
});

router.put('/api/flows/:id', (req, res) => {
  const { id } = req.params;
  if (!savedFlows.has(id)) return res.status(404).json({ error: 'Flow not found' });
  const existing = savedFlows.get(id);
  const updated = {
    ...existing,
    ...req.body,
    nodes: Array.isArray(req.body.nodes) ? req.body.nodes : (existing.nodes || []),
    edges: Array.isArray(req.body.edges) ? req.body.edges : (existing.edges || []),
    updatedAt: new Date().toISOString()
  };
  savedFlows.set(id, updated);
  saveFlowsToFile();
  res.json({ ok: true });
});

router.delete('/api/flows/:id', (req, res) => {
  const { id } = req.params;
  if (savedFlows.delete(id)) {
    saveFlowsToFile();
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Flow not found' });
  }
});

router.patch('/api/flows/:flowId/toggle', (req, res) => {
  const { flowId } = req.params;
  const flow = savedFlows.get(flowId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });
  const { enabled } = req.body || {};
  const newEnabled = enabled !== undefined ? Boolean(enabled) : !(flow.enabled !== false);
  flow.enabled = newEnabled;
  saveFlowsToFile();
  res.json({ ok: true, enabled: newEnabled, message: `Flow ${newEnabled ? 'enabled' : 'disabled'}` });
});

router.get('/api/flows/analytics', (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    const flows = Array.from(savedFlows.values()).filter(f => !sessionId || f.sessionId === sessionId);
    
    const analytics = flows.map(flow => ({
      flowId: flow.id,
      flowName: flow.name,
      sessionId: flow.sessionId,
      nodes: (flow.nodes || []).length,
      edges: (flow.edges || []).length,
      createdAt: flow.createdAt,
      stats: flowAnalytics.get(flow.id) || { executions: 0, successes: 0, failures: 0, lastExecuted: null }
    }));
    
    res.json({ analytics });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.post('/api/flows/run', async (req, res) => {
  try {
    const { sessionId, phone, flow } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!phone) return res.status(400).json({ error: 'phone required' });
    if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) return res.status(400).json({ error: 'flow invalid' });

    const state = await ensureSession(sessionId);
    if (!state || !state.isReady) return res.status(400).json({ error: 'session not ready' });

    // We can reuse executeFlow but it expects a saved flow object. 
    // If this is a test run of an unsaved flow, we can mock it.
    const mockFlow = { ...flow, id: flow.id || 'temp-run' };
    
    // Since executeFlow is designed for saved flows in context of persistent storage, 
    // we might need to just execute it directly.
    // Actually `executeFlow` in `services/flows.js` is quite robust.
    await executeFlow(mockFlow, phone, sessionId, {});
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.get('/api/flows/export', (req, res) => {
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
        nodes: flow.nodes || [],
        edges: flow.edges || [],
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

router.post('/api/flows/import', (req, res) => {
  try {
    const { flows, userTags: importedUserTags, overwrite = false } = req.body;
    
    if (!flows || !Array.isArray(flows)) {
      return res.status(400).json({ error: 'Invalid flows data' });
    }
    
    let importedCount = 0;
    let skippedCount = 0;
    let errors = [];
    
    for (const flowData of flows) {
      try {
        const flowId = flowData.id;
        if (savedFlows.has(flowId) && !overwrite) {
          skippedCount++;
          continue;
        }
        
        const flow = {
          id: flowId,
          name: flowData.name,
          description: flowData.description || '',
          sessionId: flowData.sessionId || 'default',
          tags: flowData.tags || [],
          nodes: flowData.nodes || [],
          edges: flowData.edges || [],
          createdAt: flowData.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        
        savedFlows.set(flowId, flow);
        importedCount++;
      } catch (err) {
        errors.push(`Error importing flow ${flowData.name || 'unnamed'}: ${String(err)}`);
      }
    }
    
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
      if (importedTagsCount > 0) saveUserTagsToFile();
    }
    
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

router.get('/api/flows/test', (_req, res) => {
  res.json({ status: 'ok', message: 'Flows API is working' });
});

router.post('/api/flows/generate', async (req, res) => {
  try {
    const { idea, sessionId, save, model, temperature, name } = req.body || {};
    if (!idea) return res.status(400).json({ error: 'idea required' });
    const agentMgr = (await import('../services/managers.js')).agentMgr;
    const apiKey = agentMgr.getApiKey();
    if (!apiKey) return res.status(400).json({ error: 'OpenAI API key not configured in Agent settings' });
    const flowName = name || `Flow: ${idea.slice(0, 30)}...`;
    const prompt = `Generate a WhatsApp automation flow as JSON. The user wants: "${idea}". Return ONLY valid JSON with this structure: { "nodes": [ { "id": "n1", "type": "trigger", "data": { "condition": "keyword1,keyword2" } }, { "id": "n2", "type": "message", "data": { "message": "Response text" } }, ... ], "edges": [ { "source": "n1", "target": "n2" }, ... ] }. Use types: trigger, message, choice, delay, end. No other text.`;
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: Math.min(1, Math.max(0, Number(temperature) || 0.3))
      })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return res.status(400).json({ error: err.error?.message || 'AI generation failed' });
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    let flow = { nodes: [], edges: [] };
    try {
      const parsed = JSON.parse(content.replace(/```json\n?|\n?```/g, '').trim());
      flow = { nodes: parsed.nodes || [], edges: parsed.edges || [] };
    } catch {}
    if (save && flow.nodes.length) {
      const id = `flow_${Date.now()}`;
      const newFlow = { id, name: flowName, sessionId: sessionId || 'default', nodes: flow.nodes, edges: flow.edges, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      savedFlows.set(id, newFlow);
      saveFlowsToFile();
      return res.json({ flow: newFlow, modelUsed: model || 'gpt-4o-mini' });
    }
    res.json({ flow: { ...flow, name: flowName }, modelUsed: model || 'gpt-4o-mini' });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

router.post('/api/flows/keywords', async (req, res) => {
  try {
    const { seed, model } = req.body || {};
    const agentMgr = (await import('../services/managers.js')).agentMgr;
    const apiKey = agentMgr.getApiKey();
    if (!apiKey) return res.status(400).json({ error: 'OpenAI API key not configured' });
    const prompt = `Based on this seed text or keywords: "${seed || ''}", suggest 5-10 related keywords or phrases for a WhatsApp message trigger (comma-separated, no quotes). Return ONLY the keywords, nothing else.`;
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.5 })
    });
    if (!resp.ok) return res.status(400).json({ error: 'Keyword suggestion failed' });
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const suggestions = text.split(/[,\n]/).map(s => s.trim().toLowerCase()).filter(Boolean);
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

router.post('/api/flows/explain', async (req, res) => {
  try {
    const { flow, model } = req.body || {};
    const agentMgr = (await import('../services/managers.js')).agentMgr;
    const apiKey = agentMgr.getApiKey();
    if (!apiKey) return res.status(400).json({ error: 'OpenAI API key not configured' });
    const flowStr = JSON.stringify(flow?.nodes || flow || [], null, 2);
    const prompt = `Explain this WhatsApp automation flow in 2-3 paragraphs. Describe what it does step by step:\n${flowStr}`;
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
    });
    if (!resp.ok) return res.status(400).json({ error: 'Explain failed' });
    const data = await resp.json();
    const explanation = data.choices?.[0]?.message?.content || 'No explanation available.';
    res.json({ explanation, modelUsed: model || 'gpt-4o-mini' });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

router.post('/api/flows/debug', (req, res) => {
  // Simple expression evaluator debug endpoint
  try {
    const { expression, context } = req.body;
    const result = replaceSystemVars(expression); // Basic var replacement
    // For full evaluation logic we might need to expose `evaluateCondition` or similar from flows.js
    // But usually debug is just variable replacement check
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Single Flow Export
router.get('/api/flows/export/:flowId', (req, res) => {
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
        nodes: flow.nodes || [],
        edges: flow.edges || [],
        createdAt: flow.createdAt || new Date().toISOString(),
        updatedAt: flow.updatedAt || new Date().toISOString()
      }],
      userTags: {} 
    };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="flow-${flow.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-export.json"`);
    res.json(exportData);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;


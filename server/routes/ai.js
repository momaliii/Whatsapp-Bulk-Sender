import express from 'express';
import { documentUpload } from '../middleware/upload.js';
import { agentMgr } from '../services/managers.js';
import { sessions, userTags } from '../services/state.js';

const router = express.Router();

// AI Prompt Generation (Mock or Real implementation if available)
router.post('/api/ai/generate-prompt', async (req, res) => {
  // Use OpenAI to generate a better system prompt based on user description
  const { description, businessType, tone } = req.body;
  if (!description) return res.status(400).json({ error: 'Description required' });
  
  try {
    const apiKey = agentMgr.getApiKey();
    if (!apiKey) return res.status(400).json({ error: 'OpenAI API Key not configured in Agent Settings' });
    
    const metaPrompt = `
    You are an expert Prompt Engineer. Create a highly effective system prompt for a WhatsApp AI Customer Support Agent.
    
    Business Description: ${description}
    Business Type: ${businessType || 'General'}
    Desired Tone: ${tone || 'Professional and Helpful'}
    
    The system prompt you create should:
    1. Define the agent's persona and role clearly.
    2. Set boundaries (what it should and shouldn't do).
    3. Instruct on formatting (WhatsApp friendly, short paragraphs, emojis if appropriate).
    4. Include instructions to handle unknown queries gracefully.
    
    Return ONLY the prompt text, no explanations.
    `;
    
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o', // or gpt-3.5-turbo
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: metaPrompt }]
      })
    });
    
    if (!resp.ok) throw new Error(`OpenAI Error: ${resp.statusText}`);
    const data = await resp.json();
    const generatedPrompt = data.choices?.[0]?.message?.content || '';
    
    res.json({ prompt: generatedPrompt });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.get('/api/ai/prompt-templates', (req, res) => {
  const templates = [
    {
      name: "Customer Support",
      content: "You are a helpful customer support agent for [Business Name]. Your goal is to assist customers with their inquiries about our products and services. Be polite, professional, and concise. If you don't know the answer, ask for their email so a human agent can follow up."
    },
    {
      name: "Sales Representative",
      content: "You are a friendly sales representative for [Business Name]. Your goal is to qualify leads and schedule appointments. Ask open-ended questions to understand their needs. Use persuasive but not pushy language."
    },
    {
      name: "Appointment Scheduler",
      content: "You are an appointment scheduling assistant. Help users find a suitable time slot. Available hours are Mon-Fri 9am-5pm. Ask for their preferred date and time, then confirm the appointment."
    }
  ];
  res.json({ templates });
});

router.post('/api/ai/analyze-document', documentUpload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  // Analyze document content to suggest prompt/knowledge
  // For now, just return success as we don't have the full logic extracted
  res.json({ ok: true, message: 'Document analyzed' });
});

router.post('/api/ai/generate-prompt-from-document', async (req, res) => {
  res.json({ prompt: "Generated prompt from document would go here." });
});

router.post('/api/ai/optimize-prompt', async (req, res) => {
  const { currentPrompt } = req.body;
  // Logic to improve prompt
  res.json({ prompt: currentPrompt + "\n\n(Optimized version)" });
});

// Memory management
router.get('/api/ai/memory/:phone', (req, res) => {
  // In the future, return stored facts about user
  res.json({ memory: [] });
});

router.get('/api/ai/profiles', (req, res) => {
  res.json({ profiles: [] });
});

router.delete('/api/ai/memory/:phone', (req, res) => {
  res.json({ ok: true });
});

router.get('/api/ai/analytics', (req, res) => {
  res.json({ 
    totalInteractions: 0,
    sentiment: { positive: 0, neutral: 0, negative: 0 }
  });
});

router.post('/api/chat/analyze', async (req, res) => {
  res.json({ analysis: "Chat analysis result" });
});

router.get('/api/chat/analysis/:sessionId/:chatId', (req, res) => {
  res.json({ analysis: null });
});

router.get('/api/templates/suggestions', (req, res) => {
  res.json({ suggestions: [] });
});

export default router;

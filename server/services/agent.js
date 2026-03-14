function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i=0;i<len;i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

function tokenize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
}

function buildSparse(tokens) {
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t)||0)+1);
  const entries = Array.from(freq.entries());
  entries.sort((a,b)=>b[1]-a[1]);
  return entries.slice(0,100).map(([t,c])=>({ t, c }));
}

export class AgentManager {
  constructor(db) {
    this.db = db;
    this.initialize();
  }

  initialize() {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      create table if not exists agent_settings (
        id integer primary key check (id=1),
        enabled integer not null default 0,
        prompt text,
        api_key text,
        temperature real default 0.2,
        top_k integer default 3,
        max_history integer default 25
      );
      create table if not exists agent_docs (
        id integer primary key autoincrement,
        session_id text not null default 'default',
        content text not null,
        sparse text, -- JSON array of {t,c}
        embed blob,  -- optional Float32Array binary
        created_at text not null default (datetime('now'))
      );
      create table if not exists agent_session_prompts (
        session_id text primary key,
        prompt text,
        enabled integer not null default 1,
        updated_at text not null default (datetime('now'))
      );
      create table if not exists chat_analysis (
        chat_id text not null,
        session_id text not null,
        summary text,
        intent text,
        confidence real,
        created_at text not null default (datetime('now')),
        primary key (chat_id, session_id)
      );
    `);
    // Migrations for existing DBs
    try { this.db.exec(`alter table agent_settings add column api_key text`); } catch {}
    try { this.db.exec(`alter table agent_settings add column temperature real`); } catch {}
    try { this.db.exec(`alter table agent_settings add column top_k integer`); } catch {}
    try { this.db.exec(`alter table agent_settings add column max_history integer`); } catch {}
    // Migration: add embed column if missing (for existing DBs)
    try { this.db.exec(`alter table agent_docs add column embed blob`); } catch {}
    // Migration: add session_id column if missing (for existing DBs)
    try { this.db.exec(`alter table agent_docs add column session_id text not null default 'default'`); } catch {}
    // Migration: add enabled column to agent_session_prompts if missing (for existing DBs)
    try { this.db.exec(`alter table agent_session_prompts add column enabled integer not null default 1`); } catch {}
    // Ensure a default settings row exists (compatible with both schemas)
    try { this.db.exec(`insert or ignore into agent_settings (id, enabled, prompt) values (1, 0, 'You are a helpful WhatsApp assistant.')`); } catch {}
    this.stmtGetSettings = this.db.prepare('select * from agent_settings where id=1');
    this.stmtUpdateSettings = this.db.prepare('update agent_settings set enabled=@enabled, prompt=@prompt, api_key=@api_key where id=1');
    this.stmtInsertDoc = this.db.prepare('insert into agent_docs (session_id, content, sparse, embed) values (@session_id, @content, @sparse, @embed)');
    this.stmtUpdateDocEmbed = this.db.prepare('update agent_docs set embed=@embed where id=@id');
    this.stmtListDocs = this.db.prepare('select * from agent_docs where session_id=@session_id order by id desc');
    this.stmtListAllDocs = this.db.prepare('select * from agent_docs order by id desc');
    this.stmtDeleteDoc = this.db.prepare('delete from agent_docs where id=@id');
    this.stmtAllDocs = this.db.prepare('select id, content, sparse, embed from agent_docs where session_id=@session_id');
    this.stmtGetSessPrompt = this.db.prepare('select * from agent_session_prompts where session_id=@session_id');
    this.stmtUpsertSessPrompt = this.db.prepare('insert into agent_session_prompts (session_id, prompt, enabled) values (@session_id, @prompt, @enabled) on conflict(session_id) do update set prompt=excluded.prompt, enabled=excluded.enabled, updated_at=datetime(\'now\')');
    this.stmtListSessPrompts = this.db.prepare('select * from agent_session_prompts order by updated_at desc');
    this.stmtDeleteSessPrompt = this.db.prepare('delete from agent_session_prompts where session_id=@session_id');
    // Chat analysis
    this.stmtChatAnalysis = this.db.prepare(`insert or replace into chat_analysis (chat_id, session_id, summary, intent, confidence, created_at) values (@chat_id, @session_id, @summary, @intent, @confidence, datetime('now'))`);
    this.stmtGetChatAnalysis = this.db.prepare(`select * from chat_analysis where chat_id=@chat_id and session_id=@session_id order by created_at desc limit 1`);
  }

  getSettings() { const r = this.stmtGetSettings.get(); return { enabled: r?.enabled?1:0, prompt: r?.prompt||'', hasKey: Boolean(r?.api_key), temperature: r?.temperature ?? 0.2, top_k: r?.top_k ?? 3, max_history: r?.max_history ?? 25 }; }
  updateSettings({ enabled, prompt, apiKey, temperature, topK, maxHistory }) { const cur = this.stmtGetSettings.get()||{}; this.stmtUpdateSettings.run({ enabled: enabled?1:0, prompt: prompt||'', api_key: apiKey !== undefined ? apiKey : cur.api_key }); if (temperature!==undefined) this.db.exec(`update agent_settings set temperature=${Number(temperature)}`); if (topK!==undefined) this.db.exec(`update agent_settings set top_k=${parseInt(topK||3,10)}`); if (maxHistory!==undefined) this.db.exec(`update agent_settings set max_history=${parseInt(maxHistory||25,10)}`); return this.getSettings(); }
  listDocs(sessionId = 'default') { return this.stmtListDocs.all({ session_id: sessionId }); }
  listAllDocs() { return this.stmtListAllDocs.all(); }
  addDoc(content, embed = null, sessionId = 'default') {
    const sparse = JSON.stringify(buildSparse(tokenize(content)));
    const info = this.stmtInsertDoc.run({ session_id: sessionId, content, sparse, embed });
    return { id: info.lastInsertRowid };
  }
  updateDocEmbed(id, embed) { this.stmtUpdateDocEmbed.run({ id, embed }); }
  deleteDoc(id) { this.stmtDeleteDoc.run({ id }); return { ok:true }; }
  getSessionPrompt(sessionId) { if (!sessionId) return null; return this.stmtGetSessPrompt.get({ session_id: sessionId }) || null; }
  upsertSessionPrompt(sessionId, prompt, enabled = true) { this.stmtUpsertSessPrompt.run({ session_id: sessionId, prompt, enabled: enabled ? 1 : 0 }); return { ok: true }; }
  listSessionPrompts() { return this.stmtListSessPrompts.all(); }
  deleteSessionPrompt(sessionId) { this.stmtDeleteSessPrompt.run({ session_id: sessionId }); return { ok: true }; }

  getApiKey() { const r = this.stmtGetSettings.get(); return r?.api_key || process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || null; }

  async retrieve(query, topK=3, sessionId='default') {
    const qTokens = tokenize(query);
    const qAllTerms = Array.from(new Set(qTokens));
    const docs = this.stmtAllDocs.all({ session_id: sessionId });
    let scores = [];
    // if embeddings exist and we can embed query, use cosine similarity
    const settingsRow = this.stmtGetSettings.get();
    const apiKey = settingsRow?.api_key || process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
    let qEmbed = null;
    if (apiKey) {
      try {
        // small, cheaper embedding model
        const res = await fetch('https://api.openai.com/v1/embeddings', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`}, body: JSON.stringify({ model:'text-embedding-3-small', input: query })});
        if (res.ok) { const data = await res.json(); qEmbed = data.data?.[0]?.embedding || null; }
      } catch {}
    }
    scores = docs.map(d => {
      let sim = 0; let tf = 0;
      try { if (qEmbed && d.embed) { const arr = new Float32Array(d.embed.buffer, d.embed.byteOffset, d.embed.byteLength/4); sim = Math.max(0, cosineSim(qEmbed, arr)); } } catch {}
      try { const sparse = JSON.parse(d.sparse||'[]'); const terms = new Map(sparse.map(x=>[x.t, x.c])); for (const t of qAllTerms) tf += (terms.get(t)||0); } catch {}
      const tfNorm = qAllTerms.length ? Math.min(1, tf/(qAllTerms.length*5)) : 0; // heuristic
      const score = qEmbed ? (0.8*sim + 0.2*tfNorm) : tfNorm;
      return { id: d.id, content: d.content, score };
    });
    scores.sort((a,b)=>b.score-a.score);
    let top = scores.slice(0, topK).filter(s=>s.score>0);
    if (top.length === 0 && docs.length > 0) {
      // fallback: return first doc to provide some context even if score is 0
      top = [{ id: docs[0].id, content: docs[0].content, score: 0 }];
    }
    return top;
  }

  async generateReply(query, sessionInfo) {
    const settingsRow = this.stmtGetSettings.get();
    if (!settingsRow?.enabled) return null;
    const sessionId = sessionInfo?.sessionId || 'default';
    
    // Check if AI agent is enabled for this specific session
    const sessionPromptRow = this.getSessionPrompt(sessionId);
    if (sessionPromptRow && sessionPromptRow.enabled === 0) return null;
    
    const top = await this.retrieve(query, settingsRow?.top_k || 3, sessionId);
    const context = top.map((s,i)=>`[Doc ${i+1} id=${s.id}] ${s.content}`).join('\n\n');
    const sessPromptRow = this.getSessionPrompt(sessionInfo?.sessionId);
    const systemPrompt = (sessPromptRow?.prompt) || settingsRow.prompt || 'You are a helpful WhatsApp assistant.';
    // Build recent conversation transcript (oldest -> newest)
    let historyText = '';
    try {
      const lim = settingsRow?.max_history || 25;
      const hist = Array.isArray(sessionInfo?.history) ? sessionInfo.history.slice(-lim) : [];
      if (hist.length) {
        historyText = hist.map(h => `${h.fromMe ? 'Assistant' : 'User'}: ${h.body}` ).join('\n');
      }
    } catch {}
    const prompt = `${systemPrompt}\n\nContext:\n${context || '(no relevant context)'}\n\nRecent conversation (last 25 messages):\n${historyText || '(none)'}\n\nUser: ${query}\nAssistant:`;
    const apiKey = settingsRow?.api_key || process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
    if (apiKey) {
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [ { role:'system', content: systemPrompt }, { role:'user', content: `Context:\n${context}\n\nRecent conversation (last ${settingsRow?.max_history||25}):\n${historyText}\n\nQuestion: ${query}` } ], temperature: Math.max(0, Math.min(1, settingsRow?.temperature ?? 0.2)) })
        });
        if (res.ok) {
          const data = await res.json();
          const text = data.choices?.[0]?.message?.content || '';
          if (text) {
            // Return only the AI response without sources for client messages
            return text.trim();
          }
        }
      } catch {}
    }
    // fallback simple extractive
    if (context) {
      const snippet = context.slice(0, 400);
      // Return only the response without sources for client messages
      return `According to our knowledge base: ${snippet}`;
    }
    return null;
  }

  async analyzeChat(chatId, sessionId, messages) {
    try {
      const settings = this.getSettings();
      if (!settings.enabled || !settings.hasKey) return null;

      const conversation = messages.slice(-10).map(m => ({
        role: m.fromMe ? 'assistant' : 'user',
        content: m.body || ''
      })).filter(m => m.content.trim());

      if (conversation.length === 0) return null;

      const prompt = `Analyze this WhatsApp conversation and provide:
1. A brief summary (1-2 sentences)
2. The main intent/category (e.g., "support", "sales", "complaint", "question", "greeting")
3. Confidence score (0-1)

Conversation:
${conversation.map(m => `${m.role}: ${m.content}`).join('\n')}

Respond in JSON format: {"summary": "...", "intent": "...", "confidence": 0.8}`;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 200
        })
      });

      if (!response.ok) return null;
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      const analysis = JSON.parse(content);
      this.stmtChatAnalysis.run({
        chat_id: chatId,
        session_id: sessionId,
        summary: analysis.summary || '',
        intent: analysis.intent || 'unknown',
        confidence: analysis.confidence || 0
      });

      return analysis;
    } catch (e) {
      console.error('Chat analysis failed:', e);
      return null;
    }
  }

  getChatAnalysis(chatId, sessionId) {
    return this.stmtGetChatAnalysis.get({ chat_id: chatId, session_id: sessionId });
  }

  getKBQuality(sessionId = 'default') {
    const docs = this.stmtAllDocs.all({ session_id: sessionId });
    const totalDocs = docs.length;
    const docsWithEmbeddings = docs.filter(d => d.embed).length;
    const totalChunks = docs.reduce((sum, d) => sum + (d.content ? d.content.split('\n').length : 0), 0);
    
    // Calculate coverage (docs with embeddings / total docs)
    const coverage = totalDocs > 0 ? (docsWithEmbeddings / totalDocs) * 100 : 0;
    
    // Find potentially dead docs (no embeddings, very short content)
    const deadDocs = docs.filter(d => !d.embed && (!d.content || d.content.length < 50));
    
    // Calculate average chunk size
    const avgChunkSize = totalDocs > 0 ? totalChunks / totalDocs : 0;
    
    return {
      totalDocs,
      docsWithEmbeddings,
      coverage: Math.round(coverage * 100) / 100,
      deadDocs: deadDocs.length,
      avgChunkSize: Math.round(avgChunkSize * 100) / 100,
      totalChunks
    };
  }
}



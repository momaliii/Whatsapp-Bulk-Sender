import fs from 'fs';
import mime from 'mime-types';
import { agentMgr } from './managers.js';

export async function ingestDocumentFile(absPath, sessionId = 'default') {
  const m = mime.lookup(absPath) || '';
  let text = '';
  if (String(m).includes('pdf')) {
    const pdf = (await import('pdf-parse')).default;
    const data = await pdf(fs.readFileSync(absPath));
    text = data.text || '';
  } else if (String(m).includes('officedocument') || absPath.endsWith('.docx')) {
    const mammoth = (await import('mammoth')).default;
    const out = await mammoth.extractRawText({ path: absPath });
    text = out.value || '';
  } else if (String(m).includes('markdown') || absPath.endsWith('.md')) {
    text = fs.readFileSync(absPath, 'utf8');
  } else if (absPath.endsWith('.txt')) {
    text = fs.readFileSync(absPath, 'utf8');
  } else {
    return { added: 0 };
  }
  text = String(text || '').trim();
  if (!text) return { added: 0 };
  
  const lines = text.split(/\r?\n/);
  const groups = [];
  let buf = '';
  for (const ln of lines) {
    if (/^#{1,6}\s+|^\d+\.\s+|^[A-Z][A-Z\s]{5,}$/.test(ln)) {
      if (buf.trim().length) groups.push(buf.trim());
      buf = ln + '\n';
    } else {
      buf += ln + '\n';
    }
  }
  if (buf.trim().length) groups.push(buf.trim());
  const rawChunks = groups.length ? groups : [text];
  const chunks = [];
  for (const g of rawChunks) {
    if (g.length <= 1600) { chunks.push(g); continue; }
    for (let i=0;i<g.length;i+=1600) chunks.push(g.slice(i, i+1600));
  }
  
  const apiKey = agentMgr.getApiKey();
  let embeds = [];
  if (apiKey) {
    try {
      const resEmb = await fetch('https://api.openai.com/v1/embeddings', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`}, body: JSON.stringify({ model:'text-embedding-3-small', input: chunks }) });
      if (resEmb.ok) {
        const data = await resEmb.json();
        embeds = data.data?.map(d => d.embedding) || [];
      }
    } catch {}
  }
  
  let added = 0;
  for (let i=0;i<chunks.length;i++) {
    let embedBuf = null;
    if (embeds[i]) {
      const f32 = new Float32Array(embeds[i]);
      embedBuf = Buffer.from(f32.buffer);
    }
    agentMgr.addDoc(chunks[i], embedBuf, sessionId || 'default');
    added++;
  }
  return { added };
}

export function isKBFileName(name) { return /\.(txt|md|pdf|docx)$/i.test(String(name||'')); }


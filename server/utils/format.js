export function pad2(n) { return String(n).padStart(2, '0'); }
export function formatDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
export function formatTime(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
export function formatDateTime(d) { return `${formatDate(d)} ${formatTime(d)}`; }

export function replaceSystemVars(text, context = {}) {
  if (!text) return text;
  let out = String(text);
  const now = new Date();
  
  // Replace dynamic context variables first (e.g. {name}, {custom_field})
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null) {
      // Case insensitive replacement
      const re = new RegExp(`\\{${key}\\}`, 'gi');
      out = out.replace(re, String(value));
    }
  }

  // Basic date/time variables
  out = out.replace(/\{date\}/g, formatDate(now));
  out = out.replace(/\{time\}/g, formatTime(now));
  out = out.replace(/\{datetime\}/g, formatDateTime(now));
  
  // Enhanced date variables with formats
  out = out.replace(/\{date:([^}]+)\}/g, (_m, format) => {
    try {
      switch (format.toLowerCase()) {
        case 'iso': return now.toISOString().split('T')[0];
        case 'us': return now.toLocaleDateString('en-US');
        case 'eu': return now.toLocaleDateString('en-GB');
        case 'short': return now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        case 'long': return now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        case 'ddmmyyyy': return `${pad2(now.getDate())}/${pad2(now.getMonth()+1)}/${now.getFullYear()}`;
        case 'mmddyyyy': return `${pad2(now.getMonth()+1)}/${pad2(now.getDate())}/${now.getFullYear()}`;
        default: return formatDate(now);
      }
    } catch (e) {
      return formatDate(now);
    }
  });
  
  // Enhanced time variables with formats
  out = out.replace(/\{time:([^}]+)\}/g, (_m, format) => {
    try {
      switch (format.toLowerCase()) {
        case '12': return now.toLocaleTimeString('en-US', { hour12: true });
        case '24': return now.toLocaleTimeString('en-US', { hour12: false });
        case 'short': return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        case 'long': return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        case 'hms': return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
        default: return formatTime(now);
      }
    } catch (e) {
      return formatTime(now);
    }
  });
  
  // Enhanced datetime variables
  out = out.replace(/\{datetime:([^}]+)\}/g, (_m, format) => {
    try {
      switch (format.toLowerCase()) {
        case 'iso': return now.toISOString();
        case 'short': return now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        case 'long': return now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        case 'full': return now.toLocaleString();
        default: return formatDateTime(now);
      }
    } catch (e) {
      return formatDateTime(now);
    }
  });
  
  // Individual date components
  out = out.replace(/\{year\}/g, now.getFullYear().toString());
  out = out.replace(/\{month\}/g, (now.getMonth() + 1).toString());
  out = out.replace(/\{day\}/g, now.getDate().toString());
  out = out.replace(/\{hour\}/g, now.getHours().toString());
  out = out.replace(/\{minute\}/g, now.getMinutes().toString());
  out = out.replace(/\{second\}/g, now.getSeconds().toString());
  
  // Day of week
  out = out.replace(/\{weekday\}/g, now.toLocaleDateString('en-US', { weekday: 'long' }));
  out = out.replace(/\{weekday:short\}/g, now.toLocaleDateString('en-US', { weekday: 'short' }));
  
  // Month name
  out = out.replace(/\{monthname\}/g, now.toLocaleDateString('en-US', { month: 'long' }));
  out = out.replace(/\{monthname:short\}/g, now.toLocaleDateString('en-US', { month: 'short' }));
  
  // Random number variables
  out = out.replace(/\{rand(?::(\d+)-(\d+))?\}/g, (_m, a, b) => {
    let min = 100000, max = 999999;
    if (a && b) { min = Number(a); max = Number(b); }
    if (Number.isNaN(min) || Number.isNaN(max) || max < min) { min = 0; max = 999999; }
    return String(Math.floor(min + Math.random() * (max - min + 1)));
  });
  
  return out;
}

export function parseTimeStringToMinutes(timeStr) {
  if (!timeStr) return null;
  const [h, m] = String(timeStr).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

export function inWindow(now, startMin, endMin) {
  if (startMin == null || endMin == null) return true; // no window
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (startMin <= endMin) return minutes >= startMin && minutes <= endMin;
  // window wraps past midnight
  return minutes >= startMin || minutes <= endMin;
}

export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function waitUntilWindow(now, startMin) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  let waitMinutes = 0;
  if (startMin == null) return;
  if (minutes <= startMin) {
    waitMinutes = startMin - minutes;
  } else {
    waitMinutes = 24 * 60 - minutes + startMin; // next day
  }
  await sleep(waitMinutes * 60 * 1000);
}

export function jitteredDelay(baseMs, jitterPct) {
  const pct = Math.max(0, Math.min(100, Number(jitterPct) || 0));
  if (!pct) return baseMs;
  const delta = baseMs * (pct / 100);
  const min = Math.max(0, baseMs - delta);
  const max = baseMs + delta;
  return Math.floor(min + Math.random() * (max - min));
}


import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Force Cairo timezone
if (!process.env.TZ) {
  process.env.TZ = 'Africa/Cairo';
}

// Base Directories
// process.cwd() is the project root when running `node server/index.js`
export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

// Ensure directories exist
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Database & File Paths
export const TPL_FILE = path.join(DATA_DIR, 'templates.json');
if (!fs.existsSync(TPL_FILE)) fs.writeFileSync(TPL_FILE, '[]');

export const DB_FILE = path.join(DATA_DIR, 'queue.db');
export const AR_DB = path.join(DATA_DIR, 'autoreply.db');
export const AGENT_DB = path.join(DATA_DIR, 'agent.db');

export const PORT = process.env.PORT || 3000;

// Chrome Resolution
function resolveChromeExecutable() {
  try {
    const fromEnv = process.env.CHROME_PATH;
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  } catch {}
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

export const CHROME_EXEC_PATH = resolveChromeExecutable();

export const AUTO_RECONNECT_ON_DISCONNECT = process.env.AUTO_RECONNECT_ON_DISCONNECT === 'true' || process.env.AUTO_RECONNECT_ON_DISCONNECT === '1';


# WhatsApp Tool

A Node.js WhatsApp automation tool with multi-session support, campaigns, flows, auto-reply, and AI agent integration.

## Prerequisites

- **Node.js** 18 or higher
- **Chrome/Chromium** (for WhatsApp Web via Puppeteer)
- **WhatsApp** account

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `TZ` | Timezone | Africa/Cairo |
| `DATA_DIR` | Data directory | ./data |
| `UPLOAD_DIR` | Upload directory | ./uploads |
| `CHROME_PATH` | Chrome/Chromium path | Auto-detected |
| `OPENAI_API_KEY` | OpenAI API key (for AI Agent) | - |
| `AUTO_RECONNECT_ON_DISCONNECT` | Auto-reconnect on disconnect | false |

## Running

```bash
npm start
```

Development mode with auto-reload:

```bash
npm run dev
```

## Architecture

- **Sessions**: Multi-session WhatsApp via whatsapp-web.js + LocalAuth. Each session has its own QR login and persistent auth in `.wwebjs_auth/`.
- **Campaigns**: Bulk messaging with CSV upload, queue, retries, throttling, and send windows.
- **Flows**: Visual flow builder with triggers, conditions, AI nodes, webhooks, and Google Sheets.
- **Workers**: One queue worker per session processes pending jobs.
- **Watchdog**: Periodic health checks and auto-reconnect for zombie sessions.

## Troubleshooting

- **"Execution context was destroyed"**: Transient Puppeteer error. The server retries up to 3 times. Ensure Chrome/Chromium is installed.
- **Session not connecting**: Delete the session and scan QR again. Check `.wwebjs_auth/` for stale auth.
- **Logs**: Server logs to stdout. Use `npm run pm2:logs` when running with PM2.

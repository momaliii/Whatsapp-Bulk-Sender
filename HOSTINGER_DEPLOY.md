# Hostinger Deployment Guide

## Fix for 503 / ERR_REQUIRE_ESM

Hostinger's LiteSpeed uses `require()` to load your app, but the project uses ES Modules. A CommonJS wrapper (`server.cjs`) was added to bridge this.

### Required: Change Entry File in Hostinger

1. Go to your Hostinger project → **Settings** → **Build and output settings**
2. Change **Entry file** from `server/index.js` to **`server.cjs`**
3. Redeploy

### What Was Added

- **server.cjs** – CommonJS wrapper that loads the ESM app via the `esm` package
- **server/index.js** – Exports the Express app when `LSNODE=1` (set by the wrapper)
- **esm** package – Lets `require()` load ES Modules

### If It Still Fails

1. **Check Node version** – Use Node 18.x or 20.x in Hostinger settings.
2. **Check logs** – SSH in and run:
   ```bash
   cat ~/domains/YOUR-DOMAIN.hostingersite.com/nodejs/stderr.log
   ```
3. **WhatsApp sessions** – Hostinger managed hosting may not support Puppeteer/Chromium. If WhatsApp features fail, consider a Hostinger VPS.

# WhatsApp Tool Dockerfile
FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    chromium \
    xvfb \
    libnss3-dev \
    libatk-bridge2.0-dev \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libxss1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV TZ=Africa/Cairo

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (use npm ci if lock file exists, otherwise npm install)
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# Copy application code
COPY . .

# Create data directory
RUN mkdir -p data uploads

# Expose port
EXPOSE 3000

# Start application
CMD ["node", "server/index.js"]

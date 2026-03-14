#!/usr/bin/env bash
set -euo pipefail

# Usage: ./server-bootstrap.sh [/home/mhmd167ali/whatsapp-tool]
APP_DIR="${1:-/home/mhmd167ali/whatsapp-tool}"

echo "Installing Node.js 18 via nvm (no sudo required)..."
if ! command -v node >/dev/null 2>&1; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install 18
  nvm use 18
  nvm alias default 18
  echo "Node.js 18 installed successfully"
else
  echo "Node already installed: $(node -v)"
fi

echo "Installing PM2 locally..."
npm install pm2

# Create app directory
echo "Preparing application directory at $APP_DIR..."
mkdir -p "$APP_DIR"

# Create PM2 ecosystem file for process management
echo "Creating PM2 ecosystem file..."
cat > "$APP_DIR/ecosystem.config.js" <<EOF
module.exports = {
  apps: [{
    name: 'whatsapp-tool',
    script: 'server/index.js',
    cwd: '$APP_DIR',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      TZ: 'Africa/Cairo'
    }
  }]
};
EOF

echo "Bootstrap complete. App directory: $APP_DIR"
echo "To start the app after deployment: cd $APP_DIR && npx pm2 start ecosystem.config.js"

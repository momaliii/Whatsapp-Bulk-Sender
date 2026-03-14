#!/usr/bin/env bash
set -euo pipefail

# Usage: SSH_OPTS="-i ~/.ssh/YOUR_KEY" ./deploy-local-to-gce.sh [REMOTE_USER] [REMOTE_HOST] [REMOTE_DIR]
# Example: SSH_OPTS="-i ~/.ssh/gcp" ./deploy-local-to-gce.sh mhmd167ali 34.132.197.84 /opt/whatsapp-tool

REMOTE_USER="${1:-mhmd167ali}"
REMOTE_HOST="${2:-34.132.197.84}"
REMOTE_DIR="${3:-/opt/whatsapp-tool}"

EXCLUDE_FILE=".deployignore"
SSH_OPTS="${SSH_OPTS:-} -o StrictHostKeyChecking=no"

if [[ ! -f "$EXCLUDE_FILE" ]]; then
  echo "Missing $EXCLUDE_FILE. Create it with exclude patterns first." >&2
  exit 1
fi

echo "Creating remote directory: $REMOTE_DIR"
ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"

echo "Syncing project to server (excluding patterns from $EXCLUDE_FILE)"
# --exclude for .wwebjs* folders added explicitly to avoid traversal/vanished-file errors
set +e
rsync -avz --delete --progress \
  --exclude-from="$EXCLUDE_FILE" \
  --exclude='/.wwebjs*/' --exclude='**/.wwebjs*/' --exclude='*/.wwebjs*/' \
  -e "ssh $SSH_OPTS" \
  ./ "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"
RSYNC_STATUS=$?
set -e
if [[ $RSYNC_STATUS -ne 0 && $RSYNC_STATUS -ne 24 && $RSYNC_STATUS -ne 23 ]]; then
  echo "rsync failed with status $RSYNC_STATUS" >&2
  exit $RSYNC_STATUS
fi

# Install dependencies and restart service
REMOTE_CMDS='set -e
cd '"$REMOTE_DIR"'
if command -v pnpm >/dev/null 2>&1; then
  pkgm=pnpm
elif command -v yarn >/dev/null 2>&1; then
  pkgm=yarn
else
  pkgm=npm
fi

# Install only production deps
if [ "$pkgm" = "npm" ]; then
  npm ci --omit=dev || npm install --omit=dev
elif [ "$pkgm" = "yarn" ]; then
  yarn install --production=true || yarn install
else
  pnpm install --prod || pnpm install
fi

# Try pm2 first; fallback to direct node execution
if command -v pm2 >/dev/null 2>&1; then
  pm2 startOrReload ecosystem.config.js 2>/dev/null || pm2 restart whatsapp-tool 2>/dev/null || pm2 start server/index.js --name whatsapp-tool
  pm2 save || true
elif command -v npx >/dev/null 2>&1 && [ -f ecosystem.config.js ]; then
  npx pm2 start ecosystem.config.js 2>/dev/null || npx pm2 restart whatsapp-tool 2>/dev/null || npx pm2 start server/index.js --name whatsapp-tool
  npx pm2 save || true
elif [ -f /etc/systemd/system/whatsapp-tool.service ]; then
  sudo systemctl daemon-reload
  sudo systemctl restart whatsapp-tool
else
  echo "No PM2 or systemd service found. Starting node in background..."
  nohup node server/index.js >/var/log/whatsapp-tool.log 2>&1 &
fi'

echo "Installing dependencies and restarting service"
ssh -t $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "$REMOTE_CMDS"

echo "Deployment complete to $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR"

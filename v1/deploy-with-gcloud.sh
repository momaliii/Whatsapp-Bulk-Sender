#!/usr/bin/env bash
set -euo pipefail

# Deploy via gcloud (no direct SSH keys required)
# Usage:
#   PROJECT_ID="your-gcp-project" ZONE="us-central1-a" INSTANCE="instance-2v-4r-whatsapp-tool-campaign" \
#   ./deploy-with-gcloud.sh
# Optional: REMOTE_DIR (default /opt/whatsapp-tool)

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${ZONE:?Set ZONE}"
: "${INSTANCE:?Set INSTANCE}"
REMOTE_DIR="${REMOTE_DIR:-/opt/whatsapp-tool}"

TS=$(date +%Y%m%d-%H%M%S)
ARCHIVE="whatsapp-tool-deploy-$TS.tar.gz"

# Build deploy archive with excludes (match .deployignore intent)
echo "Creating deploy archive $ARCHIVE..."
tar -czf "$ARCHIVE" \
  --exclude='./node_modules' \
  --exclude='./node_modules/*' \
  --exclude='*.wwebjs*' \
  --exclude='*/.wwebjs*' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='*/.DS_Store' \
  --exclude='./data' \
  --exclude='./server/data' \
  --exclude='./uploads/*.webm' \
  --exclude='./uploads/*.png' \
  --exclude='./uploads/*.tmp' \
  --exclude='./uploads/*_voice_note.webm' \
  --exclude='./.git' \
  --exclude='./tmp' \
  --exclude='./.tmp' \
  --exclude='./.cache' \
  .

# Copy to VM
echo "Copying archive to VM..."
gcloud compute scp --project "$PROJECT_ID" --zone "$ZONE" "$ARCHIVE" "${INSTANCE}:~/$ARCHIVE"

# Prepare remote directory, extract, install, restart
REMOTE_CMDS=$(cat <<EOF
set -e
sudo mkdir -p "$REMOTE_DIR"
sudo chown -R \$USER:\$USER "$REMOTE_DIR"
cd "$REMOTE_DIR"
# Clean target except persistent data folders if present
shopt -s dotglob || true
for item in * .[^.]*; do
  case "\$item" in
    data|server/data|node_modules) echo "Keeping \$item" ;;
    *) rm -rf "\$item" || true ;;
  esac
done
shopt -u dotglob || true

# Extract
mkdir -p "$REMOTE_DIR"
tar -xzf "~/$ARCHIVE" -C "$REMOTE_DIR"
rm -f "~/$ARCHIVE"

# Install production deps
if command -v pnpm >/dev/null 2>&1; then
  cd "$REMOTE_DIR" && pnpm install --prod || pnpm install
elif command -v yarn >/dev/null 2>&1; then
  cd "$REMOTE_DIR" && yarn install --production=true || yarn install
else
  cd "$REMOTE_DIR" && npm ci --omit=dev || npm install --omit=dev
fi

# Restart service via PM2 or systemd
if command -v pm2 >/dev/null 2>&1; then
  cd "$REMOTE_DIR"
  pm2 startOrReload ecosystem.config.js 2>/dev/null || pm2 restart whatsapp-tool 2>/dev/null || pm2 start server/index.js --name whatsapp-tool
  pm2 save || true
elif [ -f /etc/systemd/system/whatsapp-tool.service ]; then
  sudo systemctl daemon-reload
  sudo systemctl restart whatsapp-tool
else
  echo "No PM2 or systemd service found. Starting node in background..."
  cd "$REMOTE_DIR" && nohup node server/index.js >/var/log/whatsapp-tool.log 2>&1 &
fi

# Show status if systemd is used
if [ -f /etc/systemd/system/whatsapp-tool.service ]; then
  systemctl status whatsapp-tool --no-pager | tail -n +1 || true
fi
EOF
)

echo "Running remote deployment commands..."
gcloud compute ssh --project "$PROJECT_ID" --zone "$ZONE" "$INSTANCE" --command "$REMOTE_CMDS"

# Cleanup local archive
rm -f "$ARCHIVE"

echo "Deployment completed to $INSTANCE:$REMOTE_DIR"

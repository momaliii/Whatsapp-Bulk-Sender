#!/usr/bin/env bash
set -euo pipefail

# Deployment script for Google Cloud VM
# Usage: ./deploy-to-gce.sh [REMOTE_USER] [REMOTE_HOST] [REMOTE_DIR]
# Example: ./deploy-to-gce.sh mhmd167ali 34.132.197.84 /opt/whatsapp-tool

REMOTE_USER="${1:-}"
REMOTE_HOST="${2:-}"
REMOTE_DIR="${3:-/opt/whatsapp-tool}"

if [[ -z "$REMOTE_USER" || -z "$REMOTE_HOST" ]]; then
  echo "Usage: $0 <REMOTE_USER> <REMOTE_HOST> [REMOTE_DIR]"
  echo "Example: $0 mhmd167ali 34.132.197.84 /opt/whatsapp-tool"
  exit 1
fi

EXCLUDE_FILE=".deployignore"
SSH_OPTS="${SSH_OPTS:-} -o StrictHostKeyChecking=no"

if [[ ! -f "$EXCLUDE_FILE" ]]; then
  echo "Warning: Missing $EXCLUDE_FILE. Creating default one..." >&2
  cat > "$EXCLUDE_FILE" <<'EOF'
node_modules/
.git/
.wwebjs_auth/
.wwebjs_cache/
data/
server/data/
*.log
.DS_Store
EOF
fi

echo "🚀 Starting deployment to $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR"

# Step 1: Create remote directory
echo "📁 Creating remote directory..."
ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "mkdir -p '$REMOTE_DIR' 2>/dev/null || true; test -w '$REMOTE_DIR' && echo 'OK: remote dir writable' || (echo 'ERROR: remote dir not writable. Create it on VM with sudo then chown it to your user, e.g.:'; echo \"  sudo mkdir -p '$REMOTE_DIR' && sudo chown $REMOTE_USER:$REMOTE_USER '$REMOTE_DIR'\"; exit 2)"

# Step 2: Sync project files (excluding patterns from .deployignore)
echo "📤 Syncing project files..."
set +e
rsync -avz --delete --progress \
  --exclude-from="$EXCLUDE_FILE" \
  --exclude='/.wwebjs*/' --exclude='**/.wwebjs*/' --exclude='*/.wwebjs*/' \
  --exclude='node_modules/' \
  --exclude='.git/' \
  -e "ssh $SSH_OPTS" \
  ./ "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"
RSYNC_STATUS=$?
set -e

if [[ $RSYNC_STATUS -ne 0 && $RSYNC_STATUS -ne 24 && $RSYNC_STATUS -ne 23 ]]; then
  echo "❌ rsync failed with status $RSYNC_STATUS" >&2
  exit $RSYNC_STATUS
fi

# Step 3: Install Docker if not present, then build and start
echo "🐳 Setting up Docker and starting services..."
REMOTE_CMDS="set -e
cd '$REMOTE_DIR'

# Preconditions: docker + docker compose must already be installed, and this user must be able to run docker without sudo.
if ! command -v docker >/dev/null 2>&1; then
  echo 'ERROR: docker not installed on the VM.'
  echo 'Run on VM: curl -fsSL https://get.docker.com | sudo sh'
  exit 3
fi
if ! docker ps >/dev/null 2>&1; then
  echo 'ERROR: docker is installed but not usable without sudo for this user.'
  echo 'Fix on VM: sudo usermod -aG docker $USER && exit (then reconnect SSH).'
  exit 4
fi
if ! docker compose version >/dev/null 2>&1 && ! docker-compose version >/dev/null 2>&1; then
  echo 'ERROR: docker compose not installed.'
  echo 'Fix on VM: sudo apt-get update && sudo apt-get install -y docker-compose-plugin'
  exit 5
fi

# Create necessary directories
mkdir -p data uploads .wwebjs_auth

# Build and start the service
echo '🔨 Building and starting WhatsApp tool...'
if docker compose version >/dev/null 2>&1; then
  docker compose -f docker-compose.prod.yml up -d --build whatsapp-tool
else
  docker-compose -f docker-compose.prod.yml up -d --build whatsapp-tool
fi

# Wait a moment for startup
sleep 5

# Check health
echo '🏥 Checking service health...'
if curl -f http://localhost:3000/api/admin/health >/dev/null 2>&1; then
  echo '✅ Service is healthy!'
else
  echo '⚠️  Health check failed, but service may still be starting...'
  echo '📋 Check logs with: docker compose -f docker-compose.prod.yml logs -f whatsapp-tool'
fi

echo ''
echo '✅ Deployment complete!'
echo '🌐 Your app should be accessible at: http://$REMOTE_HOST:3000'
echo '📋 View logs: docker compose -f docker-compose.prod.yml logs -f whatsapp-tool'
echo '🔄 Restart: docker compose -f docker-compose.prod.yml restart whatsapp-tool'
"

ssh -t $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "$REMOTE_CMDS"

echo ""
echo "✅ Deployment to $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR completed!"
echo "🌐 Access your app at: http://$REMOTE_HOST:3000"
echo ""
echo "⚠️  IMPORTANT: Make sure firewall rule allows TCP port 3000!"
echo "   In GCP Console: VPC Network > Firewall > Create Firewall Rule"
echo "   - Direction: Ingress"
echo "   - Target tags: (your VM's network tag, or 'all instances')"
echo "   - Source IP ranges: 0.0.0.0/0 (or restrict to your IP)"
echo "   - Protocols and ports: TCP 3000"

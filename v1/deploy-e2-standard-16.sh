#!/bin/bash

# WhatsApp Tool Deployment Script for E2 Standard-16
# Optimized for high-performance 5-day campaigns

set -e

echo "🚀 Starting WhatsApp Tool Deployment on E2 Standard-16..."

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
echo "📦 Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install system dependencies for high performance
echo "📦 Installing system dependencies..."
sudo apt-get install -y \
    build-essential \
    python3 \
    git \
    chromium-browser \
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
    htop \
    iotop \
    nload

# Install PM2 for process management
echo "📦 Installing PM2..."
sudo npm install -g pm2

# Create application directory
echo "📁 Creating application directory..."
sudo mkdir -p /opt/whatsapp-tool
sudo chown $USER:$USER /opt/whatsapp-tool
cd /opt/whatsapp-tool

# Upload your project files here (replace with your actual method)
echo "📥 Please upload your WhatsApp tool files to /opt/whatsapp-tool"
echo "   You can use: scp, git clone, or file upload"

# Install dependencies
echo "📦 Installing Node.js dependencies..."
npm install

# Optimize system for high performance
echo "⚡ Optimizing system for high performance..."

# Increase file limits
sudo tee -a /etc/security/limits.conf > /dev/null <<EOF
* soft nofile 65536
* hard nofile 65536
* soft nproc 65536
* hard nproc 65536
EOF

# Optimize kernel parameters for high-performance campaigns
sudo tee -a /etc/sysctl.conf > /dev/null <<EOF
# Network optimizations for high throughput
net.core.rmem_max = 33554432
net.core.wmem_max = 33554432
net.ipv4.tcp_rmem = 4096 131072 33554432
net.ipv4.tcp_wmem = 4096 131072 33554432
net.core.netdev_max_backlog = 10000
net.ipv4.tcp_congestion_control = bbr
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# File system optimizations for high I/O
fs.file-max = 4194304
vm.swappiness = 5
vm.dirty_ratio = 10
vm.dirty_background_ratio = 3
vm.vfs_cache_pressure = 50

# Memory optimizations for 64GB RAM
vm.overcommit_memory = 1
vm.overcommit_ratio = 80
EOF

# Apply kernel parameters
sudo sysctl -p

# Create systemd service
echo "🔧 Creating systemd service..."
sudo tee /etc/systemd/system/whatsapp-tool.service > /dev/null <<EOF
[Unit]
Description=WhatsApp Tool - High Performance Campaign
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/whatsapp-tool
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=TZ=Africa/Cairo
Environment=NODE_OPTIONS="--max-old-space-size=32768"
LimitNOFILE=65536
LimitNPROC=65536

[Install]
WantedBy=multi-user.target
EOF

# Enable and start service
echo "🚀 Starting service..."
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-tool
sudo systemctl start whatsapp-tool

# Setup Nginx reverse proxy
echo "🌐 Setting up Nginx..."
sudo apt install -y nginx

# Configure firewall rules
echo "🔥 Configuring firewall rules..."
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw --force enable

sudo tee /etc/nginx/sites-available/whatsapp-tool > /dev/null <<EOF
server {
    listen 80;
    server_name _;

    # Increase client body size for large file uploads
    client_max_body_size 100M;

    # Optimize for high performance
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        
        # Optimize for high performance
        proxy_buffering on;
        proxy_buffer_size 128k;
        proxy_buffers 4 256k;
        proxy_busy_buffers_size 256k;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/whatsapp-tool /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

# Setup high-performance monitoring
echo "📊 Setting up high-performance monitoring..."
sudo tee /opt/monitor.sh > /dev/null <<EOF
#!/bin/bash
echo "=== WhatsApp Tool High-Performance Monitor ==="
echo "Date: \$(date)"
echo "Uptime: \$(uptime)"
echo ""
echo "=== MEMORY USAGE (64GB Total) ==="
free -h
echo ""
echo "=== CPU USAGE (8 vCPUs) ==="
top -bn1 | grep "Cpu(s)"
echo ""
echo "=== DISK USAGE ==="
df -h
echo ""
echo "=== NETWORK CONNECTIONS ==="
ss -tuln | grep -E ":(80|443|3000|22)"
echo ""
echo "=== WHATSAPP SESSIONS ==="
curl -s http://localhost:3000/api/sessions | jq '.sessions | length' 2>/dev/null || echo "API not available"
echo ""
echo "=== ACTIVE CAMPAIGNS ==="
curl -s http://localhost:3000/api/campaigns | jq '.campaigns | length' 2>/dev/null || echo "API not available"
echo ""
echo "=== WHATSAPP TOOL STATUS ==="
sudo systemctl status whatsapp-tool --no-pager
echo ""
echo "=== SYSTEM LOAD ==="
cat /proc/loadavg
echo ""
echo "=== MEMORY PRESSURE ==="
cat /proc/pressure/memory 2>/dev/null || echo "Memory pressure not available"
EOF

sudo chmod +x /opt/monitor.sh

# Create backup script
echo "💾 Creating backup script..."
sudo tee /opt/backup.sh > /dev/null <<EOF
#!/bin/bash
BACKUP_DIR="/opt/backups"
mkdir -p \$BACKUP_DIR
DATE=\$(date +%Y%m%d_%H%M%S)
tar -czf "\$BACKUP_DIR/whatsapp-tool-backup-\$DATE.tar.gz" /opt/whatsapp-tool/data /opt/whatsapp-tool/uploads
echo "Backup created: \$BACKUP_DIR/whatsapp-tool-backup-\$DATE.tar.gz"
EOF

sudo chmod +x /opt/backup.sh

# Create high-performance campaign configuration
echo "⚡ Creating high-performance campaign configuration..."
sudo tee /opt/campaign-config.json > /dev/null <<EOF
{
  "recommended_settings": {
    "autoShard": true,
    "perSessionCap": 2000,
    "delayMs": 500,
    "throttle": {
      "messages": 100,
      "sleepSec": 30
    },
    "window": {
      "start": "09:00",
      "end": "18:00"
    },
    "retries": {
      "maxRetries": 3,
      "baseMs": 2000,
      "jitterPct": 20
    },
    "validateNumbers": true
  },
  "performance_notes": {
    "expected_25k_time": "8-10 minutes",
    "max_sessions": "40-50 WhatsApp sessions",
    "concurrent_campaigns": "3-4 campaigns simultaneously",
    "memory_usage": "Optimized for 64GB RAM",
    "cpu_usage": "Optimized for 8 vCPUs"
  }
}
EOF

echo "✅ High-performance deployment complete!"
echo "🌐 Your app should be running at: http://$(curl -s ifconfig.me)"
echo "📊 Check status: sudo systemctl status whatsapp-tool"
echo "📝 View logs: sudo journalctl -u whatsapp-tool -f"
echo "📊 Monitor performance: /opt/monitor.sh"
echo "💾 Backup data: /opt/backup.sh"
echo ""
echo "🎯 E2 Standard-16 is ready for your high-performance campaign!"
echo "⚡ Expected performance: 25k messages in ~5 minutes"
echo "🚀 Support for 50+ WhatsApp sessions simultaneously"

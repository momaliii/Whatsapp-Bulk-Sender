#!/bin/bash

# WhatsApp Tool Deployment Script
# Run this on your cloud server (Ubuntu 20.04/22.04)

set -e

echo "🚀 Starting WhatsApp Tool Deployment..."

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
echo "📦 Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install system dependencies
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
    libasound2

# Install PM2 for process management
echo "📦 Installing PM2..."
sudo npm install -g pm2

# Create application directory
echo "📁 Creating application directory..."
sudo mkdir -p /opt/whatsapp-tool
sudo chown $USER:$USER /opt/whatsapp-tool
cd /opt/whatsapp-tool

# Clone your repository (replace with your actual repo)
echo "📥 Cloning application..."
# git clone https://github.com/yourusername/whatsapp-tool.git .
# Or upload your files manually

# Install dependencies
echo "📦 Installing Node.js dependencies..."
npm install

# Create systemd service
echo "🔧 Creating systemd service..."
sudo tee /etc/systemd/system/whatsapp-tool.service > /dev/null <<EOF
[Unit]
Description=WhatsApp Tool
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/whatsapp-tool
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=TZ=Africa/Cairo

[Install]
WantedBy=multi-user.target
EOF

# Enable and start service
echo "🚀 Starting service..."
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-tool
sudo systemctl start whatsapp-tool

# Setup Nginx reverse proxy (optional)
echo "🌐 Setting up Nginx..."
sudo apt install -y nginx

sudo tee /etc/nginx/sites-available/whatsapp-tool > /dev/null <<EOF
server {
    listen 80;
    server_name your-domain.com;  # Replace with your domain

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
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/whatsapp-tool /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

# Setup SSL with Let's Encrypt (optional)
echo "🔒 Setting up SSL..."
sudo apt install -y certbot python3-certbot-nginx
# sudo certbot --nginx -d your-domain.com

echo "✅ Deployment complete!"
echo "🌐 Your app should be running at: http://your-server-ip"
echo "📊 Check status: sudo systemctl status whatsapp-tool"
echo "📝 View logs: sudo journalctl -u whatsapp-tool -f"

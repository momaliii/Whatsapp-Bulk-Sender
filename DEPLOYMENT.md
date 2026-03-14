# Deployment Guide - Google Cloud VM

This guide will help you deploy the WhatsApp Tool to a Google Cloud Compute Engine VM.

## Prerequisites

- A Google Cloud VM (Ubuntu 22.04 or 24.04 recommended)
- SSH access to the VM
- The VM's public IP address
- Your SSH username and key

## Quick Deployment

### Step 1: Open Firewall Port 3000

**In Google Cloud Console:**

1. Go to **VPC Network** > **Firewall**
2. Click **Create Firewall Rule**
3. Configure:
   - **Name**: `allow-whatsapp-tool-3000`
   - **Direction**: Ingress
   - **Target tags**: (leave empty for all instances, or add your VM's network tag)
   - **Source IP ranges**: `0.0.0.0/0` (or restrict to specific IPs for security)
   - **Protocols and ports**: Select TCP, enter `3000`
4. Click **Create**

**Or via gcloud CLI:**
```bash
gcloud compute firewall-rules create allow-whatsapp-tool-3000 \
  --allow tcp:3000 \
  --source-ranges 0.0.0.0/0 \
  --description "Allow WhatsApp Tool on port 3000"
```

### Step 2: Deploy the Application

Run the deployment script from your local machine:

```bash
chmod +x deploy-to-gce.sh
./deploy-to-gce.sh <YOUR_USERNAME> <VM_IP_ADDRESS> /opt/whatsapp-tool
```

**Example:**
```bash
./deploy-to-gce.sh mhmd167ali 34.132.197.84 /opt/whatsapp-tool
```

The script will:
- Upload your project files (excluding node_modules, .git, etc.)
- Install Docker if not present
- Build and start the WhatsApp tool container
- Verify the service is running

### Step 3: Access Your Application

Open your browser and navigate to:
```
http://<VM_IP_ADDRESS>:3000
```

## Manual Deployment (Alternative)

If you prefer to deploy manually:

### 1. SSH into your VM
```bash
ssh <USERNAME>@<VM_IP>
```

### 2. Install Docker
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker  # or log out and back in
```

### 3. Install Docker Compose Plugin
```bash
sudo apt-get update
sudo apt-get install -y docker-compose-plugin
```

### 4. Upload Project Files

From your local machine:
```bash
rsync -avz --exclude-from=.deployignore \
  --exclude='node_modules/' --exclude='.git/' \
  ./ <USERNAME>@<VM_IP>:/opt/whatsapp-tool/
```

### 5. Start the Service

On the VM:
```bash
cd /opt/whatsapp-tool
mkdir -p data uploads .wwebjs_auth
docker compose -f docker-compose.prod.yml up -d --build whatsapp-tool
```

### 6. Verify

```bash
curl http://localhost:3000/api/admin/health
```

## Managing the Service

### View Logs
```bash
docker compose -f docker-compose.prod.yml logs -f whatsapp-tool
```

### Restart Service
```bash
docker compose -f docker-compose.prod.yml restart whatsapp-tool
```

### Stop Service
```bash
docker compose -f docker-compose.prod.yml stop whatsapp-tool
```

### Update Application

1. Make changes locally
2. Re-run the deployment script:
   ```bash
   ./deploy-to-gce.sh <USERNAME> <VM_IP> /opt/whatsapp-tool
   ```

Or manually:
```bash
# On local machine
rsync -avz --exclude-from=.deployignore ./ <USERNAME>@<VM_IP>:/opt/whatsapp-tool/

# On VM
cd /opt/whatsapp-tool
docker compose -f docker-compose.prod.yml up -d --build whatsapp-tool
```

## Data Persistence

The following directories are persisted as Docker volumes:
- `./data` - SQLite databases, templates, flows
- `./uploads` - Uploaded files
- `./.wwebjs_auth` - WhatsApp session authentication data

**Important:** These directories persist between container restarts. To reset WhatsApp sessions, delete `.wwebjs_auth`:
```bash
rm -rf .wwebjs_auth
docker compose -f docker-compose.prod.yml restart whatsapp-tool
```

## Security Notes

⚠️ **Current Configuration: No Authentication**

The application is currently deployed **without authentication**. Anyone with access to `http://<VM_IP>:3000` can:
- Create/manage WhatsApp sessions
- View all campaigns and data
- Access admin functions

**Recommendations:**
1. Restrict firewall to specific IP addresses
2. Use a VPN or SSH tunnel for access
3. Add authentication middleware (future enhancement)
4. Use a reverse proxy with Basic Auth (nginx/caddy)

## Troubleshooting

### Service won't start
```bash
# Check logs
docker compose -f docker-compose.prod.yml logs whatsapp-tool

# Check if port is in use
sudo lsof -i :3000

# Check Docker status
docker ps -a
```

### Can't access from browser
1. Verify firewall rule is created and active
2. Check VM has external IP assigned
3. Verify service is running: `docker ps`
4. Test locally on VM: `curl http://localhost:3000`

### QR code not generating
1. Check logs for errors
2. Verify Chromium is installed in container
3. Check `.wwebjs_auth` directory permissions
4. Try deleting `.wwebjs_auth` and restarting

### Out of memory
The container is limited to 2GB RAM. For high-volume campaigns, consider:
- Increasing memory limit in `docker-compose.prod.yml`
- Using a VM with more RAM
- Running multiple instances with load balancing

## Support

For issues or questions, check:
- Application logs: `docker compose -f docker-compose.prod.yml logs -f whatsapp-tool`
- System resources: `htop`, `df -h`
- Network connectivity: `curl -v http://localhost:3000/api/admin/health`

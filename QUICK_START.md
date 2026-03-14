# Quick Start - Deploy to GCE VM

## Prerequisites
- Google Cloud VM with Ubuntu (22.04+)
- SSH access to the VM
- VM's public IP address

## 3-Step Deployment

### 1. Open Firewall (One-time setup)

**Option A: Using gcloud CLI (if installed)**
```bash
./setup-firewall.sh
```

**Option B: Manual (Google Cloud Console)**
1. Go to **VPC Network** > **Firewall**
2. Create rule: Allow TCP port 3000 from 0.0.0.0/0

### 2. Deploy Application

```bash
./deploy-to-gce.sh <YOUR_USERNAME> <VM_IP> /opt/whatsapp-tool
```

**Example:**
```bash
./deploy-to-gce.sh mhmd167ali 34.132.197.84 /opt/whatsapp-tool
```

### 3. Access & Verify

Open in browser:
```
http://<VM_IP>:3000
```

Create a WhatsApp session and scan the QR code!

## Common Commands

**View logs:**
```bash
ssh <USER>@<VM_IP> "cd /opt/whatsapp-tool && docker compose -f docker-compose.prod.yml logs -f whatsapp-tool"
```

**Restart service:**
```bash
ssh <USER>@<VM_IP> "cd /opt/whatsapp-tool && docker compose -f docker-compose.prod.yml restart whatsapp-tool"
```

**Update application:**
```bash
./deploy-to-gce.sh <USER> <VM_IP> /opt/whatsapp-tool
```

## Troubleshooting

**Can't access from browser?**
- Check firewall rule is active
- Verify service: `ssh <USER>@<VM_IP> "docker ps"`
- Test locally: `ssh <USER>@<VM_IP> "curl http://localhost:3000/api/admin/health"`

**QR code not showing?**
- Check logs for errors
- Verify Chromium: `ssh <USER>@<VM_IP> "docker exec <container_id> which chromium"`

For detailed information, see [DEPLOYMENT.md](./DEPLOYMENT.md)

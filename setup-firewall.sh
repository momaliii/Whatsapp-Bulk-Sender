#!/usr/bin/env bash
# Quick firewall setup script for GCP
# Run this on your local machine with gcloud CLI installed

echo "🔥 Setting up Google Cloud Firewall for WhatsApp Tool..."

# Create firewall rule for port 3000
gcloud compute firewall-rules create allow-whatsapp-tool-3000 \
  --allow tcp:3000 \
  --source-ranges 0.0.0.0/0 \
  --description "Allow WhatsApp Tool on port 3000" \
  --direction INGRESS \
  2>/dev/null && echo "✅ Firewall rule created successfully!" || echo "⚠️  Firewall rule may already exist or command failed"

# Optional: Also allow SSH (port 22) if not already allowed
echo ""
echo "💡 To allow SSH access (if not already configured):"
echo "   gcloud compute firewall-rules create allow-ssh-22 \\"
echo "     --allow tcp:22 \\"
echo "     --source-ranges 0.0.0.0/0 \\"
echo "     --description 'Allow SSH'"

echo ""
echo "✅ Firewall setup complete!"
echo "🌐 Your VM should now accept connections on port 3000"

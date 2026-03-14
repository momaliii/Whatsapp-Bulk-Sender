module.exports = {
  apps: [{
    name: 'whatsapp-tool-server',
    script: './server/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'development',
      TZ: 'Africa/Cairo'
    },
    env_production: {
      NODE_ENV: 'production',
      TZ: 'Africa/Cairo'
    },
    // Wait 5s before restarting to prevent crash loops
    restart_delay: 5000, 
    exp_backoff_restart_delay: 100
  }]
};


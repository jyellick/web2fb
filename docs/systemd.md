# Running as a Service

Production systemd setup for web2fb.

## Install systemd Service

An example systemd service file is included in the repository at `web2fb.service`.

### Quick Install

```bash
# Copy example service file
sudo cp web2fb.service /etc/systemd/system/web2fb.service

# Edit if needed (adjust paths, user, etc.)
sudo nano /etc/systemd/system/web2fb.service

# Reload systemd
sudo systemctl daemon-reload

# Enable auto-start on boot
sudo systemctl enable web2fb.service

# Start the service
sudo systemctl start web2fb.service

# Check status
sudo systemctl status web2fb.service
```

## Service File Reference

The included `web2fb.service` file contains:

```ini
[Unit]
Description=web2fb - Web to Framebuffer Display
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kiosk
WorkingDirectory=/home/kiosk/web2fb
EnvironmentFile=/home/kiosk/web2fb/.env
ExecStart=/usr/bin/node /home/kiosk/web2fb/web2fb.js

# Restart on failure
Restart=on-failure
RestartSec=10

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=web2fb

# Security: Run with limited privileges
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

### Key Configuration

- **User=kiosk** - Run as kiosk user (must be in video group)
- **WorkingDirectory** - Set to web2fb installation directory
- **EnvironmentFile** - Loads `.env` for PUPPETEER_EXECUTABLE_PATH
- **ExecStart** - Uses absolute path to node
- **Restart=on-failure** - Auto-restart on crashes (stress management triggers clean exits)
- **NoNewPrivileges** - Security hardening

> **Note**: The service uses `Restart=on-failure` instead of `Restart=always` because stress management performs clean browser restarts within the same process. Only actual crashes trigger a service restart.

## View Logs

```bash
# Follow logs in real-time
sudo journalctl -u web2fb.service -f

# View recent logs
sudo journalctl -u web2fb.service -n 100

# View logs with timestamps
sudo journalctl -u web2fb.service --since "10 minutes ago"

# Search for stress management events
sudo journalctl -u web2fb.service | grep "CRITICAL"
```

## Service Commands

```bash
# Start service
sudo systemctl start web2fb.service

# Stop service
sudo systemctl stop web2fb.service

# Restart service
sudo systemctl restart web2fb.service

# Check status
sudo systemctl status web2fb.service

# Disable auto-start
sudo systemctl disable web2fb.service
```

## Multiple Configurations

To run multiple instances with different configs:

```bash
# Create separate service files
sudo cp /etc/systemd/system/web2fb.service /etc/systemd/system/web2fb-dakboard.service
sudo cp /etc/systemd/system/web2fb.service /etc/systemd/system/web2fb-grafana.service

# Edit each to use different configs
sudo nano /etc/systemd/system/web2fb-dakboard.service
# Change: ExecStart=/usr/bin/node web2fb.js --config=/home/kiosk/web2fb/dakboard.json

sudo nano /etc/systemd/system/web2fb-grafana.service
# Change: ExecStart=/usr/bin/node web2fb.js --config=/home/kiosk/web2fb/grafana.json

# Reload, enable, and start
sudo systemctl daemon-reload
sudo systemctl enable web2fb-dakboard.service web2fb-grafana.service
sudo systemctl start web2fb-dakboard.service web2fb-grafana.service
```

## Troubleshooting Service Issues

### Service Won't Start

```bash
# Check service status for errors
sudo systemctl status web2fb.service

# View full logs
sudo journalctl -u web2fb.service -n 50

# Common issues:
# 1. Wrong user/paths in service file
# 2. Config file not found (use absolute path in --config)
# 3. Node not found (use /usr/bin/node absolute path)
# 4. Permissions (user must be in video group)
```

### Check User Permissions

```bash
# Verify user is in video group
groups kiosk

# Should show: kiosk video ...

# If not, add to group
sudo usermod -a -G video kiosk

# User needs to log out/in for changes to take effect
```

### Test Configuration Manually

```bash
# Switch to service user
sudo su - kiosk

# Try running manually
cd /home/kiosk/web2fb
node web2fb.js --config=config.json

# If this works but service doesn't, check service file paths
```

## See Also

- [Installation Guide](installation.md)
- [Troubleshooting](troubleshooting.md)

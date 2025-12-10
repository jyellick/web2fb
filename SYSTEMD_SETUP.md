# Systemd Service Setup for PageScrape

This guide will help you set up PageScrape to run automatically on boot using systemd.

## Prerequisites

1. **Environment file**: Copy `.env.example` to `.env` and configure your settings:
   ```bash
   cp .env.example .env
   nano .env
   ```
   At minimum, set `DISPLAY_URL` to your display URL.

2. **Node.js and dependencies**: Ensure Node.js is installed and dependencies are installed:
   ```bash
   npm install
   ```

3. **Framebuffer access**: Your user needs permission to write to `/dev/fb0`. Add your user to the `video` group:
   ```bash
   sudo usermod -a -G video kiosk
   ```
   (Log out and back in for this to take effect)

## Installation Steps

1. **Copy the service file to systemd directory**:
   ```bash
   sudo cp pagescrape.service /etc/systemd/system/
   ```

2. **Reload systemd to recognize the new service**:
   ```bash
   sudo systemctl daemon-reload
   ```

3. **Enable the service to start on boot**:
   ```bash
   sudo systemctl enable pagescrape.service
   ```

4. **Start the service now** (without rebooting):
   ```bash
   sudo systemctl start pagescrape.service
   ```

## Managing the Service

### Check service status
```bash
sudo systemctl status pagescrape.service
```

### View logs
```bash
# View recent logs
sudo journalctl -u pagescrape.service -n 50

# Follow logs in real-time
sudo journalctl -u pagescrape.service -f

# View logs since last boot
sudo journalctl -u pagescrape.service -b
```

### Stop the service
```bash
sudo systemctl stop pagescrape.service
```

### Restart the service
```bash
sudo systemctl restart pagescrape.service
```

### Disable auto-start on boot
```bash
sudo systemctl disable pagescrape.service
```

## Troubleshooting

### Service fails to start
1. Check the logs: `sudo journalctl -u pagescrape.service -n 100`
2. Verify `.env` file exists and is readable
3. Ensure Node.js path is correct: `which node`
4. Check framebuffer permissions: `ls -l /dev/fb0`

### Framebuffer permission denied
```bash
# Add user to video group
sudo usermod -a -G video $USER

# Or make framebuffer writable (not recommended for production)
sudo chmod 666 /dev/fb0
```

### Change user or paths
Edit the service file:
```bash
sudo nano /etc/systemd/system/pagescrape.service
```
Then reload and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart pagescrape.service
```

## Notes

- The service runs as user `kiosk` (change in service file if needed)
- Application should be installed in `/home/kiosk/pagescrape`
- Logs are sent to systemd journal (use `journalctl` to view)
- Service restarts automatically on failure (10 second delay)
- Network must be online before service starts

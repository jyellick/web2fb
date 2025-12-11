# Troubleshooting

Common issues and solutions.

## Installation Issues

### Chromium Not Found

**Error**: Cannot find Chromium

**Solution**:
```bash
# Install Chromium
sudo apt-get install -y chromium-browser

# Configure path in .env
echo "PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium" > .env
```

### Permission Denied on /dev/fb0

**Error**: EACCES: permission denied, open '/dev/fb0'

**Solution**:
```bash
# Add user to video group
sudo usermod -a -G video kiosk

# Log out and back in, or:
sudo su - kiosk

# Verify permissions
ls -l /dev/fb0
# Should show: crw-rw---- 1 root video
```

### Node.js Version Too Old

**Error**: Requires Node.js 18+

**Solution**:
```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version
```

## Service Issues

### Service Won't Start

**Symptoms**: `systemctl status web2fb` shows failed

**Diagnosis**:
```bash
# Check detailed status
sudo systemctl status web2fb.service

# View logs
sudo journalctl -u web2fb.service -n 50
```

**Common Causes**:
1. **Wrong paths** - Use absolute paths in service file
2. **Config not found** - Verify config file path
3. **Wrong user** - User must exist and be in video group
4. **Node not found** - Use `/usr/bin/node` not just `node`

**Solution**:
```bash
# Edit service file
sudo nano /etc/systemd/system/web2fb.service

# Verify paths are absolute:
# ExecStart=/usr/bin/node /home/kiosk/web2fb/web2fb.js --config=/home/kiosk/web2fb/config.json

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart web2fb.service
```

### Service Starts But Display Blank

**Symptoms**: Service running but nothing on screen

**Check**:
```bash
# Verify framebuffer device
ls -l /dev/fb0

# Check if another process is using it
sudo fuser /dev/fb0

# View service logs
sudo journalctl -u web2fb.service -f
```

## Page Loading Issues

### Page Load Timeout

**Error**: Navigation timeout of 180000 ms exceeded

**Solution**:
```json
{
  "browser": {
    "timeout": 300000,
    "imageLoadTimeout": 240000
  }
}
```

### SSL Certificate Errors

**Error**: net::ERR_CERT_AUTHORITY_INVALID

**Solution**:
```json
{
  "browser": {
    "ignoreHTTPSErrors": true
  }
}
```

Or fix certificates:
```bash
sudo apt-get install ca-certificates
sudo update-ca-certificates
```

### Page Not Loading Correctly

**Issue**: Page renders differently than in desktop browser

**Check**:
1. User agent - Some sites require specific user agents
2. Viewport size - Ensure matches your display
3. JavaScript errors - Check console output

**Solution**:
```json
{
  "browser": {
    "userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
  }
}
```

## Overlay Issues

### Overlay Not Detected

**Symptoms**: Log shows "Overlay 'name' not found"

**Solution**:
1. Open page in desktop browser
2. Inspect element and find CSS selector
3. Test selector: `document.querySelector('.your-selector')`
4. Update config with correct selector
5. Ensure element exists after page load

### Overlay Position Wrong

**Issue**: Overlay appears in wrong location

**Solution**:
```json
{
  "overlays": [{
    "detectStyle": true,
    "style": {
      "textAlign": "center"  // Manual override if needed
    }
  }]
}
```

### Overlay Style Doesn't Match

**Issue**: Font/color doesn't match original

**Solution**:
```json
{
  "overlays": [{
    "detectStyle": true,
    "style": {
      "fontSize": 72,
      "color": "#FFFFFF",
      "fontFamily": "Arial"
    }
  }]
}
```

## Performance Issues

### High Memory Usage

**Symptoms**: System sluggish, out of memory errors

**Solutions**:
1. **Enable stress management** (on by default)
2. **Lower resolution**:
   ```json
   {
     "display": {
       "width": 1280,
       "height": 720
     }
   }
   ```
3. **Disable GUI**:
   ```bash
   sudo raspi-config
   # System Options → Boot → Console
   ```
4. **Disable getty**:
   ```bash
   sudo systemctl disable getty@tty1.service
   ```

### Frequent Browser Restarts

**Symptoms**: Logs show frequent "Restarting browser"

**Check**:
```bash
# View restart causes
sudo journalctl -u web2fb.service | grep "Restarting browser"
```

**Solutions**:
1. **Increase thresholds**:
   ```json
   {
     "stressManagement": {
       "thresholds": {
         "baseImageCritical": 20000
       },
       "recovery": {
         "killBrowserThreshold": 5
       }
     }
   }
   ```
2. **Reduce page complexity**
3. **Lower resolution**
4. **Increase change detection interval**

### Clock Jumping Multiple Times

**Issue**: Clock updates skip seconds (e.g., 12:00:03 → 12:00:07)

**Cause**: System is falling behind, updates are queuing

**Solution**: Drop-frame behavior is enabled by default. If still occurring, system is severely stressed - see stress management tuning above.

## Display Issues

### Screen Shows Login Prompt

**Issue**: tty1 login prompt visible on framebuffer

**Solution**:
```bash
sudo systemctl disable getty@tty1.service
sudo reboot
```

### Screen Flickers

**Issue**: Display flickers during updates

**Cause**: Full page re-renders happening frequently

**Solution**: Use overlays for dynamic content

### Colors Look Wrong

**Issue**: Colors don't match expected

**Check**:
```bash
# Verify framebuffer format
cat /sys/class/graphics/fb0/bits_per_pixel
```

**Solution**: web2fb supports 16bpp (RGB565), 24bpp, and 32bpp automatically

## Debugging

### Enable Verbose Logging

```bash
# Run manually with debugging
node --inspect web2fb.js

# Or with environment variable
DEBUG=* node web2fb.js
```

### Test Without Service

```bash
# Switch to service user
sudo su - kiosk

# Run manually
cd /home/kiosk/web2fb
node web2fb.js --config=config.json

# Press Ctrl+C to stop
```

### View Framebuffer Directly

```bash
# Dump framebuffer to file
cat /dev/fb0 > /tmp/fb.raw

# Convert to viewable format (requires ImageMagick)
convert -depth 8 -size 1920x1080 rgba:/tmp/fb.raw /tmp/fb.png
```

## Getting Help

If you're still stuck:

1. Check logs: `sudo journalctl -u web2fb.service -n 100`
2. Test manually as user: `sudo su - kiosk && node web2fb.js`
3. Verify config: Check JSON syntax, required fields
4. Check system resources: `free -h`, `top`
5. File an issue on GitHub with logs and config

## See Also

- [Installation Guide](installation.md)
- [Configuration Reference](configuration.md)
- [Stress Management](stress-management.md)

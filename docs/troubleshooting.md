# Troubleshooting

Common issues and solutions.

## Screenshot Issues

### Local Mode: "Unable to capture screenshot"

**Error**: `Protocol error (Page.captureScreenshot): Unable to capture screenshot`

**Symptoms**: Browser launches successfully, page loads, but screenshot fails

**Common Causes**:
1. **Stale Chrome processes** - Previous Chrome instances still running
2. **Missing environment variable** - `PUPPETEER_EXECUTABLE_PATH` not set
3. **.env file not loaded** - dotenv not configured

**Solutions**:
```bash
# 1. Restart the Pi to clear stale processes
sudo reboot

# 2. Ensure .env file exists and contains:
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 3. For systemd service, add to service file:
[Service]
Environment="PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium"

# 4. Verify Chrome can be found:
which chromium
```

### Remote Mode: Not Receiving Screenshots

**Symptoms**: Worker responds but returns errors or empty response

**Check**:
```bash
# Test worker directly:
curl "https://your-worker.workers.dev?url=https://example.com&width=1920&height=1080"
```

**Solutions**:
1. **Check API key** - Ensure `remoteApiKey` matches worker's `API_KEY` secret
2. **Check worker logs** - View logs in Cloudflare dashboard
3. **Test wait strategies** - Try adding `waitDelay` or `waitForSelector`
4. **Verify worker deployment** - Check `wrangler.toml` bindings

See [cloudflare-worker/WAIT-STRATEGIES.md](../cloudflare-worker/WAIT-STRATEGIES.md) for detailed troubleshooting.

### Page Shows "Loading..." in Screenshot

**Symptoms**: Screenshot captured too early, before content loads

**Solutions**:
```yaml
browser:
  # Option 1: Wait for specific element(s)
  waitForSelector: ".content-loaded, .today"

  # Option 2: Add fixed delay
  waitDelay: 3000  # 3 seconds

  # Option 3: Wait for network idle (stricter)
  waitForNetworkIdle: true
```

### Screen Not Updating Periodically

**Symptoms**: Initial screenshot displays, but no periodic updates

**Cause**: Without overlays, periodic refresh may not be writing to framebuffer

**Check**:
```bash
# View logs to see if screenshots are being captured:
sudo journalctl -u web2fb.service -f | grep "Screenshot captured"
```

**Solution**: This should be fixed in recent versions. If still occurring:
1. Verify `refreshInterval` is set (default: 300000 ms = 5 minutes)
2. Check logs show "Writing updated base image to framebuffer"
3. Update to latest version

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
1. **Use remote mode** - Offload browser rendering to Cloudflare Worker
2. **Lower resolution**:
   ```yaml
   display:
     width: 1280
     height: 720
   ```
3. **Increase refresh interval**:
   ```yaml
   refreshInterval: 600000  # 10 minutes instead of 5
   ```
4. **Disable GUI**:
   ```bash
   sudo raspi-config
   # System Options → Boot → Console
   ```
5. **Disable getty**:
   ```bash
   sudo systemctl disable getty@tty1.service
   ```

### Clock Jumping Multiple Times

**Issue**: Clock overlay updates skip seconds (e.g., 12:00:03 → 12:00:07)

**Cause**: System is overloaded, updates are queuing

**Solution**: Drop-frame behavior is enabled by default. If still occurring:
1. Use remote mode to reduce CPU/memory load
2. Reduce number of overlays
3. Increase overlay `updateInterval` to 2000ms or higher

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
- [Overlay System](overlays.md)
- [Cloudflare Worker Wait Strategies](../cloudflare-worker/WAIT-STRATEGIES.md)

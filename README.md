# web2fb - Web to Framebuffer Renderer

Optimized renderer for displaying web pages directly to a Linux framebuffer on resource-constrained devices like Raspberry Pi Zero 2 W.

Perfect for kiosk displays, dashboards (DakBoard, HABPanel, Grafana), and any web content you want to display on a low-power device.

## Features

- **Direct framebuffer rendering** - No X11/Wayland overhead
- **Smart overlay system** - Hide dynamic elements (clocks, dates) and render them locally to avoid constant page re-renders
- **Configurable** - JSON-based configuration for any website
- **Memory optimized** - Runs on devices with as little as 512MB RAM
- **Change detection** - Automatically re-renders when page content changes
- **Multiple overlay types** - Clock, date, custom text, or write your own
- **Example configs included** - Ready-to-use configurations for DakBoard and other use cases

## Quick Start

```bash
# Clone repository
git clone <repo-url> /home/kiosk/web2fb
cd /home/kiosk/web2fb

# Install dependencies
npm install

# Create configuration (or use an example)
cp examples/dakboard.json config.json
nano config.json  # Edit with your URL

# Run
node web2fb.js
```

## Architecture

**How it works:**
1. Puppeteer/Chromium renders the webpage at your display resolution
2. Optionally detects and hides dynamic elements (like clocks)
3. Captures base screenshot and writes to framebuffer
4. Renders overlay elements locally (clock updates every second without re-scraping the page)
5. Monitors page for changes and re-renders only when needed

**Performance:**
- Clock overlay updates: ~50ms, writes only ~110KB (vs 4MB+ for full screen)
- Full page render: Only when background content actually changes
- Memory: ~200-300MB total (Chromium process)
- CPU: <5% idle on Pi Zero 2 W

## Installation

### 1. System Setup (Raspberry Pi)

```bash
# Update system
sudo apt-get update && sudo apt-get upgrade

# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Chromium
sudo apt-get install -y chromium-browser

# Install Puppeteer dependencies
sudo apt-get install -y \
  libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 \
  libxi6 libxtst6 libnss3 libcups2 libxss1 libxrandr2 \
  libasound2 libpangocairo-1.0-0 libatk1.0-0 \
  libatk-bridge2.0-0 libgtk-3-0
```

### 2. Optimize Pi for Framebuffer (Recommended)

For best performance and to prevent conflicts:

```bash
# Switch to console-only mode (no GUI)
sudo raspi-config
# Navigate to: System Options → Boot / Auto Login → Console Autologin

# Disable getty to prevent login prompt on framebuffer
sudo systemctl disable getty@tty1.service

# Add user to video group for framebuffer access
sudo usermod -a -G video kiosk

# Reboot for changes to take effect
sudo reboot
```

### 3. Install web2fb

```bash
# Create kiosk user (if needed)
sudo useradd -m -s /bin/bash kiosk
sudo usermod -a -G video kiosk

# Switch to kiosk user
sudo su - kiosk

# Clone repository
git clone <repo-url> /home/kiosk/web2fb
cd /home/kiosk/web2fb

# Install dependencies
npm install

# Create .env file (for environment overrides)
cp .env.example .env
nano .env
```

## Configuration

web2fb uses JSON configuration files. Create `config.json` or use `--config=path/to/config.json`.

### Basic Configuration

```json
{
  "display": {
    "url": "https://example.com",
    "width": 1920,
    "height": 1080,
    "framebufferDevice": "/dev/fb0"
  }
}
```

### DakBoard Configuration

```json
{
  "display": {
    "url": "https://dakboard.com/display/uuid/YOUR-UUID",
    "width": 1920,
    "height": 1080
  },
  "overlays": [
    {
      "name": "clock",
      "type": "clock",
      "selector": ".time.large",
      "enabled": true,
      "updateInterval": 1000,
      "format": {
        "hour": "numeric",
        "minute": "2-digit",
        "second": "2-digit"
      },
      "detectStyle": true
    }
  ]
}
```

See `examples/` directory for more configurations.

### Environment Variables

You can override config values with environment variables:

- `DISPLAY_URL` - Override display.url
- `WIDTH` / `HEIGHT` - Override resolution
- `FRAMEBUFFER_DEVICE` - Override framebuffer device
- `PUPPETEER_EXECUTABLE_PATH` - Path to Chromium (required on ARM64: `/usr/bin/chromium`)

Create `.env` file:
```bash
DISPLAY_URL=https://your-dashboard.com
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium  # Required on ARM64
```

## Configuration Reference

### Display Settings

```json
{
  "display": {
    "url": "https://example.com",         // Required: URL to render
    "width": 1920,                         // Display width (default: 1920)
    "height": 1080,                        // Display height (default: 1080)
    "framebufferDevice": "/dev/fb0"        // Framebuffer device (default: /dev/fb0)
  }
}
```

### Browser Settings

```json
{
  "browser": {
    "userAgent": "...",                    // Custom user agent
    "timeout": 180000,                     // Page load timeout (ms, default: 180000)
    "imageLoadTimeout": 120000,            // Image load timeout (ms, default: 120000)
    "disableAnimations": true              // Disable CSS animations (default: true)
  }
}
```

### Overlay System

Overlays let you hide page elements and render them locally for better performance.

**Clock Overlay:**
```json
{
  "name": "clock",
  "type": "clock",
  "selector": ".time",                     // CSS selector
  "enabled": true,
  "updateInterval": 1000,                  // Update every 1 second
  "format": {
    "hour": "numeric",                     // "numeric" or "2-digit"
    "minute": "2-digit",
    "second": "2-digit",
    "hour12": false                        // 24-hour format
  },
  "detectStyle": true                      // Auto-detect font/color from page
}
```

**Date Overlay:**
```json
{
  "name": "date",
  "type": "date",
  "selector": ".date",
  "updateInterval": 60000,                 // Update every minute
  "format": {
    "weekday": "long",
    "year": "numeric",
    "month": "long",
    "day": "numeric"
  }
}
```

**Custom Text Overlay:**
```json
{
  "name": "status",
  "type": "text",
  "selector": ".status",
  "text": "System Online",
  "updateInterval": 5000
}
```

### Change Detection

Automatically detects when page content changes:

```json
{
  "changeDetection": {
    "enabled": true,                       // Enable change detection
    "watchSelectors": ["img", "[style*='background']"],
    "watchAttributes": ["src", "style", "class"],
    "periodicCheckInterval": 120000,       // Fallback check every 2 minutes
    "debounceDelay": 500                   // Delay before re-render (ms)
  }
}
```

### Performance Options

```json
{
  "performance": {
    "scrollToLoadLazy": true,              // Scroll page to trigger lazy images
    "waitForImages": true,                 // Wait for all images before render
    "bufferPooling": true,                 // Reduce GC pressure
    "splashScreen": "splash.png"           // Show image during startup
  }
}
```

## Running

### Manual

```bash
# Using default config locations (config.json, web2fb.config.json, .web2fb.json)
node web2fb.js

# Using specific config
node web2fb.js --config=examples/dakboard.json

# With environment override
DISPLAY_URL=https://example.com node web2fb.js
```

### Auto-start on Boot

See [SYSTEMD_SETUP.md](SYSTEMD_SETUP.md) for detailed systemd service setup.

Quick setup:
```bash
sudo cp web2fb.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable web2fb.service
sudo systemctl start web2fb.service
```

View logs:
```bash
sudo journalctl -u web2fb.service -f
```

## Use Cases

### DakBoard Dashboard
```bash
cp examples/dakboard.json config.json
# Edit config.json with your DakBoard URL
node web2fb.js
```

### Grafana Dashboard
```json
{
  "display": {
    "url": "https://grafana.example.com/d/dashboard-id?kiosk",
    "width": 1920,
    "height": 1080
  },
  "changeDetection": {
    "enabled": true,
    "periodicCheckInterval": 30000  // Refresh every 30 seconds
  }
}
```

### Simple Webpage
```bash
cp examples/simple.json config.json
node web2fb.js
```

### Home Assistant / HABPanel
```json
{
  "display": {
    "url": "https://homeassistant.local:8123/dashboard",
    "width": 1920,
    "height": 1080
  }
}
```

## Development

### Local Testing (without Pi hardware)

Use test scripts to simulate framebuffer:

```bash
# Create simulated framebuffer
./test-framebuffer.sh

# View framebuffer as PNG (in another terminal)
./view-framebuffer.sh
```

### Creating Custom Overlays

Edit `lib/overlays.js` to add custom overlay types:

```javascript
function generateCustomOverlay(overlay, region) {
  // Your custom rendering logic
  const content = "Your dynamic content";
  return generateTextSVG(content, overlay, region);
}
```

## Troubleshooting

### Page Load Timeout

```bash
# Increase timeout in config
{
  "browser": {
    "timeout": 300000  // 5 minutes
  }
}
```

### Framebuffer Permission Denied

```bash
# Ensure user is in video group
sudo usermod -a -G video kiosk
# Log out and back in

# Check framebuffer permissions
ls -l /dev/fb0
```

### ARM64 Chromium Issues

Make sure `.env` contains:
```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

### Overlay Not Detected

Check the CSS selector in browser dev tools:
1. Open the page in a desktop browser
2. Inspect the element you want to overlay
3. Find a unique CSS selector
4. Update config with correct selector

### High Memory Usage

- Ensure console-only mode (no GUI)
- Disable getty on tty1
- Reduce display resolution
- Disable overlays if not needed

## Performance Tips

1. **Overlays** - Use overlays for frequently updating elements (saves ~99% of I/O)
2. **Change detection** - Tune `periodicCheckInterval` based on how often your content changes
3. **Console mode** - Disable GUI to free up ~200MB RAM
4. **Resolution** - Lower resolution = less memory and faster rendering
5. **Disable animations** - Set `disableAnimations: true` for instant rendering

## Examples

The `examples/` directory contains ready-to-use configurations:

- `dakboard.json` - DakBoard dashboard with clock overlay
- `simple.json` - Basic webpage rendering
- `multi-overlay.json` - Multiple overlays (clock, date, text)

## Configuration Schema

See `config.schema.json` for the complete configuration schema. Most IDEs will provide autocomplete if you add:

```json
{
  "$schema": "./config.schema.json",
  ...
}
```

## Contributing

Contributions welcome! Please:
1. Test on actual Pi hardware when possible
2. Keep memory usage low
3. Document configuration options
4. Add example configs for new use cases

## License

MIT

## Credits

Built for displaying DakBoard dashboards on Raspberry Pi Zero 2 W, but designed to be useful for any web-to-framebuffer rendering needs.

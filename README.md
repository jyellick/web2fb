# web2fb - Web to Framebuffer Renderer

Optimized renderer for displaying web pages directly to a Linux framebuffer on resource-constrained devices like Raspberry Pi Zero 2 W.

Perfect for kiosk displays, dashboards (DakBoard, HABPanel, Grafana), and any web content you want to display on a low-power device.

## Features

- **Direct framebuffer rendering** - No X11/Wayland overhead
- **Smart overlay system** - Hide dynamic elements (clocks, dates) and render them locally to avoid constant page re-renders
- **Stress management** - Intelligent throttling prevents memory thrashing on constrained hardware
- **Configurable** - JSON-based configuration for any website
- **Memory optimized** - Runs on devices with as little as 512MB RAM
- **Change detection** - Automatically re-renders when page content changes
- **Multiple overlay types** - Clock, date, custom text, or write your own
- **Example configs included** - Ready-to-use configurations for DakBoard and other use cases

## Architecture

**How it works:**
1. Puppeteer/Chromium renders the webpage at your display resolution
2. Optionally detects and hides dynamic elements (like clocks)
3. Captures base screenshot and writes to framebuffer
4. Renders overlay elements locally (clock updates every second without re-scraping the page)
5. Monitors page for changes and re-renders only when needed
6. Detects system stress and throttles background operations to prevent crashes

**Performance:**
- Clock overlay updates: ~50ms, writes only ~110KB (vs 4MB+ for full screen)
- Full page render: Only when background content actually changes
- Memory: ~200-300MB total (Chromium process)
- CPU: <5% idle on Pi Zero 2 W
- Stress recovery: Automatically throttles or restarts browser under heavy load

## Installation

### 1. System Prerequisites (Raspberry Pi)

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

### 2. Create Kiosk User (Recommended)

For security and isolation, run web2fb as a dedicated user:

```bash
# Create kiosk user
sudo useradd -m -s /bin/bash kiosk

# Add to video group for framebuffer access
sudo usermod -a -G video kiosk

# Switch to kiosk user for remaining steps
sudo su - kiosk
```

> **Note:** All paths in this guide assume the kiosk user home directory (`/home/kiosk/`). Adjust if using a different user.

### 3. Optimize Pi for Framebuffer (Recommended)

For best performance and to prevent conflicts:

```bash
# Switch to console-only mode (no GUI login manager)
sudo raspi-config
# Navigate to: System Options → Boot → Console login

# Disable getty to prevent login prompt on framebuffer
sudo systemctl disable getty@tty1.service

# Reboot for changes to take effect
sudo reboot
```

After reboot, log back in as the kiosk user:
```bash
sudo su - kiosk
```

### 4. Install web2fb

```bash
# Clone repository
git clone https://github.com/jyellick/web2fb.git /home/kiosk/web2fb
cd /home/kiosk/web2fb

# Install dependencies
npm install
```

## Quick Start

```bash
# 1. Create configuration from example
cp examples/dakboard.json config.json

# 2. Edit with your settings
nano config.json  # Update the URL to your dashboard

# 3. Run
node web2fb.js

# Or specify a different config file
node web2fb.js --config=examples/simple.json
```

## Configuration

web2fb uses JSON configuration files. By default, it looks for:
1. `config.json` (in the current directory)
2. `web2fb.config.json`
3. `.web2fb.json`

Or specify explicitly: `node web2fb.js --config=/path/to/config.json`

### Minimal Configuration

```json
{
  "display": {
    "url": "https://example.com",
    "width": 1920,
    "height": 1080
  }
}
```

### DakBoard Configuration (Recommended)

```json
{
  "$schema": "./config.schema.json",
  "name": "DakBoard Display",

  "display": {
    "url": "https://dakboard.com/display/uuid/YOUR-UUID",
    "width": 1920,
    "height": 1080,
    "framebufferDevice": "/dev/fb0"
  },

  "browser": {
    "timeout": 180000,
    "disableAnimations": true
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
      "detectStyle": true,
      "comment": "Hides DakBoard clock and renders locally"
    }
  ],

  "changeDetection": {
    "enabled": true,
    "debounceDelay": 500,
    "periodicCheckInterval": 120000
  },

  "stressManagement": {
    "enabled": true,
    "comment": "Prevents memory thrashing on Pi Zero 2 W"
  }
}
```

See the `examples/` directory for more complete configurations.

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
    "disableAnimations": true,             // Disable CSS animations (default: true)
    "executablePath": "/usr/bin/chromium"  // Path to Chromium (auto-detected on ARM64)
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
  "selector": ".time",                     // CSS selector to find element
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

### Stress Management (New!)

Prevents memory thrashing on resource-constrained hardware by intelligently throttling operations:

```json
{
  "stressManagement": {
    "enabled": true,                       // Enable stress monitoring (default: true)
    "thresholds": {
      "overlayUpdateWarning": 3000,        // Warn if overlay update >3s
      "overlayUpdateCritical": 10000,      // Critical if overlay update >10s
      "baseImageWarning": 5000,            // Warn if page render >5s
      "baseImageCritical": 15000           // Critical if page render >15s
    },
    "recovery": {
      "skipUpdatesOnStress": true,         // Skip redundant updates when stressed
      "maxConsecutiveSlowOps": 3,          // Consecutive slow ops before throttling
      "killBrowserThreshold": 3,           // Critical events before browser restart
      "cooldownPeriod": 30000,             // Wait time after restart (ms)
      "recoveryCheckInterval": 5000        // Check stress level every 5s
    }
  }
}
```

**How it works:**
- **Normal**: All operations run as usual
- **Mild Stress**: Throttles background re-renders (clock keeps updating)
- **Moderate Stress**: Pauses background entirely (clock still works, background frozen)
- **Severe Stress**: Kills and restarts browser (better than system crash)

This prioritizes user-visible updates (overlays) over invisible operations (page re-renders).

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

### Environment Variables

Override config values with environment variables:

- `DISPLAY_URL` - Override display.url
- `WIDTH` / `HEIGHT` - Override resolution
- `FRAMEBUFFER_DEVICE` - Override framebuffer device
- `PUPPETEER_EXECUTABLE_PATH` - Path to Chromium (auto-detected on ARM64: `/usr/bin/chromium`)

Create `.env` file:
```bash
DISPLAY_URL=https://your-dashboard.com
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

## Running as a Service (Recommended for Production)

### 1. Create systemd Service File

Create `/etc/systemd/system/web2fb.service`:

```ini
[Unit]
Description=web2fb - Web to Framebuffer Renderer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kiosk
WorkingDirectory=/home/kiosk/web2fb
ExecStart=/usr/bin/node web2fb.js --config=/home/kiosk/web2fb/config.json
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# Increase restart limit (stress management may trigger restarts)
StartLimitBurst=10
StartLimitIntervalSec=300

[Install]
WantedBy=multi-user.target
```

**Important Configuration Notes:**
- `User=kiosk` - Run as kiosk user (must match user created in step 2)
- `WorkingDirectory` - Set to web2fb installation directory
- `ExecStart` - **Use absolute paths** for both `node` and the config file
- `--config` - Specify your config file path explicitly
- `Restart=always` - Auto-restart on crashes or stress-triggered exits
- `StartLimitBurst=10` - Allow frequent restarts (stress management feature)

### 2. Install and Enable Service

```bash
# Copy service file
sudo cp web2fb.service /etc/systemd/system/

# Or create it directly:
sudo nano /etc/systemd/system/web2fb.service
# (paste the content above)

# Reload systemd
sudo systemctl daemon-reload

# Enable auto-start on boot
sudo systemctl enable web2fb.service

# Start the service
sudo systemctl start web2fb.service

# Check status
sudo systemctl status web2fb.service
```

### 3. View Logs

```bash
# Follow logs in real-time
sudo journalctl -u web2fb.service -f

# View recent logs
sudo journalctl -u web2fb.service -n 100

# View logs with timestamps
sudo journalctl -u web2fb.service --since "10 minutes ago"
```

### 4. Multiple Configurations

To run multiple instances with different configs:

```bash
# Create separate service files
sudo cp web2fb.service /etc/systemd/system/web2fb-dakboard.service
sudo cp web2fb.service /etc/systemd/system/web2fb-grafana.service

# Edit each to use different configs
sudo nano /etc/systemd/system/web2fb-dakboard.service
# Change: ExecStart=/usr/bin/node web2fb.js --config=/home/kiosk/web2fb/dakboard.json

sudo nano /etc/systemd/system/web2fb-grafana.service
# Change: ExecStart=/usr/bin/node web2fb.js --config=/home/kiosk/web2fb/grafana.json

# Enable and start
sudo systemctl enable web2fb-dakboard.service web2fb-grafana.service
sudo systemctl start web2fb-dakboard.service web2fb-grafana.service
```

See [SYSTEMD_SETUP.md](SYSTEMD_SETUP.md) for advanced systemd configuration.

## Manual Running (for Testing)

```bash
# Using default config locations
node web2fb.js

# Using specific config
node web2fb.js --config=examples/dakboard.json

# With environment override
DISPLAY_URL=https://example.com node web2fb.js

# With debugging
node --inspect web2fb.js
```

## Use Cases & Examples

### DakBoard Dashboard
```bash
cp examples/dakboard.json config.json
nano config.json  # Update YOUR-UUID
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
    "periodicCheckInterval": 30000
  }
}
```

### Home Assistant / HABPanel
```json
{
  "display": {
    "url": "https://homeassistant.local:8123/dashboard",
    "width": 1920,
    "height": 1080
  },
  "stressManagement": {
    "enabled": true
  }
}
```

### Simple Static Webpage
```bash
cp examples/simple.json config.json
node web2fb.js
```

## Troubleshooting

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

### Page Load Timeout

Increase timeout in config:
```json
{
  "browser": {
    "timeout": 300000
  }
}
```

### Framebuffer Permission Denied

```bash
# Ensure user is in video group
sudo usermod -a -G video kiosk

# Log out and back in, or:
sudo su - kiosk

# Check framebuffer permissions
ls -l /dev/fb0
# Should show: crw-rw---- 1 root video
```

### ARM64 Chromium Issues

Create `.env` file:
```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

Or set in config:
```json
{
  "browser": {
    "executablePath": "/usr/bin/chromium"
  }
}
```

### Overlay Not Detected

1. Open the page in a desktop browser
2. Right-click → Inspect the element you want to overlay
3. Find a unique CSS selector (e.g., `.time.large`)
4. Update config with correct selector
5. Verify with: `document.querySelector('.your-selector')`

### High Memory Usage / System Crashes

Enable stress management (enabled by default):
```json
{
  "stressManagement": {
    "enabled": true,
    "thresholds": {
      "baseImageCritical": 15000
    }
  }
}
```

Also consider:
- Ensure console-only mode (no GUI)
- Disable getty on tty1
- Reduce display resolution
- Lower `periodicCheckInterval` if page doesn't change often

### Stress Management Triggering Restarts

This is normal! The system detected severe stress and restarted the browser to prevent a crash. Check logs:

```bash
sudo journalctl -u web2fb.service | grep "CRITICAL"
```

If restarts are too frequent, tune thresholds:
```json
{
  "stressManagement": {
    "thresholds": {
      "baseImageCritical": 20000,
      "overlayUpdateCritical": 15000
    },
    "recovery": {
      "killBrowserThreshold": 5
    }
  }
}
```

## Performance Tips

1. **Use Overlays** - Saves ~99% of I/O for frequently updating elements
2. **Enable Stress Management** - Prevents crashes on constrained hardware (enabled by default)
3. **Tune Change Detection** - Adjust `periodicCheckInterval` based on content update frequency
4. **Console Mode** - Disable GUI to free up ~200MB RAM
5. **Lower Resolution** - Less memory and faster rendering
6. **Disable Animations** - Set `disableAnimations: true`
7. **Splash Screen** - Improves perceived startup time

## Development

### Local Testing (without Pi hardware)

Use the development server to test without actual Raspberry Pi hardware:

```bash
# Start development server (creates virtual framebuffer and web viewer)
npm run dev

# Or with custom port
node dev-server.js --port=8080

# Or with custom dimensions
WIDTH=1280 HEIGHT=720 npm run dev
```

The dev server will:
- Create a virtual framebuffer at `./test-fb/fb0`
- Start a web server at http://localhost:3000
- Provide a live view of the framebuffer with auto-refresh

Then in another terminal, run web2fb against the virtual framebuffer:

```bash
# Run web2fb with virtual framebuffer
FRAMEBUFFER_DEVICE=test-fb/fb0 DISPLAY_URL=https://example.com node web2fb.js

# Or with a config file
FRAMEBUFFER_DEVICE=test-fb/fb0 node web2fb.js --config=examples/dakboard.json
```

Open http://localhost:3000 in your browser to see the live framebuffer output!

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- stress-monitor

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

### Linting and Formatting

```bash
# Check code style
npm run lint

# Fix issues automatically
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check
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

## Configuration Schema

See `config.schema.json` for the complete configuration schema. Most IDEs will provide autocomplete if you add:

```json
{
  "$schema": "./config.schema.json",
  ...
}
```

## Examples

The `examples/` directory contains ready-to-use configurations:

- `dakboard.json` - DakBoard dashboard with clock overlay and stress management
- `simple.json` - Basic webpage rendering
- `multi-overlay.json` - Multiple overlays (clock, date, text)

## Contributing

Contributions welcome! Please:
1. Test on actual Pi hardware when possible
2. Keep memory usage low
3. Document configuration options
4. Add tests for new features
5. Follow existing code style (run `npm run lint`)

## License

MIT

## Credits

Built for displaying DakBoard dashboards on Raspberry Pi Zero 2 W, but designed to be useful for any web-to-framebuffer rendering needs.

Special thanks to the Puppeteer and Sharp teams for their excellent libraries.

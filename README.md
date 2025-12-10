# PageScrape - Direct Framebuffer Display

Optimized renderer for displaying web dashboards (like DakBoard) directly to a framebuffer on resource-constrained devices like Raspberry Pi Zero 2 W.

## Architecture

**Direct framebuffer rendering on Raspberry Pi:**
- Runs Puppeteer/Chromium locally to render the dashboard
- Writes directly to Linux framebuffer device (`/dev/fb0`)
- Detects and hides the clock element from the page
- Renders clock overlay locally (updates only clock region, not full screen)
- Monitors page for background image changes
- Optimized for low memory and CPU usage

**Key optimizations:**
- Clock updates write only ~110KB (609x90 region) instead of 4MB (1920x1080 full screen)
- Base page screenshot only when background images change
- Buffer pooling to reduce GC pressure
- Single-process Chromium with memory-optimized flags

## Hardware Requirements

- Raspberry Pi Zero 2 W (or any Pi with framebuffer support)
- Raspbian Bookworm (or similar Linux with framebuffer)
- Network connection for initial page load and updates

## Installation

### 1. Install Dependencies

```bash
# Update system
sudo apt-get update
sudo apt-get upgrade

# Install Node.js (if not already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Chromium for ARM64
sudo apt-get install -y chromium-browser

# Install required libraries for Puppeteer
sudo apt-get install -y \
  libx11-xcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxi6 \
  libxtst6 \
  libnss3 \
  libcups2 \
  libxss1 \
  libxrandr2 \
  libasound2 \
  libpangocairo-1.0-0 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libgtk-3-0

# Clone repository
git clone <your-repo-url> /home/kiosk/pagescrape
cd /home/kiosk/pagescrape

# Install Node dependencies
npm install
```

### 2. Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit configuration
nano .env
```

Required environment variables:
- `DISPLAY_URL`: Your dashboard URL (e.g., DakBoard display URL) - **required**
- `WIDTH`: Screen width in pixels (default: 1920)
- `HEIGHT`: Screen height in pixels (default: 1080)
- `FRAMEBUFFER_DEVICE`: Framebuffer device path (default: `/dev/fb0`)
- `PUPPETEER_EXECUTABLE_PATH`: Path to Chromium (required on ARM64: `/usr/bin/chromium`)

**Important for ARM64:** Puppeteer doesn't provide Chrome binaries for ARM64, so you must set:
```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

### 3. Raspberry Pi Configuration

For optimal performance and to prevent framebuffer conflicts:

**a) Switch to console-only mode** (saves resources, prevents GUI from competing for framebuffer):
```bash
sudo raspi-config
# Navigate to: System Options → Boot / Auto Login → Console Autologin
```

**b) Disable getty on tty1** (prevents login prompt from interfering with framebuffer):
```bash
sudo systemctl disable getty@tty1.service
```

**c) Add user to video group** (for framebuffer access):
```bash
sudo usermod -a -G video kiosk
```

Log out and back in for group changes to take effect.

### 4. Set Up Auto-Start on Boot

See [SYSTEMD_SETUP.md](SYSTEMD_SETUP.md) for detailed systemd service setup instructions.

Quick setup:
```bash
# Copy service file
sudo cp pagescrape.service /etc/systemd/system/

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable pagescrape.service
sudo systemctl start pagescrape.service

# Check status
sudo systemctl status pagescrape.service
```

## Configuration

All configuration is done via environment variables in `.env`:

```bash
# Required: Your dashboard display URL
DISPLAY_URL=https://dakboard.com/display/uuid/YOUR-UUID-HERE

# Required for ARM64: Path to Chromium executable
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Optional: Screen resolution (defaults to 1920x1080)
WIDTH=1920
HEIGHT=1080

# Optional: Framebuffer device (default: /dev/fb0)
FRAMEBUFFER_DEVICE=/dev/fb0
```

## Usage

### Run Manually

```bash
cd /home/kiosk/pagescrape
node screenshot.js
```

### Run as Service

```bash
# Start
sudo systemctl start pagescrape.service

# Stop
sudo systemctl stop pagescrape.service

# Restart
sudo systemctl restart pagescrape.service

# View logs
sudo journalctl -u pagescrape.service -f
```

## Development & Testing

### Local Testing (without Pi hardware)

Use the included test scripts to simulate framebuffer on your development machine:

```bash
# Create simulated framebuffer and run
./test-framebuffer.sh

# In another terminal, view the framebuffer as PNG
./view-framebuffer.sh
```

## Monitoring

### View Logs

```bash
# Follow logs in real-time
sudo journalctl -u pagescrape.service -f

# View recent logs
sudo journalctl -u pagescrape.service -n 100

# View logs since last boot
sudo journalctl -u pagescrape.service -b
```

### What to Look For

**Healthy operation:**
- `Clock overlay update: XXXms` logged every 10 seconds (should be <100ms)
- `Partial write breakdown: sharp=XXms, fb=XXms` shows clock region updates
- No timeout errors

**Background updates:**
- `Background image changed` when page images rotate
- `Re-capturing base image...` triggers full page re-render

## Troubleshooting

### Page Load Timeout

If you see `TimeoutError: Navigation timeout exceeded`:
- Increase timeout in screenshot.js (currently 180s for page load, 120s for images)
- Check network connectivity
- Verify DISPLAY_URL is accessible

### Framebuffer Permission Denied

```bash
# Ensure user is in video group
sudo usermod -a -G video kiosk

# Check framebuffer permissions
ls -l /dev/fb0

# Temporarily make writable (for testing only)
sudo chmod 666 /dev/fb0
```

### Clock Not Detected

The application looks for `.time.large` CSS selector. If your page uses different selectors:
1. Inspect the page HTML to find the correct selector
2. Modify screenshot.js line ~425 to use correct selector

### High CPU/Memory Usage

- Ensure console-only mode is enabled (no GUI running)
- Verify getty is disabled on tty1
- Check browser flags in screenshot.js (already optimized for Pi Zero 2 W)
- Consider reducing screen resolution in .env

### Chromium Crashes on ARM64

Make sure you have set:
```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

And installed Chromium:
```bash
sudo apt-get install chromium-browser
```

## Performance

**Raspberry Pi Zero 2 W (typical):**
- Initial page load: 60-120 seconds (depending on network)
- Clock overlay update: 30-60ms (only 609x90 region updated)
- Full page re-render: 2-5 seconds (only when background images change)
- Memory usage: ~200-300MB (Chromium process)
- CPU usage: <5% idle, ~50% during updates

**Optimizations applied:**
- Direct framebuffer writing (no X11/Wayland overhead)
- Partial framebuffer updates for clock (110KB vs 4MB)
- Single-process Chromium mode
- Buffer pooling for RGB565 conversion
- Local clock rendering (no page re-scraping)

## Architecture Details

### Clock Overlay System

1. Page loads and renders completely
2. Clock element (`.time.large`) is detected and its position/styling captured
3. Clock element is hidden from the page via CSS
4. Base image (without clock) is captured as JPEG
5. Every second:
   - Generate clock SVG with current time (using locale formatting)
   - Extract clock region from base image
   - Composite clock SVG onto region
   - Write only clock region to framebuffer (~110KB)
6. When background images change:
   - Re-capture base image
   - Write full framebuffer
   - Continue clock overlay updates

### Background Change Detection

- MutationObserver watches entire document for image changes
- Monitors: `src`, `style`, `class`, `srcset`, DOM node changes
- Periodic fallback check every 2 minutes
- Triggers full page re-render only when needed

## License

MIT

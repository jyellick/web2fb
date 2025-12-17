# web2fb

**Display web pages on low-power devices like Raspberry Pi Zero 2 W**

## The Problem

Modern Chrome requires **1GB+ RAM just to start** and uses hundreds of megabytes to render complex dashboards. This makes displaying web content on devices like the Raspberry Pi Zero 2 W (512MB RAM) impractical with traditional approaches.

## The Solution

web2fb takes a different approach:

1. **Render screenshots** - A headless browser (local or remote) captures the page as an image
2. **Write to framebuffer** - The image is written directly to `/dev/fb0` (no X11/Wayland overhead)
3. **Overlay dynamic elements** - Optional: render clocks/dates locally so they update without re-rendering the entire page
4. **Periodic refresh** - Capture new screenshots at configurable intervals (default: 5 minutes)

This approach uses **~200-300MB RAM total** and runs smoothly on the Pi Zero 2 W.

## Screenshot Modes

**Local Mode** (default)
- Uses Puppeteer + system Chromium on the Pi
- Browser launches fresh for each screenshot, then closes (prevents memory leaks)
- Best for: Pi 3/4/5, or Pi Zero 2 W with simple pages

**Remote Mode** (Cloudflare Worker)
- Offloads screenshot rendering to Cloudflare Worker
- Pi only downloads the image and writes to screen
- Best for: Pi Zero 2 W with complex pages, or when you want minimal Pi resource usage

## Quick Start

### Prerequisites

```bash
# Raspberry Pi OS (tested on Bullseye/Bookworm)
sudo apt-get update
sudo apt-get install -y nodejs chromium-browser

# Add user to video group for framebuffer access
sudo usermod -a -G video $USER
# Log out and back in for group to take effect
```

### Installation

```bash
# Clone repository
git clone https://github.com/jyellick/web2fb.git
cd web2fb

# Install dependencies
npm install

# Set Chromium path (required for local mode on ARM)
echo "PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium" > .env

# Create configuration
cp examples/simple.yaml config.yaml
nano config.yaml  # Edit URL to your dashboard
```

### Run

```bash
# Test run
node web2fb.js

# Or with specific config
node web2fb.js --config=config.yaml
```

Your webpage should now display on the screen! Press Ctrl+C to stop.

### Run as Service

```bash
# Copy and edit service file
sudo cp web2fb.service /etc/systemd/system/
sudo nano /etc/systemd/system/web2fb.service  # Adjust paths

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable web2fb.service
sudo systemctl start web2fb.service

# View logs
sudo journalctl -u web2fb.service -f
```

## Minimal Configuration

Create `config.yaml`:

```yaml
display:
  url: https://your-dashboard.com
  width: 1920
  height: 1080

# Optional: Use remote screenshots
# browser:
#   mode: remote
#   remoteScreenshotUrl: https://your-worker.workers.dev
#   remoteApiKey: your-secret-key

# Optional: Add a clock overlay
# overlays:
#   - name: clock
#     type: clock
#     selector: ".time"  # CSS selector to hide on page
#     updateInterval: 1000
#     region: { x: 1620, y: 30, width: 280, height: 80 }
#     style:
#       fontSize: 64
#       fontFamily: "Roboto"
#       color: "rgb(255, 255, 255)"
```

## Documentation

- **[Installation Guide](docs/installation.md)** - Detailed setup, system requirements, Pi optimization
- **[Configuration Reference](docs/configuration.md)** - All config options, local vs remote modes, wait strategies
- **[Cloudflare Worker Setup](cloudflare-worker/)** - Deploy remote screenshot service
- **[Overlay System](docs/overlays.md)** - Add dynamic clocks, dates, custom elements
- **[Troubleshooting](docs/troubleshooting.md)** - Common issues and solutions
- **[systemd Service](docs/systemd.md)** - Run as background service

## Use Cases

- **DakBoard** - Personal dashboards (weather, calendar, photos)
- **Grafana** - Monitoring dashboards
- **Home Assistant** - Smart home displays
- **Magic Mirror** - Information displays
- **Any static/semi-static web content** - News, transit schedules, crypto tickers, etc.

Perfect for dashboards that update hourly/daily rather than real-time data that changes every second.

## Performance

**Raspberry Pi Zero 2 W:**
- Memory: ~200-300MB total (with local mode)
- Memory: ~100-150MB total (with remote mode)
- CPU: <5% idle, ~50% during screenshot capture
- Screenshot capture: 30-60 seconds (local), 3-5 seconds (remote)

**Raspberry Pi 4/5:**
- Memory: ~250-350MB total
- CPU: <3% idle, ~25% during screenshot capture
- Screenshot capture: 10-20 seconds

## Requirements

- **Hardware**: Raspberry Pi with framebuffer display (tested on Zero 2 W, 3, 4, 5)
- **OS**: Raspberry Pi OS (Bullseye or newer)
- **Node.js**: 18.x or newer
- **Chromium**: System package (for local mode)
- **RAM**: 512MB minimum (local mode), 256MB minimum (remote mode)

## Examples

See [examples/](examples/) directory:
- `simple.yaml` - Minimal configuration
- `dakboard.yaml` - Local mode with clock overlay
- `dakboard-remote.yaml` - Remote mode with overlays
- `remote-simple.yaml` - Remote mode, no overlays
- `multi-overlay.yaml` - Multiple overlays

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT

## Credits

Built for displaying DakBoard dashboards on Raspberry Pi Zero 2 W.

Special thanks to:
- [Puppeteer](https://pptr.dev/) - Headless Chrome automation
- [Sharp](https://sharp.pixelplumbing.com/) - Fast image processing
- [Cloudflare Workers](https://workers.cloudflare.com/) - Serverless screenshot rendering

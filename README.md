# web2fb

Render web pages directly to a Linux framebuffer on resource-constrained devices like Raspberry Pi Zero 2 W.

Perfect for kiosk displays, dashboards (DakBoard, HABPanel, Grafana), and any web content on low-power devices.

## ✨ Key Features

- **Direct framebuffer rendering** - No X11/Wayland overhead
- **Smart overlay system** - Render dynamic elements locally (clocks update without page re-renders)
- **Stress management** - Intelligent throttling prevents crashes on constrained hardware
- **Memory optimized** - Runs on devices with 512MB RAM
- **Auto change detection** - Re-renders only when page content changes
- **JSON configuration** - Easy setup for any website

## 🚀 Quick Start (Raspberry Pi)

```bash
# 1. Install dependencies
sudo apt-get update
sudo apt-get install -y nodejs chromium-browser

# 2. Clone and install
git clone https://github.com/jyellick/web2fb.git
cd web2fb
npm install

# 3. Configure Chromium path
echo "PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium" > .env

# 4. Create config
cp examples/dakboard.json config.json
nano config.json  # Update URL to your dashboard

# 5. Run
node web2fb.js
```

## 📖 Documentation

- **[Installation Guide](docs/installation.md)** - System setup, prerequisites, Pi optimization
- **[Configuration Reference](docs/configuration.md)** - Complete config options and examples
- **[Running as Service](docs/systemd.md)** - Production systemd setup
- **[Overlay System](docs/overlays.md)** - Local rendering for clocks, dates, custom elements
- **[Stress Management](docs/stress-management.md)** - Memory protection for constrained hardware
- **[Performance Profiling](docs/performance-profiling.md)** - Identify bottlenecks and optimize performance
- **[Troubleshooting](docs/troubleshooting.md)** - Common issues and solutions
- **[Development](docs/development.md)** - Testing, contributing, custom overlays

## 💡 Minimal Configuration

```json
{
  "display": {
    "url": "https://your-dashboard.com",
    "width": 1920,
    "height": 1080
  }
}
```

See [examples/](examples/) for complete configurations.

## 🎯 Use Cases

- **DakBoard** - Personal dashboards with weather, calendar, photos
- **Grafana** - Monitoring dashboards
- **Home Assistant** - Smart home control panels
- **Custom Dashboards** - Any web-based display

## 🔧 Key Concepts

**Overlay System**: Hide dynamic elements (like clocks) on the webpage and render them locally. Clock updates every second (~50ms, 110KB) instead of re-rendering the entire page (4MB+).

**Stress Management**: Monitors system load and intelligently throttles operations. Prioritizes user-visible updates (overlays) over background operations (page re-renders). Automatically restarts browser before system crashes.

**Change Detection**: Watches for page content changes (images, backgrounds) and re-renders only when needed. Saves CPU and memory.

## 📊 Performance

- **Memory**: ~200-300MB total
- **CPU**: <5% idle on Pi Zero 2 W
- **Clock updates**: ~50ms (writes only overlay region)
- **Full page render**: Only when content changes

## 🛠️ Running as Service

```bash
# Copy included service file
sudo cp web2fb.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable and start
sudo systemctl enable web2fb.service
sudo systemctl start web2fb.service

# View logs
sudo journalctl -u web2fb.service -f
```

See [systemd documentation](docs/systemd.md) for complete setup and configuration options.

## 🧪 Development

```bash
# Start dev server (virtual framebuffer + web viewer)
npm run dev

# In another terminal, run web2fb
FRAMEBUFFER_DEVICE=test-fb/fb0 node web2fb.js --config=examples/dakboard.json

# Open http://localhost:3000 to view output
```

See [development documentation](docs/development.md) for details.

## 📝 License

MIT

## 🙏 Credits

Built for displaying DakBoard dashboards on Raspberry Pi Zero 2 W.

Special thanks to the Puppeteer and Sharp teams.

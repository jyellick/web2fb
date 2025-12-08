# DakBoard Remote Renderer

Server-side rendering solution for displaying DakBoard dashboards on resource-constrained devices like Raspberry Pi Zero 2 W.

## Architecture

**Server (Docker container):**
- Runs Puppeteer/Chromium to render DakBoard page
- Uses MutationObserver to detect clock updates (every second)
- Serves latest screenshot via HTTP at `/latest.png`
- Port 3000

**Client (Raspberry Pi):**
- Uses `feh` with `--reload` flag to auto-refresh image from server
- Minimal resource usage (no browser required)
- Works over Tailscale or any network

## Server Setup

### Configuration

Create a `.env` file with your configuration:

```bash
cp .env.example .env
# Edit .env and set your DISPLAY_URL
```

Required environment variables:
- `DISPLAY_URL`: Your DakBoard display URL (required)
- `WIDTH`: Screen width in pixels (default: 1920)
- `HEIGHT`: Screen height in pixels (default: 1080)
- `HTTP_PORT`: HTTP server port (default: 3000)

### Option 1: Docker Compose (Recommended)

```bash
# Set environment variables
export DISPLAY_URL="https://dakboard.com/display/uuid/YOUR-UUID-HERE"

# Or use .env file (docker-compose will read it automatically)

# Build and run
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Option 2: Docker

```bash
# Build image
docker build -t dakboard-renderer .

# Run container
docker run -d \
  -p 3000:3000 \
  -e DISPLAY_URL="https://dakboard.com/display/uuid/YOUR-UUID-HERE" \
  --name dakboard-renderer \
  dakboard-renderer

# View logs
docker logs -f dakboard-renderer
```

### Option 3: Node.js

```bash
# Install dependencies
npm install

# Set environment variable and run
export DISPLAY_URL="https://dakboard.com/display/uuid/YOUR-UUID-HERE"
node screenshot.js
```

## Client Setup (Raspberry Pi)

### Prerequisites

Install feh on your Raspberry Pi:

```bash
sudo apt-get update
sudo apt-get install feh
```

### Run Display

Replace `<SERVER_IP>` with your server's Tailscale IP or hostname:

```bash
# Fullscreen mode, reload every 1 second
feh --reload 1 --fullscreen http://<SERVER_IP>:3000/latest.png
```

### Auto-start on Boot

Create a systemd service file:

```bash
sudo nano /etc/systemd/system/dakboard-display.service
```

Add the following content (replace `<SERVER_IP>` and `<USER>`):

```ini
[Unit]
Description=DakBoard Display
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<USER>
Environment=DISPLAY=:0
Environment=WAYLAND_DISPLAY=wayland-1
ExecStart=/usr/bin/feh --reload 1 --fullscreen http://<SERVER_IP>:3000/latest.png
Restart=always
RestartSec=10

[Install]
WantedBy=graphical.target
```

Enable and start the service:

```bash
sudo systemctl enable dakboard-display.service
sudo systemctl start dakboard-display.service

# Check status
sudo systemctl status dakboard-display.service
```

## Configuration

Configuration is managed through environment variables (see `.env.example`):

- `DISPLAY_URL`: Your DakBoard display URL (required)
- `WIDTH` / `HEIGHT`: Screen resolution (default: 1920x1080)
- `HTTP_PORT`: HTTP server port (default: 3000)

No code changes needed!

## Monitoring

### Health Check

```bash
curl http://<SERVER_IP>:3000/health
```

### View Latest Screenshot

Open in browser:
```
http://<SERVER_IP>:3000/latest.png
```

## Troubleshooting

### Server Issues

1. **Container won't start:** Check logs with `docker-compose logs`
2. **Page not loading:** Increase wait time in screenshot.js (line 57)
3. **Clock not detected:** Verify CSS selector `.time.large` matches DakBoard's HTML

### Client Issues

1. **Black screen:** Ensure server is reachable and image is being served
2. **Image not updating:** Check feh is using `--reload` flag
3. **Wayland issues:** Try setting `WAYLAND_DISPLAY` environment variable

## Performance

- **Server:** Captures ~1 screenshot/second (~1.3MB PNG)
- **Network:** ~10 Mbps sustained bandwidth over gigabit connection
- **Client:** Minimal CPU/RAM usage (<50MB RAM typical)

## License

MIT

# Configuration Reference

Complete reference for web2fb configuration options.

## Configuration Files

web2fb supports both YAML and JSON configuration files.

**Loading priority:**
1. File specified with `--config=path/to/config.yaml`
2. `config.yaml` (current directory)
3. `config.json` (current directory)

```bash
node web2fb.js --config=/path/to/config.yaml
```

## IDE Autocomplete

Add schema validation to your config:

**JSON:**
```json
{
  "$schema": "./config.schema.json",
  "display": { ... }
}
```

**YAML:**
Most editors support schema validation via comments:
```yaml
# yaml-language-server: $schema=./config.schema.json
display:
  url: https://example.com
```

## Required Settings

### Display

```yaml
display:
  url: https://dakboard.com/display/your-id  # Required: URL to render
  width: 1920                                 # Display width (default: 1920)
  height: 1080                                # Display height (default: 1080)
  framebufferDevice: /dev/fb0                 # Framebuffer device (default: /dev/fb0)
```

## Screenshot Modes

### Local Mode (Default)

Uses Puppeteer with system Chromium. Browser launches fresh for each screenshot to prevent memory leaks.

```yaml
browser:
  mode: local  # Default, can be omitted

  # Optional local-specific settings:
  userAgent: "Mozilla/5.0 ..."               # Custom user agent
  waitDelay: 2000                            # Extra wait after page load (ms)
  waitForNetworkIdle: false                  # Wait for network idle (default: false)
  waitForSelector: ".content-loaded"         # CSS selector to wait for
```

**Local Mode Wait Strategies:**
- By default, waits for `load` event (fast, works for most pages)
- `waitForNetworkIdle: true` - Waits for 0 active network connections (stricter)
- `waitForSelector` - Waits for specific element(s) to appear
- `waitDelay` - Additional fixed delay after page load

### Remote Mode (Cloudflare Worker)

Offloads screenshot capture to a Cloudflare Worker. Ideal for very low-power devices.

```yaml
browser:
  mode: remote
  remoteScreenshotUrl: https://your-worker.workers.dev  # Required for remote mode
  remoteApiKey: your-api-key                            # Recommended for security
  remoteTimeout: 60000                                  # Request timeout (ms, default: 60000)

  # Wait strategies (same as local):
  waitDelay: 2000
  waitForSelector: ".calendar-day, .photo-loaded"
  waitForNetworkIdle: true
```

See [cloudflare-worker/](../cloudflare-worker/) for Worker deployment and [WAIT-STRATEGIES.md](../cloudflare-worker/WAIT-STRATEGIES.md) for detailed wait strategy documentation.

## Overlay System

Render dynamic elements (like clocks) locally instead of re-capturing the entire page.

```yaml
overlays:
  - name: clock
    type: clock                    # Built-in: clock, date, text, custom
    selector: ".time"              # CSS selector to hide on page
    enabled: true                  # Enable/disable this overlay
    updateInterval: 1000           # Update frequency (ms, default: 1000)

    # Overlay region (use tools/detect-overlays.js to auto-detect):
    region:
      x: 100
      y: 50
      width: 300
      height: 80

    # Overlay style (use tools/detect-overlays.js to auto-detect):
    style:
      fontSize: 64
      fontFamily: "Arial"
      color: "rgb(255, 255, 255)"
      fontWeight: "bold"
      textAlign: "center"

    # Clock-specific format:
    format:
      hour: "2-digit"
      minute: "2-digit"
      hour12: false
```

**Overlay Types:**
- `clock` - Digital clock with customizable format
- `date` - Current date display
- `text` - Static text overlay
- `custom` - Custom rendering function

See [overlays.md](overlays.md) for complete overlay documentation.

## Refresh Interval

How often to capture a fresh screenshot (with or without overlays):

```yaml
refreshInterval: 300000  # 5 minutes (default), in milliseconds
```

**With overlays:** Base image refreshes every 5 minutes, overlays update per their `updateInterval`
**Without overlays:** Entire screen refreshes every 5 minutes

## Splash Screen

Customize the startup splash screen:

```yaml
splash:
  text: "Loading Dashboard..."
  style:
    fontSize: 48
    fontFamily: "sans-serif"
    color: "rgb(255, 255, 255)"
    fontWeight: "normal"
```

## Environment Variables

Create a `.env` file (or set in systemd):

```bash
# Required for local mode on ARM devices:
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Optional:
DEBUG=1  # Enable performance monitoring
```

## Complete Example (Local Mode)

```yaml
name: "DakBoard Display (Local)"
description: "DakBoard with local screenshot capture"

display:
  url: https://dakboard.com/display/your-id
  width: 1920
  height: 1080

browser:
  mode: local
  waitDelay: 1000

overlays:
  - name: clock
    type: clock
    selector: ".time"
    updateInterval: 1000
    region: { x: 1620, y: 30, width: 280, height: 80 }
    style:
      fontSize: 64
      fontFamily: "Roboto"
      color: "rgb(255, 255, 255)"
      fontWeight: "300"

refreshInterval: 300000
```

## Complete Example (Remote Mode)

```yaml
name: "DakBoard Display (Remote)"
description: "DakBoard with Cloudflare Worker screenshots"

display:
  url: https://dakboard.com/display/your-id
  width: 1920
  height: 1080

browser:
  mode: remote
  remoteScreenshotUrl: https://web2fb-screenshots.your-account.workers.dev
  remoteApiKey: your-secret-key
  remoteTimeout: 60000
  waitForSelector: ".today, .photo-group-1-photo"
  waitDelay: 2000

refreshInterval: 300000
```

## Performance Tuning

**For Pi Zero 2 W:**
- Use remote mode to offload browser rendering
- Keep `refreshInterval` at 5+ minutes
- Limit overlays to 1-2 for best performance

**For Pi 4/5:**
- Local mode works great
- Can reduce `refreshInterval` to 1-2 minutes
- Support multiple overlays

**Debug Performance:**
```bash
DEBUG=1 node web2fb.js --config=config.yaml
```

This enables performance monitoring and logs timing for each operation.

## Schema Validation

The configuration is validated against [config.schema.json](../config.schema.json). Invalid configurations will show helpful error messages on startup.

## Examples

See [examples/](../examples/) directory for complete working configurations:
- `simple.yaml` - Minimal configuration
- `dakboard.yaml` - Local mode with overlays
- `dakboard-remote.yaml` - Remote mode with Cloudflare Worker
- `multi-overlay.yaml` - Multiple overlay types
- `remote-simple.yaml` - Remote mode without overlays

# Configuration Reference

Complete reference for web2fb configuration options.

## Configuration Files

web2fb looks for configuration in this order:
1. `config.json` (in the current directory)
2. `web2fb.config.json`
3. `.web2fb.json`

Or specify explicitly:
```bash
node web2fb.js --config=/path/to/config.json
```

## Configuration Schema

Your IDE can provide autocomplete by adding:
```json
{
  "$schema": "./config.schema.json",
  ...
}
```

## Display Settings

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

## Browser Settings

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

## Change Detection

Automatically detects when page content changes:

```json
{
  "changeDetection": {
    "enabled": true,                       // Enable change detection
    "watchSelectors": ["img", "[style*='background']"],
    "watchAttributes": ["src", "style", "class", "srcset"],
    "periodicCheckInterval": 120000,       // Fallback check every 2 minutes
    "debounceDelay": 500                   // Delay before re-render (ms)
  }
}
```

## Performance Options

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

## Environment Variables

Override config values:

- `DISPLAY_URL` - Override display.url
- `WIDTH` / `HEIGHT` - Override resolution
- `FRAMEBUFFER_DEVICE` - Override framebuffer device
- `PUPPETEER_EXECUTABLE_PATH` - Path to Chromium

Example `.env` file:
```bash
DISPLAY_URL=https://your-dashboard.com
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

## Example Configurations

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

### DakBoard Configuration

```json
{
  "$schema": "./config.schema.json",
  "name": "DakBoard Display",

  "display": {
    "url": "https://dakboard.com/display/uuid/YOUR-UUID",
    "width": 1920,
    "height": 1080
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
      "updateInterval": 1000,
      "format": {
        "hour": "numeric",
        "minute": "2-digit",
        "second": "2-digit"
      },
      "detectStyle": true
    }
  ],

  "changeDetection": {
    "enabled": true,
    "debounceDelay": 500,
    "periodicCheckInterval": 120000
  },

  "stressManagement": {
    "enabled": true
  }
}
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

## See Also

- [Overlay System](overlays.md) - Configure local overlays
- [Stress Management](stress-management.md) - Memory protection options
- [Examples Directory](../examples/) - Ready-to-use configurations

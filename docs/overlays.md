# Overlay System

Local rendering system for dynamic elements like clocks and dates.

## Why Use Overlays?

**Problem**: A clock that updates every second causes the entire webpage to re-render constantly.

**Solution**: Hide the clock element on the webpage and render it locally. Updates happen directly on the framebuffer without touching the browser.

**Performance**:
- Clock update without overlay: 4MB+ full page screenshot
- Clock update with overlay: ~110KB region write, ~50ms
- 99% reduction in I/O and CPU usage

## How It Works

1. Page loads and web2fb detects the clock element using a CSS selector
2. Element is hidden on the page (display: none)
3. Base screenshot is captured (without the clock)
4. Clock is rendered locally every second directly to framebuffer
5. Page re-renders only when actual content changes

## Clock Overlay

```json
{
  "name": "clock",
  "type": "clock",
  "selector": ".time.large",             // CSS selector to find element
  "enabled": true,
  "updateInterval": 1000,                // Update every 1 second
  "format": {
    "hour": "numeric",                   // "numeric" or "2-digit"
    "minute": "2-digit",
    "second": "2-digit",
    "hour12": false                      // true = 12-hour, false = 24-hour
  },
  "detectStyle": true                    // Auto-detect font/color from page
}
```

## Date Overlay

```json
{
  "name": "date",
  "type": "date",
  "selector": ".date",
  "updateInterval": 60000,               // Update every minute
  "format": {
    "weekday": "long",                   // "long", "short", "narrow"
    "year": "numeric",
    "month": "long",                     // "numeric", "2-digit", "long", "short", "narrow"
    "day": "numeric"
  },
  "detectStyle": true
}
```

## Text Overlay

Display custom static text:

```json
{
  "name": "status",
  "type": "text",
  "selector": ".status",
  "text": "System Online",
  "updateInterval": 5000
}
```

## Custom Overlay

For custom dynamic content, use type "custom" and implement the logic in `lib/overlays.js`.

## Style Detection

When `detectStyle: true`, web2fb automatically detects:
- Font family
- Font size
- Font weight
- Color
- Text alignment
- Letter spacing

This ensures the overlay matches the page style exactly.

## Manual Style Override

You can override detected styles:

```json
{
  "name": "clock",
  "type": "clock",
  "selector": ".time",
  "detectStyle": true,
  "style": {
    "fontSize": 72,
    "fontFamily": "Arial",
    "color": "#FFFFFF",
    "fontWeight": "bold",
    "textAlign": "center"
  }
}
```

## Finding CSS Selectors

1. Open your dashboard in a desktop browser
2. Right-click on the element you want to overlay
3. Select "Inspect" or "Inspect Element"
4. Look at the element's classes and ID
5. Create a unique selector:
   - By class: `.time` or `.time.large`
   - By ID: `#clock`
   - By combination: `div.widget .time`
6. Test in browser console: `document.querySelector('.your-selector')`

## Multiple Overlays

You can configure multiple overlays:

```json
{
  "overlays": [
    {
      "name": "clock",
      "type": "clock",
      "selector": ".time",
      "updateInterval": 1000
    },
    {
      "name": "date",
      "type": "date",
      "selector": ".date",
      "updateInterval": 60000
    },
    {
      "name": "status",
      "type": "text",
      "selector": ".status",
      "text": "Online"
    }
  ]
}
```

## Troubleshooting

### Overlay Not Detected

**Issue**: Log shows "Overlay 'name' not found"

**Solutions**:
1. Verify selector in browser console: `document.querySelector('.your-selector')`
2. Check if element exists after page load
3. Try a more specific selector
4. Check browser console for element structure

### Overlay Position Wrong

**Issue**: Overlay appears in wrong location

**Solutions**:
1. Ensure `detectStyle: true` is enabled
2. Check if page has CSS transforms or positioning
3. Verify element is visible before detection
4. Try refreshing the base image

### Overlay Style Doesn't Match

**Issue**: Font/color doesn't match page

**Solutions**:
1. Enable `detectStyle: true`
2. Add manual style overrides
3. Check if page uses custom fonts (may not be available system-wide)
4. Verify color detection in logs

## Performance Tips

1. **Higher update intervals** - If seconds aren't needed, update less frequently
2. **Multiple overlays** - Add all dynamic elements as overlays
3. **Style detection** - Let web2fb detect styles automatically
4. **Region size** - Smaller overlays = faster updates

## See Also

- [Configuration Reference](configuration.md)
- [Examples Directory](../examples/) - Working overlay configurations
- [Development](development.md) - Creating custom overlay types

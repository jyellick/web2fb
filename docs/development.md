# Development Guide

Testing, contributing, and extending web2fb.

## Local Testing (Without Pi Hardware)

Use the development server to test without Raspberry Pi hardware:

```bash
# Start development server (creates virtual framebuffer + web viewer)
npm run dev

# Or with custom port
node dev-server.js --port=8080

# Or with custom dimensions
WIDTH=1280 HEIGHT=720 npm run dev
```

The dev server:
- Creates virtual framebuffer at `./test-fb/fb0`
- Starts web server at http://localhost:3000
- Provides live view with auto-refresh

Then in another terminal:

```bash
# Run web2fb with virtual framebuffer
FRAMEBUFFER_DEVICE=test-fb/fb0 node web2fb.js --config=examples/dakboard.json

# Open http://localhost:3000 to see live output
```

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- stress-monitor

# Watch mode (re-run on file changes)
npm run test:watch

# Coverage report
npm run test:coverage
```

## Code Style

### Linting

```bash
# Check code style
npm run lint

# Fix issues automatically
npm run lint:fix
```

### Formatting

```bash
# Format all code
npm run format

# Check formatting without changes
npm run format:check
```

## Project Structure

```
web2fb/
├── web2fb.js              # Main application
├── lib/
│   ├── config.js          # Configuration loader
│   ├── overlays.js        # Overlay rendering system
│   ├── stress-monitor.js  # Stress management
│   └── cleanup.js         # Chrome profile cleanup
├── examples/              # Example configurations
├── tests/                 # Test files
│   ├── unit/
│   └── integration/
├── docs/                  # Documentation
├── dev-server.js          # Development server
└── config.schema.json     # Configuration schema
```

## Creating Custom Overlays

### 1. Add Overlay Type to lib/overlays.js

```javascript
function generateCustomOverlay(overlay, region) {
  // Your custom logic here
  const content = getYourDynamicContent();

  // Use SVG for text rendering
  return generateTextSVG(content, overlay, region);

  // Or return PNG buffer directly
  // return Buffer.from(...);
}

// Register in generateOverlay()
function generateOverlay(overlay, region) {
  switch (overlay.type) {
    case 'clock':
      return generateClockOverlay(overlay, region);
    case 'date':
      return generateDateOverlay(overlay, region);
    case 'text':
      return generateTextOverlay(overlay, region);
    case 'custom':
      return generateCustomOverlay(overlay, region);
    case 'mytype':  // Your new type
      return generateMyTypeOverlay(overlay, region);
    default:
      console.warn(`Unknown overlay type: ${overlay.type}`);
      return generateTextOverlay({ text: '', style: {} }, region);
  }
}
```

### 2. Add Configuration Support

Update `config.schema.json`:

```json
{
  "type": {
    "enum": ["clock", "date", "text", "custom", "mytype"]
  }
}
```

### 3. Use in Configuration

```json
{
  "overlays": [
    {
      "name": "my-overlay",
      "type": "mytype",
      "selector": ".my-element",
      "updateInterval": 1000,
      "myCustomOption": "value"
    }
  ]
}
```

## Adding Tests

### Unit Tests

Create `tests/unit/myfeature.test.js`:

```javascript
const MyFeature = require('../../lib/myfeature');

describe('MyFeature', () => {
  test('should do something', () => {
    const feature = new MyFeature();
    expect(feature.doSomething()).toBe(expected);
  });
});
```

### Integration Tests

Create `tests/integration/mytest.test.js`:

```javascript
const { loadConfig } = require('../../lib/config');

describe('Integration Test', () => {
  test('should load configuration', () => {
    const config = loadConfig('examples/simple.json');
    expect(config.display.url).toBeDefined();
  });
});
```

## Debugging

### Node.js Inspector

```bash
# Start with inspector
node --inspect web2fb.js

# Or with breakpoint at start
node --inspect-brk web2fb.js

# Then open chrome://inspect in Chrome
```

### Verbose Logging

```bash
# Enable debug output
DEBUG=* node web2fb.js

# Puppeteer debugging
DEBUG=puppeteer:* node web2fb.js
```

### Manual Testing

```bash
# Run without service
node web2fb.js --config=test-config.json

# Test with specific framebuffer
FRAMEBUFFER_DEVICE=test-fb/fb0 node web2fb.js
```

## Contributing

### Guidelines

1. **Test on actual Pi hardware when possible**
2. **Keep memory usage low** - This is critical for Pi Zero 2 W
3. **Document configuration options** - Update config.schema.json
4. **Add tests for new features**
5. **Follow existing code style** - Run `npm run lint`
6. **Update documentation** - Keep docs in sync with code

### Pull Request Process

1. Fork the repository
2. Create feature branch: `git checkout -b feature/my-feature`
3. Make changes and test
4. Run tests: `npm test`
5. Run linter: `npm run lint:fix`
6. Commit with clear message
7. Push and create pull request

### Commit Messages

Use clear, descriptive commit messages:

```
Add custom overlay type for weather data

- Implement weather overlay renderer
- Add configuration schema
- Update documentation
- Add tests
```

## Performance Testing

### Memory Usage

```bash
# Monitor memory during operation
watch -n 1 'ps aux | grep node'

# Or use htop
htop -p $(pgrep -f web2fb)
```

### Timing

The stress monitor tracks operation timing. Check logs:

```bash
sudo journalctl -u web2fb.service | grep "took.*ms"
```

### Profiling

```bash
# Start with profiler
node --prof web2fb.js

# Process profile after running
node --prof-process isolate-*-v8.log > profile.txt
```

## Release Process

1. Update version in `package.json`
2. Update CHANGELOG.md (if exists)
3. Run full test suite: `npm test`
4. Tag release: `git tag v1.0.0`
5. Push: `git push && git push --tags`

## Architecture Notes

### Framebuffer Writing

- Direct writes to `/dev/fb0` (no libraries needed)
- Supports RGB565 (16bpp), RGB (24bpp), RGBA (32bpp)
- Line-by-line writing for partial updates
- Buffer pooling for RGB565 conversion

### Overlay Rendering

- SVG to PNG conversion using Sharp
- Region extraction from base image
- Compositing overlay onto region
- Partial framebuffer write

### Stress Management

- Operation timing tracking
- Progressive throttling (4 levels)
- In-process browser restart
- Critical event decay over time

## Useful Resources

- [Puppeteer API](https://pptr.dev/)
- [Sharp Documentation](https://sharp.pixelplumbing.com/)
- [Linux Framebuffer](https://www.kernel.org/doc/Documentation/fb/framebuffer.txt)
- [systemd Service](https://www.freedesktop.org/software/systemd/man/systemd.service.html)

## See Also

- [Configuration Reference](configuration.md)
- [Overlay System](overlays.md)
- [Troubleshooting](troubleshooting.md)

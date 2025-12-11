#!/usr/bin/env node

/**
 * Development Server for web2fb
 *
 * Creates a virtual framebuffer and serves it via HTTP for easy testing
 * without actual Raspberry Pi hardware.
 *
 * Usage:
 *   node dev-server.js [--config=path/to/config.json] [--port=3000]
 */

const express = require('express');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const configArg = args.find(arg => arg.startsWith('--config='));
const configPath = configArg ? configArg.split('=')[1] : null;
const portArg = args.find(arg => arg.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1]) : 3000;

// Load config to get display dimensions (don't require URL for dev server)
let config = {
  display: {
    width: parseInt(process.env.WIDTH) || 1920,
    height: parseInt(process.env.HEIGHT) || 1080,
    framebufferDevice: './test-fb/fb0'
  }
};

// Try to load config if provided (but don't fail if URL is missing)
if (configPath || fs.existsSync('config.json')) {
  try {
    const configFile = fs.readFileSync(configPath || 'config.json', 'utf8');
    const userConfig = JSON.parse(configFile);
    if (userConfig.display) {
      config.display.width = userConfig.display.width || config.display.width;
      config.display.height = userConfig.display.height || config.display.height;
    }
    console.log('Loaded display dimensions from config');
  } catch (err) {
    // Config loading failed, use defaults
    console.log('Using default dimensions (1920x1080)');
  }
}

// Configuration
const FB_WIDTH = config.display.width || 1920;
const FB_HEIGHT = config.display.height || 1080;
const FB_BPP = 32; // 32-bit RGBA
const TEST_FB_DIR = './test-fb';
const TEST_FB_DEVICE = path.join(TEST_FB_DIR, 'fb0');
const SYSFS_DIR = path.join(TEST_FB_DIR, 'sys/class/graphics/fb0');

console.log('='.repeat(60));
console.log('web2fb Development Server');
console.log('='.repeat(60));
console.log(`Framebuffer: ${FB_WIDTH}x${FB_HEIGHT} @ ${FB_BPP}bpp`);
console.log(`Device: ${TEST_FB_DEVICE}`);
console.log(`Port: ${port}`);
console.log('='.repeat(60));

// Create test framebuffer environment
function setupFramebuffer() {
  console.log('Setting up virtual framebuffer...');

  // Create directory structure
  fs.mkdirSync(TEST_FB_DIR, { recursive: true });
  fs.mkdirSync(SYSFS_DIR, { recursive: true });

  // Create fake sysfs files for framebuffer detection
  fs.writeFileSync(
    path.join(SYSFS_DIR, 'virtual_size'),
    `${FB_WIDTH},${FB_HEIGHT}`
  );
  fs.writeFileSync(
    path.join(SYSFS_DIR, 'bits_per_pixel'),
    `${FB_BPP}`
  );

  // Calculate framebuffer size
  const fbSize = FB_WIDTH * FB_HEIGHT * (FB_BPP / 8);

  // Create empty framebuffer file if it doesn't exist
  if (!fs.existsSync(TEST_FB_DEVICE)) {
    console.log(`Creating framebuffer file (${fbSize} bytes)...`);
    const buffer = Buffer.alloc(fbSize);
    fs.writeFileSync(TEST_FB_DEVICE, buffer);
  }

  console.log('✓ Virtual framebuffer ready');
}

// Convert framebuffer to PNG
async function framebufferToPNG() {
  try {
    const rawBuffer = fs.readFileSync(TEST_FB_DEVICE);

    const pngBuffer = await sharp(rawBuffer, {
      raw: {
        width: FB_WIDTH,
        height: FB_HEIGHT,
        channels: 4 // RGBA
      }
    })
      .png()
      .toBuffer();

    return pngBuffer;
  } catch (err) {
    console.error('Error converting framebuffer:', err.message);
    throw err;
  }
}

// Setup Express server
function startServer() {
  const app = express();

  // Serve framebuffer as PNG
  app.get('/framebuffer.png', async (req, res) => {
    try {
      const pngBuffer = await framebufferToPNG();
      res.type('image/png');
      res.send(pngBuffer);
    } catch (err) {
      res.status(500).send('Error rendering framebuffer');
    }
  });

  // Serve viewer HTML
  app.get('/', (req, res) => {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>web2fb Development Server</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #1a1a1a;
      color: #fff;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    header {
      background: #2a2a2a;
      padding: 1rem 2rem;
      border-bottom: 2px solid #3a3a3a;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
    }
    .info {
      margin-top: 0.5rem;
      font-size: 0.875rem;
      color: #aaa;
    }
    .info span {
      margin-right: 1.5rem;
    }
    main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      overflow: auto;
    }
    .framebuffer-container {
      position: relative;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      border-radius: 4px;
      overflow: hidden;
      background: #000;
    }
    #framebuffer {
      display: block;
      max-width: 100%;
      height: auto;
    }
    .loading {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: #666;
      font-size: 1rem;
    }
    .controls {
      background: #2a2a2a;
      padding: 1rem 2rem;
      border-top: 1px solid #3a3a3a;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .controls-left {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    button {
      background: #007acc;
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
    }
    button:hover {
      background: #005a9e;
    }
    button:active {
      transform: translateY(1px);
    }
    button.pause {
      background: #666;
    }
    button.pause:hover {
      background: #555;
    }
    .refresh-rate {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      color: #aaa;
    }
    .refresh-rate input {
      width: 80px;
      padding: 0.25rem;
      border: 1px solid #555;
      background: #1a1a1a;
      color: #fff;
      border-radius: 2px;
    }
    .status {
      font-size: 0.875rem;
      color: #aaa;
    }
    .status.updating {
      color: #4caf50;
    }
  </style>
</head>
<body>
  <header>
    <h1>web2fb Development Server</h1>
    <div class="info">
      <span>Resolution: ${FB_WIDTH}x${FB_HEIGHT}</span>
      <span>BPP: ${FB_BPP}</span>
      <span>Device: ${TEST_FB_DEVICE}</span>
    </div>
  </header>

  <main>
    <div class="framebuffer-container">
      <img id="framebuffer" src="/framebuffer.png" alt="Framebuffer">
      <div class="loading" id="loading">Loading...</div>
    </div>
  </main>

  <div class="controls">
    <div class="controls-left">
      <button id="toggle" onclick="toggleRefresh()">Pause</button>
      <div class="refresh-rate">
        <label for="interval">Refresh interval:</label>
        <input type="number" id="interval" value="1000" min="100" step="100">
        <span>ms</span>
      </div>
    </div>
    <div class="status" id="status">Auto-refreshing...</div>
  </div>

  <script>
    let isPaused = false;
    let refreshInterval = 1000;
    let intervalId = null;
    let lastUpdate = Date.now();

    const img = document.getElementById('framebuffer');
    const loading = document.getElementById('loading');
    const status = document.getElementById('status');
    const toggle = document.getElementById('toggle');
    const intervalInput = document.getElementById('interval');

    // Hide loading once image loads
    img.onload = () => {
      loading.style.display = 'none';
    };

    function updateFramebuffer() {
      if (isPaused) return;

      status.textContent = 'Updating...';
      status.classList.add('updating');

      // Add timestamp to prevent caching
      img.src = '/framebuffer.png?' + Date.now();

      setTimeout(() => {
        status.textContent = 'Auto-refreshing...';
        status.classList.remove('updating');
      }, 200);
    }

    function toggleRefresh() {
      isPaused = !isPaused;
      toggle.textContent = isPaused ? 'Resume' : 'Pause';
      toggle.classList.toggle('pause', isPaused);

      if (isPaused) {
        clearInterval(intervalId);
        status.textContent = 'Paused';
        status.classList.remove('updating');
      } else {
        startRefresh();
        status.textContent = 'Auto-refreshing...';
      }
    }

    function startRefresh() {
      clearInterval(intervalId);
      intervalId = setInterval(updateFramebuffer, refreshInterval);
    }

    intervalInput.addEventListener('change', (e) => {
      refreshInterval = parseInt(e.target.value) || 1000;
      if (!isPaused) {
        startRefresh();
      }
    });

    // Start auto-refresh
    startRefresh();

    // Initial update
    updateFramebuffer();
  </script>
</body>
</html>
    `;
    res.send(html);
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      framebuffer: {
        width: FB_WIDTH,
        height: FB_HEIGHT,
        bpp: FB_BPP,
        device: TEST_FB_DEVICE
      }
    });
  });

  app.listen(port, () => {
    console.log('');
    console.log('✓ Server started successfully!');
    console.log('');
    console.log('  View framebuffer: http://localhost:' + port);
    console.log('  API endpoint:     http://localhost:' + port + '/framebuffer.png');
    console.log('  Health check:     http://localhost:' + port + '/health');
    console.log('');
    console.log('Now run web2fb in another terminal:');
    console.log('  FRAMEBUFFER_DEVICE=' + TEST_FB_DEVICE + ' node web2fb.js');
    console.log('');
    console.log('Press Ctrl+C to stop');
    console.log('='.repeat(60));
  });
}

// Main
try {
  setupFramebuffer();
  startServer();
} catch (err) {
  console.error('Failed to start development server:', err);
  process.exit(1);
}

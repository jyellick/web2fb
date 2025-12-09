const puppeteer = require('puppeteer');
const express = require('express');
const path = require('path');

const DISPLAY_URL = process.env.DISPLAY_URL || 'https://example.com';
const WIDTH = parseInt(process.env.WIDTH || '1920', 10);
const HEIGHT = parseInt(process.env.HEIGHT || '1080', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);
const SCREENSHOT_PATH = 'latest.png';

if (DISPLAY_URL === 'https://example.com') {
  console.error('ERROR: DISPLAY_URL environment variable is required');
  process.exit(1);
}

// Global state for video streaming
let latestFrameBuffer = null;
const streamClients = new Set();

(async () => {
  // Start HTTP server
  const app = express();

  app.get('/latest.png', (req, res) => {
    res.sendFile(path.join(__dirname, SCREENSHOT_PATH), (err) => {
      if (err) {
        console.error('Error serving image:', err);
        res.status(404).send('Image not yet available');
      }
    });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // MJPEG video stream endpoint
  app.get('/stream.mjpeg', (req, res) => {
    console.log('New MJPEG stream client connected');

    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Connection': 'close'
    });

    // Send initial frame if available
    if (latestFrameBuffer) {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrameBuffer.length}\r\n\r\n`);
      res.write(latestFrameBuffer);
      res.write('\r\n');
    }

    // Add client to stream set
    streamClients.add(res);

    // Remove client on disconnect
    req.on('close', () => {
      streamClients.delete(res);
      console.log('MJPEG stream client disconnected');
    });
  });

  app.listen(HTTP_PORT, () => {
    console.log(`HTTP server listening on port ${HTTP_PORT}`);
    console.log(`Image available at: http://localhost:${HTTP_PORT}/latest.png`);
    console.log(`Video stream available at: http://localhost:${HTTP_PORT}/stream.mjpeg`);
  });

  // Launch browser and start capturing
  const browser = await puppeteer.launch({
    headless: 'new', // Use new headless mode (more compatible)
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled', // Hide automation
      '--disable-web-security', // Help with CORS issues
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });

  const page = await browser.newPage();

  // Set a realistic user agent to avoid detection
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Remove webdriver flag
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  // Set viewport to 1080p resolution
  await page.setViewport({
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
  });

  console.log('Loading page...');
  // Navigate and wait for load event
  await page.goto(DISPLAY_URL, {
    waitUntil: ['load', 'networkidle2'],
    timeout: 60000
  });

  console.log('Scrolling page to trigger lazy loading...');
  // Scroll to trigger any lazy-loaded images
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });

  console.log('Waiting for all images to load...');
  // Wait for all images (including background images) to finish loading
  await page.waitForFunction(() => {
    // Check all <img> elements are loaded
    const images = Array.from(document.images);
    const allImagesLoaded = images.every(img => img.complete && img.naturalHeight !== 0);

    // Check if network is idle (no pending requests)
    const noNetworkActivity = performance.getEntriesByType('resource')
      .filter(r => r.initiatorType === 'img' || r.initiatorType === 'css')
      .every(r => r.responseEnd > 0);

    return allImagesLoaded && noNetworkActivity;
  }, { timeout: 30000 });

  console.log('All images loaded, page ready');

  console.log('Setting up MutationObserver on clock element...');

  // Watchdog: Track last update time and restart if stuck
  let lastUpdateTime = Date.now();
  const WATCHDOG_TIMEOUT = 30000; // 30 seconds

  setInterval(() => {
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateTime;

    if (timeSinceLastUpdate > WATCHDOG_TIMEOUT) {
      console.error(`WATCHDOG: No updates for ${timeSinceLastUpdate}ms. Restarting...`);
      process.exit(1); // Docker will restart the container
    }
  }, 10000); // Check every 10 seconds

  // Set up MutationObserver to watch for clock changes
  await page.exposeFunction('onClockChange', async () => {
    // Capture PNG for static endpoint
    await page.screenshot({ path: SCREENSHOT_PATH });

    // Capture JPEG for video stream
    const jpegBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 85
    });

    // Store latest frame
    latestFrameBuffer = jpegBuffer;

    // Broadcast to all connected stream clients
    if (streamClients.size > 0) {
      const frame = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBuffer.length}\r\n\r\n`;
      streamClients.forEach(client => {
        try {
          client.write(frame);
          client.write(jpegBuffer);
          client.write('\r\n');
        } catch (err) {
          // Client disconnected, will be removed by close handler
          streamClients.delete(client);
        }
      });
    }

    lastUpdateTime = Date.now(); // Update watchdog timer
    const timestamp = new Date().toISOString();
    console.log(`Updated ${SCREENSHOT_PATH} at ${timestamp} (${streamClients.size} stream clients)`);
  });

  await page.evaluate(() => {
    // Find the time element (look for element with class "time")
    const timeElement = document.querySelector('.time.large');

    if (!timeElement) {
      console.error('Could not find time element');
      return;
    }

    console.log('Found time element, setting up observer...');

    // Create a MutationObserver to watch for changes
    const observer = new MutationObserver((mutations) => {
      // Call our exposed function when clock changes
      window.onClockChange();
    });

    // Observe changes to the time element and its children (including the seconds span)
    observer.observe(timeElement, {
      childList: true,      // Watch for added/removed child nodes
      subtree: true,        // Watch all descendants
      characterData: true   // Watch for text content changes
    });

    console.log('MutationObserver active');
  });

  console.log('Monitoring clock for changes. Press Ctrl+C to stop.');

  // Keep the script running
  // Press Ctrl+C to stop
})();

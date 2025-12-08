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

  app.listen(HTTP_PORT, () => {
    console.log(`HTTP server listening on port ${HTTP_PORT}`);
    console.log(`Image available at: http://localhost:${HTTP_PORT}/latest.png`);
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

  // Check for background image on body or main container
  const bgInfo = await page.evaluate(() => {
    const body = document.body;
    const bgImage = window.getComputedStyle(body).backgroundImage;
    return {
      element: 'body',
      backgroundImage: bgImage,
      isLoaded: bgImage !== 'none' && !bgImage.includes('data:')
    };
  });
  console.log('Background image info:', bgInfo);

  console.log('All images loaded, page ready');

  console.log('Setting up MutationObserver on clock element...');

  // Set up MutationObserver to watch for clock changes
  await page.exposeFunction('onClockChange', async () => {
    await page.screenshot({ path: SCREENSHOT_PATH });
    const timestamp = new Date().toISOString();
    console.log(`Updated ${SCREENSHOT_PATH} at ${timestamp}`);
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

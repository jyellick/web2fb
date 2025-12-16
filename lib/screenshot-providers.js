/**
 * Screenshot Provider Abstraction
 *
 * Provides a clean interface for swapping between local (Puppeteer) and remote (Cloudflare Worker)
 * screenshot acquisition methods.
 *
 * Local mode: Browser starts fresh for each screenshot, then tears down completely.
 * This prevents memory leaks, cache growth, and browser crashes.
 */

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

/**
 * Base class for screenshot providers
 */
class ScreenshotProvider {
  constructor(config) {
    this.config = config;
  }

  /**
   * Initialize the provider (validate config, etc.)
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Capture a screenshot of the configured URL
   * @param {Array} hideSelectors - CSS selectors to hide before screenshot
   * @returns {Promise<Buffer>} Screenshot buffer
   */
  async captureScreenshot(hideSelectors = []) {
    throw new Error('captureScreenshot() must be implemented by subclass');
  }

  /**
   * Cleanup resources
   * @returns {Promise<void>}
   */
  async cleanup() {
    throw new Error('cleanup() must be implemented by subclass');
  }

  /**
   * Get provider type name
   * @returns {string}
   */
  getType() {
    return 'unknown';
  }
}

/**
 * Local screenshot provider using Puppeteer
 *
 * Each screenshot is a fresh browser session:
 * 1. Launch browser with temp profile
 * 2. Load page and wait for images
 * 3. Take screenshot
 * 4. Close browser and delete profile
 *
 * This prevents all long-running browser issues (memory leaks, cache growth, crashes).
 */
class LocalScreenshotProvider extends ScreenshotProvider {
  constructor(config) {
    super(config);
  }

  getType() {
    return 'local';
  }

  async initialize() {
    // Validate config only - we don't launch browser until screenshot time
    if (!this.config.display || !this.config.display.url) {
      throw new Error('display.url is required');
    }

    console.log('✓ Local screenshot provider initialized (browser starts fresh each screenshot)');
  }

  async captureScreenshot(hideSelectors = []) {
    let browser = null;
    let page = null;

    try {
      const browserConfig = this.config.browser || {};

      // Optimized Chrome args for Pi Zero 2 W
      // NOTE: No temporary profile - working version used persistent/default profile
      const browserArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',  // Hide automation detection
        '--disable-web-security',  // Disable CORS/security (needed for some pages)
        '--disable-features=IsolateOrigins,site-per-process',  // Reduce process isolation overhead
        '--disable-gpu',  // No GPU on Pi
        '--disable-dev-shm-usage',
        '--single-process',
        '--disable-software-rasterizer',
        '--no-zygote',  // Disable zygote process
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-pings',
        '--safebrowsing-disable-auto-update',
        '--disk-cache-size=1',
        '--media-cache-size=1',
        '--aggressive-cache-discard',
        '--disable-cache',
        '--disable-application-cache',
        '--disable-offline-load-stale-cache',
        '--disk-cache-size=0'
      ];

      // Launch browser with extended timeout for Pi Zero 2 W
      console.log('Local browser: Launching browser...');
      browser = await puppeteer.launch({
        headless: 'new',
        args: browserArgs,
        ignoreDefaultArgs: ['--enable-automation'],
        dumpio: false,
        timeout: 60000 // 60 seconds (default is 30s)
      });
      console.log('Local browser: Browser launched successfully');

      // Set process priority on Pi
      if (browser.process()) {
        const pid = browser.process().pid;
        try {
          const { execSync } = require('child_process');
          execSync(`renice -n 10 -p ${pid}`);
        } catch (err) {
          // Ignore errors (requires permissions)
        }
      }

      // Create page and load URL
      page = await browser.newPage();

      // Remove webdriver flag (anti-detection)
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined
        });
      });

      // Set up error handlers to diagnose frame detachment issues
      page.on('error', error => {
        console.error('Local browser: Page error:', error.message);
      });
      page.on('pageerror', error => {
        console.error('Local browser: Page script error:', error.message);
      });

      console.log('Local browser: Setting viewport and user agent...');
      await page.setViewport({
        width: this.config.display.width || 1920,
        height: this.config.display.height || 1080
      });

      if (browserConfig.userAgent) {
        await page.setUserAgent(browserConfig.userAgent);
      }

      // Use 'load' by default (just wait for DOM load event, not network idle)
      // This is faster and more reliable on Pi, especially with pages that maintain
      // persistent connections. Only use networkidle if explicitly configured.
      let waitUntil = browserConfig.waitForNetworkIdle ? 'networkidle0' : 'load';
      console.log(`Local browser: Navigating to ${this.config.display.url} (waitUntil: ${waitUntil})...`);

      try {
        await page.goto(this.config.display.url, {
          waitUntil,
          timeout: 180000 // 3 minutes
        });
        console.log('Local browser: Navigation complete');
      } catch (err) {
        console.error('Local browser: Navigation failed:', err.message);

        // Check if browser is still alive
        if (browser && browser.process() && browser.process().killed) {
          throw new Error('Browser process was killed - likely out of memory');
        }

        // If networkidle0 failed with frame detached, retry with 'load' (original working behavior)
        if (waitUntil === 'networkidle0' && err.message.includes('frame was detached')) {
          console.log('Local browser: Retrying navigation with "load" event (more forgiving)...');
          waitUntil = 'load';

          // Close and recreate page for clean retry
          await page.close();
          page = await browser.newPage();

          // Reapply viewport and user agent
          await page.setViewport({
            width: this.config.display.width || 1920,
            height: this.config.display.height || 1080
          });

          if (browserConfig.userAgent) {
            await page.setUserAgent(browserConfig.userAgent);
          }

          await page.goto(this.config.display.url, {
            waitUntil: 'load',
            timeout: 180000
          });
          console.log('Local browser: Navigation complete (fallback to "load")');
        } else {
          throw err;
        }
      }

      // Scroll to trigger lazy loading (best effort - don't fail if target closes)
      console.log('Local browser: Scrolling page to trigger lazy loading...');
      try {
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        console.log('Local browser: Scrolling complete');
      } catch (err) {
        console.log(`Local browser: Scrolling failed (${err.message}), continuing anyway`);
      }

      // Wait for images like the working version did (best effort)
      console.log('Local browser: Waiting for all images to load...');
      try {
        await page.waitForFunction(() => {
          const images = Array.from(document.images);
          const allImagesLoaded = images.every(img => img.complete && img.naturalHeight !== 0);
          const noNetworkActivity = performance.getEntriesByType('resource')
            .filter(r => r.initiatorType === 'img' || r.initiatorType === 'css')
            .every(r => r.responseEnd > 0);
          return allImagesLoaded && noNetworkActivity;
        }, { timeout: 120000 });  // 2 minutes
        console.log('Local browser: All images loaded, page ready');
      } catch (err) {
        console.log(`Local browser: Image waiting failed (${err.message}), continuing anyway`);
      }

      // Additional delay if requested
      if (browserConfig.waitDelay && browserConfig.waitDelay > 0) {
        console.log(`Local browser: Waiting additional ${browserConfig.waitDelay}ms for async content...`);
        await new Promise(resolve => setTimeout(resolve, browserConfig.waitDelay));
      }

      // Disable animations (best effort)
      console.log('Local browser: Disabling CSS transitions and animations...');
      try {
        await page.addStyleTag({
          content: `
            *, *::before, *::after {
              animation-duration: 0s !important;
              animation-delay: 0s !important;
              transition-duration: 0s !important;
              transition-delay: 0s !important;
              animation: none !important;
              transition: none !important;
            }
          `
        });
        console.log('Local browser: Animations disabled');
      } catch (err) {
        console.log(`Local browser: Failed to disable animations (${err.message}), continuing anyway`);
      }

      // Hide overlay elements if specified (best effort)
      if (hideSelectors.length > 0) {
        console.log(`Local browser: Hiding ${hideSelectors.length} overlay element(s)...`);
        try {
          await page.addStyleTag({
            content: hideSelectors.map(selector => `${selector} { visibility: hidden !important; }`).join('\n')
          });
          console.log('Local browser: Overlay elements hidden');
        } catch (err) {
          console.log(`Local browser: Failed to hide overlays (${err.message}), continuing anyway`);
        }
      }

      // Wait for page to re-render after style changes (critical!)
      // Working version used 2000ms for complete rendering
      console.log('Local browser: Waiting for complete page render...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Take screenshot
      console.log('Local browser: Taking screenshot...');
      let screenshot;
      try {
        // Try PNG first (simpler encoding, may use less memory than JPEG)
        screenshot = await page.screenshot({
          type: 'png',
          optimizeForSpeed: true,
          captureBeyondViewport: false
        });
        console.log(`Local browser: Screenshot captured (${screenshot.length} bytes, PNG)`);
      } catch (screenshotError) {
        console.error('Local browser: Screenshot capture failed:', screenshotError.message);

        // Check if browser/page are still alive
        const browserAlive = browser && browser.process() && !browser.process().killed;
        const pageAlive = page && !page.isClosed();
        console.error(`Local browser: Browser alive: ${browserAlive}, Page alive: ${pageAlive}`);

        throw screenshotError;
      }

      return screenshot;

    } finally {
      // Always clean up, even if errors occurred
      console.log('Local browser: Cleaning up...');

      if (page) {
        try {
          await page.close();
        } catch (err) {
          console.log(`Local browser: Page close error: ${err.message}`);
        }
      }

      if (browser) {
        const browserProcess = browser.process();
        try {
          await browser.close();
          console.log('Local browser: Browser closed');
        } catch (err) {
          console.log(`Local browser: Browser close error: ${err.message}`);
        }

        // Ensure process is killed (belt and suspenders)
        if (browserProcess && !browserProcess.killed) {
          try {
            browserProcess.kill('SIGKILL');
            console.log(`Local browser: Force-killed browser process ${browserProcess.pid}`);
          } catch (err) {
            console.log(`Local browser: Process kill error: ${err.message}`);
          }
        }
      }

      console.log('Local browser: Cleanup complete');
    }
  }

  async cleanup() {
    // Nothing to cleanup - each screenshot is self-contained
    console.log('✓ Local screenshot provider cleaned up');
  }
}

/**
 * Remote screenshot provider using Cloudflare Worker
 */
class RemoteScreenshotProvider extends ScreenshotProvider {
  constructor(config) {
    super(config);
    this.workerUrl = null;
    this.apiKey = null;
  }

  getType() {
    return 'remote';
  }

  async initialize() {
    const browserConfig = this.config.browser || {};

    this.workerUrl = browserConfig.remoteScreenshotUrl;
    this.apiKey = browserConfig.remoteApiKey;

    if (!this.workerUrl) {
      throw new Error('Remote mode requires browser.remoteScreenshotUrl in config');
    }

    console.log(`✓ Remote screenshot provider initialized: ${this.workerUrl}`);
  }

  async captureScreenshot(hideSelectors = []) {
    const browserConfig = this.config.browser || {};

    // Build query parameters
    const params = new URLSearchParams({
      url: this.config.display.url,
      width: (this.config.display.width || 1920).toString(),
      height: (this.config.display.height || 1080).toString(),
      timeout: (browserConfig.remoteTimeout || 60000).toString(),
      waitForImages: 'true'
    });

    if (browserConfig.userAgent) {
      params.set('userAgent', browserConfig.userAgent);
    }

    // Wait controls for page loading
    if (browserConfig.waitDelay && browserConfig.waitDelay > 0) {
      params.set('waitDelay', browserConfig.waitDelay.toString());
    }

    if (browserConfig.waitForSelector) {
      params.set('waitForSelector', browserConfig.waitForSelector);
    }

    if (browserConfig.waitForNetworkIdle) {
      params.set('waitForNetworkIdle', 'true');
    }

    if (hideSelectors && hideSelectors.length > 0) {
      params.set('hideSelectors', hideSelectors.join(','));
    }

    const requestUrl = `${this.workerUrl}?${params.toString()}`;

    const headers = {
      'Accept': 'image/png'
    };

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    const response = await fetch(requestUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(browserConfig.remoteTimeout || 60000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Remote screenshot failed: ${response.status} ${response.statusText}\n${errorText}`);
    }

    // Validate that we received an image
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      // Not an image - try to read as text for debugging
      const bodyText = await response.text();
      const preview = bodyText.substring(0, 500);
      throw new Error(
        `Remote service returned non-image content-type: ${contentType}\n` +
        `Response preview: ${preview}${bodyText.length > 500 ? '...' : ''}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Additional validation - check for common image signatures
    if (buffer.length < 8) {
      throw new Error(`Remote screenshot buffer too small (${buffer.length} bytes) - likely not a valid image`);
    }

    // Check magic bytes to verify actual image format
    const magicBytes = buffer.subarray(0, 8);
    const magicHex = magicBytes.toString('hex');
    let detectedFormat = 'unknown';

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (magicBytes[0] === 0x89 && magicBytes[1] === 0x50 && magicBytes[2] === 0x4E && magicBytes[3] === 0x47) {
      detectedFormat = 'PNG';
    }
    // JPEG: FF D8 FF
    else if (magicBytes[0] === 0xFF && magicBytes[1] === 0xD8 && magicBytes[2] === 0xFF) {
      detectedFormat = 'JPEG';
    }
    // WebP: RIFF....WEBP
    else if (magicBytes[0] === 0x52 && magicBytes[1] === 0x49 && magicBytes[2] === 0x46 && magicBytes[3] === 0x46) {
      detectedFormat = 'WebP/RIFF';
    }
    // GIF: GIF87a or GIF89a
    else if (magicBytes[0] === 0x47 && magicBytes[1] === 0x49 && magicBytes[2] === 0x46) {
      detectedFormat = 'GIF';
    }
    else {
      // Not a recognized image format
      const preview = buffer.toString('utf8', 0, Math.min(200, buffer.length)).replace(/[^\x20-\x7E]/g, '.');
      throw new Error(
        `Remote service returned buffer with invalid image signature\n` +
        `Content-Type: ${contentType}\n` +
        `Buffer size: ${buffer.length} bytes\n` +
        `Magic bytes: ${magicHex}\n` +
        `Buffer preview: ${preview}`
      );
    }

    // Log successful fetch
    console.log(`Remote screenshot received: ${contentType}, ${detectedFormat}, ${buffer.length} bytes`);

    return buffer;
  }

  async cleanup() {
    // No cleanup needed for remote provider
    console.log('✓ Remote screenshot provider cleaned up');
  }
}

/**
 * Factory function to create appropriate provider based on config
 */
function createScreenshotProvider(config) {
  const browserConfig = config.browser || {};
  const mode = browserConfig.mode || 'local';

  switch (mode) {
    case 'local':
      return new LocalScreenshotProvider(config);
    case 'remote':
      return new RemoteScreenshotProvider(config);
    default:
      throw new Error(`Unknown screenshot provider mode: ${mode}. Must be 'local' or 'remote'`);
  }
}

module.exports = {
  ScreenshotProvider,
  LocalScreenshotProvider,
  RemoteScreenshotProvider,
  createScreenshotProvider
};

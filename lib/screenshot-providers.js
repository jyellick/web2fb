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
    let userDataDir = null;

    try {
      // Create temporary Chrome profile
      userDataDir = await fs.mkdtemp(path.join('/tmp', 'chrome-profile-'));

      const browserConfig = this.config.browser || {};

      // Optimized Chrome args for Pi Zero 2 W
      const browserArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--single-process',
        '--disable-software-rasterizer',
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
        '--safebrowsing-disable-auto-update',
        '--disk-cache-size=1',
        '--media-cache-size=1',
        '--aggressive-cache-discard',
        '--disable-cache',
        '--disable-application-cache',
        '--disable-offline-load-stale-cache',
        '--disk-cache-size=0',
        `--user-data-dir=${userDataDir}`
      ];

      // Launch browser
      browser = await puppeteer.launch({
        headless: 'new',
        args: browserArgs,
        ignoreDefaultArgs: ['--enable-automation'],
        dumpio: false
      });

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

      await page.setViewport({
        width: this.config.display.width || 1920,
        height: this.config.display.height || 1080
      });

      if (browserConfig.userAgent) {
        await page.setUserAgent(browserConfig.userAgent);
      }

      await page.goto(this.config.display.url, {
        waitUntil: 'load',
        timeout: 180000 // 3 minutes
      });

      // Scroll to trigger lazy loading
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await new Promise(resolve => setTimeout(resolve, 1000));
      await page.evaluate(() => window.scrollTo(0, 0));

      // Wait for images
      await page.waitForFunction(() => {
        const images = Array.from(document.images);
        return images.every(img => img.complete && img.naturalHeight !== 0);
      }, { timeout: 120000 }); // 2 minutes

      // Disable animations
      await page.addStyleTag({
        content: `
          *, *::before, *::after {
            animation-duration: 0s !important;
            animation-delay: 0s !important;
            transition-duration: 0s !important;
            transition-delay: 0s !important;
          }
        `
      });

      // Hide overlay elements
      if (hideSelectors.length > 0) {
        await page.addStyleTag({
          content: hideSelectors.map(selector => `${selector} { visibility: hidden !important; }`).join('\n')
        });
      }

      // Take screenshot
      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 90
      });

      return screenshot;

    } finally {
      // Always clean up, even if errors occurred
      if (page) {
        try {
          await page.close();
        } catch (err) {
          // Ignore
        }
      }

      if (browser) {
        try {
          await browser.close();
        } catch (err) {
          // Ignore
        }
      }

      // Clean up Chrome profile
      if (userDataDir) {
        try {
          await fs.rm(userDataDir, { recursive: true, force: true });
        } catch (err) {
          // Ignore
        }
      }
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

    // Log successful fetch for debugging
    if (process.env.DEBUG) {
      console.log(`Remote screenshot received: ${contentType}, ${buffer.length} bytes`);
    }

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

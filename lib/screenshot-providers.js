/**
 * Screenshot Provider Abstraction
 *
 * Provides a clean interface for swapping between local (Puppeteer) and remote (Cloudflare Worker)
 * screenshot acquisition methods.
 */

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

/**
 * Base class for screenshot providers
 */
class ScreenshotProvider {
  constructor(config) {
    this.config = config;
  }

  /**
   * Initialize the provider (e.g., launch browser, validate remote URL)
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
   * Check if provider supports change detection
   * @returns {boolean}
   */
  supportsChangeDetection() {
    return false;
  }

  /**
   * Setup change detection (only for providers that support it)
   * @param {Function} onChangeCallback - Called when page changes detected
   * @returns {Promise<void>}
   */
  async setupChangeDetection(onChangeCallback) {
    throw new Error('This provider does not support change detection');
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
 */
class LocalScreenshotProvider extends ScreenshotProvider {
  constructor(config) {
    super(config);
    this.browser = null;
    this.page = null;
    this.userDataDir = null;
  }

  getType() {
    return 'local';
  }

  async initialize() {
    const browserConfig = this.config.browser || {};

    // Create temporary Chrome profile in tmpfs for performance on Pi
    this.userDataDir = await fs.mkdtemp(path.join('/tmp', 'chrome-profile-'));
    console.log(`Chrome profile directory: ${this.userDataDir}`);

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
      `--user-data-dir=${this.userDataDir}`
    ];

    console.log('Launching browser...');
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: browserArgs,
      ignoreDefaultArgs: ['--enable-automation'],
      dumpio: false
    });

    // Set process priority on Pi
    if (this.browser.process()) {
      const pid = this.browser.process().pid;
      try {
        const { execSync } = require('child_process');
        execSync(`renice -n 10 -p ${pid}`);
        console.log(`✓ Set browser process (PID ${pid}) to nice priority 10`);
      } catch (err) {
        // Ignore errors (requires permissions)
      }
    }

    // Handle browser crashes
    this.browser.on('disconnected', () => {
      console.error('🚨 CRITICAL: Browser process disconnected/crashed');
      this.browser = null;
      this.page = null;
    });

    // Create page and load URL
    this.page = await this.browser.newPage();

    console.log(`Setting viewport: ${this.config.display.width}x${this.config.display.height}`);
    await this.page.setViewport({
      width: this.config.display.width || 1920,
      height: this.config.display.height || 1080
    });

    if (browserConfig.userAgent) {
      await this.page.setUserAgent(browserConfig.userAgent);
    }

    console.log(`Loading page: ${this.config.display.url}`);
    await this.page.goto(this.config.display.url, {
      waitUntil: 'load',
      timeout: 180000 // 3 minutes
    });

    // Scroll to trigger lazy loading
    console.log('Scrolling to trigger lazy loading...');
    await this.page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    await this.page.evaluate(() => window.scrollTo(0, 0));

    // Wait for images
    console.log('Waiting for images to load...');
    await this.page.waitForFunction(() => {
      const images = Array.from(document.images);
      return images.every(img => img.complete && img.naturalHeight !== 0);
    }, { timeout: 120000 }); // 2 minutes
    console.log('All images loaded');

    // Disable animations
    console.log('Disabling CSS animations...');
    await this.page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
            transition-duration: 0s !important;
            transition-delay: 0s !important;
          }
        `
      });
    }

    console.log('✓ Local browser initialized');
  }

  async captureScreenshot(hideSelectors = []) {
    if (!this.page) {
      throw new Error('Browser not initialized - call initialize() first');
    }

    // Hide overlay elements
    if (hideSelectors.length > 0) {
      await this.page.addStyleTag({
        content: hideSelectors.map(selector => `${selector} { visibility: hidden !important; }`).join('\n')
      });
    }

    return await this.page.screenshot({
      type: 'jpeg',
      quality: 90
    });
  }

  supportsChangeDetection() {
    return true;
  }

  async setupChangeDetection(onChangeCallback) {
    if (!this.page) {
      throw new Error('Browser not initialized');
    }

    const changeDetectionConfig = this.config.changeDetection || {};
    if (!changeDetectionConfig.enabled) {
      return;
    }

    // Expose callback to page
    await this.page.exposeFunction('onPageChange', onChangeCallback);

    // Inject change detection script
    await this.page.evaluate(() => {
      const WATCH_SELECTORS = ['img', '[style*="background"]'];
      const WATCH_ATTRIBUTES = ['src', 'style', 'class', 'srcset'];
      const PERIODIC_CHECK_INTERVAL = 120000; // 2 minutes
      const DEBOUNCE_DELAY = 500; // 0.5 seconds

      let lastSnapshot = '';
      let debounceTimer = null;
      let periodicCheckInterval = null;

      function captureSnapshot() {
        const elements = document.querySelectorAll(WATCH_SELECTORS.join(','));
        const limitedElements = Array.from(elements).slice(0, 100);
        const data = limitedElements.map(el => ({
          tag: el.tagName,
          src: el.src || '',
          style: el.getAttribute('style') || '',
          class: el.className || ''
        }));
        const snapshot = JSON.stringify(data);
        return snapshot.length > 102400 ? snapshot.slice(0, 102400) : snapshot;
      }

      function startPeriodicCheck() {
        if (periodicCheckInterval) {
          clearInterval(periodicCheckInterval);
        }

        periodicCheckInterval = setInterval(() => {
          const currentSnapshot = captureSnapshot();
          if (currentSnapshot !== lastSnapshot) {
            console.log('Periodic check detected change');
            triggerChange();
          }
        }, PERIODIC_CHECK_INTERVAL);
      }

      function triggerChange() {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
          const currentSnapshot = captureSnapshot();
          if (currentSnapshot !== lastSnapshot) {
            console.log('Change detected, triggering update');
            lastSnapshot = currentSnapshot;
            window.onPageChange();
            startPeriodicCheck();
          }
          debounceTimer = null;
        }, DEBOUNCE_DELAY);
      }

      lastSnapshot = captureSnapshot();
      console.log('Change detection initialized with debouncing:', DEBOUNCE_DELAY, 'ms');

      const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;

        for (const mutation of mutations) {
          if (mutation.type === 'attributes') {
            const attrName = mutation.attributeName;
            if (WATCH_ATTRIBUTES.includes(attrName)) {
              shouldCheck = true;
              break;
            }
          }
          if (mutation.type === 'childList') {
            shouldCheck = true;
            break;
          }
        }

        if (shouldCheck) {
          triggerChange();
        }
      });

      observer.observe(document.body, {
        attributes: true,
        attributeFilter: WATCH_ATTRIBUTES,
        childList: true,
        subtree: true
      });

      startPeriodicCheck();

      console.log(`Change detection active (periodic check: ${PERIODIC_CHECK_INTERVAL}ms, debounce: ${DEBOUNCE_DELAY}ms)`);
    });
  }

  async cleanup() {
    if (this.page) {
      try {
        await this.page.close();
      } catch (err) {
        console.warn('Error closing page:', err.message);
      }
      this.page = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (err) {
        console.warn('Error closing browser:', err.message);
      }
      this.browser = null;
    }

    // Clean up Chrome profile
    if (this.userDataDir) {
      try {
        await fs.rm(this.userDataDir, { recursive: true, force: true });
        console.log(`Cleaned up Chrome profile: ${this.userDataDir}`);
      } catch (err) {
        console.warn('Error cleaning up Chrome profile:', err.message);
      }
      this.userDataDir = null;
    }
  }

  getUserDataDir() {
    return this.userDataDir;
  }

  getBrowser() {
    return this.browser;
  }

  getPage() {
    return this.page;
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

    console.log(`Fetching screenshot from remote service: ${this.workerUrl}`);

    const response = await fetch(requestUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(browserConfig.remoteTimeout || 60000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Remote screenshot failed: ${response.status} ${response.statusText}\n${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.log(`✓ Remote screenshot received: ${buffer.length} bytes`);

    return buffer;
  }

  supportsChangeDetection() {
    return false;
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

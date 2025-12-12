#!/usr/bin/env node

const puppeteer = require('puppeteer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { loadConfig, getEnabledOverlays } = require('./lib/config');
const { generateOverlay, detectOverlayRegion, hideOverlayElements } = require('./lib/overlays');
const StressMonitor = require('./lib/stress-monitor');
const PerfMonitor = require('./lib/perf-monitor');
const { cleanupChromeTempDirs, checkProfileSize, formatBytes } = require('./lib/cleanup');

// Parse command line arguments
const args = process.argv.slice(2);
const configArg = args.find(arg => arg.startsWith('--config='));
const configPath = configArg ? configArg.split('=')[1] : null;

// Load configuration
const config = loadConfig(configPath);

// Initialize stress monitor
const stressMonitor = new StressMonitor(config.stressManagement || {});

// Initialize performance monitor
const perfMonitor = new PerfMonitor(config.perfMonitoring || {});

console.log('='.repeat(60));
console.log(`web2fb - Web to Framebuffer Renderer`);
if (config.name) console.log(`Configuration: ${config.name}`);
console.log('='.repeat(60));

// Framebuffer state (persistent across browser restarts)
let fbFd = null;
let fbInfo = null;

// Overlay state (persistent)
const overlayStates = new Map(); // name -> {region, style, baseRegionBuffer}

// Base image (persistent)
let baseImageBuffer = null;

// Buffer pool for reducing GC pressure (persistent)
const bufferPool = {
  rgb565: null,
  maxSize: 0
};

// Browser state (recreated on restart)
let browser = null;
let page = null;
let intervals = [];
let userDataDir = null;

// Detect framebuffer properties
function detectFramebuffer() {
  try {
    const fbPath = config.display.framebufferDevice.replace('/dev/', '/sys/class/graphics/');
    const xres = parseInt(fs.readFileSync(`${fbPath}/virtual_size`).toString().split(',')[0]);
    const yres = parseInt(fs.readFileSync(`${fbPath}/virtual_size`).toString().split(',')[1]);
    const bpp = parseInt(fs.readFileSync(`${fbPath}/bits_per_pixel`).toString());

    console.log(`Framebuffer detected: ${xres}x${yres} @ ${bpp}bpp`);

    return {
      width: xres,
      height: yres,
      bpp: bpp,
      bytesPerPixel: bpp / 8,
      stride: xres * (bpp / 8)
    };
  } catch (_err) {
    console.warn('Could not detect framebuffer properties, using config values');
    return {
      width: config.display.width,
      height: config.display.height,
      bpp: 32,
      bytesPerPixel: 4,
      stride: config.display.width * 4
    };
  }
}

// Open framebuffer device
function openFramebuffer() {
  try {
    fbFd = fs.openSync(config.display.framebufferDevice, 'w');
    fbInfo = detectFramebuffer();
    console.log(`Framebuffer opened: ${config.display.framebufferDevice}`);
    return true;
  } catch (err) {
    console.error(`Failed to open framebuffer ${config.display.framebufferDevice}:`, err);
    return false;
  }
}

// Display splash screen
async function displaySplashScreen() {
  if (!config.performance.splashScreen) return false;

  try {
    console.log('Displaying splash screen...');
    const splashBuffer = fs.readFileSync(config.performance.splashScreen);
    await writeToFramebuffer(splashBuffer);
    console.log('Splash screen displayed - starting browser...');
    return true;
  } catch (err) {
    console.warn('Could not display splash screen:', err.message);
    return false;
  }
}

// Write image to framebuffer (full screen)
async function writeToFramebuffer(imageBuffer) {
  const perfOpId = perfMonitor.start('writeToFramebuffer:total');

  try {
    let sharpImage = sharp(imageBuffer, {
      sequentialRead: true,
      limitInputPixels: false
    });

    // Convert to raw buffer based on framebuffer format
    const convOpId = perfMonitor.start('writeToFramebuffer:sharpConvert', { bpp: fbInfo.bpp });
    let rawBuffer;
    if (fbInfo.bpp === 32) {
      rawBuffer = await sharpImage.ensureAlpha().raw().toBuffer();
    } else if (fbInfo.bpp === 24) {
      rawBuffer = await sharpImage.removeAlpha().raw().toBuffer();
    } else if (fbInfo.bpp === 16) {
      const rgbBuffer = await sharpImage.removeAlpha().raw().toBuffer();
      perfMonitor.end(convOpId);
      rawBuffer = convertToRGB565(rgbBuffer);
    } else {
      throw new Error(`Unsupported framebuffer format: ${fbInfo.bpp}bpp`);
    }
    if (fbInfo.bpp !== 16) {
      perfMonitor.end(convOpId);
    }

    // Write to framebuffer device
    const writeOpId = perfMonitor.start('writeToFramebuffer:fbWrite', { bytes: rawBuffer.length });
    fs.writeSync(fbFd, rawBuffer, 0, rawBuffer.length, 0);
    perfMonitor.end(writeOpId);

    perfMonitor.end(perfOpId, { success: true });
    return true;
  } catch (err) {
    console.error('Error writing to framebuffer:', err);
    perfMonitor.end(perfOpId, { success: false, error: err.message });
    return false;
  }
}

// Write partial image to framebuffer at specific region
async function writePartialToFramebuffer(imageBuffer, region) {
  const perfOpId = perfMonitor.start('writePartialToFramebuffer:total', { region });

  try {
    let sharpImage = sharp(imageBuffer, {
      sequentialRead: true,
      limitInputPixels: false
    });

    const metadata = await sharpImage.metadata();

    // Convert to raw buffer
    const convOpId = perfMonitor.start('writePartialToFramebuffer:sharpConvert', { bpp: fbInfo.bpp });
    let rawBuffer;
    if (fbInfo.bpp === 32) {
      rawBuffer = await sharpImage.ensureAlpha().raw().toBuffer();
    } else if (fbInfo.bpp === 24) {
      rawBuffer = await sharpImage.removeAlpha().raw().toBuffer();
    } else if (fbInfo.bpp === 16) {
      const rgbBuffer = await sharpImage.removeAlpha().raw().toBuffer();
      perfMonitor.end(convOpId);
      rawBuffer = convertToRGB565(rgbBuffer);
    } else {
      throw new Error(`Unsupported framebuffer format: ${fbInfo.bpp}bpp`);
    }
    if (fbInfo.bpp !== 16) {
      perfMonitor.end(convOpId);
    }

    // Write line by line to correct framebuffer position
    const regionWidth = metadata.width;
    const regionHeight = metadata.height;
    const bytesPerLine = regionWidth * fbInfo.bytesPerPixel;
    const fbBytesPerLine = fbInfo.width * fbInfo.bytesPerPixel;

    const writeOpId = perfMonitor.start('writePartialToFramebuffer:fbWrite', {
      width: regionWidth,
      height: regionHeight,
      lines: regionHeight
    });
    for (let y = 0; y < regionHeight; y++) {
      const srcOffset = y * bytesPerLine;
      const fbOffset = ((region.y + y) * fbBytesPerLine) + (region.x * fbInfo.bytesPerPixel);
      fs.writeSync(fbFd, rawBuffer, srcOffset, bytesPerLine, fbOffset);
    }
    perfMonitor.end(writeOpId);

    perfMonitor.end(perfOpId, { success: true });
    return true;
  } catch (err) {
    console.error('Error writing partial to framebuffer:', err);
    perfMonitor.end(perfOpId, { success: false, error: err.message });
    return false;
  }
}

// Convert RGB to RGB565 (with buffer pooling)
function convertToRGB565(rgbBuffer) {
  const perfOpId = perfMonitor.start('convertToRGB565', { inputBytes: rgbBuffer.length });

  const requiredSize = (rgbBuffer.length / 3) * 2;

  if (!bufferPool.rgb565 || bufferPool.maxSize < requiredSize) {
    bufferPool.rgb565 = Buffer.allocUnsafe(requiredSize);
    bufferPool.maxSize = requiredSize;
  }

  const rgb565Buffer = bufferPool.rgb565;

  for (let i = 0; i < rgbBuffer.length; i += 3) {
    const r = rgbBuffer[i];
    const g = rgbBuffer[i + 1];
    const b = rgbBuffer[i + 2];

    const r5 = (r >> 3) & 0x1F;
    const g6 = (g >> 2) & 0x3F;
    const b5 = (b >> 3) & 0x1F;

    const rgb565 = (r5 << 11) | (g6 << 5) | b5;

    const offset = (i / 3) * 2;
    rgb565Buffer.writeUInt16LE(rgb565, offset);
  }

  perfMonitor.end(perfOpId, { outputBytes: requiredSize });

  // Return buffer directly if it's exactly the right size, otherwise return subarray view
  // Note: Using subarray (not slice) to avoid creating a new buffer - reuses pooled buffer
  return requiredSize === bufferPool.maxSize ? rgb565Buffer : rgb565Buffer.subarray(0, requiredSize);
}

// Extract and cache base image regions for all overlays
async function cacheBaseRegions() {
  if (!baseImageBuffer || overlayStates.size === 0) {
    return;
  }

  const cacheOpId = perfMonitor.start('overlay:cacheBaseRegions', { count: overlayStates.size });

  for (const [name, state] of overlayStates) {
    try {
      const extractOpId = perfMonitor.start('overlay:extractBaseRegion', {
        name,
        width: state.region.width,
        height: state.region.height
      });

      // Extract and cache the base region for this overlay
      state.baseRegionBuffer = await sharp(baseImageBuffer)
        .extract({
          left: state.region.x,
          top: state.region.y,
          width: state.region.width,
          height: state.region.height
        })
        .png()
        .toBuffer();

      perfMonitor.end(extractOpId, { bufferSize: state.baseRegionBuffer.length });
    } catch (err) {
      console.error(`Error caching base region for overlay '${name}':`, err);
      state.baseRegionBuffer = null;
    }
  }

  perfMonitor.end(cacheOpId);
}

// Update a single overlay
async function updateOverlay(overlay) {
  const perfOpId = perfMonitor.start('overlay:total', { name: overlay.name, type: overlay.type });
  const startTime = Date.now();

  try {
    const state = overlayStates.get(overlay.name);
    if (!state || !state.baseRegionBuffer) {
      perfMonitor.end(perfOpId, { success: false, reason: 'no state or base region' });
      return false;
    }

    const { region } = state;

    // Merge detected style with overlay style
    overlay.style = { ...state.style, ...overlay.style };

    // Generate overlay content
    const genOpId = perfMonitor.start('overlay:generate', { name: overlay.name, type: overlay.type });
    const overlayBuffer = generateOverlay(overlay, region);
    perfMonitor.end(genOpId, { bufferSize: overlayBuffer.length });

    // Composite overlay onto cached base region (no extract needed!)
    const compOpId = perfMonitor.start('overlay:composite', {
      name: overlay.name,
      width: region.width,
      height: region.height
    });
    const compositeImage = await sharp(state.baseRegionBuffer)
      .composite([{ input: overlayBuffer }])
      .png()
      .toBuffer();
    perfMonitor.end(compOpId, { bufferSize: compositeImage.length });

    // Write only the overlay region to framebuffer
    // (writePartialToFramebuffer has its own instrumentation)
    await writePartialToFramebuffer(compositeImage, region);

    const duration = Date.now() - startTime;
    stressMonitor.recordOperation('overlay', duration, true);
    perfMonitor.end(perfOpId, { success: true });

    return true;
  } catch (err) {
    console.error(`Error updating overlay '${overlay.name}':`, err);
    const duration = Date.now() - startTime;
    stressMonitor.recordOperation('overlay', duration, false);
    perfMonitor.end(perfOpId, { success: false, error: err.message });
    return false;
  }
}

// Update all overlays
async function updateAllOverlays() {
  const enabledOverlays = getEnabledOverlays(config);
  for (const overlay of enabledOverlays) {
    await updateOverlay(overlay);
  }
}

// Restart browser in-process
async function restartBrowser(reason) {
  console.log('\n' + '='.repeat(60));
  console.log(`🔄 Restarting browser in-process (${reason})`);
  console.log('='.repeat(60));

  // Enter recovery mode
  stressMonitor.enterRecoveryMode();

  try {
    // Clear all intervals
    console.log(`Clearing ${intervals.length} interval(s)...`);
    intervals.forEach(id => clearInterval(id));
    intervals = [];

    // Close browser
    if (browser) {
      console.log('Closing browser...');
      await browser.close().catch(err => console.warn('Browser close warning:', err.message));
      browser = null;
      page = null;
    }

    // Clean up Chrome profile
    if (userDataDir) {
      console.log('Cleaning up Chrome profile...');
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        console.log(`✓ Cleaned up Chrome profile`);
      } catch (err) {
        console.warn('Warning: Could not remove Chrome profile:', err.message);
      }
    }

    // Wait for cooldown
    const cooldown = stressMonitor.config.recovery.cooldownPeriod;
    console.log(`Waiting ${cooldown}ms for system recovery...`);
    await new Promise(resolve => setTimeout(resolve, cooldown));

    // Exit recovery mode
    stressMonitor.exitRecoveryMode();

    console.log('✓ Recovery complete, re-launching browser...\n');

    // Re-initialize browser and page
    await initializeBrowserAndRun();

  } catch (err) {
    console.error('Fatal error during browser restart:', err);
    process.exit(1);
  }
}

// Initialize browser and start main loop
async function initializeBrowserAndRun() {
  // Cleanup old Chrome temporary directories
  console.log('Cleaning up old Chrome profiles...');
  const cleanupStats = cleanupChromeTempDirs({
    maxAge: 60 * 60 * 1000, // 1 hour
    minSize: 1024 * 1024    // 1 MB
  });

  if (cleanupStats.removed > 0) {
    console.log(`✓ Removed ${cleanupStats.removed} old Chrome profile(s), freed ${formatBytes(cleanupStats.freedSpace)}`);
  } else {
    console.log('✓ No old Chrome profiles to clean up');
  }

  // Build browser args
  const browserArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-dev-shm-usage',
    '--disable-gpu',
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
    '--no-default-browser-check',
    '--no-first-run',
    '--no-pings',
    '--no-zygote',
    '--single-process',
    // Aggressive cache control for RAM-constrained devices
    '--disk-cache-size=1',              // Minimal disk cache (1 byte)
    '--media-cache-size=1',             // Minimal media cache
    '--disable-application-cache',      // No HTML5 app cache
    '--disable-offline-load-stale-cache',
    '--disable-back-forward-cache',
    '--aggressive-cache-discard'
  ];

  // Set user data directory in /tmp/web2fb
  userDataDir = path.join('/tmp', 'web2fb-chrome-profile');

  const launchOptions = {
    headless: 'new',
    args: browserArgs,
    userDataDir: userDataDir
  };

  if (config.browser.executablePath) {
    launchOptions.executablePath = config.browser.executablePath;
  }

  console.log('Launching browser...');
  const launchOpId = perfMonitor.start('browser:launch');
  browser = await puppeteer.launch(launchOptions);
  page = await browser.newPage();
  perfMonitor.end(launchOpId);
  perfMonitor.sampleMemory('after-browser-launch');

  // Set user agent if configured
  if (config.browser.userAgent) {
    await page.setUserAgent(config.browser.userAgent);
  }

  // Remove webdriver flag
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  // Set viewport to match framebuffer
  console.log(`Setting viewport: ${fbInfo.width}x${fbInfo.height}`);
  await page.setViewport({
    width: fbInfo.width,
    height: fbInfo.height,
    deviceScaleFactor: 1,
  });

  // Load page
  console.log(`Loading page: ${config.display.url}`);
  const gotoOpId = perfMonitor.start('browser:pageLoad', { url: config.display.url });
  await page.goto(config.display.url, {
    waitUntil: 'load',
    timeout: config.browser.timeout
  });
  perfMonitor.end(gotoOpId);
  perfMonitor.sampleMemory('after-page-load');

  // Scroll to load lazy images
  if (config.performance.scrollToLoadLazy) {
    console.log('Scrolling to trigger lazy loading...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  // Wait for images
  if (config.performance.waitForImages) {
    console.log('Waiting for images to load...');
    const waitImagesOpId = perfMonitor.start('browser:waitForImages');
    await page.waitForFunction(() => {
      const images = Array.from(document.images);
      return images.every(img => img.complete && img.naturalHeight !== 0);
    }, { timeout: config.browser.imageLoadTimeout });
    perfMonitor.end(waitImagesOpId);
    perfMonitor.sampleMemory('after-images-loaded');
    console.log('All images loaded');
  }

  // Disable animations
  if (config.browser.disableAnimations) {
    console.log('Disabling CSS animations...');
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
  }

  // Wait for rendering
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Detect and configure overlays
  const enabledOverlays = getEnabledOverlays(config);
  if (enabledOverlays.length > 0) {
    console.log(`Detecting ${enabledOverlays.length} overlay(s)...`);

    // Clear existing overlay states on restart
    overlayStates.clear();

    for (const overlay of enabledOverlays) {
      const detected = await detectOverlayRegion(page, overlay);
      if (detected) {
        overlayStates.set(overlay.name, detected);
        console.log(`✓ Overlay '${overlay.name}' detected at (${detected.region.x}, ${detected.region.y}), size: ${detected.region.width}x${detected.region.height}`);
      } else {
        console.warn(`✗ Overlay '${overlay.name}' not found (selector: ${overlay.selector})`);
      }
    }

    // Hide overlay elements
    const detectedOverlays = enabledOverlays.filter(o => overlayStates.has(o.name));
    if (detectedOverlays.length > 0) {
      await hideOverlayElements(page, detectedOverlays);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Capture base image
  console.log('Capturing base image...');
  const screenshotOpId = perfMonitor.start('browser:screenshot');
  baseImageBuffer = await page.screenshot({
    type: 'jpeg',
    quality: 90
  });
  perfMonitor.end(screenshotOpId, { bufferSize: baseImageBuffer.length });
  perfMonitor.sampleMemory('after-base-screenshot');
  console.log('Base image captured');

  // Write base image to framebuffer
  console.log('Writing base image to framebuffer...');
  await writeToFramebuffer(baseImageBuffer);

  // Cache base regions for overlays
  if (overlayStates.size > 0) {
    console.log('Caching base regions for overlays...');
    await cacheBaseRegions();
  }

  // Initial overlay render
  if (overlayStates.size > 0) {
    console.log('Rendering initial overlays...');
    await updateAllOverlays();
    console.log('Overlays displayed');
  }

  // Re-capture base image when page changes
  const recaptureBaseImage = async (reason) => {
    // Check if stress monitor allows this operation
    if (!stressMonitor.shouldAllowBaseImageRecapture()) {
      return;
    }

    stressMonitor.startBaseImageOperation();
    const perfOpId = perfMonitor.start('baseImage:recapture', { reason });
    const startTime = Date.now();

    try {
      console.log(`Re-capturing base image (${reason})...`);

      const screenshotOpId = perfMonitor.start('baseImage:screenshot');
      baseImageBuffer = await page.screenshot({
        type: 'jpeg',
        quality: 90
      });
      perfMonitor.end(screenshotOpId, { bufferSize: baseImageBuffer.length });

      await writeToFramebuffer(baseImageBuffer);

      // Re-cache base regions for overlays
      await cacheBaseRegions();

      await updateAllOverlays();

      const duration = Date.now() - startTime;
      console.log(`Base image updated in ${duration}ms`);
      stressMonitor.recordOperation('baseImage', duration, true);
      perfMonitor.end(perfOpId, { success: true });
    } catch (err) {
      const duration = Date.now() - startTime;
      console.error(`Error recapturing base image:`, err);
      stressMonitor.recordOperation('baseImage', duration, false);
      perfMonitor.end(perfOpId, { success: false, error: err.message });
    } finally {
      stressMonitor.endBaseImageOperation();
    }
  };

  // Set up change detection
  if (config.changeDetection.enabled) {
    await page.exposeFunction('onPageChange', async () => {
      // Guard: check if change detection is allowed under current stress
      if (!stressMonitor.shouldAllowChangeDetection()) {
        return;
      }

      stressMonitor.startChangeDetection();
      try {
        console.log('Page change detected');
        await recaptureBaseImage('page changed');
      } finally {
        stressMonitor.endChangeDetection();
      }
    });

    await page.evaluate((changeDetectionConfig) => {
      let lastSnapshot = '';
      let debounceTimer = null;
      let periodicCheckInterval = null;

      function captureSnapshot() {
        const elements = document.querySelectorAll(changeDetectionConfig.watchSelectors.join(','));
        // Limit to first 100 elements to prevent unbounded memory growth
        const limitedElements = Array.from(elements).slice(0, 100);
        const data = limitedElements.map(el => ({
          tag: el.tagName,
          src: el.src || '',
          style: el.getAttribute('style') || '',
          class: el.className || ''
        }));
        const snapshot = JSON.stringify(data);
        // Truncate if snapshot exceeds 100KB
        return snapshot.length > 102400 ? snapshot.slice(0, 102400) : snapshot;
      }

      function startPeriodicCheck() {
        // Clear existing interval if any
        if (periodicCheckInterval) {
          clearInterval(periodicCheckInterval);
        }

        // Start new interval
        periodicCheckInterval = setInterval(() => {
          const currentSnapshot = captureSnapshot();
          if (currentSnapshot !== lastSnapshot) {
            console.log('Periodic check detected change');
            triggerChange();
          }
        }, changeDetectionConfig.periodicCheckInterval);
      }

      function triggerChange() {
        // Debounce change notifications
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
          const currentSnapshot = captureSnapshot();
          if (currentSnapshot !== lastSnapshot) {
            console.log('Change detected, triggering update');
            lastSnapshot = currentSnapshot;
            window.onPageChange();

            // Reset periodic check timer since we just updated
            startPeriodicCheck();
          }
          debounceTimer = null;
        }, changeDetectionConfig.debounceDelay || 500);
      }

      lastSnapshot = captureSnapshot();
      console.log('Change detection initialized with debouncing:', changeDetectionConfig.debounceDelay || 500, 'ms');

      const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;

        for (const mutation of mutations) {
          if (mutation.type === 'attributes') {
            const attrName = mutation.attributeName;
            if (changeDetectionConfig.watchAttributes.includes(attrName)) {
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
        attributeFilter: changeDetectionConfig.watchAttributes,
        childList: true,
        subtree: true
      });

      // Start periodic check
      startPeriodicCheck();

      console.log(`Change detection active (periodic check: ${changeDetectionConfig.periodicCheckInterval}ms, debounce: ${changeDetectionConfig.debounceDelay || 500}ms)`);
    }, config.changeDetection);
  }

  // Track in-progress updates per overlay (drop-frame behavior)
  const overlayUpdateInProgress = new Map();

  // Start overlay update loops
  if (overlayStates.size > 0) {
    for (const overlay of enabledOverlays) {
      if (!overlayStates.has(overlay.name)) continue;

      const updateInterval = overlay.updateInterval || 1000;

      console.log(`Starting overlay '${overlay.name}' update loop (${updateInterval}ms)`);

      // Initialize in-progress flag for this overlay
      overlayUpdateInProgress.set(overlay.name, false);

      const intervalId = setInterval(async () => {
        // Drop-frame: skip if previous update still in progress
        if (overlayUpdateInProgress.get(overlay.name)) {
          console.log(`⏭️  Dropping frame for overlay '${overlay.name}' - previous update still in progress`);
          return;
        }

        overlayUpdateInProgress.set(overlay.name, true);
        try {
          await updateOverlay(overlay);
        } finally {
          overlayUpdateInProgress.set(overlay.name, false);
        }
      }, updateInterval);

      intervals.push(intervalId);
    }
  }

  // Recovery monitoring - check for severe stress and profile size
  let recoveryCheckInProgress = false; // Drop-frame behavior for recovery checks
  if (stressMonitor.config.enabled) {
    const recoveryCheckInterval = stressMonitor.config.recovery.recoveryCheckInterval;
    const profileSizeThresholdMB = stressMonitor.config.recovery.profileSizeThresholdMB || 40;
    const profileSizeThreshold = profileSizeThresholdMB * 1024 * 1024;
    console.log(`Stress monitoring enabled (recovery check: ${recoveryCheckInterval}ms)`);
    console.log(`Profile size monitoring: ${formatBytes(profileSizeThreshold)} threshold`);

    const recoveryIntervalId = setInterval(async () => {
      // Drop-frame: skip if previous check still in progress
      if (recoveryCheckInProgress) {
        console.log('⏭️  Dropping recovery check - previous check still in progress');
        return;
      }

      recoveryCheckInProgress = true;
      try {
        // Check profile size
        const profileCheck = checkProfileSize(userDataDir, profileSizeThreshold);

        if (profileCheck.exceeds) {
          console.error('\n' + '!'.repeat(60));
          console.error('🚨 CRITICAL: Chrome profile too large');
          console.error(`Profile size: ${profileCheck.sizeFormatted} (threshold: ${profileCheck.thresholdFormatted})`);
          console.error('Large profile in tmpfs consumes RAM on Pi!');
          console.error('!'.repeat(60));

          // Restart browser in-process
          await restartBrowser('profile too large');
          return;
        }

        // Check stress level
        if (stressMonitor.needsBrowserRestart()) {
          console.error('\n' + '!'.repeat(60));
          console.error('🚨 CRITICAL: System under severe stress');
          console.error('!'.repeat(60));

          // Restart browser in-process
          await restartBrowser('severe stress');
          return;
        }
      } finally {
        recoveryCheckInProgress = false;
      }
    }, recoveryCheckInterval);

    intervals.push(recoveryIntervalId);
  }

  // Set up periodic performance reporting if configured
  if (perfMonitor.config.enabled && perfMonitor.config.reportInterval > 0) {
    console.log(`Performance reporting enabled (interval: ${perfMonitor.config.reportInterval}ms)`);
    const reportIntervalId = setInterval(() => {
      console.log('\n[DEBUG] Performance report interval triggered');
      perfMonitor.sampleMemory('periodic-sample');
      perfMonitor.printReport();
      console.log('[DEBUG] Performance report complete\n');
    }, perfMonitor.config.reportInterval);
    intervals.push(reportIntervalId);
  }

  console.log('='.repeat(60));
  console.log('web2fb is running. Press Ctrl+C to stop.');
  if (stressMonitor.config.enabled) {
    console.log('Stress monitoring: ENABLED');
    console.log(`  - Overlay update critical threshold: ${stressMonitor.config.thresholds.overlayUpdateCritical}ms`);
    console.log(`  - Base image critical threshold: ${stressMonitor.config.thresholds.baseImageCritical}ms`);
    console.log(`  - Browser restart after ${stressMonitor.config.recovery.killBrowserThreshold} critical events`);
    console.log(`  - Critical events decay on successful operations`);
  }
  if (perfMonitor.config.enabled) {
    console.log('Performance monitoring: ENABLED');
    if (perfMonitor.config.verbose) console.log('  - Verbose logging: ON');
    if (perfMonitor.config.logToFile) console.log(`  - Logging to file: ${perfMonitor.config.logToFile}`);
  }
  console.log('='.repeat(60));
}

// Main entry point
(async () => {
  // Open framebuffer (only once, persists across browser restarts)
  if (!openFramebuffer()) {
    console.error('Failed to initialize framebuffer');
    process.exit(1);
  }

  // Display splash screen (only on first startup)
  await displaySplashScreen();

  // Initialize browser and start main loop
  await initializeBrowserAndRun();

  // Cleanup on exit
  const shutdown = () => {
    console.log('\nShutting down...');

    // Clear all intervals
    console.log(`Clearing ${intervals.length} interval(s)...`);
    intervals.forEach(id => clearInterval(id));

    // Print final performance report if enabled
    if (perfMonitor.config.enabled) {
      perfMonitor.sampleMemory('shutdown');
      perfMonitor.printReport();
      perfMonitor.close();
    }

    if (fbFd) {
      fs.closeSync(fbFd);
    }

    if (browser) {
      browser.close();
    }

    // Clean up Chrome profile
    if (userDataDir) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        console.log('✓ Cleaned up Chrome profile');
      } catch (_err) {
        // Ignore cleanup errors on exit
      }
    }

    process.exit(0);
  };

  process.on('SIGINT', shutdown);   // Ctrl+C
  process.on('SIGTERM', shutdown);  // systemctl stop
})();

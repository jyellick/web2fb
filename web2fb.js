#!/usr/bin/env node

const puppeteer = require('puppeteer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadConfig, getEnabledOverlays } = require('./lib/config');
const { generateOverlay, detectOverlayRegion, hideOverlayElements } = require('./lib/overlays');
const StressMonitor = require('./lib/stress-monitor');
const PerfMonitor = require('./lib/perf-monitor');
const ClockCache = require('./lib/clock-cache');
const { cleanupChromeTempDirs, checkProfileSize, formatBytes } = require('./lib/cleanup');

/**
 * Fetch screenshot from remote service (Cloudflare Worker)
 * @param {string} url - Target URL to screenshot
 * @param {object} options - Screenshot options
 * @returns {Promise<Buffer>} - Screenshot buffer
 */
async function fetchRemoteScreenshot(url, options = {}) {
  const {
    workerUrl,
    apiKey,
    width = 1920,
    height = 1080,
    userAgent,
    timeout = 60000,
    waitForImages = true,
    waitForSelector = null
  } = options;

  if (!workerUrl) {
    throw new Error('Remote screenshot URL not configured');
  }

  // Build query parameters
  const params = new URLSearchParams({
    url: url,
    width: width.toString(),
    height: height.toString(),
    timeout: timeout.toString(),
    waitForImages: waitForImages.toString()
  });

  if (userAgent) {
    params.set('userAgent', userAgent);
  }

  if (waitForSelector) {
    params.set('waitForSelector', waitForSelector);
  }

  const requestUrl = `${workerUrl}?${params.toString()}`;

  const headers = {
    'Accept': 'image/png'
  };

  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  console.log(`Fetching screenshot from remote service: ${workerUrl}`);

  const response = await fetch(requestUrl, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeout)
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

/**
 * Capture screenshot using configured mode (local or remote)
 * @param {object} page - Puppeteer page instance (may be null in remote mode)
 * @param {object} config - Configuration object
 * @returns {Promise<Buffer>} - Screenshot buffer
 */
async function captureScreenshot(page, config) {
  const browserConfig = config.browser || {};
  const mode = browserConfig.mode || 'local';

  if (mode === 'remote') {
    try {
      // Use remote screenshot service
      const screenshotBuffer = await fetchRemoteScreenshot(config.display.url, {
        workerUrl: browserConfig.remoteScreenshotUrl,
        apiKey: browserConfig.remoteApiKey,
        width: config.display.width || 1920,
        height: config.display.height || 1080,
        userAgent: browserConfig.userAgent,
        timeout: browserConfig.remoteTimeout || 60000,
        waitForImages: config.performance?.waitForImages !== false
      });

      return screenshotBuffer;
    } catch (error) {
      console.error(`Remote screenshot failed: ${error.message}`);

      // Fall back to local if configured
      if (browserConfig.fallbackToLocal && page) {
        console.log('Falling back to local browser screenshot...');
        return await page.screenshot({
          type: 'jpeg',
          quality: 90
        });
      }

      throw error;
    }
  }

  // Local mode - use Puppeteer
  if (!page) {
    throw new Error('Local browser mode requires a page instance');
  }

  return await page.screenshot({
    type: 'jpeg',
    quality: 90
  });
}

// Get current git commit hash
function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
  } catch (err) {
    return 'unknown';
  }
}

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

const gitCommit = getGitCommit();

console.log('='.repeat(60));
console.log(`web2fb - Web to Framebuffer Renderer (${gitCommit})`);
if (config.name) console.log(`Configuration: ${config.name}`);
console.log('='.repeat(60));

// Framebuffer state (persistent across browser restarts)
let fbFd = null;
let fbInfo = null;

// Overlay state (persistent)
const overlayStates = new Map(); // name -> {region, style, baseRegionBuffer}

// Clock cache (persistent) - pre-rendered clock frames
const clockCaches = new Map(); // name -> ClockCache instance

// Base image (persistent)
let baseImageBuffer = null;

/**
 * Page change transition state - enables smooth transitions without freezing the clock
 *
 * When a page change is detected, we don't immediately replace the current base image.
 * Instead, we prepare the new base in the background while the old cache continues
 * serving frames. When the cache is about to run out, we perform an atomic swap.
 *
 * Flow:
 * 1. Page change detected at T+3 (old cache has frames T+3→T+13)
 * 2. recaptureBaseImage() prepares new base without disrupting current state:
 *    - Screenshots new page
 *    - Extracts new overlay regions
 *    - Calculates switch time based on cache.windowEnd + 1 (e.g., T+22)
 *    - Pre-renders new cache starting at switch time (T+22→T+32)
 *    - Stores everything in pendingBaseTransition
 * 3. Meanwhile, old cache continues extending (T+14→T+21) via normal updateOverlay loop
 * 4. At T+22, updateOverlay() performs atomic swap:
 *    - Replace baseImageBuffer, overlayStates, clockCaches
 *    - Write full composited image to framebuffer
 *    - Clear pendingBaseTransition
 * 5. Clock never stops updating throughout the entire transition
 *
 * Structure: { baseBuffer, overlayStates, switchTime, switchSecond, newCaches }
 */
let pendingBaseTransition = null;

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

// Convert image buffer to framebuffer format
async function convertImageToFramebufferFormat(imageBuffer, operationName = 'convert') {
  const sharpImage = sharp(imageBuffer, {
    sequentialRead: true,
    limitInputPixels: false
  });

  const convOpId = perfMonitor.start(`${operationName}:sharpConvert`, { bpp: fbInfo.bpp });
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

  return { rawBuffer, sharpImage };
}

// Write image to framebuffer (full screen)
async function writeToFramebuffer(imageBuffer) {
  const perfOpId = perfMonitor.start('writeToFramebuffer:total');

  try {
    // Convert to raw buffer based on framebuffer format
    const { rawBuffer } = await convertImageToFramebufferFormat(imageBuffer, 'writeToFramebuffer');

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
    // Convert to raw buffer
    const { rawBuffer, sharpImage } = await convertImageToFramebufferFormat(imageBuffer, 'writePartialToFramebuffer');
    const metadata = await sharpImage.metadata();

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
// Also pre-render clock frames if applicable
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

// Pre-render clock frames for all clock overlays
async function preRenderClockFrames() {
  const enabledOverlays = getEnabledOverlays(config);
  const clockOverlays = enabledOverlays.filter(o => o.type === 'clock');

  if (clockOverlays.length === 0) {
    return;
  }

  const preRenderOpId = perfMonitor.start('clock:preRenderAll', { count: clockOverlays.length });

  for (const overlay of clockOverlays) {
    const state = overlayStates.get(overlay.name);
    if (!state || !state.baseRegionBuffer) {
      continue;
    }

    try {
      // Create or update clock cache
      let cache = clockCaches.get(overlay.name);
      if (!cache) {
        // Pass detected style so pre-rendered frames match live appearance
        cache = new ClockCache(overlay, state.baseRegionBuffer, state.region, state.style);
        clockCaches.set(overlay.name, cache);
      } else {
        cache.updateBaseRegion(state.baseRegionBuffer);
        // Update detected style in case it changed
        cache.detectedStyle = state.style;
      }

      // Pre-render initial frames
      const renderOpId = perfMonitor.start('clock:preRender', { name: overlay.name });
      await cache.preRender();
      perfMonitor.end(renderOpId, { frames: cache.windowSize });

      console.log(`✓ Pre-rendered ${cache.windowSize} frames for clock '${overlay.name}'`);
    } catch (err) {
      console.error(`Error pre-rendering clock '${overlay.name}':`, err);
    }
  }

  perfMonitor.end(preRenderOpId);
}

// Composite all overlays onto base image and return the result
async function compositeOverlaysOntoBase(baseBuffer) {
  const enabledOverlays = getEnabledOverlays(config);
  if (enabledOverlays.length === 0) {
    return baseBuffer;
  }

  let currentImage = sharp(baseBuffer);
  const composites = [];

  for (const overlay of enabledOverlays) {
    const state = overlayStates.get(overlay.name);
    if (!state || !state.baseRegionBuffer) continue;

    const { region } = state;

    // Merge detected style with overlay style
    const mergedOverlay = {
      ...overlay,
      style: { ...state.style, ...overlay.style }
    };

    let overlayImage;

    // For clock overlays, use pre-rendered frame if available
    if (overlay.type === 'clock') {
      const cache = clockCaches.get(overlay.name);
      if (cache && cache.isValid()) {
        const cachedFrame = cache.getFrame();
        if (cachedFrame) {
          // Convert raw buffer to PNG for compositing
          overlayImage = await sharp(cachedFrame.buffer, {
            raw: {
              width: cachedFrame.width,
              height: cachedFrame.height,
              channels: cachedFrame.channels
            }
          })
            .png()
            .toBuffer();
        }
      }
    }

    // Fallback: generate overlay on-the-fly
    if (!overlayImage) {
      const overlayBuffer = generateOverlay(mergedOverlay, region);
      overlayImage = overlayBuffer;
    }

    // Add to composite list with position
    composites.push({
      input: overlayImage,
      top: region.y,
      left: region.x
    });
  }

  // Composite all overlays onto base image
  if (composites.length > 0) {
    currentImage = currentImage.composite(composites);
  }

  return await currentImage.png().toBuffer();
}

// Update a single overlay
async function updateOverlay(overlay) {
  const perfOpId = perfMonitor.start('overlay:total', { name: overlay.name, type: overlay.type });
  const startTime = Date.now();

  try {
    // Check if it's time to switch to new base (smooth transition)
    if (pendingBaseTransition) {
      const currentSecond = Math.floor(Date.now() / 1000);
      if (currentSecond >= pendingBaseTransition.switchSecond) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔄 SWITCHING TO NEW BASE at ${new Date().toLocaleTimeString()}`);
        console.log(`${'='.repeat(60)}`);

        // Atomic swap
        baseImageBuffer = pendingBaseTransition.baseBuffer;
        overlayStates.clear();
        for (const [name, state] of pendingBaseTransition.overlayStates) {
          overlayStates.set(name, state);
        }

        // Replace clock caches with new ones
        if (pendingBaseTransition.newCaches) {
          clockCaches.clear();
          for (const [name, cache] of pendingBaseTransition.newCaches) {
            clockCaches.set(name, cache);
          }
        }

        // Write full composited image to framebuffer
        const compositedImage = await compositeOverlaysOntoBase(baseImageBuffer);
        await writeToFramebuffer(compositedImage);

        console.log('✓ Transition complete - now using new base + new frames');
        console.log(`${'='.repeat(60)}\n`);

        // Clear pending transition
        pendingBaseTransition = null;
      }
    }

    const state = overlayStates.get(overlay.name);
    if (!state || !state.baseRegionBuffer) {
      perfMonitor.end(perfOpId, { success: false, reason: 'no state or base region' });
      return false;
    }

    const { region } = state;

    // Merge detected style with overlay style
    overlay.style = { ...state.style, ...overlay.style };

    let compositeImage;

    // For clock overlays, use pre-rendered frames if available
    if (overlay.type === 'clock') {
      const cache = clockCaches.get(overlay.name);
      if (cache) {
        // Check if we need more frames - generate 1 at a time to avoid blocking
        if (cache.needsMoreFrames()) {
          const extendOpId = perfMonitor.start('clock:extendWindow', { name: overlay.name });
          await cache.extendWindow(); // Generate 1 frame (default)
          perfMonitor.end(extendOpId, { frames: 1 });
        }

        if (cache.isValid()) {
          // Use pre-rendered frame - no generation or compositing needed!
          const fetchOpId = perfMonitor.start('clock:fetchFrame', { name: overlay.name });
          const cachedFrame = cache.getFrame();
          if (cachedFrame) {
            // Convert raw buffer to PNG for framebuffer write
            compositeImage = await sharp(cachedFrame.buffer, {
              raw: {
                width: cachedFrame.width,
                height: cachedFrame.height,
                channels: cachedFrame.channels
              }
            })
              .png()
              .toBuffer();
          }
          perfMonitor.end(fetchOpId);
        }
      }
    }

    // Fallback: generate and composite on-the-fly (for non-clock or cache miss)
    if (!compositeImage) {
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
      compositeImage = await sharp(state.baseRegionBuffer)
        .composite([{ input: overlayBuffer }])
        .png()
        .toBuffer();
      perfMonitor.end(compOpId, { bufferSize: compositeImage.length });
    }

    // Write only the overlay region to framebuffer
    // (writePartialToFramebuffer has its own instrumentation)
    await writePartialToFramebuffer(compositeImage, region);

    const duration = Date.now() - startTime;
    stressMonitor.recordOperation('overlay', duration, true);
    perfMonitor.end(perfOpId, { success: true, preRendered: overlay.type === 'clock' });

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
// Launch browser and create page
async function launchBrowser() {
  const browserConfig = config.browser || {};
  const mode = browserConfig.mode || 'local';

  // Skip browser launch in remote mode (unless fallback is enabled)
  if (mode === 'remote' && !browserConfig.fallbackToLocal) {
    console.log('Using remote screenshot service - skipping local browser launch');
    browser = null;
    page = null;
    return;
  }

  if (mode === 'remote' && browserConfig.fallbackToLocal) {
    console.log('Remote mode with local fallback - launching browser for fallback capability...');
  }

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

  // Set browser process to lower priority (nice) to prioritize clock updates
  // This ensures overlay updates aren't delayed by browser rendering
  try {
    const browserProcess = browser.process();
    if (browserProcess && browserProcess.pid) {
      const { execSync } = require('child_process');
      // Set nice value to 10 (lower priority than default 0)
      // Higher values = lower priority (range: -20 to 19)
      execSync(`renice -n 10 -p ${browserProcess.pid}`, { stdio: 'ignore' });
      console.log(`✓ Set browser process (PID ${browserProcess.pid}) to nice priority 10`);
    }
  } catch (err) {
    console.warn(`Warning: Could not set browser process priority: ${err.message}`);
    // Non-fatal - continue anyway
  }

  // Set up browser crash detection
  browser.on('disconnected', () => {
    console.error('\n' + '!'.repeat(60));
    console.error('🚨 CRITICAL: Browser process disconnected/crashed');
    console.error('Framebuffer will freeze unless browser is restarted');
    console.error('!'.repeat(60));

    // Trigger restart via the recovery mechanism
    // Set a flag to trigger restart on next recovery check
    if (!browser || !page) {
      console.error('Browser already null, scheduling restart...');
      // Schedule restart after a brief delay
      setTimeout(async () => {
        try {
          await restartBrowser('browser disconnected');
        } catch (err) {
          console.error('Failed to restart browser after disconnect:', err);
          console.error('Manual intervention may be required');
        }
      }, 5000); // 5 second delay to avoid rapid restart loops
    }
  });

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
}

// Detect and configure overlays
async function detectAndConfigureOverlays() {
  const enabledOverlays = getEnabledOverlays(config);
  if (enabledOverlays.length === 0) {
    return enabledOverlays;
  }

  // Overlays require a browser page for detection
  if (!page) {
    console.warn('⚠️  Overlays are configured but browser is not available (remote mode without fallback)');
    console.warn('⚠️  Overlays will be skipped. To use overlays, set browser.fallbackToLocal = true');
    return [];
  }

  console.log(`Detecting ${enabledOverlays.length} overlay(s)...`);

  // Clear existing overlay states on restart
  overlayStates.clear();

  const detectAllOpId = perfMonitor.start('overlay:detectAll', { count: enabledOverlays.length });
  for (const overlay of enabledOverlays) {
    const detectOpId = perfMonitor.start('overlay:detectRegion', { name: overlay.name, selector: overlay.selector });
    const detected = await detectOverlayRegion(page, overlay);
    perfMonitor.end(detectOpId, { found: !!detected });

    if (detected) {
      overlayStates.set(overlay.name, detected);
      console.log(`✓ Overlay '${overlay.name}' detected at (${detected.region.x}, ${detected.region.y}), size: ${detected.region.width}x${detected.region.height}`);
    } else {
      console.warn(`✗ Overlay '${overlay.name}' not found (selector: ${overlay.selector})`);
    }
  }
  perfMonitor.end(detectAllOpId, { detected: overlayStates.size });

  // Hide overlay elements
  const detectedOverlays = enabledOverlays.filter(o => overlayStates.has(o.name));
  if (detectedOverlays.length > 0) {
    const hideOpId = perfMonitor.start('overlay:hideElements', { count: detectedOverlays.length });
    await hideOverlayElements(page, detectedOverlays);
    perfMonitor.end(hideOpId);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return enabledOverlays;
}

async function initializeBrowserAndRun() {
  await launchBrowser();

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
  const enabledOverlays = await detectAndConfigureOverlays();

  // Capture base image
  console.log('Capturing base image...');
  const screenshotOpId = perfMonitor.start('browser:screenshot');
  baseImageBuffer = await captureScreenshot(page, config);
  perfMonitor.end(screenshotOpId, { bufferSize: baseImageBuffer.length });
  perfMonitor.sampleMemory('after-base-screenshot');
  console.log('Base image captured');

  // Cache base regions for overlays
  if (overlayStates.size > 0) {
    console.log('Caching base regions for overlays...');
    await cacheBaseRegions();
  }

  /**
   * Startup transition from splash screen to calendar
   *
   * Similar to page change transitions, we prepare everything while the splash
   * screen remains visible, then smoothly transition to the calendar.
   *
   * Flow:
   * 1. Splash screen is already visible (displayed before browser launch)
   * 2. Browser launched, page loaded, overlays detected (background preparation)
   * 3. Pre-render clock frames to populate cache
   * 4. Brief pause to allow cache to grow via background extension
   * 5. Composite overlays onto base and write to framebuffer
   * 6. Start update intervals (cache continues extending automatically)
   *
   * Result: Smooth transition from splash to calendar with cache already populated
   */
  console.log('\n' + '='.repeat(60));
  console.log('🎨 Preparing calendar display (splash screen visible)...');
  console.log('='.repeat(60));

  // Pre-render clock frames while splash screen is visible
  // This populates the cache with 10 frames (default windowSize) before displaying
  console.log('Pre-rendering clock frames...');
  await preRenderClockFrames();
  perfMonitor.sampleMemory('after-clock-prerender');
  console.log('✓ Cache populated, ready to display');

  // Composite initial overlays onto base image
  console.log('Compositing overlays onto base image...');
  const compositedImage = await compositeOverlaysOntoBase(baseImageBuffer);

  // Smooth transition: write composited image to framebuffer
  console.log('\n' + '='.repeat(60));
  console.log('🔄 TRANSITIONING FROM SPLASH TO CALENDAR');
  console.log('='.repeat(60));
  await writeToFramebuffer(compositedImage);
  perfMonitor.sampleMemory('after-initial-overlays');
  console.log('✓ Calendar displayed with pre-populated cache');
  console.log('='.repeat(60) + '\n');

  /**
   * Re-capture base image when page changes (smooth transition)
   *
   * This function prepares a new base image in the background WITHOUT disrupting
   * the currently running clock overlays. The old cache continues serving frames
   * while we prepare the new base.
   *
   * Key principle: Clock never stops during page changes
   *
   * @param {string} reason - Why the recapture was triggered (for logging)
   */
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
      console.log('Old cache continues serving frames during preparation...');

      // Screenshot new page
      const screenshotOpId = perfMonitor.start('baseImage:screenshot');
      const newBaseImageBuffer = await captureScreenshot(page, config);
      perfMonitor.end(screenshotOpId, { bufferSize: newBaseImageBuffer.length });

      // Extract new base regions (but don't replace current ones yet)
      const newOverlayStates = new Map();
      const enabledOverlays = getEnabledOverlays(config);

      for (const overlay of enabledOverlays) {
        if (!overlay.selector) continue;

        const state = await detectOverlayRegion(page, overlay);
        if (state) {
          // Extract base region from new screenshot
          const baseRegionBuffer = await sharp(newBaseImageBuffer)
            .extract({
              left: state.region.x,
              top: state.region.y,
              width: state.region.width,
              height: state.region.height
            })
            .png()
            .toBuffer();

          newOverlayStates.set(overlay.name, {
            ...state,
            baseRegionBuffer
          });
        }
      }

      // Calculate switch time: when current cache will run out
      const currentTime = Date.now();
      const currentSecond = Math.floor(currentTime / 1000);

      // Find the earliest cache end time
      let switchSecond = currentSecond + 10; // Default to 10s from now
      for (const cache of clockCaches.values()) {
        if (cache.isValid() && cache.windowEnd) {
          // Switch at windowEnd + 1 (first uncached time)
          switchSecond = Math.max(cache.windowEnd + 1, switchSecond);
        }
      }

      const switchTime = switchSecond * 1000;

      console.log(`Switch time: ${new Date(switchTime).toLocaleTimeString()} (${switchSecond - currentSecond}s from now)`);

      // Store pending transition
      pendingBaseTransition = {
        baseBuffer: newBaseImageBuffer,
        overlayStates: newOverlayStates,
        switchTime: switchTime,
        switchSecond: switchSecond
      };

      // Pre-render new clock frames starting at switch time
      const clockOverlays = enabledOverlays.filter(o => o.type === 'clock');
      for (const overlay of clockOverlays) {
        const state = newOverlayStates.get(overlay.name);
        if (!state) continue;

        // Create new cache with new base, pre-render from switch time
        const newCache = new ClockCache(overlay, state.baseRegionBuffer, state.region, state.style);
        await newCache.preRender(new Date(switchTime), newCache.windowSize);

        // Store as pending (don't replace current cache yet)
        if (!pendingBaseTransition.newCaches) {
          pendingBaseTransition.newCaches = new Map();
        }
        pendingBaseTransition.newCaches.set(overlay.name, newCache);

        console.log(`✓ Pre-rendered ${newCache.windowSize} frames for '${overlay.name}' starting at ${new Date(switchTime).toLocaleTimeString()}`);
      }

      const duration = Date.now() - startTime;
      console.log(`New base prepared in ${duration}ms, will switch at ${new Date(switchTime).toLocaleTimeString()}`);
      stressMonitor.recordOperation('baseImage', duration, true);
      perfMonitor.end(perfOpId, { success: true });
    } catch (err) {
      const duration = Date.now() - startTime;
      console.error(`Error recapturing base image:`, err);
      pendingBaseTransition = null; // Clear pending transition on error
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
        // Health check: verify browser is still responsive
        if (browser && page) {
          // More lenient health check with retries to avoid false positives
          // Pi Zero 2 W can be slow under load, give it room to breathe
          const healthCheckTimeout = 15000; // 15 seconds (was 5s)
          const maxRetries = 2; // Retry twice before declaring failure

          let lastError = null;
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              await Promise.race([
                page.evaluate(() => true),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Health check timeout')), healthCheckTimeout)
                )
              ]);
              // Success - browser is responsive
              lastError = null;
              break;
            } catch (err) {
              lastError = err;
              if (attempt < maxRetries) {
                console.warn(`⚠️  Browser health check attempt ${attempt + 1}/${maxRetries + 1} failed, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
              }
            }
          }

          // If all retries failed, restart browser
          if (lastError) {
            console.error('\n' + '!'.repeat(60));
            console.error('🚨 CRITICAL: Browser health check failed after retries');
            console.error(`Error: ${lastError.message}`);
            console.error('Browser may be unresponsive or crashed');
            console.error('!'.repeat(60));

            // Restart browser in-process
            await restartBrowser('health check failed');
            return;
          }
        } else {
          console.error('\n' + '!'.repeat(60));
          console.error('🚨 CRITICAL: Browser or page object is null');
          console.error('Browser may have crashed without triggering disconnected event');
          console.error('!'.repeat(60));

          // Restart browser in-process
          await restartBrowser('browser null');
          return;
        }

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
  console.log(`web2fb is running (${gitCommit}). Press Ctrl+C to stop.`);
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
  perfMonitor.sampleMemory('startup');
  const initOpId = perfMonitor.start('init:total');

  // Open framebuffer (only once, persists across browser restarts)
  const fbOpId = perfMonitor.start('init:framebuffer');
  if (!openFramebuffer()) {
    console.error('Failed to initialize framebuffer');
    process.exit(1);
  }
  perfMonitor.end(fbOpId);

  // Display splash screen (only on first startup)
  const splashOpId = perfMonitor.start('init:splash');
  await displaySplashScreen();
  perfMonitor.end(splashOpId);

  perfMonitor.end(initOpId);

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

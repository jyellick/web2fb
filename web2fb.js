#!/usr/bin/env node

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadConfig, getEnabledOverlays } = require('./lib/config');
const { generateOverlay } = require('./lib/overlays');
const { createScreenshotProvider } = require('./lib/screenshot-providers');
const StressMonitor = require('./lib/stress-monitor');
const PerfMonitor = require('./lib/perf-monitor');
const ClockCache = require('./lib/clock-cache');
const { cleanupChromeTempDirs, checkProfileSize, formatBytes } = require('./lib/cleanup');

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

// Screenshot provider (replaces browser/page)
let screenshotProvider = null;
let intervals = [];

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
        cache = new ClockCache(overlay, state.baseRegionBuffer, state.region, state.detectedStyle);
        clockCaches.set(overlay.name, cache);
      } else {
        cache.updateBaseRegion(state.baseRegionBuffer);
        // Update detected style in case it changed
        cache.detectedStyle = state.detectedStyle;
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
      style: { ...state.detectedStyle, ...overlay.style }
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
    overlay.style = { ...state.detectedStyle, ...overlay.style };

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
async function restartProvider(reason) {
  console.log('\n' + '='.repeat(60));
  console.log(`🔄 Restarting screenshot provider (${reason})`);
  console.log('='.repeat(60));

  // Enter recovery mode
  stressMonitor.enterRecoveryMode();

  try {
    // Clear all intervals
    console.log(`Clearing ${intervals.length} interval(s)...`);
    intervals.forEach(id => clearInterval(id));
    intervals = [];

    // Cleanup provider
    if (screenshotProvider) {
      console.log('Cleaning up screenshot provider...');
      await screenshotProvider.cleanup();
      screenshotProvider = null;
    }

    // Wait for cooldown
    const cooldown = stressMonitor.config.recovery.cooldownPeriod;
    console.log(`Waiting ${cooldown}ms for system recovery...`);
    await new Promise(resolve => setTimeout(resolve, cooldown));

    // Exit recovery mode
    stressMonitor.exitRecoveryMode();

    console.log('✓ Recovery complete, re-initializing...\n');

    // Re-initialize
    await initializeAndRun();

  } catch (err) {
    console.error('Fatal error during provider restart:', err);
    process.exit(1);
  }
}

// Configure overlays from mandatory metadata in config
function configureOverlays() {
  const enabledOverlays = getEnabledOverlays(config);
  
  console.log(`Configuring ${enabledOverlays.length} overlay(s) from config metadata...`);
  
  for (const overlay of enabledOverlays) {
    // All overlays now have mandatory region and detectedStyle
    if (!overlay.region || !overlay.detectedStyle) {
      throw new Error(`Overlay '${overlay.name}' missing required metadata (region and detectedStyle)`);
    }
    
    overlayStates.set(overlay.name, {
      overlay,
      region: overlay.region,
      detectedStyle: overlay.detectedStyle
    });
    
    console.log(`✓ Overlay '${overlay.name}' configured: (${overlay.region.x}, ${overlay.region.y}), size: ${overlay.region.width}x${overlay.region.height}`);
  }
  
  return enabledOverlays;
}

async function initializeAndRun() {
  console.log('Initializing screenshot provider...');

  // Create and initialize provider
  screenshotProvider = createScreenshotProvider(config);
  await screenshotProvider.initialize();

  // Configure overlays from mandatory config metadata
  configureOverlays();

  // Collect selectors to hide from screenshots
  const enabledOverlays = getEnabledOverlays(config);
  const hideSelectors = enabledOverlays.map(o => o.selector);

  // Capture initial base image
  console.log('Capturing base image...');
  const screenshotOpId = perfMonitor.start('screenshot:capture');
  baseImageBuffer = await screenshotProvider.captureScreenshot(hideSelectors);
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
   */
  console.log('\n' + '='.repeat(60));
  console.log('🎨 Preparing calendar display (splash screen visible)...');
  console.log('='.repeat(60));

  // Pre-render clock frames
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
      const newBaseImageBuffer = await screenshotProvider.captureScreenshot(hideSelectors);
      perfMonitor.end(screenshotOpId, { bufferSize: newBaseImageBuffer.length });

      // Extract new base regions (but don't replace current ones yet)
      const newOverlayStates = new Map();

      for (const overlay of enabledOverlays) {
        if (!overlay.region) continue;

        const extractOpId = perfMonitor.start('baseImage:extractRegion', { name: overlay.name });

        // Extract base region for this overlay
        const baseRegionBuffer = await sharp(newBaseImageBuffer)
          .extract({
            left: overlay.region.x,
            top: overlay.region.y,
            width: overlay.region.width,
            height: overlay.region.height
          })
          .raw()
          .toBuffer();

        newOverlayStates.set(overlay.name, {
          overlay,
          region: overlay.region,
          detectedStyle: overlay.detectedStyle,
          baseRegionBuffer
        });

        perfMonitor.end(extractOpId);
      }

      // Schedule transition at next second boundary for smooth clock update
      const now = Date.now();
      const msUntilNextSecond = 1000 - (now % 1000);
      const switchTime = now + msUntilNextSecond;

      console.log(`Scheduling transition in ${msUntilNextSecond}ms (at second boundary)...`);

      // Store pending transition
      pendingBaseTransition = {
        switchTime,
        newBaseImageBuffer,
        newOverlayStates,
        newCaches: null
      };

      // Pre-render clock caches for new base (in background)
      const clockOverlays = enabledOverlays.filter(o => o.type === 'clock');
      if (clockOverlays.length > 0) {
        const cacheOpId = perfMonitor.start('baseImage:prerenderClocks', { count: clockOverlays.length });

        pendingBaseTransition.newCaches = new Map();

        for (const overlay of clockOverlays) {
          const state = newOverlayStates.get(overlay.name);
          if (!state) continue;

          // Create new cache with new base, pre-render from switch time
          const newCache = new ClockCache(overlay, state.baseRegionBuffer, state.region, state.detectedStyle);
          await newCache.preRender(new Date(switchTime), newCache.windowSize);

          // Store as pending (don't replace current cache yet)
          pendingBaseTransition.newCaches.set(overlay.name, newCache);
        }

        perfMonitor.end(cacheOpId);
      }

      const duration = Date.now() - startTime;
      perfMonitor.end(perfOpId, { success: true, duration });
      stressMonitor.recordOperation('baseImage', duration);
      console.log(`✓ Base image recaptured in ${duration}ms, transition scheduled`);

    } catch (err) {
      const duration = Date.now() - startTime;
      perfMonitor.end(perfOpId, { success: false, error: err.message, duration });
      stressMonitor.recordOperation('baseImage', duration);
      console.error(`Base image recapture failed after ${duration}ms:`, err.message);

      // Clear pending transition
      pendingBaseTransition = null;

    } finally {
      stressMonitor.endBaseImageOperation();
    }
  };

  // Set up change detection (only if provider supports it)
  if (screenshotProvider.supportsChangeDetection()) {
    const changeDetectionConfig = config.changeDetection || {};
    if (changeDetectionConfig.enabled) {
      await screenshotProvider.setupChangeDetection(async () => {
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
    }
  } else {
    const changeDetectionConfig = config.changeDetection || {};
    if (changeDetectionConfig.enabled) {
      console.log('⚠️  Change detection disabled (not supported by screenshot provider)');
    }
  }

  // Track in-progress updates per overlay (drop-frame behavior)
  const overlayUpdateInProgress = new Map();

  // Start overlay update loops
  if (overlayStates.size > 0) {
    for (const overlay of enabledOverlays) {
      if (!overlayStates.has(overlay.name)) {
        continue;
      }

      overlayUpdateInProgress.set(overlay.name, false);
      const updateInterval = overlay.updateInterval || 1000;

      console.log(`Starting overlay '${overlay.name}' update loop (${updateInterval}ms)`);

      // Overlay update function
      const updateOverlay = async (overlay) => {
        // Drop-frame: skip if update already in progress
        if (overlayUpdateInProgress.get(overlay.name)) {
          return;
        }

        overlayUpdateInProgress.set(overlay.name, true);

        try {
          const state = overlayStates.get(overlay.name);
          if (!state || !state.baseRegionBuffer) {
            return;
          }

          // Perform base transition if pending and time has arrived
          if (pendingBaseTransition && Date.now() >= pendingBaseTransition.switchTime) {
            console.log('\n🔄 Executing base image transition...');

            // Atomic swap: replace base image and overlay states
            baseImageBuffer = pendingBaseTransition.newBaseImageBuffer;

            // Replace overlay states
            for (const [name, newState] of pendingBaseTransition.newOverlayStates.entries()) {
              overlayStates.set(name, newState);
            }

            // Replace clock caches
            if (pendingBaseTransition.newCaches) {
              for (const [name, newCache] of pendingBaseTransition.newCaches.entries()) {
                clockCaches.set(name, newCache);
              }
            }

            console.log('✓ Base image transition complete - all overlays now use new base');
            pendingBaseTransition = null;
          }

          // Update overlay on framebuffer
          await updateOverlayOnFramebuffer(overlay, overlayStates.get(overlay.name));

        } catch (err) {
          console.error(`Error updating overlay '${overlay.name}':`, err.message);
        } finally {
          overlayUpdateInProgress.set(overlay.name, false);
        }
      };

      // Set up interval for this overlay
      const intervalId = setInterval(async () => {
        try {
          await updateOverlay(overlay);
        } finally {
          overlayUpdateInProgress.set(overlay.name, false);
        }
      }, updateInterval);

      intervals.push(intervalId);
    }
  }

  // Recovery monitoring (only for local mode with browser)
  let recoveryCheckInProgress = false;
  if (stressMonitor.config.enabled && screenshotProvider.getType() === 'local') {
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
        const localProvider = screenshotProvider;

        // Health check: verify browser is responsive
        const browser = localProvider.getBrowser();
        const page = localProvider.getPage();

        if (browser && page) {
          const healthCheckTimeout = 15000;
          const maxRetries = 2;
          let lastError = null;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              await Promise.race([
                page.evaluate(() => true),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Health check timeout')), healthCheckTimeout)
                )
              ]);
              lastError = null;
              break;
            } catch (err) {
              lastError = err;
              if (attempt < maxRetries) {
                console.warn(`⚠️  Browser health check attempt ${attempt + 1}/${maxRetries + 1} failed, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
          }

          if (lastError) {
            console.error('\n' + '!'.repeat(60));
            console.error('🚨 CRITICAL: Browser health check failed after retries');
            console.error(`Error: ${lastError.message}`);
            console.error('!'.repeat(60));
            await restartProvider('health check failed');
            return;
          }
        }

        // Check profile size
        const userDataDir = localProvider.getUserDataDir();
        if (userDataDir) {
          const profileCheck = checkProfileSize(userDataDir, profileSizeThreshold);

          if (profileCheck.exceeds) {
            console.error('\n' + '!'.repeat(60));
            console.error('🚨 CRITICAL: Chrome profile too large');
            console.error(`Profile size: ${profileCheck.sizeFormatted} (threshold: ${profileCheck.thresholdFormatted})`);
            console.error('!'.repeat(60));
            await restartProvider('profile too large');
            return;
          }
        }

        // Check stress level
        if (stressMonitor.needsBrowserRestart()) {
          console.error('\n' + '!'.repeat(60));
          console.error('🚨 CRITICAL: System under severe stress');
          console.error('!'.repeat(60));
          await restartProvider('severe stress');
        }

      } catch (err) {
        console.error('Recovery check error:', err.message);
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
      perfMonitor.sampleMemory('periodic-sample');
      perfMonitor.printReport();
    }, perfMonitor.config.reportInterval);
    intervals.push(reportIntervalId);
  }

  // Log running status
  console.log('='.repeat(60));
  console.log(`web2fb is running (${gitCommit}). Press Ctrl+C to stop.`);

  if (stressMonitor.config.enabled) {
    console.log('Stress monitoring: ENABLED');
    console.log(`  - Overlay update critical threshold: ${stressMonitor.config.thresholds.overlayUpdateCritical}ms`);
    console.log(`  - Base image critical threshold: ${stressMonitor.config.thresholds.baseImageCritical}ms`);
    console.log(`  - Provider restart after ${stressMonitor.config.recovery.killBrowserThreshold} critical events`);
    console.log('  - Critical events decay on successful operations');
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
  await initializeAndRun();

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

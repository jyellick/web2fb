#!/usr/bin/env node

/**
 * web2fb - Web to Framebuffer Renderer
 *
 * Main orchestration file. Coordinates between:
 * - Screenshot provider (local/remote browser)
 * - Overlay manager (clock/date/text overlays)
 * - Framebuffer (Linux framebuffer device)
 */

// Load environment variables from .env file (if present)
require('dotenv').config();

const sharp = require('sharp');
const { execSync } = require('child_process');
const { loadConfig, getEnabledOverlays } = require('./lib/config');
const { createScreenshotProvider } = require('./lib/screenshot-providers');
const PerfMonitor = require('./lib/perf-monitor');
const Framebuffer = require('./lib/framebuffer');
const OverlayManager = require('./lib/overlay-manager');
const ClockCache = require('./lib/clock-cache');

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

// Initialize performance monitor (enabled via DEBUG environment variable)
const perfMonitor = new PerfMonitor({
  enabled: process.env.DEBUG === '1',
  verbose: false,
  trackMemory: true
});

const gitCommit = getGitCommit();

console.log('='.repeat(60));
console.log(`web2fb - Web to Framebuffer Renderer (${gitCommit})`);
if (config.name) console.log(`Configuration: ${config.name}`);
console.log('='.repeat(60));

// Global state
let screenshotProvider = null;
let framebuffer = null;
let overlayManager = null;
let baseImageBuffer = null;
let intervals = [];
let overlayTimeouts = new Map();
let pendingFullUpdate = null; // { baseImageBuffer } - set when new base ready, cleared after full update

/**
 * Restart screenshot provider (browser crashed or profile too large)
 */
async function restartProvider(reason) {
  console.log('\n' + '='.repeat(60));
  console.log(`🔄 Restarting screenshot provider (${reason})`);
  console.log('='.repeat(60));

  try {
    // Clear all intervals and timeouts
    console.log(`Clearing ${intervals.length} interval(s) and ${overlayTimeouts.size} timeout(s)...`);
    intervals.forEach(id => clearInterval(id));
    intervals = [];
    overlayTimeouts.forEach(id => clearTimeout(id));
    overlayTimeouts.clear();

    // Clear pending state
    pendingFullUpdate = null;

    // Cleanup provider
    if (screenshotProvider) {
      console.log('Cleaning up screenshot provider...');
      await screenshotProvider.cleanup();
      screenshotProvider = null;
    }

    // Wait for cooldown
    const cooldown = 30000; // 30 seconds
    console.log(`Waiting ${cooldown}ms for system recovery...`);
    await new Promise(resolve => setTimeout(resolve, cooldown));

    console.log('✓ Recovery complete, re-initializing...\n');

    // Re-initialize
    await initializeAndRun();

  } catch (err) {
    console.error('Fatal error during provider restart:', err);
    process.exit(1);
  }
}

/**
 * Main initialization and run loop
 */
async function initializeAndRun() {
  console.log('Initializing screenshot provider...');

  // Create and initialize screenshot provider
  screenshotProvider = createScreenshotProvider(config);
  await screenshotProvider.initialize();

  // Create overlay manager
  overlayManager = new OverlayManager(config, perfMonitor);

  // Configure overlays from mandatory config metadata
  overlayManager.configure();

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
  if (overlayManager.states.size > 0) {
    console.log('Caching base regions for overlays...');
    await overlayManager.cacheBaseRegions(baseImageBuffer);
  }

  // Startup transition from splash screen to calendar
  console.log('\n' + '='.repeat(60));
  console.log('🎨 Preparing calendar display (splash screen visible)...');
  console.log('='.repeat(60));

  // Pre-render clock frames
  console.log('Pre-rendering clock frames...');
  await overlayManager.preRenderClockFrames();
  perfMonitor.sampleMemory('after-clock-prerender');
  console.log('✓ Cache populated, ready to display');

  // Composite initial overlays onto base image
  console.log('Compositing overlays onto base image...');
  const compositedImage = await overlayManager.compositeOntoBase(baseImageBuffer);

  // Smooth transition: write composited image to framebuffer
  console.log('\n' + '='.repeat(60));
  console.log('🔄 TRANSITIONING FROM SPLASH TO CALENDAR');
  console.log('='.repeat(60));
  await framebuffer.writeFull(compositedImage);
  perfMonitor.sampleMemory('after-initial-overlays');
  console.log('✓ Calendar displayed with pre-populated cache');
  console.log('='.repeat(60) + '\n');

  /**
   * Re-capture base image when page changes (smooth transition)
   */
  const recaptureBaseImage = async (reason) => {
    const perfOpId = perfMonitor.start('baseImage:recapture', { reason });
    const startTime = Date.now();

    try {
      console.log(`Re-capturing base image (${reason})...`);
      console.log('Old cache continues serving frames during preparation...');

      // Screenshot new page
      const screenshotOpId = perfMonitor.start('baseImage:screenshot');
      const newBaseImageBuffer = await screenshotProvider.captureScreenshot(hideSelectors);
      perfMonitor.end(screenshotOpId, { bufferSize: newBaseImageBuffer.length });

      // Validate that sharp can process the buffer
      let metadata;
      try {
        metadata = await sharp(newBaseImageBuffer).metadata();
        console.log(`Screenshot metadata: ${metadata.format} ${metadata.width}x${metadata.height}, ` +
                    `channels: ${metadata.channels}, space: ${metadata.space}`);
      } catch (err) {
        throw new Error(`Sharp cannot process screenshot buffer: ${err.message}`);
      }

      // Extract new base regions as raw pixels (faster than PNG encoding)
      const newOverlayStates = new Map();

      for (const overlay of enabledOverlays) {
        if (!overlay.region) continue;

        const extractOpId = perfMonitor.start('baseImage:extractRegion', { name: overlay.name });

        try {
          // Extract as raw pixels - faster, no compression overhead
          const baseRegionBuffer = await sharp(newBaseImageBuffer)
            .extract({
              left: overlay.region.x,
              top: overlay.region.y,
              width: overlay.region.width,
              height: overlay.region.height
            })
            .ensureAlpha() // Ensure consistent 4-channel RGBA format
            .raw()
            .toBuffer();

          newOverlayStates.set(overlay.name, {
            overlay,
            region: overlay.region,
            style: overlay.style,
            baseRegionBuffer,
            rawMetadata: {
              width: overlay.region.width,
              height: overlay.region.height,
              channels: 4 // Always RGBA after ensureAlpha()
            }
          });

          perfMonitor.end(extractOpId);
        } catch (err) {
          perfMonitor.end(extractOpId, { success: false });
          throw new Error(
            `Failed to extract region for overlay '${overlay.name}': ${err.message}\n` +
            `Region: x=${overlay.region.x}, y=${overlay.region.y}, ` +
            `w=${overlay.region.width}, h=${overlay.region.height}\n` +
            `Image: ${metadata.width}x${metadata.height}`
          );
        }
      }

      // Pipeline approach: buffer or write immediately depending on overlays
      const duration = Date.now() - startTime;
      console.log(`✓ Base image recaptured in ${duration}ms, applying transition...`);

      baseImageBuffer = newBaseImageBuffer;

      if (enabledOverlays.length === 0) {
        // No overlays: immediate pipeline - write new base directly to framebuffer
        console.log('No overlays - writing new base image directly to framebuffer');
        await framebuffer.writeFull(baseImageBuffer);
        console.log('✓ New base image displayed');
      } else {
        // With overlays: buffered pipeline - delay full update until first unrendered frame
        // This prevents visual mismatch between new background and old cached overlay
        overlayManager.swapBaseRegions(newOverlayStates);

        // Mark pending full update (will execute when cache extends to render next frame)
        pendingFullUpdate = { baseImageBuffer };

        const cache = overlayManager.clockCaches.values().next().value;
        const currentSecond = Math.floor(Date.now() / 1000);
        console.log(`✓ Transition prepared - NO framebuffer write yet`);
        console.log(`  Current time: ${new Date().toISOString()}`);
        console.log(`  Current second: ${currentSecond}`);
        console.log(`  Cache window: ${cache?.windowStart} to ${cache?.windowEnd}`);
        console.log(`  Frames ahead: ${cache ? cache.windowEnd - currentSecond + 1 : 'N/A'}`);
        console.log(`  Full update will occur when cache extends to next frame`);
      }

      perfMonitor.end(perfOpId, { success: true, duration });

    } catch (err) {
      const duration = Date.now() - startTime;
      perfMonitor.end(perfOpId, { success: false, error: err.message, duration });
      console.error(`Base image recapture failed after ${duration}ms:`, err.message);
    }
  };

  // Set up periodic refresh (mandatory)
  // Browser starts fresh for each screenshot, preventing memory leaks and cache growth
  const refreshInterval = config.refreshInterval || 300000; // Default 5 minutes
  console.log(`Setting up periodic refresh every ${refreshInterval}ms`);
  console.log('Browser will start fresh for each screenshot (no long-running processes)');

  const refreshIntervalId = setInterval(async () => {
    await recaptureBaseImage('periodic refresh');
  }, refreshInterval);
  intervals.push(refreshIntervalId);

  // Track in-progress updates per overlay (drop-frame behavior)
  const overlayUpdateInProgress = new Map();

  // Start overlay update loops
  if (overlayManager.states.size > 0) {
    for (const overlay of enabledOverlays) {
      if (!overlayManager.states.has(overlay.name)) {
        continue;
      }

      overlayUpdateInProgress.set(overlay.name, false);
      const updateInterval = overlay.updateInterval || 1000;

      console.log(`Starting overlay '${overlay.name}' update loop (${updateInterval}ms, synchronized to second boundaries)`);

      // Create update function for this overlay
      const updateOverlay = async (overlay) => {
        // Drop-frame: skip if update already in progress
        if (overlayUpdateInProgress.get(overlay.name)) {
          return;
        }

        overlayUpdateInProgress.set(overlay.name, true);

        try {
          // Check if this is the transition point: pending full update + we're at the first unrendered second
          const cache = overlayManager.clockCaches.get(overlay.name);
          const currentSecond = Math.floor(Date.now() / 1000);
          const nextUnrenderedSecond = cache ? cache.windowEnd + 1 : null;
          const isTransitionPoint = pendingFullUpdate && cache && currentSecond === nextUnrenderedSecond;

          if (isTransitionPoint) {
            // This is the first unrendered frame - perfect timing for full update!
            const now = new Date();
            console.log(`\n🔄 TRANSITION POINT REACHED - current second matches first unrendered frame`);
            console.log(`  Overlay: '${overlay.name}'`);
            console.log(`  Time: ${now.toISOString()}`);
            console.log(`  Current second: ${currentSecond} = windowEnd + 1 (${cache.windowEnd} + 1)`);
            console.log(`  Cache window before extend: ${cache.windowStart} to ${cache.windowEnd}`);

            // First, let the cache extend to render the new frame with new base
            await cache.extendWindow(1, now);
            console.log(`✓ New frame rendered with new base`);
            console.log(`  Cache window after extend: ${cache.windowStart} to ${cache.windowEnd}`);

            // Now do FULL update with the newly-rendered frame
            console.log(`  Compositing all overlays onto new base...`);
            const compositedImage = await overlayManager.compositeOntoBase(baseImageBuffer);
            console.log(`  Writing FULL framebuffer update...`);
            await framebuffer.writeFull(compositedImage);

            console.log('✓ Full update complete - new base displayed with newly-rendered overlay');
            pendingFullUpdate = null; // Clear pending flag
          } else {
            // Normal partial update
            const updateFn = overlayManager.createUpdateFunction(overlay, framebuffer);
            await updateFn();
          }
        } catch (err) {
          console.error(`Error updating overlay '${overlay.name}':`, err.message);
        } finally {
          overlayUpdateInProgress.set(overlay.name, false);
        }
      };

      // Self-scheduling function that synchronizes to second boundaries
      const scheduleNextUpdate = (overlay) => {
        const now = Date.now();
        const msUntilNextSecond = 1000 - (now % 1000);

        const timeoutId = setTimeout(async () => {
          // Update overlay (with drop-frame protection)
          await updateOverlay(overlay);

          // Reschedule for next second boundary (self-correcting, no drift)
          scheduleNextUpdate(overlay);
        }, msUntilNextSecond);

        overlayTimeouts.set(overlay.name, timeoutId);
      };

      // Start the self-scheduling loop
      scheduleNextUpdate(overlay);
    }
  }

  // Log running status
  console.log('='.repeat(60));
  console.log(`web2fb is running (${gitCommit}). Press Ctrl+C to stop.`);
  if (perfMonitor.config.enabled) {
    console.log('Performance monitoring: ENABLED (DEBUG=1)');
  }
  console.log('='.repeat(60));
}

// Main entry point
(async () => {
  perfMonitor.sampleMemory('startup');
  const initOpId = perfMonitor.start('init:total');

  // Initialize framebuffer
  framebuffer = new Framebuffer(config, perfMonitor);

  const fbOpId = perfMonitor.start('init:framebuffer');
  if (!framebuffer.open()) {
    console.error('Failed to initialize framebuffer');
    process.exit(1);
  }
  perfMonitor.end(fbOpId);

  // Display splash screen (only on first startup)
  const splashOpId = perfMonitor.start('init:splash');
  await framebuffer.displaySplashScreen();
  perfMonitor.end(splashOpId);

  perfMonitor.end(initOpId);

  // Initialize browser and start main loop
  await initializeAndRun();

  // Cleanup on exit
  const shutdown = async () => {
    console.log('\nShutting down...');

    // Clear all intervals and timeouts
    console.log(`Clearing ${intervals.length} interval(s) and ${overlayTimeouts.size} timeout(s)...`);
    intervals.forEach(id => clearInterval(id));
    overlayTimeouts.forEach(id => clearTimeout(id));

    // Print final performance report if enabled
    if (perfMonitor.config.enabled) {
      perfMonitor.sampleMemory('shutdown');
      perfMonitor.printReport();
      perfMonitor.close();
    }

    // Close framebuffer
    framebuffer.close();

    // Cleanup screenshot provider
    if (screenshotProvider) {
      try {
        await screenshotProvider.cleanup();
        console.log('✓ Cleaned up screenshot provider');
      } catch (_err) {
        // Ignore cleanup errors on exit
      }
    }

    process.exit(0);
  };

  process.on('SIGINT', shutdown);   // Ctrl+C
  process.on('SIGTERM', shutdown);  // systemctl stop
})();

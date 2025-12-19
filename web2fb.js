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
const FramebufferQueue = require('./lib/framebuffer-queue');
const FramebufferRenderer = require('./lib/framebuffer-renderer');
const DisplayScheduler = require('./lib/display-scheduler');

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
let baseImageBuffer = null;
let overlayStates = new Map(); // name -> { overlay, region, style, baseRegionBuffer, rawMetadata }
let pendingOverlayStates = null; // New overlay states awaiting full update
let pendingBaseImageBuffer = null; // New base image awaiting full update
let queue = null;
let renderer = null;
let scheduler = null;
let intervals = [];
let queueMaintainerRunning = false;
let nextFullUpdateSecond = null; // Second when next full update should occur

/**
 * Restart screenshot provider (browser crashed or profile too large)
 */
async function restartProvider(reason) {
  console.log('\n' + '='.repeat(60));
  console.log(`🔄 Restarting screenshot provider (${reason})`);
  console.log('='.repeat(60));

  try {
    // Stop scheduler
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }

    // Clear queue
    if (queue) {
      queue.clear();
      queue = null;
    }

    // Stop queue maintainer
    queueMaintainerRunning = false;

    // Clear all intervals
    console.log(`Clearing ${intervals.length} interval(s)...`);
    intervals.forEach(id => clearInterval(id));
    intervals = [];

    // Clear pending state
    nextFullUpdateSecond = null;
    overlayStates.clear();
    pendingOverlayStates = null;
    pendingBaseImageBuffer = null;

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
 * Extract base regions for overlays from base image
 * @param {Buffer} baseImage - Base image buffer
 * @param {Array} overlays - Enabled overlays
 * @param {Map} targetStates - Map to store extracted states (defaults to overlayStates)
 */
async function extractBaseRegions(baseImage, overlays, targetStates = overlayStates) {
  targetStates.clear();

  for (const overlay of overlays) {
    if (!overlay.region) continue;

    const extractOpId = perfMonitor.start('baseImage:extractRegion', { name: overlay.name });

    try {
      // Extract as raw pixels - faster, no compression overhead
      const baseRegionBuffer = await sharp(baseImage)
        .extract({
          left: overlay.region.x,
          top: overlay.region.y,
          width: overlay.region.width,
          height: overlay.region.height
        })
        .ensureAlpha() // Ensure consistent 4-channel RGBA format
        .raw()
        .toBuffer();

      targetStates.set(overlay.name, {
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
        `w=${overlay.region.width}, h=${overlay.region.height}`
      );
    }
  }
}

/**
 * Re-capture base image and schedule full update
 */
async function recaptureBaseImage(reason, enabledOverlays) {
  const perfOpId = perfMonitor.start('baseImage:recapture', { reason });
  const startTime = Date.now();

  try {
    console.log(`\nRe-capturing base image (${reason})...`);

    // Screenshot new page
    const hideSelectors = enabledOverlays.map(o => o.selector);
    const screenshotOpId = perfMonitor.start('baseImage:screenshot');
    const newBaseImageBuffer = await screenshotProvider.captureScreenshot(hideSelectors);
    perfMonitor.end(screenshotOpId, { bufferSize: newBaseImageBuffer.length });

    // Validate sharp can process it
    const metadata = await sharp(newBaseImageBuffer).metadata();
    console.log(`Screenshot: ${metadata.format} ${metadata.width}x${metadata.height}`);

    // Store new base and regions as PENDING (don't update active state yet)
    pendingBaseImageBuffer = newBaseImageBuffer;

    // Extract new base regions into PENDING state
    if (enabledOverlays.length > 0) {
      pendingOverlayStates = new Map();
      await extractBaseRegions(newBaseImageBuffer, enabledOverlays, pendingOverlayStates);
    }

    const duration = Date.now() - startTime;
    console.log(`✓ Base image recaptured in ${duration}ms`);

    // Schedule full update at the next unqueued second
    const currentSecond = Math.floor(Date.now() / 1000);
    const lastQueued = queue.getLastQueuedSecond();
    nextFullUpdateSecond = lastQueued ? lastQueued + 1 : currentSecond + 1;

    console.log(`Full update scheduled for second ${nextFullUpdateSecond} (${new Date(nextFullUpdateSecond * 1000).toISOString()})`);
    console.log(`Old overlay states remain active until full update renders`);
    perfMonitor.end(perfOpId, { success: true, duration });

  } catch (err) {
    const duration = Date.now() - startTime;
    perfMonitor.end(perfOpId, { success: false, error: err.message, duration });
    console.error(`Base image recapture failed after ${duration}ms:`, err.message);
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

  // Get enabled overlays
  const enabledOverlays = getEnabledOverlays(config);
  const hideSelectors = enabledOverlays.map(o => o.selector);

  // Capture initial base image
  console.log('Capturing base image...');
  const screenshotOpId = perfMonitor.start('screenshot:capture');
  baseImageBuffer = await screenshotProvider.captureScreenshot(hideSelectors);
  perfMonitor.end(screenshotOpId, { bufferSize: baseImageBuffer.length });
  perfMonitor.sampleMemory('after-base-screenshot');
  console.log('Base image captured');

  // Extract base regions for overlays
  if (enabledOverlays.length > 0) {
    console.log('Extracting base regions for overlays...');
    await extractBaseRegions(baseImageBuffer, enabledOverlays);
  }

  // Startup transition from splash screen to calendar
  console.log('\n' + '='.repeat(60));
  console.log('🎨 Pre-rendering framebuffer operations (splash screen visible)...');
  console.log('='.repeat(60));

  // Create queue-based rendering system
  // Use 15-second window for more buffer against slow rendering
  queue = new FramebufferQueue(15);
  renderer = new FramebufferRenderer(config, perfMonitor);
  scheduler = new DisplayScheduler(queue, framebuffer, perfMonitor);

  // Pre-render initial window of operations (10 seconds ahead)
  const currentSecond = Math.floor(Date.now() / 1000);
  console.log(`Pre-rendering operations for seconds ${currentSecond} to ${currentSecond + queue.windowSize - 1}...`);

  for (let i = 0; i < queue.windowSize; i++) {
    const displaySecond = currentSecond + i;
    const displayTime = displaySecond * 1000;

    let operation;
    if (i === 0 || enabledOverlays.length === 0) {
      // First frame or no overlays: full update
      operation = await renderer.renderFullUpdate(baseImageBuffer, enabledOverlays, overlayStates, displayTime);
    } else {
      // Subsequent frames with overlays: partial update (first overlay only for now)
      const overlay = enabledOverlays[0];
      const state = overlayStates.get(overlay.name);
      operation = await renderer.renderPartialUpdate(overlay, state, displayTime);
    }

    queue.enqueue(displaySecond, operation);
  }

  perfMonitor.sampleMemory('after-prerender');
  console.log(`✓ ${queue.windowSize} operations pre-rendered and queued`);

  // Display first operation immediately (splash transition)
  console.log('\n' + '='.repeat(60));
  console.log('🔄 TRANSITIONING FROM SPLASH TO CALENDAR');
  console.log('='.repeat(60));
  await scheduler.displayFrame(currentSecond);
  perfMonitor.sampleMemory('after-initial-display');
  console.log('✓ Calendar displayed');
  console.log('='.repeat(60) + '\n');

  // Start display scheduler (writes queued operations at second boundaries)
  scheduler.start();

  // Start queue maintainer loop (keeps queue filled)
  queueMaintainerRunning = true;
  let lastCheckTime = Date.now();

  const maintainQueue = async () => {
    while (queueMaintainerRunning) {
      try {
        const now = Date.now();
        const timeSinceLastCheck = now - lastCheckTime;
        lastCheckTime = now;

        // Warn if check loop is delayed
        if (perfMonitor.config.enabled && timeSinceLastCheck > 200) {
          console.warn(`⚠️  Queue maintainer delayed: ${timeSinceLastCheck}ms since last check (expect ~50ms)`);
        }

        let currentSecond = Math.floor(now / 1000);
        let status = queue.getStatus(currentSecond);

        // Warn if queue is running low
        if (status.secondsAhead < 5) {
          console.warn(`⚠️  Queue running low: only ${status.secondsAhead}s ahead (${status.range})`);
        }

        // Batch render multiple frames when queue needs filling
        // This is much more efficient than one-at-a-time
        let batchStartTime = null;
        let batchCount = 0;

        while (queue.needsMore(currentSecond)) {
          if (batchStartTime === null) {
            batchStartTime = Date.now();
          }

          // CRITICAL: If there's a pending full update that needs rendering, prioritize it
          // This ensures we don't skip the full update even if queue already has operations past it
          let displaySecond;
          if (nextFullUpdateSecond !== null && nextFullUpdateSecond >= currentSecond) {
            // Full update is pending and is in the current time range
            displaySecond = nextFullUpdateSecond;
            console.log(`Prioritizing pending full update for second ${displaySecond}`);
          } else {
            // Normal case: find next gap
            displaySecond = queue.getNextUnqueuedSecond(currentSecond);
          }
          const displayTime = displaySecond * 1000;

          // Check if this should be a full update (base image changed)
          const isFullUpdate = nextFullUpdateSecond !== null && displaySecond === nextFullUpdateSecond;

          let operation;
          if (isFullUpdate) {
            console.log(`\nRendering FULL update for second ${displaySecond} (new base image)`);
            const fullStartTime = Date.now();

            // Use pending states for the full update
            const baseForRender = pendingBaseImageBuffer || baseImageBuffer;
            const statesForRender = pendingOverlayStates || overlayStates;

            operation = await renderer.renderFullUpdate(baseForRender, enabledOverlays, statesForRender, displayTime);

            // Now swap pending into active (this is the critical moment!)
            if (pendingBaseImageBuffer) {
              baseImageBuffer = pendingBaseImageBuffer;
              pendingBaseImageBuffer = null;
              console.log(`✓ Base image swapped: pending → active`);
            }
            if (pendingOverlayStates) {
              overlayStates = pendingOverlayStates;
              pendingOverlayStates = null;
              console.log(`✓ Overlay states swapped: pending → active`);
            }

            nextFullUpdateSecond = null; // Clear flag
            console.log(`✓ Full update rendered in ${Date.now() - fullStartTime}ms`);
          } else if (enabledOverlays.length === 0) {
            // No overlays: full updates only (but reuse same base)
            operation = await renderer.renderFullUpdate(baseImageBuffer, enabledOverlays, overlayStates, displayTime);
          } else {
            // Normal partial update (first overlay)
            const overlay = enabledOverlays[0];
            const state = overlayStates.get(overlay.name);
            operation = await renderer.renderPartialUpdate(overlay, state, displayTime);
          }

          // Check if we're overwriting an existing operation (potential issue!)
          const existingOp = queue.operations.get(displaySecond);
          if (existingOp && perfMonitor.config.enabled) {
            console.warn(`⚠️  Overwriting existing ${existingOp.type} operation for second ${displaySecond} with ${operation.type}`);
          }

          queue.enqueue(displaySecond, operation);
          batchCount++;

          if (perfMonitor.config.enabled && displaySecond % 10 === 0) {
            const status = queue.getStatus(currentSecond);
            console.log(`Queue: ${status.size} operations, ${status.secondsAhead}s ahead (${status.range})`);
          }

          // CRITICAL: Recalculate currentSecond after rendering to avoid stale values
          // Rendering takes 100-200ms, so time advances significantly between iterations
          currentSecond = Math.floor(Date.now() / 1000);
        }

        // Log batch rendering performance
        if (batchCount > 0 && perfMonitor.config.enabled) {
          const batchDuration = Date.now() - batchStartTime;
          const avgPerFrame = batchDuration / batchCount;
          console.log(`Batch rendered ${batchCount} frames in ${batchDuration}ms (${avgPerFrame.toFixed(1)}ms/frame)`);
        }

        // Sleep briefly before next check (reduced from 100ms to 50ms for faster response)
        await new Promise(resolve => setTimeout(resolve, 50));

      } catch (err) {
        console.error('Error in queue maintainer:', err.message);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Longer sleep on error
      }
    }
  };

  // Start queue maintainer in background
  maintainQueue().catch(err => {
    console.error('Queue maintainer fatal error:', err);
  });

  // Set up periodic refresh
  const refreshInterval = config.refreshInterval || 300000; // Default 5 minutes
  console.log(`Setting up periodic refresh every ${refreshInterval}ms`);

  const refreshIntervalId = setInterval(async () => {
    await recaptureBaseImage('periodic refresh', enabledOverlays);
  }, refreshInterval);
  intervals.push(refreshIntervalId);

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

    // Stop scheduler
    if (scheduler) {
      scheduler.stop();
    }

    // Stop queue maintainer
    queueMaintainerRunning = false;

    // Clear all intervals
    console.log(`Clearing ${intervals.length} interval(s)...`);
    intervals.forEach(id => clearInterval(id));

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

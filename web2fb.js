#!/usr/bin/env node

const puppeteer = require('puppeteer');
const sharp = require('sharp');
const fs = require('fs');
const { loadConfig, getEnabledOverlays } = require('./lib/config');
const { generateOverlay, detectOverlayRegion, hideOverlayElements } = require('./lib/overlays');

// Parse command line arguments
const args = process.argv.slice(2);
const configArg = args.find(arg => arg.startsWith('--config='));
const configPath = configArg ? configArg.split('=')[1] : null;

// Load configuration
const config = loadConfig(configPath);

console.log('='.repeat(60));
console.log(`web2fb - Web to Framebuffer Renderer`);
if (config.name) console.log(`Configuration: ${config.name}`);
console.log('='.repeat(60));

// Framebuffer state
let fbFd = null;
let fbInfo = null;

// Overlay state
const overlayStates = new Map(); // name -> {region, style, baseRegionBuffer}

// Base image (without overlays)
let baseImageBuffer = null;

// Buffer pool for reducing GC pressure
const bufferPool = {
  rgb565: null,
  maxSize: 0
};

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
  } catch (err) {
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
  try {
    let sharpImage = sharp(imageBuffer, {
      sequentialRead: true,
      limitInputPixels: false
    });

    const metadata = await sharpImage.metadata();

    // Convert to raw buffer based on framebuffer format
    let rawBuffer;
    if (fbInfo.bpp === 32) {
      rawBuffer = await sharpImage.ensureAlpha().raw().toBuffer();
    } else if (fbInfo.bpp === 24) {
      rawBuffer = await sharpImage.removeAlpha().raw().toBuffer();
    } else if (fbInfo.bpp === 16) {
      const rgbBuffer = await sharpImage.removeAlpha().raw().toBuffer();
      rawBuffer = convertToRGB565(rgbBuffer);
    } else {
      throw new Error(`Unsupported framebuffer format: ${fbInfo.bpp}bpp`);
    }

    const written = fs.writeSync(fbFd, rawBuffer, 0, rawBuffer.length, 0);
    return true;
  } catch (err) {
    console.error('Error writing to framebuffer:', err);
    return false;
  }
}

// Write partial image to framebuffer at specific region
async function writePartialToFramebuffer(imageBuffer, region) {
  try {
    let sharpImage = sharp(imageBuffer, {
      sequentialRead: true,
      limitInputPixels: false
    });

    const metadata = await sharpImage.metadata();

    // Convert to raw buffer
    let rawBuffer;
    if (fbInfo.bpp === 32) {
      rawBuffer = await sharpImage.ensureAlpha().raw().toBuffer();
    } else if (fbInfo.bpp === 24) {
      rawBuffer = await sharpImage.removeAlpha().raw().toBuffer();
    } else if (fbInfo.bpp === 16) {
      const rgbBuffer = await sharpImage.removeAlpha().raw().toBuffer();
      rawBuffer = convertToRGB565(rgbBuffer);
    } else {
      throw new Error(`Unsupported framebuffer format: ${fbInfo.bpp}bpp`);
    }

    // Write line by line to correct framebuffer position
    const regionWidth = metadata.width;
    const regionHeight = metadata.height;
    const bytesPerLine = regionWidth * fbInfo.bytesPerPixel;
    const fbBytesPerLine = fbInfo.width * fbInfo.bytesPerPixel;

    for (let y = 0; y < regionHeight; y++) {
      const srcOffset = y * bytesPerLine;
      const fbOffset = ((region.y + y) * fbBytesPerLine) + (region.x * fbInfo.bytesPerPixel);
      fs.writeSync(fbFd, rawBuffer, srcOffset, bytesPerLine, fbOffset);
    }

    return true;
  } catch (err) {
    console.error('Error writing partial to framebuffer:', err);
    return false;
  }
}

// Convert RGB to RGB565 (with buffer pooling)
function convertToRGB565(rgbBuffer) {
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

  return rgb565Buffer.slice(0, requiredSize);
}

// Update a single overlay
async function updateOverlay(overlay) {
  try {
    const state = overlayStates.get(overlay.name);
    if (!state || !baseImageBuffer) {
      return false;
    }

    const { region } = state;
    const style = overlay.detectStyle ? state.style : (overlay.style || {});

    // Merge detected style with overlay style
    overlay.style = { ...state.style, ...overlay.style };

    // Generate overlay content
    const overlayBuffer = generateOverlay(overlay, region);

    // Extract region from base image and composite overlay
    const compositeImage = await sharp(baseImageBuffer)
      .extract({
        left: region.x,
        top: region.y,
        width: region.width,
        height: region.height
      })
      .composite([{ input: overlayBuffer }])
      .png()
      .toBuffer();

    // Write only the overlay region to framebuffer
    await writePartialToFramebuffer(compositeImage, region);
    return true;
  } catch (err) {
    console.error(`Error updating overlay '${overlay.name}':`, err);
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

// Main application
(async () => {
  // Open framebuffer
  if (!openFramebuffer()) {
    console.error('Failed to initialize framebuffer');
    process.exit(1);
  }

  // Display splash screen
  await displaySplashScreen();

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
    '--single-process'
  ];

  const launchOptions = {
    headless: 'new',
    args: browserArgs
  };

  if (config.browser.executablePath) {
    launchOptions.executablePath = config.browser.executablePath;
  }

  console.log('Launching browser...');
  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();

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
  await page.goto(config.display.url, {
    waitUntil: 'load',
    timeout: config.browser.timeout
  });

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
    await page.waitForFunction(() => {
      const images = Array.from(document.images);
      return images.every(img => img.complete && img.naturalHeight !== 0);
    }, { timeout: config.browser.imageLoadTimeout });
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
  baseImageBuffer = await page.screenshot({
    type: 'jpeg',
    quality: 90
  });
  console.log('Base image captured');

  // Write base image to framebuffer
  console.log('Writing base image to framebuffer...');
  await writeToFramebuffer(baseImageBuffer);

  // Initial overlay render
  if (overlayStates.size > 0) {
    console.log('Rendering initial overlays...');
    await updateAllOverlays();
    console.log('Overlays displayed');
  }

  // Re-capture base image when page changes
  const recaptureBaseImage = async (reason) => {
    const startTime = Date.now();
    console.log(`Re-capturing base image (${reason})...`);

    baseImageBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 90
    });

    await writeToFramebuffer(baseImageBuffer);
    await updateAllOverlays();

    const duration = Date.now() - startTime;
    console.log(`Base image updated in ${duration}ms`);
  };

  // Set up change detection
  if (config.changeDetection.enabled) {
    await page.exposeFunction('onPageChange', async () => {
      console.log('Page change detected');
      await recaptureBaseImage('page changed');
    });

    await page.evaluate((changeDetectionConfig) => {
      let lastSnapshot = '';

      function captureSnapshot() {
        const elements = document.querySelectorAll(changeDetectionConfig.watchSelectors.join(','));
        const data = Array.from(elements).map(el => ({
          tag: el.tagName,
          src: el.src || '',
          style: el.getAttribute('style') || '',
          class: el.className || ''
        }));
        return JSON.stringify(data);
      }

      lastSnapshot = captureSnapshot();
      console.log('Change detection initialized');

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
          const currentSnapshot = captureSnapshot();
          if (currentSnapshot !== lastSnapshot) {
            console.log('Change detected, triggering update');
            lastSnapshot = currentSnapshot;
            window.onPageChange();
          }
        }
      });

      observer.observe(document.body, {
        attributes: true,
        attributeFilter: changeDetectionConfig.watchAttributes,
        childList: true,
        subtree: true
      });

      // Periodic check
      setInterval(() => {
        const currentSnapshot = captureSnapshot();
        if (currentSnapshot !== lastSnapshot) {
          console.log('Periodic check detected change');
          lastSnapshot = currentSnapshot;
          window.onPageChange();
        }
      }, changeDetectionConfig.periodicCheckInterval);

      console.log(`Change detection active (periodic check: ${changeDetectionConfig.periodicCheckInterval}ms)`);
    }, config.changeDetection);
  }

  // Start overlay update loops
  if (overlayStates.size > 0) {
    for (const overlay of enabledOverlays) {
      if (!overlayStates.has(overlay.name)) continue;

      const updateInterval = overlay.updateInterval || 1000;

      console.log(`Starting overlay '${overlay.name}' update loop (${updateInterval}ms)`);

      setInterval(async () => {
        await updateOverlay(overlay);
      }, updateInterval);
    }
  }

  console.log('='.repeat(60));
  console.log('web2fb is running. Press Ctrl+C to stop.');
  console.log('='.repeat(60));

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    if (fbFd) {
      fs.closeSync(fbFd);
    }
    browser.close();
    process.exit(0);
  });
})();

const puppeteer = require('puppeteer');
const sharp = require('sharp');
const fs = require('fs');

const DISPLAY_URL = process.env.DISPLAY_URL || 'https://example.com';
const FRAMEBUFFER_DEVICE = process.env.FRAMEBUFFER_DEVICE || '/dev/fb0';

if (DISPLAY_URL === 'https://example.com') {
  console.error('ERROR: DISPLAY_URL environment variable is required');
  process.exit(1);
}

// Framebuffer state
let fbFd = null;
let fbInfo = null;

// Clock region state (for local overlay)
let clockRegion = null;
let clockStyle = null;

// Base image (without clock)
let baseImageBuffer = null;

// Buffer pool for reducing GC pressure
const bufferPool = {
  rgb565: null,  // Reusable buffer for RGB565 conversion
  maxSize: 0
};

// Detect framebuffer properties
function detectFramebuffer() {
  try {
    // Read framebuffer info from sysfs
    const fbPath = FRAMEBUFFER_DEVICE.replace('/dev/', '/sys/class/graphics/');

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
    // Fallback to common settings if detection fails
    console.warn('Could not detect framebuffer properties, using defaults');
    const fallbackWidth = parseInt(process.env.WIDTH || '1920', 10);
    const fallbackHeight = parseInt(process.env.HEIGHT || '1080', 10);
    return {
      width: fallbackWidth,
      height: fallbackHeight,
      bpp: 32,
      bytesPerPixel: 4,
      stride: fallbackWidth * 4
    };
  }
}

// Open framebuffer device
function openFramebuffer() {
  try {
    fbFd = fs.openSync(FRAMEBUFFER_DEVICE, 'w');
    fbInfo = detectFramebuffer();
    console.log(`Framebuffer opened: ${FRAMEBUFFER_DEVICE}`);
    return true;
  } catch (err) {
    console.error(`Failed to open framebuffer ${FRAMEBUFFER_DEVICE}:`, err);
    return false;
  }
}

// Display splash screen from static file
async function displaySplashScreen() {
  try {
    console.log('Displaying splash screen...');
    const splashBuffer = fs.readFileSync('splash.png');
    await writeToFramebuffer(splashBuffer);
    console.log('Splash screen displayed - starting browser...');
    return true;
  } catch (err) {
    console.warn('Could not display splash screen:', err.message);
    return false;
  }
}

// Write image to framebuffer (full screen)
async function writeToFramebuffer(screenshotBuffer) {
  try {
    // Screenshot is already at framebuffer resolution, just convert format
    let sharpImage = sharp(screenshotBuffer, {
      sequentialRead: true,
      limitInputPixels: false
    });

    // Get metadata to verify dimensions
    const metadata = await sharpImage.metadata();
    console.log(`Screenshot: ${metadata.width}x${metadata.height}, FB: ${fbInfo.width}x${fbInfo.height}@${fbInfo.bpp}bpp`);

    // Convert to raw buffer based on framebuffer format
    let rawBuffer;
    if (fbInfo.bpp === 32) {
      // RGBA8888 - ensure correct size
      rawBuffer = await sharpImage
        .ensureAlpha()
        .raw()
        .toBuffer();

      // Verify buffer size
      const expectedSize = fbInfo.width * fbInfo.height * 4;
      if (rawBuffer.length !== expectedSize) {
        console.warn(`Buffer size mismatch: got ${rawBuffer.length}, expected ${expectedSize}`);
      }
    } else if (fbInfo.bpp === 24) {
      // RGB888
      rawBuffer = await sharpImage
        .removeAlpha()
        .raw()
        .toBuffer();

      const expectedSize = fbInfo.width * fbInfo.height * 3;
      if (rawBuffer.length !== expectedSize) {
        console.warn(`Buffer size mismatch: got ${rawBuffer.length}, expected ${expectedSize}`);
      }
    } else if (fbInfo.bpp === 16) {
      // RGB565
      const rgbBuffer = await sharpImage
        .removeAlpha()
        .raw()
        .toBuffer();
      rawBuffer = convertToRGB565(rgbBuffer);

      const expectedSize = fbInfo.width * fbInfo.height * 2;
      if (rawBuffer.length !== expectedSize) {
        console.warn(`Buffer size mismatch: got ${rawBuffer.length}, expected ${expectedSize}`);
      }
    } else {
      throw new Error(`Unsupported framebuffer format: ${fbInfo.bpp}bpp`);
    }

    // Write to framebuffer at offset 0
    const written = fs.writeSync(fbFd, rawBuffer, 0, rawBuffer.length, 0);
    console.log(`Wrote ${written} bytes to framebuffer`);

    return true;
  } catch (err) {
    console.error('Error writing to framebuffer:', err);
    return false;
  }
}

// Write partial image to framebuffer at specific region
async function writePartialToFramebuffer(screenshotBuffer, region) {
  try {
    const t1 = Date.now();
    let sharpImage = sharp(screenshotBuffer, {
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
    const sharpTime = Date.now() - t1;

    // Write line by line to correct framebuffer position
    const t2 = Date.now();
    const regionWidth = metadata.width;
    const regionHeight = metadata.height;
    const bytesPerLine = regionWidth * fbInfo.bytesPerPixel;
    const fbBytesPerLine = fbInfo.width * fbInfo.bytesPerPixel;

    for (let y = 0; y < regionHeight; y++) {
      const srcOffset = y * bytesPerLine;
      const fbOffset = ((region.y + y) * fbBytesPerLine) + (region.x * fbInfo.bytesPerPixel);
      fs.writeSync(fbFd, rawBuffer, srcOffset, bytesPerLine, fbOffset);
    }
    const fbWriteTime = Date.now() - t2;

    console.log(`  -> Partial write breakdown: sharp=${sharpTime}ms, fb=${fbWriteTime}ms`);
    return true;
  } catch (err) {
    console.error('Error writing partial to framebuffer:', err);
    return false;
  }
}

// Generate clock SVG overlay
function generateClockSVG() {
  const now = new Date();
  // Use locale time format (respects system locale settings)
  const timeString = now.toLocaleTimeString(undefined, {
    hour: 'numeric',  // 1 digit for single-digit hours
    minute: '2-digit',
    second: '2-digit'
  });

  // Use detected clock style or defaults
  const fontSize = clockStyle?.fontSize || 120;
  const fontFamily = clockStyle?.fontFamily || 'Arial, sans-serif';
  const color = clockStyle?.color || '#ffffff';
  const fontWeight = clockStyle?.fontWeight || 'bold';
  const textAlign = clockStyle?.textAlign || 'left';
  const letterSpacing = clockStyle?.letterSpacing || 'normal';

  const svgWidth = clockRegion?.width || 700;
  const svgHeight = clockRegion?.height || 200;

  // Determine text anchor based on text-align
  let textAnchor = 'start'; // left align
  let xPos = '0';
  if (textAlign === 'center') {
    textAnchor = 'middle';
    xPos = '50%';
  } else if (textAlign === 'right') {
    textAnchor = 'end';
    xPos = '100%';
  }

  return Buffer.from(`
    <svg width="${svgWidth}" height="${svgHeight}">
      <text
        x="${xPos}"
        y="50%"
        font-family="${fontFamily}"
        font-size="${fontSize}px"
        font-weight="${fontWeight}"
        fill="${color}"
        text-anchor="${textAnchor}"
        dominant-baseline="middle"
        letter-spacing="${letterSpacing}">
        ${timeString}
      </text>
    </svg>
  `);
}

// Render clock and write only the clock region to framebuffer (optimized)
async function updateClockOverlay() {
  try {
    if (!baseImageBuffer || !clockRegion) {
      console.warn('Base image or clock region not available');
      return false;
    }

    const clockSVG = generateClockSVG();

    // Extract the clock region from the base image and composite the clock on top
    const clockRegionImage = await sharp(baseImageBuffer)
      .extract({
        left: clockRegion.x,
        top: clockRegion.y,
        width: clockRegion.width,
        height: clockRegion.height
      })
      .composite([{
        input: clockSVG
      }])
      .png()
      .toBuffer();

    // Write only the clock region to the framebuffer (not the entire screen!)
    await writePartialToFramebuffer(clockRegionImage, clockRegion);
    return true;
  } catch (err) {
    console.error('Error updating clock overlay:', err);
    return false;
  }
}

// Convert RGB to RGB565 (with buffer pooling)
function convertToRGB565(rgbBuffer) {
  // rgbBuffer is RGB (no alpha), 3 bytes per pixel
  const requiredSize = (rgbBuffer.length / 3) * 2;

  // Reuse buffer if large enough, otherwise allocate new one
  if (!bufferPool.rgb565 || bufferPool.maxSize < requiredSize) {
    bufferPool.rgb565 = Buffer.allocUnsafe(requiredSize);
    bufferPool.maxSize = requiredSize;
  }

  const rgb565Buffer = bufferPool.rgb565;

  for (let i = 0; i < rgbBuffer.length; i += 3) {
    const r = rgbBuffer[i];
    const g = rgbBuffer[i + 1];
    const b = rgbBuffer[i + 2];

    // Convert 8-bit RGB to 5-6-5
    const r5 = (r >> 3) & 0x1F;
    const g6 = (g >> 2) & 0x3F;
    const b5 = (b >> 3) & 0x1F;

    // Pack into 16-bit value
    const rgb565 = (r5 << 11) | (g6 << 5) | b5;

    // Write as little-endian
    const offset = (i / 3) * 2;
    rgb565Buffer.writeUInt16LE(rgb565, offset);
  }

  // Return slice of correct size (buffer may be larger)
  return rgb565Buffer.slice(0, requiredSize);
}

(async () => {
  // Open framebuffer
  if (!openFramebuffer()) {
    console.error('Failed to initialize framebuffer');
    process.exit(1);
  }

  // Display splash screen while browser launches
  await displaySplashScreen();

  // Launch browser with memory optimizations
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      // Memory optimizations for Pi Zero 2 W
      '--disable-dev-shm-usage',  // Use /tmp instead of /dev/shm (avoids shared memory limits)
      '--disable-gpu',  // No GPU on Pi
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
      '--single-process',  // Single process mode (less memory overhead)
    ]
  });

  const page = await browser.newPage();

  // Set user agent
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Remove webdriver flag
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  // Set viewport to match framebuffer dimensions (no resize needed!)
  console.log(`Setting viewport to framebuffer dimensions: ${fbInfo.width}x${fbInfo.height}`);
  await page.setViewport({
    width: fbInfo.width,
    height: fbInfo.height,
    deviceScaleFactor: 1,
  });

  console.log('Loading page...');
  await page.goto(DISPLAY_URL, {
    waitUntil: 'load',  // Just wait for load event, not network idle (faster on slow Pi)
    timeout: 180000     // 3 minutes - Pi Zero 2 W needs extra time
  });

  console.log('Scrolling page to trigger lazy loading...');
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });

  console.log('Waiting for all images to load...');
  await page.waitForFunction(() => {
    const images = Array.from(document.images);
    const allImagesLoaded = images.every(img => img.complete && img.naturalHeight !== 0);
    const noNetworkActivity = performance.getEntriesByType('resource')
      .filter(r => r.initiatorType === 'img' || r.initiatorType === 'css')
      .every(r => r.responseEnd > 0);
    return allImagesLoaded && noNetworkActivity;
  }, { timeout: 120000 });  // 2 minutes for slow Pi

  console.log('All images loaded, page ready');

  // Disable all CSS transitions and animations for instant updates
  console.log('Disabling CSS transitions and animations...');
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
  console.log('Transitions disabled');

  // Wait a bit more for full rendering
  console.log('Waiting for complete page render...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Detect clock position and styling before hiding it
  console.log('Detecting clock element position and style...');
  const clockInfo = await page.evaluate(() => {
    const timeElement = document.querySelector('.time.large');
    if (!timeElement) {
      console.error('Clock element not found!');
      return null;
    }

    const rect = timeElement.getBoundingClientRect();
    const styles = window.getComputedStyle(timeElement);

    console.log('Clock element rect:', JSON.stringify({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    }));

    console.log('Clock styles:', JSON.stringify({
      fontSize: styles.fontSize,
      fontFamily: styles.fontFamily,
      color: styles.color,
      fontWeight: styles.fontWeight,
      textAlign: styles.textAlign,
      letterSpacing: styles.letterSpacing
    }));

    return {
      region: {
        x: Math.floor(rect.left),
        y: Math.floor(rect.top),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height)
      },
      style: {
        fontSize: parseInt(styles.fontSize),
        fontFamily: styles.fontFamily,
        color: styles.color,
        fontWeight: styles.fontWeight,
        textAlign: styles.textAlign,
        letterSpacing: styles.letterSpacing || 'normal'
      }
    };
  });

  if (clockInfo) {
    clockRegion = clockInfo.region;
    clockStyle = clockInfo.style;
    console.log(`Clock detected at (${clockRegion.x}, ${clockRegion.y}), size: ${clockRegion.width}x${clockRegion.height}`);
    console.log(`Clock style: ${clockStyle.fontSize}px ${clockStyle.fontFamily}, color: ${clockStyle.color}`);
  } else {
    console.error('Could not detect clock element!');
    process.exit(1);
  }

  // Hide the clock element
  console.log('Hiding clock element from page...');
  await page.addStyleTag({
    content: `
      .time.large {
        visibility: hidden !important;
      }
    `
  });

  // Wait for page to re-render without clock
  await new Promise(resolve => setTimeout(resolve, 500));

  // Capture base image (without clock)
  console.log('Capturing base image (without clock)...');
  baseImageBuffer = await page.screenshot({
    type: 'jpeg',
    quality: 90
  });
  console.log('Base image captured');

  // Initial display: write full base image first
  console.log('Writing base image to framebuffer...');
  await writeToFramebuffer(baseImageBuffer);
  console.log('Base image displayed');

  // Then overlay the clock on top
  console.log('Adding clock overlay...');
  await updateClockOverlay();
  console.log('Clock overlay displayed');

  // Function to re-capture base image (when background changes)
  const recaptureBaseImage = async (reason) => {
    const startTime = Date.now();
    console.log(`Re-capturing base image (${reason})...`);

    const t1 = Date.now();
    baseImageBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 90
    });
    const screenshotTime = Date.now() - t1;

    // Write the full base image first
    await writeToFramebuffer(baseImageBuffer);

    // Then overlay the clock
    await updateClockOverlay();

    const totalTime = Date.now() - startTime;
    console.log(`Base image updated in ${totalTime}ms (screenshot: ${screenshotTime}ms)`);
  };

  // Expose function for background image changes
  await page.exposeFunction('onBackgroundChange', async () => {
    console.log('Background image changed');
    await recaptureBaseImage('background changed');
  });

  // Set up enhanced background change detection
  await page.evaluate(() => {
    // Track current state for comparison
    let lastImageSnapshot = '';

    function captureImageSnapshot() {
      const images = Array.from(document.querySelectorAll('img'));
      const backgroundElements = Array.from(document.querySelectorAll('[style*="background"]'));

      const imageData = images.map(img => ({
        src: img.src,
        currentSrc: img.currentSrc
      }));

      const bgData = backgroundElements.map(el => ({
        bg: el.style.background,
        bgImage: el.style.backgroundImage
      }));

      return JSON.stringify({ images: imageData, backgrounds: bgData });
    }

    lastImageSnapshot = captureImageSnapshot();
    console.log(`Initial image snapshot captured`);

    // Watch for any DOM changes that might affect images
    const observer = new MutationObserver((mutations) => {
      let shouldCheck = false;

      for (const mutation of mutations) {
        // Check for attribute changes on images
        if (mutation.type === 'attributes') {
          const attrName = mutation.attributeName;
          if (attrName === 'src' || attrName === 'style' ||
              attrName === 'class' || attrName === 'srcset' ||
              attrName === 'background' || attrName === 'background-image') {
            shouldCheck = true;
            console.log(`Detected ${attrName} change on ${mutation.target.tagName}`);
            break;
          }
        }

        // Check for added/removed nodes that might be images
        if (mutation.type === 'childList') {
          const hasImageNodes = Array.from(mutation.addedNodes).some(node =>
            node.tagName === 'IMG' || (node.querySelectorAll && node.querySelectorAll('img').length > 0)
          );
          if (hasImageNodes) {
            shouldCheck = true;
            console.log('Detected image element changes in DOM');
            break;
          }
        }
      }

      if (shouldCheck) {
        const currentSnapshot = captureImageSnapshot();
        if (currentSnapshot !== lastImageSnapshot) {
          console.log('Image state changed, triggering update');
          lastImageSnapshot = currentSnapshot;
          window.onBackgroundChange();
        }
      }
    });

    // Observe the entire document
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['src', 'style', 'class', 'srcset', 'background', 'background-image'],
      childList: true,
      subtree: true
    });

    console.log('Enhanced background observer active (watching entire document)');

    // Periodic fallback check every 2 minutes
    setInterval(() => {
      const currentSnapshot = captureImageSnapshot();
      if (currentSnapshot !== lastImageSnapshot) {
        console.log('Periodic check detected image changes');
        lastImageSnapshot = currentSnapshot;
        window.onBackgroundChange();
      }
    }, 120000); // 2 minutes

    console.log('Periodic fallback check active (every 2 minutes)');
  });

  // Update clock overlay every second
  console.log('Starting clock update loop (1 second interval)...');
  let updateCount = 0;
  setInterval(async () => {
    const startTime = Date.now();
    await updateClockOverlay();
    const duration = Date.now() - startTime;
    updateCount++;

    // Log every 10 seconds
    if (updateCount % 10 === 0) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] Clock overlay update: ${duration}ms`);
    }
  }, 1000);

  console.log('Clock overlay system active. Press Ctrl+C to stop.');

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    if (fbFd) {
      fs.closeSync(fbFd);
    }
    browser.close();
    process.exit(0);
  });
})();

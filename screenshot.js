const puppeteer = require('puppeteer');
const sharp = require('sharp');
const fs = require('fs');

const DISPLAY_URL = process.env.DISPLAY_URL || 'https://example.com';
const WIDTH = parseInt(process.env.WIDTH || '1920', 10);
const HEIGHT = parseInt(process.env.HEIGHT || '1080', 10);
const FRAMEBUFFER_DEVICE = process.env.FRAMEBUFFER_DEVICE || '/dev/fb0';

if (DISPLAY_URL === 'https://example.com') {
  console.error('ERROR: DISPLAY_URL environment variable is required');
  process.exit(1);
}

// Framebuffer state
let fbFd = null;
let fbInfo = null;

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
    return {
      width: WIDTH,
      height: HEIGHT,
      bpp: 32,
      bytesPerPixel: 4,
      stride: WIDTH * 4
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

// Write image to framebuffer
async function writeToFramebuffer(screenshotBuffer) {
  try {
    // Convert screenshot to raw RGB/RGBA buffer matching framebuffer format
    let sharpImage = sharp(screenshotBuffer);

    // Resize if needed to match framebuffer dimensions
    if (WIDTH !== fbInfo.width || HEIGHT !== fbInfo.height) {
      sharpImage = sharpImage.resize(fbInfo.width, fbInfo.height, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      });
    }

    // Convert to raw buffer based on framebuffer format
    let rawBuffer;
    if (fbInfo.bpp === 32) {
      // RGBA8888 or BGRA8888
      rawBuffer = await sharpImage.raw().toBuffer();
    } else if (fbInfo.bpp === 24) {
      // RGB888
      rawBuffer = await sharpImage.raw().toBuffer();
    } else if (fbInfo.bpp === 16) {
      // RGB565 - need conversion
      const rgbBuffer = await sharpImage.ensureAlpha().raw().toBuffer();
      rawBuffer = convertToRGB565(rgbBuffer);
    } else {
      throw new Error(`Unsupported framebuffer format: ${fbInfo.bpp}bpp`);
    }

    // Write to framebuffer
    fs.writeSync(fbFd, rawBuffer, 0, rawBuffer.length, 0);

    return true;
  } catch (err) {
    console.error('Error writing to framebuffer:', err);
    return false;
  }
}

// Convert RGBA to RGB565
function convertToRGB565(rgbaBuffer) {
  const rgb565Buffer = Buffer.alloc((rgbaBuffer.length / 4) * 2);

  for (let i = 0; i < rgbaBuffer.length; i += 4) {
    const r = rgbaBuffer[i];
    const g = rgbaBuffer[i + 1];
    const b = rgbaBuffer[i + 2];

    // Convert 8-bit RGB to 5-6-5
    const r5 = (r >> 3) & 0x1F;
    const g6 = (g >> 2) & 0x3F;
    const b5 = (b >> 3) & 0x1F;

    // Pack into 16-bit value
    const rgb565 = (r5 << 11) | (g6 << 5) | b5;

    // Write as little-endian
    const offset = (i / 4) * 2;
    rgb565Buffer.writeUInt16LE(rgb565, offset);
  }

  return rgb565Buffer;
}

(async () => {
  // Open framebuffer
  if (!openFramebuffer()) {
    console.error('Failed to initialize framebuffer');
    process.exit(1);
  }

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
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

  // Set viewport
  await page.setViewport({
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
  });

  console.log('Loading page...');
  await page.goto(DISPLAY_URL, {
    waitUntil: ['load', 'networkidle2'],
    timeout: 60000
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
  }, { timeout: 30000 });

  console.log('All images loaded, page ready');

  console.log('Setting up MutationObserver on clock element...');

  // Watchdog timer
  let lastUpdateTime = Date.now();
  const WATCHDOG_TIMEOUT = 30000;

  setInterval(() => {
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateTime;

    if (timeSinceLastUpdate > WATCHDOG_TIMEOUT) {
      console.error(`WATCHDOG: No updates for ${timeSinceLastUpdate}ms. Restarting...`);
      process.exit(1);
    }
  }, 10000);

  // Set up MutationObserver
  await page.exposeFunction('onClockChange', async () => {
    const screenshot = await page.screenshot({ type: 'png' });
    await writeToFramebuffer(screenshot);
    lastUpdateTime = Date.now();
    const timestamp = new Date().toISOString();
    console.log(`Frame written to framebuffer at ${timestamp}`);
  });

  await page.evaluate(() => {
    const timeElement = document.querySelector('.time.large');

    if (!timeElement) {
      console.error('Could not find time element');
      return;
    }

    console.log('Found time element, setting up observer...');

    const observer = new MutationObserver((mutations) => {
      window.onClockChange();
    });

    observer.observe(timeElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    console.log('MutationObserver active');
  });

  console.log('Monitoring clock for changes. Press Ctrl+C to stop.');

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

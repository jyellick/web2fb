#!/usr/bin/env node

/**
 * Overlay Detection Helper
 *
 * Run this on a powerful machine to detect overlay positions and styles,
 * then copy the output to your Pi Zero 2 W config file.
 *
 * Usage:
 *   node tools/detect-overlays.js --url=https://... --selector=".time.large"
 *   node tools/detect-overlays.js --config=examples/dakboard.json
 */

const puppeteer = require('puppeteer');
const { loadConfig } = require('../lib/config');
const { detectOverlayRegion } = require('../lib/overlays');

async function detectOverlays(url, overlayConfigs, options = {}) {
  const {
    width = 1920,
    height = 1080,
    timeout = 180000,
    imageLoadTimeout = 120000,
    userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
  } = options;

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  console.log(`Setting viewport: ${width}x${height}`);
  await page.setViewport({ width, height });
  await page.setUserAgent(userAgent);

  console.log(`Loading page: ${url}`);
  await page.goto(url, {
    waitUntil: 'networkidle0',
    timeout
  });

  console.log('Waiting for images to load...');
  await page.waitForFunction(() => {
    const images = Array.from(document.images);
    return images.every(img => img.complete && img.naturalHeight !== 0);
  }, { timeout: imageLoadTimeout });

  console.log('Detecting overlays...');
  const detectedOverlays = [];

  for (const overlayConfig of overlayConfigs) {
    console.log(`\nDetecting overlay: ${overlayConfig.name} (${overlayConfig.selector})`);

    const detected = await detectOverlayRegion(page, overlayConfig);

    if (detected) {
      console.log(`✓ Found at (${detected.region.x}, ${detected.region.y}), size: ${detected.region.width}x${detected.region.height}`);
      console.log(`  Style:`, detected.detectedStyle);

      detectedOverlays.push({
        name: overlayConfig.name,
        type: overlayConfig.type,
        selector: overlayConfig.selector,
        enabled: overlayConfig.enabled !== false,
        updateInterval: overlayConfig.updateInterval || 1000,
        format: overlayConfig.format || {},

        // Pre-computed metadata (add this to your config)
        region: detected.region,
        detectedStyle: detected.detectedStyle,
        manualConfig: true // Flag to skip browser detection
      });
    } else {
      console.log(`✗ Not found (selector: ${overlayConfig.selector})`);
    }
  }

  await browser.close();

  return detectedOverlays;
}

async function main() {
  const args = process.argv.slice(2);

  // Parse command line arguments
  const urlArg = args.find(arg => arg.startsWith('--url='));
  const selectorArg = args.find(arg => arg.startsWith('--selector='));
  const configArg = args.find(arg => arg.startsWith('--config='));
  const nameArg = args.find(arg => arg.startsWith('--name='));
  const typeArg = args.find(arg => arg.startsWith('--type='));

  let url, overlayConfigs, options = {};

  if (configArg) {
    // Load from config file
    const configPath = configArg.split('=')[1];
    console.log(`Loading configuration from: ${configPath}\n`);

    const config = loadConfig(configPath);
    url = config.display.url;
    overlayConfigs = config.overlays || [];
    options = {
      width: config.display.width,
      height: config.display.height,
      timeout: config.browser?.timeout,
      imageLoadTimeout: config.browser?.imageLoadTimeout,
      userAgent: config.browser?.userAgent
    };
  } else if (urlArg && selectorArg) {
    // Manual specification
    url = urlArg.split('=')[1];
    overlayConfigs = [{
      name: nameArg ? nameArg.split('=')[1] : 'overlay',
      type: typeArg ? typeArg.split('=')[1] : 'clock',
      selector: selectorArg.split('=')[1],
      enabled: true,
      updateInterval: 1000
    }];
  } else {
    console.error('Usage:');
    console.error('  node tools/detect-overlays.js --config=examples/dakboard.json');
    console.error('  node tools/detect-overlays.js --url=https://... --selector=".time" --name=clock --type=clock');
    process.exit(1);
  }

  try {
    const detectedOverlays = await detectOverlays(url, overlayConfigs, options);

    console.log('\n' + '='.repeat(70));
    console.log('DETECTED OVERLAY METADATA');
    console.log('='.repeat(70));
    console.log('\nAdd this to your config.json "overlays" array:');
    console.log('\n' + JSON.stringify(detectedOverlays, null, 2));
    console.log('\n' + '='.repeat(70));
    console.log('\nWith this metadata in your config, the Pi Zero 2 W will skip');
    console.log('browser-based detection and use the pre-computed values.');
    console.log('No browser needed on the Pi!');
    console.log('='.repeat(70) + '\n');

  } catch (err) {
    console.error('Error detecting overlays:', err);
    process.exit(1);
  }
}

main();

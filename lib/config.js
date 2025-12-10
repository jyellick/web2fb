const fs = require('fs');
const path = require('path');

/**
 * Load and validate configuration
 * Priority: CLI arg > config file > environment variables > defaults
 */
function loadConfig(configPath = null) {
  let config = {};

  // Try to load from config file
  if (configPath) {
    try {
      const configFile = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configFile);
      console.log(`Loaded configuration from: ${configPath}`);
    } catch (err) {
      console.error(`Error loading config file ${configPath}:`, err.message);
      process.exit(1);
    }
  } else {
    // Try default config locations
    const defaultPaths = [
      './config.json',
      './web2fb.config.json',
      './.web2fb.json'
    ];

    for (const defaultPath of defaultPaths) {
      if (fs.existsSync(defaultPath)) {
        try {
          const configFile = fs.readFileSync(defaultPath, 'utf8');
          config = JSON.parse(configFile);
          console.log(`Loaded configuration from: ${defaultPath}`);
          break;
        } catch (err) {
          console.warn(`Failed to load ${defaultPath}:`, err.message);
        }
      }
    }
  }

  // Merge with environment variables and defaults
  config = mergeWithEnv(config);

  // Validate required fields
  if (!config.display || !config.display.url) {
    console.error('ERROR: display.url is required (set in config file or DISPLAY_URL environment variable)');
    process.exit(1);
  }

  // Apply defaults
  config = applyDefaults(config);

  return config;
}

/**
 * Merge config with environment variables
 * Environment variables take precedence
 */
function mergeWithEnv(config) {
  config.display = config.display || {};
  config.browser = config.browser || {};
  config.performance = config.performance || {};

  // Environment variable overrides
  if (process.env.DISPLAY_URL) {
    config.display.url = process.env.DISPLAY_URL;
  }
  if (process.env.WIDTH) {
    config.display.width = parseInt(process.env.WIDTH);
  }
  if (process.env.HEIGHT) {
    config.display.height = parseInt(process.env.HEIGHT);
  }
  if (process.env.FRAMEBUFFER_DEVICE) {
    config.display.framebufferDevice = process.env.FRAMEBUFFER_DEVICE;
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    config.browser.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  return config;
}

/**
 * Apply default values
 */
function applyDefaults(config) {
  // Display defaults
  config.display.width = config.display.width || 1920;
  config.display.height = config.display.height || 1080;
  config.display.framebufferDevice = config.display.framebufferDevice || '/dev/fb0';

  // Browser defaults
  config.browser.timeout = config.browser.timeout || 180000;
  config.browser.imageLoadTimeout = config.browser.imageLoadTimeout || 120000;
  config.browser.disableAnimations = config.browser.disableAnimations !== false;

  // Overlays default
  config.overlays = config.overlays || [];

  // Change detection defaults
  if (!config.changeDetection) {
    config.changeDetection = { enabled: true };
  }
  config.changeDetection.watchSelectors = config.changeDetection.watchSelectors || ['img', '[style*="background"]'];
  config.changeDetection.watchAttributes = config.changeDetection.watchAttributes || ['src', 'style', 'class', 'srcset'];
  config.changeDetection.periodicCheckInterval = config.changeDetection.periodicCheckInterval || 120000;
  config.changeDetection.debounceDelay = config.changeDetection.debounceDelay || 500;

  // Performance defaults
  config.performance.scrollToLoadLazy = config.performance.scrollToLoadLazy !== false;
  config.performance.waitForImages = config.performance.waitForImages !== false;
  config.performance.bufferPooling = config.performance.bufferPooling !== false;

  return config;
}

/**
 * Get enabled overlays
 */
function getEnabledOverlays(config) {
  return config.overlays.filter(overlay => overlay.enabled !== false);
}

module.exports = {
  loadConfig,
  getEnabledOverlays
};

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Load and validate configuration
 * Supports both JSON and YAML formats
 * Priority: CLI arg > config file > environment variables > defaults
 */
function loadConfig(configPath = null) {
  let config = {};

  // Try to load from config file
  if (configPath) {
    try {
      const configFile = fs.readFileSync(configPath, 'utf8');
      config = parseConfig(configFile, configPath);
      console.log(`Loaded configuration from: ${configPath}`);
    } catch (err) {
      console.error(`Error loading config file ${configPath}:`, err.message);
      process.exit(1);
    }
  } else {
    // Try default config locations (YAML first, then JSON)
    const defaultPaths = [
      './config.yaml',
      './config.yml',
      './web2fb.config.yaml',
      './web2fb.config.yml',
      './config.json',
      './web2fb.config.json',
      './.web2fb.json'
    ];

    for (const defaultPath of defaultPaths) {
      if (fs.existsSync(defaultPath)) {
        try {
          const configFile = fs.readFileSync(defaultPath, 'utf8');
          config = parseConfig(configFile, defaultPath);
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
 * Parse config file based on extension
 */
function parseConfig(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.yaml' || ext === '.yml') {
    return yaml.load(content);
  } else if (ext === '.json') {
    return JSON.parse(content);
  } else {
    // Try YAML first, fallback to JSON
    try {
      return yaml.load(content);
    } catch (_err) {
      return JSON.parse(content);
    }
  }
}

/**
 * Merge config with environment variables
 * Environment variables take precedence
 */
function mergeWithEnv(config) {
  config.display = config.display || {};
  config.browser = config.browser || {};

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

  // Browser mode default
  config.browser = config.browser || {};
  config.browser.mode = config.browser.mode || 'local';

  // Overlays default
  config.overlays = config.overlays || [];

  // Change detection default (simplified to boolean)
  if (config.changeDetection === undefined) {
    config.changeDetection = true;
  }

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

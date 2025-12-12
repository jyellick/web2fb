const { loadConfig, getEnabledOverlays } = require('../../lib/config');
const path = require('path');

// Mock process.env and fs
const originalEnv = process.env;

describe('Config Loading', () => {
  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
    delete process.env.DISPLAY_URL;
    delete process.env.WIDTH;
    delete process.env.HEIGHT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    it('should load config from file', () => {
      const configPath = path.join(__dirname, '../fixtures/test-config.json');
      const config = loadConfig(configPath);

      expect(config).toBeDefined();
      expect(config.display).toBeDefined();
      expect(config.display.url).toBe('https://example.com');
    });

    it('should merge environment variables', () => {
      process.env.DISPLAY_URL = 'https://env-override.com';
      process.env.WIDTH = '800';
      process.env.HEIGHT = '600';

      const configPath = path.join(__dirname, '../fixtures/test-config.json');
      const config = loadConfig(configPath);

      expect(config.display.url).toBe('https://env-override.com');
      expect(config.display.width).toBe(800);
      expect(config.display.height).toBe(600);
    });

    it('should apply default values', () => {
      const configPath = path.join(__dirname, '../fixtures/minimal-config.json');
      const config = loadConfig(configPath);

      expect(config.display.width).toBe(1920);
      expect(config.display.height).toBe(1080);
      expect(config.display.framebufferDevice).toBe('/dev/fb0');
      expect(config.browser.timeout).toBe(180000);
      expect(config.browser.disableAnimations).toBe(true);
    });

    it('should handle PUPPETEER_EXECUTABLE_PATH env var', () => {
      process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium';

      const configPath = path.join(__dirname, '../fixtures/test-config.json');
      const config = loadConfig(configPath);

      expect(config.browser.executablePath).toBe('/usr/bin/chromium');
    });

    it('should throw error if display.url is missing', () => {
      const originalExit = process.exit;
      process.exit = jest.fn();

      const configPath = path.join(__dirname, '../fixtures/no-url-config.json');

      // This will call process.exit(1)
      loadConfig(configPath);

      expect(process.exit).toHaveBeenCalledWith(1);
      process.exit = originalExit;
    });

    it('should initialize empty overlays array if not provided', () => {
      const configPath = path.join(__dirname, '../fixtures/minimal-config.json');
      const config = loadConfig(configPath);

      expect(config.overlays).toEqual([]);
    });

    it('should set default change detection values', () => {
      const configPath = path.join(__dirname, '../fixtures/minimal-config.json');
      const config = loadConfig(configPath);

      expect(config.changeDetection.enabled).toBe(true);
      expect(config.changeDetection.periodicCheckInterval).toBe(120000);
      expect(config.changeDetection.debounceDelay).toBe(500);
    });
  });

  describe('getEnabledOverlays', () => {
    it('should return only enabled overlays', () => {
      const config = {
        overlays: [
          { name: 'clock', enabled: true },
          { name: 'date', enabled: false },
          { name: 'text', enabled: true }
        ]
      };

      const enabled = getEnabledOverlays(config);

      expect(enabled).toHaveLength(2);
      expect(enabled[0].name).toBe('clock');
      expect(enabled[1].name).toBe('text');
    });

    it('should treat overlays without enabled property as enabled', () => {
      const config = {
        overlays: [
          { name: 'clock' },
          { name: 'date', enabled: true }
        ]
      };

      const enabled = getEnabledOverlays(config);

      expect(enabled).toHaveLength(2);
    });

    it('should return empty array if no overlays', () => {
      const config = { overlays: [] };
      const enabled = getEnabledOverlays(config);

      expect(enabled).toEqual([]);
    });
  });
});

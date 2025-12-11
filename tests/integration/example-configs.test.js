const { loadConfig } = require('../../lib/config');
const fs = require('fs');
const path = require('path');

describe('Example Configurations', () => {
  const examplesDir = path.join(__dirname, '../../examples');

  it('should have examples directory', () => {
    expect(fs.existsSync(examplesDir)).toBe(true);
  });

  describe('dakboard.json', () => {
    it('should load and validate successfully', () => {
      const configPath = path.join(examplesDir, 'dakboard.json');

      expect(fs.existsSync(configPath)).toBe(true);

      // Load without env vars (will use placeholder URL)
      const originalExit = process.exit;
      process.exit = jest.fn();

      // Set a valid URL to avoid exit
      process.env.DISPLAY_URL = 'https://dakboard.com/test';
      const config = loadConfig(configPath);
      process.env.DISPLAY_URL = undefined;

      process.exit = originalExit;

      expect(config).toBeDefined();
      expect(config.display).toBeDefined();
      expect(config.overlays).toBeDefined();
      expect(config.overlays.length).toBeGreaterThan(0);

      // Check clock overlay exists
      const clockOverlay = config.overlays.find(o => o.type === 'clock');
      expect(clockOverlay).toBeDefined();
      expect(clockOverlay.selector).toBe('.time.large');
    });

    it('should have proper schema reference', () => {
      const configPath = path.join(examplesDir, 'dakboard.json');
      const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      expect(content.$schema).toBe('../config.schema.json');
    });
  });

  describe('simple.json', () => {
    it('should load and validate successfully', () => {
      const configPath = path.join(examplesDir, 'simple.json');

      expect(fs.existsSync(configPath)).toBe(true);

      process.env.DISPLAY_URL = 'https://example.com';
      const config = loadConfig(configPath);
      process.env.DISPLAY_URL = undefined;

      expect(config).toBeDefined();
      expect(config.display).toBeDefined();
      expect(config.overlays).toEqual([]);
    });
  });

  describe('multi-overlay.json', () => {
    it('should load and validate successfully', () => {
      const configPath = path.join(examplesDir, 'multi-overlay.json');

      expect(fs.existsSync(configPath)).toBe(true);

      process.env.DISPLAY_URL = 'https://example.com/dashboard';
      const config = loadConfig(configPath);
      process.env.DISPLAY_URL = undefined;

      expect(config).toBeDefined();
      expect(config.overlays).toBeDefined();
      expect(config.overlays.length).toBeGreaterThan(1);

      // Check different overlay types exist
      const types = config.overlays.map(o => o.type);
      expect(types).toContain('clock');
      expect(types).toContain('date');
    });
  });

  describe('All Examples', () => {
    it('should have valid JSON in all example files', () => {
      const files = fs.readdirSync(examplesDir).filter(f => f.endsWith('.json'));

      expect(files.length).toBeGreaterThan(0);

      files.forEach(file => {
        const filePath = path.join(examplesDir, file);
        expect(() => {
          JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }).not.toThrow();
      });
    });
  });
});

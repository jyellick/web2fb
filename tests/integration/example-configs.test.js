const { loadConfig } = require('../../lib/config');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

describe('Example Configurations', () => {
  const examplesDir = path.join(__dirname, '../../examples');

  it('should have examples directory', () => {
    expect(fs.existsSync(examplesDir)).toBe(true);
  });

  describe('dakboard.yaml', () => {
    it('should load and validate successfully', () => {
      const configPath = path.join(examplesDir, 'dakboard.yaml');

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
  });

  describe('simple.yaml', () => {
    it('should load and validate successfully', () => {
      const configPath = path.join(examplesDir, 'simple.yaml');

      expect(fs.existsSync(configPath)).toBe(true);

      process.env.DISPLAY_URL = 'https://example.com';
      const config = loadConfig(configPath);
      process.env.DISPLAY_URL = undefined;

      expect(config).toBeDefined();
      expect(config.display).toBeDefined();
      expect(config.overlays).toEqual([]);
    });
  });

  describe('multi-overlay.yaml', () => {
    it('should load and validate successfully', () => {
      const configPath = path.join(examplesDir, 'multi-overlay.yaml');

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
    it('should have valid YAML in all example files', () => {
      const files = fs.readdirSync(examplesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

      expect(files.length).toBeGreaterThan(0);

      files.forEach(file => {
        const filePath = path.join(examplesDir, file);
        expect(() => {
          yaml.load(fs.readFileSync(filePath, 'utf8'));
        }).not.toThrow();
      });
    });
  });
});

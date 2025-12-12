const ClockCache = require('../../lib/clock-cache');
const sharp = require('sharp');

describe('ClockCache', () => {
  let mockBaseRegionBuffer;
  let mockOverlay;
  let mockRegion;

  beforeEach(async () => {
    // Create a simple test image as base region
    mockBaseRegionBuffer = await sharp({
      create: {
        width: 200,
        height: 50,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    })
      .png()
      .toBuffer();

    mockOverlay = {
      name: 'test-clock',
      type: 'clock',
      format: {
        hour12: false,
        showSeconds: true
      },
      style: {
        fontSize: 48,
        color: '#ffffff',
        fontFamily: 'monospace'
      }
    };

    mockRegion = {
      x: 10,
      y: 10,
      width: 200,
      height: 50
    };
  });

  describe('Constructor', () => {
    it('should create clock cache with overlay and base region', () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      expect(cache.overlay).toBe(mockOverlay);
      expect(cache.baseRegionBuffer).toBe(mockBaseRegionBuffer);
      expect(cache.region).toBe(mockRegion);
      expect(cache.frames).toEqual({});
      expect(cache.valid).toBe(false);
    });
  });

  describe('preRender()', () => {
    it('should pre-render 60 clock states', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();

      expect(Object.keys(cache.frames).length).toBe(60);
      expect(cache.valid).toBe(true);
    });

    it('should create frames for seconds 00-59', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();

      for (let i = 0; i < 60; i++) {
        const key = i.toString().padStart(2, '0');
        expect(cache.frames[key]).toBeDefined();
        expect(Buffer.isBuffer(cache.frames[key])).toBe(true);
      }
    });

    it('should generate different buffers for different seconds', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();

      // Frames should be different (different time = different image)
      expect(cache.frames['00']).not.toEqual(cache.frames['30']);
    });

    it('should mark cache as valid after pre-rendering', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      expect(cache.valid).toBe(false);

      await cache.preRender();

      expect(cache.valid).toBe(true);
    });
  });

  describe('getFrame()', () => {
    it('should return null if cache is not valid', () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      const frame = cache.getFrame(new Date('2025-01-15T10:30:45'));

      expect(frame).toBe(null);
    });

    it('should return correct frame for given time', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      await cache.preRender();

      const frame = cache.getFrame(new Date('2025-01-15T10:30:45'));

      expect(frame).toBe(cache.frames['45']);
    });

    it('should use current time if no date provided', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      await cache.preRender();

      const now = new Date();
      const expectedKey = now.getSeconds().toString().padStart(2, '0');

      const frame = cache.getFrame();

      expect(frame).toBe(cache.frames[expectedKey]);
    });

    it('should handle edge cases (second 00 and 59)', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      await cache.preRender();

      const frame00 = cache.getFrame(new Date('2025-01-15T10:30:00'));
      const frame59 = cache.getFrame(new Date('2025-01-15T10:30:59'));

      expect(frame00).toBe(cache.frames['00']);
      expect(frame59).toBe(cache.frames['59']);
    });
  });

  describe('isValid()', () => {
    it('should return false before pre-rendering', () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      expect(cache.isValid()).toBe(false);
    });

    it('should return true after pre-rendering', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();

      expect(cache.isValid()).toBe(true);
    });

    it('should return false after invalidation', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();
      expect(cache.isValid()).toBe(true);

      cache.invalidate();
      expect(cache.isValid()).toBe(false);
    });
  });

  describe('invalidate()', () => {
    it('should clear frames and mark cache as invalid', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();
      expect(Object.keys(cache.frames).length).toBe(60);
      expect(cache.valid).toBe(true);

      cache.invalidate();

      expect(cache.frames).toEqual({});
      expect(cache.valid).toBe(false);
    });

    it('should be safe to call multiple times', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();
      cache.invalidate();
      cache.invalidate();

      expect(cache.frames).toEqual({});
      expect(cache.valid).toBe(false);
    });
  });

  describe('updateBaseRegion()', () => {
    it('should update base region buffer and invalidate cache', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();
      expect(cache.isValid()).toBe(true);

      const newBaseRegion = await sharp({
        create: {
          width: 200,
          height: 50,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 }
        }
      })
        .png()
        .toBuffer();

      cache.updateBaseRegion(newBaseRegion);

      expect(cache.baseRegionBuffer).toBe(newBaseRegion);
      expect(cache.isValid()).toBe(false);
    });
  });

  describe('Memory management', () => {
    it('should not leak memory when invalidating', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();
      const initialFrames = Object.keys(cache.frames).length;

      cache.invalidate();
      await cache.preRender();

      expect(Object.keys(cache.frames).length).toBe(initialFrames);
    });
  });

  describe('Integration with different clock formats', () => {
    it('should handle 12-hour format', async () => {
      const overlay12h = {
        ...mockOverlay,
        format: {
          hour12: true,
          showSeconds: true
        }
      };

      const cache = new ClockCache(overlay12h, mockBaseRegionBuffer, mockRegion);
      await cache.preRender();

      expect(cache.isValid()).toBe(true);
      expect(Object.keys(cache.frames).length).toBe(60);
    });

    it('should handle format without seconds', async () => {
      const overlayNoSeconds = {
        ...mockOverlay,
        format: {
          hour12: false,
          showSeconds: false
        }
      };

      const cache = new ClockCache(overlayNoSeconds, mockBaseRegionBuffer, mockRegion);
      await cache.preRender();

      // Even without seconds displayed, we still cache by second
      // to support smooth transitions when seconds are re-enabled
      expect(cache.isValid()).toBe(true);
      expect(Object.keys(cache.frames).length).toBe(60);
    });
  });
});

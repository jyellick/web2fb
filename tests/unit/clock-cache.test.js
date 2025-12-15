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
      expect(cache.detectedStyle).toEqual({});
      expect(cache.frames).toBeInstanceOf(Map);
      expect(cache.frames.size).toBe(0);
      expect(cache.valid).toBe(false);
      expect(cache.windowSize).toBe(10);
    });

    it('should store detected style when provided', () => {
      const detectedStyle = {
        fontSize: 48,
        fontWeight: 'bold',
        color: '#ff0000'
      };

      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion, detectedStyle);

      expect(cache.detectedStyle).toEqual(detectedStyle);
    });
  });

  describe('preRender()', () => {
    it('should pre-render windowSize frames by default', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();

      expect(cache.frames.size).toBe(cache.windowSize);
      expect(cache.valid).toBe(true);
    });

    it('should create frames starting from current second', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const startTime = new Date();
      const startSecond = Math.floor(startTime.getTime() / 1000);

      await cache.preRender();

      // Should have frames for next windowSize seconds
      for (let i = 0; i < cache.windowSize; i++) {
        const frameSecond = startSecond + i;
        expect(cache.frames.has(frameSecond)).toBe(true);
        const frame = cache.frames.get(frameSecond);
        expect(frame).toHaveProperty('buffer');
        expect(frame).toHaveProperty('width');
        expect(frame).toHaveProperty('height');
        expect(frame).toHaveProperty('channels');
        expect(Buffer.isBuffer(frame.buffer)).toBe(true);
      }
    });

    it('should allow pre-rendering from specific time', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const specificTime = new Date('2025-01-15T10:30:00');
      const startSecond = Math.floor(specificTime.getTime() / 1000);

      await cache.preRender(specificTime);

      // Should have windowSize frames starting from specific time
      expect(cache.frames.size).toBe(cache.windowSize);
      expect(cache.frames.has(startSecond)).toBe(true);
      expect(cache.frames.has(startSecond + cache.windowSize - 1)).toBe(true);
    });

    it('should allow custom frame count', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender(new Date(), 30);

      expect(cache.frames.size).toBe(30);
    });

    it('should generate different buffers for different seconds', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const startTime = new Date();
      const startSecond = Math.floor(startTime.getTime() / 1000);

      await cache.preRender(startTime);

      // Frames should be different (different time = different image)
      const frame0 = cache.frames.get(startSecond);
      const frame30 = cache.frames.get(startSecond + 30);
      expect(frame0).not.toEqual(frame30);
    });

    it('should mark cache as valid after pre-rendering', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      expect(cache.valid).toBe(false);

      await cache.preRender();

      expect(cache.valid).toBe(true);
    });

    it('should track window boundaries', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const startTime = new Date();
      const startSecond = Math.floor(startTime.getTime() / 1000);

      await cache.preRender(startTime);

      expect(cache.windowStart).toBe(startSecond);
      expect(cache.windowEnd).toBe(startSecond + cache.windowSize - 1);
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
      const testTime = new Date('2025-01-15T10:30:00');
      await cache.preRender(testTime);

      // Request a frame within the window (e.g., 5 seconds in)
      const requestTime = new Date('2025-01-15T10:30:05');
      const frame = cache.getFrame(requestTime);

      const expectedSecond = Math.floor(requestTime.getTime() / 1000);
      expect(frame).toBe(cache.frames.get(expectedSecond));
      expect(frame).not.toBe(null);
    });

    it('should use current time if no date provided', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const now = new Date();
      await cache.preRender(now);

      const frame = cache.getFrame();

      expect(frame).not.toBe(null);
      expect(frame).toHaveProperty('buffer');
      expect(Buffer.isBuffer(frame.buffer)).toBe(true);
    });

    it('should return null if requested time is outside window', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      await cache.preRender(testTime, 5); // Only 5 seconds

      const outsideTime = new Date('2025-01-15T10:30:10'); // 10 seconds later
      const frame = cache.getFrame(outsideTime);

      expect(frame).toBe(null);
    });

    it('should return frames at window boundaries', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      await cache.preRender(testTime);

      const firstFrame = cache.getFrame(testTime);
      const midTime = new Date(testTime.getTime() + 5 * 1000);
      const midFrame = cache.getFrame(midTime);

      expect(firstFrame).not.toBe(null);
      expect(midFrame).not.toBe(null);
      // Different times should produce different buffers
      expect(firstFrame).not.toBe(midFrame);
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
      expect(cache.frames.size).toBe(cache.windowSize);
      expect(cache.valid).toBe(true);

      cache.invalidate();

      expect(cache.frames.size).toBe(0);
      expect(cache.valid).toBe(false);
      expect(cache.windowStart).toBe(null);
      expect(cache.windowEnd).toBe(null);
    });

    it('should be safe to call multiple times', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();
      cache.invalidate();
      cache.invalidate();

      expect(cache.frames.size).toBe(0);
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
      const initialFrames = cache.frames.size;

      cache.invalidate();
      await cache.preRender();

      expect(cache.frames.size).toBe(initialFrames);
    });

    it('should cleanup old frames when extending window', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      const initialSize = 20;
      await cache.preRender(testTime, initialSize);

      expect(cache.frames.size).toBe(initialSize);

      // Move forward past windowSize and extend
      const laterTime = new Date('2025-01-15T10:30:15');
      const extendCount = 10;
      await cache.extendWindow(extendCount, laterTime);

      // After extending and cleanup, should maintain windowSize frames
      expect(cache.frames.size).toBeLessThanOrEqual(cache.windowSize);
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
      expect(cache.frames.size).toBe(cache.windowSize);
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
      expect(cache.frames.size).toBe(cache.windowSize);
    });
  });

  describe('needsMoreFrames()', () => {
    it('should return true if cache is not valid', () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      expect(cache.needsMoreFrames()).toBe(true);
    });

    it('should return false when at target window size', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      await cache.preRender(testTime, cache.windowSize);

      // At the start, we have exactly windowSize frames ahead
      const result = cache.needsMoreFrames(testTime);
      expect(result).toBe(false);
    });

    it('should return true when frames ahead below target', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      await cache.preRender(testTime, cache.windowSize);

      // 1 second later, one less frame ahead (< windowSize)
      const laterTime = new Date('2025-01-15T10:30:01');
      const result = cache.needsMoreFrames(laterTime);
      expect(result).toBe(true);
    });

    it('should use current time if no date provided', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      await cache.preRender();

      // Should not need more frames if we just pre-rendered full windowSize
      expect(cache.needsMoreFrames()).toBe(false);
    });

    it('should return true when current time is past window end', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      await cache.preRender(testTime, 60);

      // 61 seconds later, we're past the window
      const pastTime = new Date('2025-01-15T10:31:01');
      const result = cache.needsMoreFrames(pastTime);
      expect(result).toBe(true);
    });
  });

  describe('extendWindow()', () => {
    it('should add 1 frame by default', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      const initialCount = 5;
      await cache.preRender(testTime, initialCount);

      expect(cache.frames.size).toBe(initialCount);

      await cache.extendWindow(); // Default: 1 frame

      expect(cache.frames.size).toBe(initialCount + 1);
    });

    it('should allow custom frame count when below windowSize', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      const initialCount = 3;
      await cache.preRender(testTime, initialCount);

      expect(cache.frames.size).toBe(initialCount);

      await cache.extendWindow(5); // Generate 5 frames

      expect(cache.frames.size).toBe(initialCount + 5);
    });

    it('should extend from current window end', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      const startSecond = Math.floor(testTime.getTime() / 1000);
      const initialCount = 5;
      await cache.preRender(testTime, initialCount);

      expect(cache.windowEnd).toBe(startSecond + initialCount - 1);

      await cache.extendWindow(1);

      // Window should now end 1 second later
      expect(cache.windowEnd).toBe(startSecond + initialCount);
      expect(cache.frames.has(startSecond + initialCount)).toBe(true);
    });

    it('should cleanup old frames when extending', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      const startSecond = Math.floor(testTime.getTime() / 1000);
      await cache.preRender(testTime, cache.windowSize);

      // Move forward half the window size
      const moveForward = Math.floor(cache.windowSize / 2);
      const laterTime = new Date(testTime.getTime() + moveForward * 1000);
      await cache.extendWindow(moveForward, laterTime);

      // Old frames (before current time) should be removed
      expect(cache.frames.has(startSecond)).toBe(false);
      // Frames near current time and forward should exist
      const laterSecond = Math.floor(laterTime.getTime() / 1000);
      expect(cache.frames.has(laterSecond)).toBe(true);
      // Should not exceed windowSize
      expect(cache.frames.size).toBeLessThanOrEqual(cache.windowSize);
    });
  });
});

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
      expect(cache.windowSize).toBe(60);
      expect(cache.preRenderThreshold).toBe(30);
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
    it('should pre-render 60 clock states by default', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      await cache.preRender();

      expect(cache.frames.size).toBe(60);
      expect(cache.valid).toBe(true);
    });

    it('should create frames starting from current second', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const startTime = new Date();
      const startSecond = Math.floor(startTime.getTime() / 1000);

      await cache.preRender();

      // Should have frames for next 60 seconds
      for (let i = 0; i < 60; i++) {
        const frameSecond = startSecond + i;
        expect(cache.frames.has(frameSecond)).toBe(true);
        expect(Buffer.isBuffer(cache.frames.get(frameSecond))).toBe(true);
      }
    });

    it('should allow pre-rendering from specific time', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const specificTime = new Date('2025-01-15T10:30:00');
      const startSecond = Math.floor(specificTime.getTime() / 1000);

      await cache.preRender(specificTime);

      // Should have 60 frames starting from specific time
      expect(cache.frames.size).toBe(60);
      expect(cache.frames.has(startSecond)).toBe(true);
      expect(cache.frames.has(startSecond + 59)).toBe(true);
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
      expect(cache.windowEnd).toBe(startSecond + 59);
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

      const requestTime = new Date('2025-01-15T10:30:45');
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
      expect(Buffer.isBuffer(frame)).toBe(true);
    });

    it('should return null if requested time is outside window', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      await cache.preRender(testTime, 30); // Only 30 seconds

      const outsideTime = new Date('2025-01-15T10:31:00'); // 60 seconds later
      const frame = cache.getFrame(outsideTime);

      expect(frame).toBe(null);
    });

    it('should return frames at window boundaries', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      await cache.preRender(testTime);

      const firstFrame = cache.getFrame(testTime);
      const lastFrame = cache.getFrame(new Date('2025-01-15T10:30:59'));

      expect(firstFrame).not.toBe(null);
      expect(lastFrame).not.toBe(null);
      expect(firstFrame).not.toEqual(lastFrame);
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
      expect(cache.frames.size).toBe(60);
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
      await cache.preRender(testTime, 60);

      expect(cache.frames.size).toBe(60);

      // Move forward 31 seconds and extend
      const laterTime = new Date('2025-01-15T10:30:31');
      await cache.extendWindow(30, laterTime);

      // After extending and cleanup:
      // - Started with frames 0-59 (60 frames)
      // - Extended to frames 60-89 (30 more = 90 total)
      // - Cleanup removed frames 0-30 (31 frames before current time)
      // - Result: frames 31-89 (59 frames)
      expect(cache.frames.size).toBe(59);
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
      expect(cache.frames.size).toBe(60);
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
      expect(cache.frames.size).toBe(60);
    });
  });

  describe('needsMoreFrames()', () => {
    it('should return true if cache is not valid', () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);

      expect(cache.needsMoreFrames()).toBe(true);
    });

    it('should return false when plenty of frames remain', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      await cache.preRender(testTime, 60);

      // At the start, we have 60 frames remaining
      const result = cache.needsMoreFrames(testTime);
      expect(result).toBe(false);
    });

    it('should return true when frames remaining below threshold', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      await cache.preRender(testTime, 60);

      // 31 seconds later, only 29 frames remain (below 30 threshold)
      const laterTime = new Date('2025-01-15T10:30:31');
      const result = cache.needsMoreFrames(laterTime);
      expect(result).toBe(true);
    });

    it('should use current time if no date provided', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      await cache.preRender();

      // Should not need more frames if we just pre-rendered
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
    it('should add more frames to the window', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      await cache.preRender(testTime, 30);

      expect(cache.frames.size).toBe(30);

      await cache.extendWindow(30);

      expect(cache.frames.size).toBe(60);
    });

    it('should extend from current window end', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      const startSecond = Math.floor(testTime.getTime() / 1000);
      await cache.preRender(testTime, 30);

      expect(cache.windowEnd).toBe(startSecond + 29);

      await cache.extendWindow(30);

      // Window should now end 59 seconds from start
      expect(cache.windowEnd).toBe(startSecond + 59);
      expect(cache.frames.has(startSecond + 59)).toBe(true);
    });

    it('should cleanup old frames when extending', async () => {
      const cache = new ClockCache(mockOverlay, mockBaseRegionBuffer, mockRegion);
      const testTime = new Date('2025-01-15T10:30:00');
      const startSecond = Math.floor(testTime.getTime() / 1000);
      await cache.preRender(testTime, 60);

      // Move forward 31 seconds
      const laterTime = new Date('2025-01-15T10:30:31');
      await cache.extendWindow(30, laterTime);

      // Old frames (before current time) should be removed
      expect(cache.frames.has(startSecond)).toBe(false);
      expect(cache.frames.has(startSecond + 30)).toBe(false);
      // Current and future frames should exist
      expect(cache.frames.has(startSecond + 31)).toBe(true);
      expect(cache.frames.has(startSecond + 89)).toBe(true);
    });
  });
});

/**
 * Clock Cache - Pre-renders clock frames using rolling window approach
 *
 * Instead of tying to minute boundaries, this cache uses a rolling window:
 * - Pre-renders N frames (default 60) starting from current second
 * - When frames remaining < threshold (default 30), extends window in background
 * - Cleans up old frames to maintain constant memory usage
 * - No spikes at minute boundaries - smooth, distributed pre-rendering
 */

const sharp = require('sharp');
const { generateOverlay } = require('./overlays');

class ClockCache {
  constructor(overlay, baseRegionBuffer, region, style = {}, rawMetadata = null) {
    this.overlay = overlay;
    this.baseRegionBuffer = baseRegionBuffer;
    this.region = region;
    this.style = style;
    this.rawMetadata = rawMetadata; // { width, height, channels } for raw pixel buffers
    this.frames = new Map(); // key: seconds since epoch, value: buffer
    this.valid = false;
    this.windowStart = null;
    this.windowEnd = null;
    this.windowSize = 10; // Target number of frames to keep in cache (10 seconds ahead)
    this.needsResize = null; // Cache whether resize is needed (null = unknown)
  }

  /**
   * Pre-render clock frames starting from a specific time
   * @param {Date} startTime - Time to start rendering from (defaults to now)
   * @param {number} count - Number of frames to render (defaults to windowSize)
   */
  async preRender(startTime = new Date(), count = this.windowSize) {
    this.frames.clear();

    // Use region dimensions (already known)
    const baseWidth = this.region.width;
    const baseHeight = this.region.height;

    const startSecond = Math.floor(startTime.getTime() / 1000);

    // Generate frames for each second in the window
    for (let i = 0; i < count; i++) {
      const frameSecond = startSecond + i;
      const frameTime = new Date(frameSecond * 1000);

      // Generate clock overlay for this specific time
      const overlay = {
        ...this.overlay,
        style: this.style,
        _renderTime: frameTime // Pass time to overlay generator
      };

      const overlayBuffer = generateOverlay(overlay, this.region);

      // Check dimensions on first frame to determine if resize is needed
      if (this.needsResize === null) {
        const overlayMeta = await sharp(overlayBuffer).metadata();
        this.needsResize = (overlayMeta.width !== baseWidth ||
                           overlayMeta.height !== baseHeight);
      }

      // Only resize if we detected a dimension mismatch
      let finalOverlay = overlayBuffer;
      if (this.needsResize) {
        finalOverlay = await sharp(overlayBuffer)
          .resize(baseWidth, baseHeight, {
            fit: 'fill',
            kernel: 'nearest'
          })
          .toBuffer();
      }

      // Composite overlay onto base region
      // If rawMetadata is provided, buffer is raw pixels; otherwise it's PNG
      let compositeImage;
      if (this.rawMetadata) {
        // Create sharp instance from raw pixel buffer
        compositeImage = await sharp(this.baseRegionBuffer, {
          raw: {
            width: this.rawMetadata.width,
            height: this.rawMetadata.height,
            channels: this.rawMetadata.channels
          }
        })
          .composite([{ input: finalOverlay }])
          .raw()
          .toBuffer();
      } else {
        // Buffer is already PNG format
        compositeImage = await sharp(this.baseRegionBuffer)
          .ensureAlpha()
          .composite([{ input: finalOverlay }])
          .raw()
          .toBuffer();
      }

      // Store raw buffer with known format (always RGBA after ensureAlpha)
      this.frames.set(frameSecond, {
        buffer: compositeImage,
        width: this.region.width,
        height: this.region.height,
        channels: 4  // Always 4 channels (RGBA) due to ensureAlpha()
      });
    }

    this.valid = true;
    this.windowStart = startSecond;
    this.windowEnd = startSecond + count - 1;
  }

  /**
   * Extend the window by rendering more frames
   * Generate small batches (default 1) to avoid blocking and frame drops
   * @param {number} count - Number of additional frames to render (default 1)
   * @param {Date} currentTime - Current time (for cleanup)
   */
  async extendWindow(count = 1, currentTime = new Date()) {
    if (!this.valid || this.windowEnd === null) {
      // No existing window, just pre-render initial batch
      await this.preRender(currentTime, this.windowSize);
      return;
    }

    // Ensure base region metadata is cached
    if (!this.baseRegionMetadata) {
      this.baseRegionMetadata = await sharp(this.baseRegionBuffer).metadata();
    }

    const currentSecond = Math.floor(currentTime.getTime() / 1000);

    // Render new frames starting from windowEnd + 1
    const startSecond = this.windowEnd + 1;
    for (let i = 0; i < count; i++) {
      const frameSecond = startSecond + i;
      const frameTime = new Date(frameSecond * 1000);

      const overlay = {
        ...this.overlay,
        style: this.style,
        _renderTime: frameTime
      };

      const overlayBuffer = generateOverlay(overlay, this.region);

      // Check dimensions on first frame to determine if resize is needed
      if (this.needsResize === null) {
        const overlayMeta = await sharp(overlayBuffer).metadata();
        this.needsResize = (overlayMeta.width !== this.baseRegionMetadata.width ||
                           overlayMeta.height !== this.baseRegionMetadata.height);
      }

      // Only resize if we detected a dimension mismatch
      let finalOverlay = overlayBuffer;
      if (this.needsResize) {
        finalOverlay = await sharp(overlayBuffer)
          .resize(this.baseRegionMetadata.width, this.baseRegionMetadata.height, {
            fit: 'fill',
            kernel: 'nearest'
          })
          .toBuffer();
      }

      // Use raw buffers for much faster caching (no PNG compression overhead)
      // Force RGBA format for consistency (avoid metadata mismatch across pages)
      // ensureAlpha() guarantees 4 channels output, avoiding Sharp's auto-conversion
      const compositeImage = await sharp(this.baseRegionBuffer)
        .ensureAlpha()  // Force RGBA (4 channels) before composite
        .composite([{ input: finalOverlay }])
        .raw()
        .toBuffer();

      // Store raw buffer with known format (always RGBA after ensureAlpha)
      this.frames.set(frameSecond, {
        buffer: compositeImage,
        width: this.region.width,
        height: this.region.height,
        channels: 4  // Always 4 channels (RGBA) due to ensureAlpha()
      });
    }

    this.windowEnd = startSecond + count - 1;

    // Cleanup old frames (before current time) to maintain windowSize
    const targetSize = this.windowSize;
    if (this.frames.size > targetSize) {
      // Remove frames before current time
      for (const [frameSecond] of this.frames) {
        if (frameSecond < currentSecond) {
          this.frames.delete(frameSecond);
        }
      }

      // If still over size, remove oldest frames
      if (this.frames.size > targetSize) {
        const sortedKeys = Array.from(this.frames.keys()).sort((a, b) => a - b);
        const toRemove = this.frames.size - targetSize;
        for (let i = 0; i < toRemove; i++) {
          this.frames.delete(sortedKeys[i]);
        }
      }

      // Update windowStart to reflect oldest frame still in cache
      const sortedKeys = Array.from(this.frames.keys()).sort((a, b) => a - b);
      if (sortedKeys.length > 0) {
        this.windowStart = sortedKeys[0];
      }
    }
  }

  /**
   * Get the pre-rendered frame for a specific time
   * @param {Date} date - The time to get the frame for (defaults to now)
   * @returns {Object|null} - The pre-rendered frame object {buffer, width, height, channels}, or null if not in cache
   */
  getFrame(date = new Date()) {
    if (!this.valid) {
      return null;
    }

    const requestSecond = Math.floor(date.getTime() / 1000);
    return this.frames.get(requestSecond) || null;
  }

  /**
   * Check if cache is valid
   */
  isValid() {
    return this.valid;
  }

  /**
   * Check if cache needs more frames (rolling window extension)
   * Generate 1 frame at a time when below target to avoid blocking
   * @param {Date} date - The time to check (defaults to now)
   * @returns {boolean} - True if we should generate another frame
   */
  needsMoreFrames(date = new Date()) {
    if (!this.valid) {
      return true; // Not yet rendered
    }

    const currentSecond = Math.floor(date.getTime() / 1000);
    // +1 because windowEnd is inclusive (frames include both current and end)
    const framesAhead = this.windowEnd - currentSecond + 1;

    // Keep generating while we have less than windowSize frames ahead
    // This spreads the pre-rendering load evenly instead of batches
    return framesAhead < this.windowSize;
  }

  /**
   * Invalidate cache (e.g., when base image changes)
   */
  invalidate() {
    this.frames.clear();
    this.valid = false;
    this.windowStart = null;
    this.windowEnd = null;
    this.baseRegionMetadata = null; // Clear cached metadata
    this.needsResize = null; // Reset resize detection
  }

  /**
   * Update base region buffer and invalidate cache
   */
  updateBaseRegion(newBaseRegionBuffer) {
    this.baseRegionBuffer = newBaseRegionBuffer;
    this.baseRegionMetadata = null; // Clear cached metadata since base changed
    this.needsResize = null; // Reset resize detection
    this.invalidate();
  }
}

module.exports = ClockCache;

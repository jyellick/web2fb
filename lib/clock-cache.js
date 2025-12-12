/**
 * Clock Cache - Pre-renders clock frames to eliminate compositing overhead
 *
 * For clock overlays, we can pre-render all 60 possible states (one per second)
 * and simply select the correct frame when updating. This eliminates the expensive
 * Sharp composite operation (~100ms on Pi Zero 2 W) from the hot path.
 */

const sharp = require('sharp');
const { generateOverlay } = require('./overlays');

class ClockCache {
  constructor(overlay, baseRegionBuffer, region, detectedStyle = {}) {
    this.overlay = overlay;
    this.baseRegionBuffer = baseRegionBuffer;
    this.region = region;
    this.detectedStyle = detectedStyle;
    this.frames = {};
    this.valid = false;
  }

  /**
   * Pre-render all 60 clock states (one for each second)
   */
  async preRender() {
    this.frames = {};

    // Create a reference date for generating times
    const baseDate = new Date('2025-01-15T10:30:00');

    // Generate frames for each second (00-59)
    for (let second = 0; second < 60; second++) {
      const date = new Date(baseDate);
      date.setSeconds(second);

      const key = second.toString().padStart(2, '0');

      // Generate clock overlay for this specific time
      // Merge detected style with overlay style (same as live rendering)
      const overlay = {
        ...this.overlay,
        style: { ...this.detectedStyle, ...this.overlay.style },
        _renderTime: date // Pass time to overlay generator
      };

      const overlayBuffer = generateOverlay(overlay, this.region);

      // Composite overlay onto base region
      const compositeImage = await sharp(this.baseRegionBuffer)
        .composite([{ input: overlayBuffer }])
        .png()
        .toBuffer();

      this.frames[key] = compositeImage;
    }

    this.valid = true;
  }

  /**
   * Get the pre-rendered frame for a specific time
   * @param {Date} date - The time to get the frame for (defaults to now)
   * @returns {Buffer|null} - The pre-rendered frame buffer, or null if cache invalid
   */
  getFrame(date = new Date()) {
    if (!this.valid) {
      return null;
    }

    const second = date.getSeconds();
    const key = second.toString().padStart(2, '0');

    return this.frames[key] || null;
  }

  /**
   * Check if cache is valid
   */
  isValid() {
    return this.valid;
  }

  /**
   * Invalidate cache (e.g., when base image changes)
   */
  invalidate() {
    this.frames = {};
    this.valid = false;
  }

  /**
   * Update base region buffer and invalidate cache
   */
  updateBaseRegion(newBaseRegionBuffer) {
    this.baseRegionBuffer = newBaseRegionBuffer;
    this.invalidate();
  }
}

module.exports = ClockCache;

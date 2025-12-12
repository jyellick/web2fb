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
   * Pre-render all 60 clock states for the CURRENT minute
   * Must be called every minute to keep frames up-to-date
   */
  async preRender() {
    this.frames = {};

    // Use current time to get current hour and minute
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const currentDay = now.getDate();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Generate frames for each second (00-59) of the CURRENT minute
    for (let second = 0; second < 60; second++) {
      const date = new Date(currentYear, currentMonth, currentDay, currentHour, currentMinute, second);
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
    this.lastPreRenderMinute = currentMinute;
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
   * Check if cache needs re-rendering due to minute change
   * @param {Date} date - The time to check (defaults to now)
   * @returns {boolean} - True if minute has changed and re-render is needed
   */
  needsReRender(date = new Date()) {
    if (!this.valid) {
      return true; // Not yet rendered
    }

    const currentMinute = date.getMinutes();
    return currentMinute !== this.lastPreRenderMinute;
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

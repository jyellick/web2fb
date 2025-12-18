/**
 * Framebuffer Renderer
 *
 * Pre-renders framebuffer operations for specific display times.
 * Handles both full updates (entire framebuffer) and partial updates
 * (overlay regions only).
 */

const sharp = require('sharp');
const { generateOverlay } = require('./overlays');

class FramebufferRenderer {
  constructor(config, perfMonitor) {
    this.config = config;
    this.perfMonitor = perfMonitor;
  }

  /**
   * Render a full framebuffer update (base + all overlays composited)
   * @param {Buffer} baseImageBuffer - PNG buffer of base image
   * @param {Array} overlays - Array of overlay configs
   * @param {Map} overlayStates - Map of overlay name -> { region, style, baseRegionBuffer }
   * @param {number} displayTime - Unix timestamp (ms) when this should display
   * @returns {Object} { type: 'full', buffer, displayTime }
   */
  async renderFullUpdate(baseImageBuffer, overlays, overlayStates, displayTime) {
    const perfOpId = this.perfMonitor?.start('render:fullUpdate', { displayTime });

    let currentImage = sharp(baseImageBuffer);
    const composites = [];

    for (const overlay of overlays) {
      if (!overlay.enabled) continue;

      const state = overlayStates.get(overlay.name);
      if (!state || !state.baseRegionBuffer) continue;

      const { region } = state;

      // Generate overlay for specific display time
      const mergedOverlay = {
        ...overlay,
        style: state.style,
        _renderTime: new Date(displayTime) // Pass time to overlay generator
      };

      const overlayBuffer = generateOverlay(mergedOverlay, region);

      composites.push({
        input: overlayBuffer,
        top: region.y,
        left: region.x
      });
    }

    if (composites.length > 0) {
      currentImage = currentImage.composite(composites);
    }

    const buffer = await currentImage.png().toBuffer();

    this.perfMonitor?.end(perfOpId, { bufferSize: buffer.length });

    return {
      type: 'full',
      buffer,
      displayTime
    };
  }

  /**
   * Render a partial framebuffer update (overlay region only)
   * @param {Object} overlay - Overlay config
   * @param {Object} state - Overlay state { region, style, baseRegionBuffer, rawMetadata }
   * @param {number} displayTime - Unix timestamp (ms) when this should display
   * @returns {Object} { type: 'partial', buffer, region, displayTime }
   */
  async renderPartialUpdate(overlay, state, displayTime) {
    const perfOpId = this.perfMonitor?.start('render:partialUpdate', {
      name: overlay.name,
      displayTime
    });

    const { region, baseRegionBuffer, rawMetadata } = state;

    // Generate overlay for specific display time
    const mergedOverlay = {
      ...overlay,
      style: state.style,
      _renderTime: new Date(displayTime)
    };

    const overlayBuffer = generateOverlay(mergedOverlay, region);

    // Composite overlay onto base region
    let sharpInstance;
    if (rawMetadata) {
      sharpInstance = sharp(baseRegionBuffer, {
        raw: {
          width: rawMetadata.width,
          height: rawMetadata.height,
          channels: rawMetadata.channels
        }
      });
    } else {
      sharpInstance = sharp(baseRegionBuffer);
    }

    const buffer = await sharpInstance
      .composite([{ input: overlayBuffer }])
      .png()
      .toBuffer();

    this.perfMonitor?.end(perfOpId, { bufferSize: buffer.length });

    return {
      type: 'partial',
      buffer,
      region,
      displayTime
    };
  }
}

module.exports = FramebufferRenderer;

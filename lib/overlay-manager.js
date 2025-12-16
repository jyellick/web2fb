/**
 * Overlay Management
 *
 * Handles overlay configuration, caching, rendering, and updates:
 * - Configure overlays from config metadata
 * - Cache base regions for efficient compositing
 * - Pre-render clock frames
 * - Composite overlays onto base image
 * - Update individual overlays on framebuffer
 */

const sharp = require('sharp');
const { generateOverlay } = require('./overlays');
const { getEnabledOverlays } = require('./config');
const ClockCache = require('./clock-cache');

class OverlayManager {
  constructor(config, perfMonitor) {
    this.config = config;
    this.perfMonitor = perfMonitor;
    this.states = new Map(); // name -> {overlay, region, style, baseRegionBuffer}
    this.clockCaches = new Map(); // name -> ClockCache instance
  }

  /**
   * Configure overlays from mandatory metadata in config
   */
  configure() {
    const enabledOverlays = getEnabledOverlays(this.config);

    console.log(`Configuring ${enabledOverlays.length} overlay(s) from config metadata...`);

    for (const overlay of enabledOverlays) {
      if (!overlay.region || !overlay.style) {
        throw new Error(`Overlay '${overlay.name}' missing required metadata (region and style)`);
      }

      this.states.set(overlay.name, {
        overlay,
        region: overlay.region,
        style: overlay.style
      });

      console.log(`✓ Overlay '${overlay.name}' configured: (${overlay.region.x}, ${overlay.region.y}), size: ${overlay.region.width}x${overlay.region.height}`);
    }

    return enabledOverlays;
  }

  /**
   * Extract and cache base image regions for all overlays
   */
  async cacheBaseRegions(baseImageBuffer) {
    if (!baseImageBuffer || this.states.size === 0) {
      return;
    }

    const cacheOpId = this.perfMonitor.start('overlay:cacheBaseRegions', { count: this.states.size });

    for (const [name, state] of this.states) {
      try {
        const extractOpId = this.perfMonitor.start('overlay:extractBaseRegion', {
          name,
          width: state.region.width,
          height: state.region.height
        });

        // Extract as raw RGBA pixels (consistent with periodic refresh)
        state.baseRegionBuffer = await sharp(baseImageBuffer)
          .extract({
            left: state.region.x,
            top: state.region.y,
            width: state.region.width,
            height: state.region.height
          })
          .ensureAlpha() // Ensure consistent 4-channel RGBA format
          .raw()
          .toBuffer();

        // Store raw metadata so ClockCache knows the format
        state.rawMetadata = {
          width: state.region.width,
          height: state.region.height,
          channels: 4 // Always RGBA after ensureAlpha()
        };

        this.perfMonitor.end(extractOpId, { bufferSize: state.baseRegionBuffer.length });
      } catch (err) {
        console.error(`Error caching base region for overlay '${name}':`, err);
        state.baseRegionBuffer = null;
      }
    }

    this.perfMonitor.end(cacheOpId);
  }

  /**
   * Pre-render clock frames for all clock overlays
   */
  async preRenderClockFrames() {
    const enabledOverlays = getEnabledOverlays(this.config);
    const clockOverlays = enabledOverlays.filter(o => o.type === 'clock');

    if (clockOverlays.length === 0) {
      return;
    }

    const preRenderOpId = this.perfMonitor.start('clock:preRenderAll', { count: clockOverlays.length });

    for (const overlay of clockOverlays) {
      const state = this.states.get(overlay.name);
      if (!state || !state.baseRegionBuffer) {
        continue;
      }

      try {
        let cache = this.clockCaches.get(overlay.name);
        if (!cache) {
          cache = new ClockCache(overlay, state.baseRegionBuffer, state.region, state.style, state.rawMetadata);
          this.clockCaches.set(overlay.name, cache);
        } else {
          cache.updateBaseRegion(state.baseRegionBuffer, state.rawMetadata);
          cache.style = state.style;
        }

        const renderOpId = this.perfMonitor.start('clock:preRender', { name: overlay.name });
        await cache.preRender();
        this.perfMonitor.end(renderOpId, { frames: cache.windowSize });

        console.log(`✓ Pre-rendered ${cache.windowSize} frames for clock '${overlay.name}'`);
      } catch (err) {
        console.error(`Error pre-rendering clock '${overlay.name}':`, err);
      }
    }

    this.perfMonitor.end(preRenderOpId);
  }

  /**
   * Composite all overlays onto base image
   */
  async compositeOntoBase(baseBuffer) {
    const enabledOverlays = getEnabledOverlays(this.config);
    if (enabledOverlays.length === 0) {
      return baseBuffer;
    }

    let currentImage = sharp(baseBuffer);
    const composites = [];

    for (const overlay of enabledOverlays) {
      const state = this.states.get(overlay.name);
      if (!state || !state.baseRegionBuffer) continue;

      const { region } = state;

      const mergedOverlay = {
        ...overlay,
        style: state.style
      };

      let overlayImage;

      // For clock overlays, use pre-rendered frame if available
      if (overlay.type === 'clock') {
        const cache = this.clockCaches.get(overlay.name);
        if (cache && cache.isValid()) {
          const cachedFrame = cache.getFrame();
          if (cachedFrame) {
            overlayImage = await sharp(cachedFrame.buffer, {
              raw: {
                width: cachedFrame.width,
                height: cachedFrame.height,
                channels: cachedFrame.channels
              }
            })
              .png()
              .toBuffer();
          }
        }
      }

      // Fallback: generate overlay on-the-fly
      if (!overlayImage) {
        const overlayBuffer = generateOverlay(mergedOverlay, region);
        overlayImage = overlayBuffer;
      }

      composites.push({
        input: overlayImage,
        top: region.y,
        left: region.x
      });
    }

    if (composites.length > 0) {
      currentImage = currentImage.composite(composites);
    }

    return await currentImage.png().toBuffer();
  }

  /**
   * Create overlay update function for a specific overlay
   * Returns a function that updates the overlay on the framebuffer
   */
  createUpdateFunction(overlay, framebuffer, onBaseTransition) {
    return async () => {
      const state = this.states.get(overlay.name);
      if (!state || !state.baseRegionBuffer) {
        return;
      }

      // Check if base transition is ready
      if (onBaseTransition) {
        onBaseTransition();
      }

      const { region } = state;
      const mergedOverlay = {
        ...overlay,
        style: state.style
      };

      let compositeImage;

      // For clock overlays, use pre-rendered frames if available
      if (overlay.type === 'clock') {
        const cache = this.clockCaches.get(overlay.name);
        if (cache) {
          if (cache.needsMoreFrames()) {
            const extendOpId = this.perfMonitor.start('clock:extendWindow', { name: overlay.name });
            await cache.extendWindow();
            this.perfMonitor.end(extendOpId, { frames: 1 });
          }

          if (cache.isValid()) {
            const fetchOpId = this.perfMonitor.start('clock:fetchFrame', { name: overlay.name });
            const cachedFrame = cache.getFrame();
            if (cachedFrame) {
              try {
                compositeImage = await sharp(cachedFrame.buffer, {
                  raw: {
                    width: cachedFrame.width,
                    height: cachedFrame.height,
                    channels: cachedFrame.channels
                  }
                })
                  .png()
                  .toBuffer();
              } catch (err) {
                console.error(`Error converting cached frame for '${overlay.name}':`, err.message);
                console.error(`Frame info: width=${cachedFrame.width}, height=${cachedFrame.height}, channels=${cachedFrame.channels}, bufferSize=${cachedFrame.buffer.length}`);
                throw err;
              }
            }
            this.perfMonitor.end(fetchOpId);
          }
        }
      }

      // Fallback: generate and composite on-the-fly
      if (!compositeImage) {
        const genOpId = this.perfMonitor.start('overlay:generate', { name: overlay.name, type: overlay.type });
        const overlayBuffer = generateOverlay(mergedOverlay, region);
        this.perfMonitor.end(genOpId, { bufferSize: overlayBuffer.length });

        const compOpId = this.perfMonitor.start('overlay:composite', {
          name: overlay.name,
          width: region.width,
          height: region.height
        });

        try {
          // Create sharp instance from raw pixel buffer or PNG buffer
          let sharpInstance;
          if (state.rawMetadata) {
            sharpInstance = sharp(state.baseRegionBuffer, {
              raw: {
                width: state.rawMetadata.width,
                height: state.rawMetadata.height,
                channels: state.rawMetadata.channels
              }
            });
          } else {
            sharpInstance = sharp(state.baseRegionBuffer);
          }

          compositeImage = await sharpInstance
            .composite([{ input: overlayBuffer }])
            .png()
            .toBuffer();
          this.perfMonitor.end(compOpId, { bufferSize: compositeImage.length });
        } catch (err) {
          this.perfMonitor.end(compOpId, { success: false });
          console.error(`Error compositing fallback overlay '${overlay.name}':`, err.message);
          console.error(`State info: rawMetadata=${JSON.stringify(state.rawMetadata)}, bufferSize=${state.baseRegionBuffer?.length}`);
          throw err;
        }
      }

      if (!compositeImage) {
        console.error(`No composite image generated for overlay '${overlay.name}'`);
        console.error(`Cache valid: ${this.clockCaches.get(overlay.name)?.isValid()}, Cache exists: ${!!this.clockCaches.get(overlay.name)}`);
        return;
      }

      await framebuffer.writePartial(compositeImage, region);
    };
  }

  /**
   * Replace overlay states and clock caches (for base image transitions)
   */
  replaceStates(newStates, newCaches) {
    this.states.clear();
    for (const [name, state] of newStates.entries()) {
      this.states.set(name, state);
    }

    if (newCaches) {
      this.clockCaches.clear();
      for (const [name, cache] of newCaches.entries()) {
        this.clockCaches.set(name, cache);
      }
    }
  }
}

module.exports = OverlayManager;

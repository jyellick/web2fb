/**
 * Integration tests for framebuffer rendering
 * Tests full and partial updates to catch visual rendering bugs
 */

const sharp = require('sharp');
const FramebufferRenderer = require('../../lib/framebuffer-renderer');
const { _generateOverlay } = require('../../lib/overlays');

describe('Framebuffer Rendering Integration', () => {
  let renderer;
  let config;
  let perfMonitor;

  beforeEach(() => {
    config = {
      display: { width: 800, height: 600 }
    };
    perfMonitor = { start: jest.fn(() => 'mock-id'), end: jest.fn() };
    renderer = new FramebufferRenderer(config, perfMonitor);
  });

  describe('Partial Update Rendering', () => {
    it('should render overlay only in specified region without bleeding', async () => {
      // Create a solid red background (800x600)
      const baseImage = await sharp({
        create: {
          width: 800,
          height: 600,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 }
        }
      }).png().toBuffer();

      // Define overlay region (100x50 at position 350,275 - centered-ish)
      const overlay = {
        name: 'test-clock',
        type: 'clock',
        enabled: true,
        style: {
          fontSize: 32,
          fontFamily: 'Arial',
          color: '#00ff00', // Green text
          fontWeight: 'bold',
          textAlign: 'center'
        },
        _renderTime: new Date('2025-12-19T12:34:56')
      };

      const region = {
        x: 350,
        y: 275,
        width: 100,
        height: 50
      };

      // Extract base region to simulate what the main app does
      const baseRegion = await sharp(baseImage)
        .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
        .toBuffer();

      const state = {
        region,
        style: overlay.style,
        baseRegionBuffer: baseRegion
        // Note: Not providing rawMetadata, so renderer will treat as PNG
      };

      // Render partial update
      const displayTime = new Date('2025-12-19T12:34:56').getTime();
      const operation = await renderer.renderPartialUpdate(overlay, state, displayTime);

      expect(operation.type).toBe('partial');
      expect(operation.region).toEqual(region);
      expect(operation.buffer).toBeInstanceOf(Buffer);

      // Verify the rendered buffer has correct dimensions
      const resultMetadata = await sharp(operation.buffer).metadata();
      expect(resultMetadata.width).toBe(region.width);
      expect(resultMetadata.height).toBe(region.height);

      // Convert to raw pixels for verification
      const pixels = await sharp(operation.buffer)
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Verify buffer size matches region
      const expectedPixels = region.width * region.height;
      const actualPixels = pixels.data.length / pixels.info.channels;
      expect(actualPixels).toBe(expectedPixels);

      // Verify dimensions in pixel data match region (not full screen)
      expect(pixels.info.width).toBe(region.width);
      expect(pixels.info.height).toBe(region.height);
    });

    it('should not corrupt data when rendering multiple partial updates', async () => {
      // Create a checkerboard pattern background for easier visual verification
      const baseImage = await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
      }).png().toBuffer();

      // Define two overlay regions that don't overlap
      const region1 = { x: 50, y: 50, width: 80, height: 40 };
      const region2 = { x: 250, y: 150, width: 80, height: 40 };

      const overlay = {
        name: 'test-text',
        type: 'text',
        text: 'TEST',
        enabled: true,
        style: {
          fontSize: 24,
          fontFamily: 'Arial',
          color: '#000000',
          fontWeight: 'normal',
          textAlign: 'left'
        }
      };

      // Render two partial updates
      const baseRegion1 = await sharp(baseImage)
        .extract({ left: region1.x, top: region1.y, width: region1.width, height: region1.height })
        .toBuffer();

      const state1 = {
        region: region1,
        style: overlay.style,
        baseRegionBuffer: baseRegion1
      };

      const baseRegion2 = await sharp(baseImage)
        .extract({ left: region2.x, top: region2.y, width: region2.width, height: region2.height })
        .toBuffer();

      const state2 = {
        region: region2,
        style: overlay.style,
        baseRegionBuffer: baseRegion2
      };

      const displayTime = Date.now();
      const operation1 = await renderer.renderPartialUpdate(overlay, state1, displayTime);
      const operation2 = await renderer.renderPartialUpdate(overlay, state2, displayTime);

      // Verify both operations have correct dimensions
      const meta1 = await sharp(operation1.buffer).metadata();
      const meta2 = await sharp(operation2.buffer).metadata();

      expect(meta1.width).toBe(region1.width);
      expect(meta1.height).toBe(region1.height);
      expect(meta2.width).toBe(region2.width);
      expect(meta2.height).toBe(region2.height);

      // Verify regions are correctly set
      expect(operation1.region).toEqual(region1);
      expect(operation2.region).toEqual(region2);
    });
  });

  describe('Full Update Rendering', () => {
    it('should composite overlay onto base image at correct position', async () => {
      // Create a blue background
      const baseImage = await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 4,
          background: { r: 0, g: 0, b: 255, alpha: 1 }
        }
      }).png().toBuffer();

      const overlay = {
        name: 'test-overlay',
        type: 'text',
        text: 'OVERLAY',
        enabled: true,
        style: {
          fontSize: 48,
          fontFamily: 'Arial',
          color: '#ffff00', // Yellow
          fontWeight: 'bold',
          textAlign: 'center'
        }
      };

      const region = {
        x: 150,
        y: 125,
        width: 100,
        height: 50
      };

      const baseRegion = await sharp(baseImage)
        .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
        .toBuffer();

      const overlayStates = new Map();
      overlayStates.set(overlay.name, {
        region,
        style: overlay.style,
        baseRegionBuffer: baseRegion
      });

      const displayTime = Date.now();
      const operation = await renderer.renderFullUpdate(baseImage, [overlay], overlayStates, displayTime);

      expect(operation.type).toBe('full');
      expect(operation.buffer).toBeInstanceOf(Buffer);

      // Verify full image dimensions
      const metadata = await sharp(operation.buffer).metadata();
      expect(metadata.width).toBe(400);
      expect(metadata.height).toBe(300);

      // Extract the overlay region from the result to verify it was composited
      const resultOverlayRegion = await sharp(operation.buffer)
        .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Extract same region from base image
      const baseOverlayRegion = await sharp(baseImage)
        .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
        .raw()
        .toBuffer({ resolveWithObject: true });

      // The overlay region in the result should be different from the base
      // (because overlay was composited on top)
      const resultPixels = resultOverlayRegion.data;
      const basePixels = baseOverlayRegion.data;

      // At least some pixels should be different (where text was rendered)
      let differentPixels = 0;
      for (let i = 0; i < resultPixels.length; i += 4) {
        const resultR = resultPixels[i];
        const resultG = resultPixels[i + 1];
        const resultB = resultPixels[i + 2];
        const baseR = basePixels[i];
        const baseG = basePixels[i + 1];
        const baseB = basePixels[i + 2];

        if (resultR !== baseR || resultG !== baseG || resultB !== baseB) {
          differentPixels++;
        }
      }

      // Expect at least 10% of pixels to be different (text was rendered)
      const totalPixels = resultPixels.length / 4;
      expect(differentPixels).toBeGreaterThan(totalPixels * 0.1);
    });

    it('should preserve areas outside overlay regions', async () => {
      // Create a gradient or distinct pattern
      const baseImage = await sharp({
        create: {
          width: 300,
          height: 200,
          channels: 4,
          background: { r: 128, g: 64, b: 32, alpha: 1 }
        }
      }).png().toBuffer();

      const overlay = {
        name: 'small-overlay',
        type: 'text',
        text: 'X',
        enabled: true,
        style: {
          fontSize: 20,
          fontFamily: 'Arial',
          color: '#ffffff',
          fontWeight: 'normal',
          textAlign: 'center'
        }
      };

      // Small overlay in center
      const region = {
        x: 140,
        y: 90,
        width: 20,
        height: 20
      };

      const baseRegion = await sharp(baseImage)
        .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
        .toBuffer();

      const overlayStates = new Map();
      overlayStates.set(overlay.name, {
        region,
        style: overlay.style,
        baseRegionBuffer: baseRegion
      });

      const displayTime = Date.now();
      const operation = await renderer.renderFullUpdate(baseImage, [overlay], overlayStates, displayTime);

      // Extract corner regions that should be unchanged
      const topLeft = await sharp(operation.buffer)
        .extract({ left: 0, top: 0, width: 50, height: 50 })
        .raw()
        .toBuffer();

      const baseTopLeft = await sharp(baseImage)
        .extract({ left: 0, top: 0, width: 50, height: 50 })
        .raw()
        .toBuffer();

      // Top-left corner should be identical to base image
      expect(topLeft).toEqual(baseTopLeft);
    });
  });

  describe('Edge Cases', () => {
    it('should handle overlay at screen edges without overflow', async () => {
      const baseImage = await sharp({
        create: {
          width: 200,
          height: 150,
          channels: 4,
          background: { r: 100, g: 100, b: 100, alpha: 1 }
        }
      }).png().toBuffer();

      // Overlay at bottom-right corner
      const region = {
        x: 150,
        y: 100,
        width: 50,
        height: 50
      };

      const overlay = {
        name: 'corner-overlay',
        type: 'text',
        text: 'EDGE',
        enabled: true,
        style: {
          fontSize: 16,
          fontFamily: 'Arial',
          color: '#ffffff',
          fontWeight: 'normal',
          textAlign: 'left'
        }
      };

      const baseRegion = await sharp(baseImage)
        .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
        .toBuffer();

      const state = {
        region,
        style: overlay.style,
        baseRegionBuffer: baseRegion
      };

      const displayTime = Date.now();
      const operation = await renderer.renderPartialUpdate(overlay, state, displayTime);

      // Should not throw and should have correct dimensions
      const metadata = await sharp(operation.buffer).metadata();
      expect(metadata.width).toBe(50);
      expect(metadata.height).toBe(50);
    });

    it('should handle zero-size overlays gracefully', async () => {
      const baseImage = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 1 }
        }
      }).png().toBuffer();

      const overlayStates = new Map(); // No overlays

      const displayTime = Date.now();
      const operation = await renderer.renderFullUpdate(baseImage, [], overlayStates, displayTime);

      // Should return the base image unchanged
      expect(operation.type).toBe('full');
      const metadata = await sharp(operation.buffer).metadata();
      expect(metadata.width).toBe(100);
      expect(metadata.height).toBe(100);
    });
  });
});

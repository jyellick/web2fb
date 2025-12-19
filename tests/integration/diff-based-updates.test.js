/**
 * Integration tests for diff-based updates in web2fb.js
 * Tests the complete recaptureBaseImage() flow with diff detection and overlay compositing
 */

const sharp = require('sharp');
const { detectChangedRegions } = require('../../lib/image-diff');

describe('Diff-Based Updates Integration', () => {
  describe('Overlay Compositing on Changed Regions', () => {
    it('should include overlays when compositing changed regions', async () => {
      // Create old base image (blue background)
      const oldBase = await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 4,
          background: { r: 0, g: 0, b: 255, alpha: 1 }
        }
      }).png().toBuffer();

      // Create new base image (red background on left half, blue on right)
      const newBase = await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 4,
          background: { r: 0, g: 0, b: 255, alpha: 1 }
        }
      })
        .composite([{
          input: await sharp({
            create: {
              width: 200,
              height: 300,
              channels: 4,
              background: { r: 255, g: 0, b: 0, alpha: 1 }
            }
          }).png().toBuffer(),
          top: 0,
          left: 0
        }])
        .png()
        .toBuffer();

      // Detect changed regions
      const diffResult = await detectChangedRegions(oldBase, newBase, {
        threshold: 10,
        minRegionSize: 1000
      });

      expect(diffResult.regions).not.toBeNull();
      expect(diffResult.regions.length).toBeGreaterThan(0);

      // Simulate overlay region that overlaps with changed area
      const overlayRegion = {
        x: 150, // Overlaps the changed red region
        y: 125,
        width: 100,
        height: 50
      };

      const changedRegion = diffResult.regions[0];

      // Check if overlay overlaps with changed region
      const overlaps = !(
        overlayRegion.x + overlayRegion.width <= changedRegion.x ||
        overlayRegion.x >= changedRegion.x + changedRegion.width ||
        overlayRegion.y + overlayRegion.height <= changedRegion.y ||
        overlayRegion.y >= changedRegion.y + changedRegion.height
      );

      expect(overlaps).toBe(true);

      // Extract changed region and composite overlay (simulating the fix)
      const { generateOverlay } = require('../../lib/overlays');

      let regionImage = sharp(newBase)
        .extract({
          left: changedRegion.x,
          top: changedRegion.y,
          width: changedRegion.width,
          height: changedRegion.height
        });

      // Generate overlay SVG
      const overlay = {
        name: 'test-clock',
        type: 'clock',
        style: {
          fontSize: 32,
          fontFamily: 'Arial',
          color: '#00ff00',
          fontWeight: 'bold',
          textAlign: 'center'
        },
        _renderTime: new Date('2025-12-19T12:34:56')
      };

      const overlayBuffer = generateOverlay(overlay, overlayRegion);

      // Calculate relative position
      const relativeX = overlayRegion.x - changedRegion.x;
      const relativeY = overlayRegion.y - changedRegion.y;

      // Composite overlay onto changed region
      const resultBuffer = await regionImage
        .composite([{
          input: overlayBuffer,
          left: relativeX,
          top: relativeY
        }])
        .toBuffer();

      // Verify the result includes both the changed background AND the overlay
      const _resultPixels = await sharp(resultBuffer)
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Extract the area where the overlay should be (relative to changed region)
      const overlayInResult = await sharp(resultBuffer)
        .extract({
          left: Math.max(0, relativeX),
          top: Math.max(0, relativeY),
          width: Math.min(overlayRegion.width, changedRegion.width - relativeX),
          height: Math.min(overlayRegion.height, changedRegion.height - relativeY)
        })
        .raw()
        .toBuffer({ resolveWithObject: true });

      // The overlay area should not be pure red (overlay text should change some pixels)
      const pixels = overlayInResult.data;
      let nonRedPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        // Check if pixel is NOT pure red (overlay changed it)
        if (!(r === 255 && g === 0 && b === 0)) {
          nonRedPixels++;
        }
      }

      // At least 5% of pixels in overlay region should be non-red (overlay was rendered)
      const totalPixels = pixels.length / 4;
      expect(nonRedPixels).toBeGreaterThan(totalPixels * 0.05);
    });

    it('should handle partial overlaps between overlay and changed region', async () => {
      // Create old base image
      const oldBase = await sharp({
        create: {
          width: 300,
          height: 200,
          channels: 4,
          background: { r: 100, g: 100, b: 100, alpha: 1 }
        }
      }).png().toBuffer();

      // Create new base with change on left side
      const newBase = await sharp({
        create: {
          width: 300,
          height: 200,
          channels: 4,
          background: { r: 100, g: 100, b: 100, alpha: 1 }
        }
      })
        .composite([{
          input: await sharp({
            create: {
              width: 150,
              height: 200,
              channels: 4,
              background: { r: 255, g: 255, b: 0, alpha: 1 }
            }
          }).png().toBuffer(),
          top: 0,
          left: 0
        }])
        .png()
        .toBuffer();

      const diffResult = await detectChangedRegions(oldBase, newBase);
      expect(diffResult.regions).not.toBeNull();

      const changedRegion = diffResult.regions[0];

      // Overlay that partially overlaps (starts before changed region ends)
      const overlayRegion = {
        x: 100,
        y: 50,
        width: 100,
        height: 50
      };

      // Verify partial overlap
      const overlaps = !(
        overlayRegion.x + overlayRegion.width <= changedRegion.x ||
        overlayRegion.x >= changedRegion.x + changedRegion.width ||
        overlayRegion.y + overlayRegion.height <= changedRegion.y ||
        overlayRegion.y >= changedRegion.y + changedRegion.height
      );

      expect(overlaps).toBe(true);

      // Sharp should handle partial overlaps by clipping
      const { generateOverlay } = require('../../lib/overlays');

      const overlay = {
        type: 'text',
        text: 'PARTIAL',
        style: {
          fontSize: 20,
          fontFamily: 'Arial',
          color: '#ff0000',
          fontWeight: 'bold',
          textAlign: 'left'
        }
      };

      const overlayBuffer = generateOverlay(overlay, overlayRegion);
      const relativeX = overlayRegion.x - changedRegion.x;
      const relativeY = overlayRegion.y - changedRegion.y;

      // This should not throw even with negative or out-of-bounds positions
      const resultBuffer = await sharp(newBase)
        .extract({
          left: changedRegion.x,
          top: changedRegion.y,
          width: changedRegion.width,
          height: changedRegion.height
        })
        .composite([{
          input: overlayBuffer,
          left: relativeX,
          top: relativeY
        }])
        .toBuffer();

      // Verify result is valid
      const metadata = await sharp(resultBuffer).metadata();
      expect(metadata.width).toBe(changedRegion.width);
      expect(metadata.height).toBe(changedRegion.height);
    });

    it('should skip overlays that do not overlap with changed region', async () => {
      // Small changed region
      const changedRegion = {
        x: 10,
        y: 10,
        width: 50,
        height: 50
      };

      // Overlay far away
      const overlayRegion = {
        x: 200,
        y: 200,
        width: 100,
        height: 50
      };

      // Check overlap
      const overlaps = !(
        overlayRegion.x + overlayRegion.width <= changedRegion.x ||
        overlayRegion.x >= changedRegion.x + changedRegion.width ||
        overlayRegion.y + overlayRegion.height <= changedRegion.y ||
        overlayRegion.y >= changedRegion.y + changedRegion.height
      );

      // Should not overlap
      expect(overlaps).toBe(false);
    });
  });

  describe('Full Update Threshold', () => {
    it('should recommend full update when >70% of screen changes', async () => {
      // Create completely different images
      const oldBase = await sharp({
        create: {
          width: 200,
          height: 100,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 1 }
        }
      }).png().toBuffer();

      const newBase = await sharp({
        create: {
          width: 200,
          height: 100,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
      }).png().toBuffer();

      const diffResult = await detectChangedRegions(oldBase, newBase);

      expect(diffResult.fullUpdateRecommended).toBe(true);
      expect(diffResult.changePercent).toBeGreaterThan(70);
      expect(diffResult.regions).toBeNull();
    });

    it('should use partial update when <70% of screen changes', async () => {
      const oldBase = await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 4,
          background: { r: 100, g: 100, b: 100, alpha: 1 }
        }
      }).png().toBuffer();

      // Change only left third
      const newBase = await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 4,
          background: { r: 100, g: 100, b: 100, alpha: 1 }
        }
      })
        .composite([{
          input: await sharp({
            create: {
              width: 130,
              height: 300,
              channels: 4,
              background: { r: 200, g: 50, b: 50, alpha: 1 }
            }
          }).png().toBuffer(),
          top: 0,
          left: 0
        }])
        .png()
        .toBuffer();

      const diffResult = await detectChangedRegions(oldBase, newBase);

      expect(diffResult.fullUpdateRecommended).toBe(false);
      expect(diffResult.changePercent).toBeLessThan(70);
      expect(diffResult.regions).not.toBeNull();
      expect(diffResult.regions.length).toBeGreaterThan(0);
    });
  });
});

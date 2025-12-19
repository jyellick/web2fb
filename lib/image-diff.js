/**
 * Image Diff Module
 *
 * Detects changed regions between two images for optimized partial updates.
 * When only a portion of the screen changes (e.g., calendar content updates),
 * we can write only the changed regions instead of the entire screen.
 */

const sharp = require('sharp');

/**
 * Compare two images and detect changed regions
 * @param {Buffer} oldImageBuffer - Old PNG image
 * @param {Buffer} newImageBuffer - New PNG image
 * @param {Object} options - Detection options
 * @param {number} options.threshold - Pixel difference threshold (0-255, default: 10)
 * @param {number} options.minRegionSize - Minimum region size to consider (pixels, default: 1000)
 * @param {number} options.mergeDist - Merge regions closer than this distance (pixels, default: 50)
 * @returns {Promise<Array>} Array of changed regions { x, y, width, height }
 */
async function detectChangedRegions(oldImageBuffer, newImageBuffer, options = {}) {
  const threshold = options.threshold || 10;
  const minRegionSize = options.minRegionSize || 1000;
  const mergeDist = options.mergeDist || 50;

  // Convert both images to raw RGB buffers
  const [oldResult, newResult] = await Promise.all([
    sharp(oldImageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(newImageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  ]);

  const oldPixels = oldResult.data;
  const newPixels = newResult.data;
  const { width, height } = oldResult.info;

  if (newResult.info.width !== width || newResult.info.height !== height) {
    throw new Error('Image dimensions do not match');
  }

  // Create a change map (1 = changed, 0 = unchanged)
  const changeMap = new Uint8Array(width * height);
  let changedPixels = 0;

  // Compare pixels and mark changes
  for (let i = 0; i < oldPixels.length; i += 3) {
    const pixelIndex = i / 3;
    const rDiff = Math.abs(oldPixels[i] - newPixels[i]);
    const gDiff = Math.abs(oldPixels[i + 1] - newPixels[i + 1]);
    const bDiff = Math.abs(oldPixels[i + 2] - newPixels[i + 2]);

    // If any channel differs by more than threshold, mark as changed
    if (rDiff > threshold || gDiff > threshold || bDiff > threshold) {
      changeMap[pixelIndex] = 1;
      changedPixels++;
    }
  }

  const changePercent = (changedPixels / changeMap.length) * 100;

  // If too many changes (>70%), return null to indicate full update needed
  if (changePercent > 70) {
    return {
      regions: null,
      changePercent,
      changedPixels,
      fullUpdateRecommended: true
    };
  }

  // Find bounding boxes of changed regions
  const regions = findBoundingBoxes(changeMap, width, height, minRegionSize);

  // Merge nearby regions to reduce number of writes
  const mergedRegions = mergeNearbyRegions(regions, mergeDist);

  return {
    regions: mergedRegions,
    changePercent,
    changedPixels,
    fullUpdateRecommended: false
  };
}

/**
 * Find bounding boxes of changed pixels using flood fill
 * @private
 */
function findBoundingBoxes(changeMap, width, height, minSize) {
  const visited = new Uint8Array(width * height);
  const regions = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (changeMap[idx] === 1 && visited[idx] === 0) {
        // Found an unvisited changed pixel, flood fill to find region
        const region = floodFillBoundingBox(changeMap, visited, width, height, x, y);

        // Only keep regions larger than minimum size
        if (region.width * region.height >= minSize) {
          regions.push(region);
        }
      }
    }
  }

  return regions;
}

/**
 * Flood fill to find bounding box of connected changed pixels
 * @private
 */
function floodFillBoundingBox(changeMap, visited, width, height, startX, startY) {
  let minX = startX, maxX = startX;
  let minY = startY, maxY = startY;

  const stack = [[startX, startY]];

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const idx = y * width + x;

    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    if (visited[idx] === 1 || changeMap[idx] === 0) continue;

    visited[idx] = 1;

    // Update bounding box
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);

    // Add neighbors to stack
    stack.push([x + 1, y]);
    stack.push([x - 1, y]);
    stack.push([x, y + 1]);
    stack.push([x, y - 1]);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

/**
 * Merge regions that are close together
 * @private
 */
function mergeNearbyRegions(regions, mergeDist) {
  if (regions.length <= 1) return regions;

  const merged = [];
  const used = new Set();

  for (let i = 0; i < regions.length; i++) {
    if (used.has(i)) continue;

    let current = { ...regions[i] };
    let didMerge = true;

    // Keep merging until no more nearby regions found
    while (didMerge) {
      didMerge = false;

      for (let j = 0; j < regions.length; j++) {
        if (i === j || used.has(j)) continue;

        const other = regions[j];
        const distance = regionDistance(current, other);

        if (distance <= mergeDist) {
          // Merge the regions
          current = mergeTwoRegions(current, other);
          used.add(j);
          didMerge = true;
        }
      }
    }

    merged.push(current);
    used.add(i);
  }

  return merged;
}

/**
 * Calculate distance between two regions (edge to edge)
 * @private
 */
function regionDistance(r1, r2) {
  const r1Right = r1.x + r1.width;
  const r1Bottom = r1.y + r1.height;
  const r2Right = r2.x + r2.width;
  const r2Bottom = r2.y + r2.height;

  const xDist = Math.max(0, Math.max(r1.x - r2Right, r2.x - r1Right));
  const yDist = Math.max(0, Math.max(r1.y - r2Bottom, r2.y - r1Bottom));

  return Math.sqrt(xDist * xDist + yDist * yDist);
}

/**
 * Merge two regions into one bounding box
 * @private
 */
function mergeTwoRegions(r1, r2) {
  const minX = Math.min(r1.x, r2.x);
  const minY = Math.min(r1.y, r2.y);
  const maxX = Math.max(r1.x + r1.width, r2.x + r2.width);
  const maxY = Math.max(r1.y + r1.height, r2.y + r2.height);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

module.exports = {
  detectChangedRegions
};

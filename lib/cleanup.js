/**
 * Chrome Profile Cleanup Utility
 *
 * Puppeteer creates temporary Chrome profiles in /tmp that can accumulate
 * over time, especially on resource-constrained devices. This module provides
 * utilities to clean up old profiles.
 */

const fs = require('fs');
const path = require('path');

/**
 * Find Chrome temporary directories in /tmp
 */
function findChromeTempDirs() {
  const tmpDir = '/tmp';
  const chromeDirs = [];

  try {
    const entries = fs.readdirSync(tmpDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() &&
          (entry.name.startsWith('puppeteer_dev_chrome_profile-') ||
           entry.name.startsWith('chrome_') ||
           entry.name.startsWith('Crashpad'))) {
        chromeDirs.push({
          name: entry.name,
          path: path.join(tmpDir, entry.name)
        });
      }
    }
  } catch (_err) {
    console.warn('Warning: Could not scan /tmp for Chrome profiles:', err.message);
  }

  return chromeDirs;
}

/**
 * Get directory size in bytes
 */
function getDirectorySize(dirPath) {
  let totalSize = 0;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        totalSize += getDirectorySize(fullPath);
      } else {
        try {
          const stats = fs.statSync(fullPath);
          totalSize += stats.size;
        } catch (_err) {
          // File might have been deleted, skip
        }
      }
    }
  } catch (_err) {
    // Directory might have been deleted, skip
  }

  return totalSize;
}

/**
 * Get directory age (time since last modification)
 */
function getDirectoryAge(dirPath) {
  try {
    const stats = fs.statSync(dirPath);
    return Date.now() - stats.mtimeMs;
  } catch (_err) {
    return 0;
  }
}

/**
 * Remove directory recursively
 */
function removeDirectory(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch (_err) {
    console.warn(`Warning: Could not remove ${dirPath}:`, err.message);
    return false;
  }
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Clean up old Chrome temporary directories
 *
 * @param {Object} options Cleanup options
 * @param {number} options.maxAge - Maximum age in milliseconds (default: 1 hour)
 * @param {number} options.minSize - Minimum size to consider for cleanup (default: 0)
 * @param {boolean} options.dryRun - If true, only report what would be deleted
 * @returns {Object} Cleanup statistics
 */
function cleanupChromeTempDirs(options = {}) {
  const {
    maxAge = 60 * 60 * 1000, // 1 hour
    minSize = 0,
    dryRun = false
  } = options;

  const chromeDirs = findChromeTempDirs();

  const stats = {
    found: chromeDirs.length,
    removed: 0,
    failed: 0,
    totalSize: 0,
    freedSpace: 0,
    oldDirs: []
  };

  for (const dir of chromeDirs) {
    const age = getDirectoryAge(dir.path);
    const size = getDirectorySize(dir.path);
    stats.totalSize += size;

    if (age > maxAge && size >= minSize) {
      stats.oldDirs.push({
        ...dir,
        age,
        size,
        ageHours: (age / (60 * 60 * 1000)).toFixed(1),
        sizeFormatted: formatBytes(size)
      });

      if (!dryRun) {
        if (removeDirectory(dir.path)) {
          stats.removed++;
          stats.freedSpace += size;
        } else {
          stats.failed++;
        }
      }
    }
  }

  return stats;
}

/**
 * Report Chrome temp directory usage
 */
function reportChromeTempUsage() {
  const chromeDirs = findChromeTempDirs();

  if (chromeDirs.length === 0) {
    console.log('No Chrome temporary directories found in /tmp');
    return;
  }

  let totalSize = 0;
  const dirsWithSize = chromeDirs.map(dir => {
    const size = getDirectorySize(dir.path);
    const age = getDirectoryAge(dir.path);
    totalSize += size;
    return {
      ...dir,
      size,
      age,
      ageHours: (age / (60 * 60 * 1000)).toFixed(1),
      sizeFormatted: formatBytes(size)
    };
  });

  // Sort by size descending
  dirsWithSize.sort((a, b) => b.size - a.size);

  console.log(`\nChrome temporary directories in /tmp: ${chromeDirs.length}`);
  console.log(`Total size: ${formatBytes(totalSize)}`);
  console.log('\nLargest directories:');

  for (const dir of dirsWithSize.slice(0, 5)) {
    console.log(`  ${dir.sizeFormatted.padEnd(10)} ${dir.ageHours}h old  ${dir.name}`);
  }

  if (dirsWithSize.length > 5) {
    console.log(`  ... and ${dirsWithSize.length - 5} more`);
  }
}

/**
 * Monitor Chrome profile size and trigger callback if it exceeds threshold
 *
 * @param {string} profilePath Path to Chrome profile directory
 * @param {number} threshold Size threshold in bytes
 * @returns {Object} Profile size info
 */
function checkProfileSize(profilePath, threshold) {
  const size = getDirectorySize(profilePath);
  const exceeds = size > threshold;

  return {
    size,
    sizeFormatted: formatBytes(size),
    threshold,
    thresholdFormatted: formatBytes(threshold),
    exceeds
  };
}

module.exports = {
  findChromeTempDirs,
  cleanupChromeTempDirs,
  reportChromeTempUsage,
  getDirectorySize,
  formatBytes,
  checkProfileSize
};

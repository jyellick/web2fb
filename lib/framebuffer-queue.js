/**
 * Framebuffer Queue
 *
 * Manages a queue of pre-rendered framebuffer operations, each keyed by
 * the display time (second). Operations are rendered ahead of time and
 * written to framebuffer at their scheduled time.
 */

class FramebufferQueue {
  constructor(windowSize = 10) {
    this.operations = new Map(); // displaySecond -> { type, buffer, region, displayTime }
    this.sortedSeconds = []; // Maintain sorted array of queued seconds for efficient lookups
    this.windowSize = windowSize;
  }

  /**
   * Add an operation to the queue
   * @param {number} displaySecond - Unix timestamp second when this should display
   * @param {Object} operation - { type: 'full'|'partial', buffer, region?, displayTime }
   */
  enqueue(displaySecond, operation) {
    const isNew = !this.operations.has(displaySecond);
    this.operations.set(displaySecond, operation);

    // Maintain sorted array for efficient lookups
    if (isNew) {
      // Binary search to find insertion point
      const idx = this._binarySearch(displaySecond);
      this.sortedSeconds.splice(idx, 0, displaySecond);
    }
  }

  /**
   * Get and remove an operation from the queue
   * @param {number} displaySecond - Unix timestamp second to retrieve
   * @returns {Object|null} The operation, or null if not found
   */
  dequeue(displaySecond) {
    const op = this.operations.get(displaySecond);
    if (op) {
      this.operations.delete(displaySecond);
      // Remove from sorted array
      const idx = this.sortedSeconds.indexOf(displaySecond);
      if (idx !== -1) {
        this.sortedSeconds.splice(idx, 1);
      }
    }
    return op || null;
  }

  /**
   * Binary search to find insertion point for a value
   * @private
   */
  _binarySearch(value) {
    let left = 0;
    let right = this.sortedSeconds.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.sortedSeconds[mid] < value) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    return left;
  }

  /**
   * Check if queue needs more operations
   * @param {number} currentSecond - Current Unix timestamp second
   * @returns {boolean} True if queue has fewer than windowSize operations ahead
   */
  needsMore(currentSecond) {
    // Use binary search to find first future second
    const idx = this._binarySearch(currentSecond);
    const futureCount = this.sortedSeconds.length - idx;
    return futureCount < this.windowSize;
  }

  /**
   * Get the next second that needs an operation
   * @param {number} currentSecond - Current Unix timestamp second
   * @returns {number} Next second that needs rendering
   */
  getNextUnqueuedSecond(currentSecond) {
    // Use binary search to find first future second
    const idx = this._binarySearch(currentSecond);

    if (idx >= this.sortedSeconds.length) {
      // No future operations
      return currentSecond;
    }

    // Find first gap in sequence
    for (let i = idx; i < this.sortedSeconds.length; i++) {
      const expected = currentSecond + (i - idx);
      if (this.sortedSeconds[i] !== expected) {
        return expected;
      }
    }

    // No gaps, return next after last
    return this.sortedSeconds[this.sortedSeconds.length - 1] + 1;
  }

  /**
   * Get the last queued second
   * @returns {number|null} Last queued second, or null if empty
   */
  getLastQueuedSecond() {
    if (this.sortedSeconds.length === 0) {
      return null;
    }
    return this.sortedSeconds[this.sortedSeconds.length - 1];
  }

  /**
   * Get queue status for debugging
   * @param {number} currentSecond - Current Unix timestamp second
   * @returns {Object} Status information
   */
  getStatus(currentSecond) {
    // Use binary search to find first future second
    const idx = this._binarySearch(currentSecond);
    const futureSeconds = this.sortedSeconds.slice(idx);

    return {
      size: futureSeconds.length,
      windowSize: this.windowSize,
      needsMore: this.needsMore(currentSecond),
      range: futureSeconds.length > 0
        ? `${futureSeconds[0]} to ${futureSeconds[futureSeconds.length - 1]}`
        : 'empty',
      secondsAhead: futureSeconds.length > 0
        ? futureSeconds[futureSeconds.length - 1] - currentSecond
        : 0
    };
  }

  /**
   * Clear all operations
   */
  clear() {
    this.operations.clear();
    this.sortedSeconds = [];
  }
}

module.exports = FramebufferQueue;

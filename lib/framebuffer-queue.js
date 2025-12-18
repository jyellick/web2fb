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
    this.windowSize = windowSize;
  }

  /**
   * Add an operation to the queue
   * @param {number} displaySecond - Unix timestamp second when this should display
   * @param {Object} operation - { type: 'full'|'partial', buffer, region?, displayTime }
   */
  enqueue(displaySecond, operation) {
    this.operations.set(displaySecond, operation);
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
    }
    return op || null;
  }

  /**
   * Check if queue needs more operations
   * @param {number} currentSecond - Current Unix timestamp second
   * @returns {boolean} True if queue has fewer than windowSize operations ahead
   */
  needsMore(currentSecond) {
    const futureOps = Array.from(this.operations.keys())
      .filter(s => s >= currentSecond);
    return futureOps.length < this.windowSize;
  }

  /**
   * Get the next second that needs an operation
   * @param {number} currentSecond - Current Unix timestamp second
   * @returns {number} Next second that needs rendering
   */
  getNextUnqueuedSecond(currentSecond) {
    const queuedSeconds = Array.from(this.operations.keys())
      .filter(s => s >= currentSecond)
      .sort((a, b) => a - b);

    if (queuedSeconds.length === 0) {
      return currentSecond;
    }

    // Find first gap or return next after last
    for (let i = 0; i < queuedSeconds.length; i++) {
      const expected = currentSecond + i;
      if (queuedSeconds[i] !== expected) {
        return expected;
      }
    }

    return queuedSeconds[queuedSeconds.length - 1] + 1;
  }

  /**
   * Get the last queued second
   * @returns {number|null} Last queued second, or null if empty
   */
  getLastQueuedSecond() {
    const seconds = Array.from(this.operations.keys());
    if (seconds.length === 0) {
      return null;
    }
    return Math.max(...seconds);
  }

  /**
   * Get queue status for debugging
   * @param {number} currentSecond - Current Unix timestamp second
   * @returns {Object} Status information
   */
  getStatus(currentSecond) {
    const queuedSeconds = Array.from(this.operations.keys())
      .filter(s => s >= currentSecond)
      .sort((a, b) => a - b);

    return {
      size: queuedSeconds.length,
      windowSize: this.windowSize,
      needsMore: this.needsMore(currentSecond),
      range: queuedSeconds.length > 0
        ? `${queuedSeconds[0]} to ${queuedSeconds[queuedSeconds.length - 1]}`
        : 'empty',
      secondsAhead: queuedSeconds.length > 0
        ? queuedSeconds[queuedSeconds.length - 1] - currentSecond
        : 0
    };
  }

  /**
   * Clear all operations
   */
  clear() {
    this.operations.clear();
  }
}

module.exports = FramebufferQueue;

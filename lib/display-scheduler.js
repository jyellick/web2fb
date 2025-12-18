/**
 * Display Scheduler
 *
 * Writes pre-rendered operations to framebuffer at their scheduled times.
 * Synchronized to second boundaries for accurate clock display.
 */

class DisplayScheduler {
  constructor(queue, framebuffer, perfMonitor) {
    this.queue = queue;
    this.framebuffer = framebuffer;
    this.perfMonitor = perfMonitor;
    this.timeoutId = null;
    this.running = false;
  }

  /**
   * Start the display scheduler
   */
  start() {
    if (this.running) {
      console.warn('DisplayScheduler already running');
      return;
    }

    this.running = true;
    console.log('DisplayScheduler started - synchronized to second boundaries');
    this.scheduleNextDisplay();
  }

  /**
   * Stop the display scheduler
   */
  stop() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.running = false;
    console.log('DisplayScheduler stopped');
  }

  /**
   * Schedule the next display update at the next second boundary
   */
  scheduleNextDisplay() {
    if (!this.running) return;

    const now = Date.now();
    const msUntilNextSecond = 1000 - (now % 1000);

    this.timeoutId = setTimeout(async () => {
      const currentSecond = Math.floor(Date.now() / 1000);
      await this.displayFrame(currentSecond);
      this.scheduleNextDisplay(); // Continue loop
    }, msUntilNextSecond);
  }

  /**
   * Display a frame for the given second
   * @param {number} displaySecond - Unix timestamp second to display
   */
  async displayFrame(displaySecond) {
    const perfOpId = this.perfMonitor?.start('display:frame', { displaySecond });

    const operation = this.queue.dequeue(displaySecond);

    if (!operation) {
      // No operation for this second - screen stays as-is (no frame drop)
      this.perfMonitor?.end(perfOpId, { result: 'no-op' });
      return;
    }

    try {
      if (operation.type === 'full') {
        await this.framebuffer.writeFull(operation.buffer);
        this.perfMonitor?.end(perfOpId, {
          result: 'success',
          type: 'full',
          bufferSize: operation.buffer.length
        });
      } else if (operation.type === 'partial') {
        await this.framebuffer.writePartial(operation.buffer, operation.region);
        this.perfMonitor?.end(perfOpId, {
          result: 'success',
          type: 'partial',
          region: `${operation.region.width}x${operation.region.height} at (${operation.region.x},${operation.region.y})`,
          bufferSize: operation.buffer.length
        });
      } else {
        console.error(`Unknown operation type: ${operation.type}`);
        this.perfMonitor?.end(perfOpId, { result: 'error', error: 'unknown-type' });
      }
    } catch (err) {
      console.error(`Error displaying frame for second ${displaySecond}:`, err.message);
      this.perfMonitor?.end(perfOpId, { result: 'error', error: err.message });
    }
  }
}

module.exports = DisplayScheduler;

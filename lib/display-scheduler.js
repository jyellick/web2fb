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
    this.nextDisplaySecond = null; // Track expected second to prevent duplicates
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
    this.nextDisplaySecond = Math.floor(Date.now() / 1000); // Initialize
    console.log(`DisplayScheduler started - synchronized to second boundaries (starting at ${this.nextDisplaySecond})`);
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
      // CRITICAL: Use tracked nextDisplaySecond, not recalculated from Date.now()
      // This prevents duplicates when timeout fires 1ms early (e.g., 12:39:43.999)
      const displaySecond = this.nextDisplaySecond;

      // Increment for next iteration BEFORE displaying (in case display takes time)
      this.nextDisplaySecond++;

      await this.displayFrame(displaySecond);
      this.scheduleNextDisplay(); // Continue loop
    }, msUntilNextSecond);
  }

  /**
   * Display a frame for the given second
   * @param {number} displaySecond - Unix timestamp second to display
   */
  async displayFrame(displaySecond) {
    const perfOpId = this.perfMonitor?.start('display:frame', { displaySecond });
    const startTime = Date.now();

    const operation = this.queue.dequeue(displaySecond);

    if (!operation) {
      // No operation for this second - DROPPED FRAME!
      const now = new Date(displaySecond * 1000);
      console.error(`❌ DROPPED FRAME at ${now.toISOString()} (second ${displaySecond})`);
      const status = this.queue.getStatus(displaySecond);
      console.error(`   Queue: ${status.size} operations, range: ${status.range}`);
      console.error(`   Expected operation not found - frame will not display!`);
      this.perfMonitor?.end(perfOpId, { result: 'no-op' });
      return;
    }

    // Log every display attempt when DEBUG enabled
    if (this.perfMonitor?.config.enabled) {
      const now = new Date(displaySecond * 1000);
      console.log(`📺 Display ${operation.type} for ${now.toISOString()} (second ${displaySecond})`);
    }

    try {
      if (operation.type === 'full') {
        await this.framebuffer.writeFull(operation.buffer);
        const duration = Date.now() - startTime;
        if (this.perfMonitor?.config.enabled && duration > 100) {
          console.warn(`⚠️  Slow display: full write took ${duration}ms`);
        }
        this.perfMonitor?.end(perfOpId, {
          result: 'success',
          type: 'full',
          bufferSize: operation.buffer.length
        });
      } else if (operation.type === 'partial') {
        await this.framebuffer.writePartial(operation.buffer, operation.region);
        const duration = Date.now() - startTime;
        if (this.perfMonitor?.config.enabled && duration > 100) {
          console.warn(`⚠️  Slow display: partial write took ${duration}ms`);
        }
        this.perfMonitor?.end(perfOpId, {
          result: 'success',
          type: 'partial',
          region: `${operation.region.width}x${operation.region.height} at (${operation.region.x},${operation.region.y})`,
          bufferSize: operation.buffer.length
        });
      } else {
        console.error(`❌ Unknown operation type: ${operation.type}`);
        this.perfMonitor?.end(perfOpId, { result: 'error', error: 'unknown-type' });
      }
    } catch (err) {
      console.error(`❌ Error displaying frame for second ${displaySecond}:`, err.message);
      console.error(`   Stack: ${err.stack}`);
      this.perfMonitor?.end(perfOpId, { result: 'error', error: err.message });
    }
  }
}

module.exports = DisplayScheduler;

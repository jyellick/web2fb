/**
 * Performance Monitor - Detailed timing and resource tracking
 *
 * Provides instrumentation for understanding where time and resources
 * are being consumed on resource-constrained devices like Pi Zero 2 W.
 */

const fs = require('fs');
const os = require('os');

class PerfMonitor {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      verbose: config.verbose || false,
      logToFile: config.logToFile || null,
      trackMemory: config.trackMemory !== false,
      sampleInterval: config.sampleInterval || 100, // ms
    };

    // Operation timings (rolling window)
    this.timings = new Map();
    this.maxSamples = 100;

    // Active operations (for measuring duration)
    this.activeOps = new Map();

    // Memory samples
    this.memorySamples = [];
    this.maxMemorySamples = 100;

    // File handle for logging
    this.logFile = null;
    if (this.config.logToFile) {
      try {
        this.logFile = fs.openSync(this.config.logToFile, 'a');
        this.log('INFO', 'Performance monitoring started', {
          pid: process.pid,
          platform: os.platform(),
          arch: os.arch(),
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
        });
      } catch (err) {
        console.error('Failed to open performance log file:', err.message);
      }
    }
  }

  /**
   * Start timing an operation
   */
  start(operationName, metadata = {}) {
    if (!this.config.enabled) return null;

    const opId = `${operationName}_${Date.now()}_${Math.random()}`;
    const startTime = process.hrtime.bigint();
    const startMemory = this.config.trackMemory ? process.memoryUsage() : null;

    this.activeOps.set(opId, {
      name: operationName,
      startTime,
      startMemory,
      metadata,
    });

    if (this.config.verbose) {
      this.log('START', operationName, metadata);
    }

    return opId;
  }

  /**
   * End timing an operation
   */
  end(opId, additionalMetadata = {}) {
    if (!this.config.enabled || !opId) return null;

    const op = this.activeOps.get(opId);
    if (!op) {
      console.warn(`PerfMonitor: No active operation found for ID ${opId}`);
      return null;
    }

    const endTime = process.hrtime.bigint();
    const endMemory = this.config.trackMemory ? process.memoryUsage() : null;

    const durationNs = endTime - op.startTime;
    const durationMs = Number(durationNs) / 1_000_000;

    const result = {
      name: op.name,
      durationMs,
      timestamp: Date.now(),
      metadata: { ...op.metadata, ...additionalMetadata },
    };

    if (this.config.trackMemory && op.startMemory && endMemory) {
      result.memory = {
        heapUsedStart: op.startMemory.heapUsed,
        heapUsedEnd: endMemory.heapUsed,
        heapUsedDelta: endMemory.heapUsed - op.startMemory.heapUsed,
        rssStart: op.startMemory.rss,
        rssEnd: endMemory.rss,
        rssDelta: endMemory.rss - op.startMemory.rss,
        external: endMemory.external,
      };
    }

    // Store timing
    if (!this.timings.has(op.name)) {
      this.timings.set(op.name, []);
    }
    const timingArray = this.timings.get(op.name);
    timingArray.push(result);
    if (timingArray.length > this.maxSamples) {
      timingArray.shift();
    }

    // Log completion
    if (this.config.verbose) {
      this.log('END', op.name, {
        durationMs: durationMs.toFixed(2),
        ...result.memory,
        ...additionalMetadata,
      });
    }

    // Clean up
    this.activeOps.delete(opId);

    return result;
  }

  /**
   * Record a simple timing without start/end (for external measurements)
   */
  record(operationName, durationMs, metadata = {}) {
    if (!this.config.enabled) return;

    const result = {
      name: operationName,
      durationMs,
      timestamp: Date.now(),
      metadata,
    };

    if (!this.timings.has(operationName)) {
      this.timings.set(operationName, []);
    }
    const timingArray = this.timings.get(operationName);
    timingArray.push(result);
    if (timingArray.length > this.maxSamples) {
      timingArray.shift();
    }

    if (this.config.verbose) {
      this.log('RECORD', operationName, {
        durationMs: durationMs.toFixed(2),
        ...metadata,
      });
    }
  }

  /**
   * Sample current memory usage
   */
  sampleMemory(label = 'sample') {
    if (!this.config.enabled || !this.config.trackMemory) return null;

    const mem = process.memoryUsage();
    const sample = {
      timestamp: Date.now(),
      label,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    };

    this.memorySamples.push(sample);
    if (this.memorySamples.length > this.maxMemorySamples) {
      this.memorySamples.shift();
    }

    if (this.config.verbose) {
      this.log('MEMORY', label, {
        heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(2),
        rssMB: (mem.rss / 1024 / 1024).toFixed(2),
      });
    }

    return sample;
  }

  /**
   * Get statistics for an operation
   */
  getStats(operationName) {
    const timings = this.timings.get(operationName);
    if (!timings || timings.length === 0) {
      return null;
    }

    const durations = timings.map(t => t.durationMs);
    const sorted = [...durations].sort((a, b) => a - b);

    const stats = {
      operation: operationName,
      count: timings.length,
      min: Math.min(...durations),
      max: Math.max(...durations),
      mean: durations.reduce((a, b) => a + b, 0) / durations.length,
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      lastValue: durations[durations.length - 1],
    };

    // Add memory stats if available
    const withMemory = timings.filter(t => t.memory);
    if (withMemory.length > 0) {
      const heapDeltas = withMemory.map(t => t.memory.heapUsedDelta);
      const rssDeltas = withMemory.map(t => t.memory.rssDelta);

      stats.memory = {
        avgHeapDelta: heapDeltas.reduce((a, b) => a + b, 0) / heapDeltas.length,
        avgRssDelta: rssDeltas.reduce((a, b) => a + b, 0) / rssDeltas.length,
        maxHeapDelta: Math.max(...heapDeltas),
        maxRssDelta: Math.max(...rssDeltas),
      };
    }

    return stats;
  }

  /**
   * Get all statistics
   */
  getAllStats() {
    const allStats = {};
    for (const [name] of this.timings) {
      allStats[name] = this.getStats(name);
    }
    return allStats;
  }

  /**
   * Print summary report
   */
  printReport() {
    console.log('\n' + '='.repeat(70));
    console.log('PERFORMANCE REPORT');
    console.log('='.repeat(70));

    const stats = this.getAllStats();
    const operations = Object.keys(stats).sort();

    if (operations.length === 0) {
      console.log('No performance data collected.');
      return;
    }

    // Print timing statistics
    console.log('\nOperation Timings (ms):');
    console.log('-'.repeat(70));
    console.log('Operation'.padEnd(30) + 'Count'.padStart(6) + 'Mean'.padStart(8) + 'Median'.padStart(8) + 'P95'.padStart(8) + 'Max'.padStart(8));
    console.log('-'.repeat(70));

    for (const name of operations) {
      const s = stats[name];
      const row = name.padEnd(30) +
        s.count.toString().padStart(6) +
        s.mean.toFixed(1).padStart(8) +
        s.median.toFixed(1).padStart(8) +
        s.p95.toFixed(1).padStart(8) +
        s.max.toFixed(1).padStart(8);
      console.log(row);

      // Print memory stats if available
      if (s.memory) {
        const heapMB = (s.memory.avgHeapDelta / 1024 / 1024).toFixed(2);
        const rssMB = (s.memory.avgRssDelta / 1024 / 1024).toFixed(2);
        console.log(`  └─ Memory: Heap Δ ${heapMB}MB avg, RSS Δ ${rssMB}MB avg`);
      }
    }

    // Print memory summary
    if (this.config.trackMemory && this.memorySamples.length > 0) {
      console.log('\nMemory Usage:');
      console.log('-'.repeat(70));

      const latest = this.memorySamples[this.memorySamples.length - 1];
      const heapMB = (latest.heapUsed / 1024 / 1024).toFixed(2);
      const totalMB = (latest.heapTotal / 1024 / 1024).toFixed(2);
      const rssMB = (latest.rss / 1024 / 1024).toFixed(2);

      console.log(`Current: Heap ${heapMB}/${totalMB}MB, RSS ${rssMB}MB`);

      // Calculate peak
      const peakRss = Math.max(...this.memorySamples.map(s => s.rss));
      const peakHeap = Math.max(...this.memorySamples.map(s => s.heapUsed));
      console.log(`Peak: Heap ${(peakHeap / 1024 / 1024).toFixed(2)}MB, RSS ${(peakRss / 1024 / 1024).toFixed(2)}MB`);
    }

    console.log('='.repeat(70) + '\n');
  }

  /**
   * Export all data as JSON
   */
  exportJSON() {
    return {
      stats: this.getAllStats(),
      timings: Object.fromEntries(this.timings),
      memory: this.memorySamples,
      config: this.config,
    };
  }

  /**
   * Write to log file
   */
  log(level, operation, data) {
    if (!this.logFile) return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      operation,
      data,
    };

    try {
      fs.writeSync(this.logFile, JSON.stringify(logEntry) + '\n');
    } catch (err) {
      console.error('Failed to write to performance log:', err.message);
    }
  }

  /**
   * Close log file
   */
  close() {
    if (this.logFile) {
      try {
        fs.closeSync(this.logFile);
        this.logFile = null;
      } catch (err) {
        console.error('Failed to close performance log:', err.message);
      }
    }
  }
}

module.exports = PerfMonitor;

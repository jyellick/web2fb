const PerfMonitor = require('../../lib/perf-monitor');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('PerfMonitor', () => {
  let tempLogFile;

  beforeEach(() => {
    tempLogFile = path.join(os.tmpdir(), `perf-test-${Date.now()}.jsonl`);
  });

  afterEach(() => {
    // Clean up temp log files
    if (fs.existsSync(tempLogFile)) {
      fs.unlinkSync(tempLogFile);
    }
  });

  describe('Constructor', () => {
    it('should use default config when no config provided', () => {
      const perfMon = new PerfMonitor();

      expect(perfMon.config.enabled).toBe(true);
      expect(perfMon.config.verbose).toBe(false);
      expect(perfMon.config.logToFile).toBe(null);
      expect(perfMon.config.reportInterval).toBe(0);
      expect(perfMon.config.trackMemory).toBe(true);
      expect(perfMon.config.sampleInterval).toBe(100);
    });

    it('should store all config options correctly', () => {
      const config = {
        enabled: true,
        verbose: true,
        logToFile: '/tmp/test.jsonl',
        reportInterval: 60000,
        trackMemory: false,
        sampleInterval: 200
      };

      const perfMon = new PerfMonitor(config);

      expect(perfMon.config.enabled).toBe(true);
      expect(perfMon.config.verbose).toBe(true);
      expect(perfMon.config.logToFile).toBe('/tmp/test.jsonl');
      expect(perfMon.config.reportInterval).toBe(60000);
      expect(perfMon.config.trackMemory).toBe(false);
      expect(perfMon.config.sampleInterval).toBe(200);
    });

    it('should handle enabled: false correctly', () => {
      const perfMon = new PerfMonitor({ enabled: false });
      expect(perfMon.config.enabled).toBe(false);
    });

    it('should default enabled to true if not specified', () => {
      const perfMon = new PerfMonitor({});
      expect(perfMon.config.enabled).toBe(true);
    });

    it('should create log file when logToFile is specified', () => {
      const perfMon = new PerfMonitor({ logToFile: tempLogFile });

      expect(fs.existsSync(tempLogFile)).toBe(true);
      perfMon.close();
    });

    it('should write initial log entry when logToFile is specified', () => {
      const perfMon = new PerfMonitor({ logToFile: tempLogFile });
      perfMon.close();

      const content = fs.readFileSync(tempLogFile, 'utf8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.level).toBe('INFO');
      expect(entry.operation).toBe('Performance monitoring started');
    });
  });

  describe('start() and end()', () => {
    it('should return null when disabled', () => {
      const perfMon = new PerfMonitor({ enabled: false });
      const opId = perfMon.start('test-op');

      expect(opId).toBe(null);
    });

    it('should track operation timing', () => {
      const perfMon = new PerfMonitor({ enabled: true });
      const opId = perfMon.start('test-op');

      expect(opId).toBeTruthy();
      expect(typeof opId).toBe('string');
      expect(opId).toContain('test-op');

      const result = perfMon.end(opId);

      expect(result).toBeTruthy();
      expect(result.name).toBe('test-op');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('should store metadata in operation', () => {
      const perfMon = new PerfMonitor({ enabled: true });
      const opId = perfMon.start('test-op', { foo: 'bar' });
      const result = perfMon.end(opId, { baz: 'qux' });

      expect(result.metadata.foo).toBe('bar');
      expect(result.metadata.baz).toBe('qux');
    });

    it('should track memory when trackMemory is true', () => {
      const perfMon = new PerfMonitor({ enabled: true, trackMemory: true });
      const opId = perfMon.start('test-op');
      const result = perfMon.end(opId);

      expect(result.memory).toBeDefined();
      expect(result.memory.heapUsedStart).toBeGreaterThan(0);
      expect(result.memory.heapUsedEnd).toBeGreaterThan(0);
      expect(result.memory.rssStart).toBeGreaterThan(0);
      expect(result.memory.rssEnd).toBeGreaterThan(0);
    });

    it('should not track memory when trackMemory is false', () => {
      const perfMon = new PerfMonitor({ enabled: true, trackMemory: false });
      const opId = perfMon.start('test-op');
      const result = perfMon.end(opId);

      expect(result.memory).toBeUndefined();
    });

    it('should return null when ending non-existent operation', () => {
      const perfMon = new PerfMonitor({ enabled: true });
      const result = perfMon.end('non-existent-id');

      expect(result).toBe(null);
    });

    it('should store multiple operations', () => {
      const perfMon = new PerfMonitor({ enabled: true });

      const op1 = perfMon.start('op-1');
      const op2 = perfMon.start('op-2');

      perfMon.end(op1);
      perfMon.end(op2);

      const stats = perfMon.getAllStats();
      expect(Object.keys(stats)).toContain('op-1');
      expect(Object.keys(stats)).toContain('op-2');
    });
  });

  describe('record()', () => {
    it('should record timing without start/end', () => {
      const perfMon = new PerfMonitor({ enabled: true });

      perfMon.record('external-op', 123.45, { source: 'external' });

      const stats = perfMon.getStats('external-op');
      expect(stats).toBeTruthy();
      expect(stats.count).toBe(1);
      expect(stats.mean).toBe(123.45);
    });

    it('should do nothing when disabled', () => {
      const perfMon = new PerfMonitor({ enabled: false });

      perfMon.record('test-op', 100);

      const stats = perfMon.getStats('test-op');
      expect(stats).toBe(null);
    });
  });

  describe('sampleMemory()', () => {
    it('should return null when disabled', () => {
      const perfMon = new PerfMonitor({ enabled: false });
      const sample = perfMon.sampleMemory('test');

      expect(sample).toBe(null);
    });

    it('should return null when trackMemory is false', () => {
      const perfMon = new PerfMonitor({ enabled: true, trackMemory: false });
      const sample = perfMon.sampleMemory('test');

      expect(sample).toBe(null);
    });

    it('should capture memory sample', () => {
      const perfMon = new PerfMonitor({ enabled: true, trackMemory: true });
      const sample = perfMon.sampleMemory('test-label');

      expect(sample).toBeTruthy();
      expect(sample.label).toBe('test-label');
      expect(sample.heapUsed).toBeGreaterThan(0);
      expect(sample.heapTotal).toBeGreaterThan(0);
      expect(sample.rss).toBeGreaterThan(0);
      expect(sample.timestamp).toBeGreaterThan(0);
    });
  });

  describe('getStats()', () => {
    it('should return null for unknown operation', () => {
      const perfMon = new PerfMonitor({ enabled: true });
      const stats = perfMon.getStats('unknown-op');

      expect(stats).toBe(null);
    });

    it('should calculate statistics correctly', () => {
      const perfMon = new PerfMonitor({ enabled: true });

      // Record operations with known timings
      perfMon.record('test-op', 10);
      perfMon.record('test-op', 20);
      perfMon.record('test-op', 30);
      perfMon.record('test-op', 40);
      perfMon.record('test-op', 50);

      const stats = perfMon.getStats('test-op');

      expect(stats.count).toBe(5);
      expect(stats.min).toBe(10);
      expect(stats.max).toBe(50);
      expect(stats.mean).toBe(30);
      expect(stats.median).toBe(30);
      expect(stats.lastValue).toBe(50);
    });

    it('should calculate percentiles correctly', () => {
      const perfMon = new PerfMonitor({ enabled: true });

      // Record 100 operations: 1, 2, 3, ..., 100
      for (let i = 1; i <= 100; i++) {
        perfMon.record('test-op', i);
      }

      const stats = perfMon.getStats('test-op');

      expect(stats.count).toBe(100);
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(100);
      expect(stats.mean).toBe(50.5);
      expect(stats.median).toBe(51); // Math.floor(100/2) = 50th index = 51st value
      expect(stats.p95).toBe(96); // Math.floor(100*0.95) = 95th index = 96th value
      expect(stats.p99).toBe(100); // Math.floor(100*0.99) = 99th index = 100th value
    });

    it('should include memory stats when available', () => {
      const perfMon = new PerfMonitor({ enabled: true, trackMemory: true });

      const op1 = perfMon.start('mem-op');
      perfMon.end(op1);

      const op2 = perfMon.start('mem-op');
      perfMon.end(op2);

      const stats = perfMon.getStats('mem-op');

      expect(stats.memory).toBeDefined();
      expect(stats.memory.avgHeapDelta).toBeDefined();
      expect(stats.memory.avgRssDelta).toBeDefined();
    });
  });

  describe('getAllStats()', () => {
    it('should return empty object when no operations tracked', () => {
      const perfMon = new PerfMonitor({ enabled: true });
      const stats = perfMon.getAllStats();

      expect(stats).toEqual({});
    });

    it('should return stats for all operations', () => {
      const perfMon = new PerfMonitor({ enabled: true });

      perfMon.record('op-1', 10);
      perfMon.record('op-2', 20);
      perfMon.record('op-3', 30);

      const stats = perfMon.getAllStats();

      expect(Object.keys(stats)).toHaveLength(3);
      expect(stats['op-1']).toBeDefined();
      expect(stats['op-2']).toBeDefined();
      expect(stats['op-3']).toBeDefined();
    });
  });

  describe('printReport()', () => {
    it('should print "No performance data" when no operations tracked', () => {
      const perfMon = new PerfMonitor({ enabled: true });

      // Capture console.log output
      const originalLog = console.log;
      const logs = [];
      console.log = (...args) => logs.push(args.join(' '));

      perfMon.printReport();

      console.log = originalLog;

      const output = logs.join('\n');
      expect(output).toContain('PERFORMANCE REPORT');
      expect(output).toContain('No performance data collected');
    });

    it('should print formatted report with operations', () => {
      const perfMon = new PerfMonitor({ enabled: true });

      perfMon.record('test-op', 123.45);

      const originalLog = console.log;
      const logs = [];
      console.log = (...args) => logs.push(args.join(' '));

      perfMon.printReport();

      console.log = originalLog;

      const output = logs.join('\n');
      expect(output).toContain('PERFORMANCE REPORT');
      expect(output).toContain('Operation Timings');
      expect(output).toContain('test-op');
      expect(output).toContain('123.5'); // 123.45 rounds to 123.5 with toFixed(1)
    });
  });

  describe('exportJSON()', () => {
    it('should export all data as JSON', () => {
      const perfMon = new PerfMonitor({ enabled: true, reportInterval: 60000 });

      perfMon.record('test-op', 100);
      perfMon.sampleMemory('test-sample');

      const exported = perfMon.exportJSON();

      expect(exported.stats).toBeDefined();
      expect(exported.timings).toBeDefined();
      expect(exported.memory).toBeDefined();
      expect(exported.config).toBeDefined();
      expect(exported.config.reportInterval).toBe(60000);
    });
  });

  describe('Verbose logging', () => {
    it('should write START and END to log file when verbose is true', () => {
      const perfMon = new PerfMonitor({
        enabled: true,
        verbose: true,
        logToFile: tempLogFile
      });

      const opId = perfMon.start('verbose-op', { foo: 'bar' });
      perfMon.end(opId, { baz: 'qux' });

      perfMon.close();

      const content = fs.readFileSync(tempLogFile, 'utf8');
      const lines = content.trim().split('\n');

      // Should have: INFO (startup), START, END
      expect(lines.length).toBe(3);

      const startEntry = JSON.parse(lines[1]);
      expect(startEntry.level).toBe('START');
      expect(startEntry.operation).toBe('verbose-op');
      expect(startEntry.data.foo).toBe('bar');

      const endEntry = JSON.parse(lines[2]);
      expect(endEntry.level).toBe('END');
      expect(endEntry.operation).toBe('verbose-op');
      expect(endEntry.data.durationMs).toBeDefined();
      expect(endEntry.data.baz).toBe('qux');
    });

    it('should not write START/END to log file when verbose is false', () => {
      const perfMon = new PerfMonitor({
        enabled: true,
        verbose: false,
        logToFile: tempLogFile
      });

      const opId = perfMon.start('quiet-op');
      perfMon.end(opId);

      perfMon.close();

      const content = fs.readFileSync(tempLogFile, 'utf8');
      const lines = content.trim().split('\n');

      // Should only have INFO (startup)
      expect(lines.length).toBe(1);
    });
  });

  describe('Edge cases', () => {
    it('should handle very fast operations (< 1ms)', () => {
      const perfMon = new PerfMonitor({ enabled: true });

      const opId = perfMon.start('fast-op');
      const result = perfMon.end(opId);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(10); // Should be very fast
    });

    it('should handle single operation statistics', () => {
      const perfMon = new PerfMonitor({ enabled: true });

      perfMon.record('single-op', 42);

      const stats = perfMon.getStats('single-op');

      expect(stats.count).toBe(1);
      expect(stats.min).toBe(42);
      expect(stats.max).toBe(42);
      expect(stats.mean).toBe(42);
      expect(stats.median).toBe(42);
    });

    it('should limit operation history to maxSamples', () => {
      const perfMon = new PerfMonitor({ enabled: true });

      // Record more than maxSamples (100)
      for (let i = 0; i < 150; i++) {
        perfMon.record('limited-op', i);
      }

      const stats = perfMon.getStats('limited-op');

      // Should only keep last 100
      expect(stats.count).toBe(100);
    });

    it('should close log file without errors', () => {
      const perfMon = new PerfMonitor({ logToFile: tempLogFile });

      expect(() => perfMon.close()).not.toThrow();
      expect(() => perfMon.close()).not.toThrow(); // Should be idempotent
    });
  });
});

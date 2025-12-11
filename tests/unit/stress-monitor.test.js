const StressMonitor = require('../../lib/stress-monitor');

describe('StressMonitor', () => {
  let monitor;

  beforeEach(() => {
    monitor = new StressMonitor({
      enabled: true,
      thresholds: {
        overlayUpdateWarning: 100,
        overlayUpdateCritical: 200,
        baseImageWarning: 150,
        baseImageCritical: 300,
      },
      recovery: {
        maxConsecutiveSlowOps: 2,
        killBrowserThreshold: 3,
      }
    });
  });

  describe('Stress Level Tracking', () => {
    test('should start at stress level 0', () => {
      expect(monitor.stressLevel).toBe(0);
      expect(monitor.getStressLevelName()).toBe('NORMAL');
    });

    test('should increase stress level on slow operations', () => {
      monitor.recordOperation('overlay', 150, true); // Warning
      expect(monitor.stressLevel).toBe(1); // MILD
    });

    test('should increase stress level after consecutive slow ops', () => {
      monitor.recordOperation('overlay', 150, true); // Warning
      monitor.recordOperation('overlay', 150, true); // Warning
      expect(monitor.stressLevel).toBe(2); // MODERATE
    });

    test('should reach critical level after threshold critical events', () => {
      monitor.recordOperation('overlay', 250, true); // Critical
      monitor.recordOperation('overlay', 250, true); // Critical
      monitor.recordOperation('overlay', 250, true); // Critical
      expect(monitor.stressLevel).toBe(3); // SEVERE
      expect(monitor.needsBrowserRestart()).toBe(true);
    });

    test('should recover from stress with fast operations', () => {
      monitor.recordOperation('overlay', 150, true); // Warning
      expect(monitor.stressLevel).toBe(1);

      monitor.recordOperation('overlay', 50, true); // Fast
      expect(monitor.stressLevel).toBe(0); // Back to normal
    });
  });

  describe('Operation Throttling', () => {
    test('should allow base image recapture when not stressed', () => {
      expect(monitor.shouldAllowBaseImageRecapture()).toBe(true);
    });

    test('should throttle base image recapture at mild stress if in progress', () => {
      monitor.recordOperation('overlay', 150, true); // MILD
      monitor.startBaseImageOperation();
      expect(monitor.shouldAllowBaseImageRecapture()).toBe(false);
      monitor.endBaseImageOperation();
    });

    test('should block base image recapture at moderate stress', () => {
      monitor.recordOperation('overlay', 150, true);
      monitor.recordOperation('overlay', 150, true); // MODERATE
      expect(monitor.shouldAllowBaseImageRecapture()).toBe(false);
    });

    test('should allow change detection when not stressed', () => {
      expect(monitor.shouldAllowChangeDetection()).toBe(true);
    });

    test('should block change detection at moderate stress', () => {
      monitor.recordOperation('overlay', 150, true);
      monitor.recordOperation('overlay', 150, true); // MODERATE
      expect(monitor.shouldAllowChangeDetection()).toBe(false);
    });
  });

  describe('Concurrency Guards', () => {
    test('should track base image operation in progress', () => {
      expect(monitor.baseImageInProgress).toBe(false);
      monitor.startBaseImageOperation();
      expect(monitor.baseImageInProgress).toBe(true);
      monitor.endBaseImageOperation();
      expect(monitor.baseImageInProgress).toBe(false);
    });

    test('should track change detection in progress', () => {
      expect(monitor.changeDetectionInProgress).toBe(false);
      monitor.startChangeDetection();
      expect(monitor.changeDetectionInProgress).toBe(true);
      monitor.endChangeDetection();
      expect(monitor.changeDetectionInProgress).toBe(false);
    });
  });

  describe('Recovery Mode', () => {
    test('should enter and exit recovery mode', () => {
      expect(monitor.inRecoveryMode).toBe(false);
      monitor.enterRecoveryMode();
      expect(monitor.inRecoveryMode).toBe(true);

      // All operations blocked in recovery
      expect(monitor.shouldAllowBaseImageRecapture()).toBe(false);
      expect(monitor.shouldAllowChangeDetection()).toBe(false);

      monitor.exitRecoveryMode();
      expect(monitor.inRecoveryMode).toBe(false);
      expect(monitor.stressLevel).toBe(0); // Reset
      expect(monitor.criticalEvents).toBe(0);
    });
  });

  describe('Disabled Mode', () => {
    test('should allow all operations when disabled', () => {
      const disabledMonitor = new StressMonitor({ enabled: false });

      // Record critical operations
      disabledMonitor.recordOperation('overlay', 1000, true);
      disabledMonitor.recordOperation('overlay', 1000, true);
      disabledMonitor.recordOperation('overlay', 1000, true);

      // Should not block anything
      expect(disabledMonitor.shouldAllowBaseImageRecapture()).toBe(true);
      expect(disabledMonitor.shouldAllowChangeDetection()).toBe(true);
      expect(disabledMonitor.needsBrowserRestart()).toBe(false);
    });
  });

  describe('Statistics', () => {
    test('should provide stress statistics', () => {
      monitor.recordOperation('overlay', 150, true);
      const stats = monitor.getStats();

      expect(stats).toHaveProperty('stressLevel');
      expect(stats).toHaveProperty('stressLevelName');
      expect(stats).toHaveProperty('consecutiveSlowOps');
      expect(stats).toHaveProperty('criticalEvents');
      expect(stats.stressLevel).toBe(1);
      expect(stats.stressLevelName).toBe('MILD');
    });
  });
});

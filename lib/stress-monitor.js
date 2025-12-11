/**
 * Stress Monitor - Detects system stress and manages recovery
 * Prioritizes user-visible operations (overlays) over invisible ones (base image recapture)
 */

class StressMonitor {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      thresholds: {
        overlayUpdateWarning: config.thresholds?.overlayUpdateWarning || 3000,
        overlayUpdateCritical: config.thresholds?.overlayUpdateCritical || 10000,
        baseImageWarning: config.thresholds?.baseImageWarning || 5000,
        baseImageCritical: config.thresholds?.baseImageCritical || 15000,
      },
      recovery: {
        skipUpdatesOnStress: config.recovery?.skipUpdatesOnStress !== false,
        maxConsecutiveSlowOps: config.recovery?.maxConsecutiveSlowOps || 3,
        cooldownPeriod: config.recovery?.cooldownPeriod || 30000,
        killBrowserThreshold: config.recovery?.killBrowserThreshold || 3,
        recoveryCheckInterval: config.recovery?.recoveryCheckInterval || 5000,
      }
    };

    // Stress tracking
    this.stressLevel = 0; // 0 = normal, 1 = mild, 2 = moderate, 3 = severe
    this.consecutiveSlowOps = 0;
    this.criticalEvents = 0;
    this.lastRecoveryTime = 0;

    // Operation tracking
    this.operationHistory = {
      baseImage: [],
      overlay: [],
    };
    this.maxHistorySize = 10;

    // Concurrency guards
    this.baseImageInProgress = false;
    this.changeDetectionInProgress = false;
    this.inRecoveryMode = false;
  }

  /**
   * Record an operation's timing and update stress level
   */
  recordOperation(type, duration, success = true) {
    if (!this.config.enabled) return;

    const history = this.operationHistory[type];
    if (history) {
      history.push({ duration, success, timestamp: Date.now() });
      if (history.length > this.maxHistorySize) {
        history.shift();
      }
    }

    // Check thresholds
    const thresholds = this.config.thresholds;
    let isWarning = false;
    let isCritical = false;

    if (type === 'baseImage') {
      isWarning = duration > thresholds.baseImageWarning;
      isCritical = duration > thresholds.baseImageCritical;
    } else if (type === 'overlay') {
      isWarning = duration > thresholds.overlayUpdateWarning;
      isCritical = duration > thresholds.overlayUpdateCritical;
    }

    // Update stress tracking
    if (isCritical) {
      this.consecutiveSlowOps++;
      this.criticalEvents++;
      console.warn(`⚠️  CRITICAL: ${type} operation took ${duration}ms (threshold: ${isCritical ? thresholds[type + 'Critical'] : thresholds[type + 'Warning']}ms)`);
    } else if (isWarning) {
      this.consecutiveSlowOps++;
      console.warn(`⚠️  WARNING: ${type} operation took ${duration}ms`);
    } else {
      // Reset consecutive counter on successful fast operation
      this.consecutiveSlowOps = Math.max(0, this.consecutiveSlowOps - 1);
    }

    // Update stress level
    this.updateStressLevel();
  }

  /**
   * Update overall stress level based on recent operations
   */
  updateStressLevel() {
    const oldLevel = this.stressLevel;

    if (this.criticalEvents >= this.config.recovery.killBrowserThreshold) {
      this.stressLevel = 3; // Severe - needs browser restart
    } else if (this.consecutiveSlowOps >= this.config.recovery.maxConsecutiveSlowOps) {
      this.stressLevel = 2; // Moderate - pause invisible operations
    } else if (this.consecutiveSlowOps > 0) {
      this.stressLevel = 1; // Mild - throttle invisible operations
    } else {
      this.stressLevel = 0; // Normal
    }

    if (this.stressLevel !== oldLevel) {
      this.logStressLevelChange(oldLevel, this.stressLevel);
    }
  }

  /**
   * Log stress level changes
   */
  logStressLevelChange(oldLevel, newLevel) {
    const levels = ['NORMAL', 'MILD', 'MODERATE', 'SEVERE'];
    const actions = [
      'All operations running normally',
      'Throttling invisible operations (base image recapture)',
      'Pausing invisible operations, keeping overlays active',
      'CRITICAL - Browser restart required'
    ];

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚨 STRESS LEVEL: ${levels[oldLevel]} → ${levels[newLevel]}`);
    console.log(`📊 Action: ${actions[newLevel]}`);
    console.log(`📈 Stats: ${this.consecutiveSlowOps} consecutive slow ops, ${this.criticalEvents} critical events`);
    console.log(`${'='.repeat(60)}\n`);
  }

  /**
   * Check if base image recapture should be allowed
   */
  shouldAllowBaseImageRecapture() {
    if (!this.config.enabled) return true;
    if (this.inRecoveryMode) return false;

    // Level 2+ (Moderate/Severe): Block all base image recapture
    if (this.stressLevel >= 2) {
      console.log('⏸️  Skipping base image recapture (stress level:', this.getStressLevelName(), ')');
      return false;
    }

    // Level 1 (Mild): Block if already in progress (prevent queuing)
    if (this.stressLevel >= 1 && this.baseImageInProgress) {
      console.log('⏸️  Skipping base image recapture (operation already in progress)');
      return false;
    }

    return true;
  }

  /**
   * Check if change detection should be allowed
   */
  shouldAllowChangeDetection() {
    if (!this.config.enabled) return true;
    if (this.inRecoveryMode) return false;

    // Level 2+ (Moderate/Severe): Block all change detection
    if (this.stressLevel >= 2) {
      return false;
    }

    // Level 1 (Mild): Block if already in progress
    if (this.stressLevel >= 1 && this.changeDetectionInProgress) {
      return false;
    }

    return true;
  }

  /**
   * Check if browser restart is needed
   */
  needsBrowserRestart() {
    if (!this.config.enabled) return false;
    return this.stressLevel >= 3;
  }

  /**
   * Mark base image operation as in progress
   */
  startBaseImageOperation() {
    this.baseImageInProgress = true;
  }

  /**
   * Mark base image operation as complete
   */
  endBaseImageOperation() {
    this.baseImageInProgress = false;
  }

  /**
   * Mark change detection as in progress
   */
  startChangeDetection() {
    this.changeDetectionInProgress = true;
  }

  /**
   * Mark change detection as complete
   */
  endChangeDetection() {
    this.changeDetectionInProgress = false;
  }

  /**
   * Enter recovery mode
   */
  enterRecoveryMode() {
    this.inRecoveryMode = true;
    console.log('🔧 Entering recovery mode - all updates paused');
  }

  /**
   * Exit recovery mode and reset stress tracking
   */
  exitRecoveryMode() {
    this.inRecoveryMode = false;
    this.stressLevel = 0;
    this.consecutiveSlowOps = 0;
    this.criticalEvents = 0;
    this.lastRecoveryTime = Date.now();
    this.baseImageInProgress = false;
    this.changeDetectionInProgress = false;
    console.log('✅ Recovery complete - resuming normal operations');
  }

  /**
   * Get current stress level as a string
   */
  getStressLevelName() {
    const levels = ['NORMAL', 'MILD', 'MODERATE', 'SEVERE'];
    return levels[this.stressLevel] || 'UNKNOWN';
  }

  /**
   * Get stress statistics
   */
  getStats() {
    return {
      stressLevel: this.stressLevel,
      stressLevelName: this.getStressLevelName(),
      consecutiveSlowOps: this.consecutiveSlowOps,
      criticalEvents: this.criticalEvents,
      baseImageInProgress: this.baseImageInProgress,
      changeDetectionInProgress: this.changeDetectionInProgress,
      inRecoveryMode: this.inRecoveryMode,
      lastRecoveryTime: this.lastRecoveryTime,
    };
  }
}

module.exports = StressMonitor;

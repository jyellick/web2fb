# Stress Management

Intelligent memory protection for resource-constrained hardware.

## Overview

On devices like Raspberry Pi Zero 2 W (512MB RAM), memory pressure can cause the system to thrash and crash. The stress management system monitors performance and intelligently throttles operations before problems occur.

## How It Works

web2fb tracks operation timing and detects four stress levels:

### 1. Normal (Level 0)
- All operations running smoothly
- No throttling

### 2. Mild Stress (Level 1)
- Operations taking longer than warning thresholds
- **Action**: Throttles background page re-renders
- **Effect**: Clock keeps updating, background paused

### 3. Moderate Stress (Level 2)
- Multiple consecutive slow operations
- **Action**: Pauses all background operations
- **Effect**: Only overlays update (user-visible elements)

### 4. Severe Stress (Level 3)
- Critical events threshold reached
- **Action**: Restarts browser in-process
- **Effect**: Browser closes, cleans up, waits for cooldown, relaunches

## Key Principle

**Prioritize user-visible over invisible operations**

The clock updating every second is visible to the user - if it stops, the display appears frozen. The background page re-rendering is invisible - users don't notice if it's delayed.

## Configuration

```json
{
  "stressManagement": {
    "enabled": true,                     // Enable stress monitoring (default: true)
    "thresholds": {
      "overlayUpdateWarning": 3000,      // Warn if overlay update >3s
      "overlayUpdateCritical": 10000,    // Critical if overlay update >10s
      "baseImageWarning": 5000,          // Warn if page render >5s
      "baseImageCritical": 15000         // Critical if page render >15s
    },
    "recovery": {
      "skipUpdatesOnStress": true,       // Skip redundant updates when stressed
      "maxConsecutiveSlowOps": 3,        // Consecutive slow ops before throttling
      "killBrowserThreshold": 3,         // Critical events before browser restart
      "cooldownPeriod": 30000,           // Wait time after restart (ms)
      "recoveryCheckInterval": 5000,     // Check stress level every 5s
      "profileSizeThresholdMB": 40       // Restart if Chrome profile exceeds this
    }
  }
}
```

## Critical Event Decay

Critical events decay over time - each successful fast operation decrements the counter. This means old stress events from hours ago don't count against the system if it's running smoothly now.

## In-Process Browser Restart

When severe stress is detected, web2fb restarts the browser **within the same process**:

1. Clears all update intervals
2. Closes browser and cleans up Chrome profile
3. Waits for cooldown period (default: 30s)
4. Re-launches browser and re-initializes
5. Continues running

**Benefits**:
- Framebuffer stays intact (last image remains visible)
- No splash screen on restart
- Faster recovery than full process restart
- No systemd restart needed

## Chrome Profile Size Monitoring

Chrome's profile in `/tmp` is backed by RAM (tmpfs). If the profile grows too large, it consumes precious RAM. web2fb monitors profile size and triggers browser restart if it exceeds the threshold.

Default: 40MB (configurable via `profileSizeThresholdMB`)

## Monitoring Stress

Check logs for stress events:

```bash
# View stress level changes
sudo journalctl -u web2fb.service | grep "STRESS LEVEL"

# View critical events
sudo journalctl -u web2fb.service | grep "CRITICAL"

# View browser restarts
sudo journalctl -u web2fb.service | grep "Restarting browser"
```

## Tuning Thresholds

If browser restarts are too frequent, increase thresholds:

```json
{
  "stressManagement": {
    "thresholds": {
      "baseImageCritical": 20000,
      "overlayUpdateCritical": 15000
    },
    "recovery": {
      "killBrowserThreshold": 5
    }
  }
}
```

If system crashes before restart triggers, decrease thresholds:

```json
{
  "stressManagement": {
    "thresholds": {
      "baseImageCritical": 10000,
      "overlayUpdateCritical": 8000
    },
    "recovery": {
      "killBrowserThreshold": 2
    }
  }
}
```

## Drop-Frame Behavior

web2fb implements "drop-frame" logic - if an overlay update is still in progress when the next update interval fires, it skips that frame rather than queuing it up.

This prevents the clock from "jumping" multiple times when the system falls behind.

## Best Practices

1. **Enable stress management** - It's on by default, leave it enabled
2. **Monitor logs** - Check for frequent restarts
3. **Tune thresholds** - Adjust based on your hardware and content
4. **Use overlays** - Reduces load significantly
5. **Lower resolution** - If possible, use 1280x720 instead of 1920x1080
6. **Console mode** - Disable GUI to free up ~200MB RAM

## Debugging

Enable detailed logging:

```bash
# Watch stress events in real-time
sudo journalctl -u web2fb.service -f | grep -E "(STRESS|CRITICAL|WARNING)"
```

Stats shown in logs:
- Consecutive slow ops
- Critical events
- Current stress level
- Operation timing

## See Also

- [Configuration Reference](configuration.md)
- [Troubleshooting](troubleshooting.md)
- [Installation](installation.md) - System optimization tips

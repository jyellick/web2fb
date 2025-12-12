# Performance Profiling

web2fb includes comprehensive performance instrumentation to help identify bottlenecks and optimize performance on resource-constrained hardware like the Raspberry Pi Zero 2 W.

## Overview

The performance monitoring system tracks:
- **Timing**: How long each operation takes (browser launch, page load, screenshots, image processing, framebuffer writes, overlays)
- **Memory**: Heap and RSS memory usage before/after operations
- **Statistics**: Min, max, mean, median, P95, P99 for all operations

## Quick Start

### Enable Basic Monitoring

Add to your `config.json`:

```json
{
  "perfMonitoring": {
    "enabled": true
  }
}
```

Run web2fb and press `Ctrl+C` to see a performance report on exit.

### Enable Verbose Logging

For detailed operation-by-operation logging:

```json
{
  "perfMonitoring": {
    "enabled": true,
    "verbose": true
  }
}
```

### Log to File

To save performance data for later analysis:

```json
{
  "perfMonitoring": {
    "enabled": true,
    "logToFile": "/tmp/web2fb-perf.jsonl"
  }
}
```

Each line in the log file is a JSON object:
```json
{"timestamp":"2025-01-15T10:30:45.123Z","level":"START","operation":"browser:launch","data":{}}
{"timestamp":"2025-01-15T10:30:48.456Z","level":"END","operation":"browser:launch","data":{"durationMs":"3333.12"}}
```

### Periodic Reports

To print performance reports at regular intervals:

```json
{
  "perfMonitoring": {
    "enabled": true,
    "reportInterval": 60000
  }
}
```

This prints a full report every 60 seconds (60000ms).

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable performance monitoring |
| `verbose` | boolean | `false` | Log every operation start/end |
| `logToFile` | string | `null` | Path to JSONL log file |
| `reportInterval` | integer | `0` | Milliseconds between reports (0 = disabled) |
| `trackMemory` | boolean | `true` | Track memory usage per operation |

## Understanding the Report

When you stop web2fb (Ctrl+C) or at `reportInterval`, you'll see:

```
======================================================================
PERFORMANCE REPORT
======================================================================

Operation Timings (ms):
----------------------------------------------------------------------
Operation                      Count   Mean  Median     P95     Max
----------------------------------------------------------------------
browser:launch                     1 3245.2  3245.2  3245.2  3245.2
browser:pageLoad                   1 4521.8  4521.8  4521.8  4521.8
browser:screenshot                 1 1234.5  1234.5  1234.5  1234.5
browser:waitForImages              1  567.3   567.3   567.3   567.3
writeToFramebuffer:total           1  123.4   123.4   123.4   123.4
  └─ Memory: Heap Δ 12.34MB avg, RSS Δ 15.67MB avg
writeToFramebuffer:sharpConvert    1   89.2    89.2    89.2    89.2
writeToFramebuffer:fbWrite         1   34.2    34.2    34.2    34.2
overlay:total                    120   45.3    42.1    78.9   156.7
overlay:generate                 120    2.1     1.9     4.2     8.3
overlay:composite                120   23.4    21.2    42.1    89.4
writePartialToFramebuffer:total  120   19.8    18.3    35.6    71.2

Memory Usage:
----------------------------------------------------------------------
Current: Heap 234.56/512.00MB, RSS 345.67MB
Peak: Heap 456.78MB, RSS 567.89MB
======================================================================
```

### Key Metrics

- **Count**: Number of times this operation ran
- **Mean**: Average duration
- **Median**: Middle value (less affected by outliers)
- **P95**: 95th percentile (useful for finding slowdowns)
- **Max**: Worst case duration

### Memory Deltas

Memory changes show:
- **Heap Δ**: Change in JavaScript heap memory
- **RSS Δ**: Change in Resident Set Size (actual RAM used)

Positive deltas indicate memory allocation, negative indicates freeing.

## Operations Tracked

### Browser Operations

| Operation | Description | What to Look For |
|-----------|-------------|------------------|
| `browser:launch` | Puppeteer browser startup | Should be ~2-5s on Pi Zero 2 W |
| `browser:pageLoad` | page.goto() duration | Depends on page complexity and network |
| `browser:waitForImages` | Waiting for images to load | Network-dependent, can be slow |
| `browser:screenshot` | page.screenshot() call | Should be ~500ms-2s for full page |

### Framebuffer Operations

| Operation | Description | What to Look For |
|-----------|-------------|------------------|
| `writeToFramebuffer:total` | Full-screen framebuffer write | Should be <200ms typically |
| `writeToFramebuffer:sharpConvert` | Sharp image format conversion | CPU-intensive, ~50-100ms |
| `writeToFramebuffer:fbWrite` | Actual fs.writeSync to /dev/fb0 | Should be very fast (<50ms) |
| `convertToRGB565` | RGB to RGB565 conversion (16bpp only) | CPU loop, scales with resolution |

### Partial Framebuffer Operations

| Operation | Description | What to Look For |
|-----------|-------------|------------------|
| `writePartialToFramebuffer:total` | Overlay region write | Much faster than full write |
| `writePartialToFramebuffer:sharpConvert` | Sharp conversion for region | Small regions = fast |
| `writePartialToFramebuffer:fbWrite` | Line-by-line write to fb | Scales with region height |

### Overlay Operations

| Operation | Description | What to Look For |
|-----------|-------------|------------------|
| `overlay:total` | Complete overlay update | Should be <100ms for clocks |
| `overlay:generate` | Generate overlay SVG/PNG | Very fast (<5ms) for simple overlays |
| `overlay:composite` | Sharp extract + composite | Main cost of overlay updates |

### Base Image Operations

| Operation | Description | What to Look For |
|-----------|-------------|------------------|
| `baseImage:recapture` | Full page re-render | Expensive, should be infrequent |
| `baseImage:screenshot` | Screenshot during recapture | Same as browser:screenshot |

## Identifying Bottlenecks

### High Browser Launch Time

**Symptom**: `browser:launch > 5000ms`

**Causes**:
- Slow SD card
- CPU throttling
- Insufficient RAM

**Solutions**:
- Use faster SD card (A2 rated)
- Check `vcgencmd measure_temp` for thermal throttling
- Reduce browser args (though already minimal)

### Slow Page Load

**Symptom**: `browser:pageLoad > 30000ms`

**Causes**:
- Slow network connection
- Complex page with many resources
- JavaScript-heavy page

**Solutions**:
- Increase `browser.timeout` in config
- Optimize the source webpage
- Use local caching proxy

### Slow Screenshots

**Symptom**: `browser:screenshot > 2000ms`

**Causes**:
- High resolution
- Complex page rendering
- CPU under load

**Solutions**:
- Reduce display resolution
- Disable animations (`browser.disableAnimations: true`)
- Ensure no background processes consuming CPU

### Slow Sharp Processing

**Symptom**: `writeToFramebuffer:sharpConvert > 150ms`

**Causes**:
- High resolution images
- Complex format conversions
- CPU throttling

**Solutions**:
- Use JPEG quality < 90
- Reduce display resolution
- Check for thermal throttling

### Slow RGB565 Conversion

**Symptom**: `convertToRGB565 > 100ms`

**Causes**:
- High resolution (every pixel is processed)
- Pure JavaScript loop (no SIMD)

**Solutions**:
- Use 32bpp framebuffer if possible (no conversion needed)
- Reduce resolution
- This is CPU-bound, limited optimization possible

### Slow Overlay Updates

**Symptom**: `overlay:total > 100ms`

**Causes**:
- Large overlay regions
- Complex compositing
- Sharp operations on large regions

**Solutions**:
- Make overlay regions as small as possible
- Simplify overlay content
- Reduce overlay update frequency

### High Memory Usage

**Symptom**: Peak RSS > 400MB on Pi Zero 2 W (512MB total)

**Causes**:
- Large images/buffers
- Memory leaks
- Chrome profile growth

**Solutions**:
- Reduce resolution
- Monitor Chrome profile size (stress management does this)
- Check for base image recapture loops

## Example: Profiling on Pi Zero 2 W

Create `config-perf.json`:

```json
{
  "name": "Performance Profiling",
  "display": {
    "url": "https://example.com",
    "width": 800,
    "height": 480
  },
  "perfMonitoring": {
    "enabled": true,
    "verbose": true,
    "logToFile": "/tmp/web2fb-perf.jsonl",
    "reportInterval": 300000
  },
  "overlays": [
    {
      "name": "clock",
      "type": "clock",
      "selector": "#clock",
      "updateInterval": 1000
    }
  ]
}
```

Run:
```bash
node web2fb.js --config=config-perf.json
```

Let it run for 5+ minutes, then stop with Ctrl+C.

Review the report to identify:
1. Which operations take the most time
2. Whether overlays are completing within their update interval
3. Memory growth over time
4. P95/P99 outliers indicating sporadic slowdowns

## Analyzing Log Files

The JSONL log file can be analyzed with standard tools:

### Extract all durations for an operation

```bash
grep 'browser:screenshot' /tmp/web2fb-perf.jsonl | \
  jq -r '.data.durationMs' | \
  sort -n
```

### Calculate average duration

```bash
grep 'overlay:total' /tmp/web2fb-perf.jsonl | \
  jq -r '.data.durationMs' | \
  awk '{sum+=$1; count++} END {print sum/count}'
```

### Find slow operations (>1000ms)

```bash
jq 'select(.level=="END" and (.data.durationMs | tonumber) > 1000)' \
  /tmp/web2fb-perf.jsonl
```

## Best Practices

1. **Profile on actual hardware** - Pi Zero 2 W performance is very different from desktop
2. **Run for extended periods** - Initial runs don't show memory leaks or gradual slowdowns
3. **Compare before/after** - Profile before and after changes to verify improvements
4. **Focus on P95, not just mean** - Occasional slowdowns affect user experience
5. **Track memory deltas** - Memory growth over time indicates leaks
6. **Use verbose mode sparingly** - Creates large log files, adds some overhead
7. **Correlate with system metrics** - Use `htop`, `vcgencmd measure_temp`, etc.

## Troubleshooting

### "No performance data collected"

- Ensure `perfMonitoring.enabled: true`
- Check that operations are actually running
- Verify verbose mode if you want to see individual operations

### Large log files

- Disable verbose mode: `verbose: false`
- Reduce `reportInterval` or set to 0
- Rotate log files externally

### Performance overhead

- Performance monitoring adds ~1-5ms overhead per operation
- Verbose mode adds more overhead (I/O for logging)
- For production, use `enabled: false` or minimal config

### Memory samples not appearing

- Ensure `trackMemory: true` (default)
- Memory tracking adds minimal overhead
- Check that operations are completing successfully

## Related Documentation

- [Configuration](configuration.md) - Full config schema
- [Troubleshooting](troubleshooting.md) - General debugging guide
- [Stress Management](../README.md#stress-management) - Automatic throttling under load

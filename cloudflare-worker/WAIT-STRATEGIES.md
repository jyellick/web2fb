# Wait Strategies for Screenshot Timing

Your Cloudflare Worker now supports multiple strategies for ensuring pages are fully loaded before taking screenshots.

## Execution Order

The Worker executes wait strategies in this order:

```
1. Page Navigation (with networkidle2 or networkidle0)
2. Scroll page (triggers lazy loading)
3. waitForSelector (if specified)
4. waitForImages (default: true)
5. waitDelay (if specified)
6. Take Screenshot
```

## Default Behavior (No Extra Config)

```yaml
browser:
  mode: remote
  remoteScreenshotUrl: https://your-worker.workers.dev
  remoteApiKey: your-key
```

**What happens:**
1. Navigate to page and wait for `networkidle2` (≤2 network connections for 500ms)
2. Scroll page 3 times to trigger lazy-loaded content
3. Wait for all images and background images to load
4. Take screenshot

This should work for most pages but may miss content that loads after network idle.

## Strategy 1: Add Extra Delay (Simplest)

```yaml
browser:
  waitDelay: 5000  # Wait 5 extra seconds
```

**Use when:** Content loads after network idle or images finish
**Execution:** Waits 5 seconds AFTER all images load, before screenshot
**Pros:** Simple, catches everything
**Cons:** Always waits full time, even if page loads faster

## Strategy 2: Wait for Specific Element

```yaml
browser:
  waitForSelector: '.calendar-grid'  # Wait for calendar to appear
```

**Use when:** Page has a reliable "ready" indicator
**Execution:** Waits for selector to appear BEFORE checking images
**Pros:** Precise, doesn't waste time
**Cons:** Requires knowing the right selector

## Strategy 3: Stricter Network Idle

```yaml
browser:
  waitForNetworkIdle: true  # Use networkidle0 instead of networkidle2
```

**Use when:** Page has many async requests that finish at different times
**Execution:** Changes initial page.goto to wait for 0 connections (stricter)
**Pros:** Catches async API calls
**Cons:** May wait too long or timeout on poorly-coded pages

## Combining Strategies

You can combine strategies for maximum reliability:

```yaml
browser:
  waitForNetworkIdle: true  # Strict network idle
  waitDelay: 2000           # Plus 2 second safety buffer
```

Or:

```yaml
browser:
  waitForSelector: '.content-loaded'  # Wait for indicator
  waitDelay: 1000                     # Plus 1 second for images
```

## Troubleshooting

### Still seeing "Loading..." text?
Try increasing `waitDelay`:
```yaml
browser:
  waitDelay: 5000  # or even 10000
```

### Specific table/image not loading?
Find a selector for content that appears when ready:
```yaml
browser:
  waitForSelector: '.calendar-table'  # or '.photo-loaded'
```

### Timeouts?
Your page might have long-running connections. Try:
```yaml
browser:
  remoteTimeout: 120000  # Increase timeout to 2 minutes
  waitForNetworkIdle: false  # Don't use strict network idle
  waitDelay: 5000  # Use simple delay instead
```

## Recommended Starting Point for DakBoard

```yaml
browser:
  mode: remote
  remoteScreenshotUrl: https://your-worker.workers.dev
  remoteApiKey: your-key
  remoteTimeout: 60000
  waitDelay: 3000  # 3 seconds after images load
```

If that's not enough, try:
```yaml
browser:
  waitForNetworkIdle: true  # Stricter
  waitDelay: 5000           # Longer delay
```

## Debugging

Check your Worker logs in the Cloudflare dashboard to see:
- How long each wait stage takes
- Which stage is completing too early
- Any timeout errors

Example log output:
```
Capturing screenshot: https://dakboard.com/... (1920x1080)
Scrolling page to trigger lazy-loaded content...
Waiting for images to load...
Waiting additional 3000ms for async content...
Capturing screenshot...
Screenshot captured: 1252578 bytes
```

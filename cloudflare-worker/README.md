# web2fb Screenshot Service (Cloudflare Worker)

This Cloudflare Worker offloads the heavy browser rendering work from your Pi Zero 2 W to Cloudflare's edge network, dramatically improving performance and eliminating browser memory issues.

## Architecture

```
┌─────────────────────┐
│  Cloudflare Worker  │ ← Runs headless Chrome
│  (Edge Network)     │ ← Captures screenshots
└──────────┬──────────┘
           │ PNG image (~500KB)
           ↓
┌─────────────────────┐
│   Pi Zero 2 W       │ ← Fetches screenshot
│   (web2fb)          │ ← Local image processing
│                     │ ← Writes to framebuffer
└─────────────────────┘
```

## Benefits

- **Eliminates 38s browser launch** from Pi
- **Eliminates 8s screenshot time** from Pi
- **No browser memory issues** on Pi
- **Global edge network** (low latency)
- **Very low cost** (~$0.11/month)

## Setup Instructions

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
```

### 2. Login to Cloudflare

```bash
wrangler login
```

This will open your browser to authenticate.

### 3. Enable Browser Rendering

Before deploying, you need to enable Browser Rendering in your Cloudflare account:

1. Go to https://dash.cloudflare.com
2. Navigate to Workers & Pages → Overview
3. Click "Browser Rendering" in the left sidebar
4. Click "Enable Browser Rendering" (if not already enabled)

Note: Browser Rendering is available on Workers Paid plan ($5/month + usage).

### 4. Deploy the Worker

```bash
cd cloudflare-worker
wrangler deploy
```

You'll see output like:
```
✨ Success! Uploaded worker to Cloudflare
🌍 https://web2fb-screenshot.your-subdomain.workers.dev
```

**Save this URL** - you'll need it for web2fb config.

### 5. (Optional) Set API Key for Security

```bash
wrangler secret put API_KEY
```

Enter a random secure key (e.g., generate with `openssl rand -hex 32`).

**Save this key** - you'll need it for web2fb config.

### 6. (Optional) Enable Custom Domain

If you have a Cloudflare-managed domain:

1. Edit `wrangler.toml`:
   ```toml
   [env.production]
   route = { pattern = "screenshot.yourdomain.com/*", zone_name = "yourdomain.com" }
   ```

2. Deploy to production:
   ```bash
   wrangler deploy --env production
   ```

## Cost Estimate

### Cloudflare Pricing

- **Workers**: Free tier covers 100,000 requests/day
- **Browser Rendering**: $5 per million requests

### Typical web2fb Usage

- Page changes every 2 minutes: **720 screenshots/day**
- Monthly screenshots: **~21,600**
- **Monthly cost: ~$0.11** (essentially free)

### Cost Breakdown

```
21,600 screenshots/month ÷ 1,000,000 × $5 = $0.108/month
```

Even with hourly page changes, you'd only pay **~$0.36/month**.

## Testing

### Test the Worker

```bash
# Replace with your worker URL
WORKER_URL="https://web2fb-screenshot.your-subdomain.workers.dev"

# Test basic screenshot
curl "$WORKER_URL?url=https://example.com&width=1920&height=1080" \
  -H "X-API-Key: YOUR_API_KEY" \
  -o test-screenshot.png

# Verify screenshot was created
file test-screenshot.png
# Should output: test-screenshot.png: PNG image data, 1920 x 1080, 8-bit/color RGB, non-interlaced
```

### Test with DakBoard

```bash
curl "$WORKER_URL?url=https://dakboard.com/display/uuid/YOUR-UUID&width=1920&height=1080&waitForImages=true" \
  -H "X-API-Key: YOUR_API_KEY" \
  -o dakboard-screenshot.png
```

## Configuration

Update your web2fb config (e.g., `examples/dakboard.json`):

```json
{
  "display": {
    "url": "https://dakboard.com/display/uuid/YOUR-UUID-HERE",
    "width": 1920,
    "height": 1080
  },
  "browser": {
    "mode": "remote",
    "remoteScreenshotUrl": "https://web2fb-screenshot.your-subdomain.workers.dev",
    "remoteApiKey": "your-api-key-here",
    "fallbackToLocal": true
  }
}
```

## Monitoring

### Cloudflare Dashboard

View worker metrics at:
https://dash.cloudflare.com → Workers & Pages → web2fb-screenshot

Metrics include:
- Requests per second
- Success rate
- CPU time
- Errors

### Worker Logs

Stream live logs during development:

```bash
wrangler tail
```

## Troubleshooting

### Worker returns 401 Unauthorized

- Check that `X-API-Key` header matches the secret you set
- Verify API key in web2fb config is correct

### Worker returns 500 Error

- Check worker logs: `wrangler tail`
- Verify the target URL is accessible
- Check timeout settings (DakBoard can be slow)

### Screenshot is blank/incomplete

- Increase `timeout` parameter
- Add `waitForSelector` parameter for specific elements
- Check if target URL requires authentication

### High latency

- Worker cold starts can add 2-3s latency
- Consider using a custom domain to reduce routing overhead
- Worker keeps warm with frequent requests

## Advanced Configuration

### Custom User Agent

```bash
curl "$WORKER_URL?url=https://example.com&userAgent=Mozilla/5.0%20..." \
  -H "X-API-Key: YOUR_API_KEY" \
  -o screenshot.png
```

### Wait for Specific Element

```bash
curl "$WORKER_URL?url=https://example.com&waitForSelector=.my-element" \
  -H "X-API-Key: YOUR_API_KEY" \
  -o screenshot.png
```

### Disable Image Waiting

```bash
curl "$WORKER_URL?url=https://example.com&waitForImages=false" \
  -H "X-API-Key: YOUR_API_KEY" \
  -o screenshot.png
```

## Migration Path

1. **Deploy worker** and verify it works with test screenshots
2. **Update config** to use `"mode": "remote"` with `"fallbackToLocal": true`
3. **Monitor performance** - should see dramatic improvement
4. **Optional**: Set `"fallbackToLocal": false` once stable

## Rollback

If you need to revert to local browser:

```json
{
  "browser": {
    "mode": "local"
  }
}
```

Or simply restart web2fb without the remote config - it defaults to local.

## Security Notes

- **API Key**: Keep your API key secret, don't commit it to git
- **CORS**: Worker allows all origins by default (change if needed)
- **Rate Limiting**: Consider adding rate limiting for production
- **Authentication**: Worker doesn't authenticate to target URLs (add if needed)

## Support

- Cloudflare Workers docs: https://developers.cloudflare.com/workers/
- Browser Rendering docs: https://developers.cloudflare.com/browser-rendering/
- web2fb issues: https://github.com/your-repo/web2fb/issues
